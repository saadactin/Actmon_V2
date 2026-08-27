"""
Oracle Storage Health — Phase 1 read-only collector.

Segment/partition inventory and size, plus an overview bundle for the
future Storage Health dashboard. No classification, no recommendations,
no mutating SQL here — that's the decision engine (Phase 2) and the
approval/execute workflow (Phase 3). Reuses the existing tablespace and
datafile collectors as-is rather than duplicating them.
"""

from sqlalchemy.orm import Session

from app.services.oracle.oracle_monitoring_service import (
    _get_conn_or_404, _get_engine, _rows,
    _safe_float, _safe_int, _safe_str,
    _SYSTEM_OWNERS,
    oracle_tablespaces, oracle_datafile_mounts,
)

_SEGMENT_TYPES = "'TABLE','INDEX','LOBSEGMENT','CLUSTER'"
_SEGMENT_LIMIT = 100
_PARTITION_LIMIT = 100


def oracle_storage_segments(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []

    segments = []
    try:
        raw = _rows(
            engine,
            f"""SELECT s.owner, s.segment_name, s.segment_type, s.tablespace_name,
                       ROUND(s.bytes/1024/1024, 2) AS size_mb, s.blocks,
                       t.num_rows, t.avg_row_len, t.row_movement, t.last_analyzed
                FROM dba_segments s
                LEFT JOIN dba_tables t
                       ON t.owner = s.owner AND t.table_name = s.segment_name
                      AND s.segment_type = 'TABLE'
                WHERE s.owner NOT IN ({_SYSTEM_OWNERS})
                  AND s.segment_type IN ({_SEGMENT_TYPES})
                ORDER BY s.bytes DESC
                FETCH FIRST {_SEGMENT_LIMIT} ROWS ONLY"""
        )
        segments = [
            {
                "owner":         _safe_str(r.get("OWNER")),
                "segment_name":  _safe_str(r.get("SEGMENT_NAME")),
                "segment_type":  _safe_str(r.get("SEGMENT_TYPE")),
                "tablespace_name": _safe_str(r.get("TABLESPACE_NAME")),
                "size_mb":       round(_safe_float(r.get("SIZE_MB")), 2),
                "blocks":        _safe_int(r.get("BLOCKS")),
                "num_rows":      _safe_int(r.get("NUM_ROWS")) if r.get("NUM_ROWS") is not None else None,
                "avg_row_len":   _safe_int(r.get("AVG_ROW_LEN")) if r.get("AVG_ROW_LEN") is not None else None,
                "row_movement":  _safe_str(r.get("ROW_MOVEMENT")) or None,
                "last_analyzed": _safe_str(r.get("LAST_ANALYZED")) or None,
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"segments: {exc}")

    total_segments = len(segments)
    try:
        raw = _rows(
            engine,
            f"""SELECT COUNT(*) AS cnt FROM dba_segments s
                WHERE s.owner NOT IN ({_SYSTEM_OWNERS})
                  AND s.segment_type IN ({_SEGMENT_TYPES})"""
        )
        total_segments = _safe_int(raw[0].get("CNT")) if raw else total_segments
    except Exception as exc:
        errors.append(f"segments_count: {exc}")

    return {
        "status":   "success",
        "segments": segments,
        "summary": {
            "returned":       len(segments),
            "total_segments": total_segments,
        },
        "errors": errors,
    }


def oracle_storage_partitions(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []

    partitions = []
    try:
        # HIGH_VALUE is a LONG column. Oracle forbids a LONG in the same query
        # block as ORDER BY/JOIN/GROUP BY/DISTINCT — ORA-00932 "inconsistent
        # datatypes: expected CHAR got LONG". A WITH-clause CTE doesn't reliably
        # dodge this: the optimizer can inline it back into one query block,
        # reproducing the exact same error. So this is two FULLY separate
        # queries: rank/limit first (no LONG column anywhere in it), then a
        # second, completely independent query — no JOIN, no ORDER BY, no
        # GROUP BY — fetches HIGH_VALUE only for the tables that made the cut.
        ranked = _rows(
            engine,
            f"""SELECT tp.table_owner AS owner, tp.table_name, tp.partition_name,
                       tp.num_rows, tp.last_analyzed,
                       ROUND(s.bytes/1024/1024, 2) AS size_mb
                FROM dba_tab_partitions tp
                LEFT JOIN dba_segments s
                       ON s.owner = tp.table_owner AND s.segment_name = tp.table_name
                      AND s.partition_name = tp.partition_name
                      AND s.segment_type = 'TABLE PARTITION'
                WHERE tp.table_owner NOT IN ({_SYSTEM_OWNERS})
                ORDER BY size_mb DESC NULLS LAST
                FETCH FIRST {_PARTITION_LIMIT} ROWS ONLY"""
        )

        high_values = {}
        table_pairs = {(r.get("OWNER"), r.get("TABLE_NAME")) for r in ranked}
        if table_pairs:
            params = {}
            tuples_sql = []
            for i, (owner, table) in enumerate(table_pairs):
                params[f"o{i}"] = owner
                params[f"t{i}"] = table
                tuples_sql.append(f"(:o{i}, :t{i})")
            hv_raw = _rows(
                engine,
                f"""SELECT tp2.table_owner AS owner, tp2.table_name, tp2.partition_name,
                           SUBSTR(tp2.high_value, 1, 500) AS high_value
                    FROM dba_tab_partitions tp2
                    WHERE (tp2.table_owner, tp2.table_name) IN ({', '.join(tuples_sql)})""",
                params,
            )
            for r in hv_raw:
                high_values[(r.get("OWNER"), r.get("TABLE_NAME"), r.get("PARTITION_NAME"))] = r.get("HIGH_VALUE")

        partitions = [
            {
                "owner":         _safe_str(r.get("OWNER")),
                "table_name":    _safe_str(r.get("TABLE_NAME")),
                "partition_name": _safe_str(r.get("PARTITION_NAME")),
                "high_value":    _safe_str(high_values.get((r.get("OWNER"), r.get("TABLE_NAME"), r.get("PARTITION_NAME")))) or None,
                "num_rows":      _safe_int(r.get("NUM_ROWS")) if r.get("NUM_ROWS") is not None else None,
                "last_analyzed": _safe_str(r.get("LAST_ANALYZED")) or None,
                "size_mb":       round(_safe_float(r.get("SIZE_MB")), 2) if r.get("SIZE_MB") is not None else None,
            }
            for r in ranked
        ]
    except Exception as exc:
        errors.append(f"partitions: {exc}")

    total_partitions = len(partitions)
    try:
        raw = _rows(
            engine,
            f"""SELECT COUNT(*) AS cnt FROM dba_tab_partitions tp
                WHERE tp.table_owner NOT IN ({_SYSTEM_OWNERS})"""
        )
        total_partitions = _safe_int(raw[0].get("CNT")) if raw else total_partitions
    except Exception as exc:
        errors.append(f"partitions_count: {exc}")

    return {
        "status":     "success",
        "partitions": partitions,
        "summary": {
            "returned":         len(partitions),
            "total_partitions": total_partitions,
        },
        "errors": errors,
    }


def oracle_storage_object_detail(conn_id: int, db: Session, object_type: str, owner: str, name: str):
    """Single-object snapshot used by Phase 3 to capture before/after metrics
    around an approved maintenance execution. Same query shape as
    oracle_storage_segments()/oracle_index_analysis(), just narrowed to one
    row via owner/name instead of a top-N scan."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    try:
        if object_type == "segment":
            raw = _rows(
                engine,
                """SELECT s.owner, s.segment_name, s.segment_type, s.tablespace_name,
                          ROUND(s.bytes/1024/1024, 2) AS size_mb, s.blocks,
                          t.num_rows, t.avg_row_len, t.row_movement, t.last_analyzed
                   FROM dba_segments s
                   LEFT JOIN dba_tables t ON t.owner = s.owner AND t.table_name = s.segment_name
                   WHERE s.owner = :o AND s.segment_name = :n AND s.segment_type = 'TABLE'""",
                {"o": owner, "n": name},
            )
            if not raw:
                return {"status": "error", "error": "segment not found"}
            r = raw[0]
            return {
                "status": "success",
                "owner":         _safe_str(r.get("OWNER")),
                "segment_name":  _safe_str(r.get("SEGMENT_NAME")),
                "segment_type":  _safe_str(r.get("SEGMENT_TYPE")),
                "tablespace_name": _safe_str(r.get("TABLESPACE_NAME")),
                "size_mb":       round(_safe_float(r.get("SIZE_MB")), 2),
                "blocks":        _safe_int(r.get("BLOCKS")),
                "num_rows":      _safe_int(r.get("NUM_ROWS")) if r.get("NUM_ROWS") is not None else None,
                "avg_row_len":   _safe_int(r.get("AVG_ROW_LEN")) if r.get("AVG_ROW_LEN") is not None else None,
                "row_movement":  _safe_str(r.get("ROW_MOVEMENT")) or None,
                "last_analyzed": _safe_str(r.get("LAST_ANALYZED")) or None,
            }
        elif object_type == "index":
            raw = _rows(
                engine,
                """SELECT owner, index_name, table_name, status, blevel, leaf_blocks
                   FROM dba_indexes WHERE owner = :o AND index_name = :n""",
                {"o": owner, "n": name},
            )
            if not raw:
                return {"status": "error", "error": "index not found"}
            r = raw[0]
            return {
                "status": "success",
                "owner":         _safe_str(r.get("OWNER")),
                "index_name":    _safe_str(r.get("INDEX_NAME")),
                "table_name":    _safe_str(r.get("TABLE_NAME")),
                "index_status":  _safe_str(r.get("STATUS")),
                "blevel":        _safe_int(r.get("BLEVEL")),
                "leaf_blocks":   _safe_int(r.get("LEAF_BLOCKS")),
            }
        else:
            return {"status": "error", "error": f"unsupported object_type: {object_type}"}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def _db_block_size(engine) -> int:
    rows = _rows(engine, "SELECT value FROM v$parameter WHERE name='db_block_size'")
    return _safe_int(rows[0].get("VALUE")) if rows else 8192


def oracle_storage_block_detail(conn_id: int, db: Session, object_type: str, **kwargs):
    """Real block-level space accounting for one storage object, fetched
    on demand when the user drills into a datafile/tablespace/segment row —
    not part of the flat overview/findings payloads.

    datafile:   DBA_DATA_FILES row for file_id, joined against DBA_FREE_SPACE
                (same file_id) for real free-block counts. No OUT-params, so
                this works over the agent-proxy same as everything else here.
    tablespace: same math, aggregated (GROUP BY) across every datafile that
                belongs to the tablespace, plus the list of those datafiles.
    segment:    delegates to oracle_storage_object_detail(), which already
                returns real dba_segments.blocks — nothing new to query.
    """
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []

    block_size = 8192
    try:
        block_size = _db_block_size(engine)
    except Exception as exc:
        errors.append(f"block_size: {exc}")

    if object_type == "datafile":
        file_id   = kwargs.get("file_id")
        file_name = kwargs.get("file_name")
        try:
            if file_id:
                raw = _rows(
                    engine,
                    """SELECT df.file_id, df.tablespace_name, df.file_name,
                              df.bytes, df.blocks, df.autoextensible, df.maxbytes, df.status
                       FROM dba_data_files df WHERE df.file_id = :fid""",
                    {"fid": file_id},
                )
            else:
                # Datafile findings only carry the file's name (dba_data_files
                # has no natural short key besides file_id) — look it up by name.
                raw = _rows(
                    engine,
                    """SELECT df.file_id, df.tablespace_name, df.file_name,
                              df.bytes, df.blocks, df.autoextensible, df.maxbytes, df.status
                       FROM dba_data_files df WHERE df.file_name = :fn""",
                    {"fn": file_name},
                )
            if not raw:
                return {"status": "error", "error": "datafile not found", "errors": errors}
            r = raw[0]
            total_bytes  = _safe_int(r.get("BYTES"))
            total_blocks = _safe_int(r.get("BLOCKS"))

            free_bytes, free_blocks = 0, 0
            try:
                fs = _rows(
                    engine,
                    """SELECT NVL(SUM(bytes),0) AS free_bytes, NVL(SUM(blocks),0) AS free_blocks
                       FROM dba_free_space WHERE file_id = :fid""",
                    {"fid": file_id},
                )
                if fs:
                    free_bytes  = _safe_int(fs[0].get("FREE_BYTES"))
                    free_blocks = _safe_int(fs[0].get("FREE_BLOCKS"))
            except Exception as exc:
                errors.append(f"free_space: {exc}")

            used_bytes  = max(total_bytes - free_bytes, 0)
            used_blocks = max(total_blocks - free_blocks, 0)
            return {
                "status":       "success",
                "object_type":  "datafile",
                "block_size":   block_size,
                "file_id":      _safe_int(r.get("FILE_ID")),
                "file_name":    _safe_str(r.get("FILE_NAME")),
                "tablespace_name": _safe_str(r.get("TABLESPACE_NAME")),
                "status_":      _safe_str(r.get("STATUS")),
                "autoextend":   _safe_str(r.get("AUTOEXTENSIBLE")),
                "max_bytes":    _safe_int(r.get("MAXBYTES")) or None,
                "size_bytes":   total_bytes,
                "blocks": {
                    "total": total_blocks,
                    "free":  free_blocks,
                    "used":  used_blocks,
                    "used_pct": round(used_blocks / total_blocks * 100, 1) if total_blocks else 0.0,
                },
                "free_bytes":   free_bytes,
                "used_bytes":   used_bytes,
                "errors": errors,
            }
        except Exception as exc:
            return {"status": "error", "error": str(exc), "errors": errors}

    elif object_type == "tablespace":
        ts_name = kwargs.get("tablespace_name")
        try:
            raw = _rows(
                engine,
                """SELECT tablespace_name, SUM(bytes) AS total_bytes, SUM(blocks) AS total_blocks
                   FROM dba_data_files WHERE tablespace_name = :ts
                   GROUP BY tablespace_name""",
                {"ts": ts_name},
            )
            if not raw:
                return {"status": "error", "error": "tablespace not found", "errors": errors}
            r = raw[0]
            total_bytes  = _safe_int(r.get("TOTAL_BYTES"))
            total_blocks = _safe_int(r.get("TOTAL_BLOCKS"))

            free_bytes, free_blocks = 0, 0
            try:
                fs = _rows(
                    engine,
                    """SELECT NVL(SUM(bytes),0) AS free_bytes, NVL(SUM(blocks),0) AS free_blocks
                       FROM dba_free_space WHERE tablespace_name = :ts""",
                    {"ts": ts_name},
                )
                if fs:
                    free_bytes  = _safe_int(fs[0].get("FREE_BYTES"))
                    free_blocks = _safe_int(fs[0].get("FREE_BLOCKS"))
            except Exception as exc:
                errors.append(f"free_space: {exc}")

            datafiles = []
            try:
                df_raw = _rows(
                    engine,
                    """SELECT file_id, file_name, bytes, blocks, status
                       FROM dba_data_files WHERE tablespace_name = :ts ORDER BY file_name""",
                    {"ts": ts_name},
                )
                datafiles = [
                    {
                        "file_id":    _safe_int(d.get("FILE_ID")),
                        "file_name":  _safe_str(d.get("FILE_NAME")),
                        "size_bytes": _safe_int(d.get("BYTES")),
                        "blocks":     _safe_int(d.get("BLOCKS")),
                        "status":     _safe_str(d.get("STATUS")),
                    }
                    for d in df_raw
                ]
            except Exception as exc:
                errors.append(f"datafiles: {exc}")

            used_bytes  = max(total_bytes - free_bytes, 0)
            used_blocks = max(total_blocks - free_blocks, 0)
            return {
                "status":       "success",
                "object_type":  "tablespace",
                "block_size":   block_size,
                "tablespace_name": _safe_str(r.get("TABLESPACE_NAME")),
                "size_bytes":   total_bytes,
                "blocks": {
                    "total": total_blocks,
                    "free":  free_blocks,
                    "used":  used_blocks,
                    "used_pct": round(used_blocks / total_blocks * 100, 1) if total_blocks else 0.0,
                },
                "free_bytes":   free_bytes,
                "used_bytes":   used_bytes,
                "datafiles":    datafiles,
                "errors": errors,
            }
        except Exception as exc:
            return {"status": "error", "error": str(exc), "errors": errors}

    elif object_type == "segment":
        owner = kwargs.get("owner")
        name  = kwargs.get("name")
        detail = oracle_storage_object_detail(conn_id, db, "segment", owner, name)
        if detail.get("status") != "success":
            detail["errors"] = errors
            return detail
        detail["object_type"] = "segment"
        detail["block_size"]  = block_size
        detail["size_bytes"]  = int(round(_safe_float(detail.get("size_mb")) * 1024 * 1024))
        detail["errors"] = errors + (detail.get("errors") or [])
        return detail

    else:
        return {"status": "error", "error": f"unsupported object_type: {object_type}", "errors": errors}


_TABLE_DICT_GROUPS = [
    {
        "id": "identity",
        "label": "Identity & Location",
        "columns": ["owner", "table_name", "tablespace_name", "cluster_name", "iot_name",
                    "status", "partitioned", "temporary", "secondary", "nested", "dropped", "read_only"],
    },
    {
        "id": "storage",
        "label": "Storage Parameters",
        "columns": ["pct_free", "pct_used", "ini_trans", "max_trans", "initial_extent", "next_extent",
                    "min_extents", "max_extents", "pct_increase", "freelists", "freelist_groups", "buffer_pool"],
    },
    {
        "id": "statistics",
        "label": "Statistics",
        "columns": ["num_rows", "blocks", "empty_blocks", "avg_space", "chain_cnt", "avg_row_len",
                    "avg_space_freelist_blocks", "num_freelist_blocks", "sample_size", "last_analyzed",
                    "global_stats", "user_stats", "monitoring"],
    },
    {
        "id": "behavior",
        "label": "Behavior & Options",
        "columns": ["degree", "instances", "cache", "table_lock", "logging", "row_movement",
                    "compression", "compress_for", "duration", "skip_corrupt", "result_cache"],
    },
]
_TABLE_DICT_ALL_COLUMNS = [c for g in _TABLE_DICT_GROUPS for c in g["columns"]]


def oracle_table_dictionary(conn_id: int, db: Session, owner: str, table_name: str):
    """The real DBA_TABLES row for one table, exactly as Oracle's data
    dictionary reports it — every column real, nothing derived or estimated.
    Grouped into the same 4 sections the frontend steps through (identity,
    storage parameters, statistics, behavior/options) so a ~30-column raw
    dictionary row is navigable instead of one giant dump. No LONG columns
    are involved (DBA_TABLES has none), so this is a single plain SELECT."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    try:
        cols_sql = ", ".join(_TABLE_DICT_ALL_COLUMNS)
        raw = _rows(
            engine,
            f"SELECT {cols_sql} FROM dba_tables WHERE owner = :o AND table_name = :t",
            {"o": owner, "t": table_name},
        )
        if not raw:
            return {"status": "error", "error": "table not found in DBA_TABLES"}
        r = raw[0]
        fields = {
            c: (_safe_str(r.get(c.upper())).strip() if r.get(c.upper()) is not None else None)
            for c in _TABLE_DICT_ALL_COLUMNS
        }
        groups = [
            {"id": g["id"], "label": g["label"], "fields": {c: fields[c] for c in g["columns"]}}
            for g in _TABLE_DICT_GROUPS
        ]
        return {"status": "success", "owner": owner, "table_name": table_name, "groups": groups}
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def oracle_storage_overview(conn_id: int, db: Session):
    """Bundles tablespaces + datafiles + top segments in one call, mirroring
    oracle_dashboard()'s bundling pattern, so the Storage Health dashboard
    doesn't need separate round-trips for its summary cards."""
    ts_resp   = oracle_tablespaces(conn_id, db)
    df_resp   = oracle_datafile_mounts(conn_id, db)
    seg_resp  = oracle_storage_segments(conn_id, db)

    errors = []
    if ts_resp.get("status") != "success":
        errors.append(f"tablespaces: {ts_resp.get('error', 'failed')}")
    errors.extend(df_resp.get("errors") or [])
    errors.extend(seg_resp.get("errors") or [])

    return {
        "status":       "success",
        "tablespaces":  ts_resp.get("tablespaces", []),
        "datafiles":    df_resp.get("datafiles", []),
        "top_segments": seg_resp.get("segments", []),
        "summary": {
            "total_tablespaces": ts_resp.get("total", 0),
            "critical_tablespaces": len(ts_resp.get("critical") or []),
            "warning_tablespaces":  len(ts_resp.get("warning") or []),
            "total_datafiles":   len(df_resp.get("datafiles") or []),
            "segments_returned": seg_resp.get("summary", {}).get("returned", 0),
            "total_segments":    seg_resp.get("summary", {}).get("total_segments", 0),
        },
        "errors": errors,
    }
