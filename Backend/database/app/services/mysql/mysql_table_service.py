from urllib.parse import quote_plus

from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster

_SKIP_DBS = frozenset({
    "information_schema", "performance_schema", "mysql", "sys", "innodb", "tmp",
})


# ── Internal helpers ──────────────────────────────────────────────────────────

def _engine(conn: ConnectionMaster):
    pw  = quote_plus(conn.password or "")
    usr = quote_plus(conn.username or "")
    url = (
        f"mysql+pymysql://{usr}:{pw}"
        f"@{conn.host}:{conn.port or 3306}/{conn.database_name or ''}"
    )
    from app.services.common import db_proxy_service
    return db_proxy_service.engine_for(conn, lambda: create_engine(
        url,
        connect_args={"connect_timeout": 15, "read_timeout": 30, "write_timeout": 30},
        pool_pre_ping=True,
    ))


def _rows(engine, sql: str, params=None) -> list:
    with engine.connect() as c:
        res  = c.execute(text(sql), params or {})
        cols = list(res.keys())
        return [dict(zip(cols, row)) for row in res.fetchall()]


def _scalar(engine, sql: str, params=None):
    with engine.connect() as c:
        return c.execute(text(sql), params or {}).scalar()


def _get_conn(conn_id: int, db: Session) -> ConnectionMaster:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, "Connection not found")
    return rec


def _human_size(b: float) -> str:
    b = float(b or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} PB"


def _iso(v):
    """A `datetime`/`date`, OR — when this query was routed through a host agent —
    a string already, since the agent's own JSON encoder (`json.dumps(..., default=str)`
    in actmon_agent.py's _dbquery) stringifies anything it can't serialize natively
    before this ever reaches the backend. A direct connection hands back the real
    object here; an agent-routed one hands back its str() already. Calling
    .isoformat() unconditionally crashed the WHOLE database list (one bad row
    aborts the loop) the moment any schema's CREATE_TIME/UPDATE_TIME was non-null
    on an agent-linked connection."""
    if v is None:
        return None
    return v.isoformat() if hasattr(v, "isoformat") else str(v)


def _norm_user(v: str) -> str:
    """GRANTEE arrives as `'root'@'localhost'`, DEFINER as `root@localhost`."""
    return (v or "").replace("'", "").replace("`", "")


def _schema_owners(engine) -> dict:
    """
    Best available "owner" per schema, and where it came from.

    MySQL has no schema owner (PostgreSQL's pg_database.datdba has no counterpart),
    so this derives one from two sources, in order of how directly each implies
    ownership:

      schema_privileges  a user holding privileges granted ON that schema
      object_definer     the user who DEFINERs the most views/routines/triggers/
                         events inside it

    Neither exists for a schema of plain tables whose users hold only GLOBAL
    grants, which is the common case for a root-only server — the owner is then
    genuinely unknown and reported as None rather than guessed.
    """
    owners: dict = {}

    try:
        for r in _rows(engine, """
            SELECT TABLE_SCHEMA AS db, GRANTEE AS who, COUNT(*) AS n
            FROM information_schema.SCHEMA_PRIVILEGES
            GROUP BY TABLE_SCHEMA, GRANTEE
            ORDER BY TABLE_SCHEMA, n DESC, GRANTEE
        """):
            owners.setdefault(r["db"], {
                "name": _norm_user(r["who"]), "source": "schema_privileges",
            })
    except Exception:
        pass  # reading SCHEMA_PRIVILEGES needs privileges of its own

    try:
        tally: dict = {}
        for r in _rows(engine, """
            SELECT TABLE_SCHEMA AS db, DEFINER AS who, COUNT(*) AS n
              FROM information_schema.VIEWS      GROUP BY 1, 2
            UNION ALL
            SELECT ROUTINE_SCHEMA, DEFINER, COUNT(*)
              FROM information_schema.ROUTINES   GROUP BY 1, 2
            UNION ALL
            SELECT TRIGGER_SCHEMA, DEFINER, COUNT(*)
              FROM information_schema.TRIGGERS   GROUP BY 1, 2
            UNION ALL
            SELECT EVENT_SCHEMA, DEFINER, COUNT(*)
              FROM information_schema.EVENTS     GROUP BY 1, 2
        """):
            by_user = tally.setdefault(r["db"], {})
            who = _norm_user(r["who"])
            by_user[who] = by_user.get(who, 0) + int(r["n"] or 0)
        for db_name, by_user in tally.items():
            if db_name in owners or not by_user:
                continue  # an explicit grant always outranks a definer
            # most objects wins; alphabetical tie-break keeps the answer stable
            top = sorted(by_user.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
            owners[db_name] = {"name": top, "source": "object_definer"}
    except Exception:
        pass

    return owners


# ═════════════════════════════════════════════════════════════════════════════
#  Service functions
# ═════════════════════════════════════════════════════════════════════════════

def get_databases(conn_id: int, db: Session) -> dict:
    """
    Full per-schema metadata for the Databases list.

    Two caveats are inherent to MySQL rather than to this code, so each derived
    field ships with the source it was derived from and the UI labels it:

      created_on  MySQL does not record when a schema was created. The oldest
                  table's CREATE_TIME is the closest available proxy, so
                  `created_on_source` is "oldest_table" (or None when the schema
                  has no tables and the date is simply unknown).
      owner       MySQL has no schema owner (unlike PostgreSQL's pg_database.datdba).
                  The grantee holding the most schema-level privileges is the
                  nearest equivalent; users who reach the schema through GLOBAL
                  grants (typically root) hold no schema-level rows and so cannot
                  be seen here — the owner is then reported as unknown.

    `status` is derived from what is actually knowable: a schema is "empty" when
    no BASE TABLE is visible to this connection's user, "active" otherwise.
    """
    conn = _get_conn(conn_id, db)
    try:
        engine = _engine(conn)

        # One pass over SCHEMATA + TABLES. LEFT JOIN so an empty schema still
        # appears (an INNER JOIN would silently drop it from the list).
        rows = _rows(engine, """
            SELECT s.SCHEMA_NAME                                  AS name,
                   s.DEFAULT_CHARACTER_SET_NAME                   AS charset,
                   s.DEFAULT_COLLATION_NAME                       AS collation,
                   COUNT(t.TABLE_NAME)                            AS tables,
                   COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS size_bytes,
                   COALESCE(SUM(t.DATA_LENGTH), 0)                AS data_bytes,
                   COALESCE(SUM(t.INDEX_LENGTH), 0)               AS index_bytes,
                   COALESCE(SUM(t.TABLE_ROWS), 0)                 AS row_estimate,
                   MIN(t.CREATE_TIME)                             AS created_on,
                   MAX(t.UPDATE_TIME)                             AS updated_on
            FROM information_schema.SCHEMATA s
            LEFT JOIN information_schema.TABLES t
                   ON t.TABLE_SCHEMA = s.SCHEMA_NAME
                  AND t.TABLE_TYPE   = 'BASE TABLE'
            GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME
            ORDER BY s.SCHEMA_NAME
        """)

        owners = _schema_owners(engine)

        databases = []
        for r in rows:
            name = r["name"]
            if (name or "").lower() in _SKIP_DBS:
                continue
            size_bytes = int(r["size_bytes"] or 0)
            tables     = int(r["tables"] or 0)
            created    = r["created_on"]
            owner      = owners.get(name)
            databases.append({
                "name":               name,
                "status":             "active" if tables else "empty",
                # keys below stay in sync with the frontend's DATABASE_COLUMNS
                "tables":             tables,
                "size_bytes":         size_bytes,
                "size_mb":            round(size_bytes / 1048576, 2),
                "size_human":         _human_size(size_bytes),
                "data_bytes":         int(r["data_bytes"] or 0),
                "index_bytes":        int(r["index_bytes"] or 0),
                "row_estimate":       int(r["row_estimate"] or 0),
                "created_on":         _iso(created),
                "created_on_source":  "oldest_table" if created else None,
                "updated_on":         _iso(r["updated_on"]),
                "owner":              owner["name"] if owner else None,
                "owner_source":       owner["source"] if owner else None,
                "charset":            r["charset"],
                "collation":          r["collation"],
            })
        return {"status": "success", "data": databases}
    except Exception as e:
        return {"status": "error", "error": str(e), "data": []}


def get_tables(conn_id: int, db_name: str, db: Session) -> dict:
    conn = _get_conn(conn_id, db)
    try:
        engine = _engine(conn)
        rows   = _rows(engine, """
            SELECT
                t.TABLE_NAME                                      AS name,
                t.TABLE_TYPE                                      AS type,
                t.ENGINE                                          AS engine,
                t.TABLE_ROWS                                      AS row_estimate,
                t.AVG_ROW_LENGTH                                  AS avg_row_len,
                t.DATA_LENGTH                                     AS data_bytes,
                t.INDEX_LENGTH                                    AS index_bytes,
                ROUND((t.DATA_LENGTH + t.INDEX_LENGTH)/1048576,3) AS total_mb,
                t.DATA_FREE                                       AS data_free,
                t.AUTO_INCREMENT                                  AS auto_increment,
                t.TABLE_COLLATION                                 AS collation,
                t.ROW_FORMAT                                      AS row_format,
                t.CREATE_TIME                                     AS create_time,
                t.UPDATE_TIME                                     AS update_time,
                t.TABLE_COMMENT                                   AS comment,
                (SELECT COUNT(*) FROM information_schema.COLUMNS c
                 WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA
                   AND c.TABLE_NAME  = t.TABLE_NAME)              AS col_count,
                (SELECT COUNT(*) FROM information_schema.STATISTICS s
                 WHERE s.TABLE_SCHEMA = t.TABLE_SCHEMA
                   AND s.TABLE_NAME  = t.TABLE_NAME
                   AND s.SEQ_IN_INDEX = 1)                        AS index_count
            FROM information_schema.TABLES t
            WHERE t.TABLE_SCHEMA = :db
            ORDER BY (t.DATA_LENGTH + t.INDEX_LENGTH) DESC, t.TABLE_NAME
        """, {"db": db_name})
        for r in rows:
            r["size_human"]  = _human_size((r.get("data_bytes") or 0) + (r.get("index_bytes") or 0))
            r["create_time"] = str(r["create_time"]) if r.get("create_time") else None
            r["update_time"] = str(r["update_time"]) if r.get("update_time") else None
        return {"status": "success", "database": db_name, "data": rows}
    except Exception as e:
        return {"status": "error", "error": str(e), "data": []}


def get_all_tables(conn_id: int, db: Session) -> dict:
    """Flat list of every table across all user databases (one query) — powers the
    PostgreSQL-style single-list Tables view."""
    conn = _get_conn(conn_id, db)
    try:
        engine = _engine(conn)
        skip = ",".join(f"'{s}'" for s in _SKIP_DBS)
        rows = _rows(engine, f"""
            SELECT
                t.TABLE_SCHEMA                                    AS `database`,
                t.TABLE_NAME                                      AS name,
                t.ENGINE                                          AS engine,
                t.TABLE_ROWS                                      AS row_estimate,
                t.DATA_LENGTH                                     AS data_bytes,
                t.INDEX_LENGTH                                    AS index_bytes,
                (t.DATA_LENGTH + t.INDEX_LENGTH)                  AS total_bytes,
                t.DATA_FREE                                       AS data_free,
                t.ROW_FORMAT                                      AS row_format,
                t.TABLE_COLLATION                                 AS collation,
                t.AUTO_INCREMENT                                  AS auto_increment,
                t.CREATE_TIME                                     AS create_time,
                t.UPDATE_TIME                                     AS update_time,
                (SELECT COUNT(*) FROM information_schema.COLUMNS c
                 WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME) AS col_count,
                (SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS s
                 WHERE s.TABLE_SCHEMA = t.TABLE_SCHEMA AND s.TABLE_NAME = t.TABLE_NAME)  AS index_count
            FROM information_schema.TABLES t
            WHERE t.TABLE_TYPE = 'BASE TABLE'
              AND t.TABLE_SCHEMA NOT IN ({skip})
            ORDER BY (t.DATA_LENGTH + t.INDEX_LENGTH) DESC, t.TABLE_NAME
        """)
        databases = []
        total_bytes = 0
        for r in rows:
            r["row_estimate"] = int(r.get("row_estimate") or 0)
            r["data_bytes"]   = int(r.get("data_bytes") or 0)
            r["index_bytes"]  = int(r.get("index_bytes") or 0)
            r["total_bytes"]  = int(r.get("total_bytes") or 0)
            r["col_count"]    = int(r.get("col_count") or 0)
            r["index_count"]  = int(r.get("index_count") or 0)
            r["size_human"]   = _human_size(r["total_bytes"])
            r["create_time"]  = str(r["create_time"]) if r.get("create_time") else None
            r["update_time"]  = str(r["update_time"]) if r.get("update_time") else None
            total_bytes += r["total_bytes"]
            if r["database"] not in databases:
                databases.append(r["database"])
        return {
            "status": "success",
            "data": rows,
            "tables": rows,
            "total_count": len(rows),
            "total_bytes": total_bytes,
            "total_size_human": _human_size(total_bytes),
            "databases": sorted(databases),
        }
    except Exception as e:
        return {"status": "error", "error": str(e), "data": [], "tables": [], "databases": []}


def get_table_detail(conn_id: int, db_name: str, table_name: str, db: Session) -> dict:
    conn   = _get_conn(conn_id, db)
    result = {
        "status": "success", "database": db_name, "table": table_name,
        "columns": [], "indexes": [], "constraints": [], "foreign_keys": [],
        "triggers": [], "status_info": {}, "partitions": [], "ddl": "", "errors": {},
    }
    try:
        engine = _engine(conn)
    except Exception as e:
        return {"status": "error", "error": str(e)}

    try:
        result["columns"] = _rows(engine, """
            SELECT
                ORDINAL_POSITION AS position,
                COLUMN_NAME      AS name,
                COLUMN_TYPE      AS type,
                DATA_TYPE        AS data_type,
                CHARACTER_MAXIMUM_LENGTH AS char_max_len,
                NUMERIC_PRECISION        AS num_precision,
                NUMERIC_SCALE            AS num_scale,
                IS_NULLABLE      AS nullable,
                COLUMN_DEFAULT   AS default_value,
                COLUMN_KEY       AS key_type,
                EXTRA            AS extra,
                COLUMN_COMMENT   AS comment,
                COLLATION_NAME   AS collation,
                CHARACTER_SET_NAME AS charset
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :tbl
            ORDER BY ORDINAL_POSITION
        """, {"db": db_name, "tbl": table_name})
    except Exception as e:
        result["errors"]["columns"] = str(e)

    try:
        idx_rows = _rows(engine, """
            SELECT
                INDEX_NAME   AS name,
                SEQ_IN_INDEX AS seq,
                COLUMN_NAME  AS column_name,
                NON_UNIQUE   AS non_unique,
                INDEX_TYPE   AS index_type,
                NULLABLE     AS nullable,
                CARDINALITY  AS cardinality,
                SUB_PART     AS sub_part,
                COMMENT      AS comment
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :tbl
            ORDER BY INDEX_NAME, SEQ_IN_INDEX
        """, {"db": db_name, "tbl": table_name})
        idx_map = {}
        for r in idx_rows:
            nm = r["name"]
            if nm not in idx_map:
                idx_map[nm] = {
                    "name": nm, "unique": not bool(r["non_unique"]),
                    "type": r["index_type"], "columns": [],
                    "cardinality": r["cardinality"], "comment": r["comment"],
                }
            idx_map[nm]["columns"].append({
                "name": r["column_name"], "seq": r["seq"],
                "sub_part": r["sub_part"], "nullable": r["nullable"],
            })
        result["indexes"] = list(idx_map.values())
    except Exception as e:
        result["errors"]["indexes"] = str(e)

    try:
        result["constraints"] = _rows(engine, """
            SELECT CONSTRAINT_NAME AS name, CONSTRAINT_TYPE AS type
            FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :tbl
            ORDER BY CONSTRAINT_TYPE, CONSTRAINT_NAME
        """, {"db": db_name, "tbl": table_name})
    except Exception as e:
        result["errors"]["constraints"] = str(e)

    try:
        result["foreign_keys"] = _rows(engine, """
            SELECT
                kcu.CONSTRAINT_NAME        AS name,
                kcu.COLUMN_NAME            AS column_name,
                kcu.ORDINAL_POSITION       AS position,
                kcu.REFERENCED_TABLE_SCHEMA AS ref_schema,
                kcu.REFERENCED_TABLE_NAME  AS ref_table,
                kcu.REFERENCED_COLUMN_NAME AS ref_column,
                rc.UPDATE_RULE             AS on_update,
                rc.DELETE_RULE             AS on_delete
            FROM information_schema.KEY_COLUMN_USAGE kcu
            JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
              ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
             AND rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
            WHERE kcu.TABLE_SCHEMA = :db AND kcu.TABLE_NAME = :tbl
              AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
            ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
        """, {"db": db_name, "tbl": table_name})
    except Exception as e:
        result["errors"]["foreign_keys"] = str(e)

    try:
        result["triggers"] = _rows(engine, """
            SELECT
                TRIGGER_NAME       AS name,
                EVENT_MANIPULATION AS event,
                ACTION_TIMING      AS timing,
                EVENT_OBJECT_TABLE AS table_name,
                DEFINER            AS definer,
                CREATED            AS created,
                ACTION_STATEMENT   AS body
            FROM information_schema.TRIGGERS
            WHERE EVENT_OBJECT_SCHEMA = :db AND EVENT_OBJECT_TABLE = :tbl
            ORDER BY ACTION_TIMING, EVENT_MANIPULATION
        """, {"db": db_name, "tbl": table_name})
        for t in result["triggers"]:
            if t.get("created"):
                t["created"] = str(t["created"])
    except Exception as e:
        result["errors"]["triggers"] = str(e)

    try:
        st_rows = _rows(engine, """
            SELECT ENGINE, TABLE_ROWS, AVG_ROW_LENGTH, DATA_LENGTH,
                INDEX_LENGTH, DATA_FREE, AUTO_INCREMENT, TABLE_COLLATION,
                ROW_FORMAT, CREATE_TIME, UPDATE_TIME, CHECK_TIME,
                CREATE_OPTIONS, TABLE_COMMENT
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :tbl
        """, {"db": db_name, "tbl": table_name})
        if st_rows:
            s = st_rows[0]
            total_bytes = (s.get("DATA_LENGTH") or 0) + (s.get("INDEX_LENGTH") or 0)
            s["total_size_human"] = _human_size(total_bytes)
            s["data_size_human"]  = _human_size(s.get("DATA_LENGTH") or 0)
            s["index_size_human"] = _human_size(s.get("INDEX_LENGTH") or 0)
            s["free_size_human"]  = _human_size(s.get("DATA_FREE") or 0)
            s["CREATE_TIME"] = str(s["CREATE_TIME"]) if s.get("CREATE_TIME") else None
            s["UPDATE_TIME"] = str(s["UPDATE_TIME"]) if s.get("UPDATE_TIME") else None
            s["CHECK_TIME"]  = str(s["CHECK_TIME"])  if s.get("CHECK_TIME")  else None
            result["status_info"] = s
    except Exception as e:
        result["errors"]["status_info"] = str(e)

    try:
        parts = _rows(engine, """
            SELECT PARTITION_NAME, SUBPARTITION_NAME, PARTITION_ORDINAL_POSITION,
                PARTITION_METHOD, PARTITION_EXPRESSION, PARTITION_DESCRIPTION,
                TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
            FROM information_schema.PARTITIONS
            WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :tbl
              AND PARTITION_NAME IS NOT NULL
            ORDER BY PARTITION_ORDINAL_POSITION
        """, {"db": db_name, "tbl": table_name})
        if parts:
            result["partitions"] = parts
    except Exception as e:
        result["errors"]["partitions"] = str(e)

    try:
        ddl_rows = _rows(engine, f"SHOW CREATE TABLE `{db_name}`.`{table_name}`")
        if ddl_rows:
            vals = list(ddl_rows[0].values())
            result["ddl"] = vals[1] if len(vals) > 1 else vals[0]
    except Exception as e:
        result["errors"]["ddl"] = str(e)

    return result


def get_table_sample_data(conn_id: int, db_name: str, table_name: str, db: Session) -> dict:
    conn = _get_conn(conn_id, db)
    try:
        engine    = _engine(conn)
        cols      = _rows(engine, """
            SELECT COLUMN_NAME AS name, DATA_TYPE AS type, COLUMN_KEY AS `key`
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :tbl
            ORDER BY ORDINAL_POSITION
        """, {"db": db_name, "tbl": table_name})
        col_names = [c["name"] for c in cols]
        rows      = _rows(engine, f"SELECT * FROM `{db_name}`.`{table_name}` LIMIT 100")

        safe_rows = []
        for row in rows:
            safe = {}
            for k, v in row.items():
                if v is None or isinstance(v, (int, float, str, bool)):
                    safe[k] = v
                else:
                    safe[k] = str(v)
            safe_rows.append(safe)

        total = None
        try:
            total = _scalar(engine, f"SELECT COUNT(*) FROM `{db_name}`.`{table_name}`")
        except Exception:
            pass

        return {
            "status": "success", "database": db_name, "table": table_name,
            "columns": cols, "col_names": col_names,
            "data": safe_rows, "returned": len(safe_rows), "total_rows": total,
        }
    except Exception as e:
        return {"status": "error", "error": str(e), "data": []}
