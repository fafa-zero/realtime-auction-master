import asyncio

import httpx
import pytest

from services.agent.app.main import app


@pytest.fixture(autouse=True)
def disable_external_providers(monkeypatch):
    monkeypatch.delenv("AGENT_SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("AI_API_KEY", raising=False)
    monkeypatch.delenv("USTC_LLM_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)


def request(payload):
    async def send():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.post("/v1/agent/chat", json=payload)

    return asyncio.run(send())


def test_node_to_fastapi_chat_contract_with_full_context(monkeypatch):
    monkeypatch.delenv("AGENT_SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("AI_API_KEY", raising=False)
    response = request(
        {
            "message": "当前竞拍有什么规则？",
            "session_id": "node-contract-1",
            "user_id": "buyer-123",
            "user_role": "BUYER",
            "live_room_id": "live-1",
            "context": {
                "liveRoom": {"id": "live-1", "title": "珠宝专场", "hostName": "主播"},
                "product": {
                    "id": "product-1",
                    "name": "翡翠吊坠",
                    "description": "天然翡翠",
                    "startPrice": 100,
                    "incrementStep": 10,
                    "ceilingPrice": 500,
                    "durationSeconds": 60,
                    "stock": 1,
                },
                "auction": {
                    "status": "ACTIVE",
                    "currentPrice": 200,
                    "startPrice": 100,
                    "incrementStep": 10,
                    "ceilingPrice": 500,
                    "durationSeconds": 60,
                    "extendCount": 0,
                },
                "order": None,
                "bids": [{"nickname": "买家", "price": 200, "createdAt": 1}],
                "participantCount": 2,
                "recentDanmaku": ["想看细节"],
                "history": [],
                "serverTime": 1,
            },
        }
    )
    payload = response.json()
    assert response.status_code == 200
    assert payload["ok"] is True
    assert payload["sessionId"] == "node-contract-1"
    assert payload["intent"] == "chat"
    assert isinstance(payload["citations"], list)
    assert isinstance(payload["toolsUsed"], list)
    assert isinstance(payload["toolResults"], dict)
    assert response.headers["x-request-id"]


def test_contract_rejects_invalid_session_and_oversized_message():
    invalid_session = request({"message": "规则", "session_id": "bad session"})
    oversized = request({"message": "x" * 1001})
    assert invalid_session.status_code == 422
    assert oversized.status_code == 422
