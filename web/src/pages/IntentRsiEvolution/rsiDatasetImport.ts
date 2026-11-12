/**
 * 题目导入的本地预检与模板（codex 2026-10-18 复审 P1④）：
 * 业务人员不上代码也能完成——下载模板照着填、上传先本地逐行预检（行号+原因）、
 * 预览题数/题型分布确认后再提交；后端 importReport 的逐行错误同样渲染成表。
 * 校验规则与后端 normalizeCases 对齐（rsi-task-dataset.js），前端先挡一道，
 * 后端仍是权威（fail-fast 并返回完整报告）。
 */
export interface LocalIssue { index: number; caseId: string | null; reason: string }

const SHAPES = ['single_intent', 'multi_intent', 'ambiguous_intent'];
const SHAPE_LABEL: Record<string, string> = {
  single_intent: '单意图', multi_intent: '多意图', ambiguous_intent: '模糊提问',
};

export interface TemplateCase {
  case_id: string; query: string; intent_shape: string;
  expected_intents: string[]; difficulty?: string; note?: string;
}

/** 三种题型各一条示例 + 一条故意错行（说明错误提示长什么样） */
export function templateCases(): TemplateCase[] {
  return [
    { case_id: 'demo-single-001', query: '帮我查一下这个月物业费还有多少钱没交', intent_shape: 'single_intent', expected_intents: ['<替换单意图ID>'], difficulty: 'easy', note: '单意图：一句话一个需求，答案恰一个意图' },
    { case_id: 'demo-multi-001', query: '帮我报修客厅的灯，然后再查一下报修进度', intent_shape: 'multi_intent', expected_intents: ['<替换意图ID-1>', '<替换意图ID-2>'], difficulty: 'medium', note: '多意图：一句话两个需求（用「再/然后/还要」连接），答案按子句顺序列两个' },
    { case_id: 'demo-ambig-001', query: '这个费用是怎么回事', intent_shape: 'ambiguous_intent', expected_intents: ['<意图ID-A>', '<意图ID-B>'], difficulty: 'hard', note: '模糊提问：问法落在两个意图之间，期望行为是系统反问澄清，答案填这两个候选意图' },
  ];
}

/** 与后端 normalizeCases 同口径的本地预检（只能挡格式错；意图 ID 是否属于图谱由后端判） */
export function localCheck(raw: unknown): { cases: TemplateCase[]; issues: LocalIssue[] } {
  const issues: LocalIssue[] = [];
  const cases: TemplateCase[] = [];
  if (!Array.isArray(raw)) return { cases, issues: [{ index: -1, caseId: null, reason: '文件顶层必须是 JSON 数组（或含 cases 字段的对象）' }] };
  raw.forEach((item, index) => {
    const id = (item && typeof item === 'object' && String((item as Record<string, unknown>).case_id || (item as Record<string, unknown>).caseId || '')) || null;
    try {
      if (!item || typeof item !== 'object') throw new Error('题目必须是对象');
      const c = item as Record<string, unknown>;
      const cid = String(c.case_id || c.caseId || '').trim();
      if (!cid) throw new Error('缺少 case_id（题目唯一编号）');
      if (cases.some(x => x.case_id === cid)) throw new Error(`case_id 重复: ${cid}`);
      if (typeof c.query !== 'string' || !c.query.trim()) throw new Error('query 必须是非空字符串');
      const shapeRaw = String(c.intent_shape || c.category || '');
      const shape = SHAPES.includes(shapeRaw) ? shapeRaw : ({ MULTI: 'multi_intent', COMPOUND: 'multi_intent', AMBIGUOUS: 'ambiguous_intent', SINGLE: 'single_intent', NEGATIVE: 'negative_intent' } as Record<string, string>)[shapeRaw.toUpperCase()];
      if (!shape) throw new Error(`未知题型「${shapeRaw || '空'}」——须为 single_intent / multi_intent / ambiguous_intent`);
      const expected = (c.expected_intents ?? ((c.expected as Record<string, unknown>)?.intentId ? [(c.expected as Record<string, unknown>).intentId] : (c.expected as Record<string, unknown>)?.intentIds || [])) as unknown;
      if (!Array.isArray(expected) || expected.some(x => typeof x !== 'string' || !String(x).trim())) throw new Error('expected_intents 必须是非空字符串数组');
      if (shape === 'negative_intent' ? expected.length !== 0 : expected.length === 0) throw new Error('题型与答案数量不兼容');
      if (shape === 'single_intent' && expected.length !== 1) throw new Error('单意图题必须恰有一个标准答案');
      if (shape === 'multi_intent' && expected.length < 2) throw new Error('多意图题至少需要两个标准答案');
      if (String(expected[0]).startsWith('<')) throw new Error('答案还是模板占位符（<...>），请替换成真实意图 ID');
      cases.push({ case_id: cid, query: c.query, intent_shape: shape, expected_intents: expected as string[], difficulty: c.difficulty as string | undefined, note: c.note as string | undefined });
    } catch (e) { issues.push({ index, caseId: id, reason: (e as Error).message }); }
  });
  return { cases, issues };
}

/** 题型分布一行摘要（预览确认用） */
export function shapeDistLine(cases: TemplateCase[]): string {
  const dist = new Map<string, number>();
  for (const c of cases) dist.set(c.intent_shape, (dist.get(c.intent_shape) || 0) + 1);
  return [...dist.entries()].map(([s, n]) => `${SHAPE_LABEL[s] || s} ${n}`).join(' · ') || '无';
}

/** 下载 JSON 模板（三种题型示例 + 填写说明字段） */
export function downloadTemplate(): void {
  const tpl = {
    _说明: '把本数组替换/补充为你的题目。case_id 全表唯一；expected_intents 填图谱里的意图 ID（可到图谱页查看）；不确定就先导 3-5 道试错，导入失败会逐行告诉你原因。',
    _字段: { case_id: '唯一编号', query: '用户原话', intent_shape: 'single_intent|multi_intent|ambiguous_intent', expected_intents: '期望意图 ID 数组', difficulty: '可选 easy|medium|hard', note: '可选出题动机' },
    示例题目: templateCases(),
  };
  const blob = new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '评测题目模板.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 后端 importReport.errors → 本地同构 issue 表（渲染复用） */
export function reportToIssues(report: { errors?: { index: number; caseId: string | null; reason: string }[] } | undefined | null): LocalIssue[] {
  return (report?.errors || []).map(e => ({ index: e.index, caseId: e.caseId ?? null, reason: e.reason }));
}
