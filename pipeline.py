"""
pipeline.py  –  Core LangChain Code-Generation Pipeline   (Day 3 / Teammate 1)
===============================================================================
Connects: FormContext schema → prompt template → LLM (Groq) → guardrails → code

Public API
----------
    result = run_pipeline(form_context, feedback="")

    result.code      – validated React component string (or None on failure)
    result.success   – bool
    result.error     – error message string (or None on success)
    result.attempts  – how many LLM calls were made (max = PIPELINE_MAX_RETRIES)

The pipeline uses LangChain's ChatPromptTemplate so the prompt is fully
typed, versioned, and swappable without touching the LLM or guardrail logic.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Optional

from langchain_core.messages import SystemMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate

from guardrails import GuardrailsConfig, GuardrailError, apply_guardrails, check_output
from llm_providers import get_llm
from prompts import SYSTEM_PROMPT, HUMAN_PROMPT
from schemas import FormContext

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Pipeline config (all tunable via env vars)
# ─────────────────────────────────────────────────────────────────────────────

def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, default))
    except (TypeError, ValueError):
        return default


PIPELINE_MAX_RETRIES: int = _env_int("PIPELINE_MAX_RETRIES", 2)   # LLM retry count
PIPELINE_MAX_TOKENS:  int = _env_int("PIPELINE_MAX_TOKENS", 1024) # max tokens per call


# ─────────────────────────────────────────────────────────────────────────────
# Result container
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class PipelineResult:
    code:     Optional[str]  # validated React component code, or None
    success:  bool
    error:    Optional[str]  # human-readable failure reason, or None
    attempts: int            # LLM calls made


# ─────────────────────────────────────────────────────────────────────────────
# LangChain prompt template
# ─────────────────────────────────────────────────────────────────────────────

# Build once; reuse across all pipeline calls (the template is stateless).
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
# Core pipeline
# ─────────────────────────────────────────────────────────────────────────────

def run_pipeline(
    form_context: FormContext,
    feedback: str = "",
    guardrails_cfg: Optional[GuardrailsConfig] = None,
) -> PipelineResult:
    """
    Run the full code-generation pipeline for one FormContext.

    Parameters
    ----------
    form_context    : Validated FormContext pydantic model.
    feedback        : Optional string from a previous failed attempt to guide retry.
    guardrails_cfg  : Custom GuardrailsConfig; uses defaults if None.

    Returns
    -------
    PipelineResult with .code, .success, .error, .attempts
    """
    cfg = guardrails_cfg or GuardrailsConfig()
    llm = get_llm()

    # Serialise the context to JSON for the prompt.
    context_json = form_context.model_dump_json(indent=2)

    # Pre-call guardrail: topic check on the context JSON.
    try:
        apply_guardrails(cfg, context_json)
    except GuardrailError as exc:
        logger.warning("Pipeline blocked by pre-call guardrail: %s", exc)
        return PipelineResult(code=None, success=False, error=str(exc), attempts=0)

    # Retry loop — retries on guardrail validation failure only.
    last_error: str = "Unknown error"
    for attempt in range(1, PIPELINE_MAX_RETRIES + 2):   # +2 → at least 1 attempt
        logger.info("Pipeline attempt %d / %d", attempt, PIPELINE_MAX_RETRIES + 1)

        # Build prompt messages (inject prior feedback on retries).
        messages = _build_messages(context_json, feedback if attempt > 1 else "")

        # LLM call.
        try:
            response = llm.invoke(messages)
            raw_code = response.content if hasattr(response, "content") else str(response)
        except Exception as exc:                           # network / API errors
            last_error = f"LLM call failed: {exc}"
            logger.error(last_error)
            if attempt > PIPELINE_MAX_RETRIES:
                break
            continue

        # Post-call guardrail: validate & clean the output.
        try:
            clean_code = check_output(cfg, raw_code)
            logger.info("Pipeline succeeded on attempt %d.", attempt)
            return PipelineResult(
                code=clean_code,
                success=True,
                error=None,
                attempts=attempt,
            )
        except GuardrailError as exc:
            last_error = str(exc)
            logger.warning("Output guardrail failed (attempt %d): %s", attempt, exc)
            # Pass the guardrail message as feedback so the LLM can self-correct.
            feedback = last_error
            if attempt > PIPELINE_MAX_RETRIES:
                break

    return PipelineResult(code=None, success=False, error=last_error, attempts=attempt)


# ─────────────────────────────────────────────────────────────────────────────
# Quick smoke-test (run directly: python pipeline.py)
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, stream=sys.stdout)

    sample = FormContext(
        formTitle="Quick Health Check",
        fields=[
            {"name": "age",    "label": "How old are you?",           "type": "number", "required": True},
            {"name": "gender", "label": "What is your gender?",       "type": "select", "required": True,
             "options": ["Male", "Female", "Non-binary", "Prefer not to say"]},
            {"name": "symptom","label": "What is your main symptom?", "type": "text",   "required": True},
        ],
        frictionField="symptom",
        frictionReason="User paused 8 seconds on this field",
    )

    result = run_pipeline(sample)
    if result.success:
        print("✅ Pipeline OK — code length:", len(result.code))
        print(result.code[:300], "...")
    else:
        print("❌ Pipeline failed:", result.error)
