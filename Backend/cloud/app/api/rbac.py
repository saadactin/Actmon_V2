"""Role-based access control for the Event Log.

An audit trail is the one feature where "who may read this" is part of the
feature, not an afterthought — so the permissions are modelled explicitly here
rather than left implicit in the routes.

**An honest note about the current deployment**, because a security control
that quietly does nothing is worse than none at all:

This microservice presently accepts unauthenticated requests on *every* route.
`app/core/security.py`'s `get_current_user` returns None when no token is
presented, no existing route depends on it, and the frontend's `cloudAxios`
instance sends no Authorization header. Making Event Log the one endpoint that
demands a token would break the feature on this deployment while leaving Cost,
Security and Resources wide open — a lock on one door of an open house.

So enforcement is a switch, and the switch's position is *reported in every
response* rather than assumed:

*   `EVENTLOG_RBAC_ENFORCE=false` (default) — an unauthenticated caller is
    granted `EVENTLOG_DEFAULT_ROLE` (default `audit_admin`, matching how the
    rest of this service already behaves). `GET /cloud/events/access` and the
    settings payload both report `rbac_enforced: false`, and the UI shows a
    banner saying audit access is not currently restricted.
*   `EVENTLOG_RBAC_ENFORCE=true` — a request without a valid token is refused
    with 401, and the token's `role` claim decides what it may do. Turning this
    on is a one-line change and needs no code edit.

Either way, refusals are recorded in the access log, so an attempt to exceed a
role is visible even while enforcement is off.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional, Set

from fastapi import Depends, HTTPException, Request, status

from app.core.security import decode_access_token

logger = logging.getLogger("cloud_svc.events.rbac")


# ── Permissions ───────────────────────────────────────────────────────────────
VIEW = "events:view"
SEARCH = "events:search"
VIEW_RAW = "events:view_raw"
EXPORT = "events:export"
SAVE_QUERY = "events:save_query"
COLLECT = "events:collect"
CONFIGURE = "events:configure"
VIEW_ACCESS_LOG = "events:view_access_log"

# ── Topology permissions ──────────────────────────────────────────────────────
# The topology reads the same inventory the Resources tab already serves
# unauthenticated, so `topology:view` is granted to every role. What is NOT
# universal is the raw provider payload: it is the one part of a resource that
# can carry an internal hostname, a connection template or a policy document,
# and it is gated exactly as the raw event payload is, for the same reason.
TOPOLOGY_VIEW = "topology:view"
TOPOLOGY_VIEW_RAW = "topology:view_raw"
TOPOLOGY_EXPORT = "topology:export"
TOPOLOGY_SNAPSHOT = "topology:snapshot"

# ── Security Center permissions ───────────────────────────────────────────────
# The Security, Compliance and Alerts routes previously had NO authorisation
# dependency of any kind — `POST /alerts/{id}/resolve` was reachable
# unauthenticated, and so were the IAM wildcard grants, the privilege-escalation
# paths and the open-port inventory. Those are among the most sensitive reads in
# the product: a findings list is a ranked, evidence-bearing map of exactly
# where to attack an estate.
#
# The split follows what an action can do, not how it is spelled:
#
#   security:view      — the posture, findings, compliance, exposure, identity.
#                        Granted to every role, like topology:view, because it
#                        reads the same inventory the Resources tab already
#                        serves.
#   security:view_raw  — the `evidence` block, which quotes provider payloads:
#                        policy statements, NSG rules, bucket policies. Gated
#                        exactly as raw event and raw topology payloads are.
#   security:assess    — run an assessment. Cheap but not free, and it writes.
#   security:triage    — acknowledge and resolve. Changes what other people see.
#   security:suppress  — suppress or accept a risk. Makes a real finding stop
#                        counting, which is the most consequential thing a user
#                        can do here, so it is administrator-only.
#   security:manage_policies — change what pages people. Administrator-only for
#                        the same reason: a disabled policy is a silent one.
SECURITY_VIEW = "security:view"
SECURITY_VIEW_RAW = "security:view_raw"
SECURITY_ASSESS = "security:assess"
SECURITY_TRIAGE = "security:triage"
SECURITY_SUPPRESS = "security:suppress"
SECURITY_MANAGE_POLICIES = "security:manage_policies"

# ── Cost Intelligence permissions ─────────────────────────────────────────────
# Cost is commercially sensitive in a way the other reads are not: an itemized
# bill discloses headcount-scale, growth, which products are real and which are
# experiments, and what a competitor would pay to learn. It is also the one
# dataset people habitually email outside the company.
#
# The split therefore separates *seeing* from *taking a copy*, and both from
# *changing what the numbers mean*:
#
#   cost:view      — the dashboards, explorer, per-resource spend, diagnostics.
#                    Granted to viewer, consistent with topology:view and
#                    security:view: this is the product's primary page, and
#                    making it administrator-only would leave most users
#                    staring at a 403 on the tab they were sent to.
#   cost:export    — CSV/PDF download and the report builder. Its OWN
#                    permission, because an export leaves the building. A
#                    viewer can read a figure on screen; extracting the full
#                    itemized ledger is a deliberate, auditable act.
#   cost:manage_budgets / cost:manage_alerts — set thresholds and what pages
#                    people. Administrator-only for the same reason security
#                    policies are: a budget alert nobody receives is worse
#                    than no budget, and silence looks identical to safety.
#   cost:manage_recommendations — accept or dismiss an optimization. Dismissing
#                    makes a real saving opportunity stop being counted, which
#                    mirrors security:suppress exactly.
#   cost:admin     — reserved for future destructive/remediation actions. It is
#                    deliberately granted to nobody but administrators and
#                    guards nothing yet; the platform is advisory today and no
#                    route changes a cloud resource.
COST_VIEW = "cost:view"
COST_EXPORT = "cost:export"
COST_MANAGE_BUDGETS = "cost:manage_budgets"
COST_MANAGE_ALERTS = "cost:manage_alerts"
COST_MANAGE_RECOMMENDATIONS = "cost:manage_recommendations"
COST_ADMIN = "cost:admin"

# ---- Resources -------------------------------------------------------------
# The inventory is the least sensitive of these surfaces and the most widely
# used, so RESOURCE_VIEW sits with the other viewer permissions. The raw
# provider payload does not: it carries connection strings, instance metadata
# and policy documents that the normalized columns deliberately summarise, so
# it follows the same rule the Event Log set and needs the analyst role.
#
# RESOURCE_ACTION exists and is granted to nobody but an administrator, even
# though no provider adapter can currently execute one. Declaring it now means
# the first write path to land arrives already gated, rather than shipping
# ungated and being retrofitted.
RESOURCE_VIEW = "resources:view"
RESOURCE_VIEW_RAW = "resources:view_raw"
RESOURCE_EXPORT = "resources:export"
RESOURCE_DISCOVER = "resources:discover"
RESOURCE_ACTION = "resources:action"
RESOURCE_ADMIN = "resources:admin"

# ---- Alerts ----------------------------------------------------------------
# Alerting splits three ways, on what an action can do to other people:
#
#   alerts:view          — the rules, the history, the delivery status. Every
#                          role, like the other view permissions: an on-call
#                          engineer must be able to see what is watched and
#                          what fired without being able to change it.
#   alerts:triage        — acknowledge and resolve. Changes what the rest of
#                          the team sees as outstanding, so it sits with the
#                          analyst role beside security:triage.
#   alerts:manage_rules  — create, edit, enable, disable, delete a rule.
#                          Administrator-only, and for the same reason
#                          security:manage_policies is: a disabled rule is a
#                          silent one, and silence is indistinguishable from
#                          safety until the incident.
#   alerts:manage_recipients — who receives the mail, and switching the shared
#                          email channel on. Separate from managing rules
#                          because it reaches outside the product: it decides
#                          whose inbox this system writes to, and it touches a
#                          delivery setting the database service shares.
#   alerts:test          — run a rule's evaluation on demand, and send a test
#                          message. Analyst-level: testing is how you find out
#                          why a rule is quiet, and making that
#                          administrator-only guarantees nobody checks.
ALERT_VIEW = "alerts:view"
ALERT_TRIAGE = "alerts:triage"
ALERT_MANAGE_RULES = "alerts:manage_rules"
ALERT_MANAGE_RECIPIENTS = "alerts:manage_recipients"
ALERT_TEST = "alerts:test"

# ---- Clients, organisation onboarding and client reports ------------------
#   clients:view     — the client list, the portfolio view, a client's accounts.
#                      Every role: it is a grouping of data each role can
#                      already read account by account.
#   clients:manage   — create, rename, delete a client; assign accounts to it.
#                      Administrator-only, because assignment decides whose
#                      report an account's bill appears in.
#   clients:onboard  — list an AWS organisation or Azure tenant and create
#                      accounts from it. It stores new cloud credentials, so it
#                      sits with resources:discover at the administrator level.
#   reports:export   — generate and download a client's PDF. Its own
#                      permission for the reason cost:export is: an itemized
#                      report leaves the building the moment it is downloaded.
#   reports:manage   — schedules and recipients. Decides whose inbox this
#                      system writes to every month, like alerts:manage_recipients.
CLIENT_VIEW = "clients:view"
CLIENT_MANAGE = "clients:manage"
CLIENT_ONBOARD = "clients:onboard"
REPORT_EXPORT = "reports:export"
REPORT_MANAGE = "reports:manage"

# ---- Resource Intelligence ---------------------------------------------------
#   intelligence:view     — the findings workspace, evidence, telemetry, health.
#                           Every role, like security:view and cost:view: it
#                           reads what those two already expose.
#   intelligence:triage   — acknowledge, reopen, mark resolved. Analyst-level,
#                           beside security:triage.
#   intelligence:suppress — suppress a finding so it stops counting. Admin-only,
#                           for the reason security:suppress is.
# Running an analysis contacts the provider's monitoring API, so it needs
# resources:discover — the same permission as "Refresh all", which runs it.
# A SECURITY finding shown here keeps the Security Center's own permissions.
INTELLIGENCE_VIEW = "intelligence:view"
INTELLIGENCE_TRIAGE = "intelligence:triage"
INTELLIGENCE_SUPPRESS = "intelligence:suppress"

# ---- Identity & Access (CIEM) ------------------------------------------------
# This surface is the most sensitive read in the product and the only one with a
# write path that changes a customer's IAM, so it splits further than the others.
#
#   identity:view       — the dashboard, the identity table, dormancy, MFA state,
#                         credential age. Granted to every role, like the other
#                         view permissions.
#   identity:view_raw   — policy documents, trust policies, OCI policy statements
#                         and the full decision trace. Gated exactly as the raw
#                         event, topology and security payloads are, and for a
#                         sharper reason: a policy document is a precise map of
#                         what an identity can reach and is the single most useful
#                         artefact to an attacker who has a foothold.
#   identity:query      — the permission explorer and the "who can access this?"
#                         reverse query. Separated from view because a reverse
#                         query over an estate is reconnaissance in a way a table
#                         is not: "who can delete backups" answers, in one call,
#                         the question an intruder most wants answered. Analyst
#                         and above.
#   identity:analyze    — run collection and analysis. Contacts provider APIs and
#                         writes, so it sits with resources:discover.
#   identity:request    — raise an access or right-sizing request. Deliberately
#                         granted to viewer: the person who needs elevation is
#                         usually not an administrator, and making them ask an
#                         administrator to ask on their behalf is how JIT gets
#                         abandoned for standing access.
#   identity:approve    — approve or reject. Administrator-only, and the service
#                         additionally refuses self-approval, because an approval
#                         workflow one person can complete alone is decoration.
#   identity:apply      — execute an approved change against the provider. The
#                         only permission in the product that can alter a
#                         customer's IAM. Administrator-only, and still gated
#                         behind CIEM_ENABLE_WRITE at the service layer.
#   identity:audit      — read the CIEM audit trail of who requested, who
#                         approved and what changed. With the audit roles, beside
#                         events:view_access_log.
IDENTITY_VIEW = "identity:view"
IDENTITY_VIEW_RAW = "identity:view_raw"
IDENTITY_QUERY = "identity:query"
IDENTITY_ANALYZE = "identity:analyze"
IDENTITY_REQUEST = "identity:request"
IDENTITY_APPROVE = "identity:approve"
IDENTITY_APPLY = "identity:apply"
IDENTITY_AUDIT = "identity:audit"

ROLE_VIEWER = "viewer"
ROLE_ANALYST = "security_analyst"
ROLE_ADMIN = "administrator"
ROLE_AUDIT_ADMIN = "audit_admin"

# The four roles from the specification. Each is a superset of the one before,
# with one deliberate exception: the raw provider payload is NOT granted to a
# plain viewer. A raw CloudTrail event carries request parameters and response
# elements that the normalized columns summarise; redaction removes credential
# material but not, for instance, an internal hostname or a policy document.
# A viewer gets the structured event — every field needed to answer who/what/
# when/where — and the payload needs the analyst role.
ROLE_PERMISSIONS = {
    ROLE_VIEWER: {VIEW, TOPOLOGY_VIEW, SECURITY_VIEW, COST_VIEW, RESOURCE_VIEW,
                  ALERT_VIEW, CLIENT_VIEW, INTELLIGENCE_VIEW,
                  # Can see the identity picture and ask for elevation; cannot
                  # run a reverse query, approve, or change anything.
                  IDENTITY_VIEW, IDENTITY_REQUEST},
    ROLE_ANALYST: {
        VIEW, SEARCH, VIEW_RAW, EXPORT, SAVE_QUERY,
        TOPOLOGY_VIEW, TOPOLOGY_VIEW_RAW, TOPOLOGY_EXPORT,
        # An analyst investigates and triages, and needs the evidence to do it.
        # They cannot suppress a finding or retune a policy: both make a real
        # risk stop being counted, and that belongs with an administrator.
        SECURITY_VIEW, SECURITY_VIEW_RAW, SECURITY_ASSESS, SECURITY_TRIAGE,
        # Can pull the itemized ledger out of the product, but cannot change
        # budgets, alert thresholds, or dismiss an optimization.
        COST_VIEW, COST_EXPORT,
        # Can pull the inventory out of the product and read the raw
        # provider payload while investigating; cannot trigger discovery
        # against a rate-limited provider API.
        RESOURCE_VIEW, RESOURCE_VIEW_RAW, RESOURCE_EXPORT,
        # Works the alert queue and can test why a rule is quiet; cannot
        # change what is watched or whose inbox it reaches.
        ALERT_VIEW, ALERT_TRIAGE, ALERT_TEST,
        # Can produce and download a client's report; cannot schedule one or
        # decide who receives it.
        CLIENT_VIEW, REPORT_EXPORT,
        # Works the findings queue; cannot suppress.
        INTELLIGENCE_VIEW, INTELLIGENCE_TRIAGE,
        # Investigates identities, including the policy documents and the
        # reverse query. Cannot approve an elevation or apply a change.
        IDENTITY_VIEW, IDENTITY_VIEW_RAW, IDENTITY_QUERY, IDENTITY_REQUEST,
    },
    ROLE_ADMIN: {
        VIEW, SEARCH, VIEW_RAW, EXPORT, SAVE_QUERY, COLLECT, CONFIGURE,
        TOPOLOGY_VIEW, TOPOLOGY_VIEW_RAW, TOPOLOGY_EXPORT, TOPOLOGY_SNAPSHOT,
        SECURITY_VIEW, SECURITY_VIEW_RAW, SECURITY_ASSESS, SECURITY_TRIAGE,
        SECURITY_SUPPRESS, SECURITY_MANAGE_POLICIES,
        COST_VIEW, COST_EXPORT, COST_MANAGE_BUDGETS, COST_MANAGE_ALERTS,
        COST_MANAGE_RECOMMENDATIONS, COST_ADMIN,
        RESOURCE_VIEW, RESOURCE_VIEW_RAW, RESOURCE_EXPORT,
        RESOURCE_DISCOVER, RESOURCE_ACTION, RESOURCE_ADMIN,
        ALERT_VIEW, ALERT_TRIAGE, ALERT_TEST, ALERT_MANAGE_RULES,
        ALERT_MANAGE_RECIPIENTS,
        CLIENT_VIEW, CLIENT_MANAGE, CLIENT_ONBOARD, REPORT_EXPORT, REPORT_MANAGE,
        INTELLIGENCE_VIEW, INTELLIGENCE_TRIAGE, INTELLIGENCE_SUPPRESS,
        IDENTITY_VIEW, IDENTITY_VIEW_RAW, IDENTITY_QUERY, IDENTITY_ANALYZE,
        IDENTITY_REQUEST, IDENTITY_APPROVE, IDENTITY_APPLY, IDENTITY_AUDIT,
    },
    ROLE_AUDIT_ADMIN: {
        VIEW, SEARCH, VIEW_RAW, EXPORT, SAVE_QUERY, COLLECT, CONFIGURE,
        VIEW_ACCESS_LOG,
        TOPOLOGY_VIEW, TOPOLOGY_VIEW_RAW, TOPOLOGY_EXPORT, TOPOLOGY_SNAPSHOT,
        SECURITY_VIEW, SECURITY_VIEW_RAW, SECURITY_ASSESS, SECURITY_TRIAGE,
        SECURITY_SUPPRESS, SECURITY_MANAGE_POLICIES,
        COST_VIEW, COST_EXPORT, COST_MANAGE_BUDGETS, COST_MANAGE_ALERTS,
        COST_MANAGE_RECOMMENDATIONS, COST_ADMIN,
        RESOURCE_VIEW, RESOURCE_VIEW_RAW, RESOURCE_EXPORT,
        RESOURCE_DISCOVER, RESOURCE_ACTION, RESOURCE_ADMIN,
        ALERT_VIEW, ALERT_TRIAGE, ALERT_TEST, ALERT_MANAGE_RULES,
        ALERT_MANAGE_RECIPIENTS,
        CLIENT_VIEW, CLIENT_MANAGE, CLIENT_ONBOARD, REPORT_EXPORT, REPORT_MANAGE,
        INTELLIGENCE_VIEW, INTELLIGENCE_TRIAGE, INTELLIGENCE_SUPPRESS,
        IDENTITY_VIEW, IDENTITY_VIEW_RAW, IDENTITY_QUERY, IDENTITY_ANALYZE,
        IDENTITY_REQUEST, IDENTITY_APPROVE, IDENTITY_APPLY, IDENTITY_AUDIT,
    },
}

# Aliases for the role names the main application's own user model uses, so a
# token minted there resolves to a role here instead of falling through to the
# least-privileged default.
ROLE_ALIASES = {
    "admin": ROLE_ADMIN,
    "administrator": ROLE_ADMIN,
    "superadmin": ROLE_AUDIT_ADMIN,
    "super_admin": ROLE_AUDIT_ADMIN,
    "auditor": ROLE_ANALYST,
    "audit": ROLE_AUDIT_ADMIN,
    "auditadmin": ROLE_AUDIT_ADMIN,
    "security": ROLE_ANALYST,
    "analyst": ROLE_ANALYST,
    "securityanalyst": ROLE_ANALYST,
    "operator": ROLE_VIEWER,
    "user": ROLE_VIEWER,
    "viewer": ROLE_VIEWER,
    "readonly": ROLE_VIEWER,
}


def rbac_enforced() -> bool:
    """Whether a bearer token is required.

    `CLOUD_RBAC_ENFORCE` is the name to use — this switch now governs the
    topology as well as the Event Log, and a variable called EVENTLOG_* turning
    on access control for a different feature would be a trap for whoever sets
    it next. The old name is still honoured so an existing .env keeps working.
    """
    for name in ("CLOUD_RBAC_ENFORCE", "EVENTLOG_RBAC_ENFORCE"):
        raw = os.getenv(name)
        if raw is not None:
            return raw.strip().lower() in ("true", "1", "yes", "on")
    return False


def default_role() -> str:
    """The role an unauthenticated caller gets while enforcement is off.

    Falls back to audit_admin — matching this service's existing
    unauthenticated-and-unrestricted behaviour — but an operator who wants a
    narrower default before wiring up tokens can set EVENTLOG_DEFAULT_ROLE
    without touching code.
    """
    configured = (
        os.getenv("CLOUD_DEFAULT_ROLE")
        or os.getenv("EVENTLOG_DEFAULT_ROLE")
        or ROLE_AUDIT_ADMIN
    ).strip().lower()
    resolved = ROLE_ALIASES.get(configured.replace("_", "").replace("-", ""), configured)
    if resolved not in ROLE_PERMISSIONS:
        logger.warning(
            "EVENTLOG_DEFAULT_ROLE=%r is not a known role; falling back to %s. "
            "Known roles: %s", configured, ROLE_AUDIT_ADMIN, ", ".join(ROLE_PERMISSIONS),
        )
        return ROLE_AUDIT_ADMIN
    return resolved


@dataclass
class Principal:
    """Who is calling, what they may do, and whether any of it was verified."""

    name: Optional[str]
    role: str
    permissions: Set[str]
    authenticated: bool
    enforced: bool
    source_ip: Optional[str] = None

    def can(self, permission: str) -> bool:
        return permission in self.permissions

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "role": self.role,
            "permissions": sorted(self.permissions),
            "authenticated": self.authenticated,
            "rbac_enforced": self.enforced,
        }


def _normalize_role(claim: Optional[str]) -> str:
    if not claim:
        return ROLE_VIEWER
    key = str(claim).strip().lower()
    if key in ROLE_PERMISSIONS:
        return key
    return ROLE_ALIASES.get(key.replace("_", "").replace("-", ""), ROLE_VIEWER)


async def get_principal(request: Request) -> Principal:
    """Resolve the caller.

    The token is read from the Authorization header directly rather than
    through the OAuth2PasswordBearer dependency, because that dependency's
    `tokenUrl` points at an endpoint this service does not serve and would put
    a misleading login flow in the OpenAPI schema.
    """
    enforced = rbac_enforced()
    client_ip = request.client.host if request.client else None
    header = request.headers.get("authorization") or ""
    token = header[7:].strip() if header[:7].lower() == "bearer " else None

    if token:
        try:
            payload = decode_access_token(token)
        except HTTPException:
            if enforced:
                raise
            # Enforcement off: a bad token is not a reason to refuse, but it is
            # also not an identity. The caller is treated as unauthenticated,
            # and the name is not taken from an unverified token.
            logger.info("Ignoring an invalid bearer token (RBAC enforcement is off).")
            payload = {}
        if payload:
            role = _normalize_role(
                payload.get("role") or payload.get("scope") or payload.get("roles")
            )
            return Principal(
                name=payload.get("sub"),
                role=role,
                permissions=set(ROLE_PERMISSIONS.get(role, set())),
                authenticated=True,
                enforced=enforced,
                source_ip=client_ip,
            )

    if enforced:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=(
                "Event Log access requires authentication (EVENTLOG_RBAC_ENFORCE is on). "
                "Send a bearer token with a `role` claim."
            ),
            headers={"WWW-Authenticate": "Bearer"},
        )

    role = default_role()
    return Principal(
        name=None,
        role=role,
        permissions=set(ROLE_PERMISSIONS.get(role, set())),
        authenticated=False,
        enforced=False,
        source_ip=client_ip,
    )


def require(permission: str):
    """A dependency factory that enforces one permission.

    The refusal is recorded before it is raised, so an attempt to exceed a role
    appears in the audit-of-the-audit log whether or not enforcement is on —
    which is what makes turning enforcement on an informed decision rather than
    a guess.
    """

    async def dependency(
        request: Request, principal: Principal = Depends(get_principal)
    ) -> Principal:
        if principal.can(permission):
            return principal
        await deny(principal, permission, request)

    return dependency


async def deny(principal: Principal, permission: str, request: Request) -> None:
    """Record a refusal and raise the 403. Never returns.

    Exported because some permissions cannot be expressed as a whole-route
    dependency — searching is a parameter of the list route, and including raw
    payloads is a parameter of the export route, so both are decided inside the
    handler. Those refusals were originally raised inline and, because they
    never passed through `require`, were the only refusals in the system that
    went unaudited. Everything that says no now says it through here.
    """
    await _record_denial(principal, permission, request)
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(
            f"Your role ({principal.role}) does not include {permission}. "
            f"Required by: {request.url.path}"
        ),
    )


async def _record_denial(principal: Principal, permission: str, request: Request) -> None:
    """Best-effort audit of a refusal.

    Its own session, so a failure to record cannot poison the request's
    transaction, and swallowed, so a logging problem never turns a clean 403
    into a 500.
    """
    try:
        from app.core.database import AsyncSessionLocal
        from app.models.event_admin import ACCESS_DENIED
        from app.repository.event_repo import EventRepository

        async with AsyncSessionLocal() as db:
            await EventRepository(db).record_access(
                ACCESS_DENIED,
                actor=principal.name,
                role=principal.role,
                target=str(request.url.path),
                detail={"permission": permission, "method": request.method},
                source_ip=principal.source_ip,
            )
            await db.commit()
    except Exception as exc:
        logger.warning("Could not record an Event Log access denial: %s", exc)


def rbac_summary() -> dict:
    """The effective access model, for the UI banner and for verification."""
    return {
        "enforced": rbac_enforced(),
        "default_role_when_unenforced": default_role(),
        "roles": {
            role: sorted(perms) for role, perms in ROLE_PERMISSIONS.items()
        },
        "note": (
            "RBAC enforcement is OFF. Every route on this microservice currently accepts "
            "unauthenticated requests, so Event Log follows the same posture rather than "
            "being the single locked door on an open service. Set "
            "CLOUD_RBAC_ENFORCE=true in Backend/cloud/.env to require a bearer token "
            "with a `role` claim; refusals are already recorded either way."
            if not rbac_enforced() else
            "RBAC enforcement is ON. Requests must carry a bearer token; the `role` claim "
            "selects the permission set."
        ),
    }
