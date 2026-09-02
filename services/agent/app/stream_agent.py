"""Server-Sent Events (SSE) streaming variant of the dynamic tool-calling agent.

This streams the agent's work to the client as it happens instead of buffering a
single JSON response:

* ``token`` events carry incremental answer text as the model generates it,
* ``tool`` events announce each read-only tool the model decides to call,
* ``done`` carries the final :class:`AiResult` payload,

It reuses every guardrail of the non-streaming paths (policy screening, circuit
breaker, deterministic fallback, bounded tool steps). The OpenAI-compatible
streaming format fragments both answer tokens and ``tool_calls`` across chunks,
so this module reassembles them before executing tools.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .agent import (
    _configured_provider,
    _is_retryable_status,
    _sanitize_error,
    model_circuit_breaker,
)
from .config import env_float, env_int
from .dynamic_agent import (
    _collect_results,
    _message_body,
    _ModelCallError,
    _tool_call_target,
)
from .metrics import record_request
from .observability import get_request_id
from .policy import SAFE_BLOCK_MESSAGE, detect_policy_violation
from .reliability import CircuitOpenError
from .schemas import AgentRunRequest, AiResult
from .tools import run_single_tool, run_tool_plan

Event = tuple[str, Any]


def _stream_body(model: str, api_url: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
    body = _message_body(model, api_url, messages)
    body["stream"] = True
    return body


def _error_from_bytes(raw: bytes, status_code: int) -> str:
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
        if isinstance(payload, dict):
            error = payload.get("error")
            message = error.get("message") if isinstance(error, dict) else payload.get("message")
            if message:
                return str(message)
    except (ValueError, TypeError):
        pass
    return f"模型接口返回异常（HTTP {status_code}）"


async def _stream_model_turn(
    client: Any, url: str, api_key: str, body: dict[str, Any]
) -> AsyncIterator[Event]:
    """Yield ``("token", text)`` as content arrives, then one ``("assembled", {...})``."""
    content_parts: list[str] = []
    tool_slots: dict[int, dict[str, str]] = {}
    async with client.stream(
        "POST",
        url,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        json=body,
    ) as response:
        if response.status_code >= 400:
            raw = await response.aread()
            reason = _sanitize_error(_error_from_bytes(raw, response.status_code))
            raise _ModelCallError(reason, retryable=_is_retryable_status(response.status_code))

        async for line in response.aiter_lines():
            line = line.strip()
            if not line or not line.startswith("data:"):
                continue
            data = line[len("data:") :].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except ValueError:
                continue
            choices = chunk.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            piece = delta.get("content")
            if isinstance(piece, str) and piece:
                content_parts.append(piece)
                yield ("token", piece)
            for call in delta.get("tool_calls") or []:
                if not isinstance(call, dict):
                    continue
                index = call.get("index") or 0
                slot = tool_slots.setdefault(int(index), {"id": "", "name": "", "arguments": ""})
                if isinstance(call.get("id"), str) and call["id"]:
                    slot["id"] = call["id"]
                raw_function = call.get("function")
                function: dict[str, Any] = raw_function if isinstance(raw_function, dict) else {}
                name = function.get("name")
                if isinstance(name, str) and name:
                    slot["name"] = name
                arguments = function.get("arguments")
                if isinstance(arguments, str):
                    slot["arguments"] += arguments

    assembled_calls = [
        {
            "id": slot["id"] or f"call-{index}",
            "type": "function",
            "function": {"name": slot["name"], "arguments": slot["arguments"] or "{}"},
        }
        for index, slot in sorted(tool_slots.items())
    ]
    yield ("assembled", {"content": "".join(content_parts), "tool_calls": assembled_calls})


def _record(task: str, result: AiResult, started: float) -> None:
    record_request(
        task=task,
        source=result.source,
        fallback=result.fallback,
        latency_ms=(time.perf_counter() - started) * 1000,
        tools_used=result.toolsUsed,
        request_id=get_request_id(),
    )


def _result_payload(result: AiResult) -> dict[str, Any]:
    return result.model_dump() if hasattr(result, "model_dump") else result.dict()


async def _emit_terminal(result: AiResult, task: str, started: float) -> AsyncIterator[Event]:
    if result.content:
        yield ("token", result.content)
    yield ("done", _result_payload(result))
    _record(task, result, started)


async def _stream_events(request: AgentRunRequest) -> AsyncIterator[Event]:
    started = time.perf_counter()
    task = f"{request.task}:stream"
    plan_results, plan_tools = run_tool_plan(request.task, request.context)
    yield ("meta", {"task": task, "requestId": get_request_id()})

    violation = detect_policy_violation(request.policy_text or request.user_prompt)
    if violation:
        blocked = _fallback_blocked(request, violation, plan_tools, plan_results)
        async for event in _emit_terminal(blocked, task, started):
            yield event
        return

    api_key, api_url, model, provider_name = _configured_provider()
    if not api_key:
        result = _fallback(request, "未配置模型 API Key，流式 Agent 已使用本地兜底策略", plan_tools, plan_results)
        async for event in _emit_terminal(result, task, started):
            yield event
        return

    try:
        model_circuit_breaker.before_call()
    except CircuitOpenError as exc:
        result = _fallback(request, str(exc), plan_tools, plan_results)
        async for event in _emit_terminal(result, task, started):
            yield event
        return

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
                assembled: dict[str, Any] = {"content": "", "tool_calls": []}
                async for kind, data in _stream_model_turn(
                    client, api_url, api_key, _stream_body(model, api_url, messages)
                ):
                    if kind == "token":
                        yield ("token", data)
                    else:
                        assembled = data

                tool_calls = assembled.get("tool_calls") or []
                if not tool_calls:
                    content = str(assembled.get("content") or "").strip()
                    if not content:
                        model_circuit_breaker.record_failure()
                        result = _fallback(
                            request, "模型返回内容为空，已使用本地兜底策略", tools_used or plan_tools, plan_results
                        )
                        yield ("done", _result_payload(result))
                        _record(task, result, started)
                        return
                    model_circuit_breaker.record_success()
                    result = AiResult(
                        title=request.title,
                        content=content,
                        generatedAt=int(time.time() * 1000),
                        source="model",
                        fallback=False,
                        message=f"流式 Agent / {provider_name} 生成成功（{len(tools_used)} 次工具调用）",
                        toolsUsed=tools_used,
                        toolResults=_collect_results(tools_used, request.context),
                    )
                    yield ("done", _result_payload(result))
                    _record(task, result, started)
                    return

                messages.append(
                    {"role": "assistant", "content": assembled.get("content") or "", "tool_calls": tool_calls}
                )
                for call in tool_calls:
                    name, call_id = _tool_call_target(call)
                    tool_result = (
                        run_single_tool(name, request.context) if name else {"ok": False, "error": "missing tool name"}
                    )
                    if name:
                        tools_used.append(name)
                        yield ("tool", {"name": name})
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call_id,
                            "name": name or "unknown",
                            "content": json.dumps(tool_result, ensure_ascii=False, separators=(",", ":")),
                        }
                    )
    except _ModelCallError as exc:
        if exc.retryable:
            model_circuit_breaker.record_failure()
        result = _fallback(request, f"{exc}，已使用本地兜底策略", tools_used or plan_tools, plan_results)
        async for event in _emit_terminal(result, task, started):
            yield event
        return
    except httpx.HTTPError as exc:
        model_circuit_breaker.record_failure()
        result = _fallback(
            request, f"模型调用失败（{_sanitize_error(str(exc))}），已使用本地兜底策略", tools_used or plan_tools, plan_results
        )
        async for event in _emit_terminal(result, task, started):
            yield event
        return

    result = _fallback(request, "流式 Agent 超过工具调用步数上限，已使用本地兜底策略", tools_used or plan_tools, plan_results)
    yield ("done", _result_payload(result))
    _record(task, result, started)


def _fallback(
    request: AgentRunRequest,
    message: str,
    tools_used: list[str],
    tool_results: dict[str, Any],
) -> AiResult:
    from .agent import _fallback as _base_fallback

    return _base_fallback(request, message, tools_used, tool_results)


def _fallback_blocked(
    request: AgentRunRequest, violation: str, tools_used: list[str], tool_results: dict[str, Any]
) -> AiResult:
    blocked = _fallback(request, f"检测到受限请求（{violation}），{SAFE_BLOCK_MESSAGE}", tools_used, tool_results)
    update = {"content": SAFE_BLOCK_MESSAGE}
    return blocked.model_copy(update=update) if hasattr(blocked, "model_copy") else blocked.copy(update=update)


def _sse(event: str, data: Any) -> str:
    payload = data if isinstance(data, dict) else {"text": data}
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def run_stream_agent_sse(request: AgentRunRequest) -> AsyncIterator[str]:
    """Serialize the streaming agent's events into the SSE wire format."""
    async for event, data in _stream_events(request):
        yield _sse(event, data)
