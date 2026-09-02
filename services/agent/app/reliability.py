"""Dependency-free circuit breaker for outbound model calls."""

import time
from dataclasses import dataclass
from threading import Lock


@dataclass(frozen=True)
class CircuitSnapshot:
    state: str
    consecutive_failures: int
    opened_at: float | None


class CircuitOpenError(RuntimeError):
    """Raised when the model provider is temporarily considered unavailable."""


class CircuitBreaker:
    def __init__(self, failure_threshold: int = 3, recovery_seconds: float = 30.0):
        self.failure_threshold = max(1, int(failure_threshold))
        self.recovery_seconds = max(0.1, float(recovery_seconds))
        self._lock = Lock()
        self._failures = 0
        self._opened_at: float | None = None

    def allow(self) -> bool:
        with self._lock:
            if self._opened_at is None:
                return True
            if time.monotonic() - self._opened_at >= self.recovery_seconds:
                # Half-open: allow exactly one caller to probe the provider.
                self._opened_at = None
                self._failures = 0
                return True
            return False

    def before_call(self) -> None:
        if not self.allow():
            raise CircuitOpenError("模型服务暂时熔断，请稍后重试")

    def record_success(self) -> None:
        with self._lock:
            self._failures = 0
            self._opened_at = None

    def record_failure(self) -> None:
        with self._lock:
            self._failures += 1
            if self._failures >= self.failure_threshold:
                self._opened_at = time.monotonic()

    def snapshot(self) -> CircuitSnapshot:
        with self._lock:
            state = "OPEN" if self._opened_at is not None else "CLOSED"
            return CircuitSnapshot(state, self._failures, self._opened_at)

    def reset(self) -> None:
        with self._lock:
            self._failures = 0
            self._opened_at = None

