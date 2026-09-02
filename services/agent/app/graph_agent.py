"""LangGraph variant of the dynamic tool-calling agent.

This is a deliberate second implementation of the same capability as
:mod:`dynamic_agent`, built on a LangGraph ``StateGraph`` (agent node + tool
node + conditional edge that loops until the model stops calling tools). It
exists so the project can compare a hand-rolled loop against an industry-standard
orchestration framework on the *same* tools, guardrails and evaluation set.

LangGraph is an optional dependency: if it is not installed the service still
boots and this path degrades to the deterministic local fallback.
"""

from __future__ import annotations

import json
import time
from typing import Annotated, Any, TypedDict

from .agent import _configured_provider, _fallback, _sanitize_error, model_circuit_breaker
from .config import env_float, env_int
from .metrics import record_request
from .observability import get_request_id
from .policy import SAFE_BLOCK_MESSAGE, detect_policy_violation
from .reliability import CircuitOpenError
from .schemas import AgentRunRequest, AiResult
from .tools import TOOLS, run_single_tool, run_tool_plan

try:
    from langchain_core.messages import HumanMessage, SystemMessage
    from langchain_core.tools import StructuredTool
    from langgraph.graph import START, StateGraph
    from langgraph.graph.message import add_messages
    from langgraph.prebuilt import ToolNode, tools_condition

    LANGGRAPH_AVAILABLE = True
except ImportError:  # pragma: no cover - LangGraph is an optional extra.
    LANGGRAPH_AVAILABLE = False


class _State(TypedDict):
    messages: Annotated[list, add_messages]


def _derive_base_url(api_url: str) -> str:
    """LangChain's ChatOpenAI expects a base URL, not the full completions path."""
    for suffix in ("/chat/completions", "/completions"):
        if api_url.endswith(suffix):
            return api_url[: -len(suffix)]
    return api_url


def _build_context_tools(context: dict[str, Any]) -> list[Any]:
    """Wrap read-only tools as LangChain tools bound to this request's context."""
    tools: list[Any] = []
    for tool in TOOLS.values():

        def make_runner(name: str) -> Any:
            def _run(focus: str = "") -> str:
                return json.dumps(run_single_tool(name, context), ensure_ascii=False)

            return _run

        tools.append(
            StructuredTool.from_function(
                func=make_runner(tool.name),
                name=tool.name,
                description=tool.description,
            )
        )
    return tools


def _build_graph(model: Any, tools: list[Any]) -> Any:
    def agent_node(state: _State) -> dict[str, Any]:
        return {"messages": [model.invoke(state["messages"])]}

    graph = StateGraph(_State)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", ToolNode(tools))
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", tools_condition)
    graph.add_edge("tools", "agent")
    return graph.compile()


def _tools_used(messages: list[Any]) -> list[str]:
    used: list[str] = []
    for message in messages:
        for call in getattr(message, "tool_calls", None) or []:
            name = call.get("name") if isinstance(call, dict) else None
            if name:
                used.append(name)
    return used


def _final_text(messages: list[Any]) -> str:
    for message in reversed(messages):
        if getattr(message, "type", None) != "ai" or getattr(message, "tool_calls", None):
            continue
        content = getattr(message, "content", "")
        if isinstance(content, list):  # some providers return content parts
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        if isinstance(content, str) and content.strip():
            return content.strip()
    return ""


def _collect_results(tools_used: list[str], context: dict[str, Any]) -> dict[str, Any]:
    return {name: run_single_tool(name, context) for name in dict.fromkeys(tools_used)}


def _build_model(tools: list[Any], api_key: str, api_url: str, model_name: str) -> Any:
    from langchain_openai import ChatOpenAI
    from pydantic import SecretStr

    llm = ChatOpenAI(
        model=model_name,
        api_key=SecretStr(api_key),
        base_url=_derive_base_url(api_url),
        temperature=0.3,
        timeout=env_float("AGENT_MODEL_TIMEOUT_SECONDS", 8.0, minimum=0.1),
        max_retries=env_int("AGENT_MODEL_MAX_RETRIES", 2, minimum=0),
    )
    return llm.bind_tools(tools)


async def _run_graph(request: AgentRunRequest, model_override: Any = None) -> AiResult:
    plan_results, plan_tools = run_tool_plan(request.task, request.context)

    violation = detect_policy_violation(request.policy_text or request.user_prompt)
    if violation:
        blocked = _fallback(request, f"检测到受限请求（{violation}），{SAFE_BLOCK_MESSAGE}", plan_tools, plan_results)
        update = {"content": SAFE_BLOCK_MESSAGE}
        return blocked.model_copy(update=update) if hasattr(blocked, "model_copy") else blocked.copy(update=update)

    if not LANGGRAPH_AVAILABLE:
        return _fallback(request, "未安装 LangGraph 依赖，已使用本地兜底策略", plan_tools, plan_results)

    api_key, api_url, model_name, provider_name = _configured_provider()
    if model_override is None and not api_key:
        return _fallback(request, "未配置模型 API Key，LangGraph Agent 已使用本地兜底策略", plan_tools, plan_results)

    try:
        model_circuit_breaker.before_call()
    except CircuitOpenError as exc:
        return _fallback(request, str(exc), plan_tools, plan_results)

    tools = _build_context_tools(request.context)
    model = model_override if model_override is not None else _build_model(tools, api_key, api_url, model_name)
    graph = _build_graph(model, tools)
    recursion_limit = env_int("AGENT_MAX_TOOL_STEPS", 4, minimum=1) * 2 + 1
    initial = {"messages": [SystemMessage(content=request.system_prompt), HumanMessage(content=request.user_prompt)]}

    try:
        final_state = await graph.ainvoke(initial, config={"recursion_limit": recursion_limit})
    except Exception as exc:
        model_circuit_breaker.record_failure()
        return _fallback(
            request,
            f"LangGraph 执行失败（{_sanitize_error(str(exc))}），已使用本地兜底策略",
            plan_tools,
            plan_results,
        )

    out_messages = list(final_state.get("messages", []))
    tools_used = _tools_used(out_messages)
    content = _final_text(out_messages)
    if not content:
        model_circuit_breaker.record_failure()
        return _fallback(request, "LangGraph 返回内容为空，已使用本地兜底策略", tools_used or plan_tools, plan_results)

    model_circuit_breaker.record_success()
    return AiResult(
        title=request.title,
        content=content,
        generatedAt=int(time.time() * 1000),
        source="model",
        fallback=False,
        message=f"LangGraph Agent / {provider_name} 生成成功（{len(tools_used)} 次工具调用）",
        toolsUsed=tools_used,
        toolResults=_collect_results(tools_used, request.context),
    )


async def run_graph_agent(request: AgentRunRequest, model_override: Any = None) -> AiResult:
    """Run the LangGraph loop and record latency/source metrics."""
    started = time.perf_counter()
    task = f"{request.task}:graph"
    try:
        result = await _run_graph(request, model_override=model_override)
    except Exception:
        record_request(
            task=task,
            source="error",
            fallback=True,
            latency_ms=(time.perf_counter() - started) * 1000,
            failed=True,
            request_id=get_request_id(),
        )
        raise
    record_request(
        task=task,
        source=result.source,
        fallback=result.fallback,
        latency_ms=(time.perf_counter() - started) * 1000,
        tools_used=result.toolsUsed,
        request_id=get_request_id(),
    )
    return result
