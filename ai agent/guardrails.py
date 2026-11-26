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

    # ── Output length / over-generation control ───────────────────────────────
    # Maximum characters the LLM output may be (prevents runaway generation).
    max_output_chars: int = field(
        default_factory=lambda: _env_int("GR_MAX_OUTPUT_CHARS", 8000)
    )

    # Minimum characters — rejects empty / trivially short outputs.
    min_output_chars: int = field(
        default_factory=lambda: _env_int("GR_MIN_OUTPUT_CHARS", 50)
    )

    # Maximum number of JSX return statements (catches duplicated outputs).
    max_return_statements: int = field(
        default_factory=lambda: _env_int("GR_MAX_RETURN_STATEMENTS", 1)
    )



# Guardrail result


class GuardrailError(ValueError):
    """Raised when a guardrail blocks a request or response."""



# Pre-call: topic enforcement


def check_topic(cfg: GuardrailsConfig, user_text: str) -> None:
    """
    Raise GuardrailError if the user's request is off-topic or a prompt injection.

    Parameters
    ----------
    cfg       : GuardrailsConfig
    user_text : The raw user / form context string being sent to the LLM.
    """
    text_lower = user_text.lower()

    # 1. Reject known off-topic / injection patterns immediately.
    for bad in cfg.off_topic_keywords:
        if bad.lower() in text_lower:
            logger.warning("Guardrail OFF-TOPIC hit: %r", bad)
            raise GuardrailError(
                f"Request blocked: contains disallowed content ({bad!r}). "
                "This agent only generates React form-wizard UI code."
            )

    # 2. Require at least one on-topic keyword.
    hits = [kw for kw in cfg.on_topic_keywords if kw.lower() in text_lower]
    if len(hits) < cfg.min_on_topic_hits:
        logger.warning("Guardrail TOPIC MISS — hits: %s", hits)
        raise GuardrailError(
            "Request blocked: does not appear to be about form/wizard UI generation. "
            f"Expected at least {cfg.min_on_topic_hits} relevant keyword(s)."
        )

    logger.debug("Topic check passed — hits: %s", hits)



# Post-call: output validation

def check_output(cfg: GuardrailsConfig, llm_output: str) -> str:
    """
    Validate the LLM's raw output before returning it to the caller.

    - Strips stray markdown code fences (defensive clean-up).
    - Checks length bounds.
    - Checks required function name is present.
    - Checks forbidden patterns are absent.
    - Checks for duplicate return statements (over-generation).

    Returns the cleaned output string on success.
    Raises GuardrailError on failure.
    """
    #  1. Strip markdown fences the model may have added 
    cleaned = re.sub(r"^```[a-z]*\n?", "", llm_output.strip(), flags=re.MULTILINE)
    cleaned = re.sub(r"\n?```$", "", cleaned.strip(), flags=re.MULTILINE)
    cleaned = cleaned.strip()

    #  2. Length bounds 
    char_count = len(cleaned)
    if char_count < cfg.min_output_chars:
        raise GuardrailError(
            f"LLM output too short ({char_count} chars). "
            "The model may have refused or failed to generate code."
        )
    if char_count > cfg.max_output_chars:
        raise GuardrailError(
            f"LLM output too long ({char_count} chars > limit {cfg.max_output_chars}). "
            "Possible over-generation / looping detected."
        )

    #  3. Required function name 
    if cfg.required_function_name not in cleaned:
        raise GuardrailError(
            f"LLM output missing required function '{cfg.required_function_name}'. "
            "Output does not conform to the expected structure."
        )

    #  4. Forbidden patterns 
    for pattern in cfg.forbidden_output_patterns:
        if pattern.lower() in cleaned.lower():
            raise GuardrailError(
                f"LLM output contains forbidden pattern: {pattern!r}. "
                "Possible hallucination or policy violation."
            )

    #  5. Over-generation check: too many return statements 
    return_count = len(re.findall(r"\breturn\s*\(", cleaned))
    if return_count > cfg.max_return_statements:
        raise GuardrailError(
            f"LLM output contains {return_count} return statements "
            f"(max {cfg.max_return_statements}). Possible duplicate generation."
        )

    logger.debug("Output check passed — %d chars, %d return(s).", char_count, return_count)
    return cleaned



# Convenience wrapper


def apply_guardrails(cfg: GuardrailsConfig, user_text: str) -> str:
    """
    Run all pre-call guardrails on the user text.
    Returns the same text unmodified if all checks pass.
    Raises GuardrailError on the first failed check.
    """
    check_topic(cfg, user_text)
    return user_text
