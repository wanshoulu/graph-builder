"""使用 openjiuwen 框架创建 RSI 进化 DeepAgent（归因/提案两个 skill 场景）。"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from openjiuwen.core.foundation.llm import Model, ModelClientConfig, ModelRequestConfig
from openjiuwen.core.single_agent import AgentCard
from openjiuwen.harness import Workspace, create_deep_agent

from app.config import AGENT_ID, RsiAgentSettings
from app.tools import RsiApiClient, create_rsi_tools

logger = logging.getLogger("rsi_agent.factory")

_FALLBACK_PROMPTS = {
    "attribute": (
        "你是意图评测坏例归因专家。用工具调研（list_badcases/inspect_intent/probe_query）后，"
        "在最终回答输出 JSON 数组：[{family,rootCause,rootCauseDetail,evidenceCases,suggestedOps,priority}]，"
        "rootCause 取 expression_gap/boundary_overlap/clarify_missing/label_suspect/mechanism_limit 之一。"
    ),
    "propose": (
        "你是意图图谱整改提案专家。用工具调研后，在最终回答输出提案 JSON 数组"
        "（A1_utterance_expand/A2_disambiguation/A3_clause_expansion/A4_description_rewrite/A5_clarify/A6_ambiguity_cluster_expand）。"
    ),
}


def load_skill_prompt(skills_dir: str, task_type: str, preloaded: dict[str, str] | None = None) -> tuple[str, str]:
    """加载任务 skill 正文。优先取启动时预读缓存（openjiuwen.harness 会拦截 .md 读取，
    运行期直接读文件不可靠——见 config.preload_skill_texts）。"""
    if preloaded and task_type in preloaded:
        return "skill-file(preloaded)", preloaded[task_type]
    # 扩展名 .prompt：避开 harness 的 parser 接管（同 config.preload_skill_texts 注释）
    path = Path(skills_dir) / task_type / "SKILL.prompt"
    try:
        md = path.read_text(encoding="utf-8")
        md = re.sub(r"^---\n[\s\S]*?\n---\n", "", md).strip()
        return "skill-file", md
    except OSError:
        logger.warning("skill file missing/unreadable, using builtin fallback: %s", path)
        return "builtin-fallback", _FALLBACK_PROMPTS.get(task_type, "")


class RsiAgentFactory:
    """创建 RSI 进化 DeepAgent 实例（按任务类型装配 skill prompt）。"""

    def __init__(self, settings: RsiAgentSettings, skill_texts: dict[str, str] | None = None):
        self._settings = settings
        self._skill_texts = skill_texts or {}
        self._agents: dict[str, Any] = {}
        self._clients: dict[str, RsiApiClient] = {}

    def client_for(self, task_type: str) -> RsiApiClient:
        if task_type not in self._clients:
            client = RsiApiClient(base_url=self._settings.rsi_api_base_url, timeout=90.0)
            self._clients[task_type] = client
        return self._clients[task_type]

    def create(self, task_type: str, skill_override: str | None = None) -> Any:
        # prompt 层 RSI 覆盖：一次性 agent（不进缓存），不复用烧录默认 prompt
        if skill_override:
            source, skill_prompt = "skill-override(rsi-state)", skill_override
        else:
            if task_type in self._agents:
                return self._agents[task_type]
            source, skill_prompt = load_skill_prompt(self._settings.skills_dir, task_type, self._skill_texts)

        model = Model(
            model_client_config=ModelClientConfig(
                client_provider=self._settings.model_provider,
                api_key=self._settings.model_api_key,
                api_base=self._settings.model_base_url,
                max_retries=0,
            ),
            model_config=ModelRequestConfig(
                model=self._settings.model_name,
                temperature=0.2,
                max_tokens=4096,
            ),
        )

        card = AgentCard(
            id=AGENT_ID,
            name=f"rsi-agent-{task_type}",
            description=f"意图图谱 RSI 进化 · {task_type} 任务（skill: {source}）",
        )

        tools = create_rsi_tools(self.client_for(task_type))

        workspace = Workspace(root_path=f"/tmp/rsi-agent-{task_type}", language="cn")

        agent = create_deep_agent(
            model=model,
            card=card,
            workspace=workspace,
            system_prompt=skill_prompt,
            tools=tools,
            enable_task_loop=True,
            enable_task_planning=False,
            max_iterations=self._settings.max_iterations,
            language="cn",
            parallel_tool_calls=False,
            restrict_to_work_dir=True,
            enable_security_rail=False,
            enable_model_anomaly_detection_rail=False,
        )
        if not skill_override:
            self._agents[task_type] = agent
        logger.info("RSI DeepAgent created: task=%s skill=%s", task_type, source)
        return agent

    async def close(self):
        for client in self._clients.values():
            await client.close()
        self._clients.clear()
