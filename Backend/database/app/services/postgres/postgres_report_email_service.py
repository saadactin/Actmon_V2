"""
PostgreSQL Report Email Service — business logic, PDF generation,
email sending, scheduler, and Pydantic models.
"""

import base64
import json
import smtplib
import threading
import logging
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
from typing import List, Optional

from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.postgres_report_schedule_model import PostgresReportSchedule

log = logging.getLogger("postgres_report_email")

# ─────────────────────────────────────────────
# Pydantic schemas
# ─────────────────────────────────────────────

class SendEmailRequest(BaseModel):
    conn_id: int
    recipient_emails: List[str]
    smtp_host: Optional[str]     = None
    smtp_port: Optional[int]     = None
    smtp_user: Optional[str]     = None
    smtp_password: Optional[str] = None
    smtp_tls: Optional[bool]     = None
    sender_email: Optional[str]  = None
    sender_name: Optional[str]   = None
    report_period: str           = "24h"
    base_url: str                = "http://localhost:8000"
    pdf_base64: Optional[str]    = None
    db_name: Optional[str]       = None

class ScheduleCreate(BaseModel):
    conn_id: int
    schedule_name: str
    frequency: str = "daily"
    hour: int = 7
    minute: int = 0
    day_of_week: str = "0"
    day_of_month: int = 1
    recipient_emails: List[str]
    smtp_host: Optional[str]     = None
    smtp_port: Optional[int]     = None
    smtp_user: Optional[str]     = None
    smtp_password: Optional[str] = None
    smtp_tls: Optional[bool]     = None
    sender_email: Optional[str]  = None
    sender_name: Optional[str]   = None
    report_period: str = "24h"
    include_sections: Optional[List[str]] = None
    enabled: bool = True
    base_url: str = "http://localhost:8000"

class ScheduleUpdate(BaseModel):
    schedule_name: Optional[str] = None
    frequency: Optional[str] = None
    hour: Optional[int] = None
    minute: Optional[int] = None
    day_of_week: Optional[str] = None
    day_of_month: Optional[int] = None
    recipient_emails: Optional[List[str]] = None
    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = None
    smtp_user: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_tls: Optional[bool] = None
    sender_email: Optional[str] = None
    sender_name: Optional[str] = None
    report_period: Optional[str] = None
    include_sections: Optional[List[str]] = None
    enabled: Optional[bool] = None
    base_url: Optional[str] = None


# ─────────────────────────────────────────────
# Data collection helpers
# ─────────────────────────────────────────────

def _fetch(base_url: str, path: str) -> dict:
    try:
        url = f"{base_url}{path}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        pass
    return {}


def _collect_report_data(conn_id: int, base_url: str) -> dict:
    b = base_url.rstrip("/")
    p = f"/api/v1/connections/postgresql/{conn_id}"
    return {
        "dashboard":    _fetch(b, f"{p}/monitoring-dashboard"),
        "slow_queries": _fetch(b, f"{p}/pg-slow-queries"),
        "index":        _fetch(b, f"{p}/pg-index-analysis"),
        "replication":  _fetch(b, f"{p}/replication-detail"),
        "tables":       _fetch(b, f"{p}/tables-detail"),
        "storage":      _fetch(b, f"{p}/storage-detail"),
        "users":        _fetch(b, f"{p}/users-detail"),
        "wal":          _fetch(b, f"{p}/pg-wal-stats"),
        "checkpoint":   _fetch(b, f"{p}/pg-checkpoint-stats"),
        "sessions":     _fetch(b, f"{p}/pg-session-details"),
        "backup":       _fetch(b, f"{p}/backup-summary"),
    }


def _s(v, default="—"):
    if v is None:
        return default
    return str(v) if str(v) else default


# ─────────────────────────────────────────────
# PDF generation
# ─────────────────────────────────────────────

def generate_postgres_pdf(db_name: str, report_period: str, data: dict,
                           conn_host: str = None, conn_db: str = None) -> bytes:
    from fpdf import FPDF

    period_map = {
        "live": "Live (Real-Time)", "1h": "Last 1 Hour",
        "24h": "Last 24 Hours",    "7d": "Last 7 Days",
        "30d": "Last 30 Days",     "90d": "Last 90 Days",
        "1y":  "Last 1 Year",      "custom": "Custom Period",
    }
    period_lbl = period_map.get(report_period, report_period)
    now = datetime.now()

    dash   = data.get("dashboard", {}) or {}
    hs     = dash.get("health_summary", {}) or dash.get("overview", {}) or {}
    tables = (data.get("tables", {}) or {}).get("tables", []) or []
    repl   = data.get("replication", {}) or {}
    backup = data.get("backup", {}) or {}

    server      = _s(conn_host or hs.get("host"), db_name)
    db_version  = _s(hs.get("version") or hs.get("pg_version"), "N/A")
    uptime      = _s(hs.get("uptime"), "N/A")
    db_label    = conn_db or db_name
    active_conn = str(int(hs.get("active_connections") or hs.get("numbackends") or 0))
    max_conn    = str(int(hs.get("max_connections") or 0))
    cache_hit   = f'{float(hs.get("cache_hit_ratio") or hs.get("blks_hit_pct") or 0):.1f}%'
    db_size     = _s(hs.get("db_size") or hs.get("database_size"), "N/A")

    repl_standby = _s((repl.get("standbys") or [{}])[0].get("application_name") if repl.get("standbys") else None, "None")
    repl_lag     = _s((repl.get("standbys") or [{}])[0].get("write_lag") if repl.get("standbys") else None, "N/A")

    last_bkp     = _s((backup.get("last_backup") or {}).get("status") or backup.get("last_backup_time"), "No data")

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    # ── Header ──
    pdf.set_fill_color(51, 103, 145)
    pdf.rect(0, 0, 210, 42, "F")
    pdf.set_text_color(186, 225, 255)
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_xy(10, 8)
    pdf.cell(0, 6, "ACTMON  -  POSTGRESQL DATABASE MONITORING", ln=True)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("Helvetica", "B", 16)
    pdf.set_xy(10, 15)
    pdf.cell(130, 10, (db_name or "PostgreSQL DB")[:40], ln=False)
    pdf.set_xy(145, 15)
    pdf.set_font("Helvetica", "", 8)
    pdf.set_text_color(186, 225, 255)
    pdf.cell(0, 5, "Generated", ln=True)
    pdf.set_xy(145, 20)
    pdf.set_font("Helvetica", "B", 10)
    pdf.set_text_color(255, 255, 255)
    pdf.cell(0, 5, now.strftime("%d %b %Y"), ln=True)
    pdf.set_xy(145, 26)
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(186, 225, 255)
    pdf.cell(0, 5, now.strftime("%I:%M %p"), ln=True)
    pdf.set_xy(10, 28)
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(220, 240, 255)
    pdf.cell(0, 5, f"Server: {server}   |   Database: {db_label}   |   Period: {period_lbl}", ln=True)
    pdf.set_fill_color(74, 144, 226)
    pdf.rect(0, 42, 210, 3, "F")
    pdf.set_text_color(0, 0, 0)
    pdf.set_y(52)

    def section_hdr(title: str, r: int = 51, g: int = 103, b: int = 145):
        pdf.set_fill_color(r, g, b)
        pdf.set_text_color(255, 255, 255)
        pdf.set_font("Helvetica", "B", 9)
        pdf.cell(190, 7, f"  {title}", fill=True, ln=True)
        pdf.set_text_color(0, 0, 0)

    def kv_row(label: str, value: str, alt: bool):
        pdf.set_fill_color(248, 250, 252) if alt else pdf.set_fill_color(255, 255, 255)
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(100, 116, 139)
        pdf.cell(75, 7, f"  {label}", fill=True, border="B")
        pdf.set_font("Helvetica", "", 9)
        pdf.set_text_color(30, 41, 59)
        pdf.cell(115, 7, f"  {str(value)[:60]}", fill=True, border="B", ln=True)

    section_hdr("REPORT DETAILS")
    kv_row("Monitoring Date",  now.strftime("%d-%b-%Y"), False)
    kv_row("Monitoring Time",  now.strftime("%I:%M %p"),  True)
    kv_row("Connection Name",  db_name,                  False)
    kv_row("Server / Host",    server,                    True)
    kv_row("Database",         db_label,                 False)
    kv_row("Report Period",    period_lbl,                True)
    pdf.ln(4)

    section_hdr("LIVE SNAPSHOT AT REPORT TIME", 74, 144, 226)
    kv_row("PostgreSQL Version",  db_version,    False)
    kv_row("Uptime",              uptime,        True)
    kv_row("Active Connections",  active_conn,   False)
    kv_row("Max Connections",     max_conn,       True)
    kv_row("Cache Hit Ratio",     cache_hit,     False)
    kv_row("Database Size",       db_size,        True)
    kv_row("Replication Standby", repl_standby,  False)
    kv_row("Replication Lag",     repl_lag,       True)
    kv_row("Last Backup",         last_bkp,      False)
    pdf.ln(4)

    if tables:
        section_hdr("TOP TABLES BY SIZE")
        col_w = [75, 30, 35, 30, 20]
        hdrs  = ["Table Name", "Schema", "Total Size", "Live Tuples", "Dead Tuples"]
        pdf.set_fill_color(226, 232, 240)
        pdf.set_font("Helvetica", "B", 8)
        pdf.set_text_color(30, 41, 59)
        for h, w in zip(hdrs, col_w):
            pdf.cell(w, 7, f"  {h}", fill=True, border="B")
        pdf.ln()
        for idx, tbl in enumerate(tables[:20]):
            pdf.set_fill_color(248, 250, 252) if idx % 2 == 0 else pdf.set_fill_color(255, 255, 255)
            pdf.set_font("Helvetica", "", 8)
            pdf.set_text_color(30, 41, 59)
            vals = [
                str(tbl.get("table_name") or tbl.get("relname") or "N/A")[:32],
                str(tbl.get("schema") or tbl.get("schemaname") or "public")[:14],
                str(tbl.get("total_size") or tbl.get("size") or "—")[:14],
                str(tbl.get("n_live_tup") or tbl.get("live_tuples") or "0"),
                str(tbl.get("n_dead_tup") or tbl.get("dead_tuples") or "0"),
            ]
            for val, w in zip(vals, col_w):
                pdf.cell(w, 6, f"  {val}", fill=True, border="B")
            pdf.ln()
        pdf.set_text_color(30, 41, 59)
        pdf.ln(4)

    # ── Footer ──
    pdf.set_font("Helvetica", "I", 7)
    pdf.set_text_color(148, 163, 184)
    pdf.set_y(-12)
    pdf.cell(0, 5,
             f"ACTMON PostgreSQL Monitoring  -  {db_name}  -  "
             f"Generated {now.strftime('%d %b %Y %I:%M %p')}  -  Automated report",
             align="C")

    return bytes(pdf.output())


# ─────────────────────────────────────────────
# HTML email builder
# ─────────────────────────────────────────────

def build_email_body(db_name: str, report_period: str, data: dict, has_pdf: bool,
                     conn_host: str = None, conn_db: str = None,
                     app_url: str = None, conn_id: int = None) -> str:
    now      = datetime.now()
    mon_date = now.strftime("%d-%b-%Y")
    mon_time = now.strftime("%I:%M %p")

    dash     = data.get("dashboard", {}) or {}
    hs       = dash.get("health_summary", {}) or dash.get("overview", {}) or {}
    server   = _s(conn_host or hs.get("host"), db_name)
    db_label = conn_db or db_name
    db_version = _s(hs.get("version") or hs.get("pg_version"), "—")
    uptime   = _s(hs.get("uptime"), "—")
    active_conn = str(int(hs.get("active_connections") or hs.get("numbackends") or 0))
    cache_hit = f'{float(hs.get("cache_hit_ratio") or hs.get("blks_hit_pct") or 0):.1f}%'

    repl     = data.get("replication", {}) or {}
    standbys = repl.get("standbys") or []
    repl_ok  = len(standbys) > 0

    period_map = {
        "live": "Live (Real-Time)", "1h": "Last 1 Hour",
        "24h": "Last 24 Hours",    "7d": "Last 7 Days",
        "30d": "Last 30 Days",     "90d": "Last 90 Days",
        "1y":  "Last 1 Year",      "custom": "Custom Period",
    }
    period_lbl = period_map.get(report_period, report_period)

    def _row(label, value, alt=False):
        bg = 'background:#f8fafc;' if alt else ''
        return (
            f'<tr style="{bg}border-bottom:1px solid #f1f5f9">'
            f'<td style="padding:9px 16px;font-size:12px;color:#64748b;font-weight:700;'
            f'width:44%;font-family:Arial,sans-serif">{label}</td>'
            f'<td style="padding:9px 16px;font-size:12px;color:#1e293b;font-weight:600;'
            f'font-family:Arial,sans-serif">{value}</td></tr>'
        )

    repl_badge = (
        '<span style="background:#dcfce7;color:#15803d;padding:1px 8px;border-radius:9999px;font-size:11px;font-weight:700">Active</span>'
        if repl_ok else
        '<span style="background:#f1f5f9;color:#64748b;padding:1px 8px;border-radius:9999px;font-size:11px;font-weight:700">Standalone</span>'
    )

    if has_pdf:
        pdf_note = (
            '<tr><td style="padding:0 0 20px 0">'
            '<table width="100%" cellpadding="0" cellspacing="0"><tr>'
            '<td style="background:#f0fdf4;border:2px solid #86efac;border-radius:8px;padding:16px 20px">'
            '<table width="100%" cellpadding="0" cellspacing="0">'
            '<tr><td style="padding-bottom:8px">'
            '<table cellpadding="0" cellspacing="0"><tr>'
            '<td style="font-size:24px;padding-right:10px;vertical-align:middle">&#128206;</td>'
            '<td style="font-size:14px;color:#15803d;font-weight:800;font-family:Arial,sans-serif">'
            'Report PDF is attached to this email</td>'
            '</tr></table></td></tr>'
            '<tr><td style="font-size:12px;color:#166534;font-family:Arial,sans-serif;line-height:1.6">'
            'To view, download or print the report:<br>'
            '&nbsp; 1. Look for the <strong>PDF attachment</strong> at the bottom of this email<br>'
            '&nbsp; 2. Click the attachment to <strong>open it directly</strong> in your PDF viewer<br>'
            '&nbsp; 3. Use the PDF viewer toolbar to <strong>Download</strong> &#11015; or <strong>Print</strong> &#128438;'
            '</td></tr></table></td></tr></table></td></tr>'
        )
    else:
        pdf_note = (
            '<tr><td style="padding:0 0 16px 0">'
            '<table width="100%" cellpadding="0" cellspacing="0"><tr>'
            '<td style="background:#fef9c3;border:1px solid #fde047;border-radius:6px;padding:12px 16px">'
            '<span style="font-size:12px;color:#854d0e;font-family:Arial,sans-serif">'
            '&#9432; No PDF attachment — report was generated without a snapshot. '
            'Please open Actmon and use the Download button to get the full PDF report.'
            '</span></td></tr></table></td></tr>'
        )

    return f"""<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <title>PostgreSQL Monitoring Report — {db_name}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9">
<tr><td align="center" style="padding:32px 16px">
  <table width="620" cellpadding="0" cellspacing="0"
    style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.10);max-width:620px">
    <tr>
      <td style="background:#336791;padding:0">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="padding:26px 32px 20px 32px">
            <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#bae1ff;font-weight:700;margin-bottom:8px">
              ACTMON &nbsp;&bull;&nbsp; POSTGRESQL DATABASE MONITORING
            </div>
            <div style="font-size:22px;font-weight:900;color:#ffffff;letter-spacing:-0.3px">{db_name}</div>
            <div style="font-size:12px;color:#dceeff;margin-top:5px">
              Server: <strong style="color:#ffffff">{server}</strong>
              &nbsp;&bull;&nbsp; Database: <strong style="color:#ffffff">{db_label}</strong>
              &nbsp;&bull;&nbsp; Period: <strong style="color:#ffffff">{period_lbl}</strong>
            </div>
          </td>
          <td style="padding:26px 32px 20px 0;text-align:right;vertical-align:top;white-space:nowrap">
            <div style="font-size:10px;color:#bae1ff;margin-bottom:4px">Generated</div>
            <div style="font-size:13px;font-weight:700;color:#ffffff">{mon_date}</div>
            <div style="font-size:12px;color:#bae1ff">{mon_time}</div>
          </td>
        </tr></table>
        <div style="height:4px;background:linear-gradient(90deg,#4a90e2,#74b3f0,#336791)"></div>
      </td>
    </tr>
    <tr><td style="padding:28px 32px 20px 32px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-size:15px;color:#1e293b;font-weight:700;padding-bottom:14px;font-family:Arial,sans-serif">Dear Sir/Madam,</td></tr>
        <tr><td style="font-size:13px;color:#334155;line-height:1.75;padding-bottom:22px;font-family:Arial,sans-serif">
          Please find attached the <strong style="color:#336791">{db_name} PostgreSQL Monitoring Report</strong>
          for the <strong>{period_lbl}</strong> period.
        </td></tr>
        {pdf_note}
        <tr><td style="padding-bottom:20px">
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:6px;overflow:hidden">
            <tr><td style="background:#336791;padding:9px 16px">
              <span style="font-size:11px;font-weight:800;color:#e2e8f0;text-transform:uppercase;letter-spacing:1px">Report Details</span>
            </td></tr>
            <tr><td style="padding:0"><table width="100%" cellpadding="0" cellspacing="0">
              {_row("Monitoring Date",  mon_date,   False)}
              {_row("Monitoring Time",  mon_time,   True)}
              {_row("Connection Name",  db_name,    False)}
              {_row("Server / Host",    server,     True)}
              {_row("Database",         db_label,   False)}
              {_row("Report Period",    period_lbl, True)}
            </table></td></tr>
          </table>
        </td></tr>
        <tr><td style="padding-bottom:20px">
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:6px;overflow:hidden">
            <tr><td style="background:#4a90e2;padding:9px 16px">
              <span style="font-size:11px;font-weight:800;color:#ffffff;text-transform:uppercase;letter-spacing:1px">Live Snapshot at Report Time</span>
            </td></tr>
            <tr><td style="padding:0"><table width="100%" cellpadding="0" cellspacing="0">
              {_row("PostgreSQL Version", db_version,  False)}
              {_row("Uptime",             uptime,      True)}
              {_row("Active Connections", active_conn, False)}
              {_row("Cache Hit Ratio",    cache_hit,   True)}
              {_row("Replication",        repl_badge,  False)}
            </table></td></tr>
          </table>
        </td></tr>
        <tr><td style="font-size:13px;color:#334155;line-height:1.75;padding:8px 0 20px 0;font-family:Arial,sans-serif">
          Please review the <strong>attached PDF report</strong> for complete details including performance, WAL stats, replication, and backup status.
        </td></tr>
        <tr><td style="font-size:13px;color:#334155;padding-bottom:6px;font-family:Arial,sans-serif">Regards,</td></tr>
        <tr><td style="padding-bottom:2px">
          <span style="font-size:15px;font-weight:800;color:#336791;font-family:Arial,sans-serif">ActMon Team</span>
        </td></tr>
        <tr><td style="font-size:12px;color:#64748b;font-family:Arial,sans-serif">Actin Technologies</td></tr>
      </table>
    </td></tr>
    <tr><td style="background:#336791;padding:12px 32px">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:11px;color:#bae1ff;font-family:Arial,sans-serif">
          <strong style="color:#e2e8f0">Actmon</strong> &mdash; PostgreSQL Monitoring &nbsp;&bull;&nbsp; {mon_date}
        </td>
        <td style="font-size:11px;color:#bae1ff;text-align:right;font-family:Arial,sans-serif">
          Automated report &mdash; do not reply
        </td>
      </tr></table>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>"""


# ─────────────────────────────────────────────
# Email sender
# ─────────────────────────────────────────────

MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024


def send_postgres_report_email(
    conn_id: int,
    recipients: List[str],
    smtp_host: str,
    smtp_port: int,
    smtp_user: Optional[str],
    smtp_password: Optional[str],
    smtp_tls: bool,
    sender_email: str,
    sender_name: str,
    report_period: str,
    base_url: str,
    pdf_base64: Optional[str] = None,
    db_name: Optional[str] = None,
    conn_host: Optional[str] = None,
    conn_db: Optional[str] = None,
    app_url: Optional[str] = None,
) -> dict:
    import socket

    data     = _collect_report_data(conn_id, base_url)
    has_pdf  = False
    pdf_size = 0
    db_label = db_name or f"PostgreSQL DB #{conn_id}"
    now_dt   = datetime.now()
    subj     = f"PostgreSQL Monitoring Report — {db_label} — {now_dt.strftime('%d %b %Y %I:%M %p')}"

    try:
        socket.getaddrinfo(smtp_host, smtp_port)
    except socket.gaierror as e:
        return {"status": "error", "message": f"DNS lookup failed for '{smtp_host}'. ({e})"}

    pdf_bytes = None
    if pdf_base64:
        try:
            pdf_bytes = base64.b64decode(pdf_base64)
            pdf_size  = len(pdf_bytes)
            if pdf_size <= MAX_ATTACHMENT_BYTES:
                has_pdf = True
            else:
                pdf_bytes = None
        except Exception as e:
            log.warning("PDF decode failed: %s", e)
            pdf_bytes = None

    if pdf_bytes is None:
        try:
            pdf_bytes = generate_postgres_pdf(db_label, report_period, data,
                                               conn_host=conn_host, conn_db=conn_db)
            pdf_size = len(pdf_bytes)
            has_pdf  = True
        except Exception as e:
            log.warning("Backend PDF generation failed: %s", e)

    html_body = build_email_body(db_label, report_period, data, has_pdf=has_pdf,
                                  conn_host=conn_host, conn_db=conn_db,
                                  app_url=app_url, conn_id=conn_id)

    msg = MIMEMultipart("mixed")
    msg["Subject"]  = subj
    msg["From"]     = f"{sender_name} <{sender_email}>"
    msg["To"]       = ", ".join(recipients)
    msg["X-Mailer"] = "Actmon PostgreSQL Monitor"

    alt = MIMEMultipart("alternative")
    alt.attach(MIMEText(html_body, "html", "utf-8"))
    msg.attach(alt)

    if has_pdf and pdf_bytes:
        safe_name = db_label.replace(" ", "_").replace("/", "_")
        filename  = f"PostgreSQL_Report_{safe_name}_{now_dt.strftime('%Y%m%d_%H%M')}.pdf"
        pdf_part  = MIMEApplication(pdf_bytes, _subtype="pdf")
        pdf_part.add_header("Content-Disposition", "attachment", filename=filename)
        msg.attach(pdf_part)

    try:
        if smtp_tls:
            server = smtplib.SMTP(smtp_host, smtp_port, timeout=30)
            server.ehlo(); server.starttls(); server.ehlo()
        else:
            server = smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=30)
            server.ehlo()

        if smtp_user and smtp_password:
            server.login(smtp_user, smtp_password)

        failed = server.sendmail(sender_email, recipients, msg.as_bytes())
        server.quit()

        if failed:
            real_failed = {k: v for k, v in failed.items() if "@" in k}
            failed = real_failed

        if failed:
            failed_list = ", ".join(f"{k} (code {v[0]})" for k, v in failed.items())
            succeeded = [r for r in recipients if r not in failed]
            if succeeded:
                return {"status": "partial", "message": f"Delivered to {', '.join(succeeded)}. Failed: {failed_list}."}
            return {"status": "error", "message": f"All recipients failed: {failed_list}"}

        attach_note = f" with PDF ({pdf_size // 1048576} MB)" if has_pdf else ""
        return {"status": "success", "message": f"Report{attach_note} sent to {', '.join(recipients)}. If not in inbox, check Spam/Junk folder."}

    except smtplib.SMTPAuthenticationError:
        return {"status": "error", "message": "Authentication failed — for Gmail use an App Password."}
    except smtplib.SMTPRecipientsRefused as e:
        return {"status": "error", "message": f"Recipient(s) refused: {e}"}
    except smtplib.SMTPSenderRefused as e:
        return {"status": "error", "message": f"Sender refused: {e}"}
    except TimeoutError:
        return {"status": "error", "message": f"Connection timed out to {smtp_host}:{smtp_port}."}
    except Exception as exc:
        log.error("Email send error: %s", exc, exc_info=True)
        return {"status": "error", "message": str(exc)}


# ─────────────────────────────────────────────
# Background scheduler
# ─────────────────────────────────────────────

_sched_lock   = threading.Lock()
_sched_thread = None
_sched_stop   = threading.Event()


def _next_run(sched: PostgresReportSchedule) -> datetime:
    now  = datetime.utcnow()
    freq = sched.frequency or "daily"

    if freq == "hourly":
        return now.replace(minute=sched.minute or 0, second=0, microsecond=0) + timedelta(hours=1)

    if freq == "daily":
        candidate = now.replace(hour=sched.hour or 7, minute=sched.minute or 0, second=0, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        return candidate

    if freq == "weekly":
        dow = int(sched.day_of_week or 0)
        days_ahead = (dow - now.weekday()) % 7
        candidate = (now + timedelta(days=days_ahead)).replace(
            hour=sched.hour or 7, minute=sched.minute or 0, second=0, microsecond=0)
        if candidate <= now:
            candidate += timedelta(weeks=1)
        return candidate

    if freq == "monthly":
        try:
            candidate = now.replace(day=sched.day_of_month or 1, hour=sched.hour or 7,
                                    minute=sched.minute or 0, second=0, microsecond=0)
        except ValueError:
            candidate = now.replace(day=28, hour=sched.hour or 7, minute=sched.minute or 0,
                                    second=0, microsecond=0)
        if candidate <= now:
            candidate = candidate.replace(month=now.month + 1) if now.month < 12 else candidate.replace(year=now.year + 1, month=1)
        return candidate

    if freq == "yearly":
        target_month = int(sched.day_of_week or 1)
        target_day   = int(sched.day_of_month or 1)
        try:
            candidate = now.replace(month=target_month, day=target_day, hour=sched.hour or 7,
                                    minute=sched.minute or 0, second=0, microsecond=0)
        except ValueError:
            candidate = now.replace(month=target_month, day=28, hour=sched.hour or 7,
                                    minute=sched.minute or 0, second=0, microsecond=0)
        if candidate <= now:
            candidate = candidate.replace(year=now.year + 1)
        return candidate

    candidate = now.replace(hour=sched.hour or 7, minute=sched.minute or 0, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate


def _finish_schedule(sched, db_session, result=None, error=None):
    """Record the outcome and ALWAYS move next_run_at forward.

    The scheduler re-picks any row whose next_run_at is still in the past, so a
    row that fails to advance re-fires every 60s indefinitely. Advancing here
    unconditionally means a broken schedule retries at its next *scheduled*
    time instead of hammering (and, if the send half-succeeded, stops it
    emailing on every tick).
    """
    sched.last_sent_at = datetime.utcnow()
    if error is not None:
        sched.last_status = "error"
    elif isinstance(result, dict):
        sched.last_status = result.get("status") or "unknown"
    sched.next_run_at = _next_run(sched)
    db_session.commit()

def _run_schedule(sched: PostgresReportSchedule, db_session):
    recipients = json.loads(sched.recipient_emails or "[]")
    if not recipients:
        # Reschedule even though there is nothing to send. Returning here
        # WITHOUT advancing next_run_at left the row permanently due, so the
        # 60s scheduler tick re-picked it forever — a hot loop burning a DB
        # query every minute for a schedule that can never deliver.
        sched.last_status = "no recipients"
        sched.next_run_at = _next_run(sched)
        db_session.commit()
        return

    smtp_host = sched.smtp_host; smtp_port = sched.smtp_port or 587
    smtp_user = sched.smtp_user; smtp_password = sched.smtp_password
    smtp_tls  = sched.smtp_tls if sched.smtp_tls is not None else True
    sender_email = sched.sender_email; sender_name = sched.sender_name or "Actmon Monitor"

    try:
        from app.models.smtp_config_model import SmtpConfig
        cfg = (db_session.query(SmtpConfig).filter(SmtpConfig.is_default == True).first()
               or db_session.query(SmtpConfig).order_by(SmtpConfig.id).first())
        if cfg:
            smtp_host = cfg.smtp_host; smtp_port = cfg.smtp_port or 587
            smtp_user = cfg.smtp_user; smtp_password = cfg.smtp_password
            smtp_tls  = cfg.smtp_tls if cfg.smtp_tls is not None else True
            sender_email = cfg.sender_email; sender_name = cfg.sender_name or "Actmon Monitor"
    except Exception as exc:
        log.warning("Could not load SMTP config for schedule %s: %s", sched.id, exc)

    conn_host = conn_db = None
    try:
        from app.models.connection_model import ConnectionMaster
        conn = db_session.query(ConnectionMaster).filter(ConnectionMaster.id == sched.conn_id).first()
        if conn:
            conn_host = conn.host
            conn_db   = conn.database_name
    except Exception:
        pass

    result = send_postgres_report_email(
        conn_id=sched.conn_id, recipients=recipients,
        smtp_host=smtp_host, smtp_port=smtp_port,
        smtp_user=smtp_user, smtp_password=smtp_password,
        smtp_tls=smtp_tls, sender_email=sender_email, sender_name=sender_name,
        report_period=sched.report_period or "24h",
        base_url="http://localhost:8000",
        conn_host=conn_host, conn_db=conn_db,
    )
    _finish_schedule(sched, db_session, result)


def _scheduler_loop():
    from app.database.connection import SessionLocal
    while not _sched_stop.is_set():
        try:
            with SessionLocal() as session:
                now       = datetime.utcnow()
                schedules = session.query(PostgresReportSchedule).filter(
                    PostgresReportSchedule.enabled == True,
                    PostgresReportSchedule.next_run_at <= now,
                ).all()
                for sched in schedules:
                    try:
                        _run_schedule(sched, session)
                    except Exception as exc:
                        # An exception here means _run_schedule did not reach
                        # _finish_schedule, so next_run_at is still in the past
                        # and this row would re-fire on every 60s tick. Force it
                        # forward and record why, so a broken schedule degrades
                        # to "retries next cycle" instead of a mail storm.
                        log.error("Schedule %s error: %s", sched.id, exc)
                        try:
                            session.rollback()
                            _finish_schedule(sched, session, error=exc)
                        except Exception as exc2:
                            log.error("Schedule %s could not be rescheduled: %s", sched.id, exc2)
                            session.rollback()
        except Exception as exc:
            log.error("Scheduler tick error: %s", exc)
        _sched_stop.wait(60)


def start_postgres_report_scheduler():
    global _sched_thread
    with _sched_lock:
        if _sched_thread and _sched_thread.is_alive():
            return
        _sched_stop.clear()
        _sched_thread = threading.Thread(target=_scheduler_loop, daemon=True,
                                          name="postgres_report_scheduler")
        _sched_thread.start()
        log.info("PostgreSQL report scheduler started")


def stop_postgres_report_scheduler():
    _sched_stop.set()


# ─────────────────────────────────────────────
# Schedule CRUD service functions
# ─────────────────────────────────────────────

def svc_list_schedules(conn_id: int, db: Session) -> dict:
    rows = db.query(PostgresReportSchedule).filter(
        PostgresReportSchedule.conn_id == conn_id
    ).order_by(PostgresReportSchedule.id).all()
    return {"status": "success", "schedules": [
        {
            "id": r.id, "schedule_name": r.schedule_name,
            "frequency": r.frequency, "hour": r.hour, "minute": r.minute,
            "day_of_week": r.day_of_week, "day_of_month": r.day_of_month,
            "recipient_emails": json.loads(r.recipient_emails or "[]"),
            "report_period": r.report_period, "enabled": r.enabled,
            "last_sent_at": r.last_sent_at.isoformat() if r.last_sent_at else None,
            "next_run_at":  r.next_run_at.isoformat()  if r.next_run_at  else None,
            "last_status":  r.last_status,
        }
        for r in rows
    ]}


def svc_create_schedule(req: ScheduleCreate, db: Session) -> dict:
    from fastapi import HTTPException
    from app.models.smtp_config_model import SmtpConfig

    cfg = (db.query(SmtpConfig).filter(SmtpConfig.is_default == True).first()
           or db.query(SmtpConfig).order_by(SmtpConfig.id).first())
    if not cfg:
        raise HTTPException(status_code=400,
            detail="No SMTP configuration saved. Go to Settings → SMTP Configuration first.")

    sched = PostgresReportSchedule(
        conn_id=req.conn_id, schedule_name=req.schedule_name,
        frequency=req.frequency, hour=req.hour, minute=req.minute,
        day_of_week=req.day_of_week, day_of_month=req.day_of_month,
        recipient_emails=json.dumps(req.recipient_emails),
        smtp_host=cfg.smtp_host, smtp_port=cfg.smtp_port or 587,
        smtp_user=cfg.smtp_user, smtp_password=cfg.smtp_password,
        smtp_tls=cfg.smtp_tls if cfg.smtp_tls is not None else True,
        sender_email=cfg.sender_email, sender_name=cfg.sender_name or "Actmon Monitor",
        report_period=req.report_period, enabled=req.enabled,
        created_at=datetime.utcnow(), updated_at=datetime.utcnow(),
    )
    sched.next_run_at = _next_run(sched)
    db.add(sched); db.commit(); db.refresh(sched)
    return {"status": "success", "id": sched.id,
            "next_run_at": sched.next_run_at.isoformat() if sched.next_run_at else None,
            "frequency": sched.frequency}


def svc_update_schedule(sched_id: int, req: ScheduleUpdate, db: Session) -> dict:
    from fastapi import HTTPException
    sched = db.query(PostgresReportSchedule).filter(PostgresReportSchedule.id == sched_id).first()
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")
    for k, v in req.model_dump(exclude_unset=True).items():
        if k == "recipient_emails" and v is not None:
            v = json.dumps(v)
        setattr(sched, k, v)
    sched.updated_at  = datetime.utcnow()
    sched.next_run_at = _next_run(sched)
    db.commit()
    return {"status": "success"}


def svc_delete_schedule(sched_id: int, db: Session) -> dict:
    from fastapi import HTTPException
    sched = db.query(PostgresReportSchedule).filter(PostgresReportSchedule.id == sched_id).first()
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")
    db.delete(sched); db.commit()
    return {"status": "success"}


def svc_send_report_now(req: SendEmailRequest, db: Session) -> dict:
    from fastapi import HTTPException
    from app.models.smtp_config_model import SmtpConfig
    from app.models.connection_model  import ConnectionMaster

    cfg = (db.query(SmtpConfig).filter(SmtpConfig.is_default == True).first()
           or db.query(SmtpConfig).order_by(SmtpConfig.id).first())
    if not cfg:
        raise HTTPException(status_code=400,
            detail="No SMTP configuration saved. Go to Settings → SMTP Configuration first.")

    smtp_host = cfg.smtp_host; smtp_port = cfg.smtp_port or 587
    smtp_user = cfg.smtp_user; smtp_password = cfg.smtp_password
    smtp_tls  = cfg.smtp_tls if cfg.smtp_tls is not None else True
    sender_email = cfg.sender_email; sender_name = cfg.sender_name or "Actmon Monitor"

    conn_host = conn_db = None
    conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == req.conn_id).first()
    if conn:
        conn_host = conn.host
        conn_db   = conn.database_name

    result = send_postgres_report_email(
        conn_id=req.conn_id, recipients=req.recipient_emails,
        smtp_host=smtp_host, smtp_port=smtp_port,
        smtp_user=smtp_user, smtp_password=smtp_password,
        smtp_tls=smtp_tls, sender_email=sender_email, sender_name=sender_name,
        report_period=req.report_period, base_url=req.base_url,
        pdf_base64=req.pdf_base64, db_name=req.db_name,
        conn_host=conn_host, conn_db=conn_db,
        app_url=req.base_url.replace(":8000", ":3000") if req.base_url else None,
    )
    if result["status"] == "error":
        raise HTTPException(status_code=500, detail=result["message"])
    return result
