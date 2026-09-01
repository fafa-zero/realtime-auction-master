import json
from typing import Any

from .agent import run_agent
from .knowledge import KnowledgeHit, retrieve
from .memory import conversation_memory, format_turns
from .schemas import AgentRunRequest, ChatRequest, ChatResponse
from .tools import run_tool_plan


def detect_intent(message: str) -> str:
    text = message.lower()
    if any(word in text for word in ("售后", "退款", "退货", "换货", "物流", "投诉")):
        return "after-sales"
    if any(word in text for word in ("库存", "补货", "缺货", "低库存")):
        return "inventory-alert"
    if any(word in text for word in ("订单", "待支付", "已支付", "gmv", "成交额")):
        return "order-query"
    if any(word in text for word in ("直播复盘", "整场复盘", "全场复盘", "运营复盘", "直播表现")):
        return "live-review"
    if any(word in text for word in ("风险", "异常", "可疑", "风控")):
        return "bid-risk"
    if any(word in text for word in ("话术", "怎么说", "主播", "促成交")):
        return "host-cue"
    if any(word in text for word in ("复盘", "总结", "数据", "表现", "成交")):
        return "auction-summary"
    if any(word in text for word in ("商品", "卖点", "介绍", "讲解")):
        return "product-script"
    return "chat"


def _fallback_content(intent: str, context: dict[str, Any], hits: list[KnowledgeHit]) -> str:
    tool_results, _ = run_tool_plan(intent, context)
    if intent == "bid-risk":
        analysis = tool_results.get("analyze_bid_risk", {})
        level = analysis.get("level", "LOW")
        reasons = analysis.get("reasons") or ["当前未发现明显异常"]
        return f"风险等级：{level}。{'；'.join(str(reason) for reason in reasons)}。"
    if intent == "host-cue":
        brief = tool_results.get("generate_host_script", {})
        return f"{brief.get('hostName', '主播')}可以这样说：当前最高价 {brief.get('currentPrice', 0)} 元，下一口 {brief.get('nextBid', 0)} 元起，欢迎理性参与。"
    if intent == "product-script":
        product = tool_results.get("get_product_info", {})
        return f"{product.get('name', '当前商品')}：{product.get('description', '欢迎查看商品详情后理性参与竞拍。')}"
    if intent == "auction-summary":
        history = tool_results.get("get_auction_history", {})
        return f"当前竞拍共有 {history.get('participantCount', 0)} 位参与者，累计 {history.get('bidCount', 0)} 次出价。"
    if intent == "inventory-alert":
        inventory = tool_results.get("get_inventory_status", {})
        attention = inventory.get("attentionItems") or []
        names = "、".join(str(item.get("name", "未命名商品")) for item in attention[:5])
        detail = f"需关注：{names}。" if names else "当前无低库存商品。"
        return (
            f"库存巡检：共 {inventory.get('totalProducts', 0)} 件商品，"
            f"缺货 {inventory.get('outOfStockCount', 0)} 件，"
            f"低库存 {inventory.get('lowStockCount', 0)} 件。{detail}"
        )
    if intent == "order-query":
        orders = tool_results.get("get_order_overview", {})
        return (
            f"订单概况：共 {orders.get('totalOrders', 0)} 笔，"
            f"已支付 {orders.get('paidCount', 0)} 笔，"
            f"待支付 {orders.get('pendingPaymentCount', 0)} 笔，"
            f"已支付成交额 {orders.get('paidRevenue', 0)} 元。"
        )
    if intent == "after-sales":
        service = tool_results.get("get_after_sales_context", {})
        suggestions = service.get("suggestions") or []
        return f"{service.get('boundary', '当前只提供售后处理建议')}。{' 。'.join(str(item) for item in suggestions)}。"
    if intent == "live-review":
        performance = tool_results.get("analyze_live_performance", {})
        rate = round(float(performance.get("sellThroughRate", 0)) * 100)
        return (
            f"直播复盘：已完成 {performance.get('completedRoundCount', 0)} 轮，"
            f"成交 {performance.get('soldRoundCount', 0)} 轮，成交率 {rate}%，"
            f"累计出价 {performance.get('bidCount', 0)} 次，"
            f"已支付成交额 {performance.get('paidRevenue', 0)} 元。"
        )
    return hits[0].content if hits else "已读取当前竞拍状态，请继续描述你想了解的内容。"


async def run_chat(request: ChatRequest) -> ChatResponse:
    intent = detect_intent(request.message)
    room_key = request.live_room_id or "global"
    key = f"{request.user_id}:{room_key}:{request.session_id}"
    previous_turns = await conversation_memory.aget(key)
    hits = retrieve(request.message)
    tool_results, tools_used = run_tool_plan(intent, request.context)
    knowledge_text = "\n".join(f"[{hit.title}] {hit.content}" for hit in hits)
    history_text = format_turns(previous_turns)
    user_prompt = (
        f"用户问题：{request.message}\n"
        f"用户角色：{request.user_role}\n"
        f"最近对话：{history_text or '无'}\n"
        f"业务知识：{knowledge_text}\n"
        f"工具结果：{json.dumps(tool_results, ensure_ascii=False, separators=(',', ':'))}"
    )
    fallback = _fallback_content(intent, request.context, hits)
    result = await run_agent(
        AgentRunRequest(
            task=intent,
            title="Agent 运营工作台",
            system_prompt=(
                "你是直播电商运营 Agent。先依据工具结果和业务知识回答，保持客观、简洁、合规；"
                "不要替用户出价、支付或修改订单，不确定时明确说明需要以系统状态为准。"
            ),
            user_prompt=user_prompt,
            fallback_content=fallback,
            policy_text=request.message,
            context=request.context,
        )
    )
    await conversation_memory.aappend(key, "user", request.message)
    await conversation_memory.aappend(key, "assistant", result.content)
    response_data = result.model_dump() if hasattr(result, "model_dump") else result.dict()
    response_data.update(
        {
            "sessionId": request.session_id,
            "intent": intent,
            "citations": [hit.as_dict() for hit in hits],
            "historySize": await conversation_memory.asize(key),
            "toolsUsed": tools_used,
            "toolResults": tool_results,
        }
    )
    return ChatResponse(**response_data)
