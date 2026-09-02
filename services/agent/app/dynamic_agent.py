"""Native dynamic tool-calling agent (OpenAI-compatible ``tool_calls`` loop).

Unlike the deterministic path in :mod:`agent`, here the model decides which
tools to call and when to stop. This is a hand-rolled ReAct-style loop with no
framework dependency, so the mechanics (planning, tool execution, stopping) are
explicit. It keeps every production guardrail of the deterministic path:

* read-only tools that consume server-authoritative context (the model cannot
  smuggle arguments that fetch or mutate anything else),
* policy screening before any model call,
* circuit breaker, bounded retries with exponential backoff,
* deterministic local fallback whenever the model is unavailable,
* a hard cap on reasoning steps so the loop always terminates.
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx

from .agent import (
    _configured_provider,
    _extract_content,
    _fallback,
    _is_retryable_status,
    _response_error,
    _retry_sleep,
    _sanitize_error,
    model_circuit_breaker,
)
from .config import env_float, env_int
from .metrics import record_request
from .observability import get_request_id
from .policy import SAFE_BLOCK_MESSAGE, detect_policy_violation
from .reliability import CircuitOpenError
from .schemas import AgentRunRequest, AiResult
from .tools import openai_tool_schemas, run_single_tool, run_tool_plan


class _ModelCallError(Exception):
    """Internal error carrying whether the failure is worth retrying."""

    def __init__(self, message: str, *, retryable: bool):
        super().__init__(message)
        self.retryable = retryable


async def _post_once(client: Any, url: str, api_key: str, body: dict[str, Any]) -> dict[str, Any]:
    try:
        response = await client.post(
            url,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            json=body,
        )
    except httpx.HTTPError as exc:
        raise _ModelCallError(f"模型调用失败（{_sanitize_error(str(exc))}）", retryable=True) from exc

    if response.status_code >= 400:
        reason = _sanitize_error(str(_response_error(response)))
        raise _ModelCallError(reason, retryable=_is_retryable_status(response.status_code))

    try:
        payload = response.json()
    except (ValueError, TypeError) as exc:
        raise _ModelCallError(f"模型返回格式异常（{_sanitize_error(str(exc))}）", retryable=False) from exc
    if not isinstance(payload, dict):
        raise _ModelCallError("模型返回格式异常", retryable=False)
    return payload


async def _call_model(client: Any, url: str, api_key: str, body: dict[str, Any]) -> dict[str, Any]:
    max_retries = env_int("AGENT_MODEL_MAX_RETRIES", 2, minimum=0)
    backoff_base = env_float("AGENT_MODEL_RETRY_BACKOFF_SECONDS", 0.25, minimum=0.0)
    backoff_max = env_float("AGENT_MODEL_RETRY_BACKOFF_MAX_SECONDS", 2.0, minimum=0.0)
    last_error: _ModelCallError | None = None
    for attempt in range(max_retries + 1):
        try:
            return await _post_once(client, url, api_key, body)
        except _ModelCallError as exc:
            last_error = exc
            if exc.retryable and attempt < max_retries:
                await _retry_sleep(attempt, backoff_base, backoff_max)
                continue
            raise
    assert last_error is not None  # loop always sets it before raising
    raise last_error


def _message_body(model: str, api_url: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "tools": openai_tool_schemas(),
        "tool_choice": "auto",
        "temperature": 0.3,
        "max_tokens": 400,
    }
    if "deepseek" in api_url or model.startswith("deepseek-"):
        body["thinking"] = {"type": "disabled"}
    return body


def _parse_tool_calls(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    choices = payload.get("choices") or []
    message = choices[0].get("message") if choices else {}
    message = message if isinstance(message, dict) else {}
    tool_calls = message.get("tool_calls")
    tool_calls = tool_calls if isinstance(tool_calls, list) else []
    return message, tool_calls


async def _run_dynamic(request: AgentRunRequest) -> AiResult:
    plan_results, plan_tools = run_tool_plan(request.task, request.context)

    violation = detect_policy_violation(request.policy_text or request.user_prompt)
    if violation:
        blocked = _fallback(request, f"检测到受限请求（{violation}），{SAFE_BLOCK_MESSAGE}", plan_tools, plan_results)
        update = {"content": SAFE_BLOCK_MESSAGE}
        return blocked.model_copy(update=update) if hasattr(blocked, "model_copy") else blocked.copy(update=update)

    api_key, api_url, model, provider_name = _configured_provider()
    if not api_key:
        return _fallback(request, "未配置模型 API Key，动态 Agent 已使用本地兜底策略", plan_tools, plan_results)

    try:
        model_circuit_breaker.before_call()
    except CircuitOpenError as exc:
        return _fallback(request, str(exc), plan_tools, plan_results)

    max_steps = env_int("AGENT_MAX_TOOL_STEPS", 4, minimum=1)
    timeout_seconds = env_float("AGENT_MODEL_TIMEOUT_SECONDS", 8.0, minimum=0.1)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": request.system_prompt},
        {"role": "user", "content": request.user_prompt},
    ]
    tools_used: list[str] = []

    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            for _ in range(max_steps):
                payload = await _call_model(client, api_url, api_key, _message_body(model, api_url, messages))
                message, tool_calls = _parse_tool_calls(payload)

                if not tool_calls:
                    content = _extract_content(payload)
                    if not content:
                        model_circuit_breaker.record_failure()
                        return _fallback(request, "模型返回内容为空，已使用本地兜底策略", tools_used or plan_tools, plan_results)
                    model_circuit_breaker.record_success()
                    return AiResult(
                        title=request.title,
                        content=content,
                        generatedAt=int(time.time() * 1000),
                        source="model",
                        fallback=False,
                        message=f"动态 Agent / {provider_name} 生成成功（{len(tools_used)} 次工具调用）",
                        toolsUsed=tools_used,
                        toolResults=_collect_results(tools_used, request.context),
                    )

                messages.append(
                    {"role": "assistant", "content": message.get("content") or "", "tool_calls": tool_calls}
                )
                for call in tool_calls:
                    name, call_id = _tool_call_target(call)
                    result = run_single_tool(name, request.context) if name else {"ok": False, "error": "missing tool name"}
                    if name:
                        tools_used.append(name)
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call_id,
                            "name": name or "unknown",
                            "content": json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                        }
                    )
    except _ModelCallError as exc:
        if exc.retryable:
            model_circuit_breaker.record_failure()
        return _fallback(request, f"{exc}，已使用本地兜底策略", tools_used or plan_tools, plan_results)

    # Step budget exhausted without a final answer: degrade gracefully.
    return _fallback(request, "动态 Agent 超过工具调用步数上限，已使用本地兜底策略", tools_used or plan_tools, plan_results)


def _tool_call_target(call: Any) -> tuple[str, str]:
    if not isinstance(call, dict):
        return "", ""
    function = call.get("function")
    function = function if isinstance(function, dict) else {}
    name = function.get("name")
    call_id = call.get("id")
    return (name if isinstance(name, str) else ""), (call_id if isinstance(call_id, str) else "")


def _collect_results(tools_used: list[str], context: dict[str, Any]) -> dict[str, Any]:
    return {name: run_single_tool(name, context) for name in dict.fromkeys(tools_used)}


async def run_dynamic_agent(request: AgentRunRequest) -> AiResult:
    """Run the dynamic loop and record latency/source metrics, mirroring ``run_agent``."""
    started = time.perf_counter()
    task = f"{request.task}:dynamic"
    try:
        result = await _run_dynamic(request)
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
