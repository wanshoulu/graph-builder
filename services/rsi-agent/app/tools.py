"""RSI 进化 Agent 工具集——HTTP 回调 Node 侧（ai-harbor）RSI 实验台的 agent API。

范式与 intent-trial-agent 一致：@tool 装饰器 + API 客户端类。
Node 侧的 /api/intent-rsi/agent/* 端点负责真正的数据访问（图谱/坏例/试问），
本服务不持有 RSI 状态（无 document 透传——状态在 Node 的 rsi-state.json）。
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx
from openjiuwen.core.foundation.tool import Tool, tool

logger = logging.getLogger("rsi_agent.tools")


class RsiApiClient:
    """封装对 Node 侧 RSI 实验台 agent API 的调用。"""

    def __init__(self, base_url: str, timeout: float = 60.0, tool_ctx: dict[str, Any] | None = None):
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None
        self.tool_calls: list[dict[str, Any]] = []
        # 任务上下文（如 branch=<分支id>）：随每个工具回调透传给 Node 侧，用于
        # 多分支进化时把工具路由到对应分支图谱——替代旧的"临时改写持久化 state"方案
        #（10-14 事故：分支版本残留进 state，靠 loadState 自愈兜底；ctx 直传后不再需要换体）
        self.tool_ctx: dict[str, Any] = dict(tool_ctx or {})

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=self._timeout)
        return self._client

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict:
        client = await self._ensure_client()
        merged = dict(self.tool_ctx)
        if params:
            merged.update(params)
        resp = await client.get(f"{self._base_url}{path}", params=merged)
        resp.raise_for_status()
        body = resp.json()
        if isinstance(body, dict) and "capabilities" in body:
            return {"families": body.get("data", []), "capabilities": body["capabilities"], "controls": body.get("controls", [])}
        return body.get("data", body) if isinstance(body, dict) else body

    async def weaknesses(self) -> dict:
        return await self._get("/weaknesses")

    async def badcases(self, family: str, limit: int = 6) -> dict:
        return await self._get("/badcases", {"family": family, "limit": limit})

    async def search_intents(self, keyword: str) -> dict:
        return await self._get("/search", {"keyword": keyword})

    async def inspect_intent(self, intent_id: str) -> dict:
        return await self._get("/intent", {"id": intent_id})

    async def probe(
        self,
        query: str,
        target: str = "",
        utterances: list[str] | None = None,
        op: str = "",
        hints: list[str] | None = None,
        scope_out: list[str] | None = None,
        clauses: list[str] | None = None,
        description: str = "",
        clarify: str = "",
        targets: list[str] | None = None,
        case_id: str = "",
    ) -> dict:
        params: dict[str, Any] = {"q": query}
        if target:
            params["target"] = target
        if utterances:
            params["utt"] = "||".join(str(u) for u in utterances)
        if op:
            params["op"] = op
        if hints:
            params["hints"] = "||".join(str(h) for h in hints)
        if scope_out:
            params["scopeOut"] = "||".join(str(s) for s in scope_out)
        if clauses:
            params["clauses"] = "||".join(str(c) for c in clauses)
        if description:
            params["desc"] = description
        if clarify:
            params["clarify"] = clarify
        if targets:
            params["targets"] = "||".join(targets)
        if case_id:
            params["caseId"] = case_id
        return await self._get("/probe", params)

    async def close(self):
        self.tool_calls.clear()
        if self._client and not self._client.is_closed:
            await self._client.aclose()


def _clip(obj: Any, limit: int = 6000) -> str:
    """工具结果统一转字符串并截断（保护上下文窗口）。"""
    s = json.dumps(obj, ensure_ascii=False, default=str)
    return s if len(s) <= limit else s[:limit] + "…(截断)"


def create_rsi_tools(api_client: RsiApiClient) -> list[Tool]:
    """创建 RSI 进化 Agent 的调研工具集（归因/提案任务共用）。"""

    @tool(
        name="list_weaknesses",
        description="查看当前评测坏例归因族概览（族名/数量/建议算子/说明）与分形态成绩。调研第一步。",
    )
    async def list_weaknesses() -> str:
        try:
            api_client.tool_calls.append({"name": "list_weaknesses", "args": {}})
            return _clip(await api_client.weaknesses())
        except Exception as exc:
            logger.warning("list_weaknesses failed: %s", exc)
            return f"查询失败：{exc}"

    @tool(
        name="list_badcases",
        description="翻看某个错误族的实际训练证据：完整query、期望、预测、各路召回、裁决轨迹、澄清选项及observations；据此提出可证伪的根因假设。",
    )
    async def list_badcases(family: str, limit: int = 6) -> str:
        try:
            api_client.tool_calls.append({"name": "list_badcases", "args": {"family": family, "limit": limit}})
            return _clip(await api_client.badcases(family, limit))
        except Exception as exc:
            logger.warning("list_badcases failed: %s", exc)
            return f"查询失败：{exc}"

    @tool(
        name="search_intents",
        description="按关键词检索图谱中的意图（id/名称/描述摘要），定位意图或竞争关系。",
    )
    async def search_intents(keyword: str) -> str:
        try:
            api_client.tool_calls.append({"name": "search_intents", "args": {"keyword": keyword}})
            return _clip(await api_client.search_intents(keyword))
        except Exception as exc:
            logger.warning("search_intents failed: %s", exc)
            return f"检索失败：{exc}"

    @tool(
        name="inspect_intent",
        description="查看一个意图的完整声明（描述/召回说法/边界 scope_out/混淆意图/消歧提示/澄清问题）。",
    )
    async def inspect_intent(intent_id: str) -> str:
        try:
            api_client.tool_calls.append({"name": "inspect_intent", "args": {"intent_id": intent_id}})
            return _clip(await api_client.inspect_intent(intent_id))
        except Exception as exc:
            logger.warning("inspect_intent failed: %s", exc)
            return f"查询失败：{exc}"

    @tool(
        name="probe_query",
        description=(
            "使用训练题完整原话query做反事实验证，保留真实单意图/歧义/复合任务金标；可传case_id消除同名题歧义。"
            "传target和算子参数时同时返回当前图谱与草案的strict、relaxed、resultType、clarifying、candidates及召回观察。"
            "按你打算提交的提案算子传参：A1 用 utterances；A2 用 hints/scope_out；A3 用 clauses；"
            "A4用description；A5只改文案用clarify；A6_ambiguity_cluster_expand用targets意图ID数组及utterances共同模糊表达。"
            "op默认在传utterances时为A1。improved依据实际训练题质量，不把排名上涨当成修题。"
            "多意图也须使用完整原话；每次检验一个机制，同时试问相关正确训练题作对照。"
        ),
    )
    async def probe_query(
        query: str,
        target: str = "",
        utterances: list[str] | None = None,
        op: str = "",
        hints: list[str] | None = None,
        scope_out: list[str] | None = None,
        clauses: list[str] | None = None,
        description: str = "",
        clarify: str = "",
        targets: list[str] | None = None,
        case_id: str = "",
    ) -> str:
        try:
            api_client.tool_calls.append({"name": "probe_query", "args": {"query": query, "case_id": case_id, "target": target, "targets": targets or [], "op": op or ("A1" if utterances else ""), "utterances": utterances or [], "hints": hints or [], "scope_out": scope_out or [], "clauses": clauses or []}})
            return _clip(await api_client.probe(query, target=target, utterances=utterances, op=op, hints=hints, scope_out=scope_out, clauses=clauses, description=description, clarify=clarify, targets=targets, case_id=case_id))
        except Exception as exc:
            logger.warning("probe_query failed: %s", exc)
            return f"试问失败：{exc}"

    return [list_weaknesses, list_badcases, search_intents, inspect_intent, probe_query]
