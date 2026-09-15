"""Event classification and redaction — pure logic, no database, no network.

These are the assertions that decide what the Event Log CALLS things: which
verb an operation is, which functional area it belongs to, how much risk it
carries, and what never reaches storage. Getting any of them wrong is silent —
the page still renders, it just misleads — so they are pinned here.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.events.classification import (  # noqa: E402
    classify,
    classify_risk,
    derive_action,
    derive_category,
    describe_ruleset,
)
from app.events.redaction import REDACTED, redact  # noqa: E402
from app.events.adapters.base import EventAdapter  # noqa: E402

ok, fail = [], []


def risk(**kwargs):
    defaults = dict(provider="AWS", status="Success", actor_type="Human")
    defaults.update(kwargs)
    return classify_risk(**defaults)




def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


# ── 1. Action derivation ──────────────────────────────────────────────────────
print("1. action derivation")

eq("AWS DeleteBucket -> Delete", derive_action(event_name="DeleteBucket"), "Delete")
eq("AWS RunInstances -> Invoke",
   derive_action(event_name="RunInstances"), "Invoke")
eq("AWS TerminateInstances -> Delete",
   derive_action(event_name="TerminateInstances"), "Delete")
eq("AWS ConsoleLogin -> Login", derive_action(event_name="ConsoleLogin"), "Login")
eq("AWS DescribeInstances -> Read",
   derive_action(event_name="DescribeInstances"), "Read")
eq("AWS AuthorizeSecurityGroupIngress -> Authorize",
   derive_action(event_name="AuthorizeSecurityGroupIngress"), "Authorize")

# Ordering traps: the longer fragment has to win, or Disassociate reads as
# Associate and Detach reads as Attach.
eq("DisassociateAddress -> Disassociate",
   derive_action(event_name="DisassociateAddress"), "Disassociate")
eq("DetachVolume -> Detach", derive_action(event_name="DetachVolume"), "Detach")
eq("DeregisterTargets -> Detach",
   derive_action(event_name="DeregisterTargets"), "Detach")

# Azure goes by REST verb suffix, not by an English verb.
eq("Azure .../write -> Update",
   derive_action(event_name="virtualMachines/write", provider="Azure",
                 api_operation="Microsoft.Compute/virtualMachines/write"), "Update")
eq("Azure .../delete -> Delete",
   derive_action(event_name="securityRules/delete", provider="Azure",
                 api_operation="Microsoft.Network/networkSecurityGroups/securityRules/delete"),
   "Delete")
eq("Azure .../read -> Read",
   derive_action(event_name="vaults/read", provider="Azure",
                 api_operation="Microsoft.KeyVault/vaults/read"), "Read")
eq("Azure .../action -> Invoke",
   derive_action(event_name="restart/action", provider="Azure",
                 api_operation="Microsoft.Compute/virtualMachines/restart/action"),
   "Invoke")

# OCI: name first, then the request verb as a real fallback.
eq("OCI CreateVcn -> Create", derive_action(event_name="CreateVcn"), "Create")
eq("OCI unknown name + POST -> Create",
   derive_action(event_name="Zzzqqq", request_action="POST"), "Create")
eq("OCI unknown name + DELETE -> Delete",
   derive_action(event_name="Zzzqqq", request_action="DELETE"), "Delete")

# Genuinely unknown stays unknown rather than being guessed at.
eq("unnameable + no signal -> Other", derive_action(event_name="Zzzqqq"), "Other")
eq("unnameable + provider readOnly -> Read",
   derive_action(event_name="Zzzqqq", read_only=True), "Read")


# ── 2. Category derivation ────────────────────────────────────────────────────
print("\n2. category derivation")

eq("AWS iam source -> IAM",
   derive_category(event_name="CreateUser", event_source="iam.amazonaws.com"), "IAM")
eq("AWS s3 source -> Storage",
   derive_category(event_name="PutBucketAcl", event_source="s3.amazonaws.com"), "Storage")
eq("AWS security group -> Network",
   derive_category(event_name="AuthorizeSecurityGroupIngress",
                   event_source="ec2.amazonaws.com", resource_type="SecurityGroup"),
   "Network")
eq("AWS ConsoleLogin -> Authentication",
   derive_category(event_name="ConsoleLogin", event_source="signin.amazonaws.com"),
   "Authentication")
eq("AWS CloudTrail StopLogging -> Logging",
   derive_category(event_name="StopLogging", event_source="cloudtrail.amazonaws.com"),
   "Logging")
eq("AWS kms -> Security",
   derive_category(event_name="ScheduleKeyDeletion", event_source="kms.amazonaws.com"),
   "Security")
eq("Azure NSG -> Network",
   derive_category(api_operation="Microsoft.Network/networkSecurityGroups/securityRules/write",
                   event_source="Microsoft.Network"), "Network")
eq("Azure Key Vault -> Security",
   derive_category(api_operation="Microsoft.KeyVault/vaults/write",
                   event_source="Microsoft.KeyVault"), "Security")
eq("Azure role assignment -> IAM",
   derive_category(api_operation="Microsoft.Authorization/roleAssignments/write",
                   event_source="Microsoft.Authorization"), "IAM")
eq("OCI object storage -> Storage",
   derive_category(event_name="UpdateBucket", event_source="objectstorage",
                   resource_id="ocid1.bucket.oc1..aaa"), "Storage")
eq("OCI vcn -> Network",
   derive_category(event_name="CreateVcn", event_source="virtualNetwork",
                   resource_id="ocid1.vcn.oc1..aaa"), "Network")
eq("nothing recognisable -> Other",
   derive_category(event_name="Zzzqqq", event_source="zzz"), "Other")

# ── Word-boundary regressions, every one found on live provider data ──────────
# These are the false positives a plain substring scan produced. They are not
# hypothetical: each was observed misclassifying real events from a live Azure
# subscription, and each would silently mis-file activity forever.
print("\n2b. word-boundary regressions (from live data)")

ARM_ID = ("/SUBSCRIPTIONS/4AEDDB6B-7FCA-48CC-A3F1-1AD823F70F4C/RESOURCEGROUPS/"
          "DEVAPP/PROVIDERS/MICROSOFT.WEB/SITES/T-KEQUIPDEV")

eq('"ebs" must not match inside "StopWebSite" (was: web app -> Storage)',
   derive_category(event_name="StopWebSite", event_source="MICROSOFT.WEB",
                   resource_type="sites", resource_id=ARM_ID), "Compute")
eq('"ebs" must not match inside "StartWebSite" either',
   derive_category(event_name="StartWebSite", event_source="MICROSOFT.WEB",
                   resource_type="sites", resource_id=ARM_ID), "Compute")

# "ons" (OCI's Notification Service) matched "subscriptiONS" in every single
# ARM resource id, and "subscription"/"resourcegroup" matched every one too.
eq('an ARM id alone must not be read as Monitoring, Billing or ResourceManagement',
   derive_category(event_name="StopWebSite", event_source="MICROSOFT.WEB",
                   resource_id=ARM_ID), "Compute")

# The legitimate mid-string matches that the boundary rule must NOT reject.
eq('"securitygroup" must still match "AuthorizeSecurityGroupIngress"',
   derive_category(event_name="AuthorizeSecurityGroupIngress",
                   event_source="ec2.amazonaws.com"), "Network")
eq('a plural still matches ("buckets")',
   derive_category(event_name="ListBuckets", event_source="s3.amazonaws.com"), "Storage")

# The action-verb version of the same bug: "Publish" sat above "List" in the
# pattern table, so a credential READ was classified as a deployment and then
# sailed past every write-oriented risk rule.
eq('"ListPublishingCredentials" is a Read, not a Deploy',
   derive_action(event_name="ListPublishingCredentials"), "Read")
eq('but "PublishLayerVersion" really is a Deploy',
   derive_action(event_name="PublishLayerVersion"), "Deploy")
eq('the verb is the LEADING word, not whichever pattern sits highest',
   derive_action(event_name="ListSecurityGroupRules"), "Read")
eq('"AssociateAddress" is not read as a Create via "Add"',
   derive_action(event_name="AssociateAddress"), "Associate")

# And the credential reads those two operations actually are.
level, reason = risk(action="Read", category="Security",
                     event_name="sites/ListPublishingCredentials")
eq("reading deployment credentials -> HIGH", level, "HIGH")
check("and the reason says credential material was returned",
      "credential" in (reason or "").lower(), repr(reason))
eq("Azure publishxml (returns the publish profile) is Security, not Compute",
   derive_category(event_name="publishxml/action",
                   api_operation="Microsoft.Web/sites/publishxml/action",
                   event_source="Microsoft.Web"), "Security")


# ── 3. Risk classification ────────────────────────────────────────────────────
print("\n3. risk classification")


level, reason = risk(action="Read", category="Compute", event_name="DescribeInstances")
eq("read of a compute resource -> INFO", level, "INFO")

level, _ = risk(action="Create", category="Storage", event_name="CreateBucket")
eq("create a bucket -> MEDIUM", level, "MEDIUM")

level, reason = risk(action="Delete", category="IAM", event_name="DeleteUser")
eq("delete an IAM user -> HIGH", level, "HIGH")
# The rule's own sentence, not the generic "base risk for a Delete operation".
# A matching rule must supply the explanation even when it does not raise the
# level, or every rule sitting at the floor loses its justification.
check("the matching rule supplies the reason, not the generic floor text",
      reason == "A user, group or role was deleted.", repr(reason))

level, reason = risk(action="Update", category="IAM", event_name="AttachRolePolicy")
eq("IAM policy change -> CRITICAL", level, "CRITICAL")
check("policy-change reason names the consequence",
      "who can do what" in (reason or "").lower(), repr(reason))

level, reason = risk(
    action="Authorize", category="Network",
    event_name="AuthorizeSecurityGroupIngress",
    request_parameters={"ipPermissions": {"items": [{"ipRanges": {
        "items": [{"cidrIp": "0.0.0.0/0"}]}}]}},
)
eq("security group opened to 0.0.0.0/0 -> CRITICAL", level, "CRITICAL")
check("exposure reason names the CIDR", "0.0.0.0/0" in (reason or ""), repr(reason))

level, _ = risk(
    action="Authorize", category="Network",
    event_name="AuthorizeSecurityGroupIngress",
    request_parameters={"ipPermissions": {"items": [{"ipRanges": {
        "items": [{"cidrIp": "10.10.0.0/16"}]}}]}},
)
check("the same call to a private CIDR is NOT critical", level != "CRITICAL", level)

level, reason = risk(actor_type="RootAccount", action="Read", category="Compute",
                     event_name="DescribeInstances")
eq("root usage is CRITICAL even for a read", level, "CRITICAL")

level, _ = risk(action="Update", category="Logging", event_name="StopLogging")
eq("stopping CloudTrail -> CRITICAL", level, "CRITICAL")

level, _ = risk(action="Delete", category="Security", event_name="ScheduleKeyDeletion")
eq("scheduling a KMS key deletion -> CRITICAL", level, "CRITICAL")

level, _ = risk(action="Deactivate" and "Disable", category="IAM",
                event_name="DeactivateMFADevice")
eq("MFA deactivation -> CRITICAL", level, "CRITICAL")

level, _ = risk(action="Create", category="IAM", event_name="CreateAccessKey")
eq("creating an access key -> HIGH", level, "HIGH")

level, _ = risk(action="Update", category="Compute", status="Denied",
                event_name="ModifyInstanceAttribute")
eq("a denied change -> HIGH", level, "HIGH")

level, _ = risk(action="Login", category="Authentication", status="Failed",
                event_name="ConsoleLogin")
eq("a failed login -> HIGH", level, "HIGH")

level, reason = risk(actor_type="CloudService", action="Update", category="Compute",
                     event_name="ModifyInstanceAttribute")
eq("routine cloud-service chatter is demoted to LOW", level, "LOW")
check("chatter demotion says who acted",
      "cloud service" in (reason or "").lower(), repr(reason))

# Privilege escalation spotted in the payload, not the name.
level, reason = risk(
    action="Update", category="IAM", event_name="PutUserPolicy",
    request_parameters={"policyDocument": '{"Statement":[{"Effect":"Allow",'
                                          '"Action":"*","Resource":"*"}]}',
                        "policyArn": "arn:aws:iam::aws:policy/AdministratorAccess"},
)
eq("an AdministratorAccess grant -> CRITICAL", level, "CRITICAL")

# A read must never be raised by the category floor alone.
level, _ = risk(action="Read", category="IAM", event_name="ListUsers")
eq("listing IAM users stays INFO", level, "INFO")


# ── 4. Classification is configurable, and it says how ────────────────────────
print("\n4. ruleset introspection")

ruleset = describe_ruleset()
check("base risk map is exposed", isinstance(ruleset.get("base_risk_by_action"), dict))
check("category floors are exposed", isinstance(ruleset.get("category_risk_floor"), dict))
check("every rule carries an id and a reason",
      all(r.get("id") and r.get("why") for r in ruleset["risk_rules"]),
      f"{len(ruleset['risk_rules'])} rules")
check("no rule has an empty match block (which would tag every event)",
      all(r.get("match") for r in ruleset["risk_rules"]))


# ── 5. Redaction ──────────────────────────────────────────────────────────────
print("\n5. redaction")

payload = {
    "userName": "saad",
    "password": "hunter2",
    "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
    "keyId": "1234abcd-12ab-34cd-56ef-1234567890ab",
    "nested": {
        "Authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmno",
        "client_secret": "s3cr3t-value-here",
        "connectionString": "Server=x;Password=p;",
        "safe": "keep-me",
    },
    "certBody": "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----",
    "items": [{"apiKey": "abc"}, {"note": "fine"}],
}
clean, touched = redact(payload)

check("redaction reports that it fired", touched is True)
eq("password redacted", clean["password"], REDACTED)
eq("secretAccessKey redacted", clean["secretAccessKey"], REDACTED)
eq("Authorization header redacted", clean["nested"]["Authorization"], REDACTED)
eq("client_secret redacted (snake_case spelling)",
   clean["nested"]["client_secret"], REDACTED)
eq("connectionString redacted", clean["nested"]["connectionString"], REDACTED)
eq("PEM private key redacted by value", clean["certBody"], REDACTED)
eq("apiKey inside a list redacted", clean["items"][0]["apiKey"], REDACTED)

# The deliberate exceptions: identifiers stay, because an investigation needs
# to know WHICH key was used.
eq("accessKeyId kept (identifier, not secret)",
   clean["accessKeyId"], "AKIAIOSFODNN7EXAMPLE")
eq("keyId kept (identifier)", clean["keyId"], "1234abcd-12ab-34cd-56ef-1234567890ab")
eq("innocent values untouched", clean["nested"]["safe"], "keep-me")
eq("username untouched", clean["userName"], "saad")

# The input must not be mutated: classification runs against the original.
eq("input payload not mutated", payload["password"], "hunter2")

nothing, untouched = redact({"a": 1, "b": "hello"})
check("a clean payload reports no redaction", untouched is False)
eq("and comes back intact", nothing, {"a": 1, "b": "hello"})

deep = {"a": {}}
node = deep["a"]
for _ in range(30):
    node["n"] = {}
    node = node["n"]
clean_deep, deep_touched = redact(deep)
check("absurd nesting is truncated rather than recursing forever", deep_touched is True)


# ── 6. Classify-then-redact ordering ──────────────────────────────────────────
print("\n6. classification sees the payload BEFORE redaction removes it")

# The reason finalize() owns the order: a credential-bearing field can also be
# the field that proves the risk. Classifying after redaction would downgrade
# a CRITICAL to a MEDIUM.
result = classify(
    provider="AWS",
    event_name="AuthorizeSecurityGroupIngress",
    event_source="ec2.amazonaws.com",
    status="Success",
    actor_type="Human",
    request_parameters={"cidrIp": "0.0.0.0/0", "password": "hunter2"},
)
eq("risk still CRITICAL when the payload also holds a secret",
   result["risk_level"], "CRITICAL")

redacted_first, _ = redact({"cidrIp": "0.0.0.0/0", "password": "hunter2"})
after = classify(
    provider="AWS",
    event_name="AuthorizeSecurityGroupIngress",
    event_source="ec2.amazonaws.com",
    status="Success",
    actor_type="Human",
    request_parameters=redacted_first,
)
check("(and the marker survives redaction here, so ordering is belt-and-braces)",
      after["risk_level"] == "CRITICAL")


# ── 7. Access-method derivation never invents Console ─────────────────────────
print("\n7. access method")

eq("no user agent -> None (not 'Unknown')",
   EventAdapter.access_method_from_user_agent(None), None)
eq("empty user agent -> None",
   EventAdapter.access_method_from_user_agent(""), None)
eq("aws-cli -> CLI",
   EventAdapter.access_method_from_user_agent("aws-cli/2.15.0 Python/3.11"), "CLI")
eq("terraform -> Terraform",
   EventAdapter.access_method_from_user_agent(
       "APN/1.0 HashiCorp/1.0 Terraform/1.7.0"), "Terraform")
eq("signin console -> Console",
   EventAdapter.access_method_from_user_agent("signin.amazonaws.com"), "Console")
eq("a service principal agent -> Service",
   EventAdapter.access_method_from_user_agent("autoscaling.amazonaws.com"), "Service")
eq("boto3 -> SDK",
   EventAdapter.access_method_from_user_agent("Boto3/1.34.0 Python/3.11"), "SDK")
eq("a bare browser string -> API, never Console",
   EventAdapter.access_method_from_user_agent(
       "Mozilla/5.0 (Windows NT 10.0) Chrome/120"), "API")
eq("an unrecognised agent -> SDK, never Console",
   EventAdapter.access_method_from_user_agent("SomeUnknownClient/9"), "SDK")

eq("a value outside the vocabulary is dropped, not written through",
   EventAdapter.validate_access_method("Telepathy"), None)
eq("a valid value passes", EventAdapter.validate_access_method("CLI"), "CLI")


# ── 8. Identity helpers ───────────────────────────────────────────────────────
print("\n8. identity and timestamp helpers")

eq("an email is recognised",
   EventAdapter.email_or_none("saad@example.com"), "saad@example.com")
eq("a username is NOT turned into an email",
   EventAdapter.email_or_none("saad"), None)
eq("a GUID is NOT turned into an email",
   EventAdapter.email_or_none("c44b4083-3bb0-49c1-b47d-974e53cbdf3c"), None)
eq("an OCID is NOT turned into an email",
   EventAdapter.email_or_none("ocid1.user.oc1..aaaa"), None)

from datetime import datetime, timezone  # noqa: E402

eq("a Z-suffixed string parses to UTC",
   EventAdapter.as_utc("2026-09-08T09:02:11Z"),
   datetime(2026, 9, 8, 9, 2, 11, tzinfo=timezone.utc))
eq("an offset string is converted to UTC",
   EventAdapter.as_utc("2026-09-08T14:32:11+05:30"),
   datetime(2026, 9, 8, 9, 2, 11, tzinfo=timezone.utc))
eq("a naive datetime is stamped UTC, not shifted",
   EventAdapter.as_utc(datetime(2026, 9, 8, 9, 2, 11)),
   datetime(2026, 9, 8, 9, 2, 11, tzinfo=timezone.utc))
eq("garbage returns None rather than now()",
   EventAdapter.as_utc("not a timestamp"), None)
eq("None stays None", EventAdapter.as_utc(None), None)

# Truncation keeps the distinguishing tail of an identifier.
long_ocid = "ocid1.instance.oc1.ap-mumbai-1." + ("a" * 100) + "UNIQUE"
short = EventAdapter.short(long_ocid, 40)
check("truncation keeps the tail, which is what distinguishes two OCIDs",
      short.endswith("UNIQUE") and len(short) == 40, short)
eq("a short value is untouched", EventAdapter.short("abc", 40), "abc")

# The dedup fallback must be deterministic, or a re-poll creates a new row.
a = EventAdapter.fallback_event_id("AWS", "ap-south-1", "DeleteBucket", "t1")
b = EventAdapter.fallback_event_id("AWS", "ap-south-1", "DeleteBucket", "t1")
c = EventAdapter.fallback_event_id("AWS", "ap-south-1", "DeleteBucket", "t2")
check("the fallback id is deterministic (so dedup still works)", a == b)
check("and distinguishes different events", a != c)


# ── Result ────────────────────────────────────────────────────────────────────
print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    for name in fail:
        print(f"  ! {name}")
sys.exit(1 if fail else 0)
