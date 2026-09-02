"""Text embedding backends for semantic retrieval.

Two backends are provided:

* :class:`HashingEmbedder` — a dependency-light, fully deterministic feature-
  hashing embedder. It needs no network and no model download, so it works
  offline and in tests while still producing a real vector space where lexical
  overlap maps to cosine similarity. This is the default.
* :class:`ProviderEmbedder` — calls an OpenAI-compatible ``/embeddings`` endpoint
  (the same provider used for chat) when ``AGENT_EMBEDDINGS=provider`` and a key
  is configured. If the endpoint is unavailable, retrieval degrades to lexical
  scoring (see :mod:`knowledge`) so a query never fails.

``get_embedder`` picks a backend from the environment and caches it per process.
"""

from __future__ import annotations

import hashlib
import os
import re
from functools import lru_cache
from typing import Protocol

import httpx
import numpy as np

_TOKEN_RE = re.compile(r"[a-z0-9]+|[\u4e00-\u9fff]")


def _tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


class Embedder(Protocol):
    name: str

    def embed(self, texts: list[str]) -> np.ndarray: ...


def _l2_normalize(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


class HashingEmbedder:
    """Deterministic feature-hashing embedder (the signed hashing trick)."""

    def __init__(self, dim: int = 256):
        self.dim = dim
        self.name = f"hashing-{dim}"

    def embed(self, texts: list[str]) -> np.ndarray:
        vectors = np.zeros((len(texts), self.dim), dtype=np.float64)
        for row, text in enumerate(texts):
            for token in _tokenize(text):
                digest = int(hashlib.md5(token.encode("utf-8")).hexdigest(), 16)
                index = digest % self.dim
                sign = 1.0 if (digest >> 8) & 1 else -1.0
                vectors[row, index] += sign
        return _l2_normalize(vectors)


class ProviderEmbedder:
    """Embeddings from an OpenAI-compatible ``/embeddings`` endpoint."""

    def __init__(self, api_key: str, base_url: str, model: str, timeout: float = 8.0):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.name = f"provider-{model}"

    def embed(self, texts: list[str]) -> np.ndarray:
        response = httpx.post(
            f"{self.base_url}/embeddings",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
            json={"model": self.model, "input": texts},
            timeout=self.timeout,
        )
        response.raise_for_status()
        payload = response.json()
        rows = sorted(payload["data"], key=lambda item: item.get("index", 0))
        vectors = np.array([row["embedding"] for row in rows], dtype=np.float64)
        return _l2_normalize(vectors)


def _derive_base_url(api_url: str) -> str:
    for suffix in ("/chat/completions", "/completions"):
        if api_url.endswith(suffix):
            return api_url[: -len(suffix)]
    return api_url


@lru_cache(maxsize=1)
def get_embedder() -> Embedder:
    """Return the configured embedder, falling back to hashing on any problem."""
    mode = os.getenv("AGENT_EMBEDDINGS", "hashing").strip().lower()
    if mode == "provider":
        from .agent import _configured_provider

        api_key, api_url, _model, _name = _configured_provider()
        if api_key:
            model = os.getenv("AGENT_EMBEDDING_MODEL", "text-embedding-3-small")
            return ProviderEmbedder(api_key, _derive_base_url(api_url), model)
    return HashingEmbedder()
