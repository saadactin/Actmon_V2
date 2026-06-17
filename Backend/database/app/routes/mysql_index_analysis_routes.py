from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool
from collections import defaultdict
from urllib.parse import quote_plus

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster

router = APIRouter(
    prefix="/api/v1/connections/mysql",
    tags=["MySQL Index Analysis"]
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _mysql_engine(conn):
    pw = quote_plus(conn.password or "")
    url = (
        f"mysql+pymysql://{conn.username}:{pw}"
        f"@{conn.host}:{conn.port}/{conn.database_name or ''}"
    )
    return create_engine(url, poolclass=NullPool)


def _rows(conn, sql, params=None):
    with conn.connect() as c:
        r = c.execute(text(sql), params or {})
        return [dict(row) for row in r.mappings().all()]


def _detect_duplicates(indexes_by_table):
    """
    For each table, compare all index column lists.
    If index A's columns are a strict prefix of index B's columns, A is redundant.
    Returns list of {db, table, redundant_index, covered_by, columns, covered_columns}
    """
    duplicates = []
    for (db, table), idx_map in indexes_by_table.items():
        names = list(idx_map.keys())
        for i in range(len(names)):
            for j in range(len(names)):
                if i == j:
                    continue
                a_name = names[i]
                b_name = names[j]
                if a_name == 'PRIMARY' or b_name == 'PRIMARY':
                    continue
                a_cols = idx_map[a_name]
                b_cols = idx_map[b_name]
                # A is a prefix of B (A is redundant, B is a superset)
                if len(a_cols) < len(b_cols) and b_cols[:len(a_cols)] == a_cols:
                    duplicates.append({
                        'db_name': db,
                        'table_name': table,
                        'redundant_index': a_name,
                        'covered_by': b_name,
                        'columns': a_cols,
                        'covered_columns': b_cols,
                        'drop_statement': f"ALTER TABLE `{db}`.`{table}` DROP INDEX `{a_name}`;",
                    })
    return duplicates


@router.get("/{conn_id}/index-analysis")
def index_analysis(conn_id: int, db: Session = Depends(get_db)):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "mysql_index_analysis", db)
    if _cached is not None:
        return _cached
    conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not conn:
        return {"status": "error", "message": "Connection not found"}

    try:
        engine = _mysql_engine(conn)
    except Exception as e:
        return {"status": "error", "message": f"Engine error: {e}"}

    # Check if performance_schema is enabled
    perf_schema_enabled = False
    try:
        with engine.connect() as c:
            row = c.execute(text("SHOW VARIABLES LIKE 'performance_schema'")).fetchone()
            perf_schema_enabled = (row[1] if row else 'OFF') == 'ON'
    except Exception:
        pass

    result = {
        "status": "success",
        "perf_schema_enabled": perf_schema_enabled,
        "existing_indexes": [],
        "unused_indexes": [],
        "duplicate_indexes": [],
        "missing_index_candidates": [],
        "table_sizes": [],
        "no_index_queries": [],
        "summary": {},
        "errors": {},
    }

    # ── 1. Existing Indexes ────────────────────────────────────────────
    try:
        rows = _rows(engine, """
            SELECT
                TABLE_SCHEMA   AS db_name,
                TABLE_NAME     AS table_name,
                INDEX_NAME     AS index_name,
                SEQ_IN_INDEX   AS seq,
                COLUMN_NAME    AS column_name,
                NON_UNIQUE     AS non_unique,
                INDEX_TYPE     AS index_type,
                NULLABLE       AS nullable,
                CARDINALITY    AS cardinality
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA NOT IN
                  ('performance_schema','information_schema','mysql','sys')
            ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
        """)

        # Aggregate into per-index objects
        idx_map = defaultdict(lambda: {
            'db_name': '', 'table_name': '', 'index_name': '',
            'index_type': '', 'non_unique': 1, 'columns': [], 'cardinality': 0
        })
        tbl_indexes = defaultdict(lambda: defaultdict(list))  # (db,tbl) -> idx -> [cols]

        for r in rows:
            key = (r['db_name'], r['table_name'], r['index_name'])
            obj = idx_map[key]
            obj['db_name']    = r['db_name']
            obj['table_name'] = r['table_name']
            obj['index_name'] = r['index_name']
            obj['index_type'] = r['index_type']
            obj['non_unique'] = int(r['non_unique'])
            obj['columns'].append(r['column_name'])
            obj['cardinality'] = r['cardinality']
            tbl_indexes[(r['db_name'], r['table_name'])][r['index_name']].append(r['column_name'])

        result['existing_indexes'] = list(idx_map.values())
        result['errors']['existing_indexes'] = None
    except Exception as e:
        result['errors']['existing_indexes'] = str(e)
        tbl_indexes = defaultdict(lambda: defaultdict(list))

    # ── 2. Unused Indexes (performance_schema) ─────────────────────────
    try:
        unused = _rows(engine, """
            SELECT
                OBJECT_SCHEMA  AS db_name,
                OBJECT_NAME    AS table_name,
                INDEX_NAME     AS index_name,
                COUNT_READ     AS count_read,
                COUNT_WRITE    AS count_write,
                COUNT_FETCH    AS count_fetch,
                COUNT_INSERT   AS count_insert,
                COUNT_UPDATE   AS count_update,
                COUNT_DELETE   AS count_delete
            FROM performance_schema.table_io_waits_summary_by_index_usage
            WHERE OBJECT_SCHEMA NOT IN
                  ('performance_schema','information_schema','mysql','sys')
              AND INDEX_NAME IS NOT NULL
              AND INDEX_NAME != 'PRIMARY'
              AND COUNT_READ  = 0
              AND COUNT_WRITE = 0
            ORDER BY OBJECT_SCHEMA, OBJECT_NAME
        """)

        # Enrich with columns from existing_indexes
        col_lookup = {
            (o['db_name'], o['table_name'], o['index_name']): o['columns']
            for o in result['existing_indexes']
        }
        for u in unused:
            key = (u['db_name'], u['table_name'], u['index_name'])
            u['columns'] = col_lookup.get(key, [])
            u['drop_statement'] = (
                f"ALTER TABLE `{u['db_name']}`.`{u['table_name']}` "
                f"DROP INDEX `{u['index_name']}`;"
            )
            u['estimated_size_savings'] = 'Unknown — run SHOW INDEX STATUS'

        result['unused_indexes'] = unused
        result['errors']['unused_indexes'] = None
    except Exception as e:
        result['errors']['unused_indexes'] = str(e)

    # ── 3. Duplicate / Redundant Indexes ──────────────────────────────
    try:
        result['duplicate_indexes'] = _detect_duplicates(tbl_indexes)
        result['errors']['duplicate_indexes'] = None
    except Exception as e:
        result['errors']['duplicate_indexes'] = str(e)

    # ── 4. Table Sizes ────────────────────────────────────────────────
    try:
        result['table_sizes'] = _rows(engine, """
            SELECT
                TABLE_SCHEMA AS db_name,
                TABLE_NAME   AS table_name,
                TABLE_ROWS   AS row_estimate,
                ROUND((DATA_LENGTH  + INDEX_LENGTH) / 1048576, 2) AS total_mb,
                ROUND(DATA_LENGTH  / 1048576, 2) AS data_mb,
                ROUND(INDEX_LENGTH / 1048576, 2) AS index_mb,
                ENGINE
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA NOT IN
                  ('performance_schema','information_schema','mysql','sys')
              AND TABLE_TYPE = 'BASE TABLE'
            ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
            LIMIT 200
        """)
        result['errors']['table_sizes'] = None
    except Exception as e:
        result['errors']['table_sizes'] = str(e)

    # ── 5. Queries with No Index Used ─────────────────────────────────
    try:
        no_idx = _rows(engine, """
            SELECT
                IFNULL(SCHEMA_NAME,'(all)') AS db_name,
                DIGEST_TEXT     AS sql_text,
                COUNT_STAR      AS count_calls,
                ROUND(AVG_TIMER_WAIT/1e12,4)  AS avg_sec,
                ROUND(MAX_TIMER_WAIT/1e12,4)  AS max_sec,
                SUM_NO_INDEX_USED             AS no_index_used,
                SUM_NO_GOOD_INDEX_USED        AS no_good_index_used,
                SUM_ROWS_EXAMINED             AS rows_examined,
                SUM_ROWS_SENT                 AS rows_sent,
                DATE_FORMAT(LAST_SEEN,'%Y-%m-%d %H:%i:%s') AS last_seen
            FROM performance_schema.events_statements_summary_by_digest
            WHERE (SCHEMA_NAME NOT IN
                   ('performance_schema','information_schema','mysql','sys')
                   OR SCHEMA_NAME IS NULL)
              AND (SUM_NO_INDEX_USED > 0 OR SUM_NO_GOOD_INDEX_USED > 0)
              AND DIGEST_TEXT IS NOT NULL
            ORDER BY (SUM_NO_INDEX_USED + SUM_NO_GOOD_INDEX_USED) * AVG_TIMER_WAIT DESC
            LIMIT 50
        """)
        result['no_index_queries'] = no_idx
        result['errors']['no_index_queries'] = None
    except Exception as e:
        result['errors']['no_index_queries'] = str(e)

    # ── 6. Missing Index Candidates ────────────────────────────────────
    # Build candidate list: tables that appear in no-index queries
    # Group by db+table extracted from digest text heuristically, or just surface the queries
    try:
        table_scan_count = defaultdict(lambda: {'count': 0, 'total_rows': 0, 'avg_sec': 0.0})
        for q in result.get('no_index_queries', []):
            db_name = q.get('db_name', '(all)')
            # Simple heuristic: extract first FROM/JOIN target from digest text
            import re
            sql = (q.get('sql_text') or '').upper()
            tables = re.findall(r'(?:FROM|JOIN)\s+`?(\w+)`?', sql)
            for t in tables:
                key = (db_name, t.lower())
                table_scan_count[key]['count']      += int(q.get('no_index_used', 0)) + int(q.get('no_good_index_used', 0))
                table_scan_count[key]['total_rows'] += int(q.get('rows_examined', 0))
                table_scan_count[key]['avg_sec']    = max(
                    table_scan_count[key]['avg_sec'],
                    float(q.get('avg_sec', 0))
                )

        # Build missing index candidates
        size_lookup = {
            (t['db_name'], t['table_name']): t
            for t in result['table_sizes']
        }
        existing_col_lookup = defaultdict(list)
        for idx in result['existing_indexes']:
            existing_col_lookup[(idx['db_name'], idx['table_name'])].append(idx)

        candidates = []
        for (db_name, tbl), stats in sorted(
            table_scan_count.items(), key=lambda x: -x[1]['count']
        ):
            size_info = size_lookup.get((db_name, tbl), {})
            existing = existing_col_lookup.get((db_name, tbl), [])
            existing_idx_names = [e['index_name'] for e in existing]
            candidates.append({
                'db_name':         db_name,
                'table_name':      tbl,
                'no_index_count':  stats['count'],
                'rows_examined':   stats['total_rows'],
                'worst_avg_sec':   round(stats['avg_sec'], 4),
                'table_rows':      size_info.get('row_estimate', None),
                'data_mb':         size_info.get('data_mb', None),
                'existing_indexes': existing_idx_names,
                'recommendation':  f"Analyze queries on `{tbl}` and add indexes on frequently filtered/joined columns.",
                'suggested_sql':   f"-- Identify frequent WHERE/JOIN columns on `{db_name}`.`{tbl}` and run:\n-- CREATE INDEX idx_{tbl}_<col> ON `{db_name}`.`{tbl}` (<col>);",
                'crud_impact': {
                    'select':  'Significant improvement expected (full scan → index seek)',
                    'insert':  'Minor overhead per insert for each new index',
                    'update':  'Minor overhead for indexed column updates',
                    'delete':  'Minimal overhead for delete operations',
                    'storage': 'Additional disk space per index (typically 10-30% of data size)',
                },
            })

        result['missing_index_candidates'] = candidates[:30]
        result['errors']['missing_index_candidates'] = None
    except Exception as e:
        result['errors']['missing_index_candidates'] = str(e)

    # ── 7. Summary ────────────────────────────────────────────────────
    result['summary'] = {
        'total_indexes':         len(result['existing_indexes']),
        'unused_count':          len(result['unused_indexes']),
        'duplicate_count':       len(result['duplicate_indexes']),
        'missing_candidates':    len(result['missing_index_candidates']),
        'no_index_queries':      len(result['no_index_queries']),
        'total_tables_analyzed': len(result['table_sizes']),
        'health_score': max(0, 100
            - len(result['unused_indexes'])    * 5
            - len(result['duplicate_indexes']) * 3
            - min(len(result['missing_index_candidates']) * 4, 40)
        ),
    }

    return result
