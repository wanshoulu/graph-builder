// RFC4180 口径 CSV 解析：双引号包裹、"" 转义、跨行字段；与导出格式（intent-test-cases.csv）往返
export function parseCsvRows(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function csvToItems(text: string): { items: any[]; skipped: number } {
  const rows = parseCsvRows(text);
  if (!rows.length) return { items: [], skipped: 0 };
  const header = rows[0].map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const pick = (row: string[], name: string) => {
    const i = idx(name);
    return i >= 0 ? String(row[i] ?? "").trim() : "";
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const query = pick(row, "query");
    if (!query) { skipped += 1; continue; }
    const item: Record<string, unknown> = {
      query,
      result_type: pick(row, "result_type") || "single_intent",
      final_intent: pick(row, "final_intent"),
      action_code: pick(row, "action_code"),
      business_object: pick(row, "business_object"),
      tags: pick(row, "tags"),
      source: "batch_import",
    };
    const evalMode = pick(row, "eval_mode");
    if (evalMode) item.eval_mode = evalMode;
    const sessionId = pick(row, "session_id");
    if (sessionId) item.session_id = sessionId;
    const turnIndex = pick(row, "turn_index");
    if (turnIndex !== "" && Number.isFinite(Number(turnIndex))) item.turn_index = Number(turnIndex);
    items.push(item);
  }
  return { items, skipped };
}
