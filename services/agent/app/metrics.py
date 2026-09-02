"""Small process-local metrics for Agent quality and operations.

The service deliberately keeps this dependency-free. Metrics contain only
aggregate request metadata; prompts, user identifiers and model credentials
are never stored.
"""

import time
from collections import Counter, deque
from threading import Lock
from typing import Any

_started_at = time.time()
_lock = Lock()
_total_requests = 0
_total_failures = 0
_total_fallbacks = 0
_by_task: Counter[str] = Counter()
_by_source: Counter[str] = Counter()
_by_task_source: Counter[tuple[str, str]] = Counter()
_latencies_ms: deque[float] = deque(maxlen=500)
_recent: deque[dict[str, Any]] = deque(maxlen=100)
_latency_buckets = (5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000)
_latency_bucket_counts: Counter[int] = Counter()
_latency_sum_ms = 0.0


def record_request(
    *,
    task: str,
    source: str,
    fallback: bool,
    latency_ms: float,
    tools_used: list[str] | None = None,
    failed: bool = False,
    request_id: str = "-",
) -> None:
    """Record one completed Agent request without retaining request content."""
    global _total_requests, _total_failures, _total_fallbacks, _latency_sum_ms
    bounded_latency = max(0.0, round(float(latency_ms), 2))
    with _lock:
        _total_requests += 1
        if failed:
            _total_failures += 1
        if fallback and not failed:
            _total_fallbacks += 1
        _by_task[task] += 1
        _by_source[source] += 1
        _by_task_source[(task, source)] += 1
        _latencies_ms.append(bounded_latency)
        _latency_sum_ms += bounded_latency
        for bucket in _latency_buckets:
            if bounded_latency <= bucket:
                _latency_bucket_counts[bucket] += 1
        _recent.append(
            {
                "task": task,
                "source": source,
                "fallback": bool(fallback),
                "failed": bool(failed),
                "latencyMs": bounded_latency,
                "toolsUsed": list(tools_used or []),
                "timestamp": int(time.time() * 1000),
                "requestId": request_id,
            }
        )


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((percentile / 100) * (len(ordered) - 1)))))
    return round(ordered[index], 2)


def snapshot() -> dict[str, Any]:
    """Return a JSON-serializable snapshot suitable for an internal endpoint."""
    with _lock:
        total = _total_requests
        fallback_count = _total_fallbacks
        values = list(_latencies_ms)
        return {
            "ok": True,
            "uptimeSeconds": max(0, int(time.time() - _started_at)),
            "totalRequests": total,
            "totalFailures": _total_failures,
            "totalFallbacks": fallback_count,
            "fallbackRate": round(fallback_count / total, 4) if total else 0.0,
            "averageLatencyMs": round(sum(values) / len(values), 2) if values else 0.0,
            "p95LatencyMs": _percentile(values, 95),
            "byTask": dict(_by_task),
            "bySource": dict(_by_source),
            "recent": list(_recent),
        }


def prometheus_snapshot() -> dict[str, Any]:
    """Return cumulative values needed to render a Prometheus scrape."""
    with _lock:
        return {
            "uptimeSeconds": max(0, time.time() - _started_at),
            "totalRequests": _total_requests,
            "totalFailures": _total_failures,
            "totalFallbacks": _total_fallbacks,
            "byTaskSource": dict(_by_task_source),
            "latencyBuckets": {str(bucket): _latency_bucket_counts.get(bucket, 0) for bucket in _latency_buckets},
            "latencyCount": _total_requests,
            "latencySumMs": _latency_sum_ms,
        }


def reset() -> None:
    """Reset metrics for isolated tests and local evaluation runs."""
    global _started_at, _total_requests, _total_failures, _total_fallbacks, _latency_sum_ms
    with _lock:
        _started_at = time.time()
        _total_requests = 0
        _total_failures = 0
        _total_fallbacks = 0
        _by_task.clear()
        _by_source.clear()
        _by_task_source.clear()
        _latencies_ms.clear()
        _recent.clear()
        _latency_bucket_counts.clear()
        _latency_sum_ms = 0.0
