/**
 * Knowledge Hub 注册（独立打包版精简 stub）
 *
 * 完整部署中，图谱发布后还会向资产中心的 Knowledge Hub 服务注册资产版本；
 * 独立 graph-builder 部署默认没有该后端。这里保留 registerGraphPublication 接口形态，
 * 调用方已对失败做优雅降级（图谱发布不受影响，仅提示"待注册"），注册通道可透传到
 * 外部网关：设置 KNOWLEDGE_HUB_BASE 后由该地址承接。
 */

const BASE = (import.meta.env?.VITE_KNOWLEDGE_HUB_BASE as string | undefined) ?? '/api';

export interface GraphPublicationInput {
  assetId: string;
  version: string;
  name: string;
  name_en?: string;
  description?: string;
  domain: string;
  templateId: string;
  templateVersion: string;
  nodeCount: number;
  edgeCount: number;
  contentDigest: string;
  runtimeRef: string;
}

export interface GraphPublicationRegistration {
  assetId: string;
  versionId: string;
  registrationStatus: 'REGISTERED';
  assetCreated: boolean;
  versionCreated: boolean;
}

async function postJson<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const payload = (await resp.json().catch(() => null)) as { data?: T; error?: { message?: string } } | null;
  if (!resp.ok || !payload || payload.error) {
    throw new Error(payload?.error?.message || `Knowledge Hub 注册失败（HTTP ${resp.status}）`);
  }
  return payload.data as T;
}

export const knowledgeHubApi = {
  registerGraphPublication: async (
    input: GraphPublicationInput,
    idempotencyKey: string,
  ): Promise<GraphPublicationRegistration> =>
    postJson<GraphPublicationRegistration>('/knowledge-hub/graph-publications', input, {
      'Idempotency-Key': idempotencyKey,
    }),
};
