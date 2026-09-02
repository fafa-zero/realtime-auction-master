"""Shared test isolation for the agent test suite.

The chat orchestrator uses a module-level ``conversation_memory`` singleton that
prefers Redis when ``REDIS_URL`` is set. Without isolation, a developer's local
Redis (or leftover state from a previous run) leaks between tests and makes
``historySize`` assertions non-deterministic. This fixture pins the singleton to
its bounded in-process mode and clears it around every test, keeping the suite
hermetic (which mutation testing also depends on).
"""

import pytest

from services.agent.app.memory import conversation_memory


@pytest.fixture(autouse=True)
def _isolate_conversation_memory() -> None:
    conversation_memory.redis_url = ""
    conversation_memory._redis = None
    conversation_memory._redis_disabled_until = 0.0
    conversation_memory._items.clear()
    conversation_memory._updated_at.clear()
    yield
    conversation_memory._items.clear()
    conversation_memory._updated_at.clear()
