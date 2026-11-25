"""
pipeline.py  –  Core LangChain Code-Generation Pipeline   

Connects: FormContext schema → prompt template → LLM (Groq) → guardrails → code

Public API
----------
Batch (waits for complete response):
    result = run_pipeline(form_context, feedback="")
    result.code      – validated React component string (or None on failure)
    result.success   – bool
    result.error     – error message string (or None on success)
    result.attempts  – how many LLM calls were made

Streaming (yields tokens as they arrive, faster perceived UX):
    for chunk in stream_pipeline(form_context):
        print(chunk, end="", flush=True)
    # raises StreamGuardrailError if final output fails validation

The pipeline uses LangChain's ChatPromptTemplate so the prompt is fully
typed, versioned, and swappable without touching LLM or guardrail logic.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Generator, Iterator, Optional

from langchain_core.prompts import ChatPromptTemplate

from guardrails import GuardrailsConfig, GuardrailError, apply_guardrails, check_output
from llm_providers import get_llm
from prompts import SYSTEM_PROMPT, HUMAN_PROMPT
from schemas import FormContext

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Config  (all tunable via env vars)
# ─────────────────────────────────────────────────────────────────────────────

def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, default))
    except (TypeError, ValueError):
        return default


PIPELINE_MAX_RETRIES: int = _env_int("PIPELINE_MAX_RETRIES", 2)
PIPELINE_MAX_TOKENS:  int = _env_int("PIPELINE_MAX_TOKENS", 1024)


# ─────────────────────────────────────────────────────────────────────────────
# Result containers
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class PipelineResult:
    """Returned by run_pipeline() (batch mode)."""
    code:     Optional[str]   # validated React component code, or None
    success:  bool
    error:    Optional[str]   # human-readable failure reason, or None
    attempts: int             # LLM calls made


class StreamGuardrailError(RuntimeError):
    """
    Raised by stream_pipeline() after all tokens have been yielded but the
    assembled output fails guardrail validation.  Callers should discard any
    buffered output when they catch this exception.
    """


# ─────────────────────────────────────────────────────────────────────────────
# LangChain prompt template  (built once, reused across all calls)
# ─────────────────────────────────────────────────────────────────────────────

_PROMPT_TEMPLATE = ChatPromptTemplate.from_messages([
    ("system", "{system_prompt}"),
    ("human",  "{human_prompt}"),
])


def _build_messages(context_json: str, feedback: str):
    """Return a list of LangChain messages ready to send to the LLM."""
    human_text = HUMAN_PROMPT.format(
        context=context_json,
        feedback=f"\n\nFeedback from previous attempt: {feedback}" if feedback else "",
    )
    return _PROMPT_TEMPLATE.format_messages(
        system_prompt=SYSTEM_PROMPT,
        human_prompt=human_text,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Batch pipeline  (original behaviour — unchanged)
# ─────────────────────────────────────────────────────────────────────────────

def run_pipeline(
    form_context: FormContext,
    feedback: str = "",
    guardrails_cfg: Optional[GuardrailsConfig] = None,
) -> PipelineResult:
    """
    Run the full code-generation pipeline for one FormContext.
    Waits for the complete LLM response before returning.

    Parameters
    ----------
    form_context    : Validated FormContext pydantic model.
    feedback        : Optional string from a previous failed attempt to guide retry.
    guardrails_cfg  : Custom GuardrailsConfig; uses defaults if None.

    Returns
    -------
    PipelineResult with .code, .success, .error, .attempts
    """
    cfg          = guardrails_cfg or GuardrailsConfig()
    llm          = get_llm()
    context_json = form_context.model_dump_json(indent=2)

    # Pre-call guardrail: topic check
    try:
        apply_guardrails(cfg, context_json)
    except GuardrailError as exc:
        logger.warning("Pipeline blocked by pre-call guardrail: %s", exc)
        return PipelineResult(code=None, success=False, error=str(exc), attempts=0)

    last_error: str = "Unknown error"
    for attempt in range(1, PIPELINE_MAX_RETRIES + 2):
        logger.info("Pipeline attempt %d / %d", attempt, PIPELINE_MAX_RETRIES + 1)
        messages = _build_messages(context_json, feedback if attempt > 1 else "")

        try:
            response = llm.invoke(messages)
            raw_code = response.content if hasattr(response, "content") else str(response)
        except Exception as exc:
            last_error = f"LLM call failed: {exc}"
            logger.error(last_error)
            if attempt > PIPELINE_MAX_RETRIES:
                break
            continue

        try:
            clean_code = check_output(cfg, raw_code)
            logger.info("Pipeline succeeded on attempt %d.", attempt)
            return PipelineResult(code=clean_code, success=True, error=None, attempts=attempt)
        except GuardrailError as exc:
            last_error = str(exc)
            logger.warning("Output guardrail failed (attempt %d): %s", attempt, exc)
            feedback = last_error
            if attempt > PIPELINE_MAX_RETRIES:
                break

    return PipelineResult(code=None, success=False, error=last_error, attempts=attempt)


# ─────────────────────────────────────────────────────────────────────────────
# Streaming pipeline  (Day 7 — token-by-token, faster perceived UX)
# ─────────────────────────────────────────────────────────────────────────────

def stream_pipeline(
    form_context: FormContext,
    feedback: str = "",
    guardrails_cfg: Optional[GuardrailsConfig] = None,
) -> Generator[str, None, None]:
    """
    Stream the code-generation pipeline token-by-token.

    Yields each token string as the LLM produces it so the caller can render
    code incrementally (e.g. pipe into a WebSocket or SSE response).

    After ALL tokens are yielded, the assembled output is validated by the
    same guardrails as run_pipeline().  If validation fails, StreamGuardrailError
    is raised — callers must discard buffered output on that exception.

    If the pre-call topic guardrail blocks the request, StreamGuardrailError
    is raised immediately (before any tokens are yielded).

    Retry behaviour
    ---------------
    When guardrail validation fails and retries remain, the generator silently
    re-runs the LLM call and streams the new attempt from the beginning.
    The caller only ever sees tokens from the final successful (or last failed)
    attempt.

    Parameters
    ----------
    form_context    : Validated FormContext pydantic model.
    feedback        : Optional initial feedback string.
    guardrails_cfg  : Custom GuardrailsConfig; uses defaults if None.

    Yields
    ------
    str — raw token text chunks from the LLM.

    Raises
    ------
    StreamGuardrailError — if the assembled output fails validation after all
                           retries are exhausted, or on a pre-call topic block.
    """
    cfg          = guardrails_cfg or GuardrailsConfig()
    llm          = get_llm()
    context_json = form_context.model_dump_json(indent=2)

    # Pre-call guardrail
    try:
        apply_guardrails(cfg, context_json)
    except GuardrailError as exc:
        raise StreamGuardrailError(str(exc)) from exc

    last_error: str = "Unknown error"

    for attempt in range(1, PIPELINE_MAX_RETRIES + 2):
        logger.info("Stream attempt %d / %d", attempt, PIPELINE_MAX_RETRIES + 1)
        messages = _build_messages(context_json, feedback if attempt > 1 else "")

        # Collect tokens and yield them simultaneously
        buffer: list[str] = []

        try:
            # LangChain's .stream() yields AIMessageChunk objects
            for chunk in llm.stream(messages):
                token: str = (
                    chunk.content
                    if hasattr(chunk, "content")
                    else str(chunk)
                )
                buffer.append(token)
                yield token

        except Exception as exc:
            last_error = f"LLM stream failed: {exc}"
            logger.error(last_error)
            if attempt > PIPELINE_MAX_RETRIES:
                break
            feedback = last_error
            buffer.clear()
            continue

        # Validate the assembled output
        raw_code = "".join(buffer)
        try:
            check_output(cfg, raw_code)
            logger.info("Stream pipeline validated on attempt %d.", attempt)
            return   # generator exhausted cleanly — all good

        except GuardrailError as exc:
            last_error = str(exc)
            logger.warning("Stream guardrail failed (attempt %d): %s", attempt, exc)
            feedback = last_error
            buffer.clear()
            if attempt > PIPELINE_MAX_RETRIES:
                break
            # Next iteration will re-stream from scratch

    raise StreamGuardrailError(last_error)


# ─────────────────────────────────────────────────────────────────────────────
# Quick smoke-test  (python pipeline.py)
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, stream=sys.stdout)

    sample = FormContext(
        formTitle="Quick Health Check",
        fields=[
            {"name": "age",     "label": "How old are you?",           "type": "number", "required": True},
            {"name": "gender",  "label": "What is your gender?",       "type": "select", "required": True,
             "options": ["Male", "Female", "Non-binary", "Prefer not to say"]},
            {"name": "symptom", "label": "What is your main symptom?", "type": "text",   "required": True},
        ],
        frictionField="symptom",
        frictionReason="User paused 8 seconds on this field",
    )

    mode = sys.argv[1] if len(sys.argv) > 1 else "batch"

    if mode == "stream":
        print("── STREAMING ──────────────────────────────")
        try:
            for token in stream_pipeline(sample):
                print(token, end="", flush=True)
            print("\n✅ Stream complete and validated.")
        except StreamGuardrailError as e:
            print(f"\n❌ Stream guardrail error: {e}")

    else:
        print("── BATCH ──────────────────────────────────")
        result = run_pipeline(sample)
        if result.success:
            print(f"✅ Pipeline OK — {len(result.code)} chars, {result.attempts} attempt(s)")
            print(result.code[:300], "...")
        else:
            print("❌ Pipeline failed:", result.error)
