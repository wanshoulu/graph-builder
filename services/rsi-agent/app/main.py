"""RSI 进化 Agent 服务 FastAPI 入口（任务型：归因 attribute / 提案 propose）。"""

from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# 关键顺序：skill 文本从烧进镜像的模块加载（文件系统在 openjiuwen 环境 + WSL2 bind mount
# 下均不可靠：harness 接管 .md 访问、bind mount 视图陈旧——见 app/skill_texts.py 说明）
from app.config import SUPPORTED_TASKS, RsiAgentSettings
from app.skill_texts import SKILL_TEXTS as _SKILL_TEXTS

_BOOT_SETTINGS = RsiAgentSettings.from_env()

from app.agent_factory import RsiAgentFactory, load_skill_prompt  # noqa: E402

logger = logging.getLogger("rsi_agent")
logging.basicConfig(level=logging.INFO)


class TaskRequest(BaseModel):
    # Node 侧组装的动态上下文：引擎归因摘要（attribute）/ 归因结论+画像+死因（propose）
    context: str = Field(default="", description="任务上下文（动态段，由 Node 侧注入）")
    # prompt 层 RSI：Node 侧 state 持有的生效 skill 正文（已采纳的优化提示词）。
    # 非空时绕过烧录默认 prompt 构建一次性 agent（不进缓存）
    skill_override: str = Field(default="", description="skill 提示词覆盖（prompt 层 RSI 产物）")
    # 工具回调上下文（如 {"branch": "b3"}）：随每个工具调用透传给 Node 侧 /agent/* 端点，
    # 用于多分支进化把调研工具路由到对应分支图谱——不再临时改写 Node 持久化 state
    tool_ctx: dict = Field(default_factory=dict, description="工具回调上下文（透传查询参数）")


class AnalyzeRequest(BaseModel):
    # A 档：引擎打分行 → EvaluationResultAnalyzer 逐案诊断
    summary: dict = Field(default_factory=dict)
    cases: list = Field(default_factory=list)


class ExperienceRecordRequest(BaseModel):
    type: str = Field(default="failure", description="optimization / failure / insight")
    topic: str = ""
    summary: str = ""
    outcome: str = ""
    details: str = ""
    signal: str = ""
    strategy: str = ""
    causal_chain: str = ""
    files_changed: list = Field(default_factory=list)


class OptimizePromptRequest(BaseModel):
    """prompt 层 RSI 请求体。

    必须定义在模块级：FastAPI 用 typing.get_type_hints 按模块 globals 解析端点
    注解，函数闭包内的类解析不到 → 被当成 query 参数（422 missing query payload）。
    """

    skill: str = "propose"
    current_prompt: str = ""
    issues: list = Field(default_factory=list)
    cases: list = Field(default_factory=list)
    max_actions: int = 2


def _wire_model_config_ref(service, work_root: str, settings) -> Any:
    """把本服务的模型环境（provider/name/base_url/key）写成 model_config_ref YAML，
    供 openjiuwen 诊断 agent（TeamModelConfig）加载。含 ${VAR} 占位避免 key 落盘明文。"""
    import os

    from pathlib import Path as _P

    if not settings.model_configured:
        raise RuntimeError("model not configured (RSI_AGENT_MODEL_*)")
    cfg_dir = _P(work_root)
    cfg_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = cfg_dir / "rsi_model_config.yaml"
    cfg_path.write_text(
        "\n".join(
            [
                "model:",
                "  model_client_config:",
                "    client_provider: " + settings.model_provider,
                "    api_base: " + settings.model_base_url,
                "    api_key: ${RSI_AGENT_MODEL_API_KEY}",
                "    max_retries: 0",
                "  model_request_config:",
                "    model: " + settings.model_name,
                "    temperature: 0.2",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    # load_model_config_ref 的 _expand_env_vars 在进程内展开 ${VAR}：
    # 确保 key 以环境变量形式在场（settings 已从 env 读取，这里只需保证存在）
    os.environ.setdefault("RSI_AGENT_MODEL_API_KEY", settings.model_api_key)
    object.__setattr__(service, "_model_config_ref", str(cfg_path))
    return service


def create_app(settings: RsiAgentSettings | None = None) -> FastAPI:
    rsi_settings = settings or _BOOT_SETTINGS
    factory = RsiAgentFactory(rsi_settings, _SKILL_TEXTS)
    startup_error: str | None = None
    if not rsi_settings.model_configured:
        startup_error = "model_not_configured"

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        # 任务型服务不需要跨会话持久化：checkpointer 仅尽力初始化，失败不阻断任务
        # （openjiuwen 0.1.17.post1 的 checkpointer 模块无 CheckpointerConfig 导出）
        try:
            from openjiuwen.core.session.checkpointer import CheckpointerFactory

            import os
            cp_dir = os.path.dirname(rsi_settings.checkpointer_path)
            os.makedirs(cp_dir, exist_ok=True)
            await CheckpointerFactory.create(None)
            application.state.checkpointer_ready = True
            logger.info("RSI Agent service started: checkpointer ready")
        except Exception:
            application.state.checkpointer_ready = False
            logger.warning("Checkpointer unavailable, running without persistence")
        application.state.factory = factory
        yield

    app = FastAPI(
        title="RSI Evolution Agent",
        version="1.0.0",
        docs_url="/docs",
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.startup_error = startup_error
    app.state.factory = None
    app.state.checkpointer_ready = False

    # ── A 档：openjiuwen RSI 内脏接入（诊断 + 经验库 + prompt 层优化）──
    import os as _os

    from app.rsi_services import AnalyzeService, ExperienceService, PromptOptimizeService

    rsi_work_root = _os.getenv("RSI_AGENT_ANALYZE_WORK_DIR", "/app/checkpoints/analyze").strip()
    rsi_experience_dir = _os.getenv("RSI_AGENT_EXPERIENCE_DIR", "/app/checkpoints/experience").strip()
    analyze_service: AnalyzeService | None = None
    prompt_optimize_service: PromptOptimizeService | None = None
    experience_service = ExperienceService(rsi_experience_dir)
    rsi_compat_error: str | None = None
    try:
        analyze_service = AnalyzeService(
            model_config_ref="",  # 由下方动态生成（复用本服务模型环境变量）
            experience_dir=rsi_experience_dir,
            work_root=rsi_work_root,
        )
        analyze_service = _wire_model_config_ref(analyze_service, rsi_work_root, rsi_settings)
    except Exception as exc:
        rsi_compat_error = f"{type(exc).__name__}: {exc}"
        logger.warning("openjiuwen RSI services unavailable: %s", rsi_compat_error)
    try:
        # prompt 层优化与逐案诊断共用模型配置（_wire 后的 _model_config_ref）
        prompt_optimize_service = PromptOptimizeService(
            model_config_ref=str(getattr(analyze_service, "_model_config_ref", "")),
            work_root=_os.path.join(rsi_work_root, "..", "prompt-opt"),
        )
    except Exception as exc:
        logger.warning("PromptOptimizeService unavailable: %s", exc)
        prompt_optimize_service = None
    app.state.analyze_service = analyze_service
    app.state.prompt_optimize_service = prompt_optimize_service
    app.state.experience_service = experience_service
    app.state.rsi_compat_error = rsi_compat_error

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_request: Any, _exc: RequestValidationError):
        return JSONResponse(
            status_code=422,
            # 调试期：带上 pydantic 原始 errors（上线后可收回固定文案）
            content={"detail": {"code": "validation_error", "message": "请求格式不合法", "debug": _exc.errors()[:5]}},
        )

    @app.get("/health")
    async def health() -> dict:
        return rsi_settings.public_status(
            framework_available=app.state.factory is not None and app.state.startup_error is None,
            checkpointer_ready=app.state.checkpointer_ready,
        )

    @app.get("/v1/skills/{task_type}")
    async def skill_info(task_type: str) -> dict:
        if task_type not in SUPPORTED_TASKS:
            raise HTTPException(status_code=404, detail=f"unknown task: {task_type}")
        source, prompt = load_skill_prompt(rsi_settings.skills_dir, task_type, _SKILL_TEXTS)
        return {"task": task_type, "source": source, "promptChars": len(prompt)}

    @app.get("/v1/rsi/status")
    async def rsi_status() -> dict:
        from app import rsi_compat

        return {
            "rsiBase": rsi_compat.RSI_BASE,
            "analyzeReady": app.state.analyze_service is not None,
            "experienceReady": app.state.experience_service is not None,
            "promptOptimizeReady": app.state.prompt_optimize_service is not None,
            "error": app.state.rsi_compat_error,
        }

    @app.get("/v1/rsi/prompt-current")
    async def rsi_prompt_current(task: str = "propose") -> dict:
        """返回烧录的 skill 正文（Node 侧无覆盖时用它作为优化基线）。"""
        if task not in SUPPORTED_TASKS:
            raise HTTPException(status_code=404, detail=f"unknown task: {task}")
        source, prompt = load_skill_prompt(rsi_settings.skills_dir, task, _SKILL_TEXTS)
        return {"task": task, "source": source, "prompt": prompt}

    @app.post("/v1/rsi/optimize-prompt")
    async def rsi_optimize_prompt(payload: OptimizePromptRequest) -> dict:
        service = app.state.prompt_optimize_service
        if service is None:
            raise HTTPException(
                status_code=503,
                detail={"code": "prompt_optimize_unavailable", "message": "PromptOptimizeService 不可用（检查 openjiuwen MemberOptimizer / 模型配置）"},
            )
        return await service.optimize(payload.model_dump())

    @app.post("/v1/rsi/analyze")
    async def rsi_analyze(payload: AnalyzeRequest) -> dict:
        service: AnalyzeService | None = app.state.analyze_service
        if service is None:
            raise HTTPException(
                status_code=503,
                detail={"code": "rsi_unavailable", "message": app.state.rsi_compat_error or "analyze service unavailable"},
            )
        return await service.analyze({"summary": payload.summary, "cases": payload.cases})

    @app.post("/v1/rsi/experience/record")
    async def rsi_experience_record(payload: ExperienceRecordRequest) -> dict:
        service: ExperienceService = app.state.experience_service
        return await service.record(payload.model_dump())

    @app.get("/v1/rsi/experience/search")
    async def rsi_experience_search(q: str = "", top_k: int = 5) -> dict:
        service: ExperienceService = app.state.experience_service
        if not q.strip():
            raise HTTPException(status_code=422, detail={"code": "empty_query", "message": "q 不能为空"})
        return await service.search(q, top_k)

    @app.get("/v1/rsi/experience/recent")
    async def rsi_experience_recent(limit: int = 10) -> dict:
        service: ExperienceService = app.state.experience_service
        return await service.recent(limit)

    @app.post("/v1/tasks/{task_type}")
    async def run_task(task_type: str, payload: TaskRequest) -> dict:
        if task_type not in SUPPORTED_TASKS:
            raise HTTPException(status_code=404, detail={"code": "unknown_task", "message": f"未知任务 {task_type}"})
        if app.state.startup_error or app.state.factory is None:
            code = app.state.startup_error or "runtime_unavailable"
            raise HTTPException(status_code=503, detail={"code": code, "message": "服务尚未就绪"})

        factory: RsiAgentFactory = app.state.factory
        agent = factory.create(task_type, skill_override=payload.skill_override.strip() or None)
        client = factory.client_for(task_type)
        client.tool_calls.clear()
        # 任务级工具上下文（branch 路由等）随本次任务的所有工具回调透传
        client.tool_ctx = dict(payload.tool_ctx or {})

        session_id = f"rsi-{task_type}-{uuid.uuid4().hex[:12]}"
        user_message = payload.context or "请开始调研并完成任务（以 JSON 数组收尾）。"

        try:
            # session 尽力创建（checkpointer 不可用时退化为无会话调用）
            session = None
            try:
                from openjiuwen.core.single_agent import create_agent_session

                session = create_agent_session(session_id=session_id, card=agent.card)
                await session.pre_run()
            except Exception as exc:
                logger.warning("session unavailable, invoking without session: %s", exc)

            result = await agent.invoke({"query": user_message}, session=session) if session else await agent.invoke({"query": user_message})

            if session:
                try:
                    await session.post_run()
                except Exception:
                    pass

            if hasattr(result, "content"):
                reply = str(result.content)
            elif isinstance(result, dict):
                reply = result.get("content", str(result))
            else:
                reply = str(result)

            # 迭代耗尽防护（2026-10-14 断案）：调研 20 次工具调用把旧上限
            # max_iterations=20 吃光，reply 变成 {'output': 'Max iterations
            # reached without completion', 'result_type': 'error'}，但 invoke
            # 不抛异常 → status=ok → Node 侧把错误串当提案文本解析。显式识别。
            if "Max iterations reached" in reply or "result_type': 'error'" in reply:
                logger.error("Agent hit iteration ceiling (%s): %.200s", task_type, reply)
                return {
                    "sessionId": session_id,
                    "task": task_type,
                    "reply": reply,
                    "errorKind": "max_iterations",
                    "toolCalls": client.tool_calls,
                    "status": "error",
                }

            return {
                "sessionId": session_id,
                "task": task_type,
                "reply": reply,
                "toolCalls": client.tool_calls,
                "status": "ok",
            }
        except Exception as exc:
            logger.error("Agent task failed (%s): %s", task_type, exc, exc_info=True)
            # 失败分类（2026-10-14 断案）：模型网关 502 时 openjiuwen 框架把
            # FrameworkError 吞在 Task 层、invoke 正常返回错误文本，上层只能靠
            # 字符串猜。这里显式标记 errorKind，Node 侧可据此重试/告警。
            msg = str(exc)
            kind = "model_upstream" if ("model call failed" in msg or "502" in msg or "model_gateway" in msg) else "agent_error"
            return {
                "sessionId": session_id,
                "task": task_type,
                "reply": f"Agent 执行出错：{exc}",
                "errorKind": kind,
                "toolCalls": client.tool_calls,
                "status": "error",
            }

    return app


app = create_app()
