from __future__ import annotations

import os
import re
import logging
from dataclasses import dataclass, field
from typing import List

logger = logging.getLogger(__name__)


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, default))
    except (TypeError, ValueError):
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, default))
    except (TypeError, ValueError):
        return default


def _env_list(key: str, default: List[str]) -> List[str]:
    raw = os.environ.get(key, "")
    return [s.strip() for s in raw.split(",") if s.strip()] if raw else default


@dataclass
class GuardrailsConfig:
    """
    All guardrail knobs in one place.
    Every value can be overridden by an environment variable — see guardrails.env.example.
    """

    # ── Topic enforcement ─────────────────────────────────────────────────────
    # Keywords that mark a request as ON-TOPIC for this code-gen agent.
    on_topic_keywords: List[str] = field(default_factory=lambda: _env_list(
        "GR_ON_TOPIC_KEYWORDS",
        [
            "form", "wizard", "step", "field", "input", "select", "button",
            "submit", "react", "component", "ui", "schema", "label", "value",
            "progress", "card", "generatedui", "frictionfield",
        ],
    ))

    # Keywords that immediately flag a request as OFF-TOPIC / misuse.
    off_topic_keywords: List[str] = field(default_factory=lambda: _env_list(
        "GR_OFF_TOPIC_KEYWORDS",
        [
            "password", "secret", "api key", "token", "hack", "exploit",
            "bypass", "jailbreak", "ignore previous", "ignore all",
            "disregard", "as an ai", "you are now", "sudo", "rm -rf",
            "drop table", "shell", "exec(", "eval(",
        ],
    ))

    # Minimum number of on-topic keywords that must appear in the request.
    min_on_topic_hits: int = field(
        default_factory=lambda: _env_int("GR_MIN_ON_TOPIC_HITS", 1)
    )

    # Anti-hallucination 
    # The output MUST contain the entry-point function name.
    required_function_name: str = field(
        default_factory=lambda: os.environ.get("GR_REQUIRED_FUNCTION", "GeneratedUI")
    )

    # Tokens/patterns that must NOT appear in the output.
    forbidden_output_patterns: List[str] = field(default_factory=lambda: _env_list(
        "GR_FORBIDDEN_OUTPUT_PATTERNS",
        [
            "import ", "export ", "require(", "fetch(", "axios",
            "XMLHttpRequest", "WebSocket", "localStorage", "sessionStorage",
            "document.", "window.", "process.", "globalThis",
            "dangerouslySetInnerHTML", "eval(", "Function(",
            "setTimeout(", "setInterval(", "__proto__", "constructor[",
        ],
    ))

    