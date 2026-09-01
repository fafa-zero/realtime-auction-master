import json
from typing import Any

from .agent import run_agent
from .knowledge import KnowledgeHit, retrieve
from .memory import conversation_memory, format_turns
from .schemas import AgentRunRequest, ChatRequest, ChatResponse
from .tools import run_tool_plan


def detect_intent(message: str) -> str:
    text = message.lower()
    if any(word in text for word in ("风险", "异常", "可疑", "出价", "封顶")):
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
            title="AI 竞拍助手",
            system_prompt=(
                "你是直播电商竞拍助手。先依据工具结果和业务知识回答，保持客观、简洁、合规；"
                "不要替用户出价、支付或修改订单，不确定时明确说明需要以系统状态为准。"
            ),
            user_prompt=user_prompt,
            fallback_content=fallback,
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
