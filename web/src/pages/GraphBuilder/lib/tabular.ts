/**
 * 客户端 CSV/JSON 解析（列映射 UI 用；纯函数）
 * CSV 解析语义对齐后端 knowledge-builder-data-import.parseCsv（引号包裹/转义/表头唯一）
 */

export interface ParseResult {
  headers: string[];
  rowCount: number;
}

export function parseCsvHeaders(content: string): ParseResult {
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
  const headers = (rows[0] || []).map((h) => h.trim()).filter((h) => h !== '');
  return { headers, rowCount: Math.max(rows.length - 1, 0) };
}

export function parseJsonHeaders(content: string): ParseResult {
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed) || !parsed.length || typeof parsed[0] !== 'object') {
    throw new Error('JSON 必须是对象数组');
  }
  const headers: string[] = [];
  parsed.forEach((row) => {
    Object.keys(row).forEach((k) => { if (!headers.includes(k)) headers.push(k); });
  });
  return { headers, rowCount: parsed.length };
}
