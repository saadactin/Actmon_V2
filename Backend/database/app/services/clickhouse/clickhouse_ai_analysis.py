"""
ClickHouse AI Analysis Service — error-analysis plus Groq-powered slow-query
analysis (same pattern as MySQL/PostgreSQL/MSSQL/MongoDB's existing
`.../slow-queries/analyze-groq` endpoints — see
`mssql_ai_analysis.analyze_slow_query_groq` for the reference shape).
ClickHouse previously had no AI analysis for its slow queries at all.
"""
import os
import json
from typing import Optional

from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster


def analyze_clickhouse_error(error_message: str, error_code: str, engine=None) -> str:
    """Analyze ClickHouse error and provide AI-driven insights"""

    error_msg_lower = error_message.lower()

    analysis = f"""
ClickHouse Error Analysis Report
===============================

What is error:
ClickHouse reported error: {error_message}

"""

    if "syntax error" in error_msg_lower:
        analysis += """Why it is coming:
Invalid SQL syntax in the ClickHouse query.

How to solve:
1. Review query syntax for errors
2. Check column names and table references
3. Verify function names are correct
4. Use ClickHouse documentation for syntax
5. Test query in clickhouse-client

Exactly where to change:
Fix syntax errors in your SQL query.

Exact variable to remove:
No configuration change needed.
"""
    elif "table doesn't exist" in error_msg_lower or "unknown table" in error_msg_lower:
        analysis += """Why it is coming:
Referenced table does not exist in ClickHouse database.

How to solve:
1. Verify table name and database
2. Check table creation in correct database
3. Review table schema
4. Use SHOW TABLES to list tables
5. Check for typos in table name

Exactly where to change:
Correct the table name in your query or create the missing table.

Exact variable to remove:
No configuration change needed.
"""
    elif "not enough memory" in error_msg_lower or "memory limit" in error_msg_lower:
        analysis += """Why it is coming:
ClickHouse query exceeded available memory limit.

How to solve:
1. Increase max_memory_usage setting
2. Optimize query to process less data
3. Add WHERE clauses to filter data
4. Use sampling for large datasets
5. Break large query into smaller parts
6. Review server memory availability

Exactly where to change:
Adjust max_memory_usage in ClickHouse config or optimize query.

Exact variable to remove:
Consider increasing max_memory_usage if needed.
"""
    elif "disconnected" in error_msg_lower or "connection refused" in error_msg_lower:
        analysis += """Why it is coming:
Cannot connect to ClickHouse server. Connection was refused or terminated.

How to solve:
1. Check if ClickHouse server is running
2. Verify connection host and port
3. Check firewall allows ClickHouse port (8123 for HTTP)
4. Verify credentials
5. Check server logs for connection issues
6. Verify network connectivity

Exactly where to change:
Update connection settings or check ClickHouse server configuration.

Exact variable to remove:
No configuration change needed.
"""
    elif "code 47" in error_msg_lower or "unsupported" in error_msg_lower:
        analysis += """Why it is coming:
ClickHouse encountered an unsupported operation or data type.

How to solve:
1. Review the unsupported feature in documentation
2. Use alternative functions or data types
3. Check ClickHouse version for feature availability
4. Consider upgrading ClickHouse if needed
5. Review data type compatibility

Exactly where to change:
Modify query to use supported functions or data types.

Exact variable to remove:
No configuration change needed.
"""
    else:
        analysis += """Why it is coming:
Review the ClickHouse error logs and documentation.

How to solve:
1. Check ClickHouse system.errors table
2. Review error logs in /var/log/clickhouse-server
3. Check system.query_log for query details
4. Verify server configuration
5. Monitor server resources

Exactly where to change:
Refer to ClickHouse documentation and logs for specific guidance.

Exact variable to remove:
No configuration change needed.
"""

    return analysis.strip()


# ── Groq-powered slow-query analysis ──────────────────────────────────────────
class ClickHouseSlowQueryGroqRequest(BaseModel):
    query_text:        str
    databases:         Optional[str] = None
    execution_count:   int   = 0
    avg_duration_ms:    float = 0.0
    read_rows:          float = 0.0
    read_bytes:         float = 0.0
    result_rows:        float = 0.0
    memory_usage:       float = 0.0


def analyze_slow_query_groq(conn_id: int, payload: ClickHouseSlowQueryGroqRequest, db: Session) -> dict:
    rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "clickhouse",
    ).first()
    if not rec:
        return {"status": "error", "error": "ClickHouse connection not found"}
    if not (payload.query_text or "").strip():
        return {"status": "error", "error": "No query text provided"}

    try:
        from groq import Groq
        client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))

        prompt = f"""You are a world-class ClickHouse performance expert. Analyze this slow query deeply and return ONLY valid JSON — no markdown, no code fences.

=== QUERY CONTEXT ===
Server: {rec.host}:{rec.port}
Databases touched: {payload.databases or 'unknown'}
Query:
{payload.query_text}

=== PERFORMANCE METRICS (from system.query_log, aggregated by normalized query shape) ===
Execution count: {payload.execution_count:,}
Average duration: {payload.avg_duration_ms:.2f} ms
Average rows read: {payload.read_rows:,.0f}
Average bytes read: {payload.read_bytes:,.0f}
Average result rows: {payload.result_rows:,.0f}
Average memory usage: {payload.memory_usage:,.0f} bytes

Return this exact JSON structure:
{{
  "severity": "critical|high|medium|low",
  "severity_reason": "why this severity was assigned",
  "summary": "one sentence: what the query does and why it is slow",
  "root_cause": "detailed root cause — what exactly makes this query slow in ClickHouse",
  "issues": [
    {{
      "type": "FULL_SCAN|TOO_MANY_PARTS|LARGE_JOIN|MISSING_PRIMARY_KEY_USE|HIGH_MEMORY|INEFFICIENT_AGGREGATION|OTHER",
      "table": "affected table or null",
      "description": "detailed description of the issue",
      "severity": "critical|high|medium|low",
      "evidence": "the metric or pattern that proves this issue"
    }}
  ],
  "index_recommendations": [
    {{
      "table": "database.table",
      "columns": ["col1","col2"],
      "index_type": "ORDER BY key|skip index (minmax/set/bloom_filter)|projection",
      "create_sql": "ALTER TABLE database.table ADD INDEX idx_name (col1) TYPE minmax GRANULARITY 4;",
      "reason": "why this helps",
      "estimated_improvement": "e.g. avoids a full scan of N rows"
    }}
  ],
  "query_rewrite": {{
    "applicable": true,
    "optimized_sql": "rewritten query or empty string",
    "changes_made": ["list","of","changes"],
    "explanation": "what changed and why it is faster",
    "expected_gain": "e.g. 5x-20x faster"
  }},
  "schema_suggestions": ["any table/ORDER BY/partitioning design changes that would help"],
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
