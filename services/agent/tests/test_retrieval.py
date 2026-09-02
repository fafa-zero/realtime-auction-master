"""Tests for embedding backends and semantic / hybrid retrieval."""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from services.agent.app import embeddings, knowledge
from services.agent.app.embeddings import HashingEmbedder, ProviderEmbedder, get_embedder
from services.agent.app.knowledge import (
    retrieve,
    retrieve_hybrid,
    retrieve_semantic,
    select_retriever,
)


@pytest.fixture(autouse=True)
def _reset_embedder_state(monkeypatch: pytest.MonkeyPatch) -> None:
    get_embedder.cache_clear()
    knowledge._matrix_cache.clear()
    for name in ("AGENT_EMBEDDINGS", "AGENT_RETRIEVAL", "AGENT_EMBEDDING_MODEL", "AI_API_KEY", "USTC_LLM_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    yield
    get_embedder.cache_clear()
    knowledge._matrix_cache.clear()


# --------------------------------------------------------------------------- #
# HashingEmbedder
# --------------------------------------------------------------------------- #
def test_hashing_embedder_is_deterministic_and_normalized() -> None:
    embedder = HashingEmbedder(dim=64)
    first = embedder.embed(["竞拍 出价 规则"])
    second = embedder.embed(["竞拍 出价 规则"])
    assert first.shape == (1, 64)
    np.testing.assert_allclose(first, second)
    np.testing.assert_allclose(np.linalg.norm(first, axis=1), [1.0])


def test_hashing_embedder_handles_empty_text() -> None:
    vector = HashingEmbedder(dim=32).embed([""])
    assert vector.shape == (1, 32)
    assert np.linalg.norm(vector) == pytest.approx(0.0)  # empty -> zero vector, no NaN


def test_hashing_similarity_reflects_overlap() -> None:
    embedder = HashingEmbedder(dim=512)
    matrix = embedder.embed(["竞拍 出价 封顶 成交", "竞拍 出价 封顶", "库存 补货 缺货"])
    close = float(matrix[0] @ matrix[1])
    far = float(matrix[0] @ matrix[2])
    assert close > far


# --------------------------------------------------------------------------- #
# semantic / hybrid retrieval
# --------------------------------------------------------------------------- #
def test_retrieve_semantic_ranks_relevant_document_first() -> None:
    hits = retrieve_semantic("库存 补货 缺货 低库存", top_k=3)
    assert hits[0].id == "inventory-operations"
    assert len(hits) == 3


def test_retrieve_semantic_is_bounded() -> None:
    assert len(retrieve_semantic("竞拍", top_k=2)) == 2


def test_retrieve_hybrid_keeps_lexical_winner_on_top() -> None:
    hits = retrieve_hybrid("当前竞拍有什么规则？", top_k=3)
    assert hits[0].id == "auction-rules"


def test_retrieve_hybrid_falls_back_to_lexical_when_embedding_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    class BrokenEmbedder:
        name = "broken"

        def embed(self, texts: list[str]) -> np.ndarray:
            raise RuntimeError("no embeddings here")

    hits = retrieve_hybrid("竞拍规则", top_k=2, embedder=BrokenEmbedder())
    # lexical fallback still returns the rules document for a rules query
    assert hits[0].id == "auction-rules"


# --------------------------------------------------------------------------- #
# select_retriever
# --------------------------------------------------------------------------- #
def test_select_retriever_respects_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_RETRIEVAL", "lexical")
    assert select_retriever() is retrieve
    monkeypatch.setenv("AGENT_RETRIEVAL", "semantic")
    assert select_retriever() is retrieve_semantic
    monkeypatch.setenv("AGENT_RETRIEVAL", "hybrid")
    assert select_retriever() is retrieve_hybrid
    monkeypatch.delenv("AGENT_RETRIEVAL", raising=False)
    assert select_retriever() is retrieve_hybrid  # default


# --------------------------------------------------------------------------- #
# get_embedder / ProviderEmbedder
# --------------------------------------------------------------------------- #
def test_get_embedder_defaults_to_hashing() -> None:
    assert isinstance(get_embedder(), HashingEmbedder)


def test_get_embedder_uses_provider_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_EMBEDDINGS", "provider")
    monkeypatch.setenv("AI_API_KEY", "key-123")
    monkeypatch.setenv("AI_API_URL", "https://model.test/v1/chat/completions")
    embedder = get_embedder()
    assert isinstance(embedder, ProviderEmbedder)
    assert embedder.base_url == "https://model.test/v1"


def test_get_embedder_provider_without_key_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_EMBEDDINGS", "provider")
    assert isinstance(get_embedder(), HashingEmbedder)


def test_provider_embedder_parses_and_normalizes(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return {"data": [{"index": 1, "embedding": [0.0, 3.0]}, {"index": 0, "embedding": [4.0, 0.0]}]}

    def fake_post(url: str, **kwargs: Any) -> FakeResponse:
        assert url.endswith("/embeddings")
        return FakeResponse()

    monkeypatch.setattr(embeddings.httpx, "post", fake_post)
    vectors = ProviderEmbedder("k", "https://model.test/v1", "emb").embed(["a", "b"])
    # results are reordered by index and L2-normalized
    np.testing.assert_allclose(vectors[0], [1.0, 0.0])
    np.testing.assert_allclose(vectors[1], [0.0, 1.0])


def test_document_matrix_is_cached_per_embedder() -> None:
    embedder = HashingEmbedder(dim=32)
    first = knowledge._document_matrix(embedder)
    second = knowledge._document_matrix(embedder)
    assert first is second  # cached, not recomputed
