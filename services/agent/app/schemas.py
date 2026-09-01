from typing import Any, Literal

from pydantic import BaseModel, Field


AgentTask = Literal[
    "product-script",
    "auction-summary",
    "host-cue",
    "bid-risk",
    "chat",
]


class AgentRunRequest(BaseModel):
    """A provider-neutral request from the Node auction service."""

    task: AgentTask = "chat"
    title: str = Field(min_length=1, max_length=120)
    system_prompt: str = Field(min_length=1, max_length=8_000)
    user_prompt: str = Field(min_length=1, max_length=20_000)
    fallback_content: str = Field(min_length=1, max_length=20_000)
    context: dict[str, Any] = Field(default_factory=dict)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=1_000)
    session_id: str = Field(default="default", min_length=1, max_length=80, pattern=r"^[A-Za-z0-9:_-]+$")
    user_id: str = Field(default="anonymous", min_length=1, max_length=120)
    user_role: str = Field(default="BUYER", min_length=1, max_length=20)
    live_room_id: str | None = Field(default=None, max_length=120)
    context: dict[str, Any] = Field(default_factory=dict)


class AiResult(BaseModel):
    ok: Literal[True] = True
    title: str
    content: str
    generatedAt: int
    source: Literal["model", "fallback"]
    fallback: bool
    message: str
    toolsUsed: list[str] = Field(default_factory=list)
    toolResults: dict[str, Any] = Field(default_factory=dict)


class Citation(BaseModel):
    id: str
    title: str
    content: str
    score: float


class ChatResponse(AiResult):
    sessionId: str
    intent: AgentTask
    citations: list[Citation] = Field(default_factory=list)
    historySize: int = 0
