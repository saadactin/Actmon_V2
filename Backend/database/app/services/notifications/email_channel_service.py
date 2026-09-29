"""
Email notification channel — reuses the existing smtp_configs table (no
second SMTP settings page) and generalizes the transport mechanics shared by
the four *_report_email_service.py modules (smtplib + email.mime), adding
what they don't support: Cc/Bcc, a plain-text alternative alongside the HTML
part, and a caller-supplied subject/body instead of a hardcoded report body.
"""
import base64
import logging
import re
import smtplib
import socket
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy.orm import Session

from app.models.smtp_config_model import SmtpConfig

log = logging.getLogger("email_channel")


def get_default_smtp_config(db: Session) -> Optional[SmtpConfig]:
    """Same lookup every existing report-email service uses: the config
    marked default, else the first one — one answer to "which SMTP config
    sends alert emails"."""
    return (
        db.query(SmtpConfig).filter(SmtpConfig.is_default == True).first()
        or db.query(SmtpConfig).order_by(SmtpConfig.id).first()
    )


def resolve_password(cfg: SmtpConfig) -> Optional[str]:
    """Decrypted password if this config was saved after the encryption
    retrofit, else the legacy plaintext column."""
    if cfg.smtp_password_enc:
        try:
            from app.services.common.crypto_service import decrypt_secret
            return decrypt_secret(cfg.smtp_password_enc)
        except Exception:
            log.warning("Could not decrypt smtp_password_enc for config %s", cfg.id)
    return cfg.smtp_password


_SAFE_FILENAME = re.compile(r"[^A-Za-z0-9._ -]+")


def build_message(cfg: Any, *, to: List[str], cc: List[str], subject: str,
                  html_body: Optional[str], text_body: Optional[str],
                  attachments: Optional[Sequence[Dict[str, Any]]] = None) -> MIMEMultipart:
    """The MIME message, without sending it.

    No attachments: multipart/alternative (text + HTML), exactly the shape
    every alert e-mail has always had. With attachments: multipart/mixed
    wrapping that same alternative part, plus one part per file. Raises
    ValueError for an attachment whose content cannot be decoded.
    """
    alt = MIMEMultipart("alternative")
    if text_body:
        alt.attach(MIMEText(text_body, "plain", "utf-8"))
    if html_body:
        alt.attach(MIMEText(html_body, "html", "utf-8"))

    if attachments:
        msg = MIMEMultipart("mixed")
        msg.attach(alt)
        for a in attachments:
            name = _SAFE_FILENAME.sub("_", str(a.get("filename") or "attachment")).strip() \
                or "attachment"
            try:
                data = base64.b64decode(a.get("content_b64") or "", validate=True)
            except (ValueError, TypeError) as exc:
                raise ValueError(f"Attachment {name!r} could not be decoded: {exc}") from exc
            subtype = (str(a.get("content_type") or "application/octet-stream")
                       .split("/", 1)[-1] or "octet-stream")
            part = MIMEApplication(data, _subtype=subtype, Name=name)
            part["Content-Disposition"] = f'attachment; filename="{name}"'
            msg.attach(part)
    else:
        msg = alt

    msg["Subject"] = subject
    msg["From"] = f"{cfg.sender_name} <{cfg.sender_email}>" if cfg.sender_name else cfg.sender_email
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["X-Mailer"] = "ActMon Alert Notifications"
    return msg


def send_email(
    cfg: SmtpConfig,
    to: List[str],
    subject: str,
    html_body: Optional[str] = None,
    text_body: Optional[str] = None,
    cc: Optional[List[str]] = None,
    bcc: Optional[List[str]] = None,
    timeout: int = 15,
    attachments: Optional[Sequence[Dict[str, Any]]] = None,
) -> dict:
    """Send one email through `cfg`. Returns {status: 'success'|'partial'|'error',
    message, response_code}. Mirrors the exception handling the report-email
    services already use, so failures read the same way everywhere."""
    to = [a for a in (to or []) if a]
    cc = [a for a in (cc or []) if a]
    bcc = [a for a in (bcc or []) if a]
    if not to and not cc and not bcc:
        return {"status": "error", "message": "No recipients specified.", "response_code": None}
    if not html_body and not text_body:
        text_body = ""

    # Built before the network is touched, so a malformed attachment is a
    # clean error rather than a half-sent message.
    try:
        msg = build_message(cfg, to=to, cc=cc, subject=subject, html_body=html_body,
                            text_body=text_body, attachments=attachments)
    except ValueError as exc:
        return {"status": "error", "message": str(exc), "response_code": None}

    try:
        socket.getaddrinfo(cfg.smtp_host, cfg.smtp_port)
    except socket.gaierror as e:
        return {"status": "error", "message": f"DNS lookup failed for '{cfg.smtp_host}'. ({e})", "response_code": None}

    all_recipients = to + cc + bcc
    password = resolve_password(cfg)

    try:
        if cfg.smtp_tls:
            server = smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=timeout)
            server.ehlo(); server.starttls(); server.ehlo()
        else:
            server = smtplib.SMTP_SSL(cfg.smtp_host, cfg.smtp_port, timeout=timeout)
            server.ehlo()

        if cfg.smtp_user and password:
            server.login(cfg.smtp_user, password)

        failed = server.sendmail(cfg.sender_email, all_recipients, msg.as_bytes())
        server.quit()

        failed = {k: v for k, v in (failed or {}).items() if "@" in k}
        if failed:
            failed_list = ", ".join(f"{k} (code {v[0]})" for k, v in failed.items())
            succeeded = [r for r in all_recipients if r not in failed]
            if succeeded:
                return {"status": "partial", "message": f"Delivered to {', '.join(succeeded)}. Failed: {failed_list}.", "response_code": "250", "recipient": ", ".join(succeeded)}
            return {"status": "error", "message": f"All recipients failed: {failed_list}", "response_code": None}

        return {"status": "success", "message": f"Sent to {', '.join(all_recipients)}.", "response_code": "250", "recipient": ", ".join(all_recipients)}

    except smtplib.SMTPAuthenticationError:
        return {"status": "error", "message": "Authentication failed — for Gmail use an App Password, not your account password.", "response_code": "535"}
    except smtplib.SMTPRecipientsRefused as e:
        return {"status": "error", "message": f"Recipient(s) refused: {e}", "response_code": "550"}
    except smtplib.SMTPSenderRefused as e:
        return {"status": "error", "message": f"Sender refused: {e}", "response_code": "550"}
    except TimeoutError:
        return {"status": "error", "message": f"Connection timed out to {cfg.smtp_host}:{cfg.smtp_port}.", "response_code": None}
    except Exception as exc:
        log.error("Email send error: %s", exc, exc_info=True)
        return {"status": "error", "message": str(exc), "response_code": None}


def send_via_channel(
    db: Session, org_id: int, channel_config: dict, subject: str, html_body: str, text_body: str,
    recipients_override: Optional[List[str]] = None,
    cc_override: Optional[List[str]] = None,
    bcc_override: Optional[List[str]] = None,
    attachments: Optional[Sequence[Dict[str, Any]]] = None,
) -> dict:
    """Entry point used by the notification dispatcher. Who it sends to comes
    ENTIRELY from the firing alert rule's own To/Cc/Bcc — there is no
    org-wide default recipient and no fallback to the SMTP sender's own
    address. A rule using the "email" channel without at least one recipient
    is a configuration mistake, and this says so plainly instead of quietly
    emailing whoever happens to own the mailbox."""
    cfg = get_default_smtp_config(db)
    if not cfg:
        return {"status": "error", "message": "No SMTP configuration saved yet — add one in Settings → Notifications → Email.", "response_code": None}
    to = [a for a in (recipients_override or []) if a]
    cc = [a for a in (cc_override or []) if a]
    bcc = [a for a in (bcc_override or []) if a]
    if not to and not cc and not bcc:
        return {
            "status": "error",
            "message": "No recipient configured for this alert rule — add one under Notify via → Email recipients on the rule.",
            "response_code": None,
        }
    return send_email(cfg, to=to, subject=subject, html_body=html_body, text_body=text_body,
                      cc=cc, bcc=bcc, attachments=attachments)
