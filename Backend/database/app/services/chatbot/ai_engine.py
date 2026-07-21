"""
ActMon AI Engine — Groq LLM integration with streaming, context building, and report generation.
Kept in app/services/chatbot/ so it can be reused by multiple route modules (database, cloud, infra).
"""

import os, json, re, csv, io
from typing import Generator, List, Optional


# ──────────────────────────────────────────────────────────────────────────────
# System Prompt
# ──────────────────────────────────────────────────────────────────────────────

def build_system_prompt(connections: list, user_context: dict = None) -> str:
    if connections:
        conn_lines = []
        for c in connections:
            name = c.get("connection_name") or f"{c['db_type']} #{c['id']}"
            conn_lines.append(
                f"  • [ID:{c['id']}] {name} — {c['db_type'].upper()} @ {c['host']} "
                f"(DB: {c.get('database_name') or 'default'})"
            )
        conn_ctx = "\n".join(conn_lines)
    else:
        conn_ctx = "  No connections configured yet."

    current = ""
    if user_context:
        db_type = user_context.get("db_type", "")
        conn_id = user_context.get("connection_id")
        page    = user_context.get("page", "")
        if db_type or conn_id:
            current = f"\n**Current view:** {db_type.upper() if db_type else 'Unknown'}"
            if conn_id:
                current += f" — Connection #{conn_id}"
            if page:
                current += f" — {page}"

    return f"""You are **ActMon AI**, an expert Database Administrator assistant built into the ActMon Enterprise Monitoring Platform.

## Who You Are
- Role: Expert DBA with deep knowledge of MySQL, PostgreSQL, MongoDB, MSSQL, Oracle, ClickHouse
- Style: Concise, direct, actionable — like a senior DBA colleague, not a chatbot
- You NEVER say "I'm just an AI" — you are ActMon AI, a specialized DBA assistant
{current}

## Monitored Databases
{conn_ctx}

## Your Full Capabilities
1. **General DBA Q&A** — Answer any database question clearly with examples
2. **SQL Generation** — Write any SQL (CREATE TABLE, SELECT, INDEX, PROCEDURE, VIEW, TRIGGER) for any supported DB type
3. **Schema Design** — Design normalized schemas, suggest data types, constraints, partitioning
4. **Performance Analysis** — Interpret EXPLAIN plans, buffer hit rates, lock waits, slow queries
5. **Error Diagnosis** — Look up error codes and provide step-by-step fixes
6. **Index Optimization** — Recommend and generate CREATE INDEX statements
7. **Health Assessment** — Flag metric thresholds (slow >2s = warning, >10s = critical; cache <95% = warning)
8. **Report Generation** — Tell user what report will include, then emit [ACTION:report:TYPE:CONN_ID]
9. **Query Optimization** — Rewrite inefficient queries with explanation
10. **Replication & HA** — Galera, streaming replication, Always On, Data Guard setup advice

## SQL Response Rules
- Always use triple backtick code blocks:  ```sql
- Include a short comment block at the top explaining the purpose
- For CREATE TABLE: explain each column inline with -- comments
- Use the correct dialect (MySQL uses BIGINT AUTO_INCREMENT, PostgreSQL uses BIGSERIAL, etc.)
- Default to PostgreSQL if no DB type is in context

## Report Actions
When the user asks to download or export a report, include this marker at the END of your message:
[ACTION:report:slow_queries:CONN_ID]   — replace CONN_ID with the actual connection ID
[ACTION:report:health:CONN_ID]
[ACTION:report:indexes:CONN_ID]
[ACTION:report:connections]             — no connection ID needed
Use "unknown" as CONN_ID if not specified (user can pick in UI).

## Suggestions Rule (MANDATORY)
You MUST end EVERY response with EXACTLY this format — never skip it:
SUGGESTIONS: suggestion one here|suggestion two here|suggestion three here

Make suggestions relevant to what was just discussed and immediately useful.

## Important Constraints
- Only reference Connection IDs that appear in the list above — never invent IDs
- If asked about a connection that doesn't exist, say "I don't see that connection in ActMon"
- Always be specific — no vague advice like "optimize your queries"
"""


# ──────────────────────────────────────────────────────────────────────────────
# Streaming Chat
# ──────────────────────────────────────────────────────────────────────────────

def stream_chat(messages: list) -> Generator[str, None, None]:
    """Yield SSE-formatted lines from Groq streaming API."""
    from groq import Groq
    client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))

    full_text = ""
    try:
        stream = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=messages,
            stream=True,
            max_tokens=2048,
            temperature=0.72,
        )
        for chunk in stream:
            delta = chunk.choices[0].delta.content or ""
            if delta:
                full_text += delta
                yield "data: " + json.dumps({"type": "token", "text": delta}) + "\n\n"

        # Parse SUGGESTIONS from end of full response
        suggestions = _extract_suggestions(full_text)
        # Parse ACTION markers
        actions = _extract_actions(full_text)

        yield "data: " + json.dumps({
            "type": "done",
            "suggestions": suggestions,
            "actions": actions,
        }) + "\n\n"

    except Exception as e:
        yield "data: " + json.dumps({"type": "error", "error": str(e)}) + "\n\n"


# ──────────────────────────────────────────────────────────────────────────────
# Non-streaming (for report descriptions)
# ──────────────────────────────────────────────────────────────────────────────

def chat_once(messages: list) -> str:
    from groq import Groq
    client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))
    resp = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=messages,
        max_tokens=1024,
        temperature=0.5,
    )
    return resp.choices[0].message.content or ""


# ──────────────────────────────────────────────────────────────────────────────
# Parsers
# ──────────────────────────────────────────────────────────────────────────────

def _extract_suggestions(text: str) -> list:
    match = re.search(r"SUGGESTIONS:\s*(.+?)(?:\n|$)", text, re.IGNORECASE)
    if not match:
        return []
    return [s.strip() for s in match.group(1).split("|") if s.strip()][:4]


def _extract_actions(text: str) -> list:
    actions = []
    for m in re.finditer(r"\[ACTION:([^\]]+)\]", text):
        parts = m.group(1).split(":")
        if len(parts) >= 2:
            actions.append({
                "type": parts[0],            # e.g. "report"
                "subtype": parts[1],         # e.g. "slow_queries"
                "conn_id": parts[2] if len(parts) > 2 else None,
            })
    return actions


# ──────────────────────────────────────────────────────────────────────────────
# Report CSV generators
# ──────────────────────────────────────────────────────────────────────────────

def generate_connections_csv(connections: list) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["ID", "Name", "DB Type", "Host", "Port", "Database", "Environment"])
    for c in connections:
        w.writerow([
            c.get("id"), c.get("connection_name"), c.get("db_type"),
            c.get("host"), c.get("port"), c.get("database_name"), c.get("environment"),
        ])
    return buf.getvalue()


def generate_health_summary_csv(connections: list) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["ID", "Name", "Type", "Host", "Status", "Notes"])
    for c in connections:
        w.writerow([
            c.get("id"), c.get("connection_name"), c.get("db_type"),
            c.get("host"), "Configured", "Health data available via monitoring dashboard",
        ])
    return buf.getvalue()
