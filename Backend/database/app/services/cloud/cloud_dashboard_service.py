"""
Cloud Dashboard — a cross-account KPI overview for Cloud Engineers, separate
from the main Admin Dashboard (frontend/src/pages/Dashboard.jsx), which must
never show Database/Infrastructure data to a role that only holds Cloud
Dashboard access.

The actual cloud data (accounts, resources, cost, security, alerts) lives in
the SEPARATE Cloud microservice (Backend/cloud, its own FastAPI app/DB, not
this one) — this module is a thin, server-to-server AGGREGATOR that calls
that service's already-existing endpoints and reduces them to the handful of
numbers a KPI dashboard needs. This is a deliberate proxy, not a rewrite:

  - The route this service backs (cloud_dashboard_routes.py) is gated with
    this app's own require_permission()/page_master RBAC — real backend
    authorization, 403 on denial, same as every other governed route here.
  - The Cloud microservice's OWN RBAC (Backend/cloud/app/api/rbac.py) is off
    by default in this deployment and has no org-scoping at all (no org_id
    column anywhere in its schema) — a pre-existing gap in that service,
    not something this one new page can or should silently paper over. This
    proxy does not attempt to add tenant isolation the underlying service
    doesn't have; it only adds the permission gate this specific dashboard
    needs. A genuinely multi-tenant Cloud module needs that service's own
    org_id + JWT bridge fixed directly, a separate, larger piece of work.

Every call below is independently best-effort: one endpoint being slow or
down degrades that one KPI to "unavailable" rather than failing the whole
dashboard — same discipline as every Oracle panel this session.
"""
import math
import os
import logging
import time

import requests

logger = logging.getLogger("cloud_dashboard")

CLOUD_SERVICE_BASE = os.getenv("CLOUD_SERVICE_URL", "http://127.0.0.1:8001").rstrip("/")
_TIMEOUT_SECONDS = 6


def _get(path, params=None):
    """One best-effort GET against the Cloud microservice. Returns None (never
    raises) on any failure — timeout, connection refused, non-2xx, bad JSON —
    so one slow/down endpoint only blanks its own KPI, never the page."""
    url = f"{CLOUD_SERVICE_BASE}/api/v1{path}"
    try:
        r = requests.get(url, params=params or {}, timeout=_TIMEOUT_SECONDS)
        r.raise_for_status()
        return r.json()
    except Exception as exc:  # noqa: BLE001 — best-effort, logged not raised
        logger.info("[cloud_dashboard] GET %s failed: %s", path, exc)
        return None


def svc_cloud_dashboard_overview():
    t0 = time.perf_counter()
    errors = []

    accounts = _get("/cloud/accounts")
    if accounts is None:
        errors.append("accounts: Cloud service did not respond")
        accounts = []

    by_provider_accounts = {}
    # Per-provider health split (ok/scanning/failed/never_scanned, from each
    # account's own last_discovery_status) — for the "Cloud Connections by
    # Provider" breakdown chart, same shape as the Admin Dashboard's
    # "Servers By Database Technologies" (category x status), not just a
    # second view of the plain provider counts already in by_provider_accounts.
    by_provider_status = {}
    for a in accounts:
        p = (a.get("provider") or "unknown").upper()
        by_provider_accounts[p] = by_provider_accounts.get(p, 0) + 1
        status = str(a.get("last_discovery_status") or "never_scanned").lower()
        if status not in ("ok", "scanning", "failed"):
            status = "never_scanned"
        bucket = by_provider_status.setdefault(p, {"ok": 0, "scanning": 0, "failed": 0, "never_scanned": 0})
        bucket[status] += 1

    resources_summary = _get("/cloud/resources/query/ALL", params={"include_facets": "false", "include_summary": "false"})
    resources_total = None
    if resources_summary is None:
        errors.append("resources: Cloud service did not respond")
    else:
        resources_total = resources_summary.get("total")

    security = _get("/cloud/security-center/overview")
    # Summed across every account's own findings_by_severity — by_provider
    # (used below only for the provider donut) only carries critical/high,
    # not the full scale, so the severity breakdown is built from the
    # per-account rows directly instead.
    severity_totals = {"CRITICAL": 0, "HIGH": 0, "MEDIUM": 0, "LOW": 0}
    security_resources = 0
    security_active_alerts = 0
    if security is None:
        errors.append("security: Cloud service did not respond")
    else:
        for acc in (security.get("accounts") or []):
            for sev, count in (acc.get("findings_by_severity") or {}).items():
                key = str(sev).upper()
                if key in severity_totals:
                    severity_totals[key] += count
            security_resources += acc.get("resources") or 0
            security_active_alerts += acc.get("active_alerts") or 0

    alert_counts = _get("/cloud/alerts/counts")
    if alert_counts is None:
        errors.append("alerts: Cloud service did not respond")
        alert_counts = {}

    # Real alert records (not just counts) for the Recent Alerts panel —
    # newest first, open+acknowledged only (matches the default feed
    # everywhere else in the app: what still needs attention).
    accounts_by_id = {a.get("id"): a for a in accounts if a.get("id")}
    alert_rows = _get("/cloud/alerts") or []
    # CloudAlert's own severity scale (CRITICAL/HIGH/MEDIUM/LOW) is coarser
    # than the shared frontend severityOf() scale (critical/warning/info) —
    # map it here so HIGH reads as a real warning instead of being lumped
    # into "info" alongside LOW.
    _SEVERITY_MAP = {"CRITICAL": "critical", "HIGH": "warning", "MEDIUM": "warning", "LOW": "info"}
    recent_alerts = [
        {
            "id": a.get("id"),
            "severity": _SEVERITY_MAP.get(str(a.get("severity") or "").upper(), "info"),
            "source": a.get("resource_name") or (accounts_by_id.get(a.get("account_id")) or {}).get("account_name") or "Unknown account",
            "rule_name": (a.get("anomaly_type") or "").replace("_", " ").title(),
            "message": a.get("details"),
            "timestamp": a.get("created_at"),
        }
        for a in alert_rows
    ]

    # Cost has no cross-account endpoint (every route in Backend/cloud's
    # cost.py is per-account) — sum the small number of real accounts
    # server-to-server rather than adding a new endpoint to that service for
    # one number. Each account's cost call is independently best-effort so
    # one account's billing-API hiccup doesn't blank the whole total — and a
    # single NaN/Infinity from a bad billing-API response is dropped rather
    # than poisoning the running sum for every other account.
    cost_total = 0.0
    cost_available = False
    cost_currency = None
    for a in accounts:
        acc_id = a.get("id")
        if not acc_id:
            continue
        summary = _get(f"/cloud/cost/{acc_id}")
        raw = summary.get("total_monthly_cost") if summary else None
        if raw is None:
            continue
        try:
            fval = float(raw)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(fval):
            continue
        cost_total += fval
        cost_available = True
        cost_currency = cost_currency or summary.get("currency")
    if not cost_available:
        errors.append("cost: no billing data available for any account")

    elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
    logger.info("[cloud_dashboard] overview built in %sms (%s error(s))", elapsed_ms, len(errors))

    return {
        "status": "success",
        "accounts": {
            "total": len(accounts),
            "by_provider": by_provider_accounts,
            "by_provider_status": by_provider_status,
        },
        "resources": {
            "total": resources_total,
        },
        "security": {
            "critical_findings": severity_totals["CRITICAL"],
            "high_findings": severity_totals["HIGH"],
            "medium_findings": severity_totals["MEDIUM"],
            "low_findings": severity_totals["LOW"],
            "resources_assessed": security_resources,
            "active_alerts": security_active_alerts,
        },
        "alerts": {
            "open": alert_counts.get("OPEN", 0),
            "acknowledged": alert_counts.get("ACKNOWLEDGED", 0),
            "resolved": alert_counts.get("RESOLVED", 0),
            "recent": recent_alerts,
        },
        "cost": {
            "total_monthly": round(cost_total, 2) if cost_available else None,
            "currency": cost_currency,
            "available": cost_available,
        },
        "errors": errors,
        "execution_time_ms": elapsed_ms,
    }
