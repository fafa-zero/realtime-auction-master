"""Small, deterministic tools used by the auction Agent.

Tools intentionally consume a request-scoped context supplied by Node. They do
not read the Node JSON store directly, so there is one owner for auction state.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

ToolHandler = Callable[[dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    handler: ToolHandler


def _product(context: dict[str, Any]) -> dict[str, Any]:
    product = context.get("product")
    return product if isinstance(product, dict) else {}


def _auction(context: dict[str, Any]) -> dict[str, Any]:
    auction = context.get("auction")
    return auction if isinstance(auction, dict) else {}


def _live_room(context: dict[str, Any]) -> dict[str, Any]:
    live_room = context.get("liveRoom")
    return live_room if isinstance(live_room, dict) else {}


def get_live_room_snapshot(context: dict[str, Any]) -> dict[str, Any]:
    """Return the current room and auction state needed by an Agent task."""
    snapshot = context.get("snapshot")
    if isinstance(snapshot, dict):
        return snapshot
    return {
        "liveRoom": context.get("liveRoom", {}),
        "auction": _auction(context),
        "participantCount": context.get("participantCount", 0),
        "serverTime": context.get("serverTime"),
    }


def get_product_info(context: dict[str, Any]) -> dict[str, Any]:
    product = _product(context)
    return {
        "id": product.get("id"),
        "name": product.get("name", ""),
        "description": product.get("description", ""),
        "sellingPoints": product.get("sellingPoints"),
        "scriptKeywords": product.get("scriptKeywords"),
        "stock": product.get("stock"),
        "startPrice": product.get("startPrice", _auction(context).get("startPrice")),
        "incrementStep": product.get("incrementStep", _auction(context).get("incrementStep")),
        "ceilingPrice": product.get("ceilingPrice", _auction(context).get("ceilingPrice")),
        "durationSeconds": product.get("durationSeconds", _auction(context).get("durationSeconds")),
    }


def get_auction_history(context: dict[str, Any]) -> dict[str, Any]:
    history = context.get("history")
    if not isinstance(history, list):
        history = []
    bids = context.get("bids")
    if not isinstance(bids, list):
        bids = []
    return {
        "history": history[:20],
        "recentBids": bids[:30],
        "bidCount": context.get("bidCount", len(bids)),
        "participantCount": context.get("participantCount", 0),
        "extendCount": _auction(context).get("extendCount", 0),
    }


def get_recent_danmaku(context: dict[str, Any]) -> dict[str, Any]:
    messages = context.get("recentDanmaku")
    if not isinstance(messages, list):
        messages = []
    return {"messages": messages[:10], "count": len(messages)}


def get_inventory_status(context: dict[str, Any]) -> dict[str, Any]:
    """Summarize room inventory without mutating product stock."""
    inventory = context.get("inventory")
    items = inventory if isinstance(inventory, list) else []
    normalized: list[dict[str, Any]] = []

    for item in items:
        if not isinstance(item, dict):
            continue
        stock = max(int(_number(item.get("stock"))), 0)
        normalized.append(
            {
                "id": item.get("id"),
                "name": item.get("name", "未命名商品"),
                "stock": stock,
                "queueStatus": item.get("queueStatus", "QUEUED"),
            }
        )

    out_of_stock = [item for item in normalized if item["stock"] == 0]
    low_stock = [item for item in normalized if 0 < item["stock"] <= 3]
    attention_items = sorted(
        [*out_of_stock, *low_stock], key=lambda item: (item["stock"], str(item["name"]))
    )
    return {
        "totalProducts": len(normalized),
        "totalStock": sum(item["stock"] for item in normalized),
        "outOfStockCount": len(out_of_stock),
        "lowStockCount": len(low_stock),
        "lowStockThreshold": 3,
        "attentionItems": attention_items[:10],
    }


def get_order_overview(context: dict[str, Any]) -> dict[str, Any]:
    """Return an aggregate and a bounded recent-order list for the current user scope."""
    orders = context.get("orders")
    items = [item for item in orders if isinstance(item, dict)] if isinstance(orders, list) else []
    paid = [item for item in items if item.get("status") == "PAID"]
    pending = [item for item in items if item.get("status") == "PENDING_PAYMENT"]
    return {
        "totalOrders": len(items),
        "paidCount": len(paid),
        "pendingPaymentCount": len(pending),
        "paidRevenue": sum(_number(item.get("finalPrice")) for item in paid),
        "pendingAmount": sum(_number(item.get("finalPrice")) for item in pending),
        "recentOrders": items[:10],
    }


def get_after_sales_context(context: dict[str, Any]) -> dict[str, Any]:
    """Provide read-only service guidance from order state; no refund workflow is implied."""
    overview = get_order_overview(context)
    suggestions: list[str] = []
    if overview["pendingPaymentCount"]:
        suggestions.append("待支付订单先核对支付状态和超时规则，避免重复催付")
    if overview["paidCount"]:
        suggestions.append("已支付订单可先核对订单号、商品和成交金额，再进入人工售后流程")
    if not suggestions:
        suggestions.append("当前没有可供分析的订单，请先确认订单号和买家身份")
    return {
        "caseDataAvailable": False,
        "pendingPaymentCount": overview["pendingPaymentCount"],
        "paidCount": overview["paidCount"],
        "suggestions": suggestions,
        "boundary": "当前系统未接入退款、退货或物流工单，Agent 只提供处理建议",
    }


def analyze_live_performance(context: dict[str, Any]) -> dict[str, Any]:
    """Aggregate auction history, orders and interaction signals for room review."""
    history = context.get("history")
    rounds = [item for item in history if isinstance(item, dict)] if isinstance(history, list) else []
    completed = [
        item for item in rounds if item.get("status") in {"SOLD", "UNSOLD", "CANCELLED"}
    ]
    sold = [item for item in completed if item.get("status") == "SOLD"]
    order_overview = get_order_overview(context)
    danmaku = context.get("recentDanmaku")
    recent_danmaku = danmaku if isinstance(danmaku, list) else []
    return {
        "roundCount": len(rounds),
        "completedRoundCount": len(completed),
        "soldRoundCount": len(sold),
        "sellThroughRate": round(len(sold) / len(completed), 4) if completed else 0,
        "bidCount": sum(int(_number(item.get("bidCount"))) for item in rounds),
        "maxParticipantCount": max(
            (int(_number(item.get("participantCount"))) for item in rounds), default=0
        ),
        "paidRevenue": order_overview["paidRevenue"],
        "pendingPaymentCount": order_overview["pendingPaymentCount"],
        "recentDanmakuCount": len(recent_danmaku),
    }


def analyze_bid_risk(context: dict[str, Any]) -> dict[str, Any]:
    """Apply explainable risk rules before asking a model for wording."""
    auction = _auction(context)
    risk_input = context.get("bidRisk")
    risk_input = risk_input if isinstance(risk_input, dict) else {}
    current_price = _number(risk_input.get("currentPrice", auction.get("currentPrice")))
    price = _number(risk_input.get("price"))
    increment_step = max(_number(risk_input.get("incrementStep", auction.get("incrementStep"))), 1)
    recent_bid_count = int(_number(risk_input.get("recentBidCount")))
    reaches_ceiling = bool(risk_input.get("reachesCeiling", price >= _number(auction.get("ceilingPrice"))))
    jump_amount = price - current_price
    large_jump = jump_amount >= increment_step * 5
    high_frequency = recent_bid_count >= 3

    reasons: list[str] = []
    if reaches_ceiling:
        reasons.append("本次出价达到封顶价，会立即触发成交")
    if high_frequency:
        reasons.append("该用户 30 秒内出价次数较多")
    if large_jump:
        reasons.append("本次加价幅度明显高于最低加价要求")

    level = "MEDIUM" if reasons else "LOW"
    action = "REVIEW" if reasons else "ALLOW"
    return {
        "level": level,
        "action": action,
        "reasons": reasons,
        "currentPrice": current_price,
        "price": price,
        "jumpAmount": jump_amount,
        "recentBidCount": recent_bid_count,
        "reachesCeiling": reaches_ceiling,
    }


def generate_host_script(context: dict[str, Any]) -> dict[str, Any]:
    """Prepare a compact, non-promotional script brief for the language model."""
    auction = _auction(context)
    product = get_product_info(context)
    return {
        "hostName": _live_room(context).get("hostName", "主播"),
        "productName": product.get("name", "当前商品"),
        "currentPrice": auction.get("currentPrice", product.get("startPrice", 0)),
        "nextBid": _number(auction.get("currentPrice")) + _number(auction.get("incrementStep")),
        "status": auction.get("status", "PENDING"),
        "ceilingPrice": auction.get("ceilingPrice"),
        "participantCount": context.get("participantCount", 0),
    }


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


TOOLS: dict[str, Tool] = {
    "get_live_room_snapshot": Tool(
        "get_live_room_snapshot", "读取直播间和当前竞拍快照", get_live_room_snapshot
    ),
    "get_product_info": Tool("get_product_info", "读取商品和竞拍定价信息", get_product_info),
    "get_auction_history": Tool("get_auction_history", "读取竞拍历史、出价和参与人数", get_auction_history),
    "get_recent_danmaku": Tool("get_recent_danmaku", "读取最近弹幕互动", get_recent_danmaku),
    "analyze_bid_risk": Tool("analyze_bid_risk", "使用可解释规则分析异常出价", analyze_bid_risk),
    "generate_host_script": Tool("generate_host_script", "整理主播话术所需的结构化简报", generate_host_script),
    "get_inventory_status": Tool("get_inventory_status", "检查直播间库存与低库存商品", get_inventory_status),
    "get_order_overview": Tool("get_order_overview", "汇总当前权限范围内的订单和支付状态", get_order_overview),
    "get_after_sales_context": Tool("get_after_sales_context", "根据订单状态生成售后处理建议", get_after_sales_context),
    "analyze_live_performance": Tool("analyze_live_performance", "汇总场次、成交、收入与互动指标", analyze_live_performance),
}


TASK_PLANS: dict[str, list[str]] = {
    "product-script": ["get_product_info", "get_live_room_snapshot"],
    "auction-summary": ["get_live_room_snapshot", "get_product_info", "get_auction_history"],
    "host-cue": ["get_live_room_snapshot", "get_product_info", "get_recent_danmaku", "generate_host_script"],
    "bid-risk": ["get_live_room_snapshot", "analyze_bid_risk"],
    "inventory-alert": ["get_live_room_snapshot", "get_inventory_status"],
    "order-query": ["get_order_overview"],
    "after-sales": ["get_order_overview", "get_after_sales_context"],
    "live-review": [
        "get_live_room_snapshot",
        "get_auction_history",
        "get_order_overview",
        "analyze_live_performance",
    ],
    "chat": ["get_live_room_snapshot", "get_product_info"],
}


def list_tools() -> list[dict[str, str]]:
    return [{"name": tool.name, "description": tool.description} for tool in TOOLS.values()]


def openai_tool_schemas() -> list[dict[str, Any]]:
    """Expose the registry as OpenAI-compatible function schemas.

    Every tool reads only from the server-supplied, read-only context, so the
    model just picks which tool to run. An optional ``focus`` hint is accepted
    for the model's convenience but never used to fetch or mutate anything the
    caller was not already authorized to see.
    """
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "focus": {
                            "type": "string",
                            "description": "可选关注点，仅作说明，不影响只读数据的获取范围",
                        }
                    },
                    "required": [],
                },
            },
        }
        for tool in TOOLS.values()
    ]


def run_single_tool(name: str, context: dict[str, Any]) -> dict[str, Any]:
    """Execute one registered tool by name against the read-only context."""
    tool = TOOLS.get(name)
    if tool is None:
        return {"ok": False, "error": f"unknown tool: {name}"}
    try:
        return tool.handler(context)
    except Exception as exc:  # Tools are advisory; a failure must not break the loop.
        return {"ok": False, "error": str(exc)}


def run_tool_plan(task: str, context: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Execute the bounded plan for a task and retain only serializable results."""
    plan = TASK_PLANS.get(task, TASK_PLANS["chat"])
    outputs: dict[str, Any] = {}
    used: list[str] = []
    for name in plan:
        tool = TOOLS[name]
        try:
            outputs[name] = tool.handler(context)
        except Exception as exc:  # Tools are advisory; one failure must not block fallback output.
            outputs[name] = {"ok": False, "error": str(exc)}
        used.append(name)
    return outputs, used
