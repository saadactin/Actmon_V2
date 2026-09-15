"""Provider adapter normalization — real payload shapes, no network.

Each provider's `_normalize` is exercised against a payload shaped exactly as
that provider's SDK returns it, so the assertions cover the part most likely to
be wrong: which provider field lands in which normalized column, and — just as
important — which columns stay NULL because the provider said nothing.

The AWS payload is a real CloudTrail record shape; the Azure and OCI ones are
built from stand-in objects with the same attribute names the SDKs use, since
those SDKs return typed models rather than dicts.
"""
import json
import pathlib
import sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.events.adapters.aws_adapter import AWSEventAdapter  # noqa: E402
from app.events.adapters.azure_adapter import AzureEventAdapter  # noqa: E402
from app.events.adapters.oci_adapter import OCIEventAdapter  # noqa: E402
from app.events.adapters.base import (  # noqa: E402
    ERROR_AUTH,
    ERROR_DENIED,
    ERROR_UNAVAILABLE,
    classify_error,
    is_rate_limit,
)

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


class Obj:
    """Stand-in for an SDK model: attribute access over a dict."""

    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


class Localizable:
    def __init__(self, value, localized=None):
        self.value = value
        self.localized_value = localized or value


# ══ AWS ═══════════════════════════════════════════════════════════════════════
print("1. AWS CloudTrail")

aws = AWSEventAdapter.__new__(AWSEventAdapter)
aws.credentials = {}
aws.collect_read_only = False
aws._account_id = "123456789012"

cloudtrail_detail = {
    "eventVersion": "1.09",
    "userIdentity": {
        "type": "AssumedRole",
        "principalId": "AROAEXAMPLEID:saad-session",
        "arn": "arn:aws:sts::123456789012:assumed-role/SecurityAdministrator/saad-session",
        "accountId": "123456789012",
        "accessKeyId": "ASIAEXAMPLEKEY",
        "sessionContext": {
            "sessionIssuer": {
                "type": "Role",
                "principalId": "AROAEXAMPLEID",
                "arn": "arn:aws:iam::123456789012:role/SecurityAdministrator",
                "accountId": "123456789012",
                "userName": "SecurityAdministrator",
            },
            "webIdFederationData": {"federatedProvider": "AWS SSO"},
            "attributes": {"creationDate": "2026-09-08T09:00:00Z",
                           "mfaAuthenticated": "true"},
        },
    },
    "eventTime": "2026-09-08T09:02:11Z",
    "eventSource": "ec2.amazonaws.com",
    "eventName": "AuthorizeSecurityGroupIngress",
    "awsRegion": "ap-south-1",
    "sourceIPAddress": "10.20.30.40",
    "userAgent": "signin.amazonaws.com",
    "requestParameters": {
        "groupId": "sg-123456789",
        "ipPermissions": {"items": [{
            "ipProtocol": "tcp", "fromPort": 22, "toPort": 22,
            "ipRanges": {"items": [{"cidrIp": "0.0.0.0/0"}]},
        }]},
    },
    "responseElements": {"requestId": "abc-req", "_return": True},
    "requestID": "9c8d7-request-id",
    "eventID": "8f92-event-id",
    "readOnly": False,
    "eventType": "AwsApiCall",
    "managementEvent": True,
    "recipientAccountId": "123456789012",
    "resources": [{
        "ARN": "arn:aws:ec2:ap-south-1:123456789012:security-group/sg-123456789",
        "accountId": "123456789012",
        "type": "AWS::EC2::SecurityGroup",
    }],
}

record = {
    "EventId": "8f92-event-id",
    "EventName": "AuthorizeSecurityGroupIngress",
    "EventTime": datetime(2026, 9, 8, 9, 2, 11, tzinfo=timezone.utc),
    "Username": "saad-session",
    "CloudTrailEvent": json.dumps(cloudtrail_detail),
    "Resources": [],
}

event = aws._normalize(record, "ap-south-1")
check("normalizes a CloudTrail record", event is not None)

eq("provider", event.provider, "AWS")
eq("dedup id is the CloudTrail eventID", event.provider_event_id, "8f92-event-id")
eq("timestamp is UTC-aware", event.timestamp,
   datetime(2026, 9, 8, 9, 2, 11, tzinfo=timezone.utc))
eq("event name", event.event_name, "AuthorizeSecurityGroupIngress")
eq("event source", event.event_source, "ec2.amazonaws.com")
eq("status is Success (no errorCode present)", event.status, "Success")
eq("region", event.region, "ap-south-1")
eq("account_ref", event.account_ref, "123456789012")
eq("source IP", event.source_ip, "10.20.30.40")
eq("request id", event.request_id, "9c8d7-request-id")
eq("read_only from the provider's own flag", event.read_only, False)

# Actor: an assumed role, with the session name as the human-ish identifier.
eq("actor type is IAMRole for an AssumedRole", event.actor_type, "IAMRole")
eq("actor name prefers the session name", event.actor_name, "saad-session")
eq("actor id is the principalId", event.actor_id, "AROAEXAMPLEID:saad-session")
eq("actor role is the assumed role's ARN", event.actor_role,
   "arn:aws:iam::123456789012:role/SecurityAdministrator")
check("auth method records MFA", "MFA" in (event.actor_auth_method or ""),
      event.actor_auth_method)
check("no email is invented from a session name", event.actor_email is None,
      event.actor_email)

# The role-assumption chain — the whole point of AWS actor handling.
chain = event.actor_chain or []
eq("chain has three recorded hops", len(chain), 3)
eq("hop 1 is the federation provider", chain[0]["name"], "AWS SSO")
eq("hop 2 is the assumed role", chain[1]["name"], "SecurityAdministrator")
eq("hop 3 is the operation", chain[2]["name"], "AuthorizeSecurityGroupIngress")

# Resource, from CloudTrail's own resources array.
eq("resource id is the ARN", event.resource_id,
   "arn:aws:ec2:ap-south-1:123456789012:security-group/sg-123456789")
eq("resource type is the readable tail", event.resource_type, "SecurityGroup")
eq("resource name", event.resource_name, "sg-123456789")

# Classification, end to end through finalize().
eq("action", event.action, "Authorize")
eq("category", event.event_category, "Network")
eq("risk is CRITICAL — 0.0.0.0/0 was in the payload", event.risk_level, "CRITICAL")
check("and the reason names the CIDR", "0.0.0.0/0" in (event.risk_reason or ""),
      event.risk_reason)

# Access method: the user agent says the console.
eq("access method from the user agent", event.access_method, "Console")

# The request parameters are metadata, NOT a before/after diff.
check("request parameters kept in provider_metadata",
      event.provider_metadata.get("request_parameters") is not None)
check("and explicitly labelled as not a diff",
      "not a before/after" in (
          event.provider_metadata.get("request_parameters_note") or ""))
check("change_before stays NULL for AWS (it reports no prior state)",
      event.change_before is None)
check("change_after stays NULL for AWS", event.change_after is None)
check("raw event preserved", (event.raw_event or {}).get("eventVersion") == "1.09")

# ── A denial, which must not be folded into Failed ────────────────────────────
denied_detail = dict(cloudtrail_detail)
denied_detail["errorCode"] = "Client.UnauthorizedOperation"
denied_detail["errorMessage"] = "You are not authorized to perform this operation."
denied = aws._normalize(
    {"EventId": "denied-1", "CloudTrailEvent": json.dumps(denied_detail)}, "ap-south-1"
)
eq("an unauthorized operation is Denied, not Failed", denied.status, "Denied")
eq("error code captured", denied.error_code, "Client.UnauthorizedOperation")
check("error message captured", bool(denied.error_message))

failed_detail = dict(cloudtrail_detail)
failed_detail["errorCode"] = "InvalidParameterValue"
failed = aws._normalize(
    {"EventId": "failed-1", "CloudTrailEvent": json.dumps(failed_detail)}, "ap-south-1"
)
eq("a parameter error is Failed, not Denied", failed.status, "Failed")

# ── Root usage ────────────────────────────────────────────────────────────────
root_detail = dict(cloudtrail_detail)
root_detail["userIdentity"] = {
    "type": "Root", "principalId": "123456789012",
    "arn": "arn:aws:iam::123456789012:root", "accountId": "123456789012",
}
root_detail["eventName"] = "DescribeInstances"
root_detail["readOnly"] = True
root_detail.pop("requestParameters", None)
root = aws._normalize(
    {"EventId": "root-1", "CloudTrailEvent": json.dumps(root_detail)}, "ap-south-1"
)
eq("root identity maps to RootAccount", root.actor_type, "RootAccount")
eq("root is named, not left as an account number", root.actor_name, "root")
eq("root usage is CRITICAL even for a read", root.risk_level, "CRITICAL")

# ── A service acting on its own behalf ────────────────────────────────────────
svc_detail = dict(cloudtrail_detail)
svc_detail["userIdentity"] = {
    "type": "AWSService", "invokedBy": "autoscaling.amazonaws.com",
}
svc_detail["eventName"] = "RunInstances"
svc_detail["userAgent"] = "autoscaling.amazonaws.com"
svc_detail.pop("requestParameters", None)
svc = aws._normalize(
    {"EventId": "svc-1", "CloudTrailEvent": json.dumps(svc_detail)}, "ap-south-1"
)
eq("an AWS service is CloudService, never Human", svc.actor_type, "CloudService")
eq("named by its service principal", svc.actor_name, "autoscaling.amazonaws.com")
eq("access method is Service", svc.access_method, "Service")
eq("routine service activity is demoted to LOW", svc.risk_level, "LOW")

# ── Malformed input ───────────────────────────────────────────────────────────
eq("a record with no parseable time is rejected, not stored with a fake time",
   aws._normalize({"EventId": "x", "CloudTrailEvent": "{}"}, "ap-south-1"), None)

unparseable = aws._normalize(
    {"EventId": "y", "EventName": "Whatever",
     "EventTime": datetime(2026, 9, 8, tzinfo=timezone.utc),
     "CloudTrailEvent": "not json at all"},
    "ap-south-1",
)
check("an unparseable payload still yields an event from the summary fields",
      unparseable is not None)
eq("with status Unknown rather than an assumed Success",
   unparseable.status, "Unknown")

# ── Resource fallback from request parameters ─────────────────────────────────
no_resources = dict(cloudtrail_detail)
no_resources["resources"] = []
fallback = aws._normalize(
    {"EventId": "fb-1", "CloudTrailEvent": json.dumps(no_resources)}, "ap-south-1"
)
eq("falls back to a NAMED request parameter for the resource",
   fallback.resource_id, "sg-123456789")
eq("with the type that parameter identifies", fallback.resource_type, "SecurityGroup")


# ══ Azure ═════════════════════════════════════════════════════════════════════
print("\n2. Azure Activity Log")

azure = AzureEventAdapter.__new__(AzureEventAdapter)
azure.credentials = {}
azure.collect_read_only = False

azure_record = Obj(
    event_timestamp=datetime(2026, 9, 8, 9, 2, 11, tzinfo=timezone.utc),
    submission_timestamp=datetime(2026, 9, 8, 9, 2, 13, tzinfo=timezone.utc),
    event_data_id="e1b2c3d4-event-data-id",
    correlation_id="corr-1234",
    operation_id="op-5678",
    operation_name=Localizable(
        "Microsoft.Network/networkSecurityGroups/securityRules/write"),
    category=Localizable("Administrative"),
    status=Localizable("Succeeded"),
    sub_status=Localizable("Created"),
    resource_provider_name=Localizable("Microsoft.Network"),
    resource_type=Localizable("Microsoft.Network/networkSecurityGroups/securityRules"),
    resource_id=(
        "/subscriptions/sub-1111/resourceGroups/prod-rg/providers/"
        "Microsoft.Network/networkSecurityGroups/Production-Web-NSG/securityRules/allow-ssh"
    ),
    resource_group_name="prod-rg",
    subscription_id="sub-1111",
    tenant_id="tenant-2222",
    caller="saad@example.com",
    level="Informational",
    description="",
    id="/subscriptions/sub-1111/.../events/e1b2c3d4",
    claims={
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn": "saad@example.com",
        "http://schemas.microsoft.com/identity/claims/objectidentifier": "obj-9999",
        "appid": "c44b4083-3bb0-49c1-b47d-974e53cbdf3c",
        "name": "Saad",
        "http://schemas.microsoft.com/claims/authnmethodsreferences": "pwd,mfa",
    },
    authorization=Obj(
        action="Microsoft.Network/networkSecurityGroups/securityRules/write",
        role="Network Contributor",
        scope="/subscriptions/sub-1111/resourceGroups/prod-rg",
    ),
    http_request=Obj(
        method="PUT", uri="https://management.azure.com/...",
        client_ip_address="10.20.30.41", client_request_id="client-req-1",
    ),
    properties={
        "statusCode": "Created",
        "requestbody": '{"properties":{"sourceAddressPrefix":"0.0.0.0/0",'
                       '"destinationPortRange":"22","access":"Allow"}}',
    },
    event_name=Localizable("EndRequest"),
)

az = azure._normalize(azure_record)
check("normalizes an Activity Log record", az is not None)

eq("provider", az.provider, "Azure")
eq("dedup id is the eventDataId", az.provider_event_id, "e1b2c3d4-event-data-id")
eq("timestamp", az.timestamp, datetime(2026, 9, 8, 9, 2, 11, tzinfo=timezone.utc))
eq("provider_received_at from submissionTimestamp", az.provider_received_at,
   datetime(2026, 9, 8, 9, 2, 13, tzinfo=timezone.utc))
eq("event name is the meaningful tail, not just 'write'",
   az.event_name, "securityRules/write")
eq("api_operation is the full ARM operation string", az.api_operation,
   "Microsoft.Network/networkSecurityGroups/securityRules/write")
eq("event source is the resource provider", az.event_source, "Microsoft.Network")
eq("provider category kept verbatim", az.provider_category, "Administrative")
eq("status", az.status, "Success")
eq("http status from the reason phrase", az.http_status, 201)
eq("http method as recorded", az.http_method, "PUT")
eq("read_only is False for a /write", az.read_only, False)
eq("correlation id", az.correlation_id, "corr-1234")
eq("source IP", az.source_ip, "10.20.30.41")
check("no user agent is invented (Azure supplies none)", az.user_agent is None)

eq("actor type is Human (a upn claim is present)", az.actor_type, "Human")
eq("actor name from the upn", az.actor_name, "saad@example.com")
eq("actor email", az.actor_email, "saad@example.com")
eq("actor id from the objectidentifier claim", az.actor_id, "obj-9999")
eq("actor role from SenderAuthorization", az.actor_role, "Network Contributor")
check("auth method records the claimed methods",
      "pwd" in (az.actor_auth_method or "") and "mfa" in (az.actor_auth_method or ""),
      az.actor_auth_method)
eq("access method from the Azure Portal app id", az.access_method, "Console")
eq("chain records the client app and the principal", len(az.actor_chain or []), 2)

eq("subscription", az.subscription_id, "sub-1111")
eq("tenant", az.tenant_id, "tenant-2222")
eq("resource group", az.resource_group, "prod-rg")
eq("resource name is the ARM id's last segment", az.resource_name, "allow-ssh")
eq("resource type is the readable tail", az.resource_type, "securityRules")
check("region stays NULL — Activity Log carries none", az.region is None)

eq("action from the /write suffix", az.action, "Update")
eq("category", az.event_category, "Network")
eq("risk is CRITICAL — 0.0.0.0/0 in the properties payload", az.risk_level, "CRITICAL")

check("no error code on a successful event", az.error_code is None, az.error_code)
check("change_before stays NULL for Azure", az.change_before is None)
check("properties kept, labelled as not a diff",
      "not a before/after" in (az.provider_metadata.get("properties_note") or ""))

# ── An in-flight record ───────────────────────────────────────────────────────
started = Obj(**{**azure_record.__dict__})
started.status = Localizable("Started")
started.sub_status = Localizable("")
started.event_data_id = "started-1"
started.properties = {}
az_started = azure._normalize(started)
eq("a 'Started' record is Partial, not Success", az_started.status, "Partial")

# ── A refusal ─────────────────────────────────────────────────────────────────
refused = Obj(**{**azure_record.__dict__})
refused.status = Localizable("Failed")
refused.sub_status = Localizable("Forbidden")
refused.event_data_id = "denied-1"
refused.properties = {"statusCode": "Forbidden",
                      "statusMessage": "The client does not have authorization."}
az_denied = azure._normalize(refused)
eq("Failed + Forbidden is Denied", az_denied.status, "Denied")
eq("http status 403", az_denied.http_status, 403)
eq("error code recorded", az_denied.error_code, "Forbidden")
check("error message recorded", bool(az_denied.error_message))

# ── A service principal ───────────────────────────────────────────────────────
sp = Obj(**{**azure_record.__dict__})
sp.event_data_id = "sp-1"
sp.caller = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
sp.claims = {"idtyp": "app", "appid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}
sp.properties = {}
az_sp = azure._normalize(sp)
eq("an app-only token is a ServicePrincipal, never Human",
   az_sp.actor_type, "ServicePrincipal")
check("and no email is fabricated from a GUID", az_sp.actor_email is None)
check("an unrecognised appid yields no access method",
      az_sp.access_method is None, az_sp.access_method)

# ── A read, which must be droppable ───────────────────────────────────────────
read = Obj(**{**azure_record.__dict__})
read.event_data_id = "read-1"
read.operation_name = Localizable("Microsoft.Compute/virtualMachines/read")
read.properties = {}
az_read = azure._normalize(read)
eq("a /read is flagged read_only", az_read.read_only, True)
eq("and classified as a Read", az_read.action, "Read")

check("a record with no timestamp is rejected",
      azure._normalize(Obj(event_timestamp=None)) is None)


# ══ OCI ═══════════════════════════════════════════════════════════════════════
print("\n3. OCI Audit")

oci_a = OCIEventAdapter.__new__(OCIEventAdapter)
oci_a.credentials = {}
oci_a.collect_read_only = False
oci_a._compartment_names = {"ocid1.compartment.oc1..prod": "production"}


class FakeAuth:
    tenancy_ocid = "ocid1.tenancy.oc1..tenancy"
    region = "ap-mumbai-1"


oci_a.auth = FakeAuth()

oci_record = Obj(
    event_id="oci-event-1",
    event_time=datetime(2026, 9, 8, 9, 2, 11, tzinfo=timezone.utc),
    event_type="com.oraclecloud.virtualnetwork.updatesecuritylist",
    event_type_version="2.0",
    cloud_events_version="0.1",
    source="virtualNetwork",
    content_type="application/json",
    data=Obj(
        event_name="UpdateSecurityList",
        compartment_id="ocid1.compartment.oc1..prod",
        compartment_name="production",
        resource_id="ocid1.securitylist.oc1.ap-mumbai-1..seclist1",
        resource_name="Production-Web-SecList",
        availability_domain="hpAD:AP-MUMBAI-1-AD-1",
        additional_details={"vcnId": "ocid1.vcn.oc1..vcn1"},
        identity=Obj(
            principal_id="ocid1.user.oc1..saad",
            principal_name="saad@example.com",
            principal_type="user",
            auth_type="natv",
            tenant_id="ocid1.tenancy.oc1..tenancy",
            ip_address="10.20.30.42",
            user_agent="Oracle-JavaSDK/3.34.0",
            console_session_id=None,
            credentials="ab:cd:ef:12:34:56",
        ),
        request=Obj(
            id="req-oci-1",
            path="/20160918/securityLists/ocid1.securitylist.oc1..seclist1",
            action="PUT",
            headers={"content-type": ["application/json"],
                     "authorization": ["Signature keyId=..."]},
            parameters={},
        ),
        response=Obj(
            status="200",
            response_time=datetime(2026, 9, 8, 9, 2, 12, tzinfo=timezone.utc),
            message=None,
            headers={},
            payload={},
        ),
        # The one provider that reports genuine prior state.
        state_change=Obj(
            previous={"ingressSecurityRules": [
                {"source": "0.0.0.0/0", "protocol": "6", "tcpOptions": {"max": 22}}],
                "displayName": "Production-Web-SecList"},
            current={"ingressSecurityRules": [
                {"source": "10.10.0.0/16", "protocol": "6", "tcpOptions": {"max": 22}}],
                "displayName": "Production-Web-SecList"},
        ),
    ),
)

oc = oci_a._normalize(oci_record, "ap-mumbai-1", "ocid1.compartment.oc1..prod")
check("normalizes an OCI audit event", oc is not None)

eq("provider", oc.provider, "OCI")
eq("dedup id is the OCI eventId", oc.provider_event_id, "oci-event-1")
eq("timestamp", oc.timestamp, datetime(2026, 9, 8, 9, 2, 11, tzinfo=timezone.utc))
eq("event name", oc.event_name, "UpdateSecurityList")
eq("event source", oc.event_source, "virtualNetwork")
eq("api_operation is the cloud-event type", oc.api_operation,
   "com.oraclecloud.virtualnetwork.updatesecuritylist")
eq("http method from the request action", oc.http_method, "PUT")
eq("status from the HTTP status", oc.status, "Success")
eq("http status", oc.http_status, 200)
eq("read_only False for a PUT", oc.read_only, False)
eq("region", oc.region, "ap-mumbai-1")
eq("compartment id", oc.compartment_id, "ocid1.compartment.oc1..prod")
eq("compartment name", oc.compartment_name, "production")
eq("tenancy", oc.tenancy_id, "ocid1.tenancy.oc1..tenancy")
eq("request id", oc.request_id, "req-oci-1")
check("correlation id stays NULL — OCI has no separate one",
      oc.correlation_id is None)

eq("actor type is Human for principalType=user", oc.actor_type, "Human")
eq("actor name", oc.actor_name, "saad@example.com")
eq("actor email (the principal name genuinely is one)",
   oc.actor_email, "saad@example.com")
eq("actor id is the user OCID", oc.actor_id, "ocid1.user.oc1..saad")
check("auth method describes the native API-key auth",
      "Native" in (oc.actor_auth_method or ""), oc.actor_auth_method)
eq("access method from the SDK user agent", oc.access_method, "SDK")
check("no role is claimed — OCI does not report one on an audit event",
      oc.actor_role is None)

eq("resource id", oc.resource_id, "ocid1.securitylist.oc1.ap-mumbai-1..seclist1")
eq("resource name", oc.resource_name, "Production-Web-SecList")
eq("resource type from the OCID's own structure", oc.resource_type, "securitylist")

# The before/after diff — the thing only OCI can supply.
check("change_before populated from stateChange.previous", oc.change_before is not None)
check("change_after populated from stateChange.current", oc.change_after is not None)
eq("changed_fields names only what actually moved",
   oc.changed_fields, ["ingressSecurityRules"])
check("the unchanged field is NOT reported as changed",
      "displayName" not in (oc.changed_fields or []))

eq("action", oc.action, "Update")
eq("category", oc.event_category, "Network")

# Redaction reached into the raw payload.
raw_headers = (((oc.raw_event or {}).get("data") or {}).get("request") or {}).get("headers") or {}
check("the authorization header was redacted before storage",
      raw_headers.get("authorization") == "[REDACTED]"
      or raw_headers.get("authorization") == ["[REDACTED]"]
      or "REDACTED" in json.dumps(raw_headers),
      json.dumps(raw_headers)[:200])
check("and the event is flagged as redacted", oc.redacted is True)

# ── Creation: current only, no previous ───────────────────────────────────────
created = Obj(**{**oci_record.__dict__})
created.event_id = "oci-create-1"
created.data = Obj(**{**oci_record.data.__dict__})
created.data.event_name = "CreateBucket"
created.data.state_change = Obj(previous=None, current={"name": "new-bucket"})
oc_created = oci_a._normalize(created, "ap-mumbai-1", "ocid1.compartment.oc1..prod")
check("change_before is NULL when OCI reports no previous state",
      oc_created.change_before is None)
check("change_after is still populated", oc_created.change_after is not None)
eq("and no fields are claimed as 'changed' without a before",
   oc_created.changed_fields, None)

# ── A permission failure reported as 404 ──────────────────────────────────────
notfound = Obj(**{**oci_record.__dict__})
notfound.event_id = "oci-404"
notfound.data = Obj(**{**oci_record.data.__dict__})
notfound.data.response = Obj(status="404", message="Authorization failed or requested "
                                                   "resource not found.",
                             headers={}, payload={}, response_time=None)
oc_404 = oci_a._normalize(notfound, "ap-mumbai-1", "ocid1.compartment.oc1..prod")
eq("OCI's 404-for-forbidden is treated as Denied", oc_404.status, "Denied")
eq("http status kept as reported", oc_404.http_status, 404)
eq("error code recorded", oc_404.error_code, "404")

# ── An instance principal ─────────────────────────────────────────────────────
machine = Obj(**{**oci_record.__dict__})
machine.event_id = "oci-instance-1"
machine.data = Obj(**{**oci_record.data.__dict__})
machine.data.identity = Obj(
    principal_id="ocid1.instance.oc1..inst1", principal_name="instance-principal",
    principal_type="instance", auth_type="instance",
    tenant_id="ocid1.tenancy.oc1..tenancy", ip_address="10.0.0.5",
    user_agent=None, console_session_id=None, credentials=None,
)
oc_machine = oci_a._normalize(machine, "ap-mumbai-1", "ocid1.compartment.oc1..prod")
eq("an instance principal is a ServicePrincipal", oc_machine.actor_type,
   "ServicePrincipal")
eq("access method is Automation, stated by the auth type not guessed",
   oc_machine.access_method, "Automation")

# ── The tenancy administrator ─────────────────────────────────────────────────
root_oci = Obj(**{**oci_record.__dict__})
root_oci.event_id = "oci-root-1"
root_oci.data = Obj(**{**oci_record.data.__dict__})
root_oci.data.identity = Obj(
    principal_id="ocid1.tenancy.oc1..tenancy", principal_name="tenancy-admin",
    principal_type="user", auth_type="natv",
    tenant_id="ocid1.tenancy.oc1..tenancy", ip_address="10.0.0.6",
    user_agent=None, console_session_id=None, credentials=None,
)
oc_root = oci_a._normalize(root_oci, "ap-mumbai-1", "ocid1.compartment.oc1..prod")
eq("a principal equal to the tenancy is RootAccount", oc_root.actor_type, "RootAccount")
eq("and is CRITICAL", oc_root.risk_level, "CRITICAL")

# The OCI SDK hangs its own schema dicts on every model instance. They are not
# part of the audit event, and storing them tripled a payload's size and buried
# the real content in the Raw Event viewer. Found on live OCI data.
raw_text = json.dumps(oc.raw_event)
check("SDK reflection metadata is stripped from the stored raw payload",
      "swagger_types" not in raw_text and "attribute_map" not in raw_text,
      raw_text[:160])
check("but the provider's own fields survive",
      (oc.raw_event or {}).get("event_type") == "com.oraclecloud.virtualnetwork.updatesecuritylist"
      and ((oc.raw_event or {}).get("data") or {}).get("resource_name") == "Production-Web-SecList")

check("a record with no data block is rejected",
      oci_a._normalize(Obj(event_time=datetime.now(timezone.utc), data=None),
                       "ap-mumbai-1", "c") is None)
check("a record with no time is rejected",
      oci_a._normalize(Obj(event_time=None, data=Obj()), "ap-mumbai-1", "c") is None)


# ══ Error classification ══════════════════════════════════════════════════════
print("\n4. failure classification")


class Denied(Exception):
    pass


eq("an AccessDenied message is a denial",
   classify_error(Denied("User: arn:... is not authorized to perform: cloudtrail:LookupEvents")),
   ERROR_DENIED)
eq("an expired token is an auth failure",
   classify_error(Exception("The security token included in the request is expired")),
   ERROR_AUTH)
eq("a signature mismatch is an auth failure",
   classify_error(Exception("SignatureDoesNotMatch")), ERROR_AUTH)
eq("a dropped connection is unavailability, not lost access",
   classify_error(Exception("Connection was closed before we received a valid response")),
   ERROR_UNAVAILABLE)
eq("a read timeout is unavailability",
   classify_error(Exception("Read timed out")), ERROR_UNAVAILABLE)

check("throttling is detected", is_rate_limit(Exception("ThrottlingException: Rate exceeded")))
check("HTTP 429 is detected", is_rate_limit(Exception("TooManyRequests (429)")))
check("a denial is NOT treated as throttling",
      not is_rate_limit(Denied("AccessDenied")))


# ── Result ────────────────────────────────────────────────────────────────────
print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    for name in fail:
        print(f"  ! {name}")
sys.exit(1 if fail else 0)
