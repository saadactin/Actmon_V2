"""JSON rendering: the normalized dataset, verbatim, for further analysis."""
from __future__ import annotations

import json
from typing import Any, Dict


def build_json(dataset: Dict[str, Any]) -> str:
    return json.dumps(dataset, indent=2, default=str, sort_keys=False)
