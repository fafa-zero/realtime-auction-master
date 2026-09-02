"""Targeted regression tests that pin behavior mutation testing flagged as weak.

Each test here exists to kill a specific class of surviving mutant: reading the
wrong context key (by making the fallback value differ), exact reason wording,
loop control flow, default values and boundary comparisons.
"""

from __future__ import annotations

import pytest

from services.agent.app import reliability
from services.agent.app.knowledge import retrieve
from services.agent.app.reliability import CircuitBreaker
from services.agent.app.tools import analyze_bid_risk, get_inventory_status


# --------------------------------------------------------------------------- #
# analyze_bid_risk: bidRisk keys must win over auction fallbacks
# --------------------------------------------------------------------------- #
def test_bid_risk_reads_current_price_from_bid_input_not_auction() -> None:
    result = analyze_bid_risk({"bidRisk": {"currentPrice": 50, "price": 60}, "auction": {"currentPrice": 999}})
    assert result["currentPrice"] == 50
    assert result["jumpAmount"] == 10


def test_bid_risk_reads_price_and_recent_count_keys() -> None:
    result = analyze_bid_risk(
        {"bidRisk": {"currentPrice": 100, "price": 77, "recentBidCount": 5, "reachesCeiling": False}}
    )
    assert result["price"] == 77
    assert result["recentBidCount"] == 5
    assert result["level"] == "MEDIUM"  # recentBidCount >= 3


def test_bid_risk_increment_step_key_controls_large_jump() -> None:
    # bidRisk.incrementStep=1 makes a jump of 10 "large"; the auction fallback of
    # 100 would not. A mutant reading the wrong key flips the verdict.
    result = analyze_bid_risk(
        {
            "bidRisk": {"currentPrice": 0, "price": 10, "incrementStep": 1, "recentBidCount": 0, "reachesCeiling": False},
            "auction": {"incrementStep": 100},
        }
    )
    assert result["level"] == "MEDIUM"
    assert "本次加价幅度明显高于最低加价要求" in result["reasons"]


def test_bid_risk_reaches_ceiling_key_is_honored() -> None:
    result = analyze_bid_risk(
        {"bidRisk": {"currentPrice": 1, "price": 1, "reachesCeiling": True, "recentBidCount": 0}, "auction": {"ceilingPrice": 1000}}
    )
    assert result["reachesCeiling"] is True
    assert result["level"] == "MEDIUM"


def test_bid_risk_reasons_are_exact_and_ordered() -> None:
    result = analyze_bid_risk(
        {"bidRisk": {"currentPrice": 100, "price": 1000, "incrementStep": 10, "recentBidCount": 5, "reachesCeiling": True}}
    )
    assert result["reasons"] == [
        "本次出价达到封顶价，会立即触发成交",
        "该用户 30 秒内出价次数较多",
        "本次加价幅度明显高于最低加价要求",
    ]


# --------------------------------------------------------------------------- #
# get_inventory_status: control flow, exact item shape and defaults
# --------------------------------------------------------------------------- #
def test_inventory_skips_non_dict_items_without_dropping_rest() -> None:
    # A `continue`->`break` mutant would drop the trailing dict.
    result = get_inventory_status({"inventory": [{"name": "a", "stock": 0}, "junk", {"name": "b", "stock": 0}]})
    assert result["totalProducts"] == 2


def test_inventory_attention_item_shape_is_exact() -> None:
    result = get_inventory_status({"inventory": [{"id": "x1", "name": "翡翠", "stock": 0, "queueStatus": "SOLD"}]})
    assert result["attentionItems"][0] == {"id": "x1", "name": "翡翠", "stock": 0, "queueStatus": "SOLD"}


def test_inventory_item_defaults_for_missing_fields() -> None:
    result = get_inventory_status({"inventory": [{"stock": 0}]})
    item = result["attentionItems"][0]
    assert item["name"] == "未命名商品"
    assert item["queueStatus"] == "QUEUED"
    assert item["id"] is None


# --------------------------------------------------------------------------- #
# knowledge.retrieve: default top_k and case-folding
# --------------------------------------------------------------------------- #
def test_retrieve_default_top_k_is_three() -> None:
    query = "竞拍 出价 封顶 延时 主播 权限 库存 订单 售后 复盘 风险 AI"
    assert len(retrieve(query)) == 3


def test_retrieve_lowercases_query_for_ascii_keywords() -> None:
    hits = retrieve("ai")
    assert hits[0].id == "ai-compliance"


# --------------------------------------------------------------------------- #
# CircuitBreaker: constructor defaults and recovery boundary
# --------------------------------------------------------------------------- #
def test_circuit_breaker_default_threshold_and_recovery() -> None:
    breaker = CircuitBreaker()
    assert breaker.failure_threshold == 3
    assert breaker.recovery_seconds == 30.0
    for _ in range(3):
        breaker.record_failure()
    assert breaker.snapshot().state == "OPEN"


def test_circuit_breaker_clamps_bounds() -> None:
    assert CircuitBreaker(failure_threshold=0).failure_threshold == 1
    assert CircuitBreaker(failure_threshold=1).failure_threshold == 1
    assert CircuitBreaker(recovery_seconds=0.5).recovery_seconds == 0.5
    assert CircuitBreaker(recovery_seconds=0.0).recovery_seconds == 0.1


def test_circuit_breaker_recovers_at_exact_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = [100.0]
    monkeypatch.setattr(reliability.time, "monotonic", lambda: clock[0])
    breaker = CircuitBreaker(failure_threshold=1, recovery_seconds=10)
    breaker.record_failure()
    assert breaker.snapshot().state == "OPEN"
    clock[0] = 110.0  # elapsed == recovery_seconds; ">=" must allow a probe
    assert breaker.allow() is True
