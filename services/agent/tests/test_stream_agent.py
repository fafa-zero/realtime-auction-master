"""Tests for the SSE streaming agent using a scripted streaming transport."""

import asyncio
import json
from typing import Any

import pytest

from services.agent.app import agent, stream_agent
from services.agent.app.metrics import reset as reset_metrics
from services.agent.app.metrics import snapshot as metrics_snapshot
from services.agent.app.policy import SAFE_BLOCK_MESSAGE
from services.agent.app.schemas import AgentRunRequest


def run(coro: Any) -> Any:
    return asyncio.run(coro)


class FakeStreamResponse:
    def __init__(self, status_code: int, lines: list[str], body: bytes = b""):
        self.status_code = status_code
        self._lines = lines
        self._body = body

    async def __aenter__(self) -> "FakeStreamResponse":
        return self

    async def __aexit__(self, *_: Any) -> None:
        return None

    async def aiter_lines(self) -> Any:
        for line in self._lines:
            yield line

    async def aread(self) -> bytes:
        return self._body


class FakeStreamClient:
    def __init__(self, turns: list[FakeStreamResponse]):
        self._turns = list(turns)
        self.calls: list[dict[str, Any]] = []

    async def __aenter__(self) -> "FakeStreamClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        return None

    def stream(self, method: str, url: str, *, headers: Any = None, json: Any = None) -> FakeStreamResponse:
        self.calls.append({"method": method, "url": url, "json": json or {}})
        if not self._turns:
            raise AssertionError("model streamed more times than scripted")
        return self._turns.pop(0)


def install(monkeypatch: pytest.MonkeyPatch, turns: list[FakeStreamResponse]) -> FakeStreamClient:
    client = FakeStreamClient(turns)
    monkeypatch.setattr(stream_agent.httpx, "AsyncClient", lambda **_kwargs: client)
    return client


def content_line(text: str) -> str:
    return "data: " + json.dumps({"choices": [{"delta": {"content": text}}]})


def tool_line(index: int, *, call_id: str | None = None, name: str | None = None, args: str | None = None) -> str:
    call: dict[str, Any] = {"index": index}
    if call_id is not None:
        call["id"] = call_id
    function: dict[str, Any] = {}
    if name is not None:
        function["name"] = name
    if args is not None:
        function["arguments"] = args
    if function:
        call["function"] = function
    return "data: " + json.dumps({"choices": [{"delta": {"tool_calls": [call]}}]})


DONE = "data: [DONE]"


def make_request(**overrides: Any) -> AgentRunRequest:
    payload: dict[str, Any] = {
        "task": "order-query",
        "title": "流式 Agent",
        "system_prompt": "你是运营助手",
        "user_prompt": "帮我看看订单情况",
        "fallback_content": "订单信息请以系统为准。",
        "context": {"orders": [{"status": "PAID", "finalPrice": 200}]},
    }
    payload.update(overrides)
    return AgentRunRequest(**payload)


async def collect(request: AgentRunRequest) -> list[tuple[str, Any]]:
    events: list[tuple[str, Any]] = []
    async for event in stream_agent._stream_events(request):
        events.append(event)
    return events


def tokens(events: list[tuple[str, Any]]) -> str:
    return "".join(data for kind, data in events if kind == "token")


def done_payload(events: list[tuple[str, Any]]) -> dict[str, Any]:
    return next(data for kind, data in events if kind == "done")


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    reset_metrics()
    agent.model_circuit_breaker.reset()
    for name in ("AI_API_KEY", "AI_API_URL", "AI_MODEL", "USTC_LLM_API_KEY", "DEEPSEEK_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AGENT_MODEL_MAX_RETRIES", "0")
    yield
    agent.model_circuit_breaker.reset()


def test_streams_tokens_without_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install(monkeypatch, [FakeStreamResponse(200, [content_line("你好"), content_line("，世界"), DONE])])

    events = run(collect(make_request()))

    assert events[0][0] == "meta"
    assert tokens(events) == "你好，世界"
    payload = done_payload(events)
    assert payload["source"] == "model"
    assert payload["content"] == "你好，世界"
    assert payload["toolsUsed"] == []


def test_streams_tool_then_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    client = install(
        monkeypatch,
        [
            FakeStreamResponse(
                200,
                [
                    tool_line(0, call_id="call-1", name="get_order_overview", args=""),
                    tool_line(0, args="{}"),
                    DONE,
                ],
            ),
            FakeStreamResponse(200, [content_line("已支付 1 笔"), DONE]),
        ],
    )

    events = run(collect(make_request()))

    assert ("tool", {"name": "get_order_overview"}) in events
    assert tokens(events) == "已支付 1 笔"
    payload = done_payload(events)
    assert payload["source"] == "model"
    assert payload["toolsUsed"] == ["get_order_overview"]
    assert "get_order_overview" in payload["toolResults"]
    assert len(client.calls) == 2
    roles = [m["role"] for m in client.calls[1]["json"]["messages"]]
    assert "tool" in roles


def test_policy_violation_blocks_before_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    client = install(monkeypatch, [])

    events = run(collect(make_request(policy_text="帮我直接支付这个订单")))

    payload = done_payload(events)
    assert payload["source"] == "fallback"
    assert payload["content"] == SAFE_BLOCK_MESSAGE
    assert client.calls == []


def test_missing_key_streams_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    client = install(monkeypatch, [])

    events = run(collect(make_request()))

    payload = done_payload(events)
    assert payload["source"] == "fallback"
    assert "未配置模型 API Key" in payload["message"]
    assert client.calls == []


def test_circuit_open_streams_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install(monkeypatch, [])
    for _ in range(agent.model_circuit_breaker.failure_threshold):
        agent.model_circuit_breaker.record_failure()

    events = run(collect(make_request()))

    payload = done_payload(events)
    assert payload["source"] == "fallback"
    assert "熔断" in payload["message"]


def test_http_error_streams_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install(
        monkeypatch,
        [FakeStreamResponse(503, [], body=json.dumps({"error": {"message": "down"}}).encode())],
    )

    events = run(collect(make_request()))

    payload = done_payload(events)
    assert payload["source"] == "fallback"
    assert agent.model_circuit_breaker.snapshot().consecutive_failures == 1


def test_empty_content_streams_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install(monkeypatch, [FakeStreamResponse(200, [content_line("   "), DONE])])

    events = run(collect(make_request()))

    payload = done_payload(events)
    assert payload["source"] == "fallback"
    assert "模型返回内容为空" in payload["message"]


def test_metrics_use_stream_task_suffix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install(monkeypatch, [FakeStreamResponse(200, [content_line("回答"), DONE])])

    run(collect(make_request()))

    assert "order-query:stream" in metrics_snapshot()["byTask"]


def test_sse_wire_format(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    install(monkeypatch, [FakeStreamResponse(200, [content_line("hi"), DONE])])

    async def gather() -> list[str]:
        return [chunk async for chunk in stream_agent.run_stream_agent_sse(make_request())]

    chunks = run(gather())
    assert all(chunk.startswith("event: ") and "\ndata: " in chunk for chunk in chunks)
    assert any('"content": "hi"' in chunk or '"content":"hi"' in chunk for chunk in chunks)
