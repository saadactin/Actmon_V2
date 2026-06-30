"""
SQL Server (MSSQL) Report Email Service — report data collection, PDF generation,
email sending, background scheduler, and Pydantic models. Mirrors the MySQL report service.
"""
import base64
import json
import smtplib
import threading
import logging
import urllib.request
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
from typing import List, Optional

from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.mssql_report_schedule_model import MssqlReportSchedule

log = logging.getLogger("mssql_report_email")
MAX_ATTACHMENT_BYTES = 20 * 1048576


# ── Pydantic schemas ──
class SendEmailRequest(BaseModel):
    conn_id: int
    recipient_emails: List[str]
    report_period: str        = "24h"
    base_url: str             = "http://localhost:8000"
    pdf_base64: Optional[str] = None
    db_name: Optional[str]    = None


class ScheduleCreate(BaseModel):
    conn_id: int
    schedule_name: str
    frequency: str = "daily"
    hour: int = 7
    minute: int = 0
    day_of_week: str = "0"
    day_of_month: int = 1
    recipient_emails: List[str]
    report_period: str = "24h"
    enabled: bool = True


class ScheduleUpdate(BaseModel):
    schedule_name: Optional[str] = None
    frequency: Optional[str] = None
    hour: Optional[int] = None
    minute: Optional[int] = None
    day_of_week: Optional[str] = None
    day_of_month: Optional[int] = None
    recipient_emails: Optional[List[str]] = None
    report_period: Optional[str] = None
    enabled: Optional[bool] = None


# ── Data collection ──
def _fetch(base_url: str, path: str) -> dict:
    try:
        req = urllib.request.Request(f"{base_url}{path}", headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return {}


def _collect_report_data(conn_id: int, base_url: str) -> dict:
    b = base_url.rstrip("/")
    p = f"/api/v1/connections/mssql/{conn_id}"
    return {
        "dashboard":    _fetch(b, f"{p}/monitoring-dashboard"),
        "slow_queries": _fetch(b, f"{p}/mssql-slow-queries"),
    }


def _s(v, default="—"):
    if v is None:
        return default
    return str(v) if str(v) else default


# ── PDF generation ──
def generate_mssql_pdf(db_name: str, report_period: str, data: dict,
                       conn_host: str = None, conn_db: str = None) -> bytes:
    from fpdf import FPDF
    period_map = {"live": "Live (Real-Time)", "1h": "Last 1 Hour", "24h": "Last 24 Hours",
                  "7d": "Last 7 Days", "30d": "Last 30 Days", "90d": "Last 90 Days",
                  "1y": "Last 1 Year", "custom": "Custom Period"}
    period_lbl = period_map.get(report_period, report_period)
    now = datetime.now()

    dash = data.get("dashboard", {}) or {}
    hs   = dash.get("health_summary", {}) or {}
    cpu  = dash.get("cpu", {}) or {}
    mem  = dash.get("memory", {}) or {}
    server = _s(conn_host or hs.get("host_name"), db_name)

    db_version  = _s(hs.get("version"), "N/A")
    edition     = _s(hs.get("edition"), "N/A")
    uptime      = _s(hs.get("uptime"), "N/A")
    active_sess = str(int(hs.get("active_sessions") or 0))
    max_conn    = str(int(hs.get("max_connections") or 0))
    cache_hit   = f'{float(hs.get("buffer_cache_hit_pct") or 0):.1f}%'
    host_cpu    = f'{float(cpu.get("host_cpu_pct") or hs.get("host_cpu_pct") or 0):.0f}%'
    sql_cpu     = f'{float(cpu.get("sql_server_cpu_pct") or 0):.0f}%'
    db_size     = f'{float(hs.get("total_size_gb") or 0):.2f} GB'
    slow_list   = (data.get("slow_queries", {}) or {}).get("queries", []) or []

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    pdf.set_fill_color(20, 42, 79)   # navy
    pdf.rect(0, 0, 210, 42, "F")
    pdf.set_text_color(147, 197, 253)
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_xy(10, 8); pdf.cell(0, 6, "ACTMON  -  SQL SERVER DATABASE MONITORING", ln=True)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("Helvetica", "B", 16)
    pdf.set_xy(10, 15); pdf.cell(130, 10, (db_name or "SQL Server")[:40], ln=False)
    pdf.set_xy(145, 15); pdf.set_font("Helvetica", "", 8); pdf.set_text_color(147, 197, 253)
    pdf.cell(0, 5, "Generated", ln=True)
    pdf.set_xy(145, 20); pdf.set_font("Helvetica", "B", 10); pdf.set_text_color(255, 255, 255)
    pdf.cell(0, 5, now.strftime("%d %b %Y"), ln=True)
    pdf.set_xy(145, 26); pdf.set_font("Helvetica", "", 9); pdf.set_text_color(147, 197, 253)
    pdf.cell(0, 5, now.strftime("%I:%M %p"), ln=True)
    pdf.set_xy(10, 28); pdf.set_font("Helvetica", "", 9); pdf.set_text_color(191, 219, 254)
    pdf.cell(0, 5, f"Server: {server}   |   Period: {period_lbl}", ln=True)
    pdf.set_fill_color(37, 99, 235); pdf.rect(0, 42, 210, 3, "F")
    pdf.set_text_color(0, 0, 0); pdf.set_y(52)

    def section_hdr(title, r=20, g=42, b=79):
        pdf.set_fill_color(r, g, b); pdf.set_text_color(255, 255, 255)
        pdf.set_font("Helvetica", "B", 9)
        pdf.cell(190, 7, f"  {title}", fill=True, ln=True); pdf.set_text_color(0, 0, 0)

    def kv_row(label, value, alt):
        pdf.set_fill_color(248, 250, 252) if alt else pdf.set_fill_color(255, 255, 255)
        pdf.set_font("Helvetica", "B", 9); pdf.set_text_color(100, 116, 139)
        pdf.cell(75, 7, f"  {label}", fill=True, border="B")
        pdf.set_font("Helvetica", "", 9); pdf.set_text_color(30, 41, 59)
        pdf.cell(115, 7, f"  {str(value)[:60]}", fill=True, border="B", ln=True)

    section_hdr("REPORT DETAILS")
    kv_row("Monitoring Date", now.strftime("%d-%b-%Y"), False)
    kv_row("Monitoring Time", now.strftime("%I:%M %p"), True)
    kv_row("Connection Name", db_name, False)
    kv_row("Server / Host", server, True)
    kv_row("Report Period", period_lbl, False)
    pdf.ln(4)

    section_hdr("LIVE SNAPSHOT AT REPORT TIME", 37, 99, 235)
    kv_row("SQL Server Version", db_version, False)
    kv_row("Edition", edition, True)
    kv_row("Uptime", uptime, False)
    kv_row("Active Sessions", active_sess, True)
    kv_row("Max Connections", max_conn, False)
    kv_row("Buffer Cache Hit", cache_hit, True)
    kv_row("Host CPU", host_cpu, False)
    kv_row("SQL Server CPU", sql_cpu, True)
    kv_row("Database Size", db_size, False)
    pdf.ln(4)

    if slow_list:
        section_hdr("TOP SLOW QUERIES")
        col_w = [120, 30, 40]
        for h, w in zip(["Query (truncated)", "Avg ms", "Executions"], col_w):
            pdf.set_fill_color(226, 232, 240); pdf.set_font("Helvetica", "B", 8); pdf.set_text_color(30, 41, 59)
            pdf.cell(w, 7, f"  {h}", fill=True, border="B")
        pdf.ln()
        for idx, q in enumerate(slow_list[:15]):
            pdf.set_fill_color(248, 250, 252) if idx % 2 == 0 else pdf.set_fill_color(255, 255, 255)
            pdf.set_font("Helvetica", "", 7); pdf.set_text_color(30, 41, 59)
            vals = [str(q.get("sql_text") or "")[:62].replace("\n", " "),
                    f'{float(q.get("avg_elapsed_ms") or 0):.0f}',
                    str(int(q.get("execution_count") or 0))]
            for val, w in zip(vals, col_w):
                pdf.cell(w, 6, f"  {val}", fill=True, border="B")
            pdf.ln()
        pdf.ln(4)

    pdf.set_font("Helvetica", "I", 7); pdf.set_text_color(148, 163, 184); pdf.set_y(-12)
    pdf.cell(0, 5, f"ACTMON SQL Server Monitoring  -  {db_name}  -  Generated {now.strftime('%d %b %Y %I:%M %p')}  -  Automated report", align="C")
    return bytes(pdf.output())


def build_email_body(db_name: str, report_period: str, data: dict, has_pdf: bool,
                     conn_host: str = None) -> str:
    now = datetime.now()
    dash = data.get("dashboard", {}) or {}
    hs = dash.get("health_summary", {}) or {}
    cpu = dash.get("cpu", {}) or {}
    server = _s(conn_host or hs.get("host_name"), db_name)
    period_map = {"24h": "Last 24 Hours", "7d": "Last 7 Days", "live": "Live (Real-Time)"}
    period_lbl = period_map.get(report_period, report_period)

    def _row(label, value, alt=False):
        bg = 'background:#f8fafc;' if alt else ''
        return (f'<tr style="{bg}border-bottom:1px solid #f1f5f9">'
                f'<td style="padding:9px 16px;font-size:12px;color:#64748b;font-weight:700;width:44%;font-family:Arial">{label}</td>'
                f'<td style="padding:9px 16px;font-size:12px;color:#1e293b;font-weight:600;font-family:Arial">{value}</td></tr>')

    rows = "".join([
        _row("SQL Server Version", _s(hs.get("version"))),
        _row("Edition", _s(hs.get("edition")), True),
        _row("Uptime", _s(hs.get("uptime"))),
        _row("Active Sessions", str(int(hs.get("active_sessions") or 0)), True),
        _row("Buffer Cache Hit", f'{float(hs.get("buffer_cache_hit_pct") or 0):.1f}%'),
        _row("Host CPU", f'{float(cpu.get("host_cpu_pct") or hs.get("host_cpu_pct") or 0):.0f}%', True),
        _row("SQL Server CPU", f'{float(cpu.get("sql_server_cpu_pct") or 0):.0f}%'),
        _row("Database Size", f'{float(hs.get("total_size_gb") or 0):.2f} GB', True),
    ])
    pdf_note = ('<p style="font-size:12px;color:#15803d;font-weight:700;margin:0 0 16px">📎 The full report PDF is attached to this email.</p>'
                if has_pdf else
                '<p style="font-size:12px;color:#854d0e;margin:0 0 16px">No PDF attached — open Actmon to download the full report.</p>')

    return f"""<!DOCTYPE html><html><head><meta charset="UTF-8"><title>SQL Server Monitoring Report</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9"><tr><td align="center" style="padding:32px 16px">
<table width="620" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.10);max-width:620px">
<tr><td style="background:#142a4f;padding:26px 32px 20px">
<div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#93c5fd;font-weight:700;margin-bottom:8px">ACTMON &bull; SQL SERVER MONITORING</div>
<div style="font-size:22px;font-weight:900;color:#fff">{db_name}</div>
<div style="font-size:12px;color:#bfdbfe;margin-top:6px">Server: {server} &nbsp;|&nbsp; Period: {period_lbl} &nbsp;|&nbsp; {now.strftime('%d %b %Y %I:%M %p')}</div>
</td></tr>
<tr><td style="padding:24px 32px">
{pdf_note}
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
<tr><td colspan="2" style="background:#2563eb;color:#fff;font-weight:800;font-size:12px;padding:9px 16px;font-family:Arial">LIVE SNAPSHOT</td></tr>
{rows}
</table>
<p style="font-size:11px;color:#94a3b8;margin-top:18px;font-family:Arial">Automated report from Actmon. If this is not in your inbox, please check Spam / Junk.</p>
</td></tr></table></td></tr></table></body></html>"""


# ── Email send ──
def send_mssql_report_email(conn_id, recipients, smtp_host, smtp_port, smtp_user, smtp_password,
                            smtp_tls, sender_email, sender_name, report_period, base_url,
                            pdf_base64=None, db_name=None, conn_host=None, conn_db=None, app_url=None) -> dict:
    import socket
    data = _collect_report_data(conn_id, base_url)
    db_label = db_name or f"SQL Server #{conn_id}"
    now_dt = datetime.now()
    subj = f"SQL Server Monitoring Report — {db_label} — {now_dt.strftime('%d %b %Y %I:%M %p')}"

    try:
        socket.getaddrinfo(smtp_host, smtp_port)
    except socket.gaierror as e:
        return {"status": "error", "message": f"DNS lookup failed for '{smtp_host}'. ({e})"}

    has_pdf = False; pdf_size = 0; pdf_bytes = None
    if pdf_base64:
        try:
            pdf_bytes = base64.b64decode(pdf_base64); pdf_size = len(pdf_bytes)
            has_pdf = pdf_size <= MAX_ATTACHMENT_BYTES
            if not has_pdf: pdf_bytes = None
        except Exception:
            pdf_bytes = None
    if pdf_bytes is None:
        try:
            pdf_bytes = generate_mssql_pdf(db_label, report_period, data, conn_host=conn_host, conn_db=conn_db)
            pdf_size = len(pdf_bytes); has_pdf = True
        except Exception as e:
            log.warning("MSSQL PDF generation failed: %s", e); has_pdf = False

    html = build_email_body(db_label, report_period, data, has_pdf, conn_host=conn_host)
    msg = MIMEMultipart("mixed")
    msg["Subject"] = subj
    msg["From"] = f"{sender_name} <{sender_email}>"
    msg["To"] = ", ".join(recipients)
    alt = MIMEMultipart("alternative"); alt.attach(MIMEText(html, "html", "utf-8")); msg.attach(alt)
    if has_pdf and pdf_bytes:
        safe = db_label.replace(" ", "_").replace("/", "_")
        part = MIMEApplication(pdf_bytes, _subtype="pdf")
        part.add_header("Content-Disposition", "attachment", filename=f"SQLServer_Report_{safe}_{now_dt.strftime('%Y%m%d_%H%M')}.pdf")
        msg.attach(part)

    try:
        if smtp_tls:
            server = smtplib.SMTP(smtp_host, smtp_port, timeout=30); server.ehlo(); server.starttls(); server.ehlo()
        else:
            server = smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=30); server.ehlo()
        if smtp_user and smtp_password:
            server.login(smtp_user, smtp_password)
        failed = server.sendmail(sender_email, recipients, msg.as_bytes())
        server.quit()
        failed = {k: v for k, v in (failed or {}).items() if "@" in k}
        if failed:
            ok = [r for r in recipients if r not in failed]
            if ok:
                return {"status": "partial", "message": f"Delivered to {', '.join(ok)}. Failed: {list(failed.keys())}."}
            return {"status": "error", "message": f"All recipients failed: {list(failed.keys())}"}
        note = f" with PDF ({pdf_size // 1048576} MB)" if has_pdf else ""
        return {"status": "success", "message": f"Report{note} sent to {', '.join(recipients)}. Check Spam/Junk if not in inbox."}
    except smtplib.SMTPAuthenticationError:
        return {"status": "error", "message": "Authentication failed — for Gmail use an App Password (Google Account → Security → App Passwords)."}
    except Exception as exc:
        log.error("MSSQL email send error: %s", exc, exc_info=True)
        return {"status": "error", "message": str(exc)}


# ── Background scheduler ──
_sched_lock = threading.Lock(); _sched_thread = None; _sched_stop = threading.Event()


def _next_run(sched: MssqlReportSchedule) -> datetime:
    now = datetime.utcnow(); freq = sched.frequency or "daily"
    h = sched.hour or 7; m = sched.minute or 0
    if freq == "hourly":
        return now.replace(minute=m, second=0, microsecond=0) + timedelta(hours=1)
    if freq == "weekly":
        dow = int(sched.day_of_week or 0); days = (dow - now.weekday()) % 7
        c = (now + timedelta(days=days)).replace(hour=h, minute=m, second=0, microsecond=0)
        return c + timedelta(weeks=1) if c <= now else c
    if freq == "monthly":
        try:
            c = now.replace(day=sched.day_of_month or 1, hour=h, minute=m, second=0, microsecond=0)
        except ValueError:
            c = now.replace(day=28, hour=h, minute=m, second=0, microsecond=0)
        if c <= now:
            c = c.replace(year=now.year + 1, month=1) if now.month == 12 else c.replace(month=now.month + 1)
        return c
    c = now.replace(hour=h, minute=m, second=0, microsecond=0)
    return c + timedelta(days=1) if c <= now else c


def _run_schedule(sched: MssqlReportSchedule, db_session):
    recipients = json.loads(sched.recipient_emails or "[]")
    if not recipients:
        return
    smtp_host = sched.smtp_host; smtp_port = sched.smtp_port or 587
    smtp_user = sched.smtp_user; smtp_password = sched.smtp_password
    smtp_tls = sched.smtp_tls if sched.smtp_tls is not None else True
    sender_email = sched.sender_email; sender_name = sched.sender_name or "Actmon Monitor"
    try:
        from app.models.smtp_config_model import SmtpConfig
        cfg = (db_session.query(SmtpConfig).filter(SmtpConfig.is_default == True).first()
               or db_session.query(SmtpConfig).order_by(SmtpConfig.id).first())
        if cfg:
            smtp_host, smtp_port = cfg.smtp_host, cfg.smtp_port or 587
            smtp_user, smtp_password = cfg.smtp_user, cfg.smtp_password
            smtp_tls = cfg.smtp_tls if cfg.smtp_tls is not None else True
            sender_email, sender_name = cfg.sender_email, cfg.sender_name or "Actmon Monitor"
    except Exception:
        pass
    conn_host = conn_db = None
    try:
        from app.models.connection_model import ConnectionMaster
        conn = db_session.query(ConnectionMaster).filter(ConnectionMaster.id == sched.conn_id).first()
        if conn:
            conn_host, conn_db = conn.host, conn.database_name
    except Exception:
        pass
    result = send_mssql_report_email(
        conn_id=sched.conn_id, recipients=recipients,
        smtp_host=smtp_host, smtp_port=smtp_port, smtp_user=smtp_user, smtp_password=smtp_password,
        smtp_tls=smtp_tls, sender_email=sender_email, sender_name=sender_name,
        report_period=sched.report_period or "24h", base_url="http://localhost:8000",
        pdf_base64=None, conn_host=conn_host, conn_db=conn_db)
    sched.last_sent_at = datetime.utcnow(); sched.last_status = result["status"]
    sched.next_run_at = _next_run(sched); db_session.commit()


def _scheduler_loop():
    from app.database.connection import SessionLocal
    while not _sched_stop.is_set():
        try:
            with SessionLocal() as session:
                now = datetime.utcnow()
                for sched in session.query(MssqlReportSchedule).filter(
                        MssqlReportSchedule.enabled == True, MssqlReportSchedule.next_run_at <= now).all():
                    try:
                        _run_schedule(sched, session)
                    except Exception as exc:
                        log.error("MSSQL schedule %s error: %s", sched.id, exc)
        except Exception as exc:
            log.error("MSSQL scheduler tick error: %s", exc)
        _sched_stop.wait(60)


def start_mssql_report_scheduler():
    global _sched_thread
    with _sched_lock:
        if _sched_thread and _sched_thread.is_alive():
            return
        _sched_stop.clear()
        _sched_thread = threading.Thread(target=_scheduler_loop, daemon=True, name="mssql_report_scheduler")
        _sched_thread.start()
        log.info("MSSQL report scheduler started")


def stop_mssql_report_scheduler():
    _sched_stop.set()


# ── Schedule CRUD ──
def svc_list_schedules(conn_id: int, db: Session) -> dict:
    rows = db.query(MssqlReportSchedule).filter(MssqlReportSchedule.conn_id == conn_id).order_by(MssqlReportSchedule.id).all()
    return {"status": "success", "schedules": [{
        "id": r.id, "schedule_name": r.schedule_name, "frequency": r.frequency,
        "hour": r.hour, "minute": r.minute, "day_of_week": r.day_of_week, "day_of_month": r.day_of_month,
        "recipient_emails": json.loads(r.recipient_emails or "[]"), "report_period": r.report_period,
        "enabled": r.enabled,
        "last_sent_at": r.last_sent_at.isoformat() if r.last_sent_at else None,
        "next_run_at": r.next_run_at.isoformat() if r.next_run_at else None,
        "last_status": r.last_status,
    } for r in rows]}


def svc_create_schedule(req: ScheduleCreate, db: Session) -> dict:
    from fastapi import HTTPException
    from app.models.smtp_config_model import SmtpConfig
    cfg = (db.query(SmtpConfig).filter(SmtpConfig.is_default == True).first()
           or db.query(SmtpConfig).order_by(SmtpConfig.id).first())
    if not cfg:
        raise HTTPException(status_code=400, detail="No SMTP configuration saved. Go to Settings → SMTP Configuration first.")
    sched = MssqlReportSchedule(
        conn_id=req.conn_id, schedule_name=req.schedule_name, frequency=req.frequency,
        hour=req.hour, minute=req.minute, day_of_week=req.day_of_week, day_of_month=req.day_of_month,
        recipient_emails=json.dumps(req.recipient_emails),
        smtp_host=cfg.smtp_host, smtp_port=cfg.smtp_port or 587, smtp_user=cfg.smtp_user,
        smtp_password=cfg.smtp_password, smtp_tls=cfg.smtp_tls if cfg.smtp_tls is not None else True,
        sender_email=cfg.sender_email, sender_name=cfg.sender_name or "Actmon Monitor",
        report_period=req.report_period, enabled=req.enabled,
        created_at=datetime.utcnow(), updated_at=datetime.utcnow())
    sched.next_run_at = _next_run(sched)
    db.add(sched); db.commit(); db.refresh(sched)
    return {"status": "success", "id": sched.id,
            "next_run_at": sched.next_run_at.isoformat() if sched.next_run_at else None, "frequency": sched.frequency}


def svc_update_schedule(sched_id: int, req: ScheduleUpdate, db: Session) -> dict:
    from fastapi import HTTPException
    sched = db.query(MssqlReportSchedule).filter(MssqlReportSchedule.id == sched_id).first()
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")
    for k, v in req.model_dump(exclude_unset=True).items():
        if k == "recipient_emails" and v is not None:
            v = json.dumps(v)
        setattr(sched, k, v)
    sched.updated_at = datetime.utcnow(); sched.next_run_at = _next_run(sched)
    db.commit()
    return {"status": "success"}


def svc_delete_schedule(sched_id: int, db: Session) -> dict:
    from fastapi import HTTPException
    sched = db.query(MssqlReportSchedule).filter(MssqlReportSchedule.id == sched_id).first()
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")
    db.delete(sched); db.commit()
    return {"status": "success"}


def svc_send_report_now(req: SendEmailRequest, db: Session) -> dict:
    from fastapi import HTTPException
    from app.models.smtp_config_model import SmtpConfig
    from app.models.connection_model import ConnectionMaster
    cfg = (db.query(SmtpConfig).filter(SmtpConfig.is_default == True).first()
           or db.query(SmtpConfig).order_by(SmtpConfig.id).first())
    if not cfg:
        raise HTTPException(status_code=400, detail="No SMTP configuration saved. Go to Settings → SMTP Configuration first.")
    conn_host = conn_db = None
    conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == req.conn_id).first()
    if conn:
        conn_host, conn_db = conn.host, conn.database_name
    result = send_mssql_report_email(
        conn_id=req.conn_id, recipients=req.recipient_emails,
        smtp_host=cfg.smtp_host, smtp_port=cfg.smtp_port or 587, smtp_user=cfg.smtp_user,
        smtp_password=cfg.smtp_password, smtp_tls=cfg.smtp_tls if cfg.smtp_tls is not None else True,
        sender_email=cfg.sender_email, sender_name=cfg.sender_name or "Actmon Monitor",
        report_period=req.report_period, base_url=req.base_url, pdf_base64=req.pdf_base64,
        db_name=req.db_name, conn_host=conn_host, conn_db=conn_db)
    if result["status"] == "error":
        raise HTTPException(status_code=500, detail=result["message"])
    return result
