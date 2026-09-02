"""Offline regression cases for routing, retrieval and deterministic tools.

The suite intentionally does not call a remote model. It can run in CI and in
interviews without an API key, while still checking the safety-critical Agent
boundary: intent selection, bounded tool plans and knowledge citations.
"""

import time
from typing import Any

from .knowledge import retrieve
from .orchestrator import detect_intent
from .tools import run_tool_plan

EVALUATION_CASES: tuple[dict[str, Any], ...] = (
    {
        "id": "rules-question",
        "message": "当前竞拍有什么规则？",
        "expectedIntent": "chat",
        "expectedTools": ["get_live_room_snapshot", "get_product_info"],
        "expectedCitation": "auction-rules",
        "context": {"auction": {"currentPrice": 200, "incrementStep": 20}},
    },
    {
        "id": "bid-risk-review",
        "message": "请分析这次异常出价风险",
        "expectedIntent": "bid-risk",
        "expectedTools": ["get_live_room_snapshot", "analyze_bid_risk"],
        "expectedCitation": "ai-compliance",
        "context": {
            "auction": {"currentPrice": 100, "incrementStep": 10, "ceilingPrice": 500},
            "bidRisk": {"price": 500, "recentBidCount": 3},
        },
    },
    {
        "id": "host-cue",
        "message": "给主播一句促成交话术",
        "expectedIntent": "host-cue",
        "expectedTools": [
            "get_live_room_snapshot",
            "get_product_info",
            "get_recent_danmaku",
            "generate_host_script",
        ],
        "expectedCitation": "ai-compliance",
        "context": {
            "liveRoom": {"hostName": "小雅"},
            "product": {"name": "翡翠吊坠", "startPrice": 100},
            "auction": {"currentPrice": 200, "incrementStep": 20},
            "recentDanmaku": ["想看细节"],
        },
    },
    {
        "id": "auction-summary",
        "message": "帮我总结本场成交表现和数据",
        "expectedIntent": "auction-summary",
        "expectedTools": ["get_live_room_snapshot", "get_product_info", "get_auction_history"],
        "expectedCitation": "auction-rules",
        "context": {
            "auction": {"currentPrice": 320, "incrementStep": 20, "status": "SOLD"},
            "bidCount": 8,
            "participantCount": 4,
            "bids": [{"price": 320}],
        },
    },
    {
        "id": "inventory-alert",
        "message": "检查低库存商品并给出补货建议",
        "expectedIntent": "inventory-alert",
        "expectedTools": ["get_live_room_snapshot", "get_inventory_status"],
        "expectedCitation": "inventory-operations",
        "context": {"inventory": [{"name": "翡翠", "stock": 1}]},
    },
    {
        "id": "order-query",
        "message": "查询直播间订单和待支付情况",
        "expectedIntent": "order-query",
        "expectedTools": ["get_order_overview"],
        "expectedCitation": "order-service-boundary",
        "context": {"orders": [{"status": "PENDING_PAYMENT", "finalPrice": 200}]},
    },
    {
        "id": "after-sales",
        "message": "请给出退款售后处理建议",
        "expectedIntent": "after-sales",
        "expectedTools": ["get_order_overview", "get_after_sales_context"],
        "expectedCitation": "order-service-boundary",
        "context": {"orders": [{"status": "PAID", "finalPrice": 320}]},
    },
    {
        "id": "live-review",
        "message": "做一次整场直播复盘和运营分析",
        "expectedIntent": "live-review",
        "expectedTools": [
            "get_live_room_snapshot",
            "get_auction_history",
            "get_order_overview",
            "analyze_live_performance",
        ],
        "expectedCitation": "live-review-metrics",
        "context": {
            "history": [{"status": "SOLD", "bidCount": 5, "participantCount": 3}],
            "orders": [{"status": "PAID", "finalPrice": 500}],
        },
    },
)


def evaluate_case(case: dict[str, Any]) -> dict[str, Any]:
    intent = detect_intent(str(case["message"]))
    _, tools_used = run_tool_plan(intent, case.get("context") or {})
    citations = retrieve(str(case["message"]))
    expected_citation = case.get("expectedCitation")
    checks = {
        "intent": intent == case["expectedIntent"],
        "tools": tools_used == case["expectedTools"],
        "citation": not expected_citation or any(hit.id == expected_citation for hit in citations),
    }
    return {
        "id": case["id"],
        "passed": all(checks.values()),
        "checks": checks,
        "expectedIntent": case["expectedIntent"],
        "actualIntent": intent,
        "expectedTools": case["expectedTools"],
        "actualTools": tools_used,
        "citationIds": [hit.id for hit in citations],
    }


def run_evaluation() -> dict[str, Any]:
    results = [evaluate_case(case) for case in EVALUATION_CASES]
    passed = sum(1 for result in results if result["passed"])
    total = len(results)
    return {
        "ok": passed == total,
        "suite": "agent-routing-and-tools",
        "version": "1",
        "passed": passed,
        "total": total,
        "score": round(passed / total, 4) if total else 1.0,
        "cases": results,
        "generatedAt": int(time.time() * 1000),
    }
