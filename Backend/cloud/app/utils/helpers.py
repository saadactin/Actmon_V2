"""General utility helpers for the cloud microservice."""
from __future__ import annotations

import re
from typing import Any, Dict


def sanitize_string(value: Any, max_len: int = 512) -> str:
    """Convert any value to a safe, length-capped string."""
    s = str(value) if value is not None else ""
    return s[:max_len]


def flatten_tags(tags: Any) -> Dict[str, str]:
    """Normalize various tag formats into a simple key-value dict."""
    if isinstance(tags, dict):
        return {str(k): str(v) for k, v in tags.items()}
    if isinstance(tags, list):
        result = {}
        for item in tags:
            if isinstance(item, dict):
                key = item.get("Key") or item.get("key", "")
                val = item.get("Value") or item.get("value", "")
                result[key] = val
        return result
    return {}


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
