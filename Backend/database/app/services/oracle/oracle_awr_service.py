"""Oracle AWR Analyzer: upload, parse, persist, and serve AWR reports.

Ported engine (parser/rule_engine — see app/services/oracle/awr/) from the
standalone oracle-awr-analyzer project, wired into ACTMON's own org-scoping and
Postgres conventions instead of that project's Flask + flat-JSON-file job store.
Parsing runs inline on upload — one BeautifulSoup pass per file — so there is no
Celery/Redis here, matching the rest of this backend.

A report belongs to an organisation. Linking it to a monitored Oracle connection
is optional: an AWR report identifies its own database (DB name, host, snapshot
ids are inside the file), and reports are routinely pulled from databases that
are not registered for live monitoring here.

The source project's ML risk score and workload forecaster are intentionally not
ported: the model is trained on 7 examples with labels derived from its own rule
engine (in-sample metrics only), and the forecaster is always fed one snapshot,
so neither can produce a trustworthy number.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime
from functools import lru_cache
from pathlib import Path

from fastapi import UploadFile
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.oracle_awr_model import OracleAwrFinding, OracleAwrMetric, OracleAwrReport, OracleAwrSqlStat
from app.services.oracle.awr.diagnosis import RULES_VERSION, diagnose
from app.services.oracle.awr.metrics import METRICS_VERSION, extract
from app.services.oracle.awr.parser import ProductionAWRParser
from app.services.oracle.awr.sql_stats import sql_profile

# Real AWR HTML is 1-3 MB; the cap bounds BeautifulSoup's parse time and memory.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
ALLOWED_EXTENSIONS = {".html", ".htm"}

AWR_STORAGE_ROOT = Path(__file__).resolve().parents[2] / "data" / "awr"


class AwrInputError(ValueError):
    """A problem with what the caller sent — reported back, never a 500."""


def _oracle_connection(connection_id: int, org_id: int | None, db: Session) -> ConnectionMaster | None:
    q = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "oracle",
    )
    if org_id is not None:
        q = q.filter(ConnectionMaster.org_id == org_id)
    return q.first()


def _safe_filename(original: str | None) -> str:
    name = os.path.basename((original or "").replace("\\", "/")) or "report.html"
    return name.replace("..", "_")[:250]


def _iso_or_none(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def database_key(facts, db_name: str | None) -> str | None:
    """Reports of one database share a key; RAC instances stay separate."""
    if facts.dbid:
        return f"{facts.dbid}:{facts.instance_number}" if facts.rac and facts.instance_number else facts.dbid
    return f"name:{db_name}" if db_name and db_name != "UNKNOWN" else None


def _parse_and_record(report_row: OracleAwrReport, html_text: str, db: Session) -> None:
    try:
        parser = ProductionAWRParser(html_text)
        awr = parser.parse_all()
        parser._awr_cache = awr
        tables = parser.summary_tables()
        window = parser.parse_window()
        ex = extract(parser)
        if not window["begin_snap"] and not ex.metrics:
            raise ValueError("Not an Oracle AWR HTML report: no snapshot information or AWR sections were found.")

        facts = ex.facts
        report_row.db_name = facts.db_name or awr.header.db_name
        report_row.dbid = facts.dbid
        report_row.db_release = facts.release
        report_row.is_rac = facts.rac
        report_row.platform = facts.platform
        report_row.num_cpus = facts.num_cpus
        report_row.host_mem_gb = facts.host_mem_gb
        report_row.instance_name = facts.instance_name or awr.header.instance_name
        report_row.instance_number = facts.instance_number or awr.header.instance_number
        report_row.host_name = facts.host_name or awr.header.host_name
        report_row.begin_snap = facts.snap_begin_id or awr.header.begin_snap or window["begin_snap"]
        report_row.end_snap = facts.snap_end_id or awr.header.end_snap or window["end_snap"]
        report_row.begin_time = _iso_or_none(window["begin_time"])
        report_row.end_time = _iso_or_none(window["end_time"])
        report_row.elapsed_minutes = facts.elapsed_minutes or awr.header.elapsed_minutes or window["elapsed_minutes"]
        report_row.db_time_minutes = facts.db_time_minutes or window["db_time_minutes"]
        report_row.database_key = database_key(facts, report_row.db_name)
        report_row.data_quality = {**ex.data_quality, "instance_startup": facts.instance_startup}
        report_row.parser_version = f"{METRICS_VERSION}/{RULES_VERSION}"

        for m in ex.metrics:
            db.add(OracleAwrMetric(
                org_id=report_row.org_id, report_id=report_row.id, database_key=report_row.database_key,
                metric_key=m.key, value=m.value, unit=m.unit, category=m.category, label=m.label,
                source_section=m.source, interval_start=report_row.begin_time, interval_end=report_row.end_time,
            ))

        sqls = sql_profile(parser)
        for rec in sqls.values():
            db.add(OracleAwrSqlStat(org_id=report_row.org_id, report_id=report_row.id,
                                    database_key=report_row.database_key, **rec))

        findings = diagnose(ex, awr, tables, sqls)
        for f in findings:
            db.add(OracleAwrFinding(
                report_id=report_row.id, org_id=report_row.org_id, database_key=report_row.database_key,
                rule_id=f.rule_id, finding_type=f.finding_type, source="rule",
                severity=f.severity, risk_level=f.risk_level, category=f.category, title=f.title[:500],
                evidence=f.evidence, recommendation=f.recommendation,
                snapshot_start=report_row.begin_time, snapshot_end=report_row.end_time,
                observed_metrics=f.observed,
                evidence_refs=[{"report_id": report_row.id, **r} for r in f.refs],
                probable_causes=f.causes, recommended_actions=f.actions,
                confidence_method=f.rule, data_quality=ex.data_quality["level"], model_version=RULES_VERSION,
                status="open",
            ))
        report_row.high_findings = sum(1 for f in findings if f.severity == "HIGH")
        report_row.medium_findings = sum(1 for f in findings if f.severity == "MEDIUM")
        report_row.low_findings = sum(1 for f in findings if f.severity == "LOW")
        report_row.status = "PARSED"
        report_row.error_message = None
        report_row.parsed_at = datetime.utcnow()
    except Exception as exc:  # noqa: BLE001 — malformed/unsupported AWR HTML must not 500 the request
        report_row.status = "FAILED"
        report_row.error_message = str(exc)[:2000]


def reanalyze_report(report_id: int, org_id: int | None, db: Session) -> dict:
    """Re-run extraction and diagnosis on a stored report (e.g. after a parser
    improvement). Idempotent. A DBA's status/outcome note on a finding survives
    when the same rule fires again."""
    row = _report_row(report_id, org_id, db)
    if not row:
        return {"status": "error", "error": "Report not found"}
    path = Path(row.stored_path)
    if not path.is_file():
        return {"status": "error", "error": "The uploaded file is no longer on disk"}

    kept = {
        f.rule_id: (f.status, f.outcome_note)
        for f in db.query(OracleAwrFinding).filter(
            OracleAwrFinding.report_id == report_id, OracleAwrFinding.source == "rule"
        )
        if f.rule_id and (f.status not in (None, "open") or f.outcome_note)
    }
    db.query(OracleAwrFinding).filter(
        OracleAwrFinding.report_id == report_id,
        (OracleAwrFinding.source == "rule") | (OracleAwrFinding.source.is_(None)),
    ).delete(synchronize_session=False)
    db.query(OracleAwrMetric).filter(OracleAwrMetric.report_id == report_id).delete(synchronize_session=False)
    db.query(OracleAwrSqlStat).filter(OracleAwrSqlStat.report_id == report_id).delete(synchronize_session=False)
    db.flush()

    _parse_and_record(row, path.read_bytes().decode("utf-8", errors="replace"), db)
    db.flush()
    for f in db.query(OracleAwrFinding).filter(OracleAwrFinding.report_id == report_id, OracleAwrFinding.rule_id.in_(list(kept))):
        f.status, f.outcome_note = kept[f.rule_id]
    db.commit()
    db.refresh(row)
    _parse_stored.cache_clear()
    return {"status": "ok", "report": _report_summary(row)}


def ingest_report(
    *,
    org_id: int,
    filename: str | None,
    contents: bytes,
    db: Session,
    connection_id: int | None = None,
    batch_id: str | None = None,
    uploaded_by: str | None = None,
    created_at: datetime | None = None,
) -> OracleAwrReport:
    """Validate, store and analyse one AWR file. Raises AwrInputError on bad input."""
    name = _safe_filename(filename)
    if Path(name).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise AwrInputError(f"{name}: only .html/.htm AWR report files are accepted")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise AwrInputError(f"{name}: exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload limit")
    if not contents.strip():
        raise AwrInputError(f"{name}: the file is empty")
    if connection_id is not None and not _oracle_connection(connection_id, org_id, db):
        raise AwrInputError("Oracle connection not found")

    digest = hashlib.sha256(contents).hexdigest()
    existing = (
        db.query(OracleAwrReport)
        .filter(OracleAwrReport.org_id == org_id, OracleAwrReport.file_sha256 == digest)
        .first()
    )
    if existing:
        raise AwrInputError(f"{name} was already uploaded (as {existing.original_filename})")

    dest_dir = AWR_STORAGE_ROOT / str(org_id) / (str(connection_id) if connection_id else "unassigned")
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / f"{uuid.uuid4().hex}{Path(name).suffix.lower()}"
    dest_path.write_bytes(contents)

    report_row = OracleAwrReport(
        org_id=org_id,
        connection_id=connection_id,
        batch_id=batch_id,
        original_filename=name,
        stored_path=str(dest_path),
        file_size_bytes=len(contents),
        file_sha256=digest,
        status="PENDING",
        uploaded_by=uploaded_by,
    )
    if created_at:
        report_row.created_at = created_at
    db.add(report_row)
    db.flush()  # assign report_row.id before findings reference it

    _parse_and_record(report_row, contents.decode("utf-8", errors="replace"), db)
    db.commit()
    db.refresh(report_row)
    return report_row


async def upload_and_analyze(
    org_id: int,
    file: UploadFile,
    uploaded_by: str | None,
    db: Session,
    connection_id: int | None = None,
    batch_id: str | None = None,
) -> dict:
    # Read one byte past the limit so an oversized upload is refused without
    # buffering the whole thing.
    contents = await file.read(MAX_UPLOAD_BYTES + 1)
    try:
        row = ingest_report(
            org_id=org_id, filename=file.filename, contents=contents, db=db,
            connection_id=connection_id, batch_id=batch_id, uploaded_by=uploaded_by,
        )
    except AwrInputError as exc:
        db.rollback()
        return {"status": "error", "error": str(exc)}
    return {"status": "ok", "report": _report_summary(row)}


def _report_summary(r: OracleAwrReport) -> dict:
    return {
        "id": r.id,
        "org_id": r.org_id,
        "connection_id": r.connection_id,
        "batch_id": r.batch_id,
        "original_filename": r.original_filename,
        "file_size_bytes": r.file_size_bytes,
        "database_key": r.database_key,
        "db_name": r.db_name,
        "dbid": r.dbid,
        "db_release": r.db_release,
        "is_rac": r.is_rac,
        "platform": r.platform,
        "num_cpus": r.num_cpus,
        "host_mem_gb": r.host_mem_gb,
        "data_quality": r.data_quality,
        "parser_version": r.parser_version,
        "instance_name": r.instance_name,
        "instance_number": r.instance_number,
        "host_name": r.host_name,
        "begin_snap": r.begin_snap,
        "end_snap": r.end_snap,
        "begin_time": r.begin_time.isoformat() if r.begin_time else None,
        "end_time": r.end_time.isoformat() if r.end_time else None,
        "elapsed_minutes": r.elapsed_minutes,
        "db_time_minutes": r.db_time_minutes,
        "status": r.status,
        "error_message": r.error_message,
        "high_findings": r.high_findings,
        "medium_findings": r.medium_findings,
        "low_findings": r.low_findings,
        "uploaded_by": r.uploaded_by,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "parsed_at": r.parsed_at.isoformat() if r.parsed_at else None,
    }


def _report_row(report_id: int, org_id: int | None, db: Session) -> OracleAwrReport | None:
    q = db.query(OracleAwrReport).filter(OracleAwrReport.id == report_id)
    if org_id is not None:
        q = q.filter(OracleAwrReport.org_id == org_id)
    return q.first()


def list_reports(org_id: int | None, db: Session, connection_id: int | None = None) -> dict:
    q = db.query(OracleAwrReport)
    if org_id is not None:
        q = q.filter(OracleAwrReport.org_id == org_id)
    if connection_id is not None:
        q = q.filter(OracleAwrReport.connection_id == connection_id)
    # Newest snapshot first: the order a DBA reads a run of AWR windows in.
    rows = q.order_by(
        OracleAwrReport.begin_time.desc().nulls_last(), OracleAwrReport.created_at.desc()
    ).all()
    return {"status": "ok", "reports": [_report_summary(r) for r in rows]}


def get_report(report_id: int, org_id: int | None, db: Session) -> dict:
    row = _report_row(report_id, org_id, db)
    if not row:
        return {"status": "error", "error": "Report not found"}
    findings = (
        db.query(OracleAwrFinding)
        .filter(OracleAwrFinding.report_id == report_id)
        .order_by(OracleAwrFinding.id.asc())
        .all()
    )
    return {"status": "ok", "report": _report_summary(row), "findings": [finding_dict(f) for f in findings]}


_SEVERITY_ORDER = {"HIGH": 0, "MEDIUM": 1, "LOW": 2, "INFO": 3}


def finding_dict(f: OracleAwrFinding) -> dict:
    iso = lambda d: d.isoformat() if d else None  # noqa: E731
    return {
        "id": f.id, "finding_type": f.finding_type or "diagnosis", "source": f.source or "rule",
        "rule_id": f.rule_id, "severity": f.severity, "risk_level": f.risk_level,
        "category": f.category, "title": f.title, "evidence": f.evidence, "recommendation": f.recommendation,
        "database_id": f.database_key, "report_id": f.report_id,
        "snapshot_start": iso(f.snapshot_start), "snapshot_end": iso(f.snapshot_end),
        "observed_metrics": f.observed_metrics, "baseline_metrics": f.baseline_metrics,
        "evidence_refs": f.evidence_refs, "probable_causes": f.probable_causes,
        "recommended_actions": f.recommended_actions,
        "forecast_horizon": f.forecast_horizon, "predicted_value": f.predicted_value,
        "prediction_interval": f.prediction_interval, "confidence_method": f.confidence_method,
        "data_quality": f.data_quality, "model_version": f.model_version,
        "status": f.status or "open", "outcome_note": f.outcome_note,
        "created_at": iso(f.created_at), "updated_at": iso(f.updated_at),
    }


@lru_cache(maxsize=16)
def _parse_stored(stored_path: str):
    # Stored uploads are immutable (uuid file names), so a path is a safe cache key.
    html_text = Path(stored_path).read_text(encoding="utf-8", errors="replace")
    return ProductionAWRParser(html_text).parse_all()


def get_report_insights(report_id: int, org_id: int | None, db: Session) -> dict:
    row = _report_row(report_id, org_id, db)
    if not row:
        return {"status": "error", "error": "Report not found"}
    if row.status != "PARSED":
        return {"status": "error", "error": f"Report is not parsed (status={row.status})"}
    if not Path(row.stored_path).is_file():
        return {"status": "error", "error": "The uploaded file is no longer on disk"}

    awr = _parse_stored(row.stored_path)
    to_float = ProductionAWRParser._to_float

    sql = []
    for s in awr.sql_by_elapsed_time[:10]:
        per_exec = to_float(s.raw.get("elapsed_time_per_exec_s"))
        if per_exec is None and s.elapsed_time_seconds and s.executions:
            per_exec = s.elapsed_time_seconds / s.executions
        sql.append({
            "sql_id": s.sql_id,
            "sql_text": (s.sql_text or "")[:160] or None,
            "module": s.raw.get("sql_module") or None,
            "elapsed_seconds": s.elapsed_time_seconds,
            "executions": s.executions,
            "elapsed_per_exec_seconds": per_exec,
            # 12c+ "SQL ordered by Elapsed Time" reports %CPU / %IO of elapsed,
            # not seconds.
            "cpu_pct": to_float(s.raw.get("cpu")),
            "io_pct": to_float(s.raw.get("io")),
        })

    return {
        "status": "ok",
        "wait_events": [
            {
                "name": e.name,
                "wait_class": e.wait_class or ("CPU" if e.name.lower() == "db cpu" else None),
                "percent_db_time": e.percent_db_time,
                "avg_wait_ms": e.avg_wait_ms,
                "waits": e.waits,
            }
            for e in awr.top_wait_events[:10]
        ],
        "top_sql": sql,
        "instance_efficiency": [{"name": m.name.rstrip(":").strip(), "value": m.value} for m in awr.instance_efficiency],
        "load_profile": [{"name": m.name.rstrip(":").strip(), "per_second": m.value} for m in awr.load_profile[:12]],
    }


def get_report_file(report_id: int, org_id: int | None, db: Session) -> OracleAwrReport | None:
    row = _report_row(report_id, org_id, db)
    return row if row and Path(row.stored_path).is_file() else None


def delete_report(report_id: int, org_id: int | None, db: Session) -> dict:
    row = _report_row(report_id, org_id, db)
    if not row:
        return {"status": "error", "error": "Report not found"}
    stored = Path(row.stored_path)
    info = {"database_key": row.database_key, "org_id": row.org_id, "original_filename": row.original_filename}
    # every finding anchored to this report (rule, statistics, llm); the
    # database's history is rebuilt by the caller afterwards
    db.query(OracleAwrFinding).filter(OracleAwrFinding.report_id == report_id).delete()
    db.delete(row)  # metrics and SQL stats cascade; forecasts keep their history (SET NULL)
    db.commit()
    # Only ever unlink inside our own storage root.
    if stored.is_file() and AWR_STORAGE_ROOT.resolve() in stored.resolve().parents:
        stored.unlink()
    _parse_stored.cache_clear()
    return {"status": "ok", **info}
