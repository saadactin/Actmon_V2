"""Identity & Access (CIEM): collection, analysis and the read paths.

Two pipelines and a set of queries.

**Collect** talks to the provider and writes the inventory — principals,
credentials, policies, memberships. It is the expensive half (provider API
calls, rate limit) and runs with discovery or on an explicit refresh.

**Analyse** reads the inventory plus the Event Log and writes everything
derived — effective permissions, capabilities, usage, trust, blast radius,
baselines, findings. It touches no provider API, so it can be re-run freely
after a rule change without paying for another sweep.

The split matters for a reason beyond cost: a failed collection must never
cause an analysis to conclude anything. `CloudIdentityAnalysisState` records
which of the two failed and why, and every read path surfaces it, so an empty
Identity tab says "not assessed, here is the permission to grant" rather than
showing a clean estate.

**Nothing here evaluates permissions against every resource on a UI request.**
§34 is explicit, and at 10,000 identities it is also the difference between a
page that loads and one that times out. Effective permissions are materialised
by `analyse`, the 18-row capability table answers the filters and the
dashboard, and the permission explorer's cross-product is computed for the one
question the operator actually asked.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.identity import (
    anomaly, aws_eval, azure_eval, blast_radius as br, collect_aws, collect_azure,
    collect_oci, dormancy, engine, findings as ciem_findings, oci_eval, trust as trust_mod,
    usage as usage_mod,
)
from app.identity.capability import HIGH_IMPACT_CAPABILITIES, covers
from app.identity.model import (
    ACTOR_GROUP, ACTOR_HUMAN, ACTOR_WORKLOAD, ALLOWED, ALLOWED_UNVERIFIED, AWS, AZURE,
    DECISIONS_PERMISSIVE, DEFAULT_DORMANT_DAYS, DORMANCY_DORMANT, DORMANCY_NEVER_USED,
    Decision, EXTERNAL_NO, MFA_NOT_APPLICABLE,
    MFA_UNKNOWN, NOT_DETERMINED, OCI, PRIV_ADMIN, PRIV_PRIVILEGED, PRIV_UNKNOWN,
    identity_key as make_identity_key, meta as model_meta, normalize_provider,
)
from app.models.cloud_account import CloudAccount
from app.models.identity import CloudIdentity
from app.models.identity_analysis import (
    ANALYSIS_FAILED, ANALYSIS_OK, ANALYSIS_PARTIAL,
)
from app.models.identity_grant import (
    COLLECT_AUTH_FAILED, COLLECT_NOT_SUPPORTED, COLLECT_OK, COLLECT_PERMISSION_DENIED,
    COLLECT_UNAVAILABLE,
)
from app.repository.ciem_repo import CiemRepository

logger = logging.getLogger("cloud_svc.identity")

DEFAULT_USAGE_WINDOW_DAYS = 90
# The baseline is the window BEFORE the comparison window, so "new behaviour"
# means new relative to a period that has closed.
DEFAULT_BASELINE_DAYS = 60
DEFAULT_COMPARISON_DAYS = 7


class IdentityCollectionRunning(RuntimeError):
    """Raised when a second collection is requested while one is in flight."""


class IdentityService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = CiemRepository(db)

    # ── Collection ───────────────────────────────────────────────────────────
    async def collect(self, account_id: uuid.UUID) -> Dict[str, Any]:
        """Collect the principal estate for one account."""
        account = await self.db.get(CloudAccount, account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        provider = normalize_provider(account.provider)
        if not provider:
            return await self._collection_failed(
                account_id, account.provider or "?", COLLECT_NOT_SUPPORTED,
                f"Unrecognised provider {account.provider!r}.")

        from app.utils.encryption import decrypt_credentials
        try:
            creds = decrypt_credentials(account.credentials_enc)
        except Exception as exc:  # noqa: BLE001
            return await self._collection_failed(
                account_id, provider, COLLECT_AUTH_FAILED,
                f"Stored credentials could not be decrypted: {exc}")

        loop = asyncio.get_running_loop()
        account_key = str(account_id)

        try:
            if provider == AWS:
                from app.providers.aws.aws_auth import AWSAuth
                auth = AWSAuth(creds)
                result = await loop.run_in_executor(
                    None, lambda: collect_aws.collect(
                        auth, account_id=str(account.provider_account_id or ""),
                        account_key=account_key))
                scps = await loop.run_in_executor(
                    None, lambda: collect_aws.collect_scps(
                        auth, account_id=str(account.provider_account_id or "")))
                result["scps"] = scps
            elif provider == AZURE:
                from app.providers.azure.azure_auth import AzureAuth
                auth = AzureAuth(creds)
                subscription = creds.get("subscription_id") or ""
                result = await loop.run_in_executor(
                    None, lambda: collect_azure.collect(
                        auth, subscription_id=subscription, account_key=account_key,
                        tenant_id=creds.get("tenant_id")))
                managed = await loop.run_in_executor(
                    None, lambda: collect_azure.collect_managed_identities(
                        auth, subscription_id=subscription, account_key=account_key))
                if managed.get("status") == COLLECT_OK:
                    known = {i["identity_key"] for i in result["identities"]}
                    for item in managed["identities"]:
                        if item["identity_key"] not in known:
                            result["identities"].append(item)
            elif provider == OCI:
                from app.providers.oci.oci_auth import OCIAuth
                auth = OCIAuth(creds)
                result = await loop.run_in_executor(
                    None, lambda: collect_oci.collect(
                        auth, tenancy_ocid=auth.tenancy_ocid, account_key=account_key))
            else:
                return await self._collection_failed(
                    account_id, provider, COLLECT_NOT_SUPPORTED,
                    "No identity collector for this provider.")
        except Exception as exc:  # noqa: BLE001 — a failure is data
            logger.exception("Identity collection failed for %s", account_id)
            return await self._collection_failed(
                account_id, provider, COLLECT_UNAVAILABLE, str(exc)[:2000])

        status = result.get("status") or COLLECT_OK
        if status != COLLECT_OK:
            return await self._collection_failed(
                account_id, provider, status, result.get("error_detail"),
                missing_permission=result.get("missing_permission"))

        return await self._persist_collection(account_id, provider, result)

    async def _persist_collection(
        self, account_id: uuid.UUID, provider: str, result: Dict[str, Any],
    ) -> Dict[str, Any]:
        identities = result.get("identities") or []
        partial = bool(result.get("partial"))

        key_to_id = await self.repo.replace_identities(
            account_id=account_id, provider=provider, identities=identities,
            prune=not partial,
        )

        credential_total = 0
        for spec in identities:
            identity_id = key_to_id.get(spec.get("identity_key") or "")
            if not identity_id:
                continue
            creds = spec.get("credentials") or []
            if creds:
                credential_total += await self.repo.replace_credentials(
                    account_id=account_id, provider=provider,
                    identity_id=identity_id, credentials=creds)

        policies = []
        for spec in result.get("policies") or []:
            resolved = key_to_id.get(spec.get("identity_key") or "")
            policies.append({**spec, "identity_id": resolved})
        await self.repo.replace_policies(account_id=account_id, provider=provider,
                                         policies=policies)

        memberships = []
        for spec in result.get("memberships") or []:
            member = key_to_id.get(spec.get("member_identity_key") or "")
            container = key_to_id.get(spec.get("container_identity_key") or "")
            if member and container:
                memberships.append({
                    "member_identity_id": member,
                    "container_identity_id": container,
                    "membership_kind": spec.get("membership_kind"),
                    "match_rule": spec.get("match_rule"),
                })
        await self.repo.replace_memberships(account_id=account_id,
                                            memberships=memberships)

        # Counters live on the identity row so the list query never pays for
        # a COUNT per row. Written here, where the real numbers are in hand.
        for spec in identities:
            identity_id = key_to_id.get(spec.get("identity_key") or "")
            if not identity_id:
                continue
            row = await self.repo.identity_by_id(identity_id)
            if row is None:
                continue
            creds = spec.get("credentials") or []
            row.credential_count = len(creds)
            row.active_credential_count = len(
                [c for c in creds if (c.get("status") or "").upper() == "ACTIVE"])
            row.policy_count = len([p for p in policies
                                    if p.get("identity_id") == identity_id])
            row.group_count = len([m for m in memberships
                                   if m["member_identity_id"] == identity_id])

        await self.repo.record_analysis_state(
            account_id=account_id, provider=provider,
            status=ANALYSIS_PARTIAL if partial else ANALYSIS_OK,
            identity_count=len(identities),
            missing_stages=result.get("errors") or None,
            error_detail=None,
        )
        await self.db.commit()
        logger.info("Collected %d identities for account %s (%s)%s",
                    len(identities), account_id, provider,
                    " [partial]" if partial else "")
        return {
            "status": COLLECT_OK,
            "partial": partial,
            "identities": len(identities),
            "credentials": credential_total,
            "policies": len(policies),
            "memberships": len(memberships),
            "errors": result.get("errors") or [],
            "graph_gaps": result.get("graph_gaps") or [],
            "deny_assignments_collected": result.get("deny_assignments_collected"),
            "scp_collected": (result.get("scps") or {}).get("status") == COLLECT_OK,
        }

    async def _collection_failed(
        self, account_id: uuid.UUID, provider: str, status: str,
        detail: Optional[str], missing_permission: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Record a refusal WITHOUT touching the inventory.

        The existing rows stay, so the UI shows what was collected before
        beside "last attempt failed", rather than an empty list that reads as
        "every identity was removed".
        """
        await self.repo.record_analysis_state(
            account_id=account_id, provider=provider, status=ANALYSIS_FAILED,
            error_detail=detail,
            missing_stages=[{"stage": "collection", "status": status,
                             "detail": detail,
                             "missing_permission": missing_permission}],
        )
        await self.db.commit()
        return {"status": status, "error_detail": detail,
                "missing_permission": missing_permission, "identities": 0}

    # ── Analysis ─────────────────────────────────────────────────────────────
    async def analyze(
        self, account_id: uuid.UUID, *,
        usage_window_days: int = DEFAULT_USAGE_WINDOW_DAYS,
        dormant_days: int = DEFAULT_DORMANT_DAYS,
    ) -> Dict[str, Any]:
        """Evaluate permissions, correlate usage, compute reach, emit findings."""
        started = datetime.now(timezone.utc)
        account = await self.db.get(CloudAccount, account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        provider = normalize_provider(account.provider) or account.provider
        run_id = uuid.uuid4()

        identities = await self.repo.identities(account_id)
        if not identities:
            await self.repo.record_analysis_state(
                account_id=account_id, provider=provider, status=ANALYSIS_FAILED,
                error_detail="No identities are held for this account. Run a collection "
                             "first; this is not a statement that the account has none.",
                identity_count=0, last_run_id=run_id,
            )
            await self.db.commit()
            return {"status": ANALYSIS_FAILED, "identities": 0}

        policies = await self.repo.policies(account_id=account_id)
        memberships = await self.repo.memberships(account_id)
        by_id = {i.id: i for i in identities}

        # Inheritance: a member's effective policy set includes its containers'.
        containers_of: Dict[uuid.UUID, List[uuid.UUID]] = {}
        for m in memberships:
            containers_of.setdefault(m.member_identity_id, []).append(
                m.container_identity_id)

        policies_by_identity: Dict[Optional[uuid.UUID], List[Any]] = {}
        for policy in policies:
            policies_by_identity.setdefault(policy.identity_id, []).append(policy)

        window = usage_mod.Window.trailing(usage_window_days)
        events_by_actor, total_events, source_available = await self._events_by_actor(
            account_id, provider, window)
        window.events_in_window = total_events
        window.source_available = source_available
        if not source_available:
            window.source_note = ("No events are collected for this account over this "
                                  "window, so no permission-usage conclusion is drawn.")

        resources, inventory_complete, inventory_note = await self._inventory(account_id)
        topology_edges = await self._topology_edges(account_id)
        known_accounts = await self._known_accounts()

        evaluated = 0
        unevaluated = 0
        caps_by_key: Dict[str, List[str]] = {}
        usage_by_key: Dict[str, Dict[str, Any]] = {}
        blast_by_key: Dict[str, Dict[str, Any]] = {}
        dormancy_by_key: Dict[str, Dict[str, Any]] = {}
        anomalies_by_key: Dict[str, List[Dict[str, Any]]] = {}
        creds_by_key: Dict[str, List[Dict[str, Any]]] = {}
        all_trust: List[Dict[str, Any]] = []
        missing_stages: List[Dict[str, Any]] = []

        privileged_identity_ids: List[uuid.UUID] = []

        for identity in identities:
            own = list(policies_by_identity.get(identity.id) or [])
            inherited: List[Any] = []
            for container_id in containers_of.get(identity.id, []):
                inherited.extend(policies_by_identity.get(container_id) or [])

            policy_set, evaluable, stage_gaps = self._build_policy_set(
                provider, identity, own, inherited)
            missing_stages.extend(stage_gaps)

            summary = engine.summarize(provider, policy_set, evaluable=evaluable)
            if evaluable:
                evaluated += 1
            else:
                unevaluated += 1

            identity.privilege_level = summary["privilege_level"]
            identity.standing_admin = bool(summary["standing_admin"])
            if identity.privilege_level in (PRIV_ADMIN, PRIV_PRIVILEGED):
                privileged_identity_ids.append(identity.id)

            held = list(summary["capabilities"].keys())
            caps_by_key[identity.identity_key] = held

            await self.repo.replace_capabilities(
                account_id=account_id, identity_id=identity.id,
                rows=[{
                    "provider": provider, "capability": capability,
                    "high_impact": capability in HIGH_IMPACT_CAPABILITIES,
                    "scope_level": (summary["capability_scopes"].get(capability) or {}).get("level"),
                    "scope": (summary["capability_scopes"].get(capability) or {}).get("scope"),
                    "evidence_actions": evidence,
                    "source_names": None,
                    "certain": evaluable,
                } for capability, evidence in summary["capabilities"].items()],
            )

            await self.repo.replace_effective_permissions(
                account_id=account_id, identity_id=identity.id, run_id=run_id,
                rows=self._permission_rows(provider, identity, policy_set, summary,
                                           evaluable),
            )

            # ── Usage ────────────────────────────────────────────────────────
            events = events_by_actor.get(identity.identity_key, []) \
                + events_by_actor.get((identity.provider_id or "").lower(), []) \
                + events_by_actor.get((identity.name or "").lower(), [])
            observations, seen, unmappable = usage_mod.aggregate_events(provider, events)
            correlation = usage_mod.correlate(
                provider, granted_patterns=summary["granted_patterns"],
                observations=observations, window=window,
                unmappable_events=unmappable)
            usage_by_key[identity.identity_key] = correlation
            await self.repo.replace_usage(
                account_id=account_id, identity_id=identity.id,
                rows=self._usage_rows(provider, correlation, window),
            )

            # Activity from our own event log refines last-used, but never
            # overwrites a provider-reported date with an older one.
            event_last = max((o.last_seen for o in observations.values()
                              if o.last_seen), default=None)
            if event_last and (identity.last_used_at is None
                               or event_last > identity.last_used_at):
                identity.last_used_at = event_last
                identity.last_used_source = "event log"

            # ── Dormancy, credentials, MFA, break-glass ──────────────────────
            detail = identity.provider_detail or {}
            verdict = dormancy.assess_identity(
                actor_class=identity.actor_class,
                last_used_at=identity.last_used_at,
                last_used_source=identity.last_used_source,
                provider_reports_last_used=bool(detail.get("provider_reports_last_used",
                                                           identity.last_used_at is not None)),
                event_last_seen=event_last,
                event_log_covers_identity=source_available,
                created_at=identity.created_at_provider,
                threshold_days=dormant_days,
            )
            dormancy_by_key[identity.identity_key] = verdict.to_dict()

            credentials = await self.repo.credentials(account_id=account_id,
                                                      identity_id=identity.id)
            active_same_kind: Dict[str, int] = {}
            for cred in credentials:
                if (cred.status or "").upper() == "ACTIVE":
                    active_same_kind[cred.credential_kind] = \
                        active_same_kind.get(cred.credential_kind, 0) + 1
            cred_rows: List[Dict[str, Any]] = []
            for cred in credentials:
                assessment = dormancy.assess_credential(
                    credential_kind=cred.credential_kind, status=cred.status or "UNKNOWN",
                    created_at=cred.created_at_provider, last_used_at=cred.last_used_at,
                    never_used=cred.never_used, expires_at=cred.expires_at,
                    sibling_active_count=active_same_kind.get(cred.credential_kind, 1),
                    identity_privilege=identity.privilege_level,
                )
                cred.recommendation = assessment["recommendation"]
                cred.recommendation_reason = assessment["recommendation_reason"]
                cred_rows.append({**assessment,
                                  "credential_ref": cred.credential_ref})
            creds_by_key[identity.identity_key] = cred_rows

            potential, signals = dormancy.break_glass_signals(
                name=identity.name, privilege_level=identity.privilege_level,
                dormancy=verdict.state, mfa_state=identity.mfa_state,
                actor_class=identity.actor_class,
                credential_count=identity.active_credential_count or 0,
            )
            identity.potential_break_glass = potential
            identity.break_glass_signals = signals or None

            # ── Behavioural baseline (§28) ───────────────────────────────────
            # The baseline window CLOSES before the comparison window opens, so
            # "new behaviour" means new relative to a period that has ended —
            # otherwise every identity's first week is a deviation from itself.
            baseline_end = window.end - timedelta(days=DEFAULT_COMPARISON_DAYS)
            baseline_start = baseline_end - timedelta(days=DEFAULT_BASELINE_DAYS)
            baseline = anomaly.build_baseline(provider, events, start=baseline_start,
                                              end=baseline_end)
            current = anomaly.build_baseline(provider, events, start=baseline_end,
                                             end=window.end)
            await self.repo.upsert_baseline(
                account_id=account_id, identity_id=identity.id, provider=provider,
                data=baseline.to_dict())
            signals = anomaly.compare(
                provider, baseline=baseline, current=current,
                was_dormant=verdict.state in (DORMANCY_DORMANT, DORMANCY_NEVER_USED),
                dormant_days=verdict.days_since_use,
            )
            if signals:
                anomalies_by_key[identity.identity_key] = signals

            # ── Blast radius ─────────────────────────────────────────────────
            permissive = [
                r for r in self._permission_rows(provider, identity, policy_set,
                                                 summary, evaluable)
                if r["decision"] in DECISIONS_PERMISSIVE
            ]
            reach = br.compute(
                provider, permissions=permissive, resources=resources,
                capabilities=held, topology_edges=topology_edges,
                inventory_complete=inventory_complete, inventory_note=inventory_note,
            )
            blast_by_key[identity.identity_key] = reach
            await self.repo.upsert_blast_radius(
                account_id=account_id, identity_id=identity.id, provider=provider,
                data=reach)

            # ── Trust ────────────────────────────────────────────────────────
            if provider == AWS:
                trust_doc = (identity.provider_detail or {}).get("trust_document")
                if trust_doc is None:
                    trust_doc = next(
                        (p.document for p in own if p.policy_stage == "trust_policy"),
                        None)
                if trust_doc:
                    principals = aws_eval.trust_principals(trust_doc)
                    for edge in trust_mod.build_edges(
                        provider, target_key=identity.provider_id,
                        target_name=identity.name, principals=principals,
                        known_accounts=known_accounts,
                        target_privilege=identity.privilege_level,
                    ):
                        payload = edge.to_dict()
                        payload["target_identity_id"] = identity.id
                        all_trust.append(payload)

            if identity.external == "EXTERNAL":
                all_trust.append({
                    "target_key": identity.provider_id,
                    "target_name": identity.name,
                    "target_identity_id": identity.id,
                    "source_principal": identity.principal_name or identity.provider_id,
                    "source_account": (identity.external_detail or {}).get("tenant_id"),
                    "source_type": "guest_user",
                    "external": "EXTERNAL",
                    "trust_kind": "GUEST",
                    "target_privilege": identity.privilege_level,
                    "evidence": identity.external_detail,
                })

        if all_trust:
            await self.repo.replace_trust(account_id=account_id, provider=provider,
                                          edges=all_trust)

        # ── Findings ─────────────────────────────────────────────────────────
        rows = await self.repo.identities(account_id)
        emitted = ciem_findings.analyse(
            provider=provider, account_id=str(account_id),
            identities=[self._finding_view(i, caps_by_key) for i in rows],
            capabilities_by_identity=caps_by_key,
            credentials_by_identity=creds_by_key,
            usage_by_identity=usage_by_key,
            blast_by_identity=blast_by_key,
            trust_edges=all_trust,
            dormancy_by_identity=dormancy_by_key,
        )
        complete = unevaluated == 0
        persisted = await self._persist_findings(account_id, emitted, complete=complete)

        duration = (datetime.now(timezone.utc) - started).total_seconds()
        status = ANALYSIS_PARTIAL if (unevaluated or not source_available) else ANALYSIS_OK
        await self.repo.record_analysis_state(
            account_id=account_id, provider=provider, status=status,
            identity_count=len(rows), evaluated_count=evaluated,
            unevaluated_count=unevaluated,
            missing_stages=missing_stages or None,
            usage_window_days=usage_window_days,
            usage_events_analyzed=total_events,
            usage_source_available=source_available,
            last_run_id=run_id, duration_s=duration,
        )
        await self.db.commit()
        logger.info("Analysed %d identities for %s in %.1fs (%d evaluated, %d not)",
                    len(rows), account_id, duration, evaluated, unevaluated)
        return {
            "status": status,
            "run_id": str(run_id),
            "identities": len(rows),
            "evaluated": evaluated,
            "not_evaluated": unevaluated,
            "findings": persisted,
            "usage_window_days": usage_window_days,
            "events_analyzed": total_events,
            "usage_source_available": source_available,
            "inventory_complete": inventory_complete,
            "identities_with_activity_change": len(anomalies_by_key),
            "duration_s": round(duration, 2),
        }

    # ── Building provider policy sets ────────────────────────────────────────
    def _build_policy_set(
        self, provider: str, identity: CloudIdentity,
        own: Sequence[Any], inherited: Sequence[Any],
    ) -> Tuple[Any, bool, List[Dict[str, Any]]]:
        """Assemble the right policy set, and say what was missing."""
        gaps: List[Dict[str, Any]] = []

        if provider == AWS:
            identity_docs = [p.document for p in own
                             if p.policy_stage == "identity_policy" and p.document]
            group_docs = [(p.policy_name or "group", p.document) for p in inherited
                          if p.document]
            boundary = next((p.document for p in own
                             if p.policy_stage == "permission_boundary"), None)
            scps = [p.document for p in own
                    if p.policy_stage == "service_control_policy" and p.document]
            trust = next((p.document for p in own
                          if p.policy_stage == "trust_policy"), None)
            policy_set = aws_eval.AwsPolicySet(
                identity_documents=identity_docs, group_documents=group_docs,
                boundary_document=boundary, scp_documents=scps,
                scp_collected=bool(scps), trust_document=trust,
            )
            evaluable = bool(identity_docs or group_docs)
            if not scps:
                gaps.append({"stage": "service_control_policy",
                             "reason": "NOT_COLLECTED",
                             "missing_permission": "organizations:ListPoliciesForTarget"})
            return policy_set, evaluable, gaps

        if provider == AZURE:
            assignments = [
                azure_eval.RoleAssignment.from_grant({
                    "role_name": p.policy_name, "scope": p.scope,
                    "permissions": p.document,
                    # policy_key is the ASSIGNMENT id; the role definition id
                    # travels inside the document. Keeping them apart is what
                    # lets one principal hold one role at several scopes.
                    "role_key": (p.document or {}).get("role_definition_id"),
                    "role_type": p.policy_type, "grant_key": p.policy_key,
                    "principal_id": identity.provider_id,
                    "scope_level": p.scope_level,
                })
                for p in list(own) + list(inherited)
                if p.policy_stage == "rbac_assignment"
            ]
            policy_set = azure_eval.AzureAssignmentSet(
                assignments=assignments, assignments_collected=True,
                deny_assignments_collected=False,
            )
            gaps.append({"stage": "deny_assignment", "reason": "NOT_COLLECTED",
                         "missing_permission":
                             "Microsoft.Authorization/denyAssignments/read"})
            return policy_set, bool(assignments), gaps

        if provider == OCI:
            subject_names = [n for n in (identity.name, identity.principal_name) if n]
            statements = []
            for policy in list(own) + list(inherited):
                if policy.policy_stage != "oci_policy_statement":
                    continue
                statements.extend(oci_eval.parse_policy_resource(
                    policy.document, policy_name=policy.policy_name,
                    policy_ocid=policy.policy_key,
                    compartment_id=policy.scope))
            subject_kind = {"OCI_GROUP": "group", "OCI_DYNAMIC_GROUP": "dynamic-group"} \
                .get(identity.identity_type)
            policy_set = oci_eval.OciPolicySet(
                statements=statements, subject_names=subject_names,
                subject_kind=subject_kind, policies_collected=True,
                compartment_tree_collected=False,
            )
            gaps.append({"stage": "oci_policy_statement", "reason": "NOT_COLLECTED",
                         "detail": "The compartment tree was not collected, so "
                                   "compartment inheritance could not be confirmed.",
                         "missing_permission": "inspect compartments in tenancy"})
            return policy_set, bool(statements), gaps

        return None, False, [{"stage": "provider", "reason": "NOT_SUPPORTED"}]

    def _permission_rows(
        self, provider: str, identity: CloudIdentity, policy_set: Any,
        summary: Dict[str, Any], evaluable: bool,
    ) -> List[Dict[str, Any]]:
        """Materialise one row per granted statement, with its decision."""
        if not evaluable or policy_set is None:
            return [{
                "provider": provider, "action_pattern": "(not evaluated)",
                "capability": None, "resource_pattern": None,
                "decision": NOT_DETERMINED, "source_stage": "identity_policy",
                "source_name": None,
                "unevaluated": [{"stage": "identity_policy", "reason": "NOT_COLLECTED",
                                 "detail": "No policy document was collected for this "
                                           "principal, so its permissions are unknown."}],
            }]

        rows: List[Dict[str, Any]] = []
        from app.identity.capability import classify_action

        if provider == AWS:
            for stmt in list(policy_set.identity) + [s for _, s in policy_set.group]:
                if stmt.is_deny:
                    continue
                for action in (stmt.actions or ["*"]):
                    decision = aws_eval.evaluate(policy_set, action=action)
                    rows.append({
                        "provider": provider, "action_pattern": action,
                        "capability": classify_action(provider, action),
                        "resource_pattern": (stmt.resources or ["*"])[0],
                        "decision": decision.decision,
                        "conditional": decision.conditional,
                        "conditions": stmt.conditions or None,
                        "source_stage": "identity_policy",
                        "source_name": stmt.sid or "policy",
                        "statement_id": stmt.sid,
                        "steps": [s.to_dict() for s in decision.steps],
                        "unevaluated": [u.to_dict() for u in decision.unevaluated],
                    })
        elif provider == AZURE:
            for assignment in policy_set.assignments:
                for action in assignment.actions:
                    decision = azure_eval.evaluate(policy_set, action=action,
                                                   resource=assignment.scope)
                    rows.append({
                        "provider": provider, "action_pattern": action,
                        "capability": classify_action(provider, action),
                        "resource_pattern": assignment.scope,
                        "decision": decision.decision,
                        "conditional": decision.conditional,
                        "source_stage": "rbac_assignment",
                        "source_name": assignment.role_name,
                        "source_key": assignment.role_key,
                        "statement_id": assignment.assignment_id,
                        "inherited": False,
                        "steps": [s.to_dict() for s in decision.steps],
                        "unevaluated": [u.to_dict() for u in decision.unevaluated],
                    })
        elif provider == OCI:
            for stmt in policy_set.applicable():
                token = f"{stmt.verb}:{stmt.resource_type}"
                decision = oci_eval.evaluate(policy_set, action=token)
                rows.append({
                    "provider": provider, "action_pattern": token,
                    "capability": classify_action(provider, token),
                    "resource_pattern": ("tenancy" if stmt.location_kind == "tenancy"
                                         else f"compartment {stmt.location_name or '?'}"),
                    "decision": decision.decision,
                    "conditional": bool(stmt.condition),
                    "conditions": {"where": stmt.condition} if stmt.condition else None,
                    "source_stage": "oci_policy_statement",
                    "source_name": stmt.policy_name,
                    "source_key": stmt.policy_ocid,
                    "statement_id": stmt.raw,
                    "steps": [s.to_dict() for s in decision.steps],
                    "unevaluated": [u.to_dict() for u in decision.unevaluated],
                })
        # De-duplicate on (action, resource) — several statements granting the
        # same thing is normal and would otherwise inflate every count.
        seen: set = set()
        unique: List[Dict[str, Any]] = []
        for row in rows:
            key = (row["action_pattern"], row.get("resource_pattern"))
            if key in seen:
                continue
            seen.add(key)
            unique.append(row)
        return unique

    def _usage_rows(
        self, provider: str, correlation: Dict[str, Any], window: usage_mod.Window,
    ) -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []
        for entry in correlation.get("actions") or []:
            rows.append({
                "provider": provider, "action": entry["action"],
                "capability": entry.get("capability"),
                "usage_state": entry["usage_state"],
                "event_count": entry.get("event_count") or 0,
                "success_count": entry.get("success_count") or 0,
                "first_observed_at": _parse(entry.get("first_observed_at")),
                "last_observed_at": _parse(entry.get("last_observed_at")),
                "distinct_resources": entry.get("distinct_resources") or 0,
                "regions": entry.get("regions"),
                "window_start": window.start, "window_end": window.end,
                "window_days": window.days, "events_in_window": window.events_in_window,
            })
        for entry in correlation.get("patterns") or []:
            if entry["usage_state"] == usage_mod.USAGE_OBSERVED:
                continue
            rows.append({
                "provider": provider, "action": entry["pattern"],
                "capability": entry.get("capability"),
                "usage_state": entry["usage_state"],
                "event_count": 0, "success_count": 0,
                "window_start": window.start, "window_end": window.end,
                "window_days": window.days, "events_in_window": window.events_in_window,
                "confidence_reason": entry.get("confidence_reason"),
            })
        # One row per action, so a pattern that is also a concrete action does
        # not violate the unique constraint.
        unique: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            unique.setdefault(row["action"], row)
        return list(unique.values())

    def _finding_view(
        self, identity: CloudIdentity, caps: Dict[str, List[str]],
    ) -> Dict[str, Any]:
        view = identity.to_dict(include_detail=True)
        view["capabilities"] = caps.get(identity.identity_key, [])
        view["standing_admin_reason"] = (identity.break_glass_signals or None) and None
        return view

    # ── Inputs from the rest of the platform ─────────────────────────────────
    async def _events_by_actor(
        self, account_id: uuid.UUID, provider: str, window: usage_mod.Window,
    ) -> Tuple[Dict[str, List[Any]], int, bool]:
        """Event Log rows grouped by the actor strings an identity may match.

        Matched on several keys because providers name an actor differently in
        the audit log than in IAM: CloudTrail's `userIdentity.arn` for an
        assumed role is the SESSION arn, not the role arn.
        """
        from app.models.cloud_event import CloudEvent

        rows = list((await self.db.execute(
            select(CloudEvent).where(
                CloudEvent.account_id == account_id,
                CloudEvent.timestamp >= window.start,
                CloudEvent.timestamp <= window.end,
            ).limit(500_000)
        )).scalars().all())

        grouped: Dict[str, List[Any]] = {}
        for event in rows:
            for key in filter(None, (
                (event.actor_id or "").lower(),
                (event.actor_name or "").lower(),
                (event.actor_email or "").lower(),
            )):
                grouped.setdefault(key, []).append(event)
            # An assumed-role session arn ends in /<session-name>; the role arn
            # is what the identity table holds, so index both.
            arn = (event.actor_id or "")
            if ":assumed-role/" in arn:
                role = arn.split(":assumed-role/", 1)[1].split("/")[0]
                grouped.setdefault(role.lower(), []).append(event)
        return grouped, len(rows), bool(rows)

    async def _inventory(
        self, account_id: uuid.UUID,
    ) -> Tuple[List[br.ResourceRef], bool, Optional[str]]:
        from app.models.resource import CloudResource

        rows = list((await self.db.execute(
            select(CloudResource).where(CloudResource.account_id == account_id)
        )).scalars().all())
        refs = [
            br.ResourceRef(
                key=r.provider_resource_id or str(r.id), name=r.resource_name,
                resource_type=r.resource_type, region=r.region_or_zone,
                account_id=str(account_id),
            )
            for r in rows
        ]
        complete, note = await self._inventory_complete(account_id)
        return refs, complete, note

    async def _inventory_complete(
        self, account_id: uuid.UUID,
    ) -> Tuple[bool, Optional[str]]:
        """Whether the last discovery sweep enumerated everything it tried.

        Reads the existing discovery job record rather than inventing a second
        notion of completeness — the partial-scan rule already lives there.
        """
        from app.models.discovery_job import DiscoveryJob

        job = (await self.db.execute(
            select(DiscoveryJob)
            .where(DiscoveryJob.account_id == account_id)
            .order_by(DiscoveryJob.started_at.desc()).limit(1)
        )).scalar_one_or_none()
        if job is None:
            return False, ("No discovery sweep has completed for this account, so the "
                           "resource inventory behind these counts is unknown.")
        status = (getattr(job, "status", "") or "").upper()
        if status != "COMPLETED":
            return False, (
                f"The last discovery sweep finished as {status or 'unknown'}, so the "
                "inventory these counts are measured against is incomplete. The "
                "numbers are a floor, not a total."
            )
        # A COMPLETED sweep can still have skipped scopes — `scope_summary` is
        # where the per-scope accounting lives, and the scan-coverage work put
        # it there precisely so "completed" and "complete" could be told apart.
        summary = getattr(job, "scope_summary", None) or {}
        attempted = summary.get("scopes_attempted") or summary.get("attempted")
        read = summary.get("scopes_read") or summary.get("read")
        if isinstance(attempted, int) and isinstance(read, int) and attempted > read:
            return False, (
                f"The last sweep read {read} of {attempted} scopes, so part of the "
                "estate was not enumerated. These counts are a floor, not a total."
            )
        return True, None

    async def _topology_edges(self, account_id: uuid.UUID) -> List[Dict[str, Any]]:
        try:
            from app.models.topology_snapshot import CloudTopologySnapshot

            snapshot = (await self.db.execute(
                select(CloudTopologySnapshot)
                .where(CloudTopologySnapshot.account_id == account_id)
                .order_by(CloudTopologySnapshot.taken_at.desc()).limit(1)
            )).scalar_one_or_none()
            if snapshot is None:
                return []
            return list(getattr(snapshot, "edges", None) or [])
        except Exception as exc:  # noqa: BLE001 — topology is optional input
            logger.debug("Topology unavailable for blast radius: %s", exc)
            return []

    async def _known_accounts(self) -> List[str]:
        """Every account id / tenant / tenancy this platform manages.

        The boundary definition for "external". Read from the account table
        rather than inferred, because an error in the permissive direction
        silently reclassifies real external trust as internal.
        """
        rows = list((await self.db.execute(
            select(CloudAccount.provider_account_id)
        )).scalars().all())
        return [str(r) for r in rows if r]

    async def _persist_findings(
        self, account_id: uuid.UUID, emitted: Sequence[Any], *, complete: bool,
    ) -> Dict[str, Any]:
        """Hand CIEM findings to the Security Center's own repository.

        `rule_scope` is not optional here. `persist_findings` reconciles what it
        is given against what is stored and RESOLVES anything it does not see;
        called without a scope it would close every storage, network and
        encryption finding on the account, because this analyser produces none
        of them. Scoping it to the CIEM rule ids makes the identity analyser
        able to resolve its own findings and nobody else's.

        `complete` gates resolution on the same rule the Security Center uses:
        an analysis that could not evaluate every principal must not conclude
        that a finding is gone — the identity might simply not have been read.
        """
        from app.repository.security_repo import SecurityRepository
        from app.security.model import ASSESS_COMPLETE, ASSESS_PARTIAL

        try:
            repo = SecurityRepository(self.db)
            stats = await repo.persist_findings(
                account_id=account_id,
                findings=list(emitted),
                outcome=ASSESS_COMPLETE if complete else ASSESS_PARTIAL,
                rule_scope=list(ciem_findings.RULE_IDS),
            )
            return {"emitted": len(emitted),
                    "new": stats.get("new", 0),
                    "updated": stats.get("updated", 0),
                    "resolved": stats.get("resolved", 0),
                    "reopened": stats.get("reopened", 0)}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Could not persist CIEM findings for %s: %s",
                             account_id, exc)
            return {"emitted": len(emitted), "error": str(exc)[:500]}


def _parse(value: Any) -> Optional[datetime]:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
