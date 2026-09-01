from dataclasses import dataclass
import re


@dataclass(frozen=True)
class KnowledgeDocument:
    id: str
    title: str
    content: str
    keywords: tuple[str, ...]


@dataclass(frozen=True)
class KnowledgeHit:
    id: str
    title: str
    content: str
    score: float

    def as_dict(self) -> dict[str, str | float]:
        return {"id": self.id, "title": self.title, "content": self.content, "score": self.score}


KNOWLEDGE_BASE = (
    KnowledgeDocument(
        id="auction-rules",
        title="竞拍规则",
        content="出价必须高于当前价并满足最低加价；达到封顶价会自动成交；竞拍结束后不能继续出价。",
        keywords=("竞拍", "出价", "当前价", "最低加价", "封顶", "成交", "规则"),
    ),
    KnowledgeDocument(
        id="auction-extension",
        title="竞拍延时",
        content="竞拍进入结束前的最后阶段时，有效出价可能触发自动延时，具体以当前竞拍快照的延时次数为准。",
        keywords=("延时", "倒计时", "结束", "最后", "时间"),
    ),
    KnowledgeDocument(
        id="host-permissions",
        title="主播权限",
        content="主播可以管理自己直播间的商品、竞拍和订单；买家只能提交自己的出价和支付自己的成交订单。",
        keywords=("主播", "权限", "订单", "买家", "支付", "管理"),
    ),
    KnowledgeDocument(
        id="ai-compliance",
        title="AI 话术规范",
        content="AI 话术应客观、简洁，不承诺保值或收益，不制造虚假紧迫感；风险提示只作为辅助判断。",
        keywords=("AI", "话术", "合规", "风险", "保值", "收益", "虚假"),
    ),
    KnowledgeDocument(
        id="inventory-operations",
        title="库存运营",
        content="库存预警用于识别缺货和低库存商品；补货和库存修改仍需运营人员确认。",
        keywords=("库存", "补货", "缺货", "低库存", "商品"),
    ),
    KnowledgeDocument(
        id="order-service-boundary",
        title="订单与售后边界",
        content="Agent 可以查询权限范围内的订单状态并给出售后建议，但不会自动支付、退款、退货或修改订单。",
        keywords=("订单", "待支付", "已支付", "售后", "退款", "退货", "物流"),
    ),
    KnowledgeDocument(
        id="live-review-metrics",
        title="直播复盘指标",
        content="直播复盘应结合成交率、出价次数、参与人数、已支付成交额、待支付订单和互动情况给出后续建议。",
        keywords=("直播复盘", "整场复盘", "成交率", "成交额", "互动", "运营"),
    ),
)


def retrieve(query: str, top_k: int = 3) -> list[KnowledgeHit]:
    """Lightweight lexical retrieval without adding a vector database dependency."""
    normalized = query.strip().lower()
    tokens = set(re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]", normalized))
    scored: list[KnowledgeHit] = []
    for document in KNOWLEDGE_BASE:
        keyword_hits = sum(1 for keyword in document.keywords if keyword.lower() in normalized)
        token_hits = sum(1 for token in tokens if token in document.content.lower())
        score = float(keyword_hits * 2 + token_hits)
        if score > 0:
            scored.append(KnowledgeHit(document.id, document.title, document.content, score))
    if not scored:
        general = KNOWLEDGE_BASE[0]
        scored.append(KnowledgeHit(general.id, general.title, general.content, 0.1))
    return sorted(scored, key=lambda item: item.score, reverse=True)[:top_k]
