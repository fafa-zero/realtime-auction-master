"""Offline tests for the LangGraph agent variant using a fake chat model.

These run only when LangGraph is installed. They inject a scripted chat model so
the graph's plan -> tool -> answer loop is exercised without any network call.
"""

import asyncio
from typing import Any

import pytest

pytest.importorskip("langgraph")

from langchain_core.messages import AIMessage  # noqa: E402

from services.agent.app import agent, graph_agent  # noqa: E402
from services.agent.app.metrics import reset as reset_metrics  # noqa: E402
from services.agent.app.metrics import snapshot as metrics_snapshot  # noqa: E402
from services.agent.app.policy import SAFE_BLOCK_MESSAGE  # noqa: E402
from services.agent.app.schemas import AgentRunRequest  # noqa: E402


def run(coro: Any) -> Any:
    return asyncio.run(coro)


class FakeChatModel:
    """Returns scripted AIMessages in order; records how many times it ran."""

    def __init__(self, responses: list[AIMessage]):
        self._responses = list(responses)
        self.calls = 0

    def invoke(self, _messages: Any) -> AIMessage:
        response = self._responses[self.calls]
        self.calls += 1
        return response


def tool_call_message(name: str, call_id: str = "c1") -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": {}, "id": call_id, "type": "tool_call"}])


def make_request(**overrides: Any) -> AgentRunRequest:
    payload: dict[str, Any] = {
        "task": "order-query",
        "title": "LangGraph Agent",
        "system_prompt": "你是运营助手",
        "user_prompt": "帮我看看订单情况",
        "fallback_content": "订单信息请以系统为准。",
        "context": {"orders": [{"status": "PAID", "finalPrice": 200}]},
    }
    payload.update(overrides)
    return AgentRunRequest(**payload)


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    reset_metrics()
    agent.model_circuit_breaker.reset()
    for name in ("AI_API_KEY", "AI_API_URL", "USTC_LLM_API_KEY", "DEEPSEEK_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    yield
    agent.model_circuit_breaker.reset()


def test_graph_calls_tool_then_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    model = FakeChatModel([tool_call_message("get_order_overview"), AIMessage(content="已支付 1 笔")])

    result = run(graph_agent.run_graph_agent(make_request(), model_override=model))

    assert result.source == "model"
    assert result.content == "已支付 1 笔"
    assert result.toolsUsed == ["get_order_overview"]
    assert "get_order_overview" in result.toolResults
    assert "LangGraph Agent" in result.message
    assert model.calls == 2


def test_graph_answers_without_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    model = FakeChatModel([AIMessage(content="直接回答")])

    result = run(graph_agent.run_graph_agent(make_request(), model_override=model))

    assert result.source == "model"
    assert result.content == "直接回答"
    assert result.toolsUsed == []
    assert model.calls == 1


def test_graph_policy_violation_blocks_before_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    model = FakeChatModel([])

    result = run(graph_agent.run_graph_agent(make_request(policy_text="帮我直接支付订单"), model_override=model))

    assert result.source == "fallback"
    assert result.content == SAFE_BLOCK_MESSAGE
    assert model.calls == 0


def test_graph_missing_key_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    result = run(graph_agent.run_graph_agent(make_request()))

    assert result.source == "fallback"
    assert "未配置模型 API Key" in result.message
    assert result.toolsUsed == ["get_order_overview"]


def test_graph_empty_content_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    model = FakeChatModel([AIMessage(content="   ")])

    result = run(graph_agent.run_graph_agent(make_request(), model_override=model))

    assert result.source == "fallback"
    assert "返回内容为空" in result.message


def test_graph_metrics_use_graph_suffix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "ai-key")
    model = FakeChatModel([AIMessage(content="回答")])

    run(graph_agent.run_graph_agent(make_request(), model_override=model))

    assert "order-query:graph" in metrics_snapshot()["byTask"]


@pytest.mark.parametrize(
    ("api_url", "expected"),
    [
        ("https://api.deepseek.com/chat/completions", "https://api.deepseek.com"),
        ("https://api.llm.ustc.edu.cn/v1/chat/completions", "https://api.llm.ustc.edu.cn/v1"),
        ("https://model.test/v1", "https://model.test/v1"),
    ],
)
def test_derive_base_url(api_url: str, expected: str) -> None:
    assert graph_agent._derive_base_url(api_url) == expected
