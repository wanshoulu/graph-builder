/**
 * 自动建图材料库纯函数：多文档合并、填充取证文本、表格行数据、字段映射建议
 */
import type { GraphDocument, GraphTemplateField } from '@/api/orgGraph';

/** 一份上传材料（解析+体检后入库；text 是抽取与填充的原文依据，sheets 只在 xlsx 有值） */
export interface BuildMaterial {
  id: string;
  name: string;
  chars: number;
  text: string;
  sheets: { name: string; headers: string[]; rows: number; data?: string[][]; dataTruncated?: boolean }[] | null;
  triageMode: 'extract' | 'suggest_tabular' | 'low_relevance' | 'reject';
  addedAt: number;
}

/** 节点显示名（properties.name 优先；与画布 nodeDisplayName 语义一致但零依赖） */
function nodeName(node: GraphDocument['nodes'][number]): string {
  const n = node.properties?.name;
  return typeof n === 'string' && n.trim() ? n.trim() : node.id;
}

/**
 * 合并两份图谱文档（多文档累积建图 / 增量片段并入）：
 * 节点匹配优先级：id 精确命中 → (type, 显示名) 命中 → 追加。
 * id 命中时 name 允许覆盖（对话改名语义），其余属性补缺不覆盖；
 * 名称命中的 incoming 节点 id 登记别名，边端点随之重定向，避免悬空。
 * 边按 (source,target,type) 去重，重定向后追加；合并产生的自环边跳过。
 */
export function mergeGraphDocuments(base: GraphDocument | null, incoming: GraphDocument): GraphDocument {
  const result: GraphDocument = {
    // 身份字段（document_id/template_ref/metadata）沿用 base，缺失时回落 incoming；
    // metadata 浅合并（base 优先）：v4ResourceRegistries 等随合并透传，不再丢失
    document_id: base?.document_id || incoming.document_id || 'graph-merged',
    document_version: base?.document_version || incoming.document_version || '1.0.0',
    asset_id: base?.asset_id || incoming.asset_id,
    template_ref: base?.template_ref || incoming.template_ref,
    metadata: { ...((incoming.metadata || {}) as object), ...((base?.metadata || {}) as object) },
    nodes: (base?.nodes || []).map((n) => ({ ...n, properties: { ...(n.properties || {}) } })),
    edges: (base?.edges || []).map((e) => ({ ...e, properties: { ...(e.properties || {}) } })),
  };
  const byId = new Map<string, number>();
  const byName = new Map<string, number>();
  result.nodes.forEach((n, i) => {
    byId.set(n.id, i);
    byName.set(`${n.type}|${nodeName(n)}`, i);
  });
  const edgeIndex = new Set(result.edges.map((e) => `${e.source}|${e.target}|${e.type}`));
  const idAlias = new Map<string, string>();

  const fillProps = (idx: number, props: Record<string, unknown>, overrideName: string | undefined) => {
    const target = result.nodes[idx];
    Object.entries(props || {}).forEach(([k, v]) => {
      if (k === 'name') return;
      const cur = target.properties?.[k];
      if (cur === undefined || cur === null || cur === '') {
        target.properties = { ...target.properties, [k]: v };
      }
    });
    if (overrideName !== undefined && overrideName.trim() && nodeName(target) !== overrideName.trim()) {
      target.properties = { ...target.properties, name: overrideName.trim() };
    }
  };

  incoming.nodes.forEach((n) => {
    // 片段可能不带 name（只有 id + 补充字段）——此时不得触发改名覆盖
    const rawName = n.properties?.name;
    const incName = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined;
    const idHit = n.id ? byId.get(n.id) : undefined;
    if (idHit !== undefined) {
      fillProps(idHit, n.properties || {}, incName);
      idAlias.set(n.id, result.nodes[idHit].id);
      return;
    }
    const nameKey = `${n.type}|${nodeName(n)}`;
    const nameHit = byName.get(nameKey);
    if (nameHit !== undefined) {
      fillProps(nameHit, n.properties || {}, undefined);
      if (n.id) idAlias.set(n.id, result.nodes[nameHit].id);
      return;
    }
    const idx = result.nodes.length;
    result.nodes.push({ ...n, properties: { ...(n.properties || {}) } });
    if (n.id) { byId.set(n.id, idx); idAlias.set(n.id, n.id); }
    byName.set(nameKey, idx);
  });

  incoming.edges.forEach((e) => {
    const src = (e.source && idAlias.get(e.source)) || e.source;
    const tgt = (e.target && idAlias.get(e.target)) || e.target;
    if (!src || !tgt || src === tgt) return;
    const key = `${src}|${tgt}|${e.type}`;
    if (edgeIndex.has(key)) return;
    edgeIndex.add(key);
    result.edges.push({ ...e, source: src, target: tgt, properties: { ...(e.properties || {}) } });
  });
  return result;
}

/** 填充取证文本：材料按上传顺序拼接（带名称标记），总量截断到 cap（服务端 buildFillPrompt 30k） */
export function buildFillSourceText(materials: BuildMaterial[], cap = 30000): string {
  const parts: string[] = [];
  let total = 0;
  for (const m of materials) {
    if (total >= cap) break;
    const body = m.text.slice(0, cap - total);
    const header = `【材料：${m.name}】\n`;
    parts.push(header + body);
    total += header.length + body.length;
  }
  return parts.join('\n\n');
}

/** xlsx sheet 行数据（aoa）→ JSON 行对象数组字符串（from-tabular 的 json format 输入） */
export function sheetRowsToJson(headers: string[], data: string[][]): string {
  const rows = data.map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = row[i] === undefined ? '' : String(row[i]); });
    return obj;
  });
  return JSON.stringify(rows);
}

/**
 * 表头 → 模板字段自动建议（语义对齐服务端 matchHeadersToTemplate：label/key 精确匹配优先，其次包含关系）。
 * 返回 fieldMap：{ 模板字段key: 列名 }；一列只映射一个字段，一字段只取一列。
 */
export function autoSuggestFieldMap(
  headers: string[],
  fields: GraphTemplateField[],
): Record<string, string> {
  const fieldMap: Record<string, string> = {};
  const used = new Set<string>();
  // 第一轮：精确匹配（表头 === label 或 key）
  fields.forEach((f) => {
    const exact = headers.find((h) => !used.has(h) && (h === f.label || h === f.key));
    if (exact) { fieldMap[f.key] = exact; used.add(exact); }
  });
  // 第二轮：包含匹配（表头含 label 或 label 含表头）
  fields.forEach((f) => {
    if (fieldMap[f.key]) return;
    const label = (f.label || '').trim();
    if (!label) return;
    const partial = headers.find((h) => !used.has(h) && h.length > 0 && (h.includes(label) || label.includes(h)));
    if (partial) { fieldMap[f.key] = partial; used.add(partial); }
  });
  return fieldMap;
}

/** 主标签列建议：优先匹配 name/名称/姓名/标题 表头，否则第一列 */
export function suggestNameColumn(headers: string[]): string {
  const candidates = ['name', '名称', '姓名', '标题', '节点'];
  const hit = headers.find((h) => candidates.some((c) => h.toLowerCase() === c || h.includes(c)));
  return hit || headers[0] || '';
}
