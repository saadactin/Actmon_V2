"""
Oracle AI Analysis Service
Generates AI-driven analysis for Oracle errors, plus Groq-powered slow-query
analysis (same pattern as MySQL/PostgreSQL/MSSQL/MongoDB's existing
`.../slow-queries/analyze-groq` endpoints — see
`mssql_ai_analysis.analyze_slow_query_groq` for the reference shape). Oracle
previously had no AI analysis for its slow queries at all.
"""
import os
import json
from typing import Optional

from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster


def analyze_oracle_error(error_message: str, error_code: str, engine=None) -> str:
    """
    Analyze Oracle error and provide AI-driven insights
    """

    error_msg_lower = error_message.lower()
    error_code_int = int(error_code) if error_code.isdigit() else 0

    analysis = f"""
Oracle Error Analysis Report
============================

What is error:
Oracle reported error code {error_code}: {error_message}

"""

    if error_code_int == 1:
        analysis += """Why it is coming:
Unique constraint violated. An attempt was made to insert or update a row with a duplicate value
in a column that has a unique constraint.

How to solve:
1. Identify which constraint was violated
2. Check the existing data for duplicate values
3. Modify the data to remove duplicates
4. Use UPSERT (MERGE) if appropriate
5. Review application logic for proper data validation

Exactly where to change:
Review and update the INSERT/UPDATE statements in your application.
Check the database schema for constraint definitions.

Exact variable to remove:
No configuration variable needs removal - fix the data issue instead.
"""
    elif error_code_int == 54:
        analysis += """Why it is coming:
Resource busy or temporarily unavailable. Another session has locked the resource you're trying to access.

How to solve:
1. Wait for the other transaction to complete
2. Check for blocking locks using v$session and v$lock
3. Kill blocking sessions if necessary
4. Optimize transaction scope to reduce lock duration
5. Consider using row-level locking instead of table locks
6. Implement proper transaction isolation levels

Exactly where to change:
Review your application's transaction management.
Optimize query performance to reduce lock contention.

Exact variable to remove:
No configuration variable removal needed.
"""
    elif error_code_int == 1017:
        analysis += """Why it is coming:
Invalid username/password or user not found. Authentication failed for the specified user.

How to solve:
1. Verify the username is correct
2. Reset the password if needed
3. Check if the user account is locked
4. Ensure the user has appropriate privileges
5. Verify the database link credentials

Exactly where to change:
Update the connection credentials in your application.
Reset the user password in Oracle if needed.

Exact variable to remove:
No configuration variable removal needed.
"""
    else:
        analysis += """Why it is coming:
The specific error requires analysis of the Oracle error logs and server state.

How to solve:
1. Check the Oracle alert log and trace files
2. Review the error message in Oracle documentation
3. Check database initialization parameters
4. Verify tablespace availability
5. Check for library cache issues

Exactly where to change:
Refer to the Oracle error logs for specific guidance.

Exact variable to remove:
No configuration variable removal needed.
"""

    return analysis.strip()


# ── Groq-powered slow-query analysis ──────────────────────────────────────────
class OracleSlowQueryGroqRequest(BaseModel):
    sql_text:            str
    schema_name:         Optional[str] = None
    executions:          int   = 0
    avg_elapsed_sec:     float = 0.0
    avg_cpu_sec:         float = 0.0
    avg_disk_reads:      float = 0.0
    avg_buffer_gets:     float = 0.0
    rows_processed:      int   = 0
    # Optional — when present, the prompt is enriched with the real execution
    # plan and current wait state instead of just these four aggregate
    # numbers. Backward compatible: omitted, this behaves exactly as before.
    sql_id:              Optional[str] = None


def analyze_slow_query_groq(conn_id: int, payload: OracleSlowQueryGroqRequest, db: Session) -> dict:
    rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "oracle",
    ).first()
    if not rec:
        return {"status": "error", "error": "Oracle connection not found"}
    if not (payload.sql_text or "").strip():
        return {"status": "error", "error": "No SQL text provided"}

    plan_section = ""
    wait_section = ""
    if payload.sql_id:
        try:
            from app.services.oracle.oracle_monitoring_service import oracle_sql_plan
            plan_resp = oracle_sql_plan(conn_id, db, payload.sql_id)
            plan_rows = plan_resp.get("plan") or []
            issues = plan_resp.get("issues") or []
            wait_info = plan_resp.get("wait_info") or {}

            if plan_rows:
                plan_lines = "\n".join(
                    f"{'  ' * (p.get('depth') or 0)}{p.get('operation')} {p.get('options') or ''} "
                    f"(cost={p.get('cost')}, rows={p.get('cardinality')}"
                    + (f", object={p.get('object_owner')}.{p.get('object_name')}" if p.get("object_name") else "")
                    + ")"
                    for p in plan_rows
                )
                issues_lines = "\n".join(
                    f"- [{i['severity'].upper()}] {i['type']}: {i['description']} ({i['evidence']})"
                    for i in issues
                ) or "(none flagged by deterministic analysis)"
                plan_section = f"""

=== EXECUTION PLAN (v$sql_plan, real) ===
{plan_lines}

Deterministic plan analysis already found:
{issues_lines}"""

            if wait_info:
                wait_section = f"""

=== CURRENT WAIT STATE (v$session, real, if still running) ===
Status: {wait_info.get('status')}, wait_event: {wait_info.get('wait_event')}, wait_class: {wait_info.get('wait_class')}, seconds_in_wait: {wait_info.get('seconds_in_wait')}"""
        except Exception:
            pass  # AI analysis must still work even if plan enrichment fails

    try:
        from groq import Groq
        client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))

        prompt = f"""You are a world-class Oracle Database performance expert. Analyze this slow query deeply and return ONLY valid JSON — no markdown, no code fences.

=== QUERY CONTEXT ===
Server: {rec.host}:{rec.port}
Parsing schema: {payload.schema_name or 'unknown'}
SQL:
{payload.sql_text}

=== PERFORMANCE METRICS (from v$sqlarea) ===
Executions: {payload.executions:,}
Average elapsed time: {payload.avg_elapsed_sec:.4f} sec
Average CPU time: {payload.avg_cpu_sec:.4f} sec
Average disk reads: {payload.avg_disk_reads:,.0f}
Average buffer gets (logical reads): {payload.avg_buffer_gets:,.0f}
Rows processed: {payload.rows_processed:,}{plan_section}{wait_section}

Return this exact JSON structure:
{{
  "severity": "critical|high|medium|low",
  "severity_reason": "why this severity was assigned",
  "summary": "one sentence: what the query does and why it is slow",
  "root_cause": "detailed root cause — what exactly makes this query slow in Oracle",
  "issues": [
    {{
      "type": "FULL_TABLE_SCAN|MISSING_INDEX|BAD_JOIN_ORDER|STALE_STATISTICS|HIGH_BUFFER_GETS|HIGH_DISK_READS|PARSING_OVERHEAD|OTHER",
      "table": "affected table or null",
      "description": "detailed description of the issue",
      "severity": "critical|high|medium|low",
      "evidence": "the metric or pattern that proves this issue"
    }}
  ],
  "index_recommendations": [
    {{
      "table": "schema.table",
      "columns": ["col1","col2"],
      "index_type": "BTREE|BITMAP|FUNCTION_BASED",
      "create_sql": "CREATE INDEX idx_name ON schema.table (col1, col2);",
      "reason": "why this index helps",
      "estimated_improvement": "e.g. removes a full table scan, 90% fewer buffer gets"
    }}
  ],
  "query_rewrite": {{
    "applicable": true,
    "optimized_sql": "rewritten SQL or empty string",
    "changes_made": ["list","of","changes"],
    "explanation": "what changed and why it is faster",
    "expected_gain": "e.g. 5x-20x faster"
  }},
  "schema_suggestions": ["any table/index design changes that would help"],
  "priority_actions": ["1. Most impactful action first","2. Second","3. Third"],
  "business_impact": "impact on the application and users",
  "estimated_overall_improvement": "overall expected improvement after all fixes",
  "validation_queries": ["a query to verify the optimization worked"]
}}"""

        response = client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=3000,
            reasoning_effort="low",
        )
        raw = response.choices[0].message.content.strip()
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1] if len(parts) > 1 else raw
            if raw.startswith("json"):
                raw = raw[4:]
        analysis = json.loads(raw.strip())
        return {"status": "success", "analysis": analysis}
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ── Groq-powered plain-English storage object explanation ─────────────────────
class OracleStorageAiExplainRequest(BaseModel):
    """Everything is real data already computed by the deterministic
    findings/block-detail services — the model is only asked to put it into
    plain English (and answer a free-text follow-up), never to invent its
    own numbers. `history` lets the small on-page Q&A box carry context
    across a couple of follow-up questions without a server-side session."""
    object_type:      str
    object_label:     str
    problem:          Optional[str] = None
    evidence:         Optional[str] = None
    expected_benefit: Optional[str] = None
    risk:             Optional[str] = None
    facts:            dict = {}     # size/blocks/load/impact-estimate — whatever the page already shows
    question:         Optional[str] = None   # None -> produce the initial plain-English summary
    history:          list = []     # [{question, answer}, ...] prior turns on this page


def oracle_storage_ai_explain(payload: OracleStorageAiExplainRequest) -> dict:
    try:
        from groq import Groq
        client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))

        facts_lines = "\n".join(f"- {k}: {v}" for k, v in payload.facts.items() if v is not None)
        history_lines = "\n".join(
            f"Q: {h.get('question')}\nA: {h.get('answer')}" for h in (payload.history or []) if h.get("question")
        )

        prompt = f"""You are ActMon's database assistant, explaining Oracle storage data to someone who is NOT a DBA — plain, short, everyday English. No jargon without explaining it in the same sentence. Never invent a number — use ONLY the facts given below; if something isn't in the facts, say it isn't known rather than guessing.

=== OBJECT ===
Type: {payload.object_type}
Name: {payload.object_label}
Finding: {payload.problem or '(no active finding — just showing current status)'}
Evidence: {payload.evidence or '(none)'}
Expected benefit if action is taken: {payload.expected_benefit or '(none)'}
Risk of taking action: {payload.risk or '(none)'}

=== REAL MEASURED FACTS ===
{facts_lines or '(none provided)'}

{"=== PRIOR Q&A ON THIS PAGE ===" if history_lines else ""}
{history_lines}

=== TASK ===
{"Answer this follow-up question in 2-4 sentences, grounded only in the facts above: " + payload.question if payload.question else "Write a 3-5 sentence plain-English summary: what this object is, how full/empty it really is, whether it needs attention right now, and — only if a finding/benefit is present above — roughly what running the recommended action would do. Do not restate every fact as a list; write it as something a non-technical manager could read in ten seconds."}

Return plain text only — no markdown headers, no JSON, no code fences."""

        response = client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            max_tokens=600,
            reasoning_effort="low",
        )
        answer = response.choices[0].message.content.strip()
        return {"status": "success", "answer": answer}
    except Exception as e:
        return {"status": "error", "error": str(e)}
