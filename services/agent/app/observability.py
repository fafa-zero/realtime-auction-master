"""Request-scoped tracing helpers for the Agent service."""

import logging
from contextvars import ContextVar
from uuid import uuid4

request_id_var: ContextVar[str] = ContextVar("agent_request_id", default="-")
logger = logging.getLogger("auction-agent")


def new_request_id() -> str:
    return uuid4().hex


def get_request_id() -> str:
    return request_id_var.get()
