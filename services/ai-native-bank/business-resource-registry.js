'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const capabilityRegistry = require('./capability-registry');

const DEFAULT_ROOT = path.join(__dirname, '..', '..', 'data', 'ai-native-bank', 'registries');
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

class BusinessResourceRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BusinessResourceRegistryError';
    this.code = code;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function readJson(filePath, code) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new BusinessResourceRegistryError(code, `Business resource registry cannot load ${path.basename(filePath)}`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new BusinessResourceRegistryError('registry_contract_invalid', `${label} has invalid fields`);
  }
}

function validateSkillManifest(payload) {
  assertExactKeys(payload, ['schemaVersion', 'skills'], 'skill registry');
  if (payload.schemaVersion !== '1.0' || !Array.isArray(payload.skills)) {
    throw new BusinessResourceRegistryError('registry_contract_invalid', 'Skill registry version is unsupported');
  }
  const ids = new Set();
  const intents = new Set();
  payload.skills.forEach(skill => {
    assertExactKeys(skill, [
      'id', 'version', 'digest', 'status', 'handledIntentIds', 'intentCapabilityBindings',
      'businessObjectIds', 'requiredCapabilityIds', 'riskBoundary', 'compatibleGraphVersions',
      'compatibleRuntimeVersions', 'entrypoint', 'owner',
    ], `skill ${skill.id || '<unknown>'}`);
    if (ids.has(skill.id) || !/^bank\.[a-z0-9.-]+$/.test(skill.id)) {
      throw new BusinessResourceRegistryError('registry_contract_invalid', 'Skill identifiers must be unique and valid');
    }
    ids.add(skill.id);
    if (!/^\d+\.\d+\.\d+$/.test(skill.version) || !HASH_PATTERN.test(skill.digest)) {
      throw new BusinessResourceRegistryError('registry_contract_invalid', `Skill ${skill.id} version or digest is invalid`);
    }
    if (!['active', 'disabled'].includes(skill.status) || !Array.isArray(skill.handledIntentIds) || skill.handledIntentIds.length === 0) {
      throw new BusinessResourceRegistryError('registry_contract_invalid', `Skill ${skill.id} lifecycle is invalid`);
    }
    skill.handledIntentIds.forEach(intentId => {
      if (intents.has(intentId) || !Array.isArray(skill.intentCapabilityBindings[intentId])) {
        throw new BusinessResourceRegistryError('registry_contract_invalid', `Intent ${intentId} must have one skill binding`);
      }
      intents.add(intentId);
      const allowed = new Set(skill.requiredCapabilityIds);
      if (skill.intentCapabilityBindings[intentId].some(id => !allowed.has(id))) {
        throw new BusinessResourceRegistryError('registry_contract_invalid', `Intent ${intentId} exceeds skill capability boundary`);
      }
    });
  });
}

function validateProviderManifest(payload, overrides) {
  assertExactKeys(payload, ['schemaVersion', 'providers'], 'provider registry');
  if (payload.schemaVersion !== '1.0' || !Array.isArray(payload.providers)) {
    throw new BusinessResourceRegistryError('registry_contract_invalid', 'Provider registry version is unsupported');
  }
  const ids = new Set();
  const capabilities = new Set();
  payload.providers.forEach(provider => {
    assertExactKeys(provider, [
      'providerId', 'providerType', 'capabilityId', 'version', 'schemaDigest',
      'exposure', 'requiredScopes', 'health', 'endpointBinding',
    ], `provider ${provider.providerId || '<unknown>'}`);
    if (ids.has(provider.providerId) || capabilities.has(provider.capabilityId)) {
      throw new BusinessResourceRegistryError('registry_contract_invalid', 'Provider and capability bindings must be unique');
    }
    ids.add(provider.providerId);
    capabilities.add(provider.capabilityId);
    const validProviderPair = (provider.providerType === 'mcp' && provider.exposure === 'model-callable')
      || (provider.providerType === 'user-action' && provider.exposure === 'user-action');
    if (!validProviderPair || !/^provider\.[a-z0-9.-]+$/.test(provider.providerId)
      || !/^\d+\.\d+\.\d+$/.test(provider.version)
      || !HASH_PATTERN.test(provider.schemaDigest)
      || !['ready', 'degraded', 'unavailable'].includes(provider.health)) {
      throw new BusinessResourceRegistryError('provider_not_allowed', `Provider ${provider.providerId} metadata is not agent-safe`);
    }
    const endpointKeys = provider.providerType === 'mcp'
      ? ['serverId', 'toolName']
      : ['gatewayId', 'action'];
    if (!provider.endpointBinding || typeof provider.endpointBinding !== 'object' || Array.isArray(provider.endpointBinding)) {
      throw new BusinessResourceRegistryError('registry_contract_invalid', `Provider ${provider.providerId} endpoint binding is invalid`);
    }
    assertExactKeys(provider.endpointBinding, endpointKeys, `provider ${provider.providerId} endpoint binding`);
    if (Object.values(provider.endpointBinding).some(item => typeof item !== 'string'
      || !/^[a-z][a-z0-9._-]{1,95}$/.test(item))) {
      throw new BusinessResourceRegistryError('registry_contract_invalid', `Provider ${provider.providerId} endpoint binding is invalid`);
    }
    const capability = capabilityRegistry.get(provider.capabilityId);
    if (!capability || capability.exposure === 'system-only') {
      throw new BusinessResourceRegistryError('provider_not_allowed', `Provider ${provider.providerId} is not agent-safe`);
    }
    const expected = digest({ inputSchema: capability.inputSchema, outputSchema: capability.outputSchema });
    const declared = overrides[provider.capabilityId] || provider.schemaDigest;
    if (declared !== expected) {
      throw new BusinessResourceRegistryError('tool_schema_mismatch', `Provider ${provider.providerId} schema does not match capability contract`);
    }
    if (provider.exposure !== capability.exposure || stableStringify(provider.requiredScopes) !== stableStringify(capability.requiredScopes)) {
      throw new BusinessResourceRegistryError('provider_contract_mismatch', `Provider ${provider.providerId} security metadata drifted`);
    }
  });
}

function loadBusinessResourceRegistry(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const skillsPayload = readJson(path.join(root, 'skills.v1.json'), 'skill_registry_unavailable');
  const providersPayload = readJson(path.join(root, 'providers.v1.json'), 'provider_registry_unavailable');
  validateSkillManifest(skillsPayload);
  validateProviderManifest(providersPayload, options.providerDigestOverrides || {});

  const skills = deepFreeze(structuredClone(skillsPayload.skills));
  const providers = deepFreeze(structuredClone(providersPayload.providers));
  const skillsByIntent = new Map();
  skills.forEach(skill => skill.handledIntentIds.forEach(intentId => skillsByIntent.set(intentId, skill)));
  const providersByCapability = new Map(providers.map(provider => [provider.capabilityId, provider]));

  function resolveExecutionView({ intentIds, actorScopes }) {
    const requestedIntents = [...new Set(intentIds || [])];
    const scopes = new Set(actorScopes || []);
    if (requestedIntents.length === 0) {
      throw new BusinessResourceRegistryError('intent_binding_missing', 'At least one intent is required');
    }
    const selectedSkills = [];
    const capabilityIds = [];
    requestedIntents.forEach(intentId => {
      const skill = skillsByIntent.get(intentId);
      if (!skill || skill.status !== 'active') {
        throw new BusinessResourceRegistryError('skill_binding_missing', `No active skill handles ${intentId}`);
      }
      if (!selectedSkills.includes(skill)) selectedSkills.push(skill);
      skill.intentCapabilityBindings[intentId].forEach(id => {
        if (!capabilityIds.includes(id)) capabilityIds.push(id);
      });
    });
    const selectedProviders = capabilityIds.map(capabilityId => {
      const provider = providersByCapability.get(capabilityId);
      if (!provider || provider.health !== 'ready') {
        throw new BusinessResourceRegistryError('provider_unavailable', `No healthy provider serves ${capabilityId}`);
      }
      if (provider.requiredScopes.some(scope => !scopes.has(scope))) {
        throw new BusinessResourceRegistryError('provider_scope_denied', `Actor is not authorized for ${capabilityId}`);
      }
      return provider;
    });
    const body = {
      intentIds: requestedIntents,
      skillIds: selectedSkills.map(item => item.id),
      skills: selectedSkills,
      capabilityIds,
      providers: selectedProviders,
    };
    return deepFreeze({ ...body, digest: digest(body) });
  }

  return deepFreeze({
    skills,
    providers,
    digest: digest({ skills, providers }),
    resolveExecutionView,
  });
}

module.exports = {
  BusinessResourceRegistryError,
  loadBusinessResourceRegistry,
};
