"""Groq-powered AWR report analysis — same pattern as
oracle_ai_analysis.analyze_slow_query_groq (prompt-engineered JSON contract,
manual code-fence stripping, status/error envelope, no retry/fallback
provider). Requires GROQ_API_KEY; with no key configured this returns a
clean "error" envelope rather than a fabricated analysis.

Only measurements leave the machine: wait events, SQL ids/modules/timings and
the rule findings. SQL text is never sent — it can carry literal business data.
"""
import os
import json

from sqlalchemy.orm import Session

from app.models.oracle_awr_model import OracleAwrFinding, OracleAwrReport
from app.services.common.groq_config import groq_params
from app.services.oracle import oracle_awr_service


def _evidence_lines(report_id: int, org_id: int | None, db: Session) -> tuple[str, str]:
    insights = oracle_awr_service.get_report_insights(report_id, org_id, db)
    if insights.get("status") != "ok":
        return "Not available.", "Not available."
    waits = "\n".join(
        f"- {w['name']} ({w['wait_class'] or 'n/a'}): {w['percent_db_time']}% of DB time"
        + (f", avg wait {w['avg_wait_ms']:.2f} ms" if w.get("avg_wait_ms") is not None else "")
        for w in insights["wait_events"] if w.get("percent_db_time") is not None
    ) or "None parsed."
    sql = "\n".join(
        f"- {s['sql_id']} [{s.get('module') or 'unknown module'}]: elapsed {s['elapsed_seconds']} s, "
        f"{s['executions']} executions, {s['elapsed_per_exec_seconds']} s/exec, %CPU {s['cpu_pct']}, %IO {s['io_pct']}"
        for s in insights["top_sql"][:8]
    ) or "None parsed."
    return waits, sql


def analyze_awr_report_groq(report_id: int, org_id: int | None, db: Session) -> dict:
    q = db.query(OracleAwrReport).filter(OracleAwrReport.id == report_id)
    if org_id is not None:
        q = q.filter(OracleAwrReport.org_id == org_id)
    report_row = q.first()
    if not report_row:
        return {"status": "error", "error": "AWR report not found"}
    if report_row.status != "PARSED":
        return {"status": "error", "error": f"Report is not parsed yet (status={report_row.status})"}

    findings = (
        db.query(OracleAwrFinding)
        .filter(OracleAwrFinding.report_id == report_id)
        .order_by(OracleAwrFinding.id.asc())
        .all()
    )
    findings_text = "\n".join(
        f"- [{f.severity}/{f.category}] {f.title}: {f.evidence}" for f in findings
    ) or "No rule-engine findings were raised."

    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key:
        return {
            "status": "error",
            "code": "no_api_key",
            "error": "GROQ_API_KEY is not set. Add it to Backend/database/.env and restart the backend.",
        }

    waits_text, sql_text = _evidence_lines(report_id, org_id, db)
    aas = (
        f"{report_row.db_time_minutes / report_row.elapsed_minutes:.1f}"
        if report_row.db_time_minutes and report_row.elapsed_minutes else "unknown"
    )
    # A whole AWR window is worth more thought than a chat reply.
    params = groq_params(2000, reasoning="medium")
    model = params["model"]

    try:
        from groq import Groq
        client = Groq(api_key=api_key)

        prompt = f"""You are a world-class Oracle Database performance expert. Analyze this AWR snapshot summary and return ONLY valid JSON — no markdown, no code fences.
Base every statement on the evidence below; if the evidence does not support a conclusion, say so rather than guessing.

=== AWR SNAPSHOT ===
Database: {report_row.db_name}
Instance: {report_row.instance_name or 'unknown'} (#{report_row.instance_number or '?'})
Host: {report_row.host_name or 'unknown'}
Window: snap {report_row.begin_snap} -> {report_row.end_snap}, elapsed {report_row.elapsed_minutes} minutes
DB time: {report_row.db_time_minutes} minutes (average active sessions: {aas})

=== TOP TIMED EVENTS ===
{waits_text}

=== TOP SQL BY ELAPSED TIME (SQL text withheld) ===
{sql_text}

=== RULE-ENGINE FINDINGS ===
{findings_text}

Return this exact JSON structure:
{{
  "severity": "critical|high|medium|low",
  "summary": "one sentence: overall health of this snapshot window",
  "root_cause": "most likely root cause tying the findings together",
  "priority_actions": ["1. Most impactful action first", "2. Second", "3. Third"],
  "business_impact": "impact on application and users if left unaddressed",
  "validation_queries": ["a v$/dba_ query a DBA could run to confirm the diagnosis"]
}}"""

        response = client.chat.completions.create(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            response_format={"type": "json_object"},
            **params,
        )
        raw = (response.choices[0].message.content or "").strip()
        if not raw:
            return {"status": "error", "error": f"{model} returned an empty response — try again."}
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1] if len(parts) > 1 else raw
            if raw.startswith("json"):
                raw = raw[4:]
        analysis = json.loads(raw.strip())
        return {"status": "success", "analysis": analysis, "model": model}
    except Exception as e:
        return {"status": "error", "error": str(e)}


# Alias matching the route's call name for consistency with the rest of the module.
analyze_awr_groq = analyze_awr_report_groq
