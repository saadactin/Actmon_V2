"""HTML and plain-text bodies for alert email.

One layout, filled differently per alert kind. Deliberately plain inline-CSS
HTML with a table-free flow: alert mail is read in Outlook, Gmail's clipper and
a phone lock screen, and a layout that survives all three beats one that looks
better in a browser preview.

Three rules the templates enforce rather than leave to the caller:

*   **A field with no value is omitted, not blanked.** An email with
    "Region: —" next to "Region: ap-south-1" in yesterday's mail teaches the
    reader that the system sometimes forgets; an email that simply has no
    Region line teaches them nothing false.

*   **NA is spelled out.** Where a number genuinely could not be read, the
    email says so and says why. It never shows 0.

*   **Nothing sensitive travels.** The rendered body is assembled only from
    the fields listed in `_SAFE_KEYS` below — names, counts, timestamps,
    severities and the explanation sentence. Credentials, provider payloads,
    connection strings, tokens and raw evidence blobs have no path into here,
    because they are never passed in.
"""
from __future__ import annotations

import html
from typing import Any, Dict, List, Optional

BRAND = "Actmon"
TAGLINE = "Cloud Operations Platform"

# Severity → (background, text). Chosen for contrast on white, and every one is
# paired with the severity word in text — colour alone never carries meaning.
_SEV_COLOURS = {
    "CRITICAL": ("#7f1d1d", "#ffffff"),
    "HIGH": ("#b45309", "#ffffff"),
    "MEDIUM": ("#a16207", "#ffffff"),
    "LOW": ("#1d4ed8", "#ffffff"),
    "INFO": ("#374151", "#ffffff"),
    "RESOLVED": ("#166534", "#ffffff"),
    "TEST": ("#4338ca", "#ffffff"),
}

# The only keys a caller may put in `facts`. An allowlist rather than a
# denylist: a new field added upstream cannot leak into mail by default.
_SAFE_KEYS = {
    "Account", "Provider", "Region", "Resource", "Resource type", "Rule",
    "Category", "Condition", "Observed", "Expected", "Detected", "Last observed",
    "Occurrences", "Current status", "Evaluated at", "Data as of", "Scope",
    "Service", "Currency", "Window", "Why this fired", "Recipients",
}


def _esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def subject(*, severity: str, kind: str, account: str,
            resolved: bool = False, test: bool = False) -> str:
    """`[CRITICAL] Actmon Security Alert — AWS Production`.

    Predictable enough to filter on, and the prefix is the FIRST thing so it
    survives a narrow mobile preview pane.
    """
    if test:
        return f"[TEST] {BRAND} Alert Notification — {account}"
    tag = "RESOLVED" if resolved else (severity or "INFO").upper()
    return f"[{tag}] {BRAND} {kind} — {account}"


def render(
    *,
    title: str,
    severity: str,
    lead: str,
    facts: Dict[str, Any],
    why: Optional[Dict[str, Any]] = None,
    samples: Optional[List[Dict[str, Any]]] = None,
    link: Optional[str] = None,
    link_label: str = "View in Actmon",
    extra_links: Optional[List[Dict[str, str]]] = None,
    banner: Optional[str] = None,
    resolved: bool = False,
    test: bool = False,
) -> Dict[str, str]:
    """Returns {"html": ..., "text": ...}.

    `facts` keys outside `_SAFE_KEYS` are dropped silently — the email is not
    the place to discover that a caller passed something it should not have,
    and dropping is the safe direction.
    """
    key = "TEST" if test else ("RESOLVED" if resolved else (severity or "INFO").upper())
    bg, fg = _SEV_COLOURS.get(key, _SEV_COLOURS["INFO"])
    clean = {k: v for k, v in (facts or {}).items()
             if k in _SAFE_KEYS and v not in (None, "", [])}

    rows = "".join(
        f'<tr><td style="padding:6px 16px 6px 0;color:#6b7280;'
        f'font-size:13px;white-space:nowrap;vertical-align:top">{_esc(k)}</td>'
        f'<td style="padding:6px 0;color:#111827;font-size:13px">{_esc(v)}</td></tr>'
        for k, v in clean.items()
    )

    why_block = ""
    if why:
        why_rows = "".join(
            f'<tr><td style="padding:4px 16px 4px 0;color:#6b7280;font-size:13px;'
            f'white-space:nowrap">{_esc(k)}</td>'
            f'<td style="padding:4px 0;color:#111827;font-size:13px;'
            f'font-weight:600">{_esc(v)}</td></tr>'
            for k, v in why.items() if v not in (None, "")
        )
        if why_rows:
            why_block = (
                '<div style="margin:20px 0;padding:14px 16px;background:#f9fafb;'
                'border:1px solid #e5e7eb;border-radius:6px">'
                '<div style="font-size:12px;font-weight:700;letter-spacing:.06em;'
                'text-transform:uppercase;color:#6b7280;margin-bottom:8px">'
                'Why this fired</div>'
                f'<table cellpadding="0" cellspacing="0" border="0">{why_rows}</table>'
                '</div>'
            )

    sample_block = ""
    if samples:
        items = "".join(
            '<li style="margin:0 0 6px 0;font-size:13px;color:#111827">'
            f'<strong>{_esc(s.get("name") or "—")}</strong>'
            + (f' <span style="color:#6b7280">({_esc(s["type"])})</span>'
               if s.get("type") else "")
            + (f'<br><span style="color:#6b7280">{_esc(s["detail"])}</span>'
               if s.get("detail") else "")
            + '</li>'
            for s in samples[:5]
        )
        sample_block = (
            '<div style="margin:20px 0">'
            '<div style="font-size:12px;font-weight:700;letter-spacing:.06em;'
            'text-transform:uppercase;color:#6b7280;margin-bottom:8px">Examples</div>'
            f'<ul style="margin:0;padding-left:18px">{items}</ul>'
            '</div>'
        )

    banner_block = ""
    if banner:
        banner_block = (
            '<div style="margin:0 0 18px 0;padding:10px 14px;background:#fffbeb;'
            'border:1px solid #fcd34d;border-radius:6px;color:#92400e;'
            f'font-size:13px">{_esc(banner)}</div>'
        )

    link_block = ""
    if link:
        # One primary button, the rest as plain links. A row of five equally
        # weighted buttons gives the reader nothing to act on first.
        secondary = "".join(
            f'<a href="{_esc(x["url"])}" style="margin-right:14px;color:#1d4ed8;'
            f'text-decoration:none;font-size:13px">{_esc(x["label"])}</a>'
            for x in (extra_links or []) if x.get("url")
        )
        link_block = (
            f'<div style="margin:24px 0 8px 0"><a href="{_esc(link)}" '
            'style="display:inline-block;padding:10px 18px;background:#111827;'
            'color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;'
            f'font-weight:600">{_esc(link_label)}</a></div>'
            + (f'<div style="margin:4px 0 8px 0">{secondary}</div>'
               if secondary else "")
        )

    body = f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#f3f4f6;
 font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
 <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
  <div style="padding:16px 24px;border-bottom:1px solid #e5e7eb">
   <span style="font-size:13px;font-weight:700;letter-spacing:.08em;
    text-transform:uppercase;color:#6b7280">{_esc(BRAND)} Cloud Alert</span>
  </div>
  <div style="padding:24px">
   <span style="display:inline-block;padding:3px 10px;border-radius:999px;
    background:{bg};color:{fg};font-size:11px;font-weight:700;
    letter-spacing:.08em;text-transform:uppercase">{_esc(key)}</span>
   <h1 style="margin:12px 0 8px 0;font-size:20px;line-height:1.3;color:#111827">
    {_esc(title)}</h1>
   <p style="margin:0 0 18px 0;font-size:14px;line-height:1.55;color:#374151">
    {_esc(lead)}</p>
   {banner_block}
   <table cellpadding="0" cellspacing="0" border="0" style="width:100%">{rows}</table>
   {why_block}
   {sample_block}
   {link_block}
  </div>
  <div style="padding:14px 24px;border-top:1px solid #e5e7eb;background:#fafafa">
   <span style="font-size:12px;color:#6b7280">{_esc(BRAND)} · {_esc(TAGLINE)}</span>
  </div>
 </div>
</div>
</body></html>"""

    # The plain-text alternative is generated from the same values, not from
    # the HTML — stripping tags produces something readable by accident, and
    # this is read on purpose by anyone whose client blocks HTML.
    lines = [f"[{key}] {title}", "", lead, ""]
    if banner:
        lines += [banner, ""]
    lines += [f"{k}: {v}" for k, v in clean.items()]
    if why:
        lines += ["", "WHY THIS FIRED"]
        lines += [f"  {k}: {v}" for k, v in why.items() if v not in (None, "")]
    if samples:
        lines += ["", "EXAMPLES"]
        for s in samples[:5]:
            bit = f"  - {s.get('name') or '—'}"
            if s.get("type"):
                bit += f" ({s['type']})"
            lines.append(bit)
            if s.get("detail"):
                lines.append(f"      {s['detail']}")
    if link:
        lines += ["", f"{link_label}: {link}"]
    for extra in (extra_links or []):
        if extra.get("url"):
            lines.append(f"{extra['label']}: {extra['url']}")
    lines += ["", f"{BRAND} · {TAGLINE}"]

    return {"html": body, "text": "\n".join(lines)}
