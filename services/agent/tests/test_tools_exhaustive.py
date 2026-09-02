"""Exact-output tests for every tool builder.

These assert the *whole* returned structure for a rich context and for an empty
context, and check every slice boundary. Weak assertions let mutants (changed
defaults, keys, slice limits) survive; asserting the full output kills them,
which is what mutation testing rewards.
"""

from __future__ import annotations

import pytest

from services.agent.app import tools
from services.agent.app.tools import (
    TASK_PLANS,
    TOOLS,
    Tool,
    _auction,
    _live_room,
    _number,
    _product,
    analyze_live_performance,
    generate_host_script,
    get_after_sales_context,
    get_auction_history,
    get_inventory_status,
    get_live_room_snapshot,
    get_order_overview,
    get_product_info,
    get_recent_danmaku,
    list_tools,
    openai_tool_schemas,
    run_single_tool,
    run_tool_plan,
)


# --------------------------------------------------------------------------- #
# context accessors
# --------------------------------------------------------------------------- #
def test_context_accessors_return_dict_or_empty() -> None:
    assert _product({"product": {"a": 1}}) == {"a": 1}
    assert _product({"product": "nope"}) == {}
    assert _product({}) == {}
    assert _auction({"auction": {"b": 2}}) == {"b": 2}
    assert _auction({"auction": 5}) == {}
    assert _live_room({"liveRoom": {"c": 3}}) == {"c": 3}
    assert _live_room({"liveRoom": None}) == {}


# --------------------------------------------------------------------------- #
# get_live_room_snapshot
# --------------------------------------------------------------------------- #
def test_snapshot_prefers_explicit_snapshot() -> None:
    snap = {"liveRoom": {"id": "x"}, "auction": {}, "extra": 1}
    assert get_live_room_snapshot({"snapshot": snap}) == snap


def test_snapshot_builds_from_context() -> None:
    ctx = {
        "liveRoom": {"id": "live-1", "hostName": "小雅"},
        "auction": {"currentPrice": 200},
        "participantCount": 12,
        "serverTime": 1700,
    }
    assert get_live_room_snapshot(ctx) == {
        "liveRoom": {"id": "live-1", "hostName": "小雅"},
        "auction": {"currentPrice": 200},
        "participantCount": 12,
        "serverTime": 1700,
    }


def test_snapshot_defaults_on_empty_context() -> None:
    assert get_live_room_snapshot({}) == {
        "liveRoom": {},
        "auction": {},
        "participantCount": 0,
        "serverTime": None,
    }


# --------------------------------------------------------------------------- #
# get_product_info
# --------------------------------------------------------------------------- #
def test_product_info_full() -> None:
    product = {
        "id": "p1",
        "name": "翡翠",
        "description": "desc",
        "sellingPoints": ["亮点"],
        "scriptKeywords": ["kw"],
        "stock": 5,
        "startPrice": 100,
        "incrementStep": 10,
        "ceilingPrice": 500,
        "durationSeconds": 60,
    }
    assert get_product_info({"product": product}) == product


def test_product_info_falls_back_to_auction_pricing() -> None:
    ctx = {
        "product": {"id": "p2", "name": "n"},
        "auction": {"startPrice": 88, "incrementStep": 9, "ceilingPrice": 600, "durationSeconds": 45},
    }
    result = get_product_info(ctx)
    assert result["startPrice"] == 88
    assert result["incrementStep"] == 9
    assert result["ceilingPrice"] == 600
    assert result["durationSeconds"] == 45


def test_product_info_defaults_on_empty_context() -> None:
    assert get_product_info({}) == {
        "id": None,
        "name": "",
        "description": "",
        "sellingPoints": None,
        "scriptKeywords": None,
        "stock": None,
        "startPrice": None,
        "incrementStep": None,
        "ceilingPrice": None,
        "durationSeconds": None,
    }


# --------------------------------------------------------------------------- #
# get_auction_history (slice boundaries)
# --------------------------------------------------------------------------- #
def test_auction_history_slices_and_counts() -> None:
    history = [{"i": i} for i in range(25)]
    bids = [{"b": i} for i in range(35)]
    ctx = {"history": history, "bids": bids, "participantCount": 7, "auction": {"extendCount": 3}}
    result = get_auction_history(ctx)
    assert result["history"] == history[:20]
    assert len(result["history"]) == 20
    assert result["recentBids"] == bids[:30]
    assert len(result["recentBids"]) == 30
    assert result["bidCount"] == 35
    assert result["participantCount"] == 7
    assert result["extendCount"] == 3


def test_auction_history_uses_explicit_bid_count() -> None:
    assert get_auction_history({"bids": [{"b": 1}], "bidCount": 99})["bidCount"] == 99


def test_auction_history_defaults_on_empty_context() -> None:
    assert get_auction_history({}) == {
        "history": [],
        "recentBids": [],
        "bidCount": 0,
        "participantCount": 0,
        "extendCount": 0,
    }


# --------------------------------------------------------------------------- #
# get_recent_danmaku
# --------------------------------------------------------------------------- #
def test_recent_danmaku_slices_but_counts_all() -> None:
    messages = [f"m{i}" for i in range(12)]
    result = get_recent_danmaku({"recentDanmaku": messages})
    assert result["messages"] == messages[:10]
    assert len(result["messages"]) == 10
    assert result["count"] == 12


def test_recent_danmaku_defaults() -> None:
    assert get_recent_danmaku({}) == {"messages": [], "count": 0}


# --------------------------------------------------------------------------- #
# get_inventory_status
# --------------------------------------------------------------------------- #
def test_inventory_status_exact_and_sorted() -> None:
    items = [
        {"id": "a", "name": "out1", "stock": 0, "queueStatus": "SOLD"},
        {"id": "b", "name": "low3", "stock": 3},
        {"id": "c", "name": "low1", "stock": 1},
        {"id": "d", "name": "high", "stock": 10},
        {"id": "e", "name": "neg", "stock": -4},
    ]
    result = get_inventory_status({"inventory": items})
    assert result["totalProducts"] == 5
    assert result["totalStock"] == 0 + 3 + 1 + 10 + 0
    assert result["outOfStockCount"] == 2  # stock 0 and negative-clamped-to-0
    assert result["lowStockCount"] == 2  # stock 1 and 3
    assert result["lowStockThreshold"] == 3
    names = [item["name"] for item in result["attentionItems"]]
    assert names == ["neg", "out1", "low1", "low3"]


def test_inventory_status_attention_capped_at_ten() -> None:
    items = [{"name": f"n{i}", "stock": 0} for i in range(15)]
    result = get_inventory_status({"inventory": items})
    assert len(result["attentionItems"]) == 10


# --------------------------------------------------------------------------- #
# generate_host_script
# --------------------------------------------------------------------------- #
def test_host_script_full() -> None:
    ctx = {
        "liveRoom": {"hostName": "小雅"},
        "product": {"name": "翡翠", "startPrice": 100},
        "auction": {"currentPrice": 200, "incrementStep": 20, "status": "ACTIVE", "ceilingPrice": 500},
        "participantCount": 12,
    }
    assert generate_host_script(ctx) == {
        "hostName": "小雅",
        "productName": "翡翠",
        "currentPrice": 200,
        "nextBid": 220.0,
        "status": "ACTIVE",
        "ceilingPrice": 500,
        "participantCount": 12,
    }


def test_host_script_defaults() -> None:
    assert generate_host_script({}) == {
        "hostName": "主播",
        "productName": "",
        "currentPrice": None,
        "nextBid": 0.0,
        "status": "PENDING",
        "ceilingPrice": None,
        "participantCount": 0,
    }


# --------------------------------------------------------------------------- #
# analyze_live_performance
# --------------------------------------------------------------------------- #
def test_live_performance_exact() -> None:
    ctx = {
        "history": [
            {"status": "SOLD", "bidCount": 5, "participantCount": 3},
            {"status": "UNSOLD", "bidCount": 2, "participantCount": 2},
            {"status": "CANCELLED", "bidCount": 0, "participantCount": 1},
            {"status": "ACTIVE", "bidCount": 1, "participantCount": 4},
        ],
        "orders": [{"status": "PAID", "finalPrice": 500}, {"status": "PENDING_PAYMENT", "finalPrice": 200}],
        "recentDanmaku": ["a", "b"],
    }
    result = analyze_live_performance(ctx)
    assert result["roundCount"] == 4
    assert result["completedRoundCount"] == 3
    assert result["soldRoundCount"] == 1
    assert result["sellThroughRate"] == round(1 / 3, 4)
    assert result["bidCount"] == 8
    assert result["maxParticipantCount"] == 4
    assert result["paidRevenue"] == 500
    assert result["pendingPaymentCount"] == 1
    assert result["recentDanmakuCount"] == 2


def test_live_performance_empty_uses_zero_sell_through() -> None:
    result = analyze_live_performance({})
    assert result["sellThroughRate"] == 0
    assert result["maxParticipantCount"] == 0


# --------------------------------------------------------------------------- #
# get_order_overview / get_after_sales_context
# --------------------------------------------------------------------------- #
def test_order_overview_exact_with_recent_slice() -> None:
    orders = [{"status": "PAID", "finalPrice": 10} for _ in range(12)]
    orders += [{"status": "PENDING_PAYMENT", "finalPrice": 5}]
    result = get_order_overview({"orders": orders})
    assert result["totalOrders"] == 13
    assert result["paidCount"] == 12
    assert result["pendingPaymentCount"] == 1
    assert result["paidRevenue"] == 120
    assert result["pendingAmount"] == 5
    assert len(result["recentOrders"]) == 10


def test_after_sales_suggests_both_when_orders_present() -> None:
    ctx = {"orders": [{"status": "PAID", "finalPrice": 320}, {"status": "PENDING_PAYMENT", "finalPrice": 180}]}
    result = get_after_sales_context(ctx)
    assert result == {
        "caseDataAvailable": False,
        "pendingPaymentCount": 1,
        "paidCount": 1,
        "suggestions": [
            "待支付订单先核对支付状态和超时规则，避免重复催付",
            "已支付订单可先核对订单号、商品和成交金额，再进入人工售后流程",
        ],
        "boundary": "当前系统未接入退款、退货或物流工单，Agent 只提供处理建议",
    }


def test_after_sales_suggestion_when_no_orders() -> None:
    result = get_after_sales_context({"orders": []})
    assert result["suggestions"] == ["当前没有可供分析的订单，请先确认订单号和买家身份"]


# --------------------------------------------------------------------------- #
# registry helpers
# --------------------------------------------------------------------------- #
def test_list_tools_matches_registry() -> None:
    assert list_tools() == [{"name": tool.name, "description": tool.description} for tool in TOOLS.values()]


def test_openai_tool_schemas_shape() -> None:
    schemas = openai_tool_schemas()
    assert len(schemas) == len(TOOLS)
    assert {s["function"]["name"] for s in schemas} == set(TOOLS)
    for schema in schemas:
        assert schema["type"] == "function"
        function = schema["function"]
        assert function["description"] == TOOLS[function["name"]].description
        params = function["parameters"]
        assert params["type"] == "object"
        assert params["required"] == []
        assert params["properties"]["focus"]["type"] == "string"
        assert params["properties"]["focus"]["description"]


def test_run_single_tool_known_unknown_and_raising(monkeypatch: pytest.MonkeyPatch) -> None:
    ctx = {"orders": [{"status": "PAID", "finalPrice": 1}]}
    assert run_single_tool("get_order_overview", ctx) == get_order_overview(ctx)
    assert run_single_tool("does_not_exist", ctx) == {"ok": False, "error": "unknown tool: does_not_exist"}

    def boom(_context: dict) -> dict:
        raise RuntimeError("boom!")

    monkeypatch.setitem(TOOLS, "boom", Tool("boom", "d", boom))
    assert run_single_tool("boom", {}) == {"ok": False, "error": "boom!"}


def test_run_tool_plan_known_unknown_and_tool_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    outputs, used = run_tool_plan("order-query", {"orders": []})
    assert used == ["get_order_overview"]
    assert "get_order_overview" in outputs

    _, chat_used = run_tool_plan("totally-unknown-task", {})
    assert chat_used == TASK_PLANS["chat"]

    def boom(_context: dict) -> dict:
        raise RuntimeError("kaboom")

    monkeypatch.setitem(TOOLS, "boom", Tool("boom", "d", boom))
    monkeypatch.setitem(TASK_PLANS, "boom-task", ["boom"])
    outputs, used = run_tool_plan("boom-task", {})
    assert used == ["boom"]
    assert outputs["boom"] == {"ok": False, "error": "kaboom"}


# --------------------------------------------------------------------------- #
# _number spot checks (complement the property test with exact expectations)
# --------------------------------------------------------------------------- #
def test_number_exact_cases() -> None:
    assert _number(5) == 5.0
    assert _number(0) == 0.0
    assert _number(None) == 0.0
    assert _number("nope") == 0.0
    assert _number(tools) == 0.0
