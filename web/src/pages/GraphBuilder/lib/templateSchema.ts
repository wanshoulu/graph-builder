/**
 * 模板 → 编辑器 schema 适配层（纯函数，可单测）
 *
 * 输入：GraphTemplate（AI Harbor /api/org-graph/template 返回的 X6 模板 JSON）
 * 输出：编辑器 schema（sections/blocks，结构对齐 AI Harbor graph-editor 的 schema 驱动属性面板）
 *
 * block 类型：text | textarea | tags | list | select | multiSelect | number | date
 * appliesTo 为空 = 全部类型可见；required 由模板字段 required 决定。
 */
import type { GraphTemplate, GraphTemplateField } from '@/api/orgGraph';

export type EditorBlockType = 'text' | 'textarea' | 'tags' | 'list' | 'select' | 'multiSelect' | 'number' | 'date' | 'scenes';

export interface EditorBlock {
  label: string;
  key: string;
  type: EditorBlockType;
  required?: boolean;
  appliesTo?: string[];
  options?: string[];
}

export interface EditorSection {
  title: string;
  blocks: EditorBlock[];
}

export interface EditorSchema {
  templateId: string;
  node: { sections: EditorSection[] };
  edge: { sections: EditorSection[] };
  /** nodeType → 颜色 / edgeType → 颜色（模板 style.color） */
  nodeColors: Record<string, string>;
  edgeColors: Record<string, string>;
  /** 节点类型定义（画布图例用：type/label/color） */
  nodeTypeDefs: { type: string; label: string; color: string }[];
  /** 边类型定义（统计面板用：type/label/color） */
  edgeTypeDefs: { type: string; label: string; color: string }[];
  /** 模板 metadata.property_sections 声明的阶段分组（如意图图谱 结构/语义/运行 四阶段面板的通用化）；
   *  blocks 带 appliesTo，PropertyPanel 按选中类型过滤后插在基本信息与专属分组之间 */
  nodeStageSections: EditorSection[];
}

/** 模板字段类型 → 编辑器 block 类型（scenes 特例：JSON 字符串字段渲染为结构化场景卡编辑器） */
export function fieldToBlockType(field: GraphTemplateField): EditorBlockType {
  if (field.key === 'scenes') return 'scenes';
  switch (field.type) {
    case 'multiline': return 'textarea';
    case 'tags': return 'tags';
    case 'number': return 'number';
    case 'boolean': return 'select';
    case 'date': return 'date';
    case 'enum': return 'select';
    case 'multi_enum': return 'multiSelect';
    default: return 'text'; // string / url
  }
}

/** 模板字段 → block（boolean 选项 true,false；enum/multi_enum 用模板 options） */
export function fieldToBlock(field: GraphTemplateField, appliesTo?: string[]): EditorBlock {
  const block: EditorBlock = {
    label: field.label + ' ' + field.key,
    key: field.key,
    type: fieldToBlockType(field),
    required: !!field.required,
  };
  if (appliesTo && appliesTo.length) block.appliesTo = appliesTo;
  if (field.type === 'boolean') block.options = ['true', 'false'];
  if (field.type === 'enum' || field.type === 'multi_enum') block.options = field.options || [];
  return block;
}

/** 节点类型定义里第一个必填 string/multiline 字段 = 主标签（显示名） */
export function primaryFieldKey(fields: GraphTemplateField[]): string | null {
  const primary = fields.find((f) => f.required && (f.type === 'string' || f.type === 'multiline'));
  return primary ? primary.key : null;
}

/**
 * 模板 → 编辑器 schema。
 * 节点：📋 基本信息（id/主标签/类型，全部类型可见）
 *   + 阶段分组（模板 metadata.property_sections 声明，如意图图谱 结构/语义/运行 阶段面板的通用化）
 *   + 每类型一个专属分组（fields 中未被阶段分组声明的剩余字段）。
 * 边：🔗 连接层（id/类型/标签）+ 每类型一个专属分组（fields）。
 */
export function templateToEditorSchema(template: GraphTemplate): EditorSchema {
  const nodeSections: EditorSection[] = [];
  const edgeSections: EditorSection[] = [];
  const nodeColors: Record<string, string> = {};
  const edgeColors: Record<string, string> = {};
  const nodeTypeDefs: { type: string; label: string; color: string }[] = [];
  const edgeTypeDefs: { type: string; label: string; color: string }[] = [];

  const baseBlocks: EditorBlock[] = [
    { label: 'ID', key: 'id', type: 'text' },
    { label: '节点类型 nodeType', key: 'nodeType', type: 'select', options: template.node_types.map((t) => t.type) },
  ];
  // 主标签：各类型主标签字段名可能不同（如 DOCUMENT 用 title），按类型分组渲染；
  // 基本信息里放一份「名称/标题」（取第一个类型的主标签字段），供快速编辑
  const firstPrimary = primaryFieldKey((template.node_types[0] || { fields: [] }).fields);
  if (firstPrimary) baseBlocks.splice(1, 0, { label: '名称/标题', key: firstPrimary, type: 'text' });
  nodeSections.push({ title: '📋 基本信息', blocks: baseBlocks });

  // 阶段分组（property_sections：{key,label,fields:{TYPE:[fieldKey…]}}[]；声明过字段的类型不再整组平铺）
  const stageSections: EditorSection[] = [];
  const consumedKeys: Record<string, Set<string>> = {};
  const stageMeta = ((template.metadata || {}).property_sections as
    { key: string; label: string; fields: Record<string, string[]> }[] | undefined) || [];
  stageMeta.forEach((sec) => {
    const blocks: EditorBlock[] = [];
    Object.keys(sec.fields || {}).forEach((type) => {
      const nt = template.node_types.find((t) => t.type === type);
      if (!nt) return;
      (sec.fields[type] || []).forEach((key) => {
        const f = nt.fields.find((x) => x.key === key);
        if (!f) return;
        blocks.push(fieldToBlock(f, [type]));
        if (!consumedKeys[type]) consumedKeys[type] = new Set();
        consumedKeys[type].add(key);
      });
    });
    if (blocks.length) stageSections.push({ title: `${sec.label}`, blocks });
  });
  nodeSections.push(...stageSections);

  template.node_types.forEach((nt) => {
    nodeColors[nt.type] = nt.style?.color || '#5B8FF9';
    nodeTypeDefs.push({ type: nt.type, label: nt.label, color: nodeColors[nt.type] });
    // 专属分组只放未被阶段分组声明的剩余字段（全部声明过则此类型无专属分组）
    const consumed = consumedKeys[nt.type] || new Set<string>();
    const remaining = nt.fields.filter((f) => !consumed.has(f.key));
    if (remaining.length) {
      nodeSections.push({
        title: `✨ ${nt.type} · ${nt.label}`,
        blocks: remaining.map((f) => fieldToBlock(f, [nt.type])),
      });
    }
  });

  const edgeBaseBlocks: EditorBlock[] = [
    { label: 'ID', key: 'id', type: 'text' },
    { label: '关系类型 edgeType', key: 'edgeType', type: 'select', options: template.edge_types.map((t) => t.type) },
  ];
  edgeSections.push({ title: '🔗 连接层', blocks: edgeBaseBlocks });

  template.edge_types.forEach((et) => {
    edgeColors[et.type] = et.style?.color || '#64748b';
    edgeTypeDefs.push({ type: et.type, label: et.label, color: edgeColors[et.type] });
    edgeSections.push({
      title: `🔗 ${et.type} · ${et.label}`,
      blocks: et.fields.map((f) => fieldToBlock(f, [et.type])),
    });
  });

  return {
    templateId: template.template_id,
    node: { sections: nodeSections },
    edge: { sections: edgeSections },
    nodeColors,
    edgeColors,
    nodeTypeDefs,
    edgeTypeDefs,
    nodeStageSections: stageSections,
  };
}

/** block 是否适用于给定类型（appliesTo 为空 = 全部类型） */
export function blockAppliesTo(block: EditorBlock, type: string | undefined): boolean {
  if (!block.appliesTo || !block.appliesTo.length) return true;
  if (!type) return false;
  return block.appliesTo.indexOf(type) >= 0;
}

/** 必填校验：返回缺必填的元素清单（供保存/发布前预检，对齐 graph-editor collectMissingRequired）；
 *  含 scenes 字段的节点追加场景级预检（scene_type/描述≥8字/别名≥3条 + 全图唯一性，与 V4.1 §11 对齐） */
export function collectMissingRequired(
  nodes: { id: string; type?: string; properties?: Record<string, unknown> }[],
  edges: { id: string; type?: string; properties?: Record<string, unknown> }[],
  template: GraphTemplate,
): { kind: '节点' | '边'; id: string; label: string }[] {
  const missing: { kind: '节点' | '边'; id: string; label: string }[] = [];
  const nodeDefs: Record<string, GraphTemplateField[]> = {};
  const edgeDefs: Record<string, GraphTemplateField[]> = {};
  template.node_types.forEach((t) => { nodeDefs[t.type] = t.fields; });
  template.edge_types.forEach((t) => { edgeDefs[t.type] = t.fields; });
  const descSeen = new Map<string, string>();
  const aliasSeen = new Map<string, string>();
  function check(items: { id: string; type?: string; properties?: Record<string, unknown> }[], defs: Record<string, GraphTemplateField[]>, kind: '节点' | '边') {
    items.forEach((item) => {
      const fields = item.type ? defs[item.type] || [] : [];
      fields.forEach((f) => {
        if (!f.required) return;
        const value = item.properties ? item.properties[f.key] : undefined;
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) {
          missing.push({ kind, id: item.id, label: f.label });
        }
      });
      // 场景级预检（scenes 为 JSON 字符串字段；服务端 v4 校验器为权威，这里给前端即时反馈）
      if (kind === '节点' && fields.some((f) => f.key === 'scenes')) {
        const raw = String((item.properties ? item.properties.scenes : '') ?? '').trim();
        if (!raw) return;
        let scenes: unknown;
        try { scenes = JSON.parse(raw); } catch {
          missing.push({ kind, id: item.id, label: '场景 JSON 无法解析' });
          return;
        }
        if (!Array.isArray(scenes)) {
          missing.push({ kind, id: item.id, label: '场景必须是 JSON 数组' });
          return;
        }
        scenes.forEach((scene, i) => {
          const tag = `场景${i + 1}`;
          const s = (scene || {}) as Record<string, unknown>;
          if (!s.scene_type) missing.push({ kind, id: item.id, label: `${tag}·scene_type` });
          const sem = (s.semantic_definition || {}) as Record<string, unknown>;
          const desc = typeof sem.description === 'string' ? sem.description.trim() : '';
          if (desc.length < 8) {
            missing.push({ kind, id: item.id, label: `${tag}·描述不足8字` });
          } else if (descSeen.has(desc) && descSeen.get(desc) !== item.id) {
            missing.push({ kind, id: item.id, label: `${tag}·描述与其他场景重复` });
          } else if (!descSeen.has(desc)) {
            descSeen.set(desc, item.id as string);
          }
          const retrieval = (s.retrieval_profile || {}) as Record<string, unknown>;
          const aliases = Array.isArray(retrieval.aliases) ? retrieval.aliases.map(String) : [];
          if (aliases.length < 3) {
            missing.push({ kind, id: item.id, label: `${tag}·别名不足3条` });
          }
          aliases.forEach((a) => {
            const key = a.trim();
            if (!key) return;
            if (aliasSeen.has(key) && aliasSeen.get(key) !== item.id) {
              missing.push({ kind, id: item.id, label: `${tag}·别名「${key.slice(0, 12)}」已被占用` });
            } else if (!aliasSeen.has(key)) {
              aliasSeen.set(key, item.id as string);
            }
          });
        });
      }
    });
  }
  check(nodes, nodeDefs, '节点');
  check(edges, edgeDefs, '边');
  return missing;
}
