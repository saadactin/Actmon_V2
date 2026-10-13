"""
Tests for e-mail attachments in the notification dispatcher.

Run with:  pytest tests/test_email_attachments.py -v

The cloud service's monthly client reports queue a PDF as an attachment on
the shared notification queue. Two properties matter more than the feature:

* A message WITHOUT attachments is built exactly as before — every alert
  e-mail in the product goes through this path.
* A malformed attachment is refused before any SMTP connection is opened, so
  it can never produce a half-sent message.
"""
import base64

import pytest

from app.services.notifications import email_channel_service as ecs


class _Cfg:
    sender_name = "Actmon"
    sender_email = "noreply@example.com"
    smtp_host = "smtp.invalid"
    smtp_port = 25
    smtp_tls = False
    smtp_user = None


def test_no_attachments_keeps_the_alternative_shape():
    msg = ecs.build_message(_Cfg(), to=["a@example.com"], cc=[], subject="S",
                            html_body="<p>h</p>", text_body="t")
    assert msg.get_content_type() == "multipart/alternative"
    assert [p.get_content_type() for p in msg.get_payload()] == ["text/plain", "text/html"]
    assert msg["X-Mailer"] == "ActMon Alert Notifications"


def test_attachment_is_carried_intact():
    pdf = b"%PDF-1.4 report bytes"
    msg = ecs.build_message(
        _Cfg(), to=["a@example.com"], cc=["c@example.com"], subject="Report",
        html_body="<p>h</p>", text_body="t",
        attachments=[{"filename": "Report-2026-08.pdf", "content_type": "application/pdf",
                      "content_b64": base64.b64encode(pdf).decode()}])
    parts = msg.get_payload()
    assert msg.get_content_type() == "multipart/mixed"
    assert parts[0].get_content_type() == "multipart/alternative"
    assert parts[1].get_content_type() == "application/pdf"
    assert parts[1].get_filename() == "Report-2026-08.pdf"
    assert parts[1].get_payload(decode=True) == pdf
    assert msg["Cc"] == "c@example.com"


def test_filename_cannot_carry_a_path():
    msg = ecs.build_message(
        _Cfg(), to=["a@example.com"], cc=[], subject="S", html_body="h", text_body="t",
        attachments=[{"filename": "../../etc/passwd", "content_type": "text/plain",
                      "content_b64": base64.b64encode(b"x").decode()}])
    assert "/" not in msg.get_payload()[1].get_filename()


def test_malformed_attachment_is_refused_before_sending(monkeypatch):
    def _no_network(*a, **k):  # pragma: no cover - must not be reached
        raise AssertionError("no DNS lookup or SMTP connection should happen")

    monkeypatch.setattr(ecs.socket, "getaddrinfo", _no_network)
    result = ecs.send_email(_Cfg(), to=["a@example.com"], subject="S", html_body="h",
                            text_body="t",
                            attachments=[{"filename": "x.pdf", "content_b64": "***"}])
    assert result["status"] == "error"
    assert "could not be decoded" in result["message"]


def test_dispatcher_passes_attachments_through(monkeypatch):
    from app.services.notifications import channel_dispatch

    seen = {}

    def _capture(db, org_id, config, subject, html, text, **kw):
        seen.update(kw)
        return {"status": "success"}

    monkeypatch.setattr(ecs, "send_via_channel", _capture)

    class _Row:
        config = {}

    atts = [{"filename": "r.pdf", "content_type": "application/pdf", "content_b64": "eA=="}]
    channel_dispatch._send_email(None, 1, _Row(), {}, recipients_override=["a@example.com"],
                                 prerendered={"subject": "S", "html": "<p>h</p>",
                                              "text": "t", "attachments": atts})
    assert seen.get("attachments") == atts
    seen.clear()
    channel_dispatch._send_email(None, 1, _Row(), {}, recipients_override=["a@example.com"],
                                 prerendered={"subject": "S", "html": "<p>h</p>", "text": "t"})
    assert seen.get("attachments") is None
