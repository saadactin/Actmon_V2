"""Starting points for a rule, and the set recommended after a fresh install.

A template is *only* a set of defaults for the builder. It is not a second
place where a condition is defined: every template names a `condition_type`
from `catalog.py` and supplies values for that condition's own fields, and
`validate_template()` proves it — so a template cannot drift into describing a
condition the engine does not have, or setting a field it does not read.

Two things deliberately absent:

*   **No template is installed automatically.** `RECOMMENDED` is a list the UI
    offers; nothing creates rules on boot. A product that quietly starts
    emailing people after an upgrade has broken trust before it has delivered
    any value.

*   **Recommended rules are created DISABLED and with notifications off** until
    the operator turns them on. The point of the recommended set is to save
    somebody typing seven rules, not to start paging them.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

from app.services.alerts import catalog


@dataclass(frozen=True)
class Template:
    key: str
    label: str
    summary: str
    # Why someone would want this, in one sentence. Shown under the label.
    rationale: str
    condition_type: str
    condition_config: Dict[str, Any]
    severity: str
    suggested_name: str
    evaluation_interval_seconds: int = 300
    cooldown_seconds: int = 3600
    repeat_interval_seconds: int = 0
    notify_on_resolution: bool = False
    min_duration_seconds: int = 0
    consecutive_breaches_required: int = 1
    scope_config: Optional[Dict[str, Any]] = None
    # True when this template needs a value only the operator can supply
    # (an amount, a currency). The builder opens on the condition step for
    # these rather than on review.
    needs_input: Sequence[str] = ()

    @property
    def category(self) -> str:
        return catalog.get(self.condition_type).category

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "summary": self.summary,
            "rationale": self.rationale,
            "category": self.category,
            "condition_type": self.condition_type,
            "condition_config": dict(self.condition_config),
            "scope_config": dict(self.scope_config or {}),
            "severity": self.severity,
            "suggested_name": self.suggested_name,
            "evaluation_interval_seconds": self.evaluation_interval_seconds,
            "cooldown_seconds": self.cooldown_seconds,
            "repeat_interval_seconds": self.repeat_interval_seconds,
            "notify_on_resolution": self.notify_on_resolution,
            "min_duration_seconds": self.min_duration_seconds,
            "consecutive_breaches_required": self.consecutive_breaches_required,
            "needs_input": list(self.needs_input),
        }


TEMPLATES: Dict[str, Template] = {t.key: t for t in (
    Template(
        key="critical_security_finding",
        label="Critical security finding",
        summary="Any confirmed CRITICAL finding is open.",
        rationale="The smallest useful security alert: one confirmed critical "
                  "finding is already worth someone's morning.",
        condition_type=catalog.SECURITY_FINDING_COUNT,
        condition_config={"severity_filter": "CRITICAL",
                          "operator": catalog.OP_GT, "threshold": 0},
        severity="CRITICAL",
        suggested_name="Critical security findings",
        cooldown_seconds=21600,
        notify_on_resolution=True,
    ),
    Template(
        key="high_security_findings",
        label="High findings above a bar",
        summary="More than ten confirmed HIGH findings are open.",
        rationale="High-severity findings accumulate rather than spike, so a "
                  "count bar is more useful than firing on the first one.",
        condition_type=catalog.SECURITY_FINDING_COUNT,
        condition_config={"severity_filter": "HIGH",
                          "operator": catalog.OP_GT, "threshold": 10},
        severity="HIGH",
        suggested_name="High security findings above 10",
        cooldown_seconds=86400,
    ),
    Template(
        key="security_score_drop",
        label="Security posture below a bar",
        summary="The Security Center's published score drops under 70.",
        rationale="A single score covers regressions that no individual "
                  "finding rule would catch.",
        condition_type=catalog.SECURITY_SCORE_BELOW,
        condition_config={"threshold": 70},
        severity="HIGH",
        suggested_name="Security score below 70",
        evaluation_interval_seconds=3600,
        cooldown_seconds=86400,
        notify_on_resolution=True,
    ),
    Template(
        key="budget_breach",
        label="Spend over a monthly budget",
        summary="Month-to-date spend passes an amount you set.",
        rationale="The one cost alert everybody wants. Needs your figure and "
                  "currency — amounts are never converted.",
        condition_type=catalog.COST_THRESHOLD,
        condition_config={"period": "month_to_date", "operator": catalog.OP_GT},
        severity="HIGH",
        suggested_name="Monthly spend over budget",
        evaluation_interval_seconds=3600,
        cooldown_seconds=86400,
        # Two consecutive reads, because a throttled billing API is common and
        # a one-off partial window should not page finance.
        consecutive_breaches_required=2,
        needs_input=("threshold", "currency"),
    ),
    Template(
        key="cost_spike",
        label="Cost spike against last week",
        summary="The last 7 days cost 30% more than the 7 before.",
        rationale="Catches a change in run-rate rather than an absolute number, "
                  "so it keeps working as the estate grows.",
        condition_type=catalog.COST_INCREASE_PERCENT,
        condition_config={"window_days": "7", "threshold_percent": 30},
        severity="HIGH",
        suggested_name="Weekly cost spike over 30%",
        evaluation_interval_seconds=3600,
        cooldown_seconds=86400,
        needs_input=("currency",),
    ),
    Template(
        key="daily_cost_spike",
        label="Daily cost spike",
        summary="Yesterday cost 50% more than the day before.",
        rationale="Faster than the weekly version and noisier — worth pairing "
                  "with a floor so small amounts stay quiet.",
        condition_type=catalog.COST_INCREASE_PERCENT,
        condition_config={"window_days": "1", "threshold_percent": 50},
        severity="MEDIUM",
        suggested_name="Daily cost spike over 50%",
        evaluation_interval_seconds=3600,
        cooldown_seconds=86400,
        needs_input=("currency",),
    ),
    Template(
        key="billing_unavailable",
        label="Billing data unavailable",
        summary="Actmon cannot read this account's billing API.",
        rationale="Without this, a permission or throttling problem looks "
                  "exactly like an account that stopped spending money.",
        condition_type=catalog.COST_DATA_UNAVAILABLE,
        condition_config={},
        severity="HIGH",
        suggested_name="Billing data unavailable",
        evaluation_interval_seconds=1800,
        cooldown_seconds=21600,
        notify_on_resolution=True,
        # One bad read is usually a transient 429; two in a row is a problem.
        consecutive_breaches_required=2,
    ),
    Template(
        key="discovery_failed",
        label="Discovery failed",
        summary="The most recent inventory scan failed.",
        rationale="Everything else on the platform is only as current as the "
                  "last successful sweep.",
        condition_type=catalog.DISCOVERY_FAILED,
        condition_config={},
        severity="HIGH",
        suggested_name="Discovery failed",
        cooldown_seconds=21600,
        notify_on_resolution=True,
    ),
    Template(
        key="inventory_stale",
        label="Inventory has gone stale",
        summary="No scan has succeeded for 24 hours.",
        rationale="Catches the quieter failure where scans stop being "
                  "attempted at all, which the failure rule cannot see.",
        condition_type=catalog.DISCOVERY_STALE,
        condition_config={"threshold_hours": 24},
        severity="MEDIUM",
        suggested_name="Inventory stale for 24 hours",
        evaluation_interval_seconds=3600,
        cooldown_seconds=86400,
        notify_on_resolution=True,
    ),
    Template(
        key="critical_drift",
        label="Critical configuration drift",
        summary="A CRITICAL configuration change was recorded in the last day.",
        rationale="Drift is how a secure estate becomes an insecure one "
                  "between assessments.",
        condition_type=catalog.DRIFT_COUNT,
        condition_config={"window_hours": "24", "severity_filter": "CRITICAL",
                          "operator": catalog.OP_GT, "threshold": 0},
        severity="HIGH",
        suggested_name="Critical configuration drift",
        evaluation_interval_seconds=1800,
        cooldown_seconds=21600,
    ),
    Template(
        key="failed_operations",
        label="Failed cloud operations",
        summary="More than ten control-plane operations failed in an hour.",
        rationale="A burst of failures usually means a broken automation or a "
                  "credential that just expired.",
        condition_type=catalog.EVENT_COUNT,
        condition_config={"window_hours": "1", "risk_at_least": "ANY",
                          "status_filter": "Failed",
                          "operator": catalog.OP_GT, "threshold": 10},
        severity="MEDIUM",
        suggested_name="Failed cloud operations",
        cooldown_seconds=10800,
    ),
    Template(
        key="critical_events",
        label="Critical audit events",
        summary="Any CRITICAL control-plane event in the last hour.",
        rationale="Reads the provider's own audit trail, so it catches actions "
                  "taken outside Actmon entirely.",
        condition_type=catalog.EVENT_COUNT,
        condition_config={"window_hours": "1", "risk_at_least": "CRITICAL",
                          "status_filter": "ANY",
                          "operator": catalog.OP_GT, "threshold": 0},
        severity="CRITICAL",
        suggested_name="Critical audit events",
        cooldown_seconds=10800,
    ),
    Template(
        key="event_collection_broken",
        label="Audit collection unhealthy",
        summary="One or more audit-log scopes cannot be read.",
        rationale="A gap in the audit trail is invisible by definition — this "
                  "is the only thing that makes it visible.",
        condition_type=catalog.EVENT_COLLECTION_UNHEALTHY,
        condition_config={},
        severity="MEDIUM",
        suggested_name="Audit collection unhealthy",
        evaluation_interval_seconds=3600,
        cooldown_seconds=86400,
        notify_on_resolution=True,
    ),
    Template(
        key="certificate_expiry",
        label="Certificate expiring",
        summary="A certificate expires within 30 days, or already has.",
        rationale="An expired certificate is an outage with a date on it; 30 days is "
                  "enough to renew, validate and redeploy without a change freeze "
                  "getting in the way.",
        condition_type=catalog.CREDENTIAL_EXPIRY,
        condition_config={"kind": "CERTIFICATE", "within_days": 30,
                          "include_expired": "yes", "operator": catalog.OP_GT,
                          "threshold": 0},
        severity="HIGH",
        suggested_name="Certificates expiring within 30 days",
        evaluation_interval_seconds=3600,
        cooldown_seconds=86400,
        notify_on_resolution=True,
    ),
    Template(
        key="stopped_resources",
        label="Stopped resources piling up",
        summary="More than ten resources are stopped.",
        rationale="Stopped compute usually keeps its storage, and its storage "
                  "keeps billing.",
        condition_type=catalog.RESOURCE_STATUS_COUNT,
        condition_config={"status": "STOPPED", "operator": catalog.OP_GT,
                          "threshold": 10},
        severity="LOW",
        suggested_name="Stopped resources over 10",
        evaluation_interval_seconds=3600,
        cooldown_seconds=86400,
    ),
    Template(
        key="unattached_storage",
        label="Unattached storage",
        summary="Storage attached to nothing.",
        rationale="An unattached volume does no work and bills anyway.",
        condition_type=catalog.RESOURCE_ATTRIBUTE_COUNT,
        condition_config={"attribute": "unattached", "operator": catalog.OP_GT,
                          "threshold": 0},
        severity="LOW",
        suggested_name="Unattached storage",
        evaluation_interval_seconds=3600,
        cooldown_seconds=86400,
    ),
)}

# The set offered as "recommended" after a fresh install. Chosen so that
# together they cover every category the engine can evaluate — a starting
# posture, not a best-practice claim. Nothing here is installed automatically.
RECOMMENDED: Sequence[str] = (
    "critical_security_finding",
    "security_score_drop",
    "billing_unavailable",
    "discovery_failed",
    "critical_drift",
    "critical_events",
    "event_collection_broken",
    "certificate_expiry",
)


def get(key: str) -> Template:
    template = TEMPLATES.get(key)
    if template is None:
        raise catalog.ValidationError({
            "template": f"{key!r} is not a known rule template. Known: "
                        f"{', '.join(sorted(TEMPLATES))}."
        })
    return template


def validate_all() -> List[str]:
    """Prove every template describes a condition the engine can evaluate.

    Called by the test suite and at import time in DEBUG. A template that sets a
    field the condition does not read, or omits a required one, would otherwise
    only fail when somebody clicked it.
    """
    problems: List[str] = []
    for key, template in TEMPLATES.items():
        try:
            condition = catalog.get(template.condition_type)
        except catalog.ValidationError:
            problems.append(f"{key}: unknown condition {template.condition_type!r}")
            continue

        known_fields = {f.key for f in condition.fields}
        unknown = set(template.condition_config) - known_fields
        if unknown:
            problems.append(
                f"{key}: sets field(s) {sorted(unknown)} that "
                f"{template.condition_type} does not read")

        # Fill the inputs the operator is expected to supply, then validate the
        # whole thing exactly as a save would.
        probe = dict(template.condition_config)
        for field in template.needs_input:
            if field == "currency":
                # INR, not USD: budgets/alerts in this product are evaluated
                # and displayed in INR (see `fx_rate_service`) — matching the
                # dummy value here to that keeps this dry-run probe testing
                # the same assumption the UI's own currency field makes.
                probe.setdefault(field, "INR")
            else:
                probe.setdefault(field, 1)
        try:
            catalog.validate(template.condition_type, probe,
                             template.scope_config)
        except catalog.ValidationError as exc:
            problems.append(f"{key}: {exc}")

    for key in RECOMMENDED:
        if key not in TEMPLATES:
            problems.append(f"RECOMMENDED names {key!r}, which is not a template")
    return problems


def payload(*, recommended_only: bool = False) -> Dict[str, Any]:
    keys = RECOMMENDED if recommended_only else list(TEMPLATES)
    return {
        "templates": [TEMPLATES[k].to_dict() for k in keys],
        "recommended": list(RECOMMENDED),
        "note": ("Templates only pre-fill the builder. Nothing is created until "
                 "you save it, and recommended rules are created disabled so "
                 "turning them on is a deliberate act."),
    }
