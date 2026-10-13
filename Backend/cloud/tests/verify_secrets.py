"""Secrets detection: what it finds, what it refuses to find, and what it never
lets out.

Run: venv\\Scripts\\python.exe tests\\verify_secrets.py

Section 1 is the one that matters. A tool that detects secrets and then stores
them has enlarged the problem it was bought to shrink, so the suite asserts
directly that no input value survives into any output — not that redaction was
*called*, but that the string is absent from the serialised result.

Section 4 is the other half: a managed-store reference is the GOOD outcome and
must never be flagged. Flagging the fix is how an operator learns to ignore the
finding, and an ignored CRITICAL is worth less than no CRITICAL at all.
"""
import json
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.security import registry as reg
from app.security import secrets
from app.security.model import CONF_HIGH, CONF_MEDIUM, CRITICAL, HIGH, INFO, UNKNOWN, VULNERABLE

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


class R:
    def __init__(self, rtype, name, config=None, tags=None):
        self.id = uuid.uuid4()
        self.resource_type = rtype
        self.resource_name = name
        self.config = config or {}
        self.tags = tags or {}
        self.region_or_zone = "ap-south-1"
        self.provider_resource_id = f"arn::{name}"


ACCT = "acct-1"
PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"
JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"
AWSPAIR = "AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"


def run(resources, provider="AWS", account=ACCT):
    return secrets.analyse(provider=provider, account_id=account, resources=resources)


# ═════════════════════════════════════════════════════════════════════════════
print("1. THE VALUE NEVER LEAVES — no input string survives into any output")
loud = [
    R("LambdaFunction", "fn1", {"environment_variables": {
        "JWT_SECRET_KEY": "s3cr3t-value-nobody-should-see",
        "PRIVATE_KEY": PEM,
        "TOKEN": JWT,
    }}),
    R("LambdaFunction", "fn2", {"environment_variables": {"DB_PASSWORD": "hunter2-and-more"}},
      tags={"api_secret": "tag-secret-value-here"}),
]
res = run(loud)
blob = json.dumps([r._asdict() for r in res.risks], default=str)
for needle in ("s3cr3t-value-nobody-should-see", "hunter2-and-more",
               "tag-secret-value-here", "MIIEpAIBAAKCAQEA", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"):
    check(f"'{needle[:22]}…' absent from the output", needle not in blob)
check("every evidence block says the value is redacted",
      all(r.evidence.get("value") == "[REDACTED]" for r in res.risks
          if r.rule_id != secrets.RULE_SURFACE_NOT_SCANNED))
check("findings were still produced (the suite is not passing by finding nothing)",
      len([r for r in res.risks if r.rule_id == secrets.RULE_SECRET_IN_CONFIG]) >= 4,
      str(len(res.risks)))

print("\n2. Fingerprints — stable, account-scoped, and distinct per secret")
f1 = secrets.fingerprint(ACCT, "same-value")
check("stable for the same value in the same account",
      f1 == secrets.fingerprint(ACCT, "same-value"))
check("differs for a different value",
      f1 != secrets.fingerprint(ACCT, "other-value"))
check("differs across accounts (salted, so useless as a cross-account table)",
      f1 != secrets.fingerprint("acct-2", "same-value"))
check("is truncated, not a full digest anyone could mistake for the thing",
      len(f1) == 16, str(len(f1)))
two = [r for r in res.risks if r.resource_name == "fn1"]
prints = {r.evidence["fingerprint"] for r in two}
check("two different secrets on one resource get two fingerprints",
      len(prints) == len(two), f"{len(prints)} prints for {len(two)} findings")

print("\n3. Detection — value shape beats field name, and says which fired")
by_path = {r.discriminator: r for r in res.risks
           if r.rule_id == secrets.RULE_SECRET_IN_CONFIG}
pem_hit = by_path.get("environment_variables.PRIVATE_KEY")
name_hit = by_path.get("environment_variables.JWT_SECRET_KEY")
check("a PEM block is detected by value shape", pem_hit is not None)
check("...at HIGH confidence and CRITICAL severity",
      pem_hit and pem_hit.confidence == CONF_HIGH and pem_hit.severity == CRITICAL,
      f"{pem_hit.confidence}/{pem_hit.severity}" if pem_hit else "missing")
check("...and names the detector that fired",
      pem_hit and pem_hit.evidence["detector"] == "value:pem-private-key")
check("a credential-shaped FIELD NAME is MEDIUM, not HIGH — it is circumstantial",
      name_hit and name_hit.confidence == CONF_MEDIUM and name_hit.severity == HIGH,
      f"{name_hit.confidence}/{name_hit.severity}" if name_hit else "missing")
check("an AWS key pair in one string is detected",
      any(r.evidence.get("detector") == "value:aws-key-pair"
          for r in run([R("LambdaFunction", "f", {"environment_variables": {"X": AWSPAIR}})]).risks))

print("\n4. Refusals — placeholders and managed references are NOT findings")
benign = R("LambdaFunction", "clean", {"environment_variables": {
    "DB_PASSWORD": "",                       # empty
    "API_SECRET": "changeme",                # placeholder
    "TOKEN": "TODO",                         # placeholder
    "JWT_SECRET": "arn:aws:secretsmanager:ap-south-1:1:secret:jwt-AbCdEf",
    "KV_SECRET": "@Microsoft.KeyVault(SecretUri=https://v.vault.azure.net/secrets/x/)",
    "OCI_SECRET": "ocid1.vaultsecret.oc1..aaaa",
}})
benign_res = run([benign])
hits = [r for r in benign_res.risks if r.rule_id == secrets.RULE_SECRET_IN_CONFIG]
check("no finding for placeholders or managed-store references", hits == [],
      str([h.discriminator for h in hits]))
check("an access key ID alone is not treated as a secret",
      not [r for r in run([R("LambdaFunction", "f", {"environment_variables": {
          "AWS_ACCESS_KEY_ID": "AKIAIOSFODNN7EXAMPLE"}})]).risks
           if r.rule_id == secrets.RULE_SECRET_IN_CONFIG])

print("\n5. Tags are scanned, and judged more harshly than config is forgiving")
tagged = run([R("EC2Instance", "web", tags={"db_password": "real-looking-password"})])
tag_hits = [r for r in tagged.risks if r.rule_id == secrets.RULE_SECRET_IN_TAG]
check("a credential in a tag is found", len(tag_hits) == 1, str(len(tag_hits)))
check("its rationale names the wider audience a tag has",
      "list the resource" in (tag_hits[0].detail if tag_hits else ""))
check("the tag value does not appear in the finding",
      "real-looking-password" not in json.dumps(
          [r._asdict() for r in tagged.risks], default=str))

print("\n6. Coverage — an unread surface is reported once, as UNKNOWN, not as clean")
# 3 EC2 instances, none with user_data collected.
unread = run([R("EC2Instance", f"i{i}") for i in range(3)])
gaps = [r for r in unread.risks if r.rule_id == secrets.RULE_SURFACE_NOT_SCANNED]
check("one finding per unread surface, not per resource", len(gaps) == 1, str(len(gaps)))
check("verdict is UNKNOWN, never SAFE or VULNERABLE",
      gaps and gaps[0].verdict == UNKNOWN)
check("severity is INFO — it is a gap, not a breach",
      gaps and gaps[0].severity == INFO)
check("it says how many resources are affected",
      gaps and gaps[0].evidence["resources_of_type"] == 3)

print("\n7. 'No such resources' and 'not collected' are different facts")
states = {s.surface.resource_type: s.status for s in unread.surfaces}
check("a type with resources but no field -> not_collected",
      states.get("EC2Instance") == "not_collected", states.get("EC2Instance"))
check("a type with no resources at all -> no_such_resources",
      states.get("ECSTaskDefinition") == "no_such_resources",
      states.get("ECSTaskDefinition"))
check("no finding is raised for a surface with no resources",
      not any(r.resource_type == "ECSTaskDefinition" for r in unread.risks))
scanned = run([R("LambdaFunction", "f", {"environment_variables": {"A": "b"}})])
check("a type whose field IS present -> scanned",
      {s.surface.resource_type: s.status for s in scanned.surfaces}
      .get("LambdaFunction") == "scanned")

print("\n8. Each secret resolves independently, and the registry knows every rule")
multi = run([R("LambdaFunction", "fn", {"environment_variables": {
    "A_SECRET": "aaaaaaaaaaaa", "B_SECRET": "bbbbbbbbbbbb"}})])
discs = {r.discriminator for r in multi.risks
         if r.rule_id == secrets.RULE_SECRET_IN_CONFIG}
check("two secrets on one resource have distinct discriminators", len(discs) == 2,
      str(discs))
for rid in secrets.RULE_IDS:
    rule = reg.by_id(rid)
    check(f"{rid} is registered", rule is not None)
    check(f"{rid} is synthetic (no per-resource evaluator)",
          rule is not None and rule.evaluate is None)
    check(f"{rid} has a real remediation", rule is not None and len(rule.remediation) >= 40)
check("the analyser emits no rule id the registry has not heard of",
      all(r.rule_id in reg.RULES for r in res.risks))

print("\n9. Provider scoping — a surface is only searched on its own cloud")
az = run([R("LambdaFunction", "f", {"environment_variables": {"S_SECRET": "xxxxxxxxxxxx"}})],
         provider="AZURE")
check("AWS Lambda surfaces are not scanned on an Azure account",
      not [r for r in az.risks if r.rule_id == secrets.RULE_SECRET_IN_CONFIG],
      str([r.discriminator for r in az.risks]))
check("...but tags still are, because every provider has them",
      len(run([R("VirtualMachine", "vm", tags={"client_secret": "zzzzzzzzzzzz"})],
              provider="AZURE").risks) >= 1)

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
