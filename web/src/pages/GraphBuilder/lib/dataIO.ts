/**
 * 数据格式导入导出工具（CSV / JSON-LD / RDF Turtle / GraphML）
 *
 * 支持与 Neo4j (CSV)、Apache Jena (RDF/JSON-LD)、Gephi/Cytoscape (GraphML) 互操作。
 * 对标业界标准数据格式，补齐数据互操作能力。
 */
import type { GraphDocument, GraphEdge, GraphNode } from '@/api/orgGraph';

// ── CSV 内部工具 ──

/**
 * 解析 CSV 为二维数组（处理 BOM、引号包裹、双引号转义、\r\n / \n 行尾）。
 * 语义对齐 lib/tabular.ts 的 parseCsvHeaders，但返回完整行而非仅表头。
 */
function parseCsvRows(content: string): string[][] {
  const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** 将单个值按 CSV 规则转义（含逗号/引号/换行时用双引号包裹，内部引号双写）。 */
function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** 将值序列化为字符串（对象/数组用 JSON；null/undefined 为空串）。 */
function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 收集所有节点 properties 的 key（保持首次出现顺序）。 */
function collectPropertyKeys(nodes: GraphNode[]): string[] {
  const keys: string[] = [];
  const seen: Record<string, boolean> = {};
  nodes.forEach((n) => {
    Object.keys(n.properties || {}).forEach((k) => {
      if (!seen[k]) { seen[k] = true; keys.push(k); }
    });
  });
  return keys;
}

/** 收集所有边 properties 的 key（保持首次出现顺序）。 */
function collectEdgePropertyKeys(edges: GraphEdge[]): string[] {
  const keys: string[] = [];
  const seen: Record<string, boolean> = {};
  edges.forEach((e) => {
    Object.keys(e.properties || {}).forEach((k) => {
      if (!seen[k]) { seen[k] = true; keys.push(k); }
    });
  });
  return keys;
}

// ── 1. exportCSV ──

/**
 * 将图谱导出为 CSV 格式。
 * - nodes.csv：id,type,所有 properties 字段
 * - edges.csv：id,type,source,target,所有 properties 字段
 * 自动收集所有 properties 的 key 作为列；返回两个 CSV 字符串。
 */
export function exportCSV(document: GraphDocument): { nodes: string; edges: string } {
  const nodePropKeys = collectPropertyKeys(document.nodes || []);
  const nodeHeader = ['id', 'type', ...nodePropKeys].map(escapeCsvCell).join(',');
  const nodeLines = (document.nodes || []).map((n) => {
    const cells = [n.id || '', n.type || '', ...nodePropKeys.map((k) => stringifyValue((n.properties || {})[k]))];
    return cells.map(escapeCsvCell).join(',');
  });
  const nodesCsv = [nodeHeader, ...nodeLines].join('\r\n');

  const edgePropKeys = collectEdgePropertyKeys(document.edges || []);
  const edgeHeader = ['id', 'type', 'source', 'target', ...edgePropKeys].map(escapeCsvCell).join(',');
  const edgeLines = (document.edges || []).map((e) => {
    const cells = [e.id || '', e.type || '', e.source || '', e.target || '', ...edgePropKeys.map((k) => stringifyValue((e.properties || {})[k]))];
    return cells.map(escapeCsvCell).join(',');
  });
  const edgesCsv = [edgeHeader, ...edgeLines].join('\r\n');

  return { nodes: nodesCsv, edges: edgesCsv };
}

// ── 2. importCSV ──

/**
 * 从 CSV 导入构建图谱。
 * 接收 nodes CSV 字符串与 edges CSV 字符串，解析（处理引号、逗号转义），
 * 返回 { nodes: GraphNode[], edges: GraphEdge[] }。
 * id/type/source/target 为必填列；properties 由其余列自动填充。
 */
export function importCSV(nodesCsv: string, edgesCsv: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeRows = parseCsvRows(nodesCsv);
  const edgeRows = parseCsvRows(edgesCsv);

  const nodes: GraphNode[] = [];
  if (nodeRows.length >= 2) {
    const headers = nodeRows[0].map((h) => h.trim());
    for (let r = 1; r < nodeRows.length; r += 1) {
      const row = nodeRows[r];
      if (row.length === 1 && row[0] === '') continue;
      const record: Record<string, string> = {};
      headers.forEach((h, idx) => { record[h] = row[idx] !== undefined ? row[idx] : ''; });
      const id = record.id || '';
      const type = record.type || '';
      const properties: Record<string, unknown> = {};
      Object.keys(record).forEach((k) => {
        if (k === 'id' || k === 'type') return;
        if (record[k] !== '') properties[k] = record[k];
      });
      nodes.push({ id, type, properties });
    }
  }

  const edges: GraphEdge[] = [];
  if (edgeRows.length >= 2) {
    const headers = edgeRows[0].map((h) => h.trim());
    for (let r = 1; r < edgeRows.length; r += 1) {
      const row = edgeRows[r];
      if (row.length === 1 && row[0] === '') continue;
      const record: Record<string, string> = {};
      headers.forEach((h, idx) => { record[h] = row[idx] !== undefined ? row[idx] : ''; });
      const id = record.id || '';
      const type = record.type || '';
      const source = record.source || '';
      const target = record.target || '';
      const properties: Record<string, unknown> = {};
      Object.keys(record).forEach((k) => {
        if (k === 'id' || k === 'type' || k === 'source' || k === 'target') return;
        if (record[k] !== '') properties[k] = record[k];
      });
      edges.push({ id, type, source, target, properties });
    }
  }

  return { nodes, edges };
}

// ── 3. exportJSONLD ──

/**
 * 将图谱导出为 JSON-LD 格式（RDF 兼容）。
 * - 节点 → @graph 中的实体，id 作为 @id，type 作为 rdf:type
 * - 边 → 以边类型为谓词指向目标节点 { "@id": targetId }
 * - 包含 @context 声明节点类型与属性映射
 */
export function exportJSONLD(document: GraphDocument): Record<string, unknown> {
  const nodes = document.nodes || [];
  const edges = document.edges || [];

  // 收集所有节点类型与属性 key，构建 @context
  const nodeTypes = new Set<string>();
  const propKeys = new Set<string>();
  const edgeTypes = new Set<string>();
  nodes.forEach((n) => {
    if (n.type) nodeTypes.add(n.type);
    Object.keys(n.properties || {}).forEach((k) => propKeys.add(k));
  });
  edges.forEach((e) => {
    if (e.type) edgeTypes.add(e.type);
    Object.keys(e.properties || {}).forEach((k) => propKeys.add(k));
  });

  // @context：命名空间 + 属性映射（谓词用相对 IRI，避免与保留词冲突）
  const context: Record<string, unknown> = {
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    og: 'https://graph-builder.dev/graph/0.1/',
  };
  nodeTypes.forEach((t) => {
    context[t] = { '@id': 'rdf:type', '@type': '@id' };
  });
  propKeys.forEach((k) => {
    if (!context[k]) context[k] = `og:${k}`;
  });
  edgeTypes.forEach((t) => {
    if (!context[t]) context[t] = `og:${t}`;
  });

  // 按源节点分组边：sourceId → [{ edgeType, targetId }]
  const edgesBySource: Record<string, { type: string; target: string }[]> = {};
  edges.forEach((e) => {
    if (!e.source || !e.target) return;
    if (!edgesBySource[e.source]) edgesBySource[e.source] = [];
    edgesBySource[e.source].push({ type: e.type, target: e.target });
  });

  const graph = nodes.map((n) => {
    const entity: Record<string, unknown> = { '@id': n.id || '' };
    if (n.type) entity['@type'] = n.type;
    Object.keys(n.properties || {}).forEach((k) => {
      entity[k] = (n.properties as Record<string, unknown>)[k];
    });
    // 关联边作为属性引用目标节点
    const outEdges = edgesBySource[n.id] || [];
    const byType: Record<string, string[]> = {};
    outEdges.forEach((e) => {
      if (!byType[e.type]) byType[e.type] = [];
      byType[e.type].push(e.target);
    });
    Object.keys(byType).forEach((t) => {
      const targets = byType[t].map((tid) => ({ '@id': tid }));
      entity[t] = targets.length === 1 ? targets[0] : targets;
    });
    return entity;
  });

  return { '@context': context, '@graph': graph };
}

// ── 4. exportRDFTurtle ──

/** Turtle 字符串转义（仅处理字面量中需要转义的字符）。 */
function escapeTurtleLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** 将 IRI 用尖括号包裹（已是完整 IRI 则原样，否则按相对 IRI 处理）。 */
function wrapIri(iri: string): string {
  return `<${iri}>`;
}

/** 将属性值序列化为 Turtle 字面量（数字/布尔不加引号，对象/数组用 JSON 字符串）。 */
function toTurtleLiteral(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `"${escapeTurtleLiteral(stringifyValue(value))}"`;
}

/**
 * 将图谱导出为 RDF Turtle 格式。
 * - 节点 → subject，type → rdf:type
 * - 边 → predicate（source → edgeType → target）
 * - properties → 属性声明
 */
export function exportRDFTurtle(document: GraphDocument): string {
  const nodes = document.nodes || [];
  const edges = document.edges || [];
  const RDF_TYPE = wrapIri('rdf:type');

  const lines: string[] = [
    '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '@prefix og: <https://graph-builder.dev/graph/0.1/> .',
    '',
  ];

  // 节点：subject rdf:type og:NodeType ; og:prop "value" .
  nodes.forEach((n) => {
    const subject = wrapIri(n.id || '');
    const parts: string[] = [];
    if (n.type) parts.push(`${RDF_TYPE} og:${n.type}`);
    Object.keys(n.properties || {}).forEach((k) => {
      const value = (n.properties as Record<string, unknown>)[k];
      parts.push(`og:${k} ${toTurtleLiteral(value)}`);
    });
    if (parts.length === 0) {
      lines.push(`${subject} ${RDF_TYPE} og:Node .`);
    } else {
      lines.push(`${subject}`);
      parts.forEach((p, idx) => {
        lines.push(`  ${p}${idx < parts.length - 1 ? ' ;' : ' .'}`);
      });
    }
    lines.push('');
  });

  // 边：source → edgeType → target（作为 RDF 三元组）
  edges.forEach((e) => {
    if (!e.source || !e.target) return;
    const subject = wrapIri(e.source);
    const predicate = e.type ? `og:${e.type}` : 'og:linkedTo';
    const object = wrapIri(e.target);
    lines.push(`${subject} ${predicate} ${object} .`);

    // 边的 properties 附加到 source 节点（以边类型为前缀避免冲突）
    const edgePropKeys = Object.keys(e.properties || {});
    if (edgePropKeys.length > 0 && e.id) {
      const edgeSubj = wrapIri(e.id);
      const edgeParts: string[] = [`${RDF_TYPE} og:Edge`, `og:source ${wrapIri(e.source)}`, `og:target ${wrapIri(e.target)}`];
      if (e.type) edgeParts.push(`og:edgeType "${escapeTurtleLiteral(e.type)}"`);
      edgePropKeys.forEach((k) => {
        const value = (e.properties as Record<string, unknown>)[k];
        edgeParts.push(`og:${k} ${toTurtleLiteral(value)}`);
      });
      lines.push(edgeSubj);
      edgeParts.forEach((p, idx) => {
        lines.push(`  ${p}${idx < edgeParts.length - 1 ? ' ;' : ' .'}`);
      });
      lines.push('');
    }
  });

  return lines.join('\n');
}

// ── 5. exportGraphML ──

/** XML 文本转义（< > & " '）。 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 将图谱导出为 GraphML XML 格式（Cytoscape/Gephi 兼容）。
 * - <graphml> 根 + <key> 属性声明 + <graph> <node> <edge> 结构
 * - 节点/边属性通过 <data> 元素承载
 */
export function exportGraphML(document: GraphDocument): string {
  const nodes = document.nodes || [];
  const edges = document.edges || [];

  const nodePropKeys = collectPropertyKeys(nodes);
  const edgePropKeys = collectEdgePropertyKeys(edges);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns" '
      + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
      + 'xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns '
      + 'http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">',
  ];

  // 节点属性声明
  lines.push(`  <key id="node_type" for="node" attr.name="type" attr.type="string"/>`);
  nodePropKeys.forEach((k) => {
    lines.push(`  <key id="node_${escapeXml(k)}" for="node" attr.name="${escapeXml(k)}" attr.type="string"/>`);
  });
  // 边属性声明
  lines.push(`  <key id="edge_type" for="edge" attr.name="type" attr.type="string"/>`);
  edgePropKeys.forEach((k) => {
    lines.push(`  <key id="edge_${escapeXml(k)}" for="edge" attr.name="${escapeXml(k)}" attr.type="string"/>`);
  });

  lines.push(`  <graph id="G" edgedefault="undirected">`);

  // 节点
  nodes.forEach((n) => {
    lines.push(`    <node id="${escapeXml(n.id || '')}">`);
    lines.push(`      <data key="node_type">${escapeXml(n.type || '')}</data>`);
    nodePropKeys.forEach((k) => {
      const val = stringifyValue((n.properties || {})[k]);
      if (val !== '') {
        lines.push(`      <data key="node_${escapeXml(k)}">${escapeXml(val)}</data>`);
      }
    });
    lines.push(`    </node>`);
  });

  // 边
  edges.forEach((e) => {
    lines.push(`    <edge id="${escapeXml(e.id || '')}" source="${escapeXml(e.source || '')}" target="${escapeXml(e.target || '')}">`);
    lines.push(`      <data key="edge_type">${escapeXml(e.type || '')}</data>`);
    edgePropKeys.forEach((k) => {
      const val = stringifyValue((e.properties || {})[k]);
      if (val !== '') {
        lines.push(`      <data key="edge_${escapeXml(k)}">${escapeXml(val)}</data>`);
      }
    });
    lines.push(`    </edge>`);
  });

  lines.push(`  </graph>`);
  lines.push(`</graphml>`);

  return lines.join('\n');
}

// ── 6. importJSON ──

/**
 * 从 JSON 字符串导入图文档（增加结构校验）。
 * - 校验 nodes/edges 为数组
 * - 校验节点必填字段（id/type/properties）
 * - 校验边必填字段（id/type/source/target/properties）
 * - 返回 { valid, errors, document? }
 */
export function importJSON(jsonText: string): { valid: boolean; errors: string[]; document?: GraphDocument } {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return { valid: false, errors: [`JSON 解析失败：${(e as Error).message}`] };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, errors: ['根对象必须是 JSON 对象'] };
  }

  const obj = parsed as Record<string, unknown>;
  const rawNodes = obj.nodes;
  const rawEdges = obj.edges;

  if (!Array.isArray(rawNodes)) {
    errors.push('nodes 必须是数组');
  }
  if (!Array.isArray(rawEdges)) {
    errors.push('edges 必须是数组');
  }
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const nodes: GraphNode[] = [];
  (rawNodes as unknown[]).forEach((item, idx) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push(`nodes[${idx}] 必须是对象`);
      return;
    }
    const n = item as Record<string, unknown>;
    if (typeof n.id !== 'string' || n.id === '') {
      errors.push(`nodes[${idx}] 缺少必填字段 id`);
    }
    if (typeof n.type !== 'string' || n.type === '') {
      errors.push(`nodes[${idx}] 缺少必填字段 type`);
    }
    if (typeof n.properties !== 'object' || n.properties === null || Array.isArray(n.properties)) {
      errors.push(`nodes[${idx}] 缺少必填字段 properties（须为对象）`);
    }
    const node: GraphNode = {
      id: String(n.id || ''),
      type: String(n.type || ''),
      properties: (n.properties as Record<string, unknown>) || {},
    };
    if (typeof n.x === 'number') node.x = n.x;
    if (typeof n.y === 'number') node.y = n.y;
    if (n.provenance) node.provenance = n.provenance as GraphNode['provenance'];
    if (typeof n.confidence === 'number') node.confidence = n.confidence;
    if (n.review_status) node.review_status = n.review_status as GraphNode['review_status'];
    if (n.raw !== undefined) node.raw = n.raw;
    nodes.push(node);
  });

  const edges: GraphEdge[] = [];
  (rawEdges as unknown[]).forEach((item, idx) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push(`edges[${idx}] 必须是对象`);
      return;
    }
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id === '') {
      errors.push(`edges[${idx}] 缺少必填字段 id`);
    }
    if (typeof e.type !== 'string' || e.type === '') {
      errors.push(`edges[${idx}] 缺少必填字段 type`);
    }
    if (typeof e.source !== 'string' || e.source === '') {
      errors.push(`edges[${idx}] 缺少必填字段 source`);
    }
    if (typeof e.target !== 'string' || e.target === '') {
      errors.push(`edges[${idx}] 缺少必填字段 target`);
    }
    if (typeof e.properties !== 'object' || e.properties === null || Array.isArray(e.properties)) {
      errors.push(`edges[${idx}] 缺少必填字段 properties（须为对象）`);
    }
    const edge: GraphEdge = {
      id: String(e.id || ''),
      type: String(e.type || ''),
      source: String(e.source || ''),
      target: String(e.target || ''),
      properties: (e.properties as Record<string, unknown>) || {},
    };
    if (e.provenance) edge.provenance = e.provenance as GraphEdge['provenance'];
    if (typeof e.confidence === 'number') edge.confidence = e.confidence;
    if (e.review_status) edge.review_status = e.review_status as GraphEdge['review_status'];
    if (e.raw !== undefined) edge.raw = e.raw;
    edges.push(edge);
  });

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const document: GraphDocument = { nodes, edges };
  if (typeof obj.document_id === 'string') document.document_id = obj.document_id;
  if (typeof obj.document_version === 'string') document.document_version = obj.document_version;
  if (typeof obj.asset_id === 'string') document.asset_id = obj.asset_id;
  if (obj.template_ref && typeof obj.template_ref === 'object') {
    document.template_ref = obj.template_ref as GraphDocument['template_ref'];
  }
  if (obj.metadata && typeof obj.metadata === 'object') {
    document.metadata = obj.metadata as Record<string, unknown>;
  }

  return { valid: true, errors: [], document };
}
