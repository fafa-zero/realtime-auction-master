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
