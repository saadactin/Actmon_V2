"""
MSSQL AI Analysis Service.
 - analyze_mssql_error / get_mssql_recommendations : rule-based error guidance (used by mssql_error_service)
 - analyze_slow_query_groq : Groq-powered slow-query analysis (T-SQL specific)
"""
import os
import json
from typing import Optional

from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster


def analyze_mssql_error(error_message: str, error_code: str, engine=None) -> str:
    """Analyze a MSSQL error and provide rule-based, plain-language guidance."""
    error_msg_lower = (error_message or "").lower()
    error_code_int = int(error_code) if str(error_code).isdigit() else 0

    analysis = f"""
MSSQL Error Analysis Report
===========================

What is error:
The SQL Server reported error code {error_code} with message: {error_message}

"""
    if error_code_int == 1205:
        analysis += """Why it is coming:
This is a deadlock error. SQL Server detected conflicting locks from multiple transactions
trying to access the same resources simultaneously, forcing one transaction to roll back.

How to solve:
1. Review the deadlock victim query and the blocking query
2. Optimize query execution plans to reduce lock duration
3. Use READ COMMITTED SNAPSHOT isolation if appropriate
4. Keep transactions short and access objects in a consistent order
5. Add indexes on frequently locked columns
"""
    elif error_code_int == 1053:
        analysis += """Why it is coming:
A SQL Server query timed out or the service is shutting down. The request could not finish
within the allocated time.

How to solve:
1. Increase the command timeout in the connection string
2. Optimize the slow-running query with proper indexing
3. Check if the server is under heavy load
4. Update statistics and review the plan
"""
    elif error_code_int == 515:
        analysis += """Why it is coming:
Cannot insert NULL into a column that does not allow NULLs. A NOT NULL constraint is blocking
the insert.

How to solve:
1. Provide a non-NULL value for the required column
2. Check the table schema for NOT NULL columns
3. Add a DEFAULT constraint if a default should apply
"""
    elif "permission" in error_msg_lower or "denied" in error_msg_lower:
        analysis += """Why it is coming:
The login does not have sufficient permissions for this operation.

How to solve:
1. GRANT the required permission to the login or role
2. Review the login's server and database roles
3. Verify the correct database context
"""
    elif "syntax" in error_msg_lower:
        analysis += """Why it is coming:
There is a T-SQL syntax error in the submitted statement.

How to solve:
1. Review the statement for missing commas, parentheses or keywords
2. Verify object names exist and are spelled correctly
3. Test the statement piece by piece to isolate the error
"""
    else:
        analysis += """Why it is coming:
This error needs analysis of the SQL Server error log and current server state. It may relate
to configuration, resource limits or query issues.

How to solve:
1. Check the SQL Server error log for detail
2. Review wait statistics and blocking
3. Monitor CPU, memory and disk on the host
4. Verify backups and transaction-log space
"""
    return analysis.strip()


def get_mssql_recommendations(error_code: str) -> dict:
    """Specific recommendations for common MSSQL error codes."""
    error_code_int = int(error_code) if str(error_code).isdigit() else 0
    recommendations = {
        1205: {"title": "Deadlock Detected", "severity": "HIGH",
               "impact": "Transaction rolled back, operations blocked",
               "actions": ["Review conflicting queries", "Optimize indexes", "Adjust isolation level"]},
        1053: {"title": "Query Timeout", "severity": "MEDIUM",
               "impact": "Slow query execution",
               "actions": ["Increase timeout", "Optimize query", "Add indexes"]},
        515:  {"title": "NULL Constraint Violation", "severity": "LOW",
               "impact": "Data insertion failed",
               "actions": ["Provide required values", "Update schema", "Add defaults"]},
    }
    return recommendations.get(error_code_int, {
        "title": "MSSQL Error", "severity": "UNKNOWN",
        "impact": "Check error logs for details",
        "actions": ["Review error logs", "Check server status"],
    })


# ── Groq-powered slow-query analysis ──────────────────────────────────────────
class MssqlSlowQueryGroqRequest(BaseModel):
    sql_text:           str
    db_name:            Optional[str] = None
    execution_count:    int   = 0
    avg_elapsed_ms:     float = 0.0
    total_cpu_ms:       float = 0.0
    avg_logical_reads:  float = 0.0
    avg_physical_reads: float = 0.0


def analyze_slow_query_groq(conn_id: int, payload: MssqlSlowQueryGroqRequest, db: Session) -> dict:
    rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "mssql",
    ).first()
    if not rec:
        return {"status": "error", "error": "SQL Server connection not found"}
    if not (payload.sql_text or "").strip():
        return {"status": "error", "error": "No SQL text provided"}

    try:
        from groq import Groq
        client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))

        prompt = f"""You are a world-class Microsoft SQL Server (T-SQL) performance expert. Analyze this slow query deeply and return ONLY valid JSON — no markdown, no code fences.

=== QUERY CONTEXT ===
Server: {rec.host}:{rec.port}
Database: {payload.db_name or 'unknown'}
SQL:
{payload.sql_text}

=== PERFORMANCE METRICS (from sys.dm_exec_query_stats) ===
Execution count: {payload.execution_count:,}
Average elapsed time: {payload.avg_elapsed_ms:.2f} ms
Total CPU time: {payload.total_cpu_ms:.2f} ms
Average logical reads (from memory): {payload.avg_logical_reads:,.0f}
Average physical reads (from disk): {payload.avg_physical_reads:,.0f}

Return this exact JSON structure:
{{
  "severity": "critical|high|medium|low",
  "severity_reason": "why this severity was assigned",
  "summary": "one sentence: what the query does and why it is slow",
  "root_cause": "detailed root cause — what exactly makes this query slow in SQL Server",
  "issues": [
    {{
      "type": "TABLE_SCAN|INDEX_SCAN|MISSING_INDEX|KEY_LOOKUP|INEFFICIENT_JOIN|SORT_SPILL|HIGH_LOGICAL_READS|PARAMETER_SNIFFING|IMPLICIT_CONVERSION|LARGE_RESULT_SET|OTHER",
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
      "include_columns": ["col3"],
      "index_type": "NONCLUSTERED|CLUSTERED|COLUMNSTORE",
      "create_sql": "CREATE NONCLUSTERED INDEX IX_name ON schema.table (col1, col2) INCLUDE (col3);",
      "reason": "why this index helps",
      "estimated_improvement": "e.g. removes a table scan, 95% fewer logical reads"
    }}
  ],
  "query_rewrite": {{
    "applicable": true,
    "optimized_sql": "rewritten T-SQL or empty string",
    "changes_made": ["list","of","changes"],
    "explanation": "what changed and why it is faster",
    "expected_gain": "e.g. 10x-50x faster"
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


# ── Groq-powered fragmentation explanation ────────────────────────────────────
class MssqlFragmentationGroqRequest(BaseModel):
    table_name:          str
    index_name:          str
    type_desc:           str = "NONCLUSTERED"
    is_unique:           bool = False
    frag_pct:             float = 0.0
    page_count:           int   = 0
    recommended_action:   str   = "REORGANIZE"
    fill_factor:          Optional[int]   = None
    action_note:          Optional[str]   = None
    # Populated only when the user has already run the on-demand DETAILED-mode
    # precise check on this index — plain-LIMITED-mode sweeps never have these.
    page_density_pct:     Optional[float] = None
    fragment_count:       Optional[int]   = None
    avg_fragment_size_pages: Optional[float] = None


def analyze_fragmentation_groq(conn_id: int, payload: MssqlFragmentationGroqRequest, db: Session) -> dict:
    """Plain-language explanation for one fragmented index finding — deliberately
    narrower than analyze_slow_query_groq's multi-section report: fragmentation
    has one real decision (REORGANIZE vs REBUILD, already computed from
    Microsoft's own published thresholds) that this doesn't need to second-guess,
    just explain in the context of THIS specific index."""
    rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "mssql",
    ).first()
    if not rec:
        return {"status": "error", "error": "SQL Server connection not found"}
    if not (payload.index_name or "").strip():
        return {"status": "error", "error": "No index name provided"}

    try:
        from groq import Groq
        client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))

        approx_mb = round((payload.page_count * 8) / 1024, 1)
        precise_block = ""
        if payload.page_density_pct is not None:
            precise_block = f"""
=== PRECISE CHECK (on-demand DETAILED scan, already run on this exact index) ===
Page density (avg_page_space_used_in_percent): {payload.page_density_pct}% — how full each page actually is
Fragment count: {payload.fragment_count}
Average fragment size: {payload.avg_fragment_size_pages} pages
"""
        note_block = f"\nWhy REBUILD was forced despite fragmentation possibly being under 30%: {payload.action_note}" if payload.action_note else ""
        prompt = f"""You are a Microsoft SQL Server (T-SQL) performance expert. Explain this ONE fragmented index finding in plain language for a DBA who already knows what an index is but wants the specifics of THIS case. Return ONLY valid JSON — no markdown, no code fences.

=== FINDING ===
Table: {payload.table_name}
Index: {payload.index_name} ({payload.type_desc}{', unique' if payload.is_unique else ''})
Fragmentation: {payload.frag_pct}%
Size: {payload.page_count:,} pages (~{approx_mb} MB)
Fill factor: {payload.fill_factor if payload.fill_factor else 100}%
Already-computed recommended action (Microsoft's published 5-30%=REORGANIZE / >30%=REBUILD threshold): {payload.recommended_action}{note_block}
{precise_block}
Return this exact JSON structure:
{{
  "explanation": "why an index like this, at this fragmentation level, ends up this way in practice (e.g. random-key inserts/deletes, page splits) — reference the actual numbers given, not generic text",
  "impact": "what this specific fragmentation level actually costs in query performance right now (e.g. more physical page reads per scan, degraded read-ahead) — be concrete about the mechanism, not just 'it's slower'",
  "action_reasoning": "why REORGANIZE vs REBUILD is the right call specifically at {payload.frag_pct}% on a {payload.page_count:,}-page index — reference the actual threshold logic",
  "caution": "one practical thing to know before running the {payload.recommended_action} statement on THIS index (e.g. REBUILD locks/needs Enterprise for ONLINE, REORGANIZE is always online but slower/less thorough, or note if size means this could take a while)"
}}"""

        response = client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=800,
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
