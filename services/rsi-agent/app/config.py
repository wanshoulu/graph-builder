"""RSI 进化 Agent 服务配置（openjiuwen DeepAgent + skill + HTTP 工具回调）。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

OPENJIUWEN_VERSION = "0.1.19"
AGENT_ID = "rsi-agent"

SUPPORTED_TASKS = ("attribute", "propose")

def preload_skill_texts(skills_dir: str) -> dict[str, str]:
    """在 import openjiuwen 之前预读 skill 正文（剥 frontmatter）存内存。

    openjiuwen.harness 加载后会注册 TxtMdParser 等接管 .md 文件访问，
    workspace 之外的 .md 读取会被框架拦截（实测 read_text 抛 OSError）。
    本模块只依赖标准库，必须在任何 openjiuwen import 之前调用。
    """
    import re

    texts: dict[str, str] = {}
    for task in SUPPORTED_TASKS:
        # 扩展名必须是 .prompt：openjiuwen.harness 按扩展名注册 parser 接管文件访问
        # （.md/.txt/.json 均被接管，workspace 外读取被拦截），无 parser 的扩展名走原生 fs
        path = os.path.join(skills_dir, task, "SKILL.prompt")
        try:
            with open(path, encoding="utf-8") as f:
                md = f.read()
            texts[task] = re.sub(r"^---\n[\s\S]*?\n---\n", "", md).strip()
        except OSError:
            continue
    return texts


@dataclass(frozen=True)
class RsiAgentSettings:
    model_provider: str = ""
    model_name: str = ""
    model_base_url: str = field(default="", repr=False)
    model_api_key: str = field(default="", repr=False)
    checkpointer_path: str = field(default="/app/checkpoints/rsi-agent.db", repr=False)
    host: str = "0.0.0.0"
    port: int = 18132
    # 迭代预算（2026-10-14 二调：批次2-2 把 probe 反事实验证设为强制步骤后，
    # 调研+每提案多轮 probe 微调实测 20+ 次工具调用仍不交卷（ReAct 一轮吃 2 次迭代，
    # 40 上限=20 次工具调用在 ceiling 上还在 probe）。预算 = 调研量 + probe 微调 + 交卷余量）
    max_iterations: int = 56
    # Node 侧（graph-builder server.js）RSI 实验台的 agent 工具 API 基地址。
    # 本机演示默认 127.0.0.1:3013；容器部署用 RSI_AGENT_API_BASE_URL 覆盖为服务名+端口。
    rsi_api_base_url: str = "http://127.0.0.1:3013/api/intent-rsi/agent"
    skills_dir: str = "/app/skills"

    @classmethod
    def from_env(cls) -> "RsiAgentSettings":
        # 模型三件套按 key 来源推导（与 intent-trial-agent 同款兜底）
        qwen_key = os.getenv("QWEN_KEY", "").strip()
        deepseek_key = os.getenv("DEEPSEEK_KEY", "").strip()
        explicit_key = os.getenv("RSI_AGENT_MODEL_API_KEY", "").strip()
        deepseek_only = bool(deepseek_key) and not (qwen_key or explicit_key)
        model_name = os.getenv("RSI_AGENT_MODEL_NAME", "").strip()
        if not model_name:
            model_name = "deepseek-chat" if deepseek_only else "qwen-plus"
        model_base_url = os.getenv("RSI_AGENT_MODEL_BASE_URL", "").strip()
        if not model_base_url:
            model_base_url = (
                "https://api.deepseek.com/v1"
                if deepseek_only
                else "https://dashscope.aliyuncs.com/compatible-mode/v1"
            )
        return cls(
            model_provider=os.getenv("RSI_AGENT_MODEL_PROVIDER", "").strip() or "openai",
            model_name=model_name,
            model_base_url=model_base_url,
            model_api_key=explicit_key or qwen_key or deepseek_key,
            checkpointer_path=os.getenv("RSI_AGENT_CHECKPOINTER_PATH", "/app/checkpoints/rsi-agent.db").strip(),
            host=os.getenv("RSI_AGENT_HOST", "0.0.0.0").strip(),
            port=_bounded_int(os.getenv("RSI_AGENT_PORT"), 18132, 1, 65535),
            max_iterations=_bounded_int(os.getenv("RSI_AGENT_MAX_ITERATIONS"), 56, 4, 80),
            rsi_api_base_url=os.getenv(
                "RSI_AGENT_API_BASE_URL",
                "http://127.0.0.1:3013/api/intent-rsi/agent",
            ).strip(),
            skills_dir=os.getenv("RSI_AGENT_SKILLS_DIR", "/app/skills").strip(),
        )

    @property
    def model_configured(self) -> bool:
        return all((self.model_provider, self.model_name, self.model_base_url, self.model_api_key))

    def public_status(self, *, framework_available: bool, checkpointer_ready: bool) -> dict:
        return {
            "provider": "openjiuwen",
            "version": OPENJIUWEN_VERSION,
            "agentId": AGENT_ID,
            "ready": bool(framework_available and checkpointer_ready and self.model_configured),
            "modelConfigured": self.model_configured,
            "modelProvider": self.model_provider or None,
            "modelName": self.model_name or None,
            "tasks": list(SUPPORTED_TASKS),
        }


def _bounded_int(value: str | None, fallback: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value) if value is not None else fallback
    except ValueError:
        return fallback
    return parsed if minimum <= parsed <= maximum else fallback
