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


def analyze_slow_query_groq(conn_id: int, payload: OracleSlowQueryGroqRequest, db: Session) -> dict:
    rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "oracle",
    ).first()
    if not rec:
        return {"status": "error", "error": "Oracle connection not found"}
    if not (payload.sql_text or "").strip():
        return {"status": "error", "error": "No SQL text provided"}

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
Rows processed: {payload.rows_processed:,}

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
