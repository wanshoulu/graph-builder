'use strict';
// 历史 QA 脚本（从单体带来）：用 Playwright 在浏览器里替换 GET /state 的响应，
// 检查 RSI 工作台的代际精度图与 DAG 渲染。需要调用方传入 playwright 模块路径、
// 一份真实引擎 report JSON，并自行准备 reports/intent-rsi-audit-*/ 输出目录。
// 独立仓地址由 RSI_BASE_URL 指定（默认 127.0.0.1:3013），不再写死单体的 17386/ontomind。
const fs = require('node:fs');
const path = require('node:path');
const modulePath = process.argv[2];
const reportPath = process.argv[3];
const { chromium } = require(modulePath);
const root = path.join(__dirname, '..');
const RSI_BASE_URL = process.env.RSI_BASE_URL || 'http://127.0.0.1:3013';
const BROWSER_PATH = process.env.RSI_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
async function main() {
  const browser = await chromium.launch({ executablePath: BROWSER_PATH, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [], writes = []; page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'OPTIONS') writes.push(r.method() + ' ' + new URL(r.url()).pathname); });
    const url = RSI_BASE_URL + '/intent-rsi';
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.locator('.rsi-evolution-view').waitFor();
    await page.locator('.rsi-evolution-view').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'reports/intent-rsi-audit-20261014/live-remediated-20261016.png') });
    await page.getByText('正式版本精度 · 最新实测', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'reports/intent-rsi-audit-20261014/live-version-charts-20261016.png') });
    await page.locator('button').filter({ hasText: /^自动进化$/ }).click();
    await page.locator('.ant-modal').waitFor();
    await page.waitForTimeout(400); // Capture after the modal entry animation.
    await page.screenshot({ path: path.join(root, 'reports/intent-rsi-audit-20261014/startup-config-20261016.png') });
    await page.locator('.ant-modal-close').click();
    const response = await page.request.get(RSI_BASE_URL + '/api/intent-rsi/state');
    const payload = await response.json();
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    payload.state.evolveRuns = [report.run]; payload.state.activeEvolution = null;
    payload.state.scoreHistory = []; payload.state.baseline = { version: report.run.baseVersion, scores: report.baseline, engineRev: report.run.engineRev };
    await page.route('**/intent-rsi/state', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }));
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('代际精度 · 收敛结果与试验分支', { exact: true }).waitFor();
    const generations = await page.locator('.rsi-evolution-summary').innerText().then(t => Number(t.match(/本实验\s*(\d+)\s*次代际尝试/)?.[1]));
    if (generations !== 3) throw new Error(`Expected three rendered generations, got ${generations}`);
    const nodes = await page.locator('.rsi-dag-node').count();
    if (nodes < 7) throw new Error(`Expected formal input and six measured branch nodes, got ${nodes}`);
    await page.evaluate(() => { const note = document.createElement('div'); note.textContent = '隔离验证 · 离线真实引擎 · 非正式收益（仅本浏览器替换 GET 数据）'; note.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#fff0c2;padding:8px;text-align:center'; document.body.appendChild(note); });
    await page.locator('.rsi-evolution-view').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'reports/intent-rsi-audit-20261014/isolated-three-generations-20261016.png') });
    await page.getByText('代际精度 · 收敛结果与试验分支', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'reports/intent-rsi-audit-20261014/isolated-generation-charts-20261016.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('逐代题型精度', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'reports/intent-rsi-audit-20261014/isolated-mobile-20261016.png') });
    const overflow = await page.evaluate(() => document.body.scrollWidth > innerWidth);
    console.log(JSON.stringify({ generations, nodes, pageErrors: errors, writes, mobileBodyOverflow: overflow, dataSource: report.mode, productionStateModified: false }));
    if (errors.length) throw new Error('Browser page errors: ' + errors.join('; '));
    if (writes.length || overflow) throw new Error('Unexpected mutation request or page overflow');
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
