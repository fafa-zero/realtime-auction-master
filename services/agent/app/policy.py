"""Deterministic safety checks for requests that must remain read-only."""

import re


_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "instruction_override",
        re.compile(r"(?:忽略|无视|跳过).{0,12}(?:系统|之前|上面|所有).{0,8}(?:指令|规则|要求)|ignore\s+(?:all|previous)\s+instructions", re.I),
    ),
    (
        "prompt_disclosure",
        re.compile(r"(?:泄露|输出|打印|告诉我).{0,12}(?:系统提示|system\s*prompt|提示词|内部指令)", re.I),
    ),
    (
        "write_action",
        re.compile(r"(?:替我|帮我|直接|自动).{0,10}(?:出价|竞价|支付|付款|修改订单|改价)|(?:place[_ -]?bid|pay[_ -]?order|update[_ -]?order)", re.I),
    ),
)


def detect_policy_violation(text: str) -> str | None:
    """Return a stable violation code, or ``None`` for read-only requests."""
    normalized = " ".join(text.strip().split())
    for code, pattern in _PATTERNS:
        if pattern.search(normalized):
            return code
    return None


SAFE_BLOCK_MESSAGE = "Agent 只提供竞拍信息和风险建议，不能替你出价、支付、修改订单或泄露内部提示。"
