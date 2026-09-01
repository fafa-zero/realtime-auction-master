import asyncio
import json
import os
import re
import time
from typing import Any

import httpx

from .config import env_float, env_int, load_local_env
from .metrics import record_request
from .observability import get_request_id
from .policy import SAFE_BLOCK_MESSAGE, detect_policy_violation
from .reliability import CircuitBreaker, CircuitOpenError
from .schemas import AgentRunRequest, AiResult
from .tools import run_tool_plan


load_local_env()


DEFAULT_MODEL_URL = "https://api.deepseek.com/chat/completions"
DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_USTC_URL = "https://api.llm.ustc.edu.cn/v1/chat/completions"
DEFAULT_USTC_MODEL = "deepseek-v4-flash-ascend"
model_circuit_breaker = CircuitBreaker(
    failure_threshold=env_int("AGENT_CIRCUIT_FAILURE_THRESHOLD", 3, minimum=1),
    recovery_seconds=env_float("AGENT_CIRCUIT_RECOVERY_SECONDS", 30.0, minimum=0.1),
)


def _configured_provider() -> tuple[str, str, str, str]:
    """Resolve provider settings without exposing API keys to callers."""
    if os.getenv("AI_API_KEY"):
        return (
            os.environ["AI_API_KEY"],
            os.getenv("AI_API_URL", DEFAULT_MODEL_URL),
            os.getenv("AI_MODEL", DEFAULT_MODEL),
            "模型",
        )
    if os.getenv("USTC_LLM_API_KEY"):
        return (
            os.environ["USTC_LLM_API_KEY"],
            os.getenv("USTC_LLM_API_URL", DEFAULT_USTC_URL),
            os.getenv("USTC_LLM_MODEL", DEFAULT_USTC_MODEL),
            "USTC LLM",
        )
    if os.getenv("DEEPSEEK_API_KEY"):
        return (
            os.environ["DEEPSEEK_API_KEY"],
            os.getenv("DEEPSEEK_API_URL", DEFAULT_MODEL_URL),
            os.getenv("DEEPSEEK_MODEL", DEFAULT_MODEL),
            "DeepSeek",
        )
    return "", "", "", "模型"


def _fallback(
    request: AgentRunRequest,
    message: str,
    tools_used: list[str] | None = None,
    tool_results: dict[str, Any] | None = None,
) -> AiResult:
    return AiResult(
        title=request.title,
        content=request.fallback_content,
        generatedAt=int(time.time() * 1000),
        source="fallback",
        fallback=True,
        message=message,
        toolsUsed=tools_used or [],
        toolResults=tool_results or {},
    )


def _sanitize_error(message: str) -> str:
    return re.sub(r"sk-[A-Za-z0-9_-]+", "sk-***", message)


def _extract_content(data: dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if choices:
        message = choices[0].get("message") or {}
        content = message.get("content") or message.get("reasoning_content")
        if isinstance(content, str) and content.strip():
            return content.strip()
    output_text = data.get("output_text")
    return output_text.strip() if isinstance(output_text, str) else ""


async def _run_agent(request: AgentRunRequest) -> AiResult:
    """Run one bounded agent task with a deterministic local fallback."""
    tool_results, tools_used = run_tool_plan(request.task, request.context)
    violation = detect_policy_violation(f"{request.system_prompt}\n{request.user_prompt}")
    if violation:
        blocked = _fallback(request, f"检测到受限请求（{violation}），{SAFE_BLOCK_MESSAGE}", tools_used, tool_results)
        if hasattr(blocked, "model_copy"):
            return blocked.model_copy(update={"content": SAFE_BLOCK_MESSAGE})
        return blocked.copy(update={"content": SAFE_BLOCK_MESSAGE})
    tool_context = json.dumps(tool_results, ensure_ascii=False, separators=(",", ":"))
    enriched_user_prompt = (
        f"{request.user_prompt}\n\n以下是 Agent 工具读取到的结构化上下文，请以此为准：\n{tool_context}"
    )
    api_key, api_url, model, provider_name = _configured_provider()
    if not api_key:
        return _fallback(
            request,
            "未配置模型 API Key，FastAPI Agent 已使用本地兜底策略",
            tools_used,
            tool_results,
        )

    try:
        model_circuit_breaker.before_call()
    except CircuitOpenError as exc:
        return _fallback(request, str(exc), tools_used, tool_results)

    timeout_seconds = env_float("AGENT_MODEL_TIMEOUT_SECONDS", 8.0, minimum=0.1)
    max_retries = env_int("AGENT_MODEL_MAX_RETRIES", 2, minimum=0)
    backoff_base = env_float("AGENT_MODEL_RETRY_BACKOFF_SECONDS", 0.25, minimum=0.0)
    backoff_max = env_float("AGENT_MODEL_RETRY_BACKOFF_MAX_SECONDS", 2.0, minimum=0.0)
    body: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": request.system_prompt},
            {"role": "user", "content": enriched_user_prompt},
        ],
        "temperature": 0.4,
        "max_tokens": 300,
    }
    if "deepseek" in api_url or model.startswith("deepseek-"):
        body["thinking"] = {"type": "disabled"}

    last_error = "模型调用失败"
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            for attempt in range(max_retries + 1):
                try:
                    response = await client.post(
                        api_url,
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {api_key}",
                        },
                        json=body,
                    )
                except httpx.HTTPError as exc:
                    last_error = f"模型调用失败（{_sanitize_error(str(exc))}）"
                    if attempt < max_retries:
                        await _retry_sleep(attempt, backoff_base, backoff_max)
                        continue
                    model_circuit_breaker.record_failure()
                    return _fallback(request, f"{last_error}，已使用本地兜底策略", tools_used, tool_results)

                if response.status_code >= 400:
                    reason = _response_error(response)
                    last_error = _sanitize_error(str(reason))
                    if _is_retryable_status(response.status_code) and attempt < max_retries:
                        await _retry_sleep(attempt, backoff_base, backoff_max)
                        continue
                    if _is_retryable_status(response.status_code):
                        model_circuit_breaker.record_failure()
                    return _fallback(
                        request,
                        f"{last_error}，已使用本地兜底策略",
                        tools_used,
                        tool_results,
                    )

                try:
                    payload = response.json()
                except (ValueError, TypeError) as exc:
                    model_circuit_breaker.record_failure()
                    return _fallback(
                        request,
                        f"模型返回格式异常（{_sanitize_error(str(exc))}），已使用本地兜底策略",
                        tools_used,
                        tool_results,
                    )
                if not isinstance(payload, dict):
                    model_circuit_breaker.record_failure()
                    return _fallback(request, "模型返回格式异常，已使用本地兜底策略", tools_used, tool_results)
                content = _extract_content(payload)
                if not content:
                    model_circuit_breaker.record_failure()
                    return _fallback(request, "模型返回内容为空，已使用本地兜底策略", tools_used, tool_results)
                model_circuit_breaker.record_success()
                return AiResult(
                    title=request.title,
                    content=content,
                    generatedAt=int(time.time() * 1000),
                    source="model",
                    fallback=False,
                    message=f"FastAPI Agent / {provider_name} 生成成功",
                    toolsUsed=tools_used,
                    toolResults=tool_results,
                )
    except (httpx.HTTPError, ValueError, TypeError, AttributeError) as exc:
        model_circuit_breaker.record_failure()
        return _fallback(
            request,
            f"{last_error}（{_sanitize_error(str(exc))}），已使用本地兜底策略",
            tools_used,
            tool_results,
        )
    return _fallback(request, f"{last_error}，已使用本地兜底策略", tools_used, tool_results)


async def _retry_sleep(attempt: int, base: float, maximum: float) -> None:
    delay = min(maximum, base * (2**attempt)) if maximum else 0.0
    if delay > 0:
        await asyncio.sleep(delay)


def _is_retryable_status(status_code: int) -> bool:
    return status_code in {408, 425, 429} or status_code >= 500


def _response_error(response: httpx.Response) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            error = payload.get("error", {})
            error_message = error.get("message") if isinstance(error, dict) else None
            return str(error_message or payload.get("message") or f"模型接口返回异常（HTTP {response.status_code}）")
    except (ValueError, TypeError):
        pass
    return f"模型接口返回异常（HTTP {response.status_code}）"


async def run_agent(request: AgentRunRequest) -> AiResult:
    """Run an Agent task and record latency/source metrics."""
    started = time.perf_counter()
    try:
        result = await _run_agent(request)
    except Exception:
        record_request(
            task=request.task,
            source="error",
            fallback=True,
            latency_ms=(time.perf_counter() - started) * 1000,
            failed=True,
            request_id=get_request_id(),
        )
        raise
    record_request(
        task=request.task,
        source=result.source,
        fallback=result.fallback,
        latency_ms=(time.perf_counter() - started) * 1000,
        tools_used=result.toolsUsed,
        request_id=get_request_id(),
    )
    return result
