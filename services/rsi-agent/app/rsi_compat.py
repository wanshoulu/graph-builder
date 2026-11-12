"""openjiuwen RSI 模块双路径兼容 shim。

背景：openjiuwen 0.1.18+ 把 RSI 套件从 ``openjiuwen.rsi.*`` 迁移到
``openjiuwen.rsi.harness_rsi.*``（旧路径删除）。本服务可能在
0.1.17.post1（旧路径）或 0.1.19（新路径）上运行，集中在此处做兼容，
业务代码只 import 本模块，不散落 try/except。

用法：
    from app.rsi_compat import ExperienceStore, EvaluationResultAnalyzer
"""

from __future__ import annotations

import logging

logger = logging.getLogger("rsi_agent.rsi_compat")

# 0.1.18+ 路径在前，0.1.17.post1 路径兜底
try:  # 0.1.19+
    import openjiuwen.rsi.harness_rsi as _RS  # noqa: N813
except ImportError:  # 0.1.17.post1
    import openjiuwen.rsi as _RS  # noqa: N813

RSI_BASE = _RS.__name__
"""当前生效的 RSI 基础包名（探测用，暴露给 /health）。"""


def _sym(module: str, name: str):
    """从相对 RSI 基础包的子模块导入符号，带清晰错误信息。"""
    import importlib

    full = f"{RSI_BASE}.{module}"
    try:
        mod = importlib.import_module(full)
    except ImportError as exc:
        raise ImportError(f"openjiuwen RSI 模块不可用: {full} ({exc})") from exc
    if not hasattr(mod, name):
        raise ImportError(f"{full} 缺少符号 {name}")
    return getattr(mod, name)


# ── 经验库（缺口②：失败沉淀）──
ExperienceStore = _sym("auto_harness.experience.experience_store", "ExperienceStore")
Experience = _sym("auto_harness.schema", "Experience")
ExperienceType = _sym("auto_harness.schema", "ExperienceType")

# ── 分析定位（缺口①：归因空间）──
EvaluationResultAnalyzer = _sym("evaluation_result_analyzer.analyzer", "EvaluationResultAnalyzer")
EvaluationResultAnalyzerConfig = _sym("evaluation_result_analyzer.analyzer", "EvaluationResultAnalyzerConfig")
EvaluationResultAnalysisInvocation = _sym(
    "evaluation_result_analyzer.analyzer", "EvaluationResultAnalysisInvocation"
)

# ── 机制归因（缺口③：prompt 层自优化）──
try:
    MemberOptimizer = _sym("member_optimizer.optimizer", "MemberOptimizer")
    MemberOptimizerConfig = _sym("config", "MemberOptimizerConfig")
    compile_optimization_hypotheses = _sym(
        "member_optimizer.hypothesis", "compile_optimization_hypotheses"
    )
except ImportError:  # pragma: no cover - 0.1.17.post1 同样存在，仅防御
    MemberOptimizer = None
    MemberOptimizerConfig = None
    compile_optimization_hypotheses = None

__all__ = [
    "RSI_BASE",
    "ExperienceStore",
    "Experience",
    "ExperienceType",
    "EvaluationResultAnalyzer",
    "EvaluationResultAnalyzerConfig",
    "EvaluationResultAnalysisInvocation",
    "MemberOptimizer",
    "MemberOptimizerConfig",
    "compile_optimization_hypotheses",
]
