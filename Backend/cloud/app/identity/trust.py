"""Cross-account and cross-tenant trust: who outside the boundary can get in.

Builds the §13 trust map and the §14 external-principal inventory from actual
provider configuration — AWS role trust policies, Azure foreign/guest
principals, OCI federation and cross-tenancy policy statements.

**External is a fact; dangerous is a judgement.** §14 is explicit that an
external principal must not be classified as malicious on sight, and most are
legitimate: a monitoring vendor, a CI provider, a partner tenant. So this
module reports the relationship and the risk FACTORS, and leaves severity to
the finding rules, which weigh the factors together:

*   Does the trust require an ExternalId (AWS) or restrict the tenant (Azure)?
    A third-party role with no ExternalId is the confused-deputy shape.
*   Does it require MFA?
*   Is the principal a wildcard (`"AWS": "*"`)? That is not external access,
    it is public access, and it gets its own value.
*   What does the target let the holder DO? A read-only role trusted by a
    vendor is a different finding from Administrator trusted by the same vendor.

**Our own account ids are the boundary definition.** A principal is internal
when its account/tenant matches one this platform holds credentials for. That
set is passed in rather than inferred, because getting it wrong in the
permissive direction would silently reclassify every real external trust as
internal — the failure mode that makes the whole feature useless.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from app.identity.model import (
    AWS, AZURE, EXTERNAL_ANONYMOUS, EXTERNAL_NO, EXTERNAL_UNKNOWN, EXTERNAL_YES, OCI,
    PRIV_ADMIN, PRIV_PRIVILEGED, normalize_provider,
)

TRUST_ASSUME_ROLE = "ASSUME_ROLE"
TRUST_FEDERATION = "FEDERATION"
TRUST_GUEST = "GUEST"
TRUST_CROSS_TENANCY = "CROSS_TENANCY"
TRUST_SERVICE = "SERVICE"

TRUST_KIND_LABEL = {
    TRUST_ASSUME_ROLE: "Role assumption",
    TRUST_FEDERATION: "Federated identity provider",
    TRUST_GUEST: "Guest / external user",
    TRUST_CROSS_TENANCY: "Cross-tenancy policy",
    TRUST_SERVICE: "Cloud service principal",
}

_AWS_ACCOUNT_RE = re.compile(r"arn:aws[a-z\-]*:iam::(\d{12}):")
_AWS_BARE_ACCOUNT_RE = re.compile(r"^(\d{12})$")
_AZURE_GUID_RE = re.compile(
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", re.IGNORECASE)

# AWS service principals. Not external in the sense that matters — they are
# AWS itself — but they ARE a trust relationship worth showing, so they get
# their own kind rather than being dropped or called external.
_AWS_SERVICE_SUFFIX = ".amazonaws.com"


@dataclass
class TrustEdge:
    """One "this outside principal can reach this inside target" relationship."""

    provider: str
    target_key: str
    source_principal: str
    trust_kind: str
    target_name: Optional[str] = None
    source_account: Optional[str] = None
    source_type: Optional[str] = None
    external: str = EXTERNAL_UNKNOWN
    conditions: Optional[Dict[str, Any]] = None
    has_external_id: Optional[bool] = None
    has_mfa_condition: Optional[bool] = None
    target_privilege: Optional[str] = None
    risk_factors: List[Dict[str, str]] = field(default_factory=list)
    evidence: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "provider": self.provider,
            "target_key": self.target_key,
            "target_name": self.target_name,
            "source_principal": self.source_principal,
            "source_account": self.source_account,
            "source_type": self.source_type,
            "external": self.external,
            "trust_kind": self.trust_kind,
            "trust_kind_label": TRUST_KIND_LABEL.get(self.trust_kind, self.trust_kind),
            "conditions": self.conditions,
            "has_external_id": self.has_external_id,
            "has_mfa_condition": self.has_mfa_condition,
            "target_privilege": self.target_privilege,
            "risk_factors": self.risk_factors,
            "evidence": self.evidence,
        }


def classify_principal(
    provider: str,
    principal: str,
    *,
    known_accounts: Set[str],
) -> Tuple[str, Optional[str], str, Optional[str]]:
    """`(external_state, source_account, trust_kind, source_type)` for a principal.

    `known_accounts` is the set of account ids, subscription ids, tenant ids and
    tenancy OCIDs this platform manages. Membership of that set is the ONLY
    thing that makes a principal internal — not a name, not a prefix.
    """
    prov = normalize_provider(provider)
    raw = (principal or "").strip()
    if not raw:
        return EXTERNAL_UNKNOWN, None, TRUST_ASSUME_ROLE, None

    if raw == "*":
        return EXTERNAL_ANONYMOUS, None, TRUST_ASSUME_ROLE, "wildcard"

    if prov == AWS:
        if raw.lower().startswith("service:"):
            service = raw.split(":", 1)[1]
            return EXTERNAL_NO, None, TRUST_SERVICE, service
        if raw.lower().startswith("federated:"):
            fed = raw.split(":", 1)[1]
            return EXTERNAL_YES, None, TRUST_FEDERATION, fed
        if raw.endswith(_AWS_SERVICE_SUFFIX):
            return EXTERNAL_NO, None, TRUST_SERVICE, raw
        match = _AWS_ACCOUNT_RE.search(raw) or _AWS_BARE_ACCOUNT_RE.match(raw)
        if match:
            account = match.group(1)
            state = EXTERNAL_NO if account in known_accounts else EXTERNAL_YES
            return state, account, TRUST_ASSUME_ROLE, "aws_account"
        if raw.startswith("arn:"):
            return EXTERNAL_UNKNOWN, None, TRUST_ASSUME_ROLE, "arn"
        return EXTERNAL_UNKNOWN, None, TRUST_ASSUME_ROLE, None

    if prov == AZURE:
        guid = _AZURE_GUID_RE.search(raw)
        tenant = guid.group(1).lower() if guid else None
        if tenant and tenant in {a.lower() for a in known_accounts}:
            return EXTERNAL_NO, tenant, TRUST_GUEST, "entra_tenant"
        if "#ext#" in raw.lower() or raw.lower().startswith("guest:"):
            return EXTERNAL_YES, tenant, TRUST_GUEST, "guest_user"
        if tenant:
            return EXTERNAL_YES, tenant, TRUST_GUEST, "entra_tenant"
        return EXTERNAL_UNKNOWN, None, TRUST_GUEST, None

    if prov == OCI:
        if raw.lower().startswith("ocid1.tenancy."):
            state = EXTERNAL_NO if raw in known_accounts else EXTERNAL_YES
            return state, raw, TRUST_CROSS_TENANCY, "tenancy"
        if raw.lower().startswith("ocid1.saml") or "identityprovider" in raw.lower():
            return EXTERNAL_YES, None, TRUST_FEDERATION, "identity_provider"
        return EXTERNAL_UNKNOWN, None, TRUST_CROSS_TENANCY, None

    return EXTERNAL_UNKNOWN, None, TRUST_ASSUME_ROLE, None


def risk_factors(edge: TrustEdge) -> List[Dict[str, str]]:
    """What makes this relationship worth a second look — stated, not scored.

    Every entry is a fact about the configuration with the reason it matters.
    None of them says the trust is wrong; together they are what a reviewer
    needs to decide whether it is.
    """
    out: List[Dict[str, str]] = []

    if edge.external == EXTERNAL_ANONYMOUS:
        out.append({
            "factor": "ANY_PRINCIPAL",
            "detail": "The trust policy names a wildcard principal, so any account can "
                      "assume this role, not merely a known partner.",
        })

    if edge.external == EXTERNAL_YES and edge.trust_kind == TRUST_ASSUME_ROLE:
        if edge.has_external_id is False:
            out.append({
                "factor": "NO_EXTERNAL_ID",
                "detail": "An external account can assume this role without presenting "
                          "an ExternalId. If this is a third-party integration, that is "
                          "the confused-deputy shape AWS documents.",
            })
        if edge.has_mfa_condition is False:
            out.append({
                "factor": "NO_MFA_CONDITION",
                "detail": "The trust does not require multi-factor authentication.",
            })

    if edge.target_privilege in (PRIV_ADMIN, PRIV_PRIVILEGED):
        out.append({
            "factor": "PRIVILEGED_TARGET",
            "detail": f"The target holds {edge.target_privilege.lower()} permissions, so "
                      "whoever takes this trust inherits them.",
        })

    if edge.external == EXTERNAL_UNKNOWN:
        out.append({
            "factor": "UNRESOLVED_PRINCIPAL",
            "detail": "The principal could not be resolved to an account or tenant, so "
                      "whether it is external is unknown. It is shown rather than "
                      "assumed internal.",
        })
    return out


def build_edges(
    provider: str,
    *,
    target_key: str,
    target_name: Optional[str],
    principals: Sequence[Dict[str, Any]],
    known_accounts: Iterable[str],
    target_privilege: Optional[str] = None,
) -> List[TrustEdge]:
    """Turn parsed trust principals into classified, risk-annotated edges."""
    known = {str(a) for a in (known_accounts or []) if a}
    edges: List[TrustEdge] = []
    for entry in principals or []:
        principal = str(entry.get("principal") or "").strip()
        if not principal:
            continue
        external, account, kind, source_type = classify_principal(
            provider, principal, known_accounts=known)
        edge = TrustEdge(
            provider=normalize_provider(provider) or provider,
            target_key=target_key,
            target_name=target_name,
            source_principal=principal,
            source_account=account,
            source_type=source_type,
            external=external,
            trust_kind=kind,
            conditions=entry.get("conditions"),
            has_external_id=entry.get("has_external_id"),
            has_mfa_condition=entry.get("has_mfa_condition"),
            target_privilege=target_privilege,
            evidence={"statement_id": entry.get("statement_id")},
        )
        edge.risk_factors = risk_factors(edge)
        edges.append(edge)
    return edges


def oci_cross_tenancy_edges(
    statements: Sequence[Any],
    *,
    known_accounts: Iterable[str],
    tenancy_ocid: Optional[str] = None,
) -> List[TrustEdge]:
    """Cross-tenancy trust from OCI `endorse` / `admit` / `define` statements.

    `oci_eval` deliberately refuses to evaluate these as in-tenancy grants —
    they are not — but they ARE the tenancy's external trust configuration, and
    this is where they are read.
    """
    known = {str(a) for a in (known_accounts or []) if a}
    out: List[TrustEdge] = []
    for stmt in statements or []:
        raw = getattr(stmt, "raw", "") or ""
        lowered = raw.lower().strip()
        if not lowered.startswith(("endorse ", "admit ", "define ")):
            continue
        tenancy_match = re.search(r"ocid1\.tenancy\.[a-z0-9\.\-]+", raw, re.IGNORECASE)
        source = tenancy_match.group(0) if tenancy_match else raw
        external = EXTERNAL_NO if source in known else (
            EXTERNAL_YES if tenancy_match else EXTERNAL_UNKNOWN)
        edge = TrustEdge(
            provider=OCI,
            target_key=tenancy_ocid or "tenancy",
            target_name=None,
            source_principal=source,
            source_account=source if tenancy_match else None,
            source_type="tenancy" if tenancy_match else None,
            external=external,
            trust_kind=TRUST_CROSS_TENANCY,
            evidence={"statement": raw,
                      "keyword": lowered.split(None, 1)[0]},
        )
        edge.risk_factors = risk_factors(edge)
        out.append(edge)
    return out


def summarize(edges: Sequence[TrustEdge]) -> Dict[str, Any]:
    """Counts for the dashboard, split so no number conflates two ideas."""
    external = [e for e in edges if e.external == EXTERNAL_YES]
    anonymous = [e for e in edges if e.external == EXTERNAL_ANONYMOUS]
    unknown = [e for e in edges if e.external == EXTERNAL_UNKNOWN]
    privileged_external = [e for e in external + anonymous
                           if e.target_privilege in (PRIV_ADMIN, PRIV_PRIVILEGED)]
    accounts = sorted({e.source_account for e in external if e.source_account})
    return {
        "total": len(edges),
        "external": len(external),
        "anonymous": len(anonymous),
        "unresolved": len(unknown),
        "service": len([e for e in edges if e.trust_kind == TRUST_SERVICE]),
        "privileged_external": len(privileged_external),
        "external_accounts": accounts,
        "external_account_count": len(accounts),
        "without_external_id": len([e for e in external
                                    if e.trust_kind == "ASSUME_ROLE"
                                    and e.has_external_id is False]),
    }


def graph(edges: Sequence[TrustEdge]) -> Dict[str, Any]:
    """Nodes and links for the §13 trust map. Every node carries its own id so
    the UI can make it clickable without inventing one."""
    nodes: Dict[str, Dict[str, Any]] = {}
    links: List[Dict[str, Any]] = []

    for edge in edges:
        source_id = f"principal:{edge.source_principal}"
        target_id = f"target:{edge.target_key}"
        nodes.setdefault(source_id, {
            "id": source_id,
            "kind": "external_principal" if edge.external in (EXTERNAL_YES,
                                                              EXTERNAL_ANONYMOUS)
                    else "principal",
            "label": edge.source_principal,
            "account": edge.source_account,
            "external": edge.external,
            "source_type": edge.source_type,
        })
        nodes.setdefault(target_id, {
            "id": target_id,
            "kind": "target",
            "label": edge.target_name or edge.target_key,
            "key": edge.target_key,
            "privilege": edge.target_privilege,
        })
        links.append({
            "source": source_id,
            "target": target_id,
            "kind": edge.trust_kind,
            "label": TRUST_KIND_LABEL.get(edge.trust_kind, edge.trust_kind),
            "external": edge.external,
            "risk_factors": [f["factor"] for f in edge.risk_factors],
            "has_external_id": edge.has_external_id,
            "has_mfa_condition": edge.has_mfa_condition,
        })
    return {"nodes": list(nodes.values()), "links": links}
