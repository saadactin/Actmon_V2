"""The one place every Groq call gets its model and token budget from.

Groq retires models (llama-3.3-70b-versatile was removed, which broke every AI
feature at once), so the model is a setting: GROQ_MODEL in Backend/database/.env,
falling back to DEFAULT_GROQ_MODEL.

Reasoning models (gpt-oss, qwen3) think before answering and that thinking is
billed against max_tokens — a budget sized for the answer alone comes back
empty or truncated. groq_params() adds headroom for those models only, and
passes reasoning_effort only to models that accept it.

    client.chat.completions.create(messages=..., temperature=..., **groq_params(1500))
"""
import logging
import os

# groq 1.4 hands httpx its status code as a string, and httpx's per-request INFO
# line formats it with "%d" — so every successful Groq call printed a
# "--- Logging error ---" traceback. That line only echoes "POST … 200 OK".
logging.getLogger("httpx").setLevel(logging.WARNING)

DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b"

_HEADROOM = {"low": 1500, "medium": 4000, "high": 8000}


def groq_model() -> str:
    return os.getenv("GROQ_MODEL", "").strip() or DEFAULT_GROQ_MODEL


def _is_gpt_oss(model: str) -> bool:
    return model.startswith("openai/gpt-oss")


def _is_reasoning(model: str) -> bool:
    return _is_gpt_oss(model) or model.startswith("qwen/qwen3")


def groq_params(answer_tokens: int, reasoning: str = "low") -> dict:
    """model + max_tokens (+ reasoning_effort where supported) for one call."""
    model = groq_model()
    params = {"model": model, "max_tokens": answer_tokens}
    if _is_reasoning(model):
        params["max_tokens"] = answer_tokens + _HEADROOM.get(reasoning, _HEADROOM["low"])
    if _is_gpt_oss(model):
        params["reasoning_effort"] = reasoning
    return params
