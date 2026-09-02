from __future__ import annotations

import contextlib
import json
import os
import time
from collections import deque
from dataclasses import dataclass
from hashlib import sha256
from typing import TYPE_CHECKING, Any

try:
    from redis.asyncio import Redis

    _REDIS_AVAILABLE = True
except ImportError:  # pragma: no cover - Redis is optional for local fallback mode.
    _REDIS_AVAILABLE = False
    if not TYPE_CHECKING:
        Redis = None


@dataclass(frozen=True)
class MemoryTurn:
    role: str
    content: str
    created_at: float


class ConversationMemory:
    """Bounded in-process memory for short Agent conversations.

    Memory is intentionally ephemeral. It is keyed by the Node-authenticated
    user and session, so a browser session cannot read another user's context.
    """

    def __init__(
        self,
        max_turns: int = 12,
        ttl_seconds: int = 3600,
        redis_url: str | None = None,
        redis_prefix: str = "auction-agent:memory",
    ):
        self.max_turns = max_turns
        self.ttl_seconds = ttl_seconds
        self.redis_url = (redis_url if redis_url is not None else os.getenv("REDIS_URL", "")).strip()
        self.redis_prefix = redis_prefix
        self._items: dict[str, deque[MemoryTurn]] = {}
        self._updated_at: dict[str, float] = {}
        # redis-py types async commands as ``Awaitable[T] | T``, which does not
        # play well with ``await``; treat the client as dynamic to avoid that.
        self._redis: Any = None
        self._redis_disabled_until = 0.0

    def get(self, key: str) -> list[MemoryTurn]:
        self._purge_expired()
        self._purge(key)
        return list(self._items.get(key, ()))

    def append(self, key: str, role: str, content: str) -> None:
        self._purge_expired()
        self._purge(key)
        turns = self._items.setdefault(key, deque(maxlen=self.max_turns))
        turns.append(MemoryTurn(role=role, content=content, created_at=time.time()))
        self._updated_at[key] = time.time()

    def size(self, key: str) -> int:
        return len(self.get(key))

    def clear(self, key: str) -> None:
        self._items.pop(key, None)
        self._updated_at.pop(key, None)

    async def aget(self, key: str) -> list[MemoryTurn]:
        """Read Redis-backed history when configured, otherwise local history."""
        remote = await self._redis_client()
        if remote is not None:
            try:
                values = await remote.lrange(self._redis_key(key), 0, -1)
                decoded = [self._decode_turn(value) for value in values]
                turns = [turn for turn in decoded if turn is not None]
                if turns:
                    self._replace_local(key, turns)
                    return turns
                self.clear(key)
                return []
            except Exception:
                await self._disable_redis(remote)
        return self.get(key)

    async def aappend(self, key: str, role: str, content: str) -> None:
        self._purge_expired()
        self._purge(key)
        turn = MemoryTurn(role=role, content=content, created_at=time.time())
        turns = self._items.setdefault(key, deque(maxlen=self.max_turns))
        turns.append(turn)
        self._updated_at[key] = time.time()

        remote = await self._redis_client()
        if remote is None:
            return
        try:
            await remote.rpush(self._redis_key(key), self._encode_turn(turn))
            await remote.ltrim(self._redis_key(key), -self.max_turns, -1)
            await remote.expire(self._redis_key(key), self.ttl_seconds)
        except Exception:
            await self._disable_redis(remote)

    async def asize(self, key: str) -> int:
        remote = await self._redis_client()
        if remote is not None:
            try:
                return int(await remote.llen(self._redis_key(key)))
            except Exception:
                await self._disable_redis(remote)
        return self.size(key)

    async def close(self) -> None:
        if self._redis is not None:
            await self._redis.aclose()
            self._redis = None

    async def _redis_client(self) -> Any:
        if not self.redis_url or time.time() < self._redis_disabled_until:
            return None
        if self._redis is not None:
            return self._redis
        if not _REDIS_AVAILABLE:
            self._redis_disabled_until = time.time() + 60
            return None
        try:
            self._redis = Redis.from_url(
                self.redis_url,
                decode_responses=True,
                socket_connect_timeout=0.4,
                socket_timeout=0.8,
            )
            await self._redis.ping()
            return self._redis
        except Exception:
            if self._redis is not None:
                await self._redis.aclose()
            self._redis = None
            self._redis_disabled_until = time.time() + 10
            return None

    async def _disable_redis(self, remote: Any) -> None:
        self._redis_disabled_until = time.time() + 10
        with contextlib.suppress(Exception):
            await remote.aclose()
        self._redis = None

    def _redis_key(self, key: str) -> str:
        digest = sha256(key.encode("utf-8")).hexdigest()
        return f"{self.redis_prefix}:{digest}"

    @staticmethod
    def _encode_turn(turn: MemoryTurn) -> str:
        return json.dumps(
            {"role": turn.role, "content": turn.content, "createdAt": turn.created_at},
            ensure_ascii=False,
            separators=(",", ":"),
        )

    @staticmethod
    def _decode_turn(value: Any) -> MemoryTurn | None:
        try:
            payload = json.loads(value)
            if not isinstance(payload, dict):
                return None
            role = payload.get("role")
            content = payload.get("content")
            created_at = payload.get("createdAt")
            if not isinstance(role, str) or not isinstance(content, str):
                return None
            return MemoryTurn(role=role, content=content, created_at=float(created_at or 0.0))
        except (TypeError, ValueError, json.JSONDecodeError):
            return None

    def _replace_local(self, key: str, turns: list[MemoryTurn]) -> None:
        self._items[key] = deque(turns[-self.max_turns :], maxlen=self.max_turns)
        self._updated_at[key] = time.time()

    def _purge(self, key: str) -> None:
        updated_at = self._updated_at.get(key)
        if updated_at is not None and time.time() - updated_at > self.ttl_seconds:
            self.clear(key)

    def _purge_expired(self) -> None:
        now = time.time()
        for key, updated_at in list(self._updated_at.items()):
            if now - updated_at > self.ttl_seconds:
                self.clear(key)


conversation_memory = ConversationMemory()


def format_turns(turns: list[MemoryTurn], limit: int = 8) -> str:
    return "\n".join(f"{turn.role}: {turn.content}" for turn in turns[-limit:])
