import os
import re
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from .embeddings import Embedder, get_embedder

_TOKEN_RE = re.compile(r"[a-z0-9]+|[\u4e00-\u9fff]")


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


def _lexical_scores(query: str) -> dict[str, float]:
    normalized = query.strip().lower()
    tokens = set(_TOKEN_RE.findall(normalized))
    scores: dict[str, float] = {}
    for document in KNOWLEDGE_BASE:
        keyword_hits = sum(1 for keyword in document.keywords if keyword.lower() in normalized)
        token_hits = sum(1 for token in tokens if token in document.content.lower())
        score = float(keyword_hits * 2 + token_hits)
        if score > 0:
            scores[document.id] = score
    return scores


def retrieve(query: str, top_k: int = 3) -> list[KnowledgeHit]:
    """Lightweight lexical retrieval without adding a vector database dependency."""
    scores = _lexical_scores(query)
    scored = [
        KnowledgeHit(document.id, document.title, document.content, scores[document.id])
        for document in KNOWLEDGE_BASE
        if document.id in scores
    ]
    if not scored:
        general = KNOWLEDGE_BASE[0]
        scored.append(KnowledgeHit(general.id, general.title, general.content, 0.1))
    return sorted(scored, key=lambda item: item.score, reverse=True)[:top_k]


def _document_text(document: KnowledgeDocument) -> str:
    return f"{document.title} {document.content} {' '.join(document.keywords)}"


_matrix_cache: dict[str, np.ndarray] = {}


def _document_matrix(embedder: Embedder) -> np.ndarray:
    cached = _matrix_cache.get(embedder.name)
    if cached is None:
        cached = embedder.embed([_document_text(document) for document in KNOWLEDGE_BASE])
        _matrix_cache[embedder.name] = cached
    return cached


def retrieve_semantic(query: str, top_k: int = 3, embedder: Embedder | None = None) -> list[KnowledgeHit]:
    """Embedding-based retrieval using cosine similarity over document vectors."""
    embedder = embedder or get_embedder()
    try:
        doc_matrix = _document_matrix(embedder)
        query_vector = embedder.embed([query])[0]
    except Exception:  # embedding backend unavailable: never break retrieval
        return retrieve(query, top_k)
    similarities = doc_matrix @ query_vector
    order = np.argsort(-similarities)[:top_k]
    return [
        KnowledgeHit(
            KNOWLEDGE_BASE[i].id,
            KNOWLEDGE_BASE[i].title,
            KNOWLEDGE_BASE[i].content,
            round(float(similarities[i]), 4),
        )
        for i in order
    ]


def retrieve_hybrid(
    query: str, top_k: int = 3, alpha: float = 0.5, embedder: Embedder | None = None
) -> list[KnowledgeHit]:
    """Blend normalized lexical overlap with embedding cosine similarity."""
    embedder = embedder or get_embedder()
    lexical = _lexical_scores(query)
    max_lexical = max(lexical.values()) if lexical else 0.0
    try:
        doc_matrix = _document_matrix(embedder)
        query_vector = embedder.embed([query])[0]
    except Exception:  # embedding backend unavailable: fall back to lexical
        return retrieve(query, top_k)
    similarities = doc_matrix @ query_vector
    blended: list[KnowledgeHit] = []
    for i, document in enumerate(KNOWLEDGE_BASE):
        lexical_norm = (lexical.get(document.id, 0.0) / max_lexical) if max_lexical > 0 else 0.0
        semantic = max(0.0, float(similarities[i]))
        score = round(alpha * semantic + (1 - alpha) * lexical_norm, 4)
        blended.append(KnowledgeHit(document.id, document.title, document.content, score))
    return sorted(blended, key=lambda item: item.score, reverse=True)[:top_k]


def select_retriever() -> Callable[[str], list[KnowledgeHit]]:
    """Pick the retrieval strategy from ``AGENT_RETRIEVAL`` (hybrid|semantic|lexical)."""
    mode = os.getenv("AGENT_RETRIEVAL", "hybrid").strip().lower()
    if mode == "lexical":
        return retrieve
    if mode == "semantic":
        return retrieve_semantic
    return retrieve_hybrid
