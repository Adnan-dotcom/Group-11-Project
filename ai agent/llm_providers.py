"""Creates the chat model. Provider selected via LLM_PROVIDER env variable."""
from functools import lru_cache
from langchain_groq import ChatGroq # type: ignore
from langchain_google_genai import ChatGoogleGenerativeAI #type:ignore
import os


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


@lru_cache(maxsize=1)
def get_llm():
    provider = _env("LLM_PROVIDER", "groq").lower().strip()

    # ── Groq (Default) ────────────────────────────────────────────────────────
    if provider == "groq":
        groq_api_key = _env("GROQ_API_KEY")
        groq_model   = _env("GROQ_MODEL", "openai/gpt-oss-120b")

        try:
            
            return ChatGroq(
                model=groq_model,
                groq_api_key=groq_api_key or None,
                temperature=0.2,
                timeout=30,
                max_retries=2,
            )
        except ImportError:
            # Fallback: Google Gemini via langchain_google_genai
            
            return ChatGoogleGenerativeAI(
                model=_env("GOOGLE_MODEL", "gemini-1.5-pro"),
                google_api_key=_env("GOOGLE_API_KEY") or None,
                temperature=0.2,
            )

    # ── Google Gemini (fallback) ───────────────────────────────────────────────
    if provider == "google":
        # from langchain_google_genai import ChatGoogleGenerativeAI
        return ChatGoogleGenerativeAI(
            model=_env("GOOGLE_MODEL", "gemini-1.5-pro"),
            google_api_key=_env("GOOGLE_API_KEY") or None,
            temperature=0.2,
        )