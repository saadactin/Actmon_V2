"""How much of an account a discovery sweep actually read — and why the rest was not.

Pure: no database, no network. The AWS scanner is driven with stand-in scanners
and a stand-in Bedrock client, so every outcome below is produced by the real
scan_all / _subcall / _build_scope_summary code.

What this suite pins:

* **One failed scope is not 0% coverage.** Inventory coverage is the share of
  scopes read. It used to drop to 0% the moment any scope failed, so an AWS
  account missing two permissions read "inventory 0%".
* **"Not offered in this region" is not a failure.** Bedrock's custom-model API
  does not exist in some regions (UnknownOperationException, or a
  ValidationException "Unknown operation"); counting that as a failed scope
  made a complete sweep look broken.
* **A denial is recorded, never swallowed.** The Bedrock scanner used to catch
  its errors and return "no resources", so a denied read looked like an account
  with no Bedrock. The denied IAM action is read out of AWS's own message.
* **The fix is stated exactly:** every missing action, per service and per
  certificate store, plus the policy that grants them — read actions only.
"""
from __future__ import annotations

import asyncio
import pathlib
import sys
import types

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import logging  # noqa: E402

logging.disable(logging.CRITICAL)

from botocore.exceptions import ClientError  # noqa: E402

from app.providers.aws.aws_scanner import (  # noqa: E402
    SCANNER_ACTIONS, AWSScanner, denied_action, is_not_offered,
)
from app.security import engine  # noqa: E402
from app.services.security_center_service import permissions_block  # noqa: E402
from app.workers.discovery_worker import partial_sweep_note  # noqa: E402

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


def ce(code, message, op="Op"):
    return ClientError({"Error": {"Code": code, "Message": message}}, op)


def denied(action, region="r1"):
    return ce("AccessDenied", f"User: arn:aws:iam::111122223333:user/actmon is not authorized to "
                              f"perform: {action} on resource: arn:aws:x:{region}:1:* because no "
                              "identity-based policy allows the action")


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== A. Reading AWS's answers ===")
# ═════════════════════════════════════════════════════════════════════════════
eq("UnknownOperationException means the operation is not offered there",
   is_not_offered(ce("UnknownOperationException", "Unknown Operation")), True)
eq("...and so does a ValidationException that says 'Unknown operation' (ap-south-2)",
   is_not_offered(ce("ValidationException", "Unknown operation")), True)
eq("an ordinary ValidationException is NOT 'not offered'",
   is_not_offered(ce("ValidationException", "1 validation error detected")), False)
eq("a denial is not 'not offered'", is_not_offered(denied("redshift:DescribeClusters")), False)
eq("a dropped connection is not 'not offered'",
   is_not_offered(RuntimeError("Connection was closed before we received a valid response")), False)
eq("the denied action is read out of AWS's own message",
   denied_action(denied("elasticache:DescribeReplicationGroups")),
   "elasticache:DescribeReplicationGroups")
eq("no action in the message -> None, not a guess", denied_action(ce("AccessDenied", "Denied")), None)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== B. A sweep's outcome, scope by scope ===")
# ═════════════════════════════════════════════════════════════════════════════


class _BedrockClient:
    def __init__(self, region):
        self.region = region

    def list_custom_models(self):
        if self.region == "r1":
            raise ce("ValidationException", "Unknown operation")   # not offered in r1
        return {"modelSummaries": [{"modelArn": "arn:m", "modelName": "m1"}]}

    def list_agents(self):
        raise ce("AccessDeniedException", "User: arn:aws:iam::1:user/a is not authorized to "
                                          "perform: bedrock:ListAgents on resource: x")

    def list_knowledge_bases(self):
        return {"knowledgeBaseSummaries": []}


class _Auth:
    region = "r1"

    def get_client(self, service, region=None):
        if service in ("bedrock", "bedrock-agent"):
            return _BedrockClient(region)
        raise AssertionError(f"no real client in this test: {service}")


sc = AWSScanner(_Auth())
sc._TRANSIENT_ATTEMPTS = 1      # no retry sleeps in a test


async def _regions():
    return ["r1", "r2"]


async def _found(region=None):
    return [{"provider_resource_id": f"x-{region}"}]


async def _redshift(region):
    raise denied("redshift:DescribeClusters", region)


async def _dynamodb(region):
    if region == "r2":
        raise RuntimeError("Connection was closed before we received a valid response")
    return []


async def _apigateway(region):
    if region == "r2":
        raise ce("UnknownOperationException", "Unknown Operation")
    return []


sc._get_regions = _regions
for name in ("_scan_ec2", "_scan_ebs", "_scan_rds", "_scan_db_clusters", "_scan_elasticache",
             "_scan_lambda", "_scan_eks", "_scan_elb", "_scan_vpc", "_scan_subnet",
             "_scan_security_group"):
    setattr(sc, name, _found)
sc._scan_redshift = _redshift
sc._scan_dynamodb = _dynamodb
sc._scan_apigateway = _apigateway
sc._scan_s3 = lambda: _found("global")
sc._scan_iam_role = lambda: _found("global")

resources = asyncio.run(sc.scan_all())
s = sc.scope_summary or {}
eq("every scope is accounted for: 2 regions x 15 services + S3 + IAM, minus the one not offered",
   s.get("attempted"), 2 * 15 + 2 - 1)
eq("...API Gateway in r2 is 'not offered', not failed", s.get("not_offered"), {"APIGateway": ["r2"]})
eq("Redshift is denied in both regions (the second skipped once the first was refused)",
   (s.get("denied") or {}).get("Redshift", {}).get("regions"), ["r1", "r2"])
check("...with the action AWS named, plus everything else the scanner calls",
      "redshift:DescribeClusters" in s["denied"]["Redshift"]["actions"]
      and set(SCANNER_ACTIONS["Redshift"]) <= set(s["denied"]["Redshift"]["actions"]))
eq("Bedrock's denied agents call is RECORDED (it used to be swallowed as 'no resources')",
   (s.get("denied") or {}).get("Bedrock", {}).get("observed_actions"), ["bedrock:ListAgents"])
eq("...in both regions — r1's missing custom-model API does not hide the denial",
   s["denied"]["Bedrock"]["regions"], ["r1", "r2"])
eq("a dropped connection is a failed scope, flagged as transient",
   [(f["scope"], f["transient"]) for f in s.get("failed") or []], [("DynamoDB [r2]", True)])
eq("read = attempted - denied - failed", s.get("read"), 31 - 2 - 2 - 1)
eq("missing permissions list every action for the denied services",
   s.get("missing_permissions"),
   sorted(set(SCANNER_ACTIONS["Redshift"]) | set(SCANNER_ACTIONS["Bedrock"])))
check("scan_failures (the prune guard) carries the denials and the failure",
      any("Redshift" in f for f in sc.scan_failures) and any("Bedrock" in f for f in sc.scan_failures)
      and any("DynamoDB [r2]" in f for f in sc.scan_failures))
check("...but not the region where the API does not exist — that is not a failure",
      not any("APIGateway [r2]" in f for f in sc.scan_failures), str(sc.scan_failures))
check("Bedrock's readable parts still returned their resources",
      any(r.get("provider_resource_id") == "arn:m" for r in resources))
eq("the region list worked, so the ratio describes the whole account", s.get("regions_unknown"), False)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== C. Coverage is the share read, and the reasons say why ===")
# ═════════════════════════════════════════════════════════════════════════════
a = engine.assess(account_id="acc", provider="AWS", resources=[], sweep_complete=False,
                  failed_scopes=len(sc.scan_failures), scope_summary=s)
inv = next(d for d in a.coverage if d.dimension == "inventory")
eq("inventory coverage is read / attempted (not 0%)", inv.pct, round(100.0 * 26 / 31, 1))
reasons = " ".join(a.incomplete_reasons)
check("the reasons give the share read", "26 of 31 scopes" in reasons, reasons[:200])
check("...name the denied services and the actions to grant",
      "Redshift (2 regions)" in reasons and "redshift:DescribeClusters" in reasons)
check("...point at ReadOnlyAccess for AWS", "ReadOnlyAccess" in reasons)
check("...name the scope that did not answer, and that it will be retried",
      "DynamoDB [r2]" in reasons and "retried" in reasons)
check("...and explain what was not counted", "not offered there: APIGateway in 1 region" in reasons)
eq("the assessment is PARTIAL — nothing is resolved from an incomplete sweep",
   a.outcome, "PARTIAL")

old = engine.assess(account_id="acc", provider="AWS", resources=[], sweep_complete=False,
                    failed_scopes=3, scope_summary=None)
eq("a sweep that did not count its scopes keeps the old, cautious 0%",
   next(d for d in old.coverage if d.dimension == "inventory").pct, 0.0)
blind = engine.assess(account_id="acc", provider="AWS", resources=[], sweep_complete=False,
                      failed_scopes=1, scope_summary={**s, "regions_unknown": True})
eq("...and so does one whose region list failed (its ratio would describe one region)",
   next(d for d in blind.coverage if d.dimension == "inventory").pct, 0.0)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== D. The job's note and the permissions to grant ===")
# ═════════════════════════════════════════════════════════════════════════════
note = partial_sweep_note(sc.scan_failures, s)
check("the job note gives the share and the denied services, not just the first failure",
      "26 of 31 scopes read" in note and "Redshift (2 regions)" in note
      and "Bedrock (2 regions)" in note and "1 did not answer" in note, note)
check("...and without a scope summary still names the first failure",
      "First failure" in partial_sweep_note(["EC2 [r1]: boom"], None))

stores = [types.SimpleNamespace(source="aws:acm", status="PermissionDenied",
                                missing_permission="acm:ListCertificates"),
          types.SimpleNamespace(source="aws:acm", status="PermissionDenied",
                                missing_permission="acm:ListCertificates"),
          types.SimpleNamespace(source="aws:secretsmanager", status="PermissionDenied",
                                missing_permission="secretsmanager:ListSecrets"),
          types.SimpleNamespace(source="aws:iam-server-certificates", status="Collected",
                                missing_permission=None)]
block = permissions_block("AWS", s, stores)
eq("one list of every missing action, inventory and certificate stores together",
   block["missing"], sorted(set(s["missing_permissions"]) | {
       "acm:ListCertificates", "acm:DescribeCertificate", "secretsmanager:ListSecrets"}))
eq("each area says what it is and how many scopes it blocked",
   [(x["area"], x["item"], x["scopes"]) for x in block["areas"]],
   [("Inventory", "Bedrock", 2), ("Inventory", "Redshift", 2),
    ("Certificates & secrets", "AWS Certificate Manager", 2),
    ("Certificates & secrets", "AWS Secrets Manager", 1)])
eq("the AWS policy grants exactly those actions", block["aws_policy"]["Statement"][0]["Action"],
   block["missing"])
check("...read actions only — nothing that returns a secret value",
      not any("GetSecretValue" in x for x in block["missing"])
      and all(x.split(":")[1].startswith(("List", "Describe", "Get")) or x == "apigateway:GET"
              for x in block["missing"]), str(block["missing"]))
eq("...with ReadOnlyAccess as the one-click alternative", block["managed_policy"],
   "arn:aws:iam::aws:policy/ReadOnlyAccess")
check("a store that WAS read adds nothing", "iam:ListServerCertificates" not in block["missing"])
check("no AWS policy is offered for another cloud",
      "aws_policy" not in permissions_block("Azure", None, [types.SimpleNamespace(
          source="azure:app-service-certificates", status="PermissionDenied",
          missing_permission="Microsoft.Web/certificates/read")]))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== E. A long failure list is capped; its count is not ===")
# ═════════════════════════════════════════════════════════════════════════════
# The stored list keeps 50 scopes so a bad sweep does not bloat the job row.
# Counting that list reported "50 did not answer" for any worse sweep.
many = AWSScanner(_Auth())
many._TRANSIENT_ATTEMPTS = 1
REGIONS = [f"g{i}" for i in range(1, 61)]


async def _many_regions():
    return REGIONS


async def _dropped(region):
    raise RuntimeError("Connection was closed before we received a valid response")


many._get_regions = _many_regions
for name in ("_scan_ec2", "_scan_ebs", "_scan_rds", "_scan_db_clusters", "_scan_elasticache",
             "_scan_lambda", "_scan_eks", "_scan_elb", "_scan_vpc", "_scan_subnet",
             "_scan_security_group", "_scan_redshift", "_scan_apigateway", "_scan_bedrock"):
    setattr(many, name, _found)
many._scan_dynamodb = _dropped
many._scan_s3 = lambda: _found("global")
many._scan_iam_role = lambda: _found("global")
asyncio.run(many.scan_all())
m = many.scope_summary or {}
eq("the stored list is capped at 50 scopes", len(m.get("failed") or []), 50)
eq("...but the count is all 60", m.get("failed_count"), 60)
eq("...and so is the dropped-connection count", m.get("failed_transient"), 60)
eq("read + failed = attempted", (m.get("read") or 0) + (m.get("failed_count") or 0),
   m.get("attempted"))
why = " ".join(engine.sweep_reasons(m))
check("the assessment's reason reports all 60, not the 50 listed",
      "60 scope(s) did not answer (60 dropped the connection" in why, why[-240:])
many_note = partial_sweep_note(many.scan_failures, m)
check("...and so does the job's note", "60 did not answer" in many_note, many_note)
legacy = {k: v for k, v in m.items() if k not in ("failed_count", "failed_transient")}
check("a summary stored before the counts existed still reads its list",
      "50 scope(s) did not answer" in " ".join(engine.sweep_reasons(legacy)))

print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    print("\nFAILURES:")
    for x in fail:
        print(f"  ! {x}")
sys.exit(1 if fail else 0)
