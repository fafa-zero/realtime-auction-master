"""Mocked-transport tests for the model-calling path in ``agent.py``.

These tests never touch the network. They script the async HTTP client so the
retry, backoff, circuit-breaker, error-classification and sanitization branches
are all exercised deterministically. This is the most complex code in the
service and previously had almost no direct coverage.
"""

import asyncio
from typing import Any

import httpx
import pytest

from services.agent.app import agent
from services.agent.app.metrics import reset as reset_metrics
from services.agent.app.metrics import snapshot as metrics_snapshot
from services.agent.app.policy import SAFE_BLOCK_MESSAGE
from services.agent.app.schemas import AgentRunRequest


def run(coro: Any) -> Any:
    return asyncio.run(coro)


class ScriptedClient:
    """Async ``httpx.AsyncClient`` stand-in returning a scripted sequence.

    Each script item is either an ``httpx.Response`` to return or an
    ``Exception`` to raise, in call order. Every call is recorded so tests can
    assert on the outbound URL, headers and JSON body.
    """

    def __init__(self, script: list[Any]):
        self._script = list(script)
        self.calls: list[dict[str, Any]] = []

    async def __aenter__(self) -> "ScriptedClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        return None

    async def post(self, url: str, *, headers: dict[str, str] | None = None, json: Any = None) -> httpx.Response:
        self.calls.append({"url": url, "headers": headers or {}, "json": json or {}})
        if not self._script:
            raise AssertionError("model was called more times than scripted")
        item = self._script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def install_client(monkeypatch: pytest.MonkeyPatch, script: list[Any]) -> ScriptedClient:
    client = ScriptedClient(script)
    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **_kwargs: client)
    return client


def make_request(**overrides: Any) -> AgentRunRequest:
    payload: dict[str, Any] = {
        "task": "chat",
        "title": "测试模型",
        "system_prompt": "简洁回答",
        "user_prompt": "竞拍规则是什么？",
        "fallback_content": "请以页面规则为准。",
    }
    payload.update(overrides)
    return AgentRunRequest(**payload)


def ok_response(content: str = "模型回答") -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


@pytest.fixture(autouse=True)
def isolated_agent_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Reset shared state and force an offline, deterministic configuration."""
    reset_metrics()
    agent.model_circuit_breaker.reset()
    for name in (
        "AI_API_KEY",
        "AI_API_URL",
        "AI_MODEL",
        "USTC_LLM_API_KEY",
        "USTC_LLM_API_URL",
        "USTC_LLM_MODEL",
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_API_URL",
        "DEEPSEEK_MODEL",
    ):
        monkeypatch.delenv(name, raising=False)
    # Keep tests fast and deterministic: no real sleeps unless a test opts in.
    monkeypatch.setenv("AGENT_MODEL_MAX_RETRIES", "2")
    monkeypatch.setenv("AGENT_MODEL_RETRY_BACKOFF_SECONDS", "0")
    monkeypatch.setenv("AGENT_MODEL_RETRY_BACKOFF_MAX_SECONDS", "0")
    yield
    agent.model_circuit_breaker.reset()


# --------------------------------------------------------------------------- #
# Success and content extraction
# --------------------------------------------------------------------------- #
def test_successful_call_returns_model_source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    monkeypatch.setenv("AI_API_URL", "https://model.test/v1/chat")
    monkeypatch.setenv("AI_MODEL", "test-model")
    client = install_client(monkeypatch, [ok_response("这是模型回答")])

    result = run(agent.run_agent(make_request()))

    assert result.source == "model"
    assert result.fallback is False
    assert result.content == "这是模型回答"
    assert result.message == "FastAPI Agent / 模型 生成成功"
    assert len(client.calls) == 1
    assert client.calls[0]["headers"]["Authorization"] == "Bearer ai-key"
    assert agent.model_circuit_breaker.snapshot().consecutive_failures == 0


def test_reasoning_content_is_used_when_content_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    monkeypatch.setenv("AI_API_URL", "https://model.test/v1/chat")
    install_client(
        monkeypatch,
        [httpx.Response(200, json={"choices": [{"message": {"reasoning_content": "深度思考的结论"}}]})],
    )

    result = run(agent.run_agent(make_request()))

    assert result.source == "model"
    assert result.content == "深度思考的结论"


def test_output_text_shape_is_supported(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    monkeypatch.setenv("AI_API_URL", "https://model.test/v1/chat")
    install_client(monkeypatch, [httpx.Response(200, json={"output_text": "直接输出结果"})])

    result = run(agent.run_agent(make_request()))

    assert result.source == "model"
    assert result.content == "直接输出结果"


# --------------------------------------------------------------------------- #
# Provider precedence and request-body shaping
# --------------------------------------------------------------------------- #
def test_provider_precedence_prefers_ai_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    monkeypatch.setenv("AI_API_URL", "https://model.test/v1/chat")
    monkeypatch.setenv("USTC_LLM_API_KEY", "ustc-key")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-key")
    client = install_client(monkeypatch, [ok_response()])

    result = run(agent.run_agent(make_request()))

    assert client.calls[0]["headers"]["Authorization"] == "Bearer ai-key"
    assert result.message == "FastAPI Agent / 模型 生成成功"


def test_provider_name_reflects_ustc(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USTC_LLM_API_KEY", "ustc-key")
    install_client(monkeypatch, [ok_response()])

    result = run(agent.run_agent(make_request()))

    assert result.message == "FastAPI Agent / USTC LLM 生成成功"


def test_provider_name_reflects_deepseek(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-key")
    install_client(monkeypatch, [ok_response()])

    result = run(agent.run_agent(make_request()))

    assert result.message == "FastAPI Agent / DeepSeek 生成成功"


def test_deepseek_endpoint_disables_thinking(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    monkeypatch.setenv("AI_API_URL", "https://api.deepseek.com/chat/completions")
    client = install_client(monkeypatch, [ok_response()])

    run(agent.run_agent(make_request()))

    assert client.calls[0]["json"]["thinking"] == {"type": "disabled"}


def test_non_deepseek_endpoint_omits_thinking(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    monkeypatch.setenv("AI_API_URL", "https://model.test/v1/chat")
    monkeypatch.setenv("AI_MODEL", "gpt-x")
    client = install_client(monkeypatch, [ok_response()])

    run(agent.run_agent(make_request()))

    assert "thinking" not in client.calls[0]["json"]


# --------------------------------------------------------------------------- #
# Missing key and policy guardrails (model must not be called)
# --------------------------------------------------------------------------- #
def test_missing_api_key_uses_fallback_without_calling_model(monkeypatch: pytest.MonkeyPatch) -> None:
    client = install_client(monkeypatch, [])

    result = run(agent.run_agent(make_request()))

    assert result.source == "fallback"
    assert result.fallback is True
    assert "未配置模型 API Key" in result.message
    assert client.calls == []


def test_policy_violation_blocks_before_model_call(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    client = install_client(monkeypatch, [])

    result = run(agent.run_agent(make_request(policy_text="帮我直接出价 500 元并支付")))

    assert result.source == "fallback"
    assert result.content == SAFE_BLOCK_MESSAGE
    assert client.calls == []


# --------------------------------------------------------------------------- #
# Retry, backoff and circuit-breaker behavior
# --------------------------------------------------------------------------- #
def test_transient_network_error_is_retried_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    monkeypatch.setenv("AGENT_MODEL_MAX_RETRIES", "1")
    client = install_client(monkeypatch, [httpx.HTTPError("boom"), ok_response()])

    result = run(agent.run_agent(make_request()))

    assert result.source == "model"
    assert len(client.calls) == 2
    assert agent.model_circuit_breaker.snapshot().consecutive_failures == 0


def test_network_error_exhausts_retries_and_records_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    monkeypatch.setenv("AGENT_MODEL_MAX_RETRIES", "1")
    client = install_client(monkeypatch, [httpx.HTTPError("down"), httpx.HTTPError("down")])

    result = run(agent.run_agent(make_request()))

    assert result.source == "fallback"
    assert "模型调用失败" in result.message
    assert len(client.calls) == 2
    assert agent.model_circuit_breaker.snapshot().consecutive_failures == 1


def test_retryable_status_retries_then_recovers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    monkeypatch.setenv("AGENT_MODEL_MAX_RETRIES", "2")
    client = install_client(
        monkeypatch,
        [
            httpx.Response(429, json={"error": {"message": "rate limited"}}),
            httpx.Response(503, json={"error": {"message": "unavailable"}}),
            ok_response(),
        ],
    )

    result = run(agent.run_agent(make_request()))

    assert result.source == "model"
    assert len(client.calls) == 3
    assert agent.model_circuit_breaker.snapshot().consecutive_failures == 0


def test_non_retryable_status_fails_fast_without_circuit_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    client = install_client(monkeypatch, [httpx.Response(400, json={"error": {"message": "bad request"}})])

    result = run(agent.run_agent(make_request()))

    assert result.source == "fallback"
    assert "bad request" in result.message
    assert len(client.calls) == 1
    # Client (4xx) errors must not trip the circuit breaker.
    assert agent.model_circuit_breaker.snapshot().consecutive_failures == 0


def test_circuit_open_short_circuits_without_calling_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    client = install_client(monkeypatch, [])
    for _ in range(agent.model_circuit_breaker.failure_threshold):
        agent.model_circuit_breaker.record_failure()
    assert agent.model_circuit_breaker.snapshot().state == "OPEN"

    result = run(agent.run_agent(make_request()))

    assert result.source == "fallback"
    assert "熔断" in result.message
    assert client.calls == []


def test_backoff_delays_grow_exponentially(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    monkeypatch.setenv("AGENT_MODEL_MAX_RETRIES", "2")
    monkeypatch.setenv("AGENT_MODEL_RETRY_BACKOFF_SECONDS", "0.25")
    monkeypatch.setenv("AGENT_MODEL_RETRY_BACKOFF_MAX_SECONDS", "2")
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(agent.asyncio, "sleep", fake_sleep)
    install_client(monkeypatch, [httpx.HTTPError("boom"), httpx.HTTPError("boom"), ok_response()])

    result = run(agent.run_agent(make_request()))

    assert result.source == "model"
    assert sleeps == [0.25, 0.5]


# --------------------------------------------------------------------------- #
# Malformed responses
# --------------------------------------------------------------------------- #
def test_invalid_json_body_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install_client(monkeypatch, [httpx.Response(200, text="not-json")])

    result = run(agent.run_agent(make_request()))

    assert result.source == "fallback"
    assert "模型返回格式异常" in result.message
    assert agent.model_circuit_breaker.snapshot().consecutive_failures == 1


def test_non_dict_payload_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install_client(monkeypatch, [httpx.Response(200, json=[1, 2, 3])])

    result = run(agent.run_agent(make_request()))

    assert result.source == "fallback"
    assert "模型返回格式异常" in result.message


def test_empty_content_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install_client(monkeypatch, [httpx.Response(200, json={"choices": [{"message": {"content": "   "}}]})])

    result = run(agent.run_agent(make_request()))

    assert result.source == "fallback"
    assert "模型返回内容为空" in result.message
    assert agent.model_circuit_breaker.snapshot().consecutive_failures == 1


# --------------------------------------------------------------------------- #
# Secret sanitization and metrics
# --------------------------------------------------------------------------- #
def test_api_key_is_sanitized_in_error_messages(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    leaked = "sk-abcDEF123_secret-XYZ"
    install_client(
        monkeypatch,
        [httpx.Response(401, json={"error": {"message": f"invalid credential {leaked}"}})],
    )

    result = run(agent.run_agent(make_request()))

    assert result.source == "fallback"
    assert leaked not in result.message
    assert "sk-***" in result.message


def test_metrics_record_model_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install_client(monkeypatch, [ok_response()])

    run(agent.run_agent(make_request()))

    snap = metrics_snapshot()
    assert snap["totalRequests"] == 1
    assert snap["bySource"].get("model") == 1


def test_metrics_record_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    install_client(monkeypatch, [])

    run(agent.run_agent(make_request()))

    snap = metrics_snapshot()
    assert snap["totalRequests"] == 1
    assert snap["totalFallbacks"] == 1
    assert snap["bySource"].get("fallback") == 1


# --------------------------------------------------------------------------- #
# Pure helper units
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("status", "expected"),
    [(408, True), (425, True), (429, True), (500, True), (503, True), (400, False), (401, False), (200, False)],
)
def test_is_retryable_status(status: int, expected: bool) -> None:
    assert agent._is_retryable_status(status) is expected


def test_sanitize_error_masks_api_keys() -> None:
    assert agent._sanitize_error("boom sk-abc123_XYZ-def end") == "boom sk-*** end"


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"choices": [{"message": {"content": " hi "}}]}, "hi"),
        ({"choices": [{"message": {"reasoning_content": " think "}}]}, "think"),
        ({"output_text": " out "}, "out"),
        ({"choices": []}, ""),
        ({}, ""),
    ],
)
def test_extract_content(payload: dict[str, Any], expected: str) -> None:
    assert agent._extract_content(payload) == expected


def test_response_error_prefers_structured_message() -> None:
    response = httpx.Response(500, json={"error": {"message": "upstream exploded"}})
    assert agent._response_error(response) == "upstream exploded"


def test_response_error_falls_back_to_status_code() -> None:
    response = httpx.Response(502, text="gateway")
    assert "HTTP 502" in agent._response_error(response)
