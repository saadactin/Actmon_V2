"""The unified security assessment engine.

One pass over an account's stored inventory produces one list of canonical
findings. Security, Compliance and Alerts are then all *views* over that list —
none of them evaluates a condition of its own, which is what makes it
structurally impossible for them to disagree.

The old arrangement had `compliance_service.generate_compliance_report()` call
`run_security_scan()` and re-derive its own interpretation, while the alert
service evaluated a completely separate hard-coded rule during discovery. So
"Security says CRITICAL: public RDP" and "Compliance cites PCI Req 1.3" and
"Alerts is silent" were three independent computations that happened to be
looking at the same estate. Nothing enforced that they agreed, and on live data
they did not: 3 of AWS's 20 MEDIUM compliance violations came from a rule
firing on the wrong provider, and none of the 21 OCI CRITICAL findings had ever
produced an alert.

What the engine guarantees:

* **Provider-aware dispatch.** Rules come from `registry.rules_for(provider,
  type)`, so a resource type shared by two clouds cannot inherit the wrong
  cloud's rule.
* **No verdict is discarded.** SAFE and NOT_APPLICABLE produce no finding but
  are counted toward coverage. UNKNOWN and NOT_SCANNED produce a finding *and*
  count against coverage, because "we could not tell" is information an
  operator needs and the old engine threw away.
* **Aggregation where volume would drown signal.** A rule marked `aggregate`
  yields one finding carrying `affected_count` and a drill-down sample, instead
  of 550.
* **Compliance stamped once.** Each finding carries its control citations as
  metadata, so a finding appears exactly once no matter how many frameworks
  cite it.
* **Deterministic identity.** Every finding's fingerprint is a pure function of
  provider, account, rule and the provider's own resource id, so the same
  condition on the next scan is the same finding — which is what makes history,
  age, and alert dedupe possible at all.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, NamedTuple, Optional, Sequence, Tuple

from app.security import controls as ctl
from app.security import credentials as credx
from app.security import exposure as exp
from app.security import identity as ident
from app.security import secrets
from app.security import ports as portcat
from app.security import registry as reg
from app.security import scoring
from app.security.model import (
    ASSESS_COMPLETE, ASSESS_FAILED, ASSESS_PARTIAL, AWS, AZURE, CAT_ENCRYPTION,
    CAT_EXPOSURE, CAT_IAM, CONF_HIGH, CONF_MEDIUM, CONF_UNKNOWN, COV_CREDENTIALS,
    COV_ENCRYPTION, COV_EXPOSURE, COV_IAM, COV_INVENTORY, COV_NETWORK,
    COVERAGE_DIMENSIONS, COVERAGE_LABEL, COVERAGE_MEANING, CRITICAL, EXPOSED,
    EXPOSURE_UNKNOWN, HIGH, INFO, MEDIUM, NOT_APPLICABLE, NOT_SCANNED, OCI, OPEN,
    SAFE, SCORING_COVERAGE_DIMENSIONS, SecurityFinding, UNKNOWN, VULNERABLE,
    fingerprint, normalize_provider, severity_rank,
)

logger = logging.getLogger("cloud_svc.security.engine")


class CoverageDimension(NamedTuple):
    dimension: str
    determined: int
    undetermined: int

    @property
    def pct(self) -> Optional[float]:
        total = self.determined + self.undetermined
        # None, not 100. An account where nothing was checkable has no coverage
        # percentage, and printing 100% would be the exact inversion of the
        # truth. Same reasoning as the topology coverage metric.
        return round(100.0 * self.determined / total, 1) if total else None

    def to_dict(self) -> dict:
        return {
            "dimension": self.dimension,
            "label": COVERAGE_LABEL.get(self.dimension, self.dimension),
            "meaning": COVERAGE_MEANING.get(self.dimension, ""),
            "determined": self.determined,
            "undetermined": self.undetermined,
            "pct": self.pct,
        }


class Assessment(NamedTuple):
    """Everything one evaluation produced. The single input to every view."""

    account_id: str
    provider: str
    outcome: str                      # COMPLETE / PARTIAL / FAILED
    findings: List[SecurityFinding]
    exposures: List[exp.Exposure]
    coverage: List[CoverageDimension]
    resources_evaluated: int
    rules_evaluated: int
    started_at: datetime
    finished_at: datetime
    # Why the outcome is not COMPLETE. Load-bearing: findings must not be
    # resolved from a PARTIAL assessment, and the reason is what lets a user
    # understand a stalled resolution instead of assuming the tool is broken.
    incomplete_reasons: List[str]
    identity_review: Dict[str, Any]
    # rule_id -> {verdict: count}. This is what lets compliance tell PASS
    # ("the check ran and found nothing") from NOT_APPLICABLE ("no resource was
    # in scope") from NOT_EVALUATED ("no check covers this control"). Without
    # it a control with no findings is ambiguous, and the ambiguous reading —
    # treating it as passed — is the one that flatters.
    rule_stats: Dict[str, Dict[str, int]] = {}
    # Resources plus identity grants. The score is withheld only when this is
    # zero — an account with no inventory but 24 collected role assignments HAS
    # been assessed, and reporting "Not assessed" over 34 identity findings
    # would contradict the findings list beside it.
    subjects_evaluated: int = 0

    @property
    def coverage_pct(self) -> Optional[float]:
        # Only the dimensions that gate the score — see
        # model.SCORING_COVERAGE_DIMENSIONS for why certificate stores are
        # reported beside this figure rather than averaged into it.
        pcts = [c.pct for c in self.coverage
                if c.pct is not None and c.dimension in SCORING_COVERAGE_DIMENSIONS]
        return round(sum(pcts) / len(pcts), 1) if pcts else None

    @property
    def may_resolve(self) -> bool:
        """Whether absent findings may be closed. False for anything but a
        complete assessment — an absent resource in a partial sweep means
        "failed to enumerate", and closing a still-broken finding is the one
        error a security tool must never make."""
        return self.outcome == ASSESS_COMPLETE

    def to_dict(self) -> dict:
        return {
            "account_id": self.account_id,
            "provider": self.provider,
            "outcome": self.outcome,
            "may_resolve": self.may_resolve,
            "incomplete_reasons": self.incomplete_reasons,
            "resources_evaluated": self.resources_evaluated,
            "subjects_evaluated": self.subjects_evaluated,
            "rules_evaluated": self.rules_evaluated,
            "coverage": [c.to_dict() for c in self.coverage],
            "coverage_pct": self.coverage_pct,
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat(),
            "duration_ms": int(
                (self.finished_at - self.started_at).total_seconds() * 1000),
        }


class _Coverage:
    """Tally of what could and could not be determined, per dimension."""

    def __init__(self) -> None:
        self._d: Dict[str, List[int]] = {k: [0, 0] for k in COVERAGE_DIMENSIONS}

    def determined(self, dim: Optional[str], n: int = 1) -> None:
        if dim in self._d:
            self._d[dim][0] += n

    def undetermined(self, dim: Optional[str], n: int = 1) -> None:
        if dim in self._d:
            self._d[dim][1] += n

    def result(self) -> List[CoverageDimension]:
        return [CoverageDimension(k, v[0], v[1]) for k, v in self._d.items()]


def sweep_reasons(summary: Dict[str, Any]) -> List[str]:
    """Why an incomplete sweep was incomplete, in words, from its scope summary."""
    read, attempted = int(summary.get("read") or 0), int(summary.get("attempted") or 0)
    pct = round(100.0 * read / attempted, 1) if attempted else 0.0
    out = [f"The last discovery sweep read {read} of {attempted} scopes ({pct}%). Findings "
           "are not resolved from an incomplete sweep, and resources in the scopes it "
           "could not read may be missing."]
    denied = summary.get("denied") or {}
    if denied:
        services = ", ".join(
            f"{label} ({len(e.get('regions') or [])} "
            f"region{'' if len(e.get('regions') or []) == 1 else 's'})"
            for label, e in sorted(denied.items()))
        actions = ", ".join(summary.get("missing_permissions") or [])
        tail = (" — or attach the AWS managed policy ReadOnlyAccess, which includes them"
                if summary.get("provider") == "AWS" else "")
        out.append(f"Not permitted for these credentials: {services}. Grant {actions}{tail}.")
    failed = summary.get("failed") or []
    # `failed` is capped at 50; the counts are not.
    n_failed = int(summary.get("failed_count") or len(failed))
    if n_failed:
        transient = (int(summary["failed_transient"])
                     if summary.get("failed_transient") is not None
                     else sum(1 for f in failed if f.get("transient")))
        names = ", ".join(f.get("scope", "?") for f in failed[:5])
        out.append(
            f"{n_failed} scope(s) did not answer"
            + (f" ({transient} dropped the connection and will be retried on the next "
               "scan)" if transient else "")
            + (f": {names}{'…' if n_failed > 5 else ''}" if names else "") + ".")
    not_offered = summary.get("not_offered") or {}
    if not_offered:
        out.append("Not counted, because the service is not offered there: " + ", ".join(
            f"{label} in {len(regions)} region{'' if len(regions) == 1 else 's'}"
            for label, regions in sorted(not_offered.items())) + ".")
    return out


def assess(
    *,
    account_id: str,
    provider: str,
    resources: Sequence[Any],
    grants: Sequence[Any] = (),
    identity_state: Optional[Any] = None,
    credentials: Sequence[Any] = (),
    credential_sources: Sequence[Any] = (),
    sweep_complete: bool = True,
    failed_scopes: int = 0,
    scope_summary: Optional[Dict[str, Any]] = None,
    discovery_scan_id: Optional[str] = None,
    inventory_last_discovered: Optional[datetime] = None,
    now: Optional[datetime] = None,
) -> Assessment:
    """Evaluate one account. Pure: no I/O, no database, no cloud API calls.

    That purity is deliberate and is what makes §54 possible — the engine can
    run inside the discovery worker after a scan, and the API can then serve
    persisted findings without re-running 48 rules on every page load.
    """
    started = now or datetime.now(timezone.utc)
    prov = normalize_provider(provider)
    findings: List[SecurityFinding] = []
    cov = _Coverage()
    incomplete: List[str] = []

    if prov is None:
        # An unrecognised provider must not fall through to some other cloud's
        # rules. Refuse, loudly, with nothing invented.
        finished = datetime.now(timezone.utc)
        return Assessment(
            account_id=str(account_id), provider=str(provider or "?"),
            outcome=ASSESS_FAILED, findings=[], exposures=[], coverage=cov.result(),
            resources_evaluated=0, rules_evaluated=0,
            started_at=started, finished_at=finished,
            incomplete_reasons=[
                f"Provider {provider!r} is not recognised, so no rule set applies. "
                "No assessment was performed rather than applying another provider's "
                "rules."
            ],
            identity_review={},
        )

    summary = scope_summary or {}
    # A sweep that counted its scopes says how much it read. Coverage is that
    # share — 218 of 266 is 82%, not the 0% that any single failed scope used
    # to produce — and the reasons name what was not read and why.
    counted = (bool(summary.get("attempted")) and summary.get("read") is not None
               and not summary.get("regions_unknown")
               and int(summary["read"]) < int(summary["attempted"]))
    if (not sweep_complete or failed_scopes) and counted:
        read, attempted = int(summary["read"]), int(summary["attempted"])
        cov.determined(COV_INVENTORY, read)
        cov.undetermined(COV_INVENTORY, attempted - read)
        incomplete.extend(sweep_reasons(summary))
    elif not sweep_complete or failed_scopes:
        incomplete.append(
            f"The last discovery sweep did not enumerate every scope"
            + (f" ({failed_scopes} failed)" if failed_scopes else "")
            + ". Resources may be missing, so findings are not resolved from this "
              "assessment and coverage is reported as partial."
        )
        cov.undetermined(COV_INVENTORY, max(1, failed_scopes))
    elif not resources:
        # A complete sweep that returned nothing is not 100% inventory
        # coverage. An earlier version credited `max(1, len(resources))` as
        # determined, so the never-scanned TOR2 subscription reported 100%
        # inventory coverage over zero resources.
        cov.undetermined(COV_INVENTORY)
        incomplete.append(
            "No resources have been collected for this account, so nothing in the "
            "inventory could be assessed. Run a discovery scan."
        )
    else:
        cov.determined(COV_INVENTORY, len(resources))

    by_type: Dict[str, List[Any]] = {}
    index: Dict[str, Any] = {}
    for r in resources:
        by_type.setdefault(r.resource_type, []).append(r)
        key = getattr(r, "provider_resource_id", None)
        if key:
            index[key] = r

    # ── Per-resource rule evaluation ─────────────────────────────────────────
    # Two kinds of accumulation instead of emitting immediately:
    #
    # `aggregated` — rules that declare aggregate=True (the ownership-tag rule).
    #
    # `undetermined` — every UNKNOWN and NOT_SCANNED outcome, grouped by
    # (rule, reason). These are statements about a *collection gap*, not about
    # the individual resource, and the operator's action is the same for all
    # members of a group: fix the scan, or grant the permission. Reported one
    # per resource they were 133 identical "kms_key_id not collected" findings
    # on OCI and 93 identical "NSG rules not in inventory" findings on Azure
    # Production — enough to bury the confirmed problems underneath them. A
    # group of one still emits a per-resource finding, so precision is only
    # traded away when there is nothing to be precise about.
    aggregated: Dict[str, List[Tuple[Any, reg.Outcome]]] = {}
    undetermined: Dict[Tuple[str, str], List[Tuple[Any, reg.Outcome]]] = {}
    rule_stats: Dict[str, Dict[str, int]] = {}
    rules_run = 0

    for resource in resources:
        rules = reg.rules_for(prov, resource.resource_type)
        if not rules:
            continue
        ctx = reg.Ctx(
            resource=resource,
            provider=prov,
            config=resource.config or {},
            raw=resource.raw_data if isinstance(resource.raw_data, dict) else {},
            tags=resource.tags if isinstance(resource.tags, dict) else {},
            index=index,
            by_type=by_type,
        )
        for rule in rules:
            rules_run += 1
            try:
                result = rule.evaluate(ctx)
            except Exception:  # noqa: BLE001
                # A crashing rule must not take down the assessment, and must
                # not silently pass either — it becomes an UNKNOWN finding
                # naming itself.
                logger.exception("Rule %s crashed on %s", rule.rule_id, resource.id)
                result = reg.Outcome(
                    verdict=UNKNOWN, confidence=CONF_UNKNOWN,
                    unknown_reason=f"Rule {rule.rule_id} raised an error while evaluating "
                                   f"this resource; reported as undetermined rather than "
                                   f"passed.",
                )
            outcomes = list(_iter_outcomes(result))
            # Per resource type as well, for controls that a framework numbers
            # per kind while one rule covers several (CIS OCI 5.2.1 / 5.2.2).
            typed = ctl.stat_key(rule.rule_id, resource.resource_type)
            if not outcomes:
                # A rule returning None means "does not apply to this resource",
                # which is a real answer and is recorded as such.
                _bump(rule_stats, rule.rule_id, NOT_APPLICABLE)
                _bump(rule_stats, typed, NOT_APPLICABLE)
            for outcome in outcomes:
                _bump(rule_stats, rule.rule_id, outcome.verdict)
                _bump(rule_stats, typed, outcome.verdict)
                _account_coverage(cov, rule, outcome)
                if outcome.verdict not in (VULNERABLE, UNKNOWN, NOT_SCANNED):
                    continue
                if rule.aggregate and outcome.verdict == VULNERABLE:
                    aggregated.setdefault(rule.rule_id, []).append((resource, outcome))
                    continue
                if outcome.verdict in (UNKNOWN, NOT_SCANNED):
                    key = (rule.rule_id, (outcome.unknown_reason or outcome.verdict)[:400])
                    undetermined.setdefault(key, []).append((resource, outcome))
                    continue
                findings.append(_build(
                    rule=rule, resource=resource, outcome=outcome, provider=prov,
                    account_id=str(account_id), started=started,
                    discovery_scan_id=discovery_scan_id,
                ))

    # ── Aggregated findings ──────────────────────────────────────────────────
    for rule_id, hits in aggregated.items():
        rule = reg.RULES[rule_id]
        findings.append(_build_aggregate(
            rule=rule, hits=hits, provider=prov, account_id=str(account_id),
            started=started, discovery_scan_id=discovery_scan_id,
        ))

    for (rule_id, reason), hits in undetermined.items():
        rule = reg.RULES[rule_id]
        if len(hits) == 1:
            resource, outcome = hits[0]
            findings.append(_build(
                rule=rule, resource=resource, outcome=outcome, provider=prov,
                account_id=str(account_id), started=started,
                discovery_scan_id=discovery_scan_id,
            ))
            continue
        findings.append(_build_undetermined_aggregate(
            rule=rule, reason=reason, hits=hits, provider=prov,
            account_id=str(account_id), started=started,
            discovery_scan_id=discovery_scan_id,
        ))

    # ── Internet exposure ────────────────────────────────────────────────────
    # Confirmed exposure is per resource AND per port, because closing one port
    # should resolve one finding. Unresolvable exposure groups by reason for the
    # same reason the rule UNKNOWNs do: on the live Azure Production account all
    # 49 VMs share one cause ("no network interface is recorded"), one fix, and
    # one sentence — reporting it 49 times pushed the 25 confirmed findings off
    # the first screen.
    exposures = exp.analyse(resources, prov)
    unknown_exposure: Dict[str, List[exp.Exposure]] = {}
    for e in exposures:
        if e.verdict == EXPOSED:
            cov.determined(COV_EXPOSURE)
            findings.extend(_exposure_findings(
                e, provider=prov, account_id=str(account_id), started=started,
                discovery_scan_id=discovery_scan_id,
            ))
        elif e.verdict == EXPOSURE_UNKNOWN:
            cov.undetermined(COV_EXPOSURE)
            unknown_exposure.setdefault((e.unknown_reason or "unknown")[:400], []).append(e)
        else:
            cov.determined(COV_EXPOSURE)

    for reason, group in unknown_exposure.items():
        if len(group) == 1:
            findings.append(_exposure_unknown_finding(
                group[0], provider=prov, account_id=str(account_id), started=started,
                discovery_scan_id=discovery_scan_id,
            ))
            continue
        findings.append(_exposure_unknown_aggregate(
            reason=reason, group=group, provider=prov, account_id=str(account_id),
            started=started, discovery_scan_id=discovery_scan_id,
        ))

    # ── Azure identity grants ────────────────────────────────────────────────
    identity_status = getattr(identity_state, "status", None)
    if prov == AZURE:
        if grants:
            cov.determined(COV_IAM, len(grants))
            for risk in ident.analyse_azure_grants(grants):
                findings.append(_identity_finding(
                    risk, provider=prov, account_id=str(account_id), started=started,
                    discovery_scan_id=discovery_scan_id,
                ))
        else:
            cov.undetermined(COV_IAM)
            findings.append(_rbac_not_collected_finding(
                account_id=str(account_id), started=started, state=identity_state,
                discovery_scan_id=discovery_scan_id,
            ))
            incomplete.append(
                "Azure role assignments were not collected for this subscription, so no "
                "identity review was possible."
                + (f" Provider reported: {getattr(identity_state, 'status', 'not attempted')}."
                   if identity_state else "")
            )

    # Synthetic rules produce no per-resource outcome, so their stats come from
    # what the analysers concluded. Without this every exposure control would
    # report NOT_EVALUATED even on an account where exposure was fully resolved.
    for e in exposures:
        if e.verdict == EXPOSED:
            for op in e.open_ports:
                if op.severity != INFO:
                    _bump(rule_stats, _exposure_rule_for(op), VULNERABLE)
        elif e.verdict == EXPOSURE_UNKNOWN:
            _bump(rule_stats, "EXPOSURE_UNDETERMINED", UNKNOWN)
        else:
            # PROTECTED means every exposure rule was checked and none fired.
            for rid in ("EXPOSURE_MANAGEMENT_PORT_WORLD_OPEN",
                        "EXPOSURE_DATA_PORT_WORLD_OPEN",
                        "EXPOSURE_ALL_PORTS_WORLD_OPEN",
                        "EXPOSURE_PORT_WORLD_OPEN"):
                _bump(rule_stats, rid, SAFE)
            _bump(rule_stats, "EXPOSURE_UNDETERMINED", SAFE)

    if prov == AZURE:
        if grants:
            for rid in ("AZURE_RBAC_SUBSCRIPTION_OWNER", "AZURE_RBAC_ESCALATION",
                        "AZURE_RBAC_BROAD_WRITE",
                        "AZURE_RBAC_EXTERNAL_PRINCIPAL_PRIVILEGED"):
                _bump(rule_stats, rid, SAFE, n=len(grants))
            for f in findings:
                if f.rule_id.startswith("AZURE_RBAC_") and f.verdict == VULNERABLE:
                    _bump(rule_stats, f.rule_id, VULNERABLE)
            _bump(rule_stats, "AZURE_RBAC_NOT_COLLECTED", SAFE)
        else:
            _bump(rule_stats, "AZURE_RBAC_NOT_COLLECTED", NOT_SCANNED)

    # ── Certificates, secrets and keys ───────────────────────────────────────
    # Evaluated from the credential inventory, which has its own per-store
    # completeness (see models/credential_inventory.py). A store that could not
    # be read is a coverage gap and a NOT_SCANNED finding — never a pass — but
    # it does not make the whole assessment PARTIAL: that would stop every
    # other finding in the account from ever resolving because one Key Vault
    # refused its data plane.
    cred = credx.analyse(provider=prov, objects=credentials, sources=credential_sources,
                         now=started)
    cov.determined(COV_CREDENTIALS, cred.scopes_ok)
    cov.undetermined(COV_CREDENTIALS, cred.scopes_failed)
    for risk in cred.risks:
        findings.append(_credential_finding(
            risk, provider=prov, account_id=str(account_id), started=started,
            discovery_scan_id=discovery_scan_id))
    for rid, verdicts in cred.rule_stats.items():
        for verdict, n in verdicts.items():
            _bump(rule_stats, rid, verdict, n=n)

    # ── Secrets left in configuration ────────────────────────────────────────
    # Reads the inventory already loaded above, so it costs no extra I/O. The
    # analyser never returns the secret itself — see secrets.py — so nothing
    # here can leak one into a finding, an alert e-mail or a log line.
    #
    # Surfaces the scanner does not collect produce one INFO finding each, so
    # "no secrets found" cannot be read as "we looked everywhere".
    sec = secrets.analyse(provider=prov, account_id=str(account_id),
                          resources=resources)
    for risk in sec.risks:
        findings.append(_secret_finding(
            risk, provider=prov, account_id=str(account_id), started=started,
            discovery_scan_id=discovery_scan_id))
    for rid, verdicts in sec.rule_stats.items():
        for verdict, n in verdicts.items():
            _bump(rule_stats, rid, verdict, n=n)

    # ── Compliance citations ─────────────────────────────────────────────────
    # Provider-aware: a cross-cloud rule firing on an OCI account must not
    # carry CIS AWS citations just because the same rule is mapped there.
    for f in findings:
        f.compliance = ctl.mappings_for_rule(f.rule_id, provider=prov)

    findings.sort(key=lambda f: (
        severity_rank(f.severity),
        0 if f.verdict == VULNERABLE else 1,
        f.category,
        f.resource_name or "",
    ))

    outcome = ASSESS_COMPLETE if not incomplete else ASSESS_PARTIAL
    finished = datetime.now(timezone.utc)

    identity_review = ident.review(
        provider=prov,
        findings=findings,
        grants=grants,
        collection_status=(
            identity_status if prov == AZURE
            else ("Collected" if prov in (AWS, OCI) else None)
        ),
        collection_error=getattr(identity_state, "error_detail", None),
        missing_permission=getattr(identity_state, "missing_permission", None),
        identities_reviewed=_identities_reviewed(prov, by_type, grants),
    )

    return Assessment(
        account_id=str(account_id), provider=prov, outcome=outcome,
        findings=findings, exposures=exposures, coverage=cov.result(),
        resources_evaluated=len(resources), rules_evaluated=rules_run,
        subjects_evaluated=len(resources) + len(grants) + cred.objects_evaluated,
        started_at=started, finished_at=finished, incomplete_reasons=incomplete,
        identity_review=identity_review, rule_stats=rule_stats,
    )


def _bump(stats: Dict[str, Dict[str, int]], rule_id: str, verdict: str,
          n: int = 1) -> None:
    stats.setdefault(rule_id, {})[verdict] = stats.setdefault(rule_id, {}).get(verdict, 0) + n


def _identities_reviewed(prov: str, by_type: Dict[str, List[Any]],
                         grants: Sequence[Any]) -> int:
    if prov == AWS:
        return len(by_type.get("IAMRole", []))
    if prov == OCI:
        return len(by_type.get("IAMPolicy", []))
    return len(grants)


def _iter_outcomes(result: Any) -> Iterable[reg.Outcome]:
    if result is None:
        return ()
    if isinstance(result, reg.Outcome):
        return (result,)
    if isinstance(result, (list, tuple)):
        return [o for o in result if isinstance(o, reg.Outcome)]
    return ()


def _account_coverage(cov: _Coverage, rule: reg.SecurityRule,
                      outcome: reg.Outcome) -> None:
    """A rule that reached a conclusion counts toward coverage; one that could
    not counts against it. This is what turns "0 findings" into a number an
    operator can interpret."""
    if rule.coverage is None:
        return
    if outcome.verdict in (VULNERABLE, SAFE):
        cov.determined(rule.coverage)
    elif outcome.verdict in (UNKNOWN, NOT_SCANNED):
        cov.undetermined(rule.coverage)


def _build(*, rule: reg.SecurityRule, resource: Any, outcome: reg.Outcome,
           provider: str, account_id: str, started: datetime,
           discovery_scan_id: Optional[str]) -> SecurityFinding:
    resource_key = getattr(resource, "provider_resource_id", None)
    severity = outcome.severity or rule.severity
    # An UNKNOWN verdict never inherits the rule's severity: the rule's severity
    # describes the confirmed condition, and we do not have a confirmed
    # condition. It is reported at the lower of MEDIUM and the rule's own level,
    # so an unresolvable CRITICAL check is visible without being asserted.
    if outcome.verdict in (UNKNOWN, NOT_SCANNED):
        severity = severity if severity_rank(severity) > severity_rank(MEDIUM) else MEDIUM
    confidence = outcome.confidence or rule.confidence

    description = rule.description
    if outcome.detail:
        description = f"{rule.description} {outcome.detail}"
    if outcome.unknown_reason:
        description = f"{rule.description} {outcome.unknown_reason}"

    return SecurityFinding(
        rule_id=rule.rule_id,
        rule_version=rule.version,
        provider=provider,
        account_id=account_id,
        fingerprint=fingerprint(
            provider=provider, account_id=account_id, rule_id=rule.rule_id,
            resource_key=resource_key or str(resource.id),
            discriminator=outcome.discriminator,
        ),
        resource_key=resource_key,
        resource_id=str(resource.id),
        resource_name=resource.resource_name,
        resource_type=resource.resource_type,
        region=getattr(resource, "region_or_zone", None),
        title=rule.title,
        description=description,
        rationale=rule.rationale,
        remediation=rule.remediation,
        severity=severity,
        category=rule.category,
        verdict=outcome.verdict,
        confidence=confidence,
        status=OPEN,
        evidence=dict(outcome.evidence or {}),
        first_detected_at=started,
        last_detected_at=started,
        last_verified_at=None,   # set only by a provider re-verification, never here
        resource_last_discovered_at=getattr(resource, "updated_at", None)
        or getattr(resource, "discovered_at", None),
        discovery_scan_id=discovery_scan_id,
    )


def _build_aggregate(*, rule: reg.SecurityRule, hits: List[Tuple[Any, reg.Outcome]],
                     provider: str, account_id: str, started: datetime,
                     discovery_scan_id: Optional[str]) -> SecurityFinding:
    """One finding standing for N resources, with a drill-down sample.

    The sample is capped at 200. The full list is derivable by filtering the
    Resources tab on the same condition, and a 550-entry array on every
    findings response is a cost with no reader.
    """
    sample = [
        {
            "resource_id": str(r.id),
            "resource_key": getattr(r, "provider_resource_id", None),
            "resource_name": r.resource_name,
            "resource_type": r.resource_type,
            "region": getattr(r, "region_or_zone", None),
            "detail": o.detail,
            "evidence": o.evidence,
        }
        for r, o in hits[:200]
    ]
    by_type: Dict[str, int] = {}
    for r, _ in hits:
        by_type[r.resource_type] = by_type.get(r.resource_type, 0) + 1

    return SecurityFinding(
        rule_id=rule.rule_id,
        rule_version=rule.version,
        provider=provider,
        account_id=account_id,
        fingerprint=fingerprint(
            provider=provider, account_id=account_id, rule_id=rule.rule_id,
            resource_key=None, discriminator="aggregate",
        ),
        resource_key=None,
        resource_id=None,
        resource_name=None,
        resource_type=None,
        title=rule.title,
        description=(f"{rule.description} {len(hits)} resource(s) are affected across "
                     f"{len(by_type)} resource type(s)."),
        rationale=rule.rationale,
        remediation=rule.remediation,
        severity=rule.severity,
        category=rule.category,
        verdict=VULNERABLE,
        confidence=rule.confidence,
        status=OPEN,
        evidence={"affected_by_type": by_type, "sample_truncated": len(hits) > 200},
        first_detected_at=started,
        last_detected_at=started,
        discovery_scan_id=discovery_scan_id,
        affected_count=len(hits),
        affected_sample=sample,
    )


def _build_undetermined_aggregate(*, rule: reg.SecurityRule, reason: str,
                                  hits: List[Tuple[Any, reg.Outcome]], provider: str,
                                  account_id: str, started: datetime,
                                  discovery_scan_id: Optional[str]) -> SecurityFinding:
    """One finding for N resources the same check could not evaluate.

    Fingerprinted on the rule plus a hash of the reason, so two different
    reasons under the same rule stay distinct and each resolves on its own when
    its particular gap is fixed.
    """
    verdict = hits[0][1].verdict
    by_type: Dict[str, int] = {}
    for r, _ in hits:
        by_type[r.resource_type] = by_type.get(r.resource_type, 0) + 1

    sample = [
        {
            "resource_id": str(r.id),
            "resource_key": getattr(r, "provider_resource_id", None),
            "resource_name": r.resource_name,
            "resource_type": r.resource_type,
            "region": getattr(r, "region_or_zone", None),
            "evidence": o.evidence,
        }
        for r, o in hits[:200]
    ]

    return SecurityFinding(
        rule_id=rule.rule_id,
        rule_version=rule.version,
        provider=provider,
        account_id=account_id,
        fingerprint=fingerprint(
            provider=provider, account_id=account_id, rule_id=rule.rule_id,
            resource_key=None,
            discriminator=_gap_discriminator(reason),
        ),
        resource_key=None,
        resource_id=None,
        resource_name=None,
        resource_type=None,
        title=(f"{rule.title} — not assessed for {len(hits)} resource(s)"),
        description=(f"{len(hits)} resource(s) across {len(by_type)} type(s) could not be "
                     f"evaluated by this check. {reason}"),
        rationale=(
            "Grouped into one finding because the cause is shared: the action that "
            "resolves it — completing a scan, or granting a permission — resolves it for "
            "every resource listed. " + rule.rationale
        ),
        remediation=rule.remediation,
        # Never inherits the rule's severity: the rule's severity describes a
        # confirmed condition, and there is no confirmed condition here.
        severity=MEDIUM if verdict == UNKNOWN else INFO,
        category=rule.category,
        verdict=verdict,
        confidence=CONF_UNKNOWN,
        status=OPEN,
        evidence={"reason": reason, "affected_by_type": by_type,
                  "sample_truncated": len(hits) > 200},
        first_detected_at=started,
        last_detected_at=started,
        discovery_scan_id=discovery_scan_id,
        affected_count=len(hits),
        affected_sample=sample,
    )


def _gap_discriminator(reason: Optional[str]) -> str:
    """Stable identity for an aggregate "could not be assessed" finding.

    This was `hash(reason)`, and Python salts str hashes per process, so each
    service restart gave the same gap a new fingerprint: oci_test accumulated
    11 open copies of one finding. A digest is the same in every process.
    """
    return "undetermined:" + hashlib.sha256((reason or "").encode("utf-8")).hexdigest()[:12]


def _exposure_title(rule: reg.SecurityRule, op: portcat.OpenPort) -> str:
    """The finding title. A partial range is not "every port": 49152-65535 is
    16,384 ports, and calling it everything sends the reader looking for an
    allow-all rule that does not exist."""
    if op.port is None and op.port_range and op.port_range != (0, 65535):
        lo, hi = op.port_range
        return (f"Wide port range reachable from the entire internet: {op.label} "
                f"({hi - lo + 1:,} ports)")
    return f"{rule.title}: {op.label}"


# Which synthetic exposure rule a given open port maps to. Data ports first:
# a port that is both (none are) would be reported as the worse of the two.
def _exposure_rule_for(op: portcat.OpenPort) -> str:
    if op.port is None:
        return "EXPOSURE_ALL_PORTS_WORLD_OPEN"
    if op.port in portcat.DATA_PORTS:
        return "EXPOSURE_DATA_PORT_WORLD_OPEN"
    if op.port in portcat.MANAGEMENT_PORTS:
        return "EXPOSURE_MANAGEMENT_PORT_WORLD_OPEN"
    return "EXPOSURE_PORT_WORLD_OPEN"


def _exposure_findings(e: exp.Exposure, *, provider: str, account_id: str,
                       started: datetime,
                       discovery_scan_id: Optional[str]) -> List[SecurityFinding]:
    """One finding per open port, not one per resource.

    Deliberate: an operator who closes RDP but leaves Postgres open should see
    one finding resolve and one remain. A single per-resource finding would
    stay open with a changed description, which is indistinguishable from
    nothing having happened.
    """
    out: List[SecurityFinding] = []
    for op in e.open_ports:
        if op.severity == INFO:
            # 80/443 are the intended configuration for most workloads.
            # Recording them as findings trains people to ignore the list.
            continue
        rule = reg.RULES[_exposure_rule_for(op)]
        disc = f"port:{op.port}" if op.port is not None else f"range:{op.label}"
        out.append(SecurityFinding(
            rule_id=rule.rule_id,
            rule_version=rule.version,
            provider=provider,
            account_id=account_id,
            fingerprint=fingerprint(
                provider=provider, account_id=account_id, rule_id=rule.rule_id,
                resource_key=e.resource_key or e.resource_id, discriminator=disc,
            ),
            resource_key=e.resource_key,
            resource_id=e.resource_id,
            resource_name=e.resource_name,
            resource_type=e.resource_type,
            region=e.region,
            title=_exposure_title(rule, op),
            description=(
                f"{e.resource_name or 'This resource'} has public address "
                f"{', '.join(e.public_addresses) or 'unknown'} and permits inbound traffic "
                f"from the entire internet on {op.label}"
                + (f" via {', '.join(e.evaluated_controls)}." if e.evaluated_controls
                   else ".")
            ),
            rationale=op.why,
            remediation=rule.remediation,
            severity=op.severity,
            category=CAT_EXPOSURE,
            verdict=VULNERABLE,
            confidence=e.confidence,
            status=OPEN,
            evidence={
                "public_addresses": e.public_addresses,
                "port": op.to_dict(),
                "path": [h.to_dict() for h in e.path],
                "evaluated_controls": e.evaluated_controls,
                "confidence_note": e.unknown_reason,
            },
            first_detected_at=started,
            last_detected_at=started,
            discovery_scan_id=discovery_scan_id,
        ))
    return out


def _exposure_unknown_finding(e: exp.Exposure, *, provider: str, account_id: str,
                              started: datetime,
                              discovery_scan_id: Optional[str]) -> SecurityFinding:
    rule = reg.RULES["EXPOSURE_UNDETERMINED"]
    return SecurityFinding(
        rule_id=rule.rule_id,
        rule_version=rule.version,
        provider=provider,
        account_id=account_id,
        fingerprint=fingerprint(
            provider=provider, account_id=account_id, rule_id=rule.rule_id,
            resource_key=e.resource_key or e.resource_id,
        ),
        resource_key=e.resource_key,
        resource_id=e.resource_id,
        resource_name=e.resource_name,
        resource_type=e.resource_type,
        region=e.region,
        title=rule.title,
        description=f"{rule.description} {e.unknown_reason or ''}".strip(),
        rationale=rule.rationale,
        remediation=rule.remediation,
        severity=MEDIUM,
        category=CAT_EXPOSURE,
        verdict=UNKNOWN,
        confidence=CONF_UNKNOWN,
        status=OPEN,
        evidence={
            "public_addresses": e.public_addresses,
            "path": [h.to_dict() for h in e.path],
            "evaluated_controls": e.evaluated_controls,
            "reason": e.unknown_reason,
        },
        first_detected_at=started,
        last_detected_at=started,
        discovery_scan_id=discovery_scan_id,
    )


def _exposure_unknown_aggregate(*, reason: str, group: List[exp.Exposure], provider: str,
                                account_id: str, started: datetime,
                                discovery_scan_id: Optional[str]) -> SecurityFinding:
    """One finding for N internet-facing resources whose rules could not be
    resolved, all for the same reason."""
    rule = reg.RULES["EXPOSURE_UNDETERMINED"]
    by_type: Dict[str, int] = {}
    for e in group:
        by_type[e.resource_type] = by_type.get(e.resource_type, 0) + 1
    with_address = [e for e in group if e.public_addresses]

    return SecurityFinding(
        rule_id=rule.rule_id,
        rule_version=rule.version,
        provider=provider,
        account_id=account_id,
        fingerprint=fingerprint(
            provider=provider, account_id=account_id, rule_id=rule.rule_id,
            resource_key=None,
            discriminator=_gap_discriminator(reason),
        ),
        resource_name=None,
        resource_type=None,
        title=f"{rule.title} for {len(group)} resource(s)",
        description=(
            f"{len(group)} resource(s) across {len(by_type)} type(s) could not be "
            f"evaluated for internet exposure"
            + (f", of which {len(with_address)} report a public address. " if with_address
               else ". ")
            + reason
        ),
        rationale=rule.rationale,
        remediation=rule.remediation,
        # HIGH rather than MEDIUM when any of them is known to have a public
        # address: an internet-facing resource we cannot evaluate is a bigger
        # unknown than an internal one.
        severity=HIGH if with_address else MEDIUM,
        category=CAT_EXPOSURE,
        verdict=UNKNOWN,
        confidence=CONF_UNKNOWN,
        status=OPEN,
        evidence={
            "reason": reason,
            "affected_by_type": by_type,
            "with_public_address": len(with_address),
            "sample_truncated": len(group) > 200,
        },
        first_detected_at=started,
        last_detected_at=started,
        discovery_scan_id=discovery_scan_id,
        affected_count=len(group),
        affected_sample=[
            {
                "resource_id": e.resource_id,
                "resource_key": e.resource_key,
                "resource_name": e.resource_name,
                "resource_type": e.resource_type,
                "region": e.region,
                "public_addresses": e.public_addresses,
                "path": [h.to_dict() for h in e.path],
            }
            for e in group[:200]
        ],
    )


def _identity_finding(risk: ident.IdentityRisk, *, provider: str, account_id: str,
                      started: datetime,
                      discovery_scan_id: Optional[str]) -> SecurityFinding:
    rule = reg.RULES[risk.rule_id]
    # The principal is the subject, so it takes the resource slot — a role
    # assignment has no infrastructure resource of its own, and pointing the
    # finding at the scope would make every assignment in a subscription
    # collapse onto one fingerprint.
    subject = risk.principal_name or risk.principal_id or "unknown principal"
    return SecurityFinding(
        rule_id=rule.rule_id,
        rule_version=rule.version,
        provider=provider,
        account_id=account_id,
        fingerprint=fingerprint(
            provider=provider, account_id=account_id, rule_id=rule.rule_id,
            resource_key=risk.grant_key,
        ),
        resource_key=risk.grant_key,
        resource_id=None,
        resource_name=f"{subject} → {risk.role_name or risk.scope_level}",
        resource_type="RoleAssignment",
        title=rule.title,
        description=f"{rule.description} {risk.detail}",
        rationale=rule.rationale,
        remediation=rule.remediation,
        severity=risk.severity,
        category=CAT_IAM,
        verdict=VULNERABLE,
        confidence=risk.confidence,
        status=OPEN,
        evidence=dict(risk.evidence),
        first_detected_at=started,
        last_detected_at=started,
        discovery_scan_id=discovery_scan_id,
    )


def _credential_finding(risk: "credx.CredentialRisk", *, provider: str, account_id: str,
                        started: datetime,
                        discovery_scan_id: Optional[str]) -> SecurityFinding:
    """A certificate / secret / key finding.

    The object has no row in cloud_resources — it lives in the credential
    inventory — so, like a role assignment, it takes the resource slot with its
    own provider id. That id is what the fingerprint hangs off, so a renewed
    certificate with a new ARN is a new object, and a certificate whose expiry
    merely moved is the same finding with an updated description.
    """
    rule = reg.RULES[risk.rule_id]
    return SecurityFinding(
        rule_id=rule.rule_id,
        rule_version=rule.version,
        provider=provider,
        account_id=account_id,
        fingerprint=fingerprint(
            provider=provider, account_id=account_id, rule_id=rule.rule_id,
            resource_key=risk.subject_key, discriminator=risk.discriminator,
        ),
        resource_key=risk.subject_key,
        resource_id=None,
        resource_name=risk.name,
        resource_type=risk.resource_type,
        region=risk.region,
        title=rule.title,
        description=f"{rule.description} {risk.detail}",
        rationale=rule.rationale,
        remediation=rule.remediation,
        severity=risk.severity,
        category=CAT_ENCRYPTION,
        verdict=risk.verdict,
        confidence=risk.confidence,
        status=OPEN,
        evidence=dict(risk.evidence),
        first_detected_at=started,
        last_detected_at=started,
        discovery_scan_id=discovery_scan_id,
        affected_count=risk.affected_count,
        affected_sample=list(risk.affected_sample),
    )


def _secret_finding(risk: "secrets.SecretRisk", *, provider: str, account_id: str,
                    started: datetime,
                    discovery_scan_id: Optional[str]) -> SecurityFinding:
    """A credential found in configuration or in a tag.

    The fingerprint hangs off the resource key AND the location within it, so
    two secrets in one Lambda are two findings that resolve independently —
    removing one environment variable should close one finding, not both.

    `risk.evidence` is built by the analyser and already contains only
    non-reversible material; this function adds nothing to it, so there is one
    place to audit for leakage rather than two.
    """
    rule = reg.RULES[risk.rule_id]
    return SecurityFinding(
        rule_id=rule.rule_id,
        rule_version=rule.version,
        provider=provider,
        account_id=account_id,
        fingerprint=fingerprint(
            provider=provider, account_id=account_id, rule_id=rule.rule_id,
            resource_key=risk.resource_key or risk.discriminator,
            discriminator=risk.discriminator,
        ),
        resource_key=risk.resource_key,
        resource_id=risk.resource_id,
        resource_name=risk.resource_name,
        resource_type=risk.resource_type,
        region=risk.region,
        title=rule.title,
        description=f"{rule.description} {risk.detail}",
        rationale=rule.rationale,
        remediation=rule.remediation,
        severity=risk.severity,
        category=CAT_IAM,
        verdict=risk.verdict,
        confidence=risk.confidence,
        status=OPEN,
        evidence=dict(risk.evidence),
        first_detected_at=started,
        last_detected_at=started,
        discovery_scan_id=discovery_scan_id,
    )


def _rbac_not_collected_finding(*, account_id: str, started: datetime, state: Any,
                                discovery_scan_id: Optional[str]) -> SecurityFinding:
    rule = reg.RULES["AZURE_RBAC_NOT_COLLECTED"]
    status = getattr(state, "status", None) or "NeverRun"
    missing = getattr(state, "missing_permission", None)
    detail = getattr(state, "error_detail", None)
    description = f"{rule.description} Collection status: {status}."
    if missing:
        description += (f" The subscription's credentials lack '{missing}'. Granting the "
                        f"Reader role at subscription scope includes it.")
    return SecurityFinding(
        rule_id=rule.rule_id,
        rule_version=rule.version,
        provider=AZURE,
        account_id=account_id,
        fingerprint=fingerprint(
            provider=AZURE, account_id=account_id, rule_id=rule.rule_id,
        ),
        resource_name="Subscription role assignments",
        resource_type="RoleAssignment",
        title=rule.title,
        description=description,
        rationale=rule.rationale,
        remediation=rule.remediation,
        severity=INFO if status == "NeverRun" else MEDIUM,
        category=CAT_IAM,
        verdict=NOT_SCANNED,
        confidence=CONF_UNKNOWN,
        status=OPEN,
        evidence={"collection_status": status, "missing_permission": missing,
                  "provider_error": (detail or "")[:1200]},
        first_detected_at=started,
        last_detected_at=started,
        discovery_scan_id=discovery_scan_id,
    )


# ── Convenience: the numbers every view needs ───────────────────────────────


def summarise(assessment: Assessment) -> Dict[str, Any]:
    from app.security.model import (
        ACTIVE_FINDING_STATUSES, MUTED_FINDING_STATUSES, SEVERITIES,
    )

    active = [f for f in assessment.findings if f.status in ACTIVE_FINDING_STATUSES]
    confirmed = [f for f in active if f.verdict == VULNERABLE]
    undetermined = [f for f in active if f.verdict in (UNKNOWN, NOT_SCANNED)]

    score = scoring.compute(
        assessment.findings, coverage_pct=assessment.coverage_pct,
        resources_evaluated=assessment.subjects_evaluated,
    )
    exposure_summary = exp.summarise(assessment.exposures)

    return {
        "score": score.to_dict(),
        "findings": {
            "total": len(active),
            "confirmed": len(confirmed),
            "undetermined": len(undetermined),
            "muted": sum(1 for f in assessment.findings
                         if f.status in MUTED_FINDING_STATUSES),
            "by_severity": {
                sev: sum(1 for f in confirmed if f.severity == sev) for sev in SEVERITIES
            },
            "by_severity_undetermined": {
                sev: sum(1 for f in undetermined if f.severity == sev)
                for sev in SEVERITIES
            },
            "by_category": _count_by(confirmed, "category"),
        },
        "exposure": exposure_summary,
        "identity": {
            k: v for k, v in assessment.identity_review.items() if k != "findings"
        },
        "coverage": {
            "overall_pct": assessment.coverage_pct,
            "dimensions": [c.to_dict() for c in assessment.coverage],
            "note": ("Data-availability metric, not a security score. It reports how much "
                     "of the information each check needs was actually present."),
        },
        "assessment": assessment.to_dict(),
    }


def _count_by(findings: Sequence[SecurityFinding], attr: str) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for f in findings:
        k = getattr(f, attr, None) or "Unknown"
        out[k] = out.get(k, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))
