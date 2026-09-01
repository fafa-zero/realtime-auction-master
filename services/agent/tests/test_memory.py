import asyncio
import json

from services.agent.app.memory import ConversationMemory


def run(coro):
    return asyncio.run(coro)


def test_memory_uses_bounded_local_fallback_without_redis():
    memory = ConversationMemory(max_turns=2, ttl_seconds=60, redis_url="")

    run(memory.aappend("user:room:session", "user", "one"))
    run(memory.aappend("user:room:session", "assistant", "two"))
    run(memory.aappend("user:room:session", "user", "three"))

    turns = run(memory.aget("user:room:session"))
    assert [turn.content for turn in turns] == ["two", "three"]
    assert run(memory.asize("user:room:session")) == 2


def test_async_append_preserves_local_ttl_semantics(monkeypatch):
    now = [100.0]
    monkeypatch.setattr("services.agent.app.memory.time.time", lambda: now[0])
    memory = ConversationMemory(max_turns=4, ttl_seconds=10, redis_url="")

    run(memory.aappend("ttl-key", "user", "old"))
    now[0] = 111.0
    run(memory.aappend("ttl-key", "user", "new"))

    assert [turn.content for turn in run(memory.aget("ttl-key"))] == ["new"]


class FakeRedis:
    def __init__(self):
        self.items: dict[str, list[str]] = {}
        self.ttl: dict[str, int] = {}

    async def ping(self):
        return True

    async def lrange(self, key, start, end):
        values = self.items.get(key, [])
        return values[start:] if end == -1 else values[start : end + 1]

    async def rpush(self, key, value):
        self.items.setdefault(key, []).append(value)

    async def ltrim(self, key, start, end):
        values = self.items.get(key, [])
        self.items[key] = values[start:] if end == -1 else values[start : end + 1]

    async def expire(self, key, seconds):
        self.ttl[key] = seconds

    async def llen(self, key):
        return len(self.items.get(key, []))

    async def aclose(self):
        return None


def test_memory_round_trips_redis_turns_and_applies_ttl():
    memory = ConversationMemory(max_turns=2, ttl_seconds=90, redis_url="redis://test")
    remote = FakeRedis()
    memory._redis = remote

    run(memory.aappend("private-key", "user", "你好"))
    run(memory.aappend("private-key", "assistant", "请以当前状态为准"))
    run(memory.aappend("private-key", "user", "第三条"))

    turns = run(memory.aget("private-key"))
    assert [turn.content for turn in turns] == ["请以当前状态为准", "第三条"]
    redis_key = memory._redis_key("private-key")
    assert redis_key != "private-key"
    assert remote.ttl[redis_key] == 90
    assert json.loads(remote.items[redis_key][0])["role"] == "assistant"
