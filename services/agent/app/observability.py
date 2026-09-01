"""Request-scoped tracing helpers for the Agent service."""

from contextvars import ContextVar
import logging
from uuid import uuid4


request_id_var: ContextVar[str] = ContextVar("agent_request_id", default="-")
logger = logging.getLogger("auction-agent")


def new_request_id() -> str:
    return uuid4().hex


def get_request_id() -> str:
    return request_id_var.get()
