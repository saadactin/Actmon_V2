/**
 * SLOW QUERY CATALOGUE — one definition of how each engine's Slow Query Analysis
 * page is wired, so the shared list/detail pages never branch on `tech`.
 *
 * The backend normalizes every engine's collector output into one common row
 * shape (see `Backend/database/app/services/common/slow_query_normalize.py`):
 *   query_id, query_text, database_name, schema_name, user_name, host,
 *   execution_count, total_execution_time, average_execution_time,
 *   min_execution_time, max_execution_time, rows_affected, rows_returned,
 *   first_seen, last_seen, status, severity, source
 * plus a `capabilities` object saying which of those fields this engine can
 * genuinely populate. This file only ever holds what differs per engine —
 * routes, AI-payload field names (each analyze-groq endpoint predates
 * normalization and expects its own historical shape), and whether a feature
 * (EXPLAIN, a lookup-by-id refetch, a setup guide) exists at all for it. The
 * column set, table, tabs and every visual detail live in the shared page.
 */

/** A response's own `capabilities` (from the live API call) is authoritative;
 * this is only a fallback for the moment before the first response lands. */
export const DEFAULT_CAPABILITIES = {
  aggregation: 'digest', query_id: true, schema_name: false, user_name: true,
  host: false, execution_count: true, min_execution_time: true,
  rows_returned: true, rows_affected: false, first_seen: false, cache_hit: false,
};

export const SEVERITY_TONES = { critical: 'danger', high: 'danger', medium: 'warning', low: 'success' };
export const SEVERITY_LABELS = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

/** Same cutoffs as the backend's `classify_severity` — kept here only for the
 * client-side KPI strip (count "critical now"), never to re-derive severity. */
export const SEVERITY_THRESHOLDS_MS = { medium: 500, high: 2000, critical: 10000 };

export function fmtMs(ms) {
  const v = Number(ms || 0);
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  return `${v.toFixed(v < 10 ? 2 : 0)} ms`;
}

const num = (v) => Number(v) || 0;

/**
 * Per-engine wiring. `api.byId` is null for engines whose rows have no stable
 * identity to refetch (ClickHouse per-instance fallback, MongoDB always) —
 * the detail page shows an honest "come back from the list" state for those
 * instead of pretending a reload can recover the row.
 */
export const SLOW_QUERY_ENGINES = {
  postgresql: {
    key: 'postgresql',
    label: 'PostgreSQL',
    dashboardPath: (id) => `/postgresql-dashboard/${id}`,
    api: {
      list: (id) => `/connections/postgresql/${id}/pg-slow-queries`,
      byId: (id, qid) => `/connections/postgresql/${id}/pg-slow-queries/${encodeURIComponent(qid)}`,
      analyzeGroq: (id) => `/connections/postgresql/${id}/pg-slow-queries/analyze-groq`,
      explainSql: (id) => `/connections/postgresql/${id}/pg-slow-queries/explain-analyze`,
      enableExtension: (id) => `/connections/postgresql/${id}/enable-pg-stat-statements`,
    },
    hasExplain: true,
    setupGuide: 'pg_stat_statements',
    sourceLabel: (data) => (data?.pg_stat_statements_available === false
      ? 'pg_stat_activity — live sessions (limited; enable pg_stat_statements for full history)'
      : 'pg_stat_statements — cumulative query digest'),
    buildAiPayload: (row, raw) => {
      const hit = num(raw?.shared_blks_hit);
      const read = num(raw?.shared_blks_read);
      const cacheHitPct = (hit + read) > 0 ? (hit / (hit + read)) * 100 : 100;
      return {
        sql_text: row.query_text || '',
        user_name: row.user_name || '',
        calls: num(row.execution_count),
        mean_exec_time_ms: num(row.average_execution_time),
        max_exec_time_ms: num(row.max_execution_time),
        total_exec_time_ms: num(row.total_execution_time),
        rows: num(row.rows_returned),
        shared_blks_hit: hit,
        shared_blks_read: read,
        cache_hit_pct: Number(cacheHitPct.toFixed(2)),
      };
    },
  },

  mysql: {
    key: 'mysql',
    label: 'MySQL',
    dashboardPath: (id) => `/mysql-dashboard/${id}`,
    api: {
      list: (id) => `/connections/mysql/${id}/slow-queries`,
      byId: (id, qid) => `/connections/mysql/${id}/slow-queries/${encodeURIComponent(qid)}`,
      analyzeGroq: (id) => `/connections/mysql/${id}/slow-queries/analyze-groq`,
      explainSql: (id) => `/connections/mysql/${id}/slow-queries/explain-analyze`,
    },
    hasExplain: true,
    setupGuide: null,
    sourceLabel: () => 'performance_schema / slow query log',
    buildAiPayload: (row, raw) => ({
      sql_text: row.query_text || '',
      db_name: row.database_name || '',
      count_calls: num(row.execution_count),
      avg_exec_sec: num(row.average_execution_time) / 1000,
      max_exec_sec: num(row.max_execution_time) / 1000,
      total_exec_sec: num(row.total_execution_time) / 1000,
      rows_examined: num(raw?.rows_examined ?? raw?.SUM_ROWS_EXAMINED),
      rows_returned: num(row.rows_returned),
      no_index_count: num(raw?.no_index_count ?? raw?.SUM_NO_INDEX_USED),
      last_seen: row.last_seen || null,
    }),
  },

  mssql: {
    key: 'mssql',
    label: 'SQL Server',
    dashboardPath: (id) => `/mssql-dashboard/${id}`,
    api: {
      list: (id) => `/connections/mssql/${id}/mssql-slow-queries`,
      byId: (id, qid) => `/connections/mssql/${id}/mssql-slow-queries/${encodeURIComponent(qid)}`,
      analyzeGroq: (id) => `/connections/mssql/${id}/mssql-slow-queries/analyze-groq`,
    },
    hasExplain: false, // real plan-XML retrieval is a follow-up, not this phase
    setupGuide: null,
    sourceLabel: () => 'sys.dm_exec_query_stats — cached plans',
    buildAiPayload: (row, raw) => ({
      sql_text: row.query_text || '',
      db_name: row.database_name || '',
      execution_count: num(row.execution_count),
      avg_elapsed_ms: num(row.average_execution_time),
      total_cpu_ms: num(raw?.total_cpu_ms ?? row.total_execution_time),
      avg_logical_reads: num(raw?.avg_logical_reads),
      avg_physical_reads: num(raw?.avg_physical_reads),
    }),
  },

  oracle: {
    key: 'oracle',
    label: 'Oracle',
    dashboardPath: (id) => `/oracle-dashboard/${id}`,
    api: {
      list: (id) => `/connections/oracle/${id}/oracle-slow-queries`,
      byId: (id, qid) => `/connections/oracle/${id}/oracle-slow-queries/${encodeURIComponent(qid)}`,
      analyzeGroq: (id) => `/connections/oracle/${id}/oracle-slow-queries/analyze-groq`,
      explainSqlId: (id, sqlId) => `/connections/oracle/${id}/oracle-sql-plan?sql_id=${encodeURIComponent(sqlId)}`,
    },
    hasExplain: true,
    setupGuide: null,
    sourceLabel: () => 'v$sqlarea — shared pool statement cache',
    buildAiPayload: (row, raw) => ({
      sql_text: row.query_text || '',
      schema_name: row.schema_name || '',
      executions: num(row.execution_count),
      avg_elapsed_sec: num(row.average_execution_time) / 1000,
      avg_cpu_sec: num(raw?.avg_cpu_sec),
      avg_disk_reads: num(raw?.avg_disk_reads),
      avg_buffer_gets: num(raw?.avg_buffer_gets),
      rows_processed: num(row.rows_returned),
    }),
  },

  clickhouse: {
    key: 'clickhouse',
    label: 'ClickHouse',
    dashboardPath: (id) => `/clickhouse-dashboard/${id}`,
    api: {
      list: (id) => `/connections/clickhouse/${id}/ch-slow-queries`,
      byId: null, // per-instance fallback rows have no stable digest to refetch later
      analyzeGroq: (id) => `/connections/clickhouse/${id}/ch-slow-queries/analyze-groq`,
      explainSql: (id) => `/connections/clickhouse/${id}/ch-slow-queries/explain`,
    },
    hasExplain: true,
    setupGuide: null,
    sourceLabel: () => 'system.query_log',
    buildAiPayload: (row, raw) => ({
      query_text: row.query_text || '',
      databases: row.database_name || '',
      execution_count: num(row.execution_count),
      avg_duration_ms: num(row.average_execution_time),
      read_rows: num(raw?.read_rows),
      read_bytes: num(raw?.read_bytes),
      result_rows: num(row.rows_returned),
      memory_usage: num(raw?.memory_usage),
    }),
  },

  mongodb: {
    key: 'mongodb',
    label: 'MongoDB',
    dashboardPath: (id) => `/mongodb-dashboard/${id}`,
    api: {
      list: (id) => `/connections/mongodb/${id}/mongo-slow-operations`,
      byId: null, // currentOp/profiler entries are one-time observations, not a digest
      analyzeGroq: (id) => `/connections/mongodb/${id}/mongo-slow-ops/analyze-groq`,
      explainOp: (id) => `/connections/mongodb/${id}/mongo-slow-ops/explain`,
    },
    hasExplain: true,
    setupGuide: null,
    sourceLabel: () => 'currentOp / system.profile — per-instance snapshot',
    buildAiPayload: (row, raw) => ({
      ns: raw?.ns || (row.database_name ? `${row.database_name}.${raw?.collection || ''}` : ''),
      op: raw?.op || '',
      millis: num(row.average_execution_time),
      docs_examined: num(raw?.docsExamined),
      keys_examined: num(raw?.keysExamined),
      docs_returned: num(row.rows_returned),
      plan_summary: raw?.planSummary || '',
      filter_json: raw?.query || '',
      client: row.host || '',
    }),
  },
};

export function engineFor(tech) {
  return SLOW_QUERY_ENGINES[String(tech || '').toLowerCase()] || null;
}
