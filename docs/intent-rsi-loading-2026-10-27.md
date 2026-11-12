# Intent RSI loading performance · 2026-10-27

集成结论：后端与前端修复已部署到用户实际访问的 17386 端口。生产浏览器一次实测概览可见耗时 1.704 秒，首次状态请求 1.346 秒；随后约第 17 秒收到无响应体的 304。冷启动首次请求仍可能需要数秒，不能将单次测量解释为所有环境的延迟保证。

最终集成修复了纯模型对 TSX 运行时的依赖，88 项相关前端测试通过，类型检查与生产构建通过。下文保留修复前后的测量及后端全量测试中 1 项未通过的具体限制。后续概览信息层级调整另见易用性文档。

Scope: `legacy-bank-20261016`, local nginx17386 / ai-harbor3000. No model calls, scoring, task changes, or asset mutations were performed.

## Findings

- Before: `/state` returned11,585,758 bytes. A measured nginx request took4.761s; earlier session observations ranged2?22s.
- `evolveRuns` accounted for11.12MB. Per-round copies of model inputs alone accounted for5.68MB, plus duplicated branch training feedback/probe results.
- Instrumented handler:3.333s total,3.016s inside87 synchronous reads. Docker bind-mounted task state is31,220,480 bytes; a later isolated warm-process read cost2.175s on its own.
- State projection repeatedly reread/rehashed engine dependencies, cases and graphs.
- nginx gzip returned weak `W/"..."` ETags while the server required exact strong-tag equality, so browser conditional requests missed304.
- Auxiliary `/asset-lineage` synchronously scanned153 bundles, parsing unrelated assets before checking references; it could block subsequent state requests. The task actually references91 valid bundles.
- The client could overlap state fetches from refresh, polling, completion, and calibration. The refresh callback also depended on the parent's task-name callback, allowing renders to retrigger initial auxiliary discovery.

## Changes

- Browser state requests use explicit `view=summary`. The default full state API remains compatible.
- Summary retains every run, round, branch, score, statistic, plan, trial status, probe count, and per-case before/after change. Duplicated raw model input, attempt feedback, branch training feedback and raw probe results are omitted from the polling projection only.
- Recorded training evidence loads on opening its details through the task-scoped read-only `/run-trace?runId=...&gen=...` endpoint. No checkpoint or sealed-test reading is added.
- Each state response shares one evaluation-context/engine/graph snapshot. Promotion checks outside projection still independently validate actual assets.
- GET validators use weak comparison and incorporate current cases, split, graph, engine, running status and projection identity.
- Engine source bytes and task-state source bytes have bounded caches validated against device/inode/size/mtime/ctime. State objects are freshly JSON-parsed for every caller, preserving mutation isolation and optimistic revision behavior. External edits, atomic replacements and deletions invalidate cached bytes.
- Asset lineage filters references before IO, reads asynchronously with concurrency8, and caches validated metadata with the same file-change checks. Invalid/tampered bundles remain excluded.
- Client state requests are single-flight per task/query.304 returns the cached object, so React avoids rebuilding unchanged views. Calibration uses the same idle/running timer, hidden tabs pause normal polling, and redundant completion fetch was removed.

## Measurements after backend activation

- nginx cold summary200:3.295s /1,392,102 bytes (88.0% smaller). Next conditional304 requests:237ms,312ms,253ms, zero response body.
- Warm direct handler: summary200452ms, conditional304230ms.
- Warm nginx full response776ms versus summary388ms in a parity check.
- Asset-lineage direct handler: cold2.940s including initial task-state read; warm136ms,91 assets. Asynchronous asset reads no longer monopolize the server event loop.
- Final Vite browser QA: overview visible in1.441s, state505ms; no page errors. Task overview showed19 runs,127 candidates,57 measured,3 adopted. Opening recorded training evidence fetched19 cases in109ms. One state fetch occurred during the17s observation (headless hidden-tab polling suppression); no overlapping state requests. Dev StrictMode duplicates auxiliary initialization, while state requests share one flight. Auxiliary tasks/case-review can still take2?5s under parallel development-page load, independently of the visible overview.
- Full/summary parity:19 runs,53 rounds,144 branch records; identity, revision, baseline, scores/history, versions, archive, method history, goal, statistics and score-validity fields match. Strategy differs only in its per-request `generatedAt` timestamp.

## Verification

- Added regression coverage for weak ETags, summary/detail parity and non-mutation, unchanged file cache reads, same-size source changes with preserved mtime, deletion, task isolation, concurrent client fetch sharing,304 object identity, failure retry and nonblocking asset-lineage IO.
- Focused backend tests:84/84 pass (39 runtime,19 task-storage,26 learning/remediation).
- New client loading tests:2 pass.
- Full root `npm test`:395 tests,394 pass. Existing failure: `tests/rsi-quality-contract.test.js:141`, ?capability registry separates runnable, setup, reserved and unavailable capabilities? expects `requires_setup` but receives `ready`. This change does not modify capability registry or its readiness contract.
- Final integration restored the pure numeric dependency through `rsiNumbers.ts`; all 88 focused frontend tests pass with the standard Node test command.

## Activation and limits

ai-harbor was restarted only after live RSI tasks reported no running evolution/calibration, all stored Skill GEPA jobs were FAILED/NEEDS_REVIEW, and `docker top` showed only the server plus mock-memory helper. No active worker was interrupted. Frontend was built and deployed to both nginx SPA directories; the actual `/ontomind/index.html` entry was verified.

The first request after process restart still must read/parse the31.2MB persisted task from the Windows Docker mount, taking a few seconds. Polling avoids that IO while file stamps are unchanged. Caches are in-process and bounded; legitimate writes retain revision conflict protection.

Evidence: `D:/project/Trae/artifacts/rsi-loading-20261027/` (`after-timings.json`, `projection-parity.json`, backend/client test logs, browser captures).
