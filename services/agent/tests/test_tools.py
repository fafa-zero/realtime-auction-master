from services.agent.app.tools import run_tool_plan


def test_host_cue_plan_uses_realtime_context_tools():
    outputs, used = run_tool_plan(
        "host-cue",
        {
            "liveRoom": {"hostName": "小雅"},
            "product": {"name": "翡翠吊坠", "startPrice": 100},
            "auction": {"currentPrice": 200, "incrementStep": 20, "status": "ACTIVE"},
            "recentDanmaku": ["想看细节"],
            "participantCount": 12,
        },
    )

    assert used == [
        "get_live_room_snapshot",
        "get_product_info",
        "get_recent_danmaku",
        "generate_host_script",
    ]
    assert outputs["generate_host_script"]["nextBid"] == 220
    assert outputs["get_recent_danmaku"]["count"] == 1


def test_bid_risk_plan_defaults_to_allow_for_normal_bid():
    outputs, used = run_tool_plan(
        "bid-risk",
        {
            "auction": {"currentPrice": 100, "incrementStep": 10, "ceilingPrice": 500},
            "bidRisk": {"price": 110, "recentBidCount": 1},
        },
    )

    assert used == ["get_live_room_snapshot", "analyze_bid_risk"]
    assert outputs["analyze_bid_risk"]["level"] == "LOW"
    assert outputs["analyze_bid_risk"]["action"] == "ALLOW"


def test_inventory_alert_finds_out_of_stock_and_low_stock_products():
    outputs, used = run_tool_plan(
        "inventory-alert",
        {
            "inventory": [
                {"id": "p-1", "name": "翡翠", "stock": 0, "queueStatus": "SOLD"},
                {"id": "p-2", "name": "手表", "stock": 2, "queueStatus": "QUEUED"},
                {"id": "p-3", "name": "耳饰", "stock": 8, "queueStatus": "QUEUED"},
            ]
        },
    )

    assert used == ["get_live_room_snapshot", "get_inventory_status"]
    status = outputs["get_inventory_status"]
    assert status["totalProducts"] == 3
    assert status["outOfStockCount"] == 1
    assert status["lowStockCount"] == 1
    assert [item["name"] for item in status["attentionItems"]] == ["翡翠", "手表"]


def test_order_and_after_sales_tools_keep_advice_read_only():
    context = {
        "orders": [
            {"id": "o-1", "status": "PAID", "finalPrice": 320},
            {"id": "o-2", "status": "PENDING_PAYMENT", "finalPrice": 180},
        ]
    }
    order_outputs, order_used = run_tool_plan("order-query", context)
    service_outputs, service_used = run_tool_plan("after-sales", context)

    assert order_used == ["get_order_overview"]
    assert order_outputs["get_order_overview"]["paidRevenue"] == 320
    assert order_outputs["get_order_overview"]["pendingPaymentCount"] == 1
    assert service_used == ["get_order_overview", "get_after_sales_context"]
    assert service_outputs["get_after_sales_context"]["caseDataAvailable"] is False
    assert "未接入退款" in service_outputs["get_after_sales_context"]["boundary"]


def test_live_review_aggregates_rounds_orders_and_interactions():
    outputs, used = run_tool_plan(
        "live-review",
        {
            "history": [
                {"status": "SOLD", "bidCount": 6, "participantCount": 4},
                {"status": "UNSOLD", "bidCount": 2, "participantCount": 2},
            ],
            "orders": [
                {"status": "PAID", "finalPrice": 500},
                {"status": "PENDING_PAYMENT", "finalPrice": 200},
            ],
            "recentDanmaku": ["想看细节", "什么材质"],
        },
    )

    assert used == [
        "get_live_room_snapshot",
        "get_auction_history",
        "get_order_overview",
        "analyze_live_performance",
    ]
    performance = outputs["analyze_live_performance"]
    assert performance["sellThroughRate"] == 0.5
    assert performance["bidCount"] == 8
    assert performance["paidRevenue"] == 500
    assert performance["recentDanmakuCount"] == 2
