import asyncio

import httpx

from services.agent.app import agent
from services.agent.app.reliability import CircuitBreaker
from services.agent.app.schemas import AgentRunRequest


def run(coro):
    return asyncio.run(coro)


def request() -> AgentRunRequest:
    return AgentRunRequest(
        task="chat",
        title="测试模型",
        system_prompt="简洁回答",
        user_prompt="竞拍规则是什么？",
        fallback_content="请以页面规则为准。",
    )


def test_circuit_breaker_opens_after_threshold_and_recovers(monkeypatch):
    clock = iter([100.0, 101.0, 103.0])
    monkeypatch.setattr("services.agent.app.reliability.time.monotonic", lambda: next(clock))
    breaker = CircuitBreaker(failure_threshold=2, recovery_seconds=2)

    breaker.record_failure()
    assert breaker.allow() is True
    breaker.record_failure()
    assert breaker.snapshot().state == "OPEN"
    assert breaker.allow() is False
    assert breaker.allow() is True


def test_model_retries_transient_failure_then_succeeds(monkeypatch):
    monkeypatch.setenv("AI_API_KEY", "test-key")
    monkeypatch.setenv("AI_API_URL", "https://model.test/chat")
    monkeypatch.setenv("AI_MODEL", "test-model")
    monkeypatch.setenv("AGENT_MODEL_MAX_RETRIES", "1")
    monkeypatch.setenv("AGENT_MODEL_RETRY_BACKOFF_SECONDS", "0")
    monkeypatch.setenv("AGENT_MODEL_RETRY_BACKOFF_MAX_SECONDS", "0")
    agent.model_circuit_breaker.reset()

    class FakeClient:
        calls = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def post(self, *_args, **_kwargs):
            self.calls += 1
            if self.calls == 1:
                return httpx.Response(503, json={"error": {"message": "temporary"}})
            return httpx.Response(200, json={"choices": [{"message": {"content": "模型回答"}}]})

    client = FakeClient()
    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **_kwargs: client)

    result = run(agent.run_agent(request()))
    assert result.source == "model"
    assert result.fallback is False
    assert client.calls == 2
    agent.model_circuit_breaker.reset()
