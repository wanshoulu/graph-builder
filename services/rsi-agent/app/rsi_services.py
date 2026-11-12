"""A 档接入：openjiuwen RSI 内脏的文件契约适配 + 服务封装。

两个能力：
1. AnalyzeService —— 把 Node 侧引擎打分行适配成 EvaluationResultAnalyzer
   期望的文件布局（eval_ref.yaml + summary.json + cases/<id>/result.json+trace.json），
   跑逐案诊断，返回结构化 issues（补缺口①：归因不再锁死在图谱层）。
2. ExperienceService —— 包 ExperienceStore，失败/教训跨轮检索注入
   （补缺口②：propose_fail/门禁拒绝不再只计数）。

输入契约（POST /v1/tasks/analyze 的 payload.data）：
    summary: {total_cases, passed_cases, failed_cases, average_score, evaluation_method}
    cases: [{case_id, status, score, query, expected_intents, predicted, result_type, ...}]
"""

from __future__ import annotations

import json
import logging
import tempfile
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

from app.rsi_compat import (
    EvaluationResultAnalyzer,
    EvaluationResultAnalyzerConfig,
    EvaluationResultAnalysisInvocation,
    Experience,
    ExperienceStore,
    ExperienceType,
)

logger = logging.getLogger("rsi_agent.rsi_services")


def _yaml_dump_minimal(data: dict[str, Any]) -> str:
    """无 PyYAML 依赖时也能产出可被 safe_load 的 YAML（本服务场景键值均为标量/浅层）。"""
    try:
        import yaml

        return yaml.safe_dump(data, allow_unicode=True, sort_keys=False)
    except ImportError:
        lines = []
        for k, v in data.items():
            if isinstance(v, str):
                lines.append(f"{k}: {json.dumps(v, ensure_ascii=False)}")
            else:
                lines.append(f"{k}: {v}")
        return "\n".join(lines) + "\n"


class AnalyzeService:
    """引擎打分行 → 文件契约 → EvaluationResultAnalyzer。"""

    def __init__(self, model_config_ref: str, experience_dir: str, work_root: str):
        self._model_config_ref = model_config_ref
        self._experience_dir = experience_dir
        self._work_root = Path(work_root)
        self._work_root.mkdir(parents=True, exist_ok=True)

    async def analyze(self, payload: dict[str, Any]) -> dict[str, Any]:
        started = time.time()
        summary = payload.get("summary") or {}
        cases = payload.get("cases") or []
        if not cases:
            return {"status": "error", "error": "cases 为空"}

        run_dir = self._work_root / f"analyze-{int(time.time())}-{id(cases) % 10000}"
        run_dir.mkdir(parents=True, exist_ok=True)
        try:
            eval_ref_path = self._write_layout(run_dir, summary, cases)
            config = EvaluationResultAnalyzerConfig(
                model_config_ref=self._model_config_ref,
                diagnosis_agent_model_config_ref=self._model_config_ref,
                diagnosis_agent_max_retries=1,
                diagnosis_agent_max_concurrency=4,
                diagnosis_agent_max_iterations=8,
                causal_investigation_required=False,
                max_issues=12,
                evidence_limit_per_issue=3,
            )
            analyzer = EvaluationResultAnalyzer(config)
            invocation = EvaluationResultAnalysisInvocation(
                eval_ref_path=str(eval_ref_path),
                case_results_dir=str(run_dir / "cases"),
                case_traces_dir="",
                team_skill_ref_path="",
                harness_refs_path="",
                output_dir=str(run_dir / "out"),
                source_stage="verify",
            )
            result = await analyzer.analyze(invocation)
            return {
                "status": "ok",
                "elapsedSec": round(time.time() - started, 1),
                "result": self._artifact_to_dict(result),
                "runDir": str(run_dir),
            }
        except Exception as exc:
            logger.error("analyze failed: %s", exc, exc_info=True)
            return {"status": "error", "error": f"{type(exc).__name__}: {exc}"}

    def _write_layout(self, run_dir: Path, summary: dict[str, Any], cases: list[dict[str, Any]]) -> Path:
        """按 CaseReader 的读取约定落盘：summary.json + cases/<id>/result.json+trace.json。"""
        cases_dir = run_dir / "cases"
        cases_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "out").mkdir(parents=True, exist_ok=True)
        summary_path = run_dir / "summary.json"
        summary_path.write_text(
            json.dumps(
                {
                    "total_cases": summary.get("total_cases", len(cases)),
                    "passed_cases": summary.get("passed_cases", sum(1 for c in cases if c.get("strict"))),
                    "failed_cases": summary.get("failed_cases", sum(1 for c in cases if not c.get("strict"))),
                    "average_score": summary.get("average_score", 0.0),
                    "evaluation_method": summary.get("evaluation_method", "intent_engine_v2"),
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        for c in cases:
            case_dir = cases_dir / str(c.get("case_id", "case"))
            case_dir.mkdir(parents=True, exist_ok=True)
            evaluation_passed = bool(c.get("strict"))
            evaluation_reason = self._reason_of(c)
            (case_dir / "result.json").write_text(
                json.dumps(
                    {
                        "case_id": c.get("case_id"),
                        "status": c.get("status") or ("passed" if evaluation_passed else "failed"),
                        "score": float(c.get("relaxed") or 0.0),
                        "error": "",
                        "evaluation": {
                            "method": c.get("evaluation_method", "intent_engine_v2"),
                            "passed": evaluation_passed,
                            "reason": evaluation_reason,
                            "metadata": {
                                "shape": c.get("shape", ""),
                                "result_type": c.get("resultType", ""),
                                "expected_intents": c.get("expected", []),
                                "predicted_set": c.get("predictedSet", []),
                                "candidates": (c.get("predicted") or {}).get("candidates", []),
                                "clarifying": (c.get("predicted") or {}).get("clarifying", False),
                            },
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (case_dir / "trace.json").write_text(
                json.dumps(
                    {
                        "input": c.get("query", ""),
                        "response": json.dumps(
                            {
                                "top1": (c.get("predicted") or {}).get("top1"),
                                "predicted_set": c.get("predictedSet", []),
                                "clarifying": (c.get("predicted") or {}).get("clarifying", False),
                                "candidates": (c.get("predicted") or {}).get("candidates", []),
                            },
                            ensure_ascii=False,
                        ),
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        eval_ref = run_dir / "eval_ref.yaml"
        eval_ref.write_text(_yaml_dump_minimal({"summary_path": str(summary_path)}), encoding="utf-8")
        return eval_ref

    @staticmethod
    def _reason_of(c: dict[str, Any]) -> str:
        parts = []
        if c.get("resultType"):
            parts.append(str(c["resultType"]))
        exp = "、".join(c.get("expected") or [])
        pred = c.get("predicted") or {}
        if pred.get("clarifying"):
            parts.append(f"触发澄清，候选={('、'.join(pred.get('candidates') or []))}，期望={exp}")
        else:
            got = pred.get("top1") or "无"
            parts.append(f"期望={exp}，top1={got}")
        return "；".join(parts)

    @staticmethod
    def _artifact_to_dict(result: Any) -> Any:
        """分析产物 → 可 JSON 化结构（dataclass/str 均兼容）。"""
        if result is None:
            return None
        if isinstance(result, str):
            path = Path(result)
            if path.suffix in (".yaml", ".yml") and path.exists():
                try:
                    import yaml

                    return yaml.safe_load(path.read_text(encoding="utf-8"))
                except Exception:
                    return {"artifact_path": result}
            try:
                return json.loads(result)
            except (json.JSONDecodeError, ValueError):
                return {"artifact_path": result}
        if hasattr(result, "__dataclass_fields__"):
            return asdict(result)
        if hasattr(result, "model_dump"):
            return result.model_dump(mode="json", ensure_ascii=False)
        if isinstance(result, dict):
            return result
        return {"repr": str(result)[:2000]}


class ExperienceService:
    """ExperienceStore 薄封装：record + search（按 family/意图 topic 检索）。"""

    def __init__(self, experience_dir: str):
        self._store = ExperienceStore(experience_dir)

    async def record(self, payload: dict[str, Any]) -> dict[str, Any]:
        exp_type_raw = str(payload.get("type") or "failure").lower()
        exp_type = ExperienceType.FAILURE
        if exp_type_raw == "optimization":
            exp_type = ExperienceType.OPTIMIZATION
        elif exp_type_raw == "insight":
            exp_type = ExperienceType.INSIGHT
        experience = Experience(
            type=exp_type,
            topic=str(payload.get("topic") or "")[:200],
            summary=str(payload.get("summary") or "")[:2000],
            outcome=str(payload.get("outcome") or "")[:2000],
            details=str(payload.get("details") or "")[:8000],
            signal=str(payload.get("signal") or "")[:500],
            strategy=str(payload.get("strategy") or "")[:2000],
            causal_chain=str(payload.get("causal_chain") or "")[:4000],
            files_changed=[str(f) for f in (payload.get("files_changed") or [])][:50],
        )
        exp_id = await self._store.record(experience)
        return {"status": "ok", "recorded": bool(exp_id), "id": exp_id}

    async def search(self, query: str, top_k: int = 5) -> dict[str, Any]:
        hits = await self._store.search(query, top_k=max(1, min(top_k, 20)))
        items = []
        for h in hits:
            d = asdict(h) if hasattr(h, "__dataclass_fields__") else dict(h)
            items.append(
                {
                    "id": d.get("id", ""),
                    "type": str(d.get("type", "")),
                    "topic": d.get("topic", ""),
                    "summary": d.get("summary", ""),
                    "outcome": d.get("outcome", ""),
                    "strategy": d.get("strategy", ""),
                    "causal_chain": d.get("causal_chain", ""),
                }
            )
        return {"status": "ok", "items": items}

    async def recent(self, limit: int = 10) -> dict[str, Any]:
        hits = await self._store.list_recent(limit=max(1, min(limit, 50)))
        items = []
        for h in hits:
            d = asdict(h) if hasattr(h, "__dataclass_fields__") else dict(h)
            items.append({"id": d.get("id", ""), "type": str(d.get("type", "")), "topic": d.get("topic", ""), "summary": d.get("summary", "")})
        return {"status": "ok", "items": items}


class PromptOptimizeService:
    """prompt 层 RSI：用 MemberOptimizer（single_harness + prompt-only 白名单）优化
    本服务某个任务 skill 的提示词。

    输入契约（POST /v1/rsi/optimize-prompt）：
        skill: "propose" | "attribute"（优化对象，同时是 harness 角色名）
        current_prompt: 当前生效的 skill 正文（Node 侧持有生效副本）
        issues: [{id, summary, severity, recommendation, evidence(list[str])}]
        cases: [{case_id, query}]（hypothesis 编译用，公开输入文本即可）
        max_actions: 单轮最多改动条数（默认 2）

    流程：种 harness 目录（prompt_sections/files/core.md = current_prompt）
    → analysis_ref.yaml（issues 映射成 TeamIssue，optimization_target=member_harness，
       target_ref=member_harness.<skill>.prompt ⇒ instruction lever ⇒ prompt_section surface）
    → compile_optimization_hypotheses → MemberOptimizer.optimize(single_harness=True,
       defer_publish=True) → 读回优化后的 prompt 正文。
    """

    def __init__(self, model_config_ref: str, work_root: str):
        self._model_config_ref = model_config_ref
        self._work_root = Path(work_root)
        self._work_root.mkdir(parents=True, exist_ok=True)
        # 串行锁：openjiuwen 的文件锁以全局 /tmp/openjiuwen-fs-rwlocks 为粒度，
        # 两个 optimize 并发会互相等锁 30s 后报错——一次只跑一个，后来的排队
        import asyncio

        self._lock = asyncio.Lock()

    async def optimize(self, payload: dict[str, Any]) -> dict[str, Any]:
        from app.rsi_compat import MemberOptimizer

        if MemberOptimizer is None:
            return {"status": "error", "error": "openjiuwen MemberOptimizer 不可用"}

        async with self._lock:
            return await self._optimize_locked(payload)

    async def _optimize_locked(self, payload: dict[str, Any]) -> dict[str, Any]:
        from app.rsi_compat import MemberOptimizer, MemberOptimizerConfig, compile_optimization_hypotheses

        if MemberOptimizer is None or MemberOptimizerConfig is None or compile_optimization_hypotheses is None:
            return {"status": "error", "error": "openjiuwen MemberOptimizer 不可用"}

        started = time.time()
        skill = str(payload.get("skill") or "propose").strip().lower()
        current_prompt = str(payload.get("current_prompt") or "").strip()
        issues = [i for i in (payload.get("issues") or []) if str(i.get("summary") or "").strip()]
        cases = [c for c in (payload.get("cases") or []) if str(c.get("case_id") or "").strip()]
        max_actions = max(1, min(int(payload.get("max_actions") or 2), 4))
        if not current_prompt:
            return {"status": "error", "error": "current_prompt 为空"}
        if not issues:
            return {"status": "error", "error": "issues 为空——没有可优化的反馈信号"}

        run_dir = self._work_root / f"prompt-opt-{int(time.time())}"
        run_dir.mkdir(parents=True, exist_ok=True)
        try:
            # ① seed harness：单角色，prompt surface = prompt_sections/files/core.md
            role = skill
            harness_dir = run_dir / "harness" / role
            sections_dir = harness_dir / "prompt_sections"
            (sections_dir / "files").mkdir(parents=True, exist_ok=True)
            (sections_dir / "files" / "core.md").write_text(current_prompt, encoding="utf-8")
            # file 值为 harness 根相对路径（jiuwen 规范：executor 直接以它作 target_rel，
            # 写成 "files/core.md" 会被拼成 files/files/core.md）
            (sections_dir / "sections.yaml").write_text(
                _yaml_dump_minimal({"sections": [{"name": "core", "file": "prompt_sections/files/core.md", "priority": 10}]}),
                encoding="utf-8",
            )
            (harness_dir / "harness.yaml").write_text(
                _yaml_dump_minimal({"role": role, "version": 1}), encoding="utf-8"
            )
            harness_refs = run_dir / "harness_refs.yaml"
            harness_refs.write_text(
                _yaml_dump_minimal(
                    {
                        "roles": [
                            {
                                "role": role,
                                "member_name": role,
                                "harness_ref_path": str(harness_dir),
                                "description": f"RSI {skill} skill 提示词（唯一角色）",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

            # ② analysis_ref：issues → TeamIssue 契约（仅 member_harness 目标进入优化）
            # 0.1.19 起 decision_contract.acceptance_observable 必须显式供给（无回退推断）
            analysis_ref = run_dir / "analysis_ref.yaml"
            team_issues = []
            for idx, it in enumerate(issues[:10]):
                team_issues.append(
                    {
                        "issue_id": str(it.get("id") or f"issue-{idx + 1}"),
                        "category": str(it.get("category") or "quality"),
                        "severity": str(it.get("severity") or "medium"),
                        "summary": str(it.get("summary"))[:500],
                        "affected_cases": [str(c) for c in (it.get("affected_cases") or [])][:10],
                        "evidence": [{"detail": str(e)[:300]} for e in (it.get("evidence") or [])[:5]],
                        "suspected_team_scope": [role],
                        "optimization_target": "member_harness",
                        "target_members": [role],
                        "recommendation": str(it.get("recommendation") or "")[:500],
                        "metadata": {
                            "attribution": {
                                "target_ref": f"member_harness.{role}.prompt",
                                "decision_contract": {
                                    "wrong_decision": str(it.get("wrong_decision") or it.get("summary") or "")[:300],
                                    "causal_distinction": str(it.get("causal_distinction") or it.get("summary") or "")[:300],
                                    "required_action": str(it.get("recommendation") or "")[:300],
                                    "acceptance_observable": str(it.get("acceptance_observable") or "下一轮提案的门禁拦截率较本轮下降")[:300],
                                    "activation_phase": "pre_submission",
                                },
                            }
                        },
                    }
                )
            analysis_ref.write_text(_yaml_dump_minimal({"issues": team_issues}), encoding="utf-8")

            # ③ eval_ref（MemberOptimizer 读取的最小契约：summary_path 指向 summary.json）
            summary_path = run_dir / "summary.json"
            summary_path.write_text(
                json.dumps(
                    {
                        "total_cases": len(cases),
                        "passed_cases": 0,
                        "failed_cases": len(cases),
                        "average_score": 0.0,
                        "evaluation_method": "intent_rsi_feedback",
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            eval_ref = run_dir / "eval_ref.yaml"
            eval_ref.write_text(_yaml_dump_minimal({"summary_path": str(summary_path)}), encoding="utf-8")

            # ④ hypotheses：single_harness 模式必填（immutable，content_sha256 防篡改）
            hyp_path = run_dir / "optimization_hypotheses.yaml"
            hypothesis_cases = [{"case_id": str(c.get("case_id")), "input": str(c.get("query") or "")} for c in cases[:20]]
            compile_optimization_hypotheses(
                analysis_ref_path=str(analysis_ref),
                cases=hypothesis_cases,
                output_path=str(hyp_path),
            )

            # ⑤ 跑优化器：prompt-only 白名单、单角色、不动 current（defer_publish）
            config = MemberOptimizerConfig(
                model_config_ref=self._model_config_ref,
                action_group_configs=["prompt"],
                allowed_action_groups=["prompt"],
                allowed_prompt_surfaces=["prompt_section"],
                max_roles_per_run=1,
                max_actions_per_plan=max_actions,
            )
            optimizer = MemberOptimizer(config)
            member_ref = await optimizer.optimize(
                eval_ref_path=str(eval_ref),
                analysis_result_path=str(analysis_ref),
                harness_refs_path=str(harness_refs),
                output_dir=str(run_dir / "member_optimizations"),
                defer_publish=True,
                single_harness=True,
                optimization_hypotheses_path=str(hyp_path),
            )

            # ⑥ 读回优化产物：member_optimization_ref → optimized_harness_refs → prompt 正文
            return await self._collect_result(run_dir, Path(member_ref), role, started)
        except Exception as exc:
            logger.error("prompt optimize failed: %s", exc, exc_info=True)
            return {"status": "error", "error": f"{type(exc).__name__}: {exc}", "runDir": str(run_dir)}

    async def _collect_result(self, run_dir: Path, member_ref: Path, role: str, started: float) -> dict[str, Any]:
        import yaml as _yaml

        info = _yaml.safe_load(member_ref.read_text(encoding="utf-8")) or {}
        status = str(info.get("status") or "")
        opt_refs_path = str(info.get("optimized_harness_refs_path") or "")
        if status and status != "ok":
            return {
                "status": "noop",
                "reason": status,
                "runDir": str(run_dir),
                "elapsedSec": round(time.time() - started, 1),
            }
        if not opt_refs_path:
            return {"status": "error", "error": f"member_optimization_ref 缺 optimized_harness_refs_path：{member_ref}", "runDir": str(run_dir)}

        refs = _yaml.safe_load(Path(opt_refs_path).read_text(encoding="utf-8")) or {}
        role_map = refs.get("harness_refs") or {}
        cand_path = str(role_map.get(role) or (refs.get("roles") or [{}])[0].get("harness_ref_path") or "")
        if not cand_path or not Path(cand_path).exists():
            return {"status": "error", "error": f"候选 harness 不存在: {cand_path}", "runDir": str(run_dir)}

        sections_yaml = Path(cand_path) / "prompt_sections" / "sections.yaml"
        manifest = _yaml.safe_load(sections_yaml.read_text(encoding="utf-8")) or {}
        parts = []
        for sec in manifest.get("sections") or []:
            f = str(sec.get("file") or "")
            if f:
                # file 是 harness 根相对路径（可能带或不带 prompt_sections/ 前缀，双兜底）
                p = Path(cand_path) / f
                if not p.exists():
                    p = Path(cand_path) / "prompt_sections" / f
                if p.exists():
                    parts.append(p.read_text(encoding="utf-8").strip())
        optimized_prompt = "\n\n".join([x for x in parts if x])
        if not optimized_prompt.strip():
            return {"status": "error", "error": "候选 harness 无 prompt 正文", "runDir": str(run_dir)}

        # 动作明细（plan/execution 摘要，供前端展示改了什么）
        actions = []
        plan_path = run_dir / "member_optimizations"
        for p in sorted(plan_path.rglob("plan.yaml"))[:1]:
            try:
                plan = _yaml.safe_load(p.read_text(encoding="utf-8")) or {}
                for act in plan.get("actions") or []:
                    actions.append(
                        {
                            "operation": str(act.get("operation") or ""),
                            "target": str(act.get("target") or ""),
                            "rationale": str(act.get("rationale") or act.get("reason") or "")[:300],
                        }
                    )
            except Exception:
                pass

        return {
            "status": "ok",
            "optimizedPrompt": optimized_prompt,
            "candidateHarnessPath": cand_path,
            "actions": actions[:6],
            "runDir": str(run_dir),
            "elapsedSec": round(time.time() - started, 1),
        }
