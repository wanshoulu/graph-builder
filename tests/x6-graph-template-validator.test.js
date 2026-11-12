'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const validator = require('../tools/x6-graph-template-validator');

function template() {
  return {
    template_id: 'test-template', template_version: '1.0.0', name: '测试模板', description: '用于校验', origin: 'custom', parent_template_id: null,
    node_types: [{
      type: 'PERSON', label: '人员', style: { color: '#2563eb', shape: 'rect' },
      fields: [
        { key: 'name', label: '姓名', type: 'string', required: true, default: '' },
        { key: 'level', label: '级别', type: 'enum', required: false, default: 'junior', options: ['junior', 'senior'] },
        { key: 'active', label: '启用', type: 'boolean', required: false, default: true },
      ],
    }, {
      type: 'TEAM', label: '团队', style: { color: '#16a34a', shape: 'rect' },
      fields: [{ key: 'name', label: '名称', type: 'string', required: true, default: '' }],
    }],
    edge_types: [{
      type: 'MEMBER_OF', label: '属于', source_types: ['PERSON'], target_types: ['TEAM'], style: { color: '#64748b' }, fields: [],
    }],
    starter_graph: { nodes: [], edges: [] },
    validation_rules: { unique_node_ids: true, unique_edge_ids: true, no_orphan_edges: true, allow_self_loop: false },
    metadata: { created_at: '2026-08-21T00:00:00.000Z', updated_at: '2026-08-21T00:00:00.000Z' },
  };
}

function graph() {
  return {
    nodes: [
      { id: 'p:1', type: 'PERSON', properties: { name: '王小明', level: 'senior', active: true } },
      { id: 't:1', type: 'TEAM', properties: { name: '产品团队' } },
    ],
    edges: [{ id: 'e:1', type: 'MEMBER_OF', source: 'p:1', target: 't:1', properties: {} }],
  };
}

function codes(result) { return result.errors.map((issue) => issue.code); }

function fullField(overrides) {
  return Object.assign({
    field_id: 'field:title', key: 'title', label: '标题', data_type: 'string', required: false, default: '', options: [],
    constraints: { unique: false, pattern: null, min: null, max: null },
    semantics: { primary_label: false, searchable: false, filterable: false, sensitive: false },
    status: 'active', order: 0,
  }, overrides || {});
}

function schemaTemplate() {
  const value = template();
  value.node_types[0].fields = [
    fullField({ field_id: 'field:code', key: 'code', label: '编码', data_type: 'string', required: true, default: '', constraints: { unique: true, pattern: '^[A-Z]+$', min: null, max: null }, semantics: { primary_label: true, searchable: true, filterable: true, sensitive: false }, order: 0 }),
    fullField({ field_id: 'field:description', key: 'description', label: '说明', data_type: 'multiline', default: '', order: 1 }),
    fullField({ field_id: 'field:score', key: 'score', label: '分值', data_type: 'number', default: 0, constraints: { unique: false, pattern: null, min: 0, max: 100 }, order: 2 }),
    fullField({ field_id: 'field:enabled', key: 'enabled', label: '启用', data_type: 'boolean', default: false, order: 3 }),
    fullField({ field_id: 'field:day', key: 'day', label: '日期', data_type: 'date', default: '', order: 4 }),
    fullField({ field_id: 'field:state', key: 'state', label: '状态', data_type: 'enum', default: 'open', options: ['open', 'closed'], order: 5 }),
    fullField({ field_id: 'field:channels', key: 'channels', label: '渠道', data_type: 'multi_enum', default: [], options: ['web', 'app'], order: 6 }),
    fullField({ field_id: 'field:tags', key: 'tags', label: '标签', data_type: 'tags', default: [], order: 7 }),
    fullField({ field_id: 'field:homepage', key: 'homepage', label: '主页', data_type: 'url', default: '', semantics: { primary_label: false, searchable: false, filterable: false, sensitive: true }, order: 8 }),
    fullField({ field_id: 'field:retired', key: 'retired', label: '已归档', data_type: 'string', required: true, default: '', status: 'archived', order: 9 }),
  ];
  value.node_types[1].fields = [fullField({ field_id: 'field:team-code', key: 'code', label: '编码', data_type: 'string', required: true, default: '', constraints: { unique: true, pattern: null, min: null, max: null } })];
  value.edge_types[0].fields = [
    fullField({ field_id: 'field:edge-code', key: 'code', label: '关系编码', data_type: 'string', required: true, default: '', constraints: { unique: true, pattern: '^[a-z]+$', min: null, max: null }, semantics: { primary_label: true, searchable: true, filterable: true, sensitive: false } }),
    fullField({ field_id: 'field:edge-url', key: 'reference', label: '参考链接', data_type: 'url', default: '', semantics: { primary_label: false, searchable: false, filterable: false, sensitive: true }, order: 1 }),
  ];
  return value;
}

test('validates a complete template and a graph using it', () => {
  assert.deepEqual(validator.validateTemplate(template()), { valid: true, errors: [], warnings: [] });
  assert.equal(validator.validateGraph(template(), graph()).valid, true);
});

test('rejects invalid metadata, duplicate types and fields, enum options and unknown endpoints', () => {
  const invalid = template();
  delete invalid.metadata.updated_at;
  invalid.node_types.push({ type: 'PERSON', label: '重复', style: { color: '#000', shape: 'rect' }, fields: [] });
  invalid.node_types[0].fields.push({ key: 'name', label: '重复字段', type: 'unsupported', required: false, default: null });
  invalid.node_types[0].fields[1].options = [];
  invalid.edge_types[0].target_types = ['MISSING'];
  invalid.starter_graph = { nodes: [{ id: 'x', type: 'MISSING', properties: {} }], edges: [] };
  const result = validator.validateTemplate(invalid);
  assert.equal(result.valid, false);
  ['METADATA_UPDATED_AT_REQUIRED', 'TYPE_ID_DUPLICATE', 'FIELD_KEY_DUPLICATE', 'FIELD_TYPE_INVALID', 'ENUM_OPTIONS_INVALID', 'EDGE_TARGET_TYPE_UNKNOWN', 'NODE_TYPE_UNKNOWN'].forEach((code) => assert.ok(codes(result).includes(code), code));
});

test('returns structured errors instead of throwing for malformed type definitions in a starter graph', () => {
  const invalid = template();
  invalid.node_types[0].fields = null;
  invalid.starter_graph = { nodes: [{ id: 'p:1', type: 'PERSON', properties: {} }], edges: [] };
  assert.doesNotThrow(() => validator.validateTemplate(invalid));
  assert.ok(codes(validator.validateTemplate(invalid)).includes('FIELDS_INVALID'));
});

test('is total for malformed template shapes and reserves throws for assert helpers', () => {
  const malformedCollections = template();
  malformedCollections.node_types = {};
  malformedCollections.edge_types = null;
  assert.doesNotThrow(() => validator.validateTemplate(malformedCollections));
  assert.equal(validator.validateTemplate(malformedCollections).valid, false);

  const malformedDefinitions = template();
  malformedDefinitions.node_types[0].fields = [null];
  malformedDefinitions.edge_types[0].fields = [null];
  malformedDefinitions.starter_graph = {
    nodes: [{ id: 'p:1', type: 'PERSON', properties: {} }],
    edges: [{ id: 'e:1', type: 'MEMBER_OF', source: 'p:1', target: 'p:1', properties: {} }],
  };
  malformedDefinitions.node_types.push(null);
  malformedDefinitions.edge_types.push(null);
  assert.doesNotThrow(() => validator.validateTemplate(malformedDefinitions));
  assert.doesNotThrow(() => validator.validateGraph(malformedDefinitions, { nodes: [], edges: [] }));
  assert.throws(() => validator.assertTemplate(malformedDefinitions), (error) => error.code === 'TEMPLATE_VALIDATION_FAILED');
});

test('checks graph node fields, relationship endpoints, IDs, orphan edges and self-loop rules', () => {
  const invalid = graph();
  invalid.nodes = [
    { id: 'p:1', type: 'PERSON', properties: { name: 7, level: 'principal' } },
    { id: 'p:1', type: 'UNKNOWN', properties: {} },
    { id: 't:1', type: 'TEAM', properties: {} },
  ];
  invalid.edges = [
    { id: 'e:1', type: 'MEMBER_OF', source: 'p:1', target: 'missing', properties: {} },
    { id: 'e:1', type: 'MEMBER_OF', source: 'p:1', target: 'p:1', properties: {} },
  ];
  const result = validator.validateGraph(template(), invalid);
  assert.equal(result.valid, false);
  ['NODE_ID_DUPLICATE', 'NODE_TYPE_UNKNOWN', 'FIELD_REQUIRED', 'FIELD_TYPE_INVALID', 'ENUM_VALUE_INVALID', 'EDGE_ID_DUPLICATE', 'ORPHAN_EDGE', 'EDGE_ENDPOINT_TYPE_INVALID', 'SELF_LOOP_NOT_ALLOWED'].forEach((code) => assert.ok(codes(result).includes(code), code));
});

test('requires string relationship endpoints even when orphan-edge checks are disabled', () => {
  const relaxed = template();
  relaxed.validation_rules.no_orphan_edges = false;
  const invalid = { nodes: [], edges: [
    { id: 'e:missing', type: 'MEMBER_OF', source: null, target: 7, properties: {} },
    { id: 'e:blank', type: 'MEMBER_OF', source: '', target: ' ', properties: {} },
  ] };
  const report = validator.validateGraph(relaxed, invalid);
  assert.equal(report.valid, false);
  assert.equal(codes(report).filter((code) => code === 'GRAPH_IMPORT_INVALID').length, 4);
  assert.equal(codes(report).includes('ORPHAN_EDGE'), false);
});

test('assert helpers throw their validation results with stable error codes', () => {
  assert.throws(() => validator.assertTemplate({}), (error) => error.code === 'TEMPLATE_VALIDATION_FAILED' && Array.isArray(error.validation.errors));
  assert.throws(() => validator.assertGraph(template(), { nodes: [], edges: [{ id: 'e', type: 'MEMBER_OF', source: 'x', target: 'y', properties: {} }] }), (error) => error.code === 'GRAPH_VALIDATION_FAILED');
});

test('uses strict calendar dates and rejects overflow dates', () => {
  const dated = template();
  dated.node_types[0].fields.push({ key: 'birthday', label: '日期', type: 'date', required: false, default: '' });
  const invalid = graph();
  invalid.nodes[0].properties.birthday = '2026-02-30';
  assert.ok(codes(validator.validateGraph(dated, invalid)).includes('FIELD_TYPE_INVALID'));
});

test('enforces globally unique element ids across nodes and edges', () => {
  const invalid = graph();
  invalid.edges[0].id = invalid.nodes[0].id;
  assert.ok(codes(validator.validateGraph(template(), invalid)).includes('ELEMENT_ID_DUPLICATE'));
});

test('returns non-blocking warnings for optional primary labels, template version mismatch, and isolated nodes', () => {
  const warningTemplate = template();
  warningTemplate.node_types[0].fields[0].required = false;
  const warningGraph = {
    template_ref: { template_id: warningTemplate.template_id, template_version: '0.9.0' },
    nodes: [{ id: 'p:1', type: 'PERSON', properties: { name: '', level: 'junior', active: true } }],
    edges: [],
  };
  const report = validator.validateGraph(warningTemplate, warningGraph);
  assert.equal(report.valid, true);
  const warningCodes = report.warnings.map((issue) => issue.code);
  ['OPTIONAL_PRIMARY_LABEL_EMPTY', 'TEMPLATE_VERSION_MISMATCH', 'ISOLATED_NODE'].forEach((code) => assert.ok(warningCodes.includes(code), code));
});

test('does not treat a later optional text property as the primary label', () => {
  const warningTemplate = template();
  warningTemplate.node_types[0].fields.push({ key: 'note', label: '备注', type: 'string', required: false, default: '' });
  const warningGraph = graph();
  warningGraph.nodes[0].properties.note = '';
  const warningCodes = validator.validateGraph(warningTemplate, warningGraph).warnings.map((issue) => issue.code);
  assert.equal(warningCodes.includes('OPTIONAL_PRIMARY_LABEL_EMPTY'), false);
});

test('accepts all nine field types for nodes and relationships without treating false, zero or empty arrays as missing', () => {
  const value = schemaTemplate();
  value.node_types[0].fields.find((field) => field.key === 'channels').required = true;
  const document = {
    nodes: [
      { id: 'p:1', type: 'PERSON', properties: { code: 'ALPHA', description: '多行\n说明', score: 0, enabled: false, day: '2024-02-29', state: 'open', channels: [], tags: [], homepage: 'https://example.com/a?b=1', retired: '历史值' } },
      { id: 't:1', type: 'TEAM', properties: { code: 'ALPHA' } },
    ],
    edges: [{ id: 'e:1', type: 'MEMBER_OF', source: 'p:1', target: 't:1', properties: { code: 'link', reference: 'http://example.com/reference' } }],
  };
  const report = validator.validateGraph(value, document);
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.equal(report.warnings.filter((issue) => issue.code === 'SENSITIVE_FIELD_PRESENT').length, 2);
});

test('validates complete FieldDefinition shape, type aliases, constraints, semantics, defaults and primary labels', () => {
  const invalid = schemaTemplate();
  const fields = invalid.node_types[0].fields;
  fields[0].type = 'number';
  delete fields[1].field_id;
  fields[2].constraints.unique = 'yes';
  fields[2].constraints.extra = true;
  fields[3].semantics.sensitive = 'yes';
  fields[3].semantics.extra = true;
  fields[4].default = '2026-02-30';
  fields[5].options = ['open', 'open'];
  fields[6].options = new Array(1);
  fields[7].unexpected = true;
  fields[8].constraints.pattern = '[';
  fields[1].semantics.primary_label = true;
  const report = validator.validateTemplate(invalid);
  assert.equal(report.valid, false);
  ['FIELD_DATA_TYPE_CONFLICT', 'FIELD_ID_REQUIRED', 'FIELD_CONSTRAINTS_INVALID', 'FIELD_SEMANTICS_INVALID', 'FIELD_DEFAULT_INVALID', 'ENUM_OPTIONS_INVALID', 'FIELD_SCHEMA_PROPERTY_UNKNOWN', 'FIELD_PATTERN_INVALID', 'PRIMARY_LABEL_DUPLICATE']
    .forEach((code) => assert.ok(codes(report).includes(code), code));
});

test('validates patterns, ranges, arrays, urls and Schema-external properties on both nodes and relationships', () => {
  const invalid = {
    nodes: [
      { id: 'p:1', type: 'PERSON', properties: { code: 'lower', score: 101, channels: ['web', 'unknown'], tags: ['ok', ' '], homepage: 'javascript:alert(1)', extra: true } },
      { id: 't:1', type: 'TEAM', properties: { code: 'TEAM' } },
    ],
    edges: [{ id: 'e:1', type: 'MEMBER_OF', source: 'p:1', target: 't:1', properties: { code: 'UPPER', reference: '/relative', extra: true } }],
  };
  const report = validator.validateGraph(schemaTemplate(), invalid);
  assert.equal(report.valid, false);
  ['FIELD_PATTERN_INVALID', 'FIELD_RANGE_INVALID', 'FIELD_ARRAY_INVALID', 'FIELD_URL_INVALID', 'PROPERTY_NOT_IN_SCHEMA']
    .forEach((code) => assert.ok(codes(report).includes(code), code));
  assert.ok(report.errors.some((issue) => issue.code === 'PROPERTY_NOT_IN_SCHEMA' && issue.path === 'graph.nodes[0].properties.extra'));
  assert.ok(report.errors.some((issue) => issue.code === 'PROPERTY_NOT_IN_SCHEMA' && issue.path === 'graph.edges[0].properties.extra'));
  assert.ok(report.errors.some((issue) => issue.code === 'FIELD_URL_INVALID' && issue.path === 'graph.edges[0].properties.reference'));
});

test('rejects non-http URL schemes, relative URLs, sparse tags and malformed multi-select values with stable codes', () => {
  const value = schemaTemplate();
  const invalidSchemes = ['javascript:alert(1)', 'data:text/plain,x', 'file:///tmp/a', '/relative'];
  invalidSchemes.forEach((url) => {
    const document = { nodes: [{ id: 'p:1', type: 'PERSON', properties: { code: 'VALID', homepage: url } }], edges: [] };
    assert.ok(codes(validator.validateGraph(value, document)).includes('FIELD_URL_INVALID'), url);
  });
  const sparseTags = [];
  sparseTags.length = 1;
  const malformed = { nodes: [{ id: 'p:1', type: 'PERSON', properties: { code: 'VALID', channels: 'web', tags: sparseTags } }], edges: [] };
  const report = validator.validateGraph(value, malformed);
  assert.ok(codes(report).filter((code) => code === 'FIELD_ARRAY_INVALID').length >= 2);
});

test('enforces deterministic unique values only within the same kind and element type', () => {
  const value = schemaTemplate();
  value.edge_types[0].fields[0].constraints.pattern = null;
  const document = {
    nodes: [
      { id: 'p:1', type: 'PERSON', properties: { code: 'SAME' } },
      { id: 'p:2', type: 'PERSON', properties: { code: 'SAME' } },
      { id: 't:1', type: 'TEAM', properties: { code: 'SAME' } },
    ],
    edges: [
      { id: 'e:1', type: 'MEMBER_OF', source: 'p:1', target: 't:1', properties: { code: 'SAME' } },
      { id: 'e:2', type: 'MEMBER_OF', source: 'p:2', target: 't:1', properties: { code: 'SAME' } },
    ],
  };
  const conflicts = validator.validateGraph(value, document).errors.filter((issue) => issue.code === 'FIELD_UNIQUE_CONFLICT');
  assert.deepEqual(conflicts.map((issue) => issue.path), ['graph.nodes[1].properties.code', 'graph.edges[1].properties.code']);

  value.node_types[0].fields.find((field) => field.key === 'tags').constraints.unique = true;
  document.nodes[0].properties.tags = ['a', 'b'];
  document.nodes[1].properties.tags = ['a', 'b'];
  const arrayConflicts = validator.validateGraph(value, document).errors.filter((issue) => issue.code === 'FIELD_UNIQUE_CONFLICT');
  assert.ok(arrayConflicts.some((issue) => issue.path === 'graph.nodes[1].properties.tags'));
});

test('derives a read-only identity for legacy fields without field_id and keeps legacy uniqueness working', () => {
  const legacy = template();
  legacy.node_types[0].fields[0].constraints = { unique: true };
  const before = structuredClone(legacy);
  const document = graph();
  document.nodes.splice(1, 0, { id: 'p:2', type: 'PERSON', properties: { name: '王小明', level: 'junior', active: false } });
  const report = validator.validateGraph(legacy, document);
  assert.ok(codes(report).includes('FIELD_UNIQUE_CONFLICT'));
  assert.deepEqual(legacy, before);
  assert.equal(Object.hasOwn(legacy.node_types[0].fields[0], 'field_id'), false);
});

test('allows archived historical properties, skips archived required checks and warns only for non-empty sensitive values', () => {
  const value = schemaTemplate();
  const document = {
    nodes: [{ id: 'p:1', type: 'PERSON', properties: { code: 'VALID', retired: '历史保留', homepage: '' } }],
    edges: [],
  };
  let report = validator.validateGraph(value, document);
  assert.equal(codes(report).includes('PROPERTY_NOT_IN_SCHEMA'), false);
  assert.equal(codes(report).includes('FIELD_REQUIRED'), false);
  assert.equal(report.warnings.some((issue) => issue.code === 'SENSITIVE_FIELD_PRESENT'), false);
  delete document.nodes[0].properties.retired;
  report = validator.validateGraph(value, document);
  assert.equal(codes(report).includes('FIELD_REQUIRED'), false);
});

test('uses explicit primary-label semantics before the legacy text-field fallback', () => {
  const value = schemaTemplate();
  const code = value.node_types[0].fields.find((field) => field.key === 'code');
  const description = value.node_types[0].fields.find((field) => field.key === 'description');
  code.required = false;
  code.semantics.primary_label = false;
  description.semantics.primary_label = true;
  const document = { nodes: [{ id: 'p:1', type: 'PERSON', properties: { code: '', description: '' } }], edges: [] };
  let warnings = validator.validateGraph(value, document).warnings.filter((issue) => issue.code === 'OPTIONAL_PRIMARY_LABEL_EMPTY');
  assert.deepEqual(warnings.map((issue) => issue.path), ['graph.nodes[0].properties.description']);
  document.nodes[0].properties.description = '可见名称';
  warnings = validator.validateGraph(value, document).warnings.filter((issue) => issue.code === 'OPTIONAL_PRIMARY_LABEL_EMPTY');
  assert.equal(warnings.length, 0);
});

test('is total for sparse collections and malformed properties and does not mutate template or graph', () => {
  const value = schemaTemplate();
  value.node_types[0].fields = new Array(1);
  value.node_types[1].fields[0].data_type = 'enum';
  value.node_types[1].fields[0].default = 'x';
  value.node_types[1].fields[0].options = new Array(1);
  const sparseNodes = new Array(1);
  const sparseEdges = new Array(1);
  const document = { nodes: sparseNodes, edges: sparseEdges };
  const beforeTemplate = structuredClone(value);
  const beforeGraph = structuredClone(document);
  assert.doesNotThrow(() => validator.validateTemplate(value));
  assert.doesNotThrow(() => validator.validateGraph(value, document));
  const templateReport = validator.validateTemplate(value);
  assert.ok(codes(templateReport).includes('FIELD_INVALID'));
  assert.ok(codes(templateReport).includes('ENUM_OPTIONS_INVALID'));
  assert.deepEqual(value, beforeTemplate);
  assert.deepEqual(document, beforeGraph);

  const validTemplate = schemaTemplate();
  const malformedProperties = { nodes: [{ id: 'p:1', type: 'PERSON', properties: [] }], edges: [] };
  assert.doesNotThrow(() => validator.validateGraph(validTemplate, malformedProperties));
  assert.ok(codes(validator.validateGraph(validTemplate, malformedProperties)).includes('NODE_PROPERTIES_INVALID'));
});

test('consumption descriptor covers active node and edge semantics without values or mutation', () => {
  const value = schemaTemplate();
  const nodeFields = value.node_types[0].fields;
  nodeFields.find((field) => field.key === 'code').constraints.unique = true;
  nodeFields.find((field) => field.key === 'score').semantics.filterable = true;
  nodeFields.find((field) => field.key === 'description').semantics.searchable = true;
  value.edge_types[0].fields[0].semantics.sensitive = true;
  value.node_types[0].fields.push({
    key: 'legacy_name', label: '旧字段', type: 'string', required: false, default: '',
    semantics: { primary_label: false, searchable: true, filterable: false, sensitive: false },
  });
  const before = structuredClone(value);
  const first = validator.describeConsumption(value);
  const second = validator.describeConsumption(value);
  assert.deepEqual(first, second);
  assert.deepEqual(value, before);
  assert.equal(first.node_types[0].element_kind, 'node');
  assert.equal(first.edge_types[0].element_kind, 'edge');
  assert.equal(first.node_types[0].primary_label.key, 'code');
  assert.ok(first.node_types[0].searchable.some((field) => field.field_id === 'legacy:node:PERSON:legacy_name'));
  assert.ok(first.node_types[0].filterable.some((field) => field.key === 'score'));
  assert.ok(first.node_types[0].unique.some((field) => field.key === 'code'));
  assert.ok(first.node_types[0].sensitive.some((field) => field.key === 'homepage'));
  assert.ok(first.edge_types[0].sensitive.some((field) => field.key === 'code'));
  assert.equal(first.node_types[0].searchable.some((field) => field.key === 'retired'), false);
  assert.equal(first.aggregate.type_count, value.node_types.length + value.edge_types.length);
  assert.equal(JSON.stringify(first).includes('历史值'), false);
});

test('consumption descriptor rejects invalid and sparse templates with controlled validation evidence', () => {
  const invalid = schemaTemplate();
  invalid.node_types[0].fields = new Array(1);
  assert.throws(() => validator.describeConsumption(invalid), (error) => {
    assert.equal(error.code, 'TEMPLATE_VALIDATION_FAILED');
    assert.ok(error.validation.errors.some((issue) => issue.code === 'FIELD_INVALID'));
    return true;
  });
});
