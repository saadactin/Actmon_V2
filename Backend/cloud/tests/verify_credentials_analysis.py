"""Certificates, secrets and keys: parsing, analysis, engine integration.

No database, no network. The properties pinned here, each because getting it
wrong would put a false statement in front of an operator:

* **Expired and expiring are different claims.** An expired certificate is a
  confirmed failure (HIGH, or LOW when the provider says it is unused); one
  with 25 days left is valid and only operational (LOW/MEDIUM). Treating the
  second as a control failure would be false.
* **Managed renewal is still checked.** A provider-managed certificate inside
  the window means renewal did not happen; a stuck renewal is escalated.
* **A store we could not read is never a pass.** Its rules carry NOT_SCANNED,
  and one grouped gap finding names every unread store.
* **Credential gaps do not withhold the score.** The dimension is reported but
  kept out of the coverage average that gates the score.
* **Classifiers keep the three Key Vault refusals apart** (role, access policy,
  firewall) because each needs a different fix.
"""
import base64
import pathlib
import sys
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import logging  # noqa: E402

logging.disable(logging.CRITICAL)

from app.models.credential_inventory import (  # noqa: E402
    COLLECT_BLOCKED, COLLECT_NEVER_RUN, COLLECT_NOT_SUPPORTED, COLLECT_OK,
    COLLECT_PERMISSION_DENIED, COLLECT_UNAVAILABLE, KIND_CERTIFICATE, KIND_KEY,
    KIND_SECRET,
)
from app.providers.credential_common import (  # noqa: E402
    as_utc, parse_public_certificate, scope_result,
)
from app.security import controls as ctl  # noqa: E402
from app.security import credentials as cx  # noqa: E402
from app.security import engine  # noqa: E402
from app.security.model import (  # noqa: E402
    CAT_ENCRYPTION, COV_CREDENTIALS, HIGH, LOW, MEDIUM, NOT_APPLICABLE, NOT_SCANNED,
    SAFE, VULNERABLE,
)

ok, fail = [], []
NOW = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


def obj(kind=KIND_CERTIFICATE, *, days=None, source="aws:acm", scope="ap-south-1",
        name=None, **over):
    key = over.pop("object_key", None) or f"arn:test:{uuid.uuid4().hex[:8]}"
    return {
        "kind": kind, "object_key": key, "name": name or key.split(":")[-1],
        "source": source, "source_scope": scope, "region": scope,
        "expires_at": (NOW + timedelta(days=days)) if days is not None else None,
        "enabled": over.pop("enabled", True), "in_use": over.pop("in_use", None),
        "managed_renewal": over.pop("managed_renewal", None),
        "renewal_status": over.pop("renewal_status", None),
        "container_name": over.pop("container_name", None),
        "container_key": over.pop("container_key", None),
        "rotation_enabled": over.pop("rotation_enabled", None),
        "rotation_interval_days": over.pop("rotation_interval_days", None),
        "last_rotated_at": over.pop("last_rotated_at", None),
        "next_rotation_at": over.pop("next_rotation_at", None),
        "details": over.pop("details", {}),
        **over,
    }


def src(source="aws:acm", scope="ap-south-1", status=COLLECT_OK, **over):
    return {"source": source, "scope": scope, "scope_label": over.pop("label", scope),
            "status": status, "missing_permission": over.pop("perm", None),
            "remediation": over.pop("fix", None), "error_detail": over.pop("err", None),
            "container": over.pop("container", None), "last_success_at": None, **over}


def analyse(objects, sources, provider="AWS"):
    return cx.analyse(provider=provider, objects=objects, sources=sources, now=NOW)


def rules_of(analysis):
    return sorted(r.rule_id for r in analysis.risks)


def risk(analysis, rule_id):
    return next((r for r in analysis.risks if r.rule_id == rule_id), None)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== A. Public certificate parsing (PEM, DER, PKCS#7, base64, chains) ===")
# ═════════════════════════════════════════════════════════════════════════════
from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402
from cryptography.hazmat.primitives.serialization import pkcs7  # noqa: E402
from cryptography.x509.oid import NameOID  # noqa: E402


def make_cert(cn, issuer_cert=None, issuer_key=None, days=90, sans=()):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    issuer = issuer_cert.subject if issuer_cert else subject
    builder = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer)
               .public_key(key.public_key()).serial_number(x509.random_serial_number())
               .not_valid_before(NOW - timedelta(days=1))
               .not_valid_after(NOW + timedelta(days=days)))
    if sans:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.DNSName(s) for s in sans]), critical=False)
    cert = builder.sign(issuer_key or key, hashes.SHA256())
    return cert, key


ca, ca_key = make_cert("Test Root CA", days=3650)
leaf, _ = make_cert("ebs.example.test", ca, ca_key, days=12,
                    sans=("ebs.example.test", "www.example.test"))
pem = leaf.public_bytes(serialization.Encoding.PEM).decode()
der = leaf.public_bytes(serialization.Encoding.DER)
p7_der = pkcs7.serialize_certificates([ca, leaf], serialization.Encoding.DER)

parsed = parse_public_certificate(pem)
check("PEM parses", parsed is not None)
eq("...subject is the common name", parsed and parsed["subject"], "ebs.example.test")
eq("...issuer is the CA's name", parsed and parsed["issuer"], "Test Root CA")
check("...expiry is the certificate's not-after, in UTC",
      parsed and abs((parsed["not_after"] - (NOW + timedelta(days=12))).total_seconds()) < 2,
      str(parsed and parsed["not_after"]))
eq("...SANs are read", parsed and parsed["dns_names"], ["ebs.example.test", "www.example.test"])
check("...key algorithm names RSA and size", parsed and "2048" in (parsed["key_algorithm"] or ""),
      str(parsed and parsed["key_algorithm"]))
eq("DER parses to the same expiry", (parse_public_certificate(der) or {}).get("not_after"),
   parsed["not_after"])
p7 = parse_public_certificate(p7_der)
eq("PKCS#7 with a chain returns the LEAF, not the CA", p7 and p7["subject"],
   "ebs.example.test")
b64 = parse_public_certificate(base64.b64encode(p7_der).decode())
eq("base64 PKCS#7 (Azure Application Gateway's shape) parses", b64 and b64["subject"],
   "ebs.example.test")
eq("garbage is None, never a guessed date", parse_public_certificate("not a certificate"),
   None)
eq("empty is None", parse_public_certificate(""), None)

# openssl's PKCS#12 export writes "Bag Attributes" before each PEM block. 17 of
# the 38 certificates on KOEL's OCI load balancers look like this, and every one
# was dropped because the parser demanded text that STARTS with -----BEGIN.
BAG = ("Bag Attributes\n    localKeyID: 01 00 00 00\n    friendlyName: Koel.co.in\n"
       "subject=C=IN, ST=Maharashtra, L=Pune, O=Example, CN=ebs.example.test\n"
       "issuer=CN=Test Root CA\n")
ca_pem = ca.public_bytes(serialization.Encoding.PEM).decode()
eq("PEM after an openssl 'Bag Attributes' preamble parses (it was silently dropped)",
   (parse_public_certificate(BAG + pem) or {}).get("not_after"), parsed["not_after"])
eq("...and with Windows line endings", (parse_public_certificate(
    (BAG + pem).replace("\n", "\r\n")) or {}).get("not_after"), parsed["not_after"])
eq("...and when handed over as bytes", (parse_public_certificate((BAG + pem).encode()) or {})
   .get("not_after"), parsed["not_after"])
eq("a chain where EVERY block has its own preamble still returns the leaf",
   (parse_public_certificate(BAG + ca_pem + BAG + pem) or {}).get("subject"), "ebs.example.test")
eq("a preamble with no certificate after it is still None, not a guess",
   parse_public_certificate(BAG), None)

from app.providers.credential_common import unreadable_note  # noqa: E402
eq("nothing unreadable, no note", unreadable_note([]), None)
check("an unreadable certificate is named on its store",
      "lb1/broken" in (unreadable_note(["lb1/broken"]) or "")
      and "expiry is unknown" in (unreadable_note(["lb1/broken"]) or ""))
check("...and a long list is cut, saying how many more",
      "and 5 more" in (unreadable_note([f"c{i}" for i in range(25)]) or ""))

# The OCI load-balancer collector itself, driven with a stand-in client: one
# plain PEM, one after a preamble, one that will not parse at all.
import types as _types  # noqa: E402

from app.providers.oci import oci_credentials as _ocic  # noqa: E402


class _LbClient:
    def list_certificates(self, ocid, **_):
        return _types.SimpleNamespace(headers={}, data=[
            _types.SimpleNamespace(certificate_name="plain", public_certificate=pem),
            _types.SimpleNamespace(certificate_name="pfx-export", public_certificate=BAG + pem),
            _types.SimpleNamespace(certificate_name="broken",
                                   public_certificate="-----BEGIN CERTIFICATE-----\nnope\n"
                                                      "-----END CERTIFICATE-----"),
        ])


_real_client = _ocic._client
_ocic._client = lambda config, cls, region: _LbClient()
try:
    res = _ocic._lb_region({}, "ap-mumbai-1", [{
        "ocid": "ocid1.loadbalancer.x", "name": "lb1", "region": "ap-mumbai-1",
        "certificate_names_in_use": ["pfx-export"], "listeners_known": True}])
finally:
    _ocic._client = _real_client
eq("the collector keeps BOTH parseable certificates, preamble included",
   sorted(i["name"] for i in res["items"]), ["pfx-export", "plain"])
eq("...reads listener usage for the preamble one", [i["in_use"] for i in res["items"]
                                                    if i["name"] == "pfx-export"], [True])
eq("...counts the one that would not parse on the store", (res.get("container") or {})
   .get("unreadable_certificates"), 1)
check("...and names it in the store's detail instead of dropping it",
      "lb1/broken" in (res.get("error_detail") or ""), res.get("error_detail"))
eq("...while the store itself was still read in full", res["status"], "Collected")

# Usage read LIVE from the balancer's listeners and backend sets. Before this,
# usage came only from the last discovery's stored listener map, and inventory
# scanned before that map existed left every KOEL certificate "Unknown".
_SSL = lambda name: _types.SimpleNamespace(certificate_name=name)  # noqa: E731


class _LbClientWithListeners(_LbClient):
    def get_load_balancer(self, ocid, **_):
        return _types.SimpleNamespace(data=_types.SimpleNamespace(
            listeners={
                "prd-listener": _types.SimpleNamespace(port=443, ssl_configuration=_SSL("plain")),
                "http-listener": _types.SimpleNamespace(port=80, ssl_configuration=None),
            },
            backend_sets={"ebs-backends": _types.SimpleNamespace(ssl_configuration=_SSL("plain"))},
        ))


class _LbClientListenersDown(_LbClient):
    def get_load_balancer(self, ocid, **_):
        raise RuntimeError("503 from the load balancer API")


def _run_lb(client, *, listeners_known=False, stored=()):
    _ocic._client = lambda config, cls, region: client
    try:
        return _ocic._lb_region({}, "ap-mumbai-1", [{
            "ocid": "ocid1.loadbalancer.x", "name": "lb1", "region": "ap-mumbai-1",
            "certificate_names_in_use": list(stored), "listeners_known": listeners_known}])
    finally:
        _ocic._client = _real_client


by_name = {i["name"]: i for i in _run_lb(_LbClientWithListeners())["items"]}
eq("a certificate on a listener is in use, read live",
   (by_name["plain"]["in_use"], by_name["plain"]["details"]["usage_source"]), (True, "live"))
eq("...and says exactly what uses it: listener with its port, and backend TLS",
   by_name["plain"]["in_use_by"],
   ["Listener prd-listener (port 443)", "Backend set ebs-backends (TLS to backends)"])
eq("a certificate no listener or backend set names is NOT in use (the listing was complete)",
   (by_name["pfx-export"]["in_use"], by_name["pfx-export"]["in_use_by"]), (False, []))
by_name = {i["name"]: i for i in _run_lb(_LbClientListenersDown())["items"]}
eq("listeners unreadable and nothing stored: usage is UNKNOWN, never 'not in use'",
   by_name["plain"]["in_use"], None)
check("...and the certificates themselves are still listed", len(by_name) == 2)
by_name = {i["name"]: i for i in _run_lb(_LbClientListenersDown(), listeners_known=True,
                                        stored=["pfx-export"])["items"]}
eq("listeners unreadable but a discovery stored them: that map is used, and says so",
   (by_name["pfx-export"]["in_use"], by_name["plain"]["in_use"],
    by_name["plain"]["details"]["usage_source"]), (True, False, "last discovery"))

# Azure App Service: bindings from every web app AND slot in the certificate's
# resource group — the only apps that can bind it.
from app.providers.azure import azure_credentials as _azc  # noqa: E402
from app.providers.azure import azure_rest as _azrest  # noqa: E402

_SUB = "sub-1"
_CERTS = [
    {"id": f"/subscriptions/{_SUB}/resourceGroups/RG-Web/providers/Microsoft.Web/certificates/bound",
     "name": "bound", "location": "Central India",
     "properties": {"thumbprint": "aa11", "expirationDate": "2025-08-30T00:00:00Z"}},
    {"id": f"/subscriptions/{_SUB}/resourceGroups/RG-Web/providers/Microsoft.Web/certificates/idle",
     "name": "idle", "location": "Central India",
     "properties": {"thumbprint": "BB22", "expirationDate": "2025-08-30T00:00:00Z"}},
    {"id": f"/subscriptions/{_SUB}/resourceGroups/RG-Locked/providers/Microsoft.Web/certificates/hidden",
     "name": "hidden", "location": "Central India",
     "properties": {"thumbprint": "CC33", "expirationDate": "2025-08-30T00:00:00Z"}},
]
_SITES = [
    {"name": "tor-api", "properties": {"hostNameSslStates": [
        {"name": "api.example.com", "sslState": "SniEnabled", "thumbprint": "AA11"},
        {"name": "tor-api.azurewebsites.net", "sslState": "Disabled", "thumbprint": None}]}},
    {"name": "tor-api/staging", "properties": {"hostNameSslStates": [
        {"name": "staging.example.com", "sslState": "SniEnabled", "thumbprint": "aa11"},
        {"name": "old.example.com", "sslState": "Disabled", "thumbprint": "BB22"}]}},
]
_asked = []


def _fake_get_all(url, token, params=None, **_):
    _asked.append((url, dict(params or {})))
    if url.endswith("/providers/Microsoft.Web/certificates"):
        return _CERTS
    if "/resourceGroups/RG-Web/" in url:
        return _SITES
    raise _azrest.AzureRestError(403, "AuthorizationFailed", "no read on this group")


_real_get_all = _azrest.get_all
_azrest.get_all = _fake_get_all
try:
    res = _azc._app_service(_SUB, "token")
finally:
    _azrest.get_all = _real_get_all
by_name = {i["name"]: i for i in res["items"]}
eq("an App Service certificate bound by thumbprint (case-insensitive) is in use",
   by_name["bound"]["in_use"], True)
eq("...naming every app and slot hostname that serves it",
   by_name["bound"]["in_use_by"], ["tor-api: api.example.com", "tor-api/staging: staging.example.com"])
eq("a binding switched to Disabled does not count as use",
   (by_name["idle"]["in_use"], by_name["idle"]["in_use_by"]), (False, []))
eq("a resource group whose apps could not be read leaves usage UNKNOWN",
   by_name["hidden"]["in_use"], None)
check("slots were asked for, not just production apps",
      any(p.get("includeSlots") == "true" for u, p in _asked if u.endswith("/sites")))
eq("...and the resource group is kept for the fix-it commands",
   by_name["bound"]["details"]["resource_group"], "RG-Web")

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== B. Scope results and timestamps ===")
# ═════════════════════════════════════════════════════════════════════════════
failed = scope_result("aws:acm", "eu-west-1", COLLECT_PERMISSION_DENIED,
                      items=[{"object_key": "x"}], error_detail="AccessDenied " * 500)
eq("a failed scope carries NO items, even if a collector passed some", failed["items"], [])
check("...and its error detail is bounded", len(failed["error_detail"]) <= 2000)
good = scope_result("aws:acm", "eu-west-1", COLLECT_OK, items=[{"object_key": "x"}])
eq("a collected scope keeps its items", len(good["items"]), 1)
eq("naive datetimes are UTC", as_utc(datetime(2026, 1, 1)).tzinfo, timezone.utc)
eq("epoch seconds (Key Vault 'exp') convert", as_utc(0), datetime(1970, 1, 1, tzinfo=timezone.utc))
eq("ISO with Z converts", as_utc("2026-10-01T00:00:00Z"),
   datetime(2026, 10, 1, tzinfo=timezone.utc))
eq("unparseable is None", as_utc("soon"), None)
eq("absent is None", as_utc(None), None)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== C. Certificates: expired vs expiring, use and renewal ===")
# ═════════════════════════════════════════════════════════════════════════════
read = [src()]
a = analyse([obj(days=-3, in_use=True)], read)
r = risk(a, cx.CERT_EXPIRED)
check("an expired certificate in use -> CERT_EXPIRED", r is not None, str(rules_of(a)))
eq("...at HIGH", r and r.severity, HIGH)
a = analyse([obj(days=-3, in_use=False)], read)
eq("expired but reported unused -> LOW (delete it; not an outage)",
   risk(a, cx.CERT_EXPIRED).severity, LOW)
a = analyse([obj(days=-3, in_use=None)], read)
eq("expired, use not reported -> HIGH (unknown is not 'unused')",
   risk(a, cx.CERT_EXPIRED).severity, HIGH)
a = analyse([obj(days=5)], read)
r = risk(a, cx.CERT_EXPIRING_SOON)
check("5 days left -> CERT_EXPIRING_SOON", r is not None, str(rules_of(a)))
eq("...at MEDIUM (inside the urgent window)", r and r.severity, MEDIUM)
eq("...and NOT CERT_EXPIRED: a valid certificate is not a failure",
   risk(a, cx.CERT_EXPIRED), None)
a = analyse([obj(days=20)], read)
eq("20 days left -> LOW", risk(a, cx.CERT_EXPIRING_SOON).severity, LOW)
a = analyse([obj(days=45)], read)
eq("45 days left -> no finding", rules_of(a), [])
eq("...but the rules ran and passed it", a.rule_stats.get(cx.CERT_EXPIRING_SOON),
   {SAFE: 1})
a = analyse([obj(days=20, managed_renewal=True, renewal_status="PENDING_VALIDATION")], read)
r = risk(a, cx.CERT_EXPIRING_SOON)
eq("a managed renewal stuck in PENDING_VALIDATION is escalated to MEDIUM",
   r and r.severity, MEDIUM)
check("...and says renewal will not complete without action",
      r and "will not complete" in r.detail, r and r.detail)
a = analyse([obj(days=20, managed_renewal=True, renewal_status="PENDING_AUTO_RENEWAL")], read)
r = risk(a, cx.CERT_EXPIRING_SOON)
check("a managed renewal in progress stays LOW and names the provider's status",
      r and r.severity == LOW and "PENDING_AUTO_RENEWAL" in r.detail, r and r.detail)
a = analyse([obj(days=-10, enabled=False)], read)
eq("a disabled object is ignored", rules_of(a), [])
a = analyse([obj(days=-1, source="aws:iam-server-certificates", scope="global")],
            [src("aws:iam-server-certificates", "global")])
eq("an expired IAM server certificate gets its own CIS-cited rule",
   rules_of(a), [cx.AWS_IAM_SERVER_CERT_EXPIRED])

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== D. Secrets and keys ===")
# ═════════════════════════════════════════════════════════════════════════════
kv_rbac = {"vault_id": "/subs/x/vaults/kv-rbac", "vault_name": "kv-rbac",
           "rbac_authorization": True, "purge_protection": True, "soft_delete": True}
kv_pol = {"vault_id": "/subs/x/vaults/kv-pol", "vault_name": "kv-pol",
          "rbac_authorization": False, "purge_protection": None, "soft_delete": True}
kv_sources = [
    src("azure:keyvault:secrets", kv_rbac["vault_id"], container=kv_rbac),
    src("azure:keyvault:keys", kv_rbac["vault_id"], container=kv_rbac),
    src("azure:keyvault:secrets", kv_pol["vault_id"], container=kv_pol),
    src("azure:keyvault:keys", kv_pol["vault_id"], container=kv_pol),
]


def kv(kind, vault, days=None, **over):
    return obj(kind, days=days, source=f"azure:keyvault:{'secrets' if kind == KIND_SECRET else 'keys'}",
               scope=vault["vault_id"], container_key=vault["vault_id"],
               container_name=vault["vault_name"], **over)


a = analyse([kv(KIND_SECRET, kv_rbac, days=-2)], kv_sources, "AZURE")
eq("an expired, enabled secret -> SECRET_EXPIRED at MEDIUM",
   risk(a, cx.SECRET_EXPIRED) and risk(a, cx.SECRET_EXPIRED).severity, MEDIUM)
a = analyse([kv(KIND_KEY, kv_rbac, days=10)], kv_sources, "AZURE")
eq("a key expiring in 10 days -> SECRET_EXPIRING_SOON at LOW",
   risk(a, cx.SECRET_EXPIRING_SOON) and risk(a, cx.SECRET_EXPIRING_SOON).severity, LOW)
a = analyse([kv(KIND_SECRET, kv_rbac), kv(KIND_SECRET, kv_rbac), kv(KIND_SECRET, kv_pol)],
            kv_sources, "AZURE")
r_rbac = risk(a, cx.AZURE_KEYVAULT_RBAC_SECRET_NO_EXPIRY)
r_pol = risk(a, cx.AZURE_KEYVAULT_POLICY_SECRET_NO_EXPIRY)
check("secrets with no expiry in an RBAC vault -> the RBAC rule (CIS Azure 8.3.3)",
      r_rbac is not None, str(rules_of(a)))
eq("...ONE finding per vault, counting its secrets", r_rbac and r_rbac.affected_count, 2)
check("secrets in an access-policy vault -> the access-policy rule (CIS Azure 8.3.4)",
      r_pol is not None and r_pol.affected_count == 1, str(rules_of(a)))
a = analyse([kv(KIND_KEY, kv_pol)], kv_sources, "AZURE")
check("a key with no expiry in an access-policy vault -> 8.3.2's rule",
      risk(a, cx.AZURE_KEYVAULT_POLICY_KEY_NO_EXPIRY) is not None, str(rules_of(a)))
eq("rbac None is filed under access policies (the legacy default)",
   cx.no_expiry_rule(KIND_KEY, None), cx.AZURE_KEYVAULT_POLICY_KEY_NO_EXPIRY)
r = risk(a, cx.AZURE_KEYVAULT_NOT_RECOVERABLE)
check("a vault without purge protection -> AZURE_KEYVAULT_NOT_RECOVERABLE",
      r is not None and r.subject_key == kv_pol["vault_id"], str(rules_of(a)))
check("...and the vault WITH purge protection is not flagged",
      all(x.subject_key != kv_rbac["vault_id"] for x in a.risks
          if x.rule_id == cx.AZURE_KEYVAULT_NOT_RECOVERABLE))

sm = [src("aws:secretsmanager", "ap-south-1")]
a = analyse([obj(KIND_SECRET, source="aws:secretsmanager", rotation_enabled=False)], sm)
eq("a Secrets Manager secret with rotation off -> LOW finding",
   risk(a, cx.AWS_SECRETSMANAGER_ROTATION_DISABLED) and
   risk(a, cx.AWS_SECRETSMANAGER_ROTATION_DISABLED).severity, LOW)
a = analyse([obj(KIND_SECRET, source="aws:secretsmanager", rotation_enabled=False,
                 details={"owning_service": "rds"})], sm)
eq("...unless another AWS service owns (and rotates) it", rules_of(a), [])
a = analyse([obj(KIND_SECRET, source="aws:secretsmanager", rotation_enabled=True,
                 rotation_interval_days=30, next_rotation_at=NOW - timedelta(days=5))], sm)
check("rotation enabled but 5 days past due -> SECRET_ROTATION_OVERDUE",
      risk(a, cx.SECRET_ROTATION_OVERDUE) is not None, str(rules_of(a)))
a = analyse([obj(KIND_SECRET, source="aws:secretsmanager", rotation_enabled=True,
                 rotation_interval_days=30, last_rotated_at=NOW - timedelta(days=45))], sm)
check("...also found from last rotation + interval when no next date is reported",
      risk(a, cx.SECRET_ROTATION_OVERDUE) is not None, str(rules_of(a)))
a = analyse([obj(KIND_SECRET, source="aws:secretsmanager", rotation_enabled=True,
                 rotation_interval_days=30, last_rotated_at=NOW - timedelta(days=31))], sm)
eq("one day late is inside the grace period -> no finding", rules_of(a), [])

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== E. Unread stores: a gap, never a pass ===")
# ═════════════════════════════════════════════════════════════════════════════
denied = [src("azure:keyvault:certificates", f"/v/{i}", COLLECT_PERMISSION_DENIED,
              label=f"kv-{i}", perm="Microsoft.KeyVault/vaults/certificates/read",
              fix="Assign the Key Vault Reader role.") for i in range(3)]
a = analyse([], denied, "AZURE")
r = risk(a, cx.CREDENTIAL_STORE_NOT_READ)
check("three refused vaults -> ONE grouped gap finding", r is not None and
      sum(1 for x in a.risks if x.rule_id == cx.CREDENTIAL_STORE_NOT_READ) == 1,
      str(rules_of(a)))
eq("...counting all three", r and r.affected_count, 3)
eq("...verdict NOT_SCANNED (a statement about collection, not about the vault)",
   r and r.verdict, NOT_SCANNED)
eq("...MEDIUM, because a permission can be granted", r and r.severity, MEDIUM)
check("...naming the missing permission", r and "Key Vault" in r.detail, r and r.detail)
check("the certificate rules carry NOT_SCANNED for the unread stores",
      a.rule_stats.get(cx.CERT_EXPIRED, {}).get(NOT_SCANNED) == 3,
      str(a.rule_stats.get(cx.CERT_EXPIRED)))
check("...and NOT NOT_APPLICABLE: nothing was read, so nothing is 'absent'",
      NOT_APPLICABLE not in a.rule_stats.get(cx.CERT_EXPIRED, {}),
      str(a.rule_stats.get(cx.CERT_EXPIRED)))
a = analyse([], [src("aws:acm", "x", COLLECT_UNAVAILABLE)])
eq("a transient failure is LOW", risk(a, cx.CREDENTIAL_STORE_NOT_READ).severity, LOW)
a = analyse([], [src("aws:acm", "x", COLLECT_OK)])
eq("a store read with nothing in it -> the rule is NOT_APPLICABLE",
   a.rule_stats.get(cx.CERT_EXPIRED), {NOT_APPLICABLE: 1})
a = analyse([], [src("aws:acm", "x", COLLECT_NEVER_RUN),
                 src("aws:acm", "y", COLLECT_NOT_SUPPORTED)])
eq("never-run and not-supported sources are not failures", a.scopes_failed, 0)
a = analyse([obj(days=100)], [src("aws:acm", "a"), src("aws:acm", "b", COLLECT_BLOCKED)])
eq("objects found elsewhere do not vouch for a blocked store",
   a.rule_stats.get(cx.CERT_EXPIRED, {}).get(NOT_SCANNED), 1)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== F. Engine integration: findings, identity, coverage, citations ===")
# ═════════════════════════════════════════════════════════════════════════════
ACCOUNT = str(uuid.uuid4())
res = SimpleNamespace(id=uuid.uuid4(), account_id=ACCOUNT, provider_resource_id="i-1",
                      resource_type="EC2Instance", resource_name="web",
                      region_or_zone="ap-south-1", status="running", ip_address=None,
                      config={"public_ip": None}, raw_data={}, tags={"Owner": "x"},
                      metadata_={}, updated_at=NOW, discovered_at=NOW)
cert = obj(days=-2, in_use=True, object_key="arn:aws:acm:ap-south-1:1:certificate/abc",
           name="shop.example.test")
a1 = engine.assess(account_id=ACCOUNT, provider="AWS", resources=[res],
                   credentials=[cert], credential_sources=[src()], now=NOW)
f = next((x for x in a1.findings if x.rule_id == cx.CERT_EXPIRED), None)
check("the engine turns the risk into a canonical finding", f is not None)
eq("...in the Encryption category", f and f.category, CAT_ENCRYPTION)
eq("...keyed on the provider's own id", f and f.resource_key, cert["object_key"])
eq("...typed Certificate", f and f.resource_type, "Certificate")
check("...cited against PCI-DSS 4.2.1 (certificate validity in transit)",
      f and any(ref.startswith("4.2.1") for ref in f.compliance.get("PCI-DSS", [])),
      str(f and f.compliance))
a2 = engine.assess(account_id=ACCOUNT, provider="AWS", resources=[res],
                   credentials=[cert], credential_sources=[src()], now=NOW + timedelta(hours=6))
f2 = next((x for x in a2.findings if x.rule_id == cx.CERT_EXPIRED), None)
eq("the same certificate next run is the SAME finding (stable fingerprint)",
   f2 and f2.fingerprint, f and f.fingerprint)
dims = {c.dimension: c for c in a1.coverage}
check("certificate stores appear as their own coverage dimension",
      COV_CREDENTIALS in dims and dims[COV_CREDENTIALS].determined == 1)
a_bad = engine.assess(account_id=ACCOUNT, provider="AWS", resources=[res],
                      credentials=[cert],
                      credential_sources=[src(), src("aws:acm", "x", COLLECT_PERMISSION_DENIED)],
                      now=NOW)
eq("an unread store does NOT move the coverage figure that gates the score",
   a_bad.coverage_pct, a1.coverage_pct)
eq("...and does not make the assessment PARTIAL (other findings may still resolve)",
   a_bad.outcome, a1.outcome)
check("...but its gap IS a finding", any(x.rule_id == cx.CREDENTIAL_STORE_NOT_READ
                                         for x in a_bad.findings))
iam = obj(days=-1, source="aws:iam-server-certificates", scope="global",
          object_key="arn:aws:iam::1:server-certificate/old")
a3 = engine.assess(account_id=ACCOUNT, provider="AWS", resources=[res],
                   credentials=[iam], credential_sources=[src("aws:iam-server-certificates",
                                                              "global")], now=NOW)
f3 = next((x for x in a3.findings if x.rule_id == cx.AWS_IAM_SERVER_CERT_EXPIRED), None)
check("an expired IAM server certificate is cited as CIS AWS 2.17",
      f3 and any(ref.startswith("2.17") for ref in f3.compliance.get("CIS-AWS", [])),
      str(f3 and f3.compliance))
oci_cert = obj(days=-1, source="oci:certificates", scope="ap-mumbai-1",
               object_key="ocid1.certificate.oc1..x")
a4 = engine.assess(account_id=ACCOUNT, provider="OCI", resources=[],
                   credentials=[oci_cert], credential_sources=[src("oci:certificates",
                                                                   "ap-mumbai-1")], now=NOW)
f4 = next((x for x in a4.findings if x.rule_id == cx.CERT_EXPIRED), None)
check("an OCI certificate finding carries no other cloud's benchmark",
      f4 and not ({"CIS-AWS", "CIS-AZURE"} & set(f4.compliance)), str(f4 and f4.compliance))
check("subjects evaluated include credential objects", a4.subjects_evaluated == 1,
      str(a4.subjects_evaluated))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== G. Azure effective permissions: the action is the PATTERN ===")
# ═════════════════════════════════════════════════════════════════════════════
from app.providers.azure.azure_tenant import allowed  # noqa: E402

reader = [{"actions": ["*/read"], "notActions": []}]
cost_reader = [{"actions": ["Microsoft.Consumption/*/read", "Microsoft.CostManagement/*/read",
                            "Microsoft.Resources/subscriptions/resourceGroups/read"],
                "notActions": []}]
check("Reader can list resources", allowed(reader, "Microsoft.Resources/subscriptions/resources/read"))
check("Cost Management Reader can query cost",
      allowed(cost_reader, "Microsoft.CostManagement/query/read"))
check("Cost Management Reader can NOT list resources (it only has resourceGroups/read)",
      not allowed(cost_reader, "Microsoft.Resources/subscriptions/resources/read"))
check("a notAction in the SAME block cancels",
      not allowed([{"actions": ["*"], "notActions": ["Microsoft.Authorization/*"]}],
                  "Microsoft.Authorization/roleAssignments/read"))
check("a notAction in ANOTHER block does not cancel",
      allowed([{"actions": ["*"], "notActions": []},
               {"actions": ["*/read"], "notActions": ["Microsoft.Authorization/*"]}],
              "Microsoft.Authorization/roleAssignments/read"))
check("matching is case-insensitive", allowed(reader, "microsoft.keyvault/vaults/READ"))
check("an empty listing grants nothing", not allowed([], "Microsoft.KeyVault/vaults/read"))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== H. Error classification keeps different fixes apart ===")
# ═════════════════════════════════════════════════════════════════════════════
from app.providers.aws import aws_credentials as awsc  # noqa: E402
from app.providers.azure import azure_credentials as azc  # noqa: E402
from app.providers.azure.azure_rest import AzureRestError  # noqa: E402
from app.providers.oci import oci_credentials as ocic  # noqa: E402


class _BotoLike(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code, "Message": code}}


eq("AWS AccessDeniedException -> PermissionDenied naming the action",
   awsc._classify(awsc.SOURCE_ACM, _BotoLike("AccessDeniedException"))[:2],
   (COLLECT_PERMISSION_DENIED, "acm:ListCertificates"))
eq("AWS UnrecognizedClientException -> AuthenticationFailed",
   awsc._classify(awsc.SOURCE_SECRETS, _BotoLike("UnrecognizedClientException"))[0],
   "AuthenticationFailed")
eq("anything else -> Unavailable", awsc._classify(awsc.SOURCE_ACM, RuntimeError("x"))[0],
   COLLECT_UNAVAILABLE)
st, perm, fix = azc._classify_data_plane(
    AzureRestError(403, "Forbidden", "Caller is not authorized", "ForbiddenByRbac"),
    KIND_CERTIFICATE, True)
check("Key Vault 403 ForbiddenByRbac -> PermissionDenied, fix names Key Vault Reader",
      st == COLLECT_PERMISSION_DENIED and "Key Vault Reader" in fix, f"{st} {fix}")
st, perm, fix = azc._classify_data_plane(
    AzureRestError(403, "Forbidden", "no list permission", "ForbiddenByPolicy"),
    KIND_SECRET, False)
check("403 ForbiddenByPolicy -> PermissionDenied, fix names the access policy",
      st == COLLECT_PERMISSION_DENIED and "access policy" in fix, f"{st} {fix}")
st, _, fix = azc._classify_data_plane(
    AzureRestError(403, "Forbidden", "Client address is not authorized",
                   "ForbiddenByFirewall"), KIND_KEY, True)
check("403 ForbiddenByFirewall -> BlockedByNetwork, fix names the firewall",
      st == COLLECT_BLOCKED and "firewall" in fix, f"{st} {fix}")
st, _, _ = azc._classify_data_plane(AzureRestError(None, "ConnectionError", "no route"),
                                    KIND_KEY, None)
eq("no response at all -> Unavailable (private endpoint)", st, COLLECT_UNAVAILABLE)


class _OciLike(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status, self.code = status, code


eq("OCI 404 NotAuthorizedOrNotFound -> PermissionDenied",
   ocic._classify(ocic.SOURCE_SECRETS, _OciLike(404, "NotAuthorizedOrNotFound"))[0],
   COLLECT_PERMISSION_DENIED)
eq("OCI 401 -> AuthenticationFailed",
   ocic._classify(ocic.SOURCE_SECRETS, _OciLike(401, "NotAuthenticated"))[0],
   "AuthenticationFailed")

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== I. Organisation member credentials ===")
# ═════════════════════════════════════════════════════════════════════════════
from app.providers.aws.aws_organizations import member_credentials, role_arn_for  # noqa: E402
from app.providers.azure import azure_tenant  # noqa: E402

base = {"access_key_id": "AKIA", "secret_access_key": "s", "session_token": None,
        "region": "ap-south-1"}
m = member_credentials(base, {"account_id": "111122223333", "is_caller_account": False},
                       role_name="ActmonReadOnly", external_id="ext-1")
eq("a member is stored with the role to assume INTO it", m.get("role_arn"),
   "arn:aws:iam::111122223333:role/ActmonReadOnly")
eq("...and the external id", m.get("external_id"), "ext-1")
mg = member_credentials(base, {"account_id": "999", "is_caller_account": True},
                        role_name="ActmonReadOnly", external_id=None)
check("the account the keys belong to is stored WITHOUT a role", "role_arn" not in mg)
eq("role ARN format", role_arn_for("1", "R"), "arn:aws:iam::1:role/R")
az = azure_tenant.member_credentials({"tenant_id": "t", "client_id": "c",
                                      "client_secret": "s"}, "sub-1")
eq("an Azure member is the same principal pointed at one subscription",
   az, {"tenant_id": "t", "client_id": "c", "client_secret": "s", "subscription_id": "sub-1"})

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== J. The rule registry knows every credential rule ===")
# ═════════════════════════════════════════════════════════════════════════════
from app.security import registry as reg  # noqa: E402

missing = [rid for rid in cx.RULE_IDS if rid not in reg.RULES]
eq("every analyser rule id is declared in the registry", missing, [])
check("every credential rule is synthetic (no per-resource evaluator)",
      all(reg.RULES[rid].synthetic for rid in cx.RULE_IDS))
check("every credential rule counts toward the credentials coverage dimension",
      all(reg.RULES[rid].coverage == COV_CREDENTIALS for rid in cx.RULE_IDS))
check("CERT_EXPIRING_SOON is cited by NO compliance control (it is not a failure)",
      not ctl.controls_for_rule(cx.CERT_EXPIRING_SOON))
check("CERT_EXPIRED is cited by at least one control", bool(ctl.controls_for_rule(cx.CERT_EXPIRED)))

print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    print("\nFAILURES:")
    for x in fail:
        print(f"  ! {x}")
sys.exit(1 if fail else 0)
