"""
ActMon's own bookkeeping tables — shared across every engine's slow-query /
top-query service so a monitored connection that happens to point at the
same Postgres instance ActMon itself uses (the `actmon` database) doesn't
show ActMon's own agent/notification/audit housekeeping queries mixed in
with the real workload being monitored.

Table list is generated from `__tablename__` across Backend/database/app/models
and Backend/cloud/app/models — keep in sync if a new model is added there.
"""

ACTMON_INTERNAL_TABLES = [
    "agent_db_targets", "agent_metrics", "agent_notifications", "agent_oracle_snapshots",
    "agent_pending_update", "agent_sessions", "agent_snapshots", "agent_stable_changes",
    "agent_stable_facts", "agent_tokens", "agent_top_sql", "agent_wait_events", "agents",
    "alert_fired_state", "alert_rules", "audit_log",
    "connection_master", "cosmos_query_log", "dashboard_appearance_settings",
    "database_instances", "db_check_runs", "department_master", "designation_master",
    "diagnosis_runs", "employee_master", "external_check", "external_check_result",
    "group_role_page_permission", "login_history", "module_master", "monitoring_settings",
    "mssql_report_schedules", "mysql_report_schedules", "notification_channels",
    "notification_history", "notification_queue", "notification_settings",
    "notification_templates", "oracle_report_schedules", "organization_master",
    "os_servers", "page_master", "password_history", "permission",
    "postgres_report_schedules", "role", "severity_channel_routing", "smtp_configs",
    "status_master", "user_master", "user_session",
    # Backend/cloud (same shared Postgres instance)
    "cloud_accounts", "discovery_jobs", "cloud_resources",
]


def pg_exclude_internal_tables_sql(column: str = "s.query") -> str:
    """POSIX word-boundary regex clause for a Postgres WHERE, e.g.:
    `AND col !~* '\\y(agents|agent_sessions|...)\\y'`
    Word boundaries (`\\y`) keep this from also excluding a genuine table that
    merely contains one of these names as a substring (e.g. `user_master_v2`
    would NOT match, `user_master` would).
    """
    alternation = "|".join(ACTMON_INTERNAL_TABLES)
    return f"{column} !~* '\\y({alternation})\\y'"


def mysql_exclude_internal_tables_sql(column: str = "digest_text") -> str:
    """MySQL REGEXP clause (MySQL 8's REGEXP is PCRE-based, so `\\b` works)."""
    alternation = "|".join(ACTMON_INTERNAL_TABLES)
    return f"({column} IS NULL OR {column} NOT REGEXP '\\\\b({alternation})\\\\b')"


def mssql_exclude_internal_tables_sql(column: str = "qt.text") -> str:
    """SQL Server has no native regex; word-boundary-safe enough in practice
    since these are distinctive ActMon table names unlikely to substring-collide,
    so a plain NOT LIKE chain is used instead of a false sense of precision."""
    clauses = " AND ".join(f"{column} NOT LIKE '%{t}%'" for t in ACTMON_INTERNAL_TABLES)
    return f"({clauses})"


def oracle_exclude_internal_tables_sql(column: str = "sql_text") -> str:
    """A single REGEXP_LIKE alternation of every internal table name exceeds
    Oracle's regex engine's pattern-length limit (ORA-12733) once the list
    grows this large — a plain NOT LIKE chain has no such limit, same
    approach as `mssql_exclude_internal_tables_sql` for the same reason."""
    clauses = " AND ".join(f"{column} NOT LIKE '%{t}%'" for t in ACTMON_INTERNAL_TABLES)
    return f"({clauses})"


def clickhouse_exclude_internal_tables_sql(column: str = "query") -> str:
    """ClickHouse match() uses RE2 syntax — word boundaries via (^|\\W) / (\\W|$)
    since RE2 doesn't support \\b the same way in all builds."""
    alternation = "|".join(ACTMON_INTERNAL_TABLES)
    return f"NOT match({column}, '(?i)(^|[^a-zA-Z0-9_])({alternation})([^a-zA-Z0-9_]|$)')"


def contains_internal_table(query_text: str) -> bool:
    """Python-side fallback check (case-insensitive, word-boundary via regex) —
    for engines/paths where filtering after fetch (rather than in the query
    itself) is the only practical option."""
    import re
    if not query_text:
        return False
    pattern = r"\b(" + "|".join(ACTMON_INTERNAL_TABLES) + r")\b"
    return re.search(pattern, query_text, re.IGNORECASE) is not None
