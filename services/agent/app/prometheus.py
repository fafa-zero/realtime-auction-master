"""Dependency-free Prometheus text exposition for Agent metrics."""

from collections.abc import Mapping
from numbers import Real
from typing import Any


def render_metrics(metrics: Mapping[str, Any], *, circuit_state: str, circuit_failures: int) -> str:
    """Render a stable Prometheus 0.0.4 scrape from cumulative metric values."""
    lines: list[str] = []

    _metric_header(lines, "auction_agent_requests_total", "Total completed Agent requests.", "counter")
    for (task, source), count in sorted(metrics.get("byTaskSource", {}).items()):
        labels = _labels({"task": task, "source": source})
        lines.append(f"auction_agent_requests_total{labels} {_number(count)}")

    _metric_header(lines, "auction_agent_failures_total", "Total Agent requests that raised an internal error.", "counter")
    lines.append(f"auction_agent_failures_total {_number(metrics.get('totalFailures', 0))}")

    _metric_header(lines, "auction_agent_fallback_total", "Total Agent requests served by fallback output.", "counter")
    lines.append(f"auction_agent_fallback_total {_number(metrics.get('totalFallbacks', 0))}")

    _metric_header(lines, "auction_agent_fallback_ratio", "Ratio of completed Agent requests served by fallback output.", "gauge")
    requests = float(metrics.get("totalRequests", 0) or 0)
    fallbacks = float(metrics.get("totalFallbacks", 0) or 0)
    lines.append(f"auction_agent_fallback_ratio {_number(fallbacks / requests if requests else 0)}")

    _metric_header(lines, "auction_agent_request_latency_ms", "Agent request latency in milliseconds.", "histogram")
    for bucket, count in sorted(_numeric_buckets(metrics.get("latencyBuckets", {})).items()):
        lines.append(
            f"auction_agent_request_latency_ms_bucket{_labels({'le': _bucket_label(bucket)})} {_number(count)}"
        )
    lines.append(
        f"auction_agent_request_latency_ms_bucket{_labels({'le': '+Inf'})} "
        f"{_number(metrics.get('latencyCount', 0))}"
    )
    lines.append(f"auction_agent_request_latency_ms_sum {_number(metrics.get('latencySumMs', 0))}")
    lines.append(f"auction_agent_request_latency_ms_count {_number(metrics.get('latencyCount', 0))}")

    _metric_header(lines, "auction_agent_model_circuit_open", "Whether the outbound model circuit is open (1 or 0).", "gauge")
    lines.append(f"auction_agent_model_circuit_open {1 if circuit_state == 'OPEN' else 0}")
    _metric_header(lines, "auction_agent_model_circuit_failures", "Consecutive outbound model failures.", "gauge")
    lines.append(f"auction_agent_model_circuit_failures {_number(circuit_failures)}")

    _metric_header(lines, "auction_agent_uptime_seconds", "Agent process uptime in seconds.", "gauge")
    lines.append(f"auction_agent_uptime_seconds {_number(metrics.get('uptimeSeconds', 0))}")
    return "\n".join(lines) + "\n"


def _metric_header(lines: list[str], name: str, help_text: str, metric_type: str) -> None:
    lines.append(f"# HELP {name} {help_text}")
    lines.append(f"# TYPE {name} {metric_type}")


def _numeric_buckets(value: Any) -> dict[float, int]:
    if not isinstance(value, Mapping):
        return {}
    result: dict[float, int] = {}
    for raw_bucket, raw_count in value.items():
        try:
            bucket = float(raw_bucket)
            count = int(raw_count)
        except (TypeError, ValueError):
            continue
        if bucket >= 0 and count >= 0:
            result[bucket] = count
    return result


def _labels(values: Mapping[str, Any]) -> str:
    escaped = []
    for key in sorted(values):
        escaped.append(f'{key}="{_escape_label(str(values[key]))}"')
    return "{" + ",".join(escaped) + "}"


def _escape_label(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _bucket_label(value: float) -> str:
    return str(int(value)) if value.is_integer() else str(value)


def _number(value: Any) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, Real):
        return str(value)
    try:
        return str(float(value))
    except (TypeError, ValueError):
        return "0"
