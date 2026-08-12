"""
ActmonAI — the Diagnosis window's AI-analysis layer.

Reuses the same Groq client pattern already proven in
`app/services/mysql/mysql_ai_analysis.py` (real API call, structured-JSON
prompt) — NOT the pattern in `oracle_ai_analysis.py` / the MSSQL equivalent,
which are hardcoded if/elif text templates with no model call at all and are
explicitly not reused here.

The prompt is built ENTIRELY from the real evidence bundle the orchestrator
and diagnose_engine already collected (checks, rule-based RCA, connectivity,
service status, latest error) — never from guessed defaults. The model is
instructed to say so plainly when the evidence doesn't support a confident
call, rather than fill the gap with something plausible-sounding.
"""
import json
import os

from groq import Groq

_MODEL = "llama-3.3-70b-versatile"


def _client():
    key = os.getenv("GROQ_API_KEY")
    if not key:
        return None
    return Groq(api_key=key)


def _evidence_bundle_text(bundle: dict) -> str:
    header = bundle.get("header", {})
    service_process = bundle.get("service_process", {})
    connectivity = bundle.get("connectivity", {})
    checks = bundle.get("checks", [])
    rca = bundle.get("root_cause_analysis", {})
    latest_error = bundle.get("latest_error", {})

    lines = [
        f"Technology: {header.get('technology')}",
        f"Host: {header.get('host')}:{header.get('port')}  OS: {header.get('os_type') or 'unknown'}",
        f"Current status: {header.get('current_status')}  Severity: {header.get('severity')}",
        f"Down/degraded since: {header.get('down_since') or 'n/a'} ({header.get('duration_seconds') or 0}s)",
        "",
        "SERVICE / PROCESS:",
        json.dumps(service_process, indent=2, default=str),
        "",
        "CONNECTIVITY:",
        json.dumps(connectivity, indent=2, default=str),
        "",
        "LATEST ERROR:" if latest_error.get("available") else "LATEST ERROR: none captured",
        json.dumps(latest_error, indent=2, default=str) if latest_error.get("available") else "",
        "",
        "STEP-BY-STEP DIAGNOSTIC CHECKS (id: status — detail):",
    ]
    for c in checks:
        lines.append(f"  {c.get('id')}: {c.get('status')} — {c.get('detail')}")
        if c.get("evidence"):
            lines.append(f"    evidence: {str(c.get('evidence'))[:400]}")
    lines += [
        "",
        "RULE-BASED ROOT CAUSE ANALYSIS (already computed from the checks above, not by you):",
        json.dumps({k: v for k, v in rca.items() if k != "recovery_commands"}, indent=2, default=str),
    ]
    return "\n".join(lines)


def analyze(bundle: dict) -> dict:
    """Returns the ActmonAI section shape. Never raises — a missing API key
    or a model/network failure is reported as `available: false` with a
    reason, since the Diagnosis window must render correctly either way."""
    client = _client()
    if client is None:
        return {"available": False, "reason": "GROQ_API_KEY is not configured on this ActMon server — ActmonAI analysis is unavailable until it is."}

    evidence_text = _evidence_bundle_text(bundle)
    prompt = f"""You are ActmonAI, a senior database reliability engineer reviewing REAL diagnostic evidence collected by ActMon's monitoring agent for one specific database instance.

Below is the COMPLETE evidence available. You must reason ONLY from this evidence. Do not invent service names, file paths, error messages, or metrics that are not present below. If the evidence is insufficient to support a confident root cause, say so explicitly in "diagnosis" and set "confidence" low (below 40) rather than guessing.

=== EVIDENCE ===
{evidence_text}
=== END EVIDENCE ===

Return ONLY valid JSON, no markdown, no commentary, in exactly this shape:
{{
  "diagnosis": "One or two sentences: what is actually happening, grounded in the evidence above.",
  "root_cause": "The specific root cause, or 'Insufficient evidence to determine a root cause' if the evidence doesn't support one.",
  "evidence": ["Each bullet must reference something that actually appears above — a specific check id, status, or value."],
  "recommended_resolution": "The single most useful next action given this evidence.",
  "confidence": 0
}}"""

    try:
        response = client.chat.completions.create(
            model=_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=1200,
        )
        raw = response.choices[0].message.content.strip()
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1]
            if raw.startswith("json"):
                raw = raw[4:]
        parsed = json.loads(raw.strip())
        return {
            "available": True,
            "diagnosis": parsed.get("diagnosis"),
            "root_cause": parsed.get("root_cause"),
            "evidence": parsed.get("evidence", []),
            "recommended_resolution": parsed.get("recommended_resolution"),
            "confidence": parsed.get("confidence"),
        }
    except Exception as e:  # noqa: BLE001 — a bad AI call must degrade, not break the window
        return {"available": False, "reason": f"ActmonAI analysis failed: {e}"}
