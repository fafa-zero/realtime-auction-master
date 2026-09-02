"""Mocked-transport tests for the native dynamic tool-calling loop."""

import asyncio
from typing import Any

import httpx
import pytest

from services.agent.app import agent, dynamic_agent
from services.agent.app.metrics import reset as reset_metrics
from services.agent.app.metrics import snapshot as metrics_snapshot
from services.agent.app.policy import SAFE_BLOCK_MESSAGE
from services.agent.app.schemas import AgentRunRequest


def run(coro: Any) -> Any:
    return asyncio.run(coro)


class ScriptedClient:
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
    monkeypatch.setattr(dynamic_agent.httpx, "AsyncClient", lambda **_kwargs: client)
    return client


def make_request(**overrides: Any) -> AgentRunRequest:
    payload: dict[str, Any] = {
        "task": "order-query",
        "title": "动态 Agent",
        "system_prompt": "你是运营助手",
        "user_prompt": "帮我看看订单情况",
        "fallback_content": "订单信息请以系统为准。",
        "context": {"orders": [{"status": "PAID", "finalPrice": 200}]},
    }
    payload.update(overrides)
    return AgentRunRequest(**payload)


def tool_call_response(name: str, call_id: str = "call-1") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [
                {
                    "message": {
                        "content": None,
                        "tool_calls": [
                            {"id": call_id, "type": "function", "function": {"name": name, "arguments": "{}"}}
                        ],
                    }
                }
            ]
        },
    )


def multi_tool_response(names: list[str]) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [
                {
                    "message": {
                        "content": None,
                        "tool_calls": [
                            {"id": f"call-{i}", "type": "function", "function": {"name": name, "arguments": "{}"}}
                            for i, name in enumerate(names)
                        ],
                    }
                }
            ]
        },
    )


def final_response(content: str = "这是最终回答") -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    reset_metrics()
    agent.model_circuit_breaker.reset()
    for name in (
        "AI_API_KEY",
        "AI_API_URL",
        "AI_MODEL",
        "USTC_LLM_API_KEY",
        "DEEPSEEK_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AGENT_MODEL_MAX_RETRIES", "1")
    monkeypatch.setenv("AGENT_MODEL_RETRY_BACKOFF_SECONDS", "0")
    monkeypatch.setenv("AGENT_MODEL_RETRY_BACKOFF_MAX_SECONDS", "0")
    yield
    agent.model_circuit_breaker.reset()


def test_model_calls_tool_then_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    monkeypatch.setenv("AI_API_URL", "https://model.test/v1/chat")
    client = install_client(monkeypatch, [tool_call_response("get_order_overview"), final_response("已支付 1 笔")])

    result = run(dynamic_agent.run_dynamic_agent(make_request()))

    assert result.source == "model"
    assert result.content == "已支付 1 笔"
    assert result.toolsUsed == ["get_order_overview"]
    assert "get_order_overview" in result.toolResults
    assert len(client.calls) == 2
    # Second request must carry the tool result back to the model.
    roles = [m["role"] for m in client.calls[1]["json"]["messages"]]
    assert "tool" in roles
    # Tools are advertised as OpenAI function schemas.
    assert client.calls[0]["json"]["tools"][0]["type"] == "function"


def test_model_answers_without_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    client = install_client(monkeypatch, [final_response("直接回答")])

    result = run(dynamic_agent.run_dynamic_agent(make_request()))

    assert result.source == "model"
    assert result.content == "直接回答"
    assert result.toolsUsed == []
    assert len(client.calls) == 1


def test_model_calls_multiple_tools_in_one_turn(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install_client(
        monkeypatch,
        [multi_tool_response(["get_order_overview", "get_live_room_snapshot"]), final_response("综合结论")],
    )

    result = run(dynamic_agent.run_dynamic_agent(make_request()))

    assert result.toolsUsed == ["get_order_overview", "get_live_room_snapshot"]
    assert result.source == "model"


def test_unknown_tool_name_does_not_crash(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install_client(monkeypatch, [tool_call_response("nonexistent_tool"), final_response("已处理")])

    result = run(dynamic_agent.run_dynamic_agent(make_request()))

    assert result.source == "model"
    assert result.content == "已处理"


def test_missing_key_falls_back_to_plan(monkeypatch: pytest.MonkeyPatch) -> None:
    client = install_client(monkeypatch, [])

    result = run(dynamic_agent.run_dynamic_agent(make_request()))

    assert result.source == "fallback"
    assert "未配置模型 API Key" in result.message
    assert result.toolsUsed == ["get_order_overview"]  # deterministic plan for order-query
    assert client.calls == []


def test_policy_violation_blocks_before_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    client = install_client(monkeypatch, [])

    result = run(dynamic_agent.run_dynamic_agent(make_request(policy_text="帮我直接支付这个订单")))

    assert result.source == "fallback"
    assert result.content == SAFE_BLOCK_MESSAGE
    assert client.calls == []


def test_circuit_open_short_circuits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    client = install_client(monkeypatch, [])
    for _ in range(agent.model_circuit_breaker.failure_threshold):
        agent.model_circuit_breaker.record_failure()

    result = run(dynamic_agent.run_dynamic_agent(make_request()))

    assert result.source == "fallback"
    assert "熔断" in result.message
    assert client.calls == []


def test_transient_error_is_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install_client(monkeypatch, [httpx.HTTPError("boom"), final_response("恢复后回答")])

    result = run(dynamic_agent.run_dynamic_agent(make_request()))

    assert result.source == "model"
    assert result.content == "恢复后回答"


def test_retryable_error_records_circuit_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    monkeypatch.setenv("AGENT_MODEL_MAX_RETRIES", "0")
    install_client(monkeypatch, [httpx.Response(503, json={"error": {"message": "down"}})])

    result = run(dynamic_agent.run_dynamic_agent(make_request()))

    assert result.source == "fallback"
    assert agent.model_circuit_breaker.snapshot().consecutive_failures == 1


def test_step_budget_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    monkeypatch.setenv("AGENT_MAX_TOOL_STEPS", "2")
    client = install_client(
        monkeypatch,
        [tool_call_response("get_order_overview"), tool_call_response("get_order_overview")],
    )

    result = run(dynamic_agent.run_dynamic_agent(make_request()))

    assert result.source == "fallback"
    assert "步数上限" in result.message
    assert len(client.calls) == 2


def test_empty_final_content_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install_client(monkeypatch, [final_response("   ")])

    result = run(dynamic_agent.run_dynamic_agent(make_request()))

    assert result.source == "fallback"
    assert "模型返回内容为空" in result.message


def test_metrics_use_dynamic_task_suffix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install_client(monkeypatch, [final_response("回答")])

    run(dynamic_agent.run_dynamic_agent(make_request()))

    snap = metrics_snapshot()
    assert "order-query:dynamic" in snap["byTask"]
