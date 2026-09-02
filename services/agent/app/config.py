import os
from pathlib import Path


def load_local_env() -> None:
    """Load the repository's local env files without overwriting shell values."""
    roots = [Path.cwd(), Path(__file__).resolve().parents[3]]
    seen: set[Path] = set()

    for root in roots:
        for filename in (".env.local", ".env"):
            path = (root / filename).resolve()
            if path in seen or not path.is_file():
                continue
            seen.add(path)
            for line in path.read_text(encoding="utf-8").splitlines():
                parsed = _parse_env_line(line)
                if parsed and parsed[0] not in os.environ:
                    os.environ[parsed[0]] = parsed[1]


def _parse_env_line(line: str) -> tuple[str, str] | None:
    value = line.strip()
    if not value or value.startswith("#") or "=" not in value:
        return None
    key, raw = value.split("=", 1)
    key = key.strip()
    if not key or not key.replace("_", "a").isalnum() or not (key[0].isalpha() or key[0] == "_"):
        return None
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {"'", '"'}:
        raw = raw[1:-1]
    return key, raw


load_local_env()


def env_float(name: str, default: float, *, minimum: float = 0.0) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default
    return value if value >= minimum else default


def env_int(name: str, default: int, *, minimum: int = 0) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default
    return value if value >= minimum else default
