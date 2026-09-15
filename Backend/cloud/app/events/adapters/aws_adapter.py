"""AWS CloudTrail adapter.

Reads management events through `cloudtrail:LookupEvents`, which is the API
behind the console's "Event history" — no trail, no S3 bucket and no Athena
required, so it works on any account whose credentials can read CloudTrail.
The trade-off is stated plainly to the user rather than hidden: LookupEvents
serves **management events from the last 90 days only**, and no configuration
of this application can reach further back.

Two things about CloudTrail shape the adapter:

*   The interesting payload is a JSON *string* in `CloudTrailEvent`, not the
    flat summary fields. `Username` in the summary is frequently absent or
    misleading (an assumed role reports the session name), so every field
    below is read from the parsed record and the summary is used only as a
    fallback.

*   `LookupEvents` is documented at **two requests per second per account**,
    and it is per-region. Nineteen regions polled in parallel is a throttle
    storm that collects less than a serial pass, so the base class's
    sequential scope walk is not a simplification here — it is the correct
    shape.

The role-assumption chain is the one piece of real reconstruction this adapter
does, and it is reconstruction from recorded fields, not inference: CloudTrail
records `sessionContext.sessionIssuer` (the role that was assumed) and, for a
federated session, the identity that assumed it. Walking those gives the human
behind an assumed role — the single most common question asked of an AWS audit
trail — without guessing at anything.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.events.adapters.base import (
    CollectedEvent,
    EventAdapter,
    ScopeResult,
    classify_error,
)
from app.models.cloud_event import (
    ACTOR_CLOUD_SERVICE,
    ACTOR_HUMAN,
    ACTOR_IAM_ROLE,
    ACTOR_ROOT,
    ACTOR_SERVICE_ACCOUNT,
    ACTOR_UNKNOWN,
    STATUS_DENIED,
    STATUS_FAILED,
    STATUS_SUCCESS,
    STATUS_UNKNOWN,
)
from app.providers.aws.aws_auth import AWSAuth

logger = logging.getLogger("cloud_svc.events.aws")

# CloudTrail error codes that mean "refused", as distinct from "tried and
# broke". A denial is a security-relevant event in its own right — a cluster of
# them is what reconnaissance looks like — so it gets its own status rather
# than being folded into Failed.
_DENIAL_CODES = frozenset(
    {
        "accessdenied", "accessdeniedexception", "unauthorizedoperation",
        "authfailure", "forbidden", "unauthorizedaccess",
        "notauthorized", "operationnotpermitted", "clientunauthorizederror",
        "invalidclienttokenid", "signaturedoesnotmatch",
    }
)

# CloudTrail identity types → our actor vocabulary. Straight from the
# documented `userIdentity.type` values.
_IDENTITY_TYPES = {
    "IAMUser": ACTOR_HUMAN,
    "Root": ACTOR_ROOT,
    "AssumedRole": ACTOR_IAM_ROLE,
    "Role": ACTOR_IAM_ROLE,
    "FederatedUser": ACTOR_HUMAN,
    "AWSService": ACTOR_CLOUD_SERVICE,
    "AWSAccount": ACTOR_SERVICE_ACCOUNT,
    "IdentityCenterUser": ACTOR_HUMAN,
    "Directory": ACTOR_HUMAN,
    "Unknown": ACTOR_UNKNOWN,
}


class AWSEventAdapter(EventAdapter):
    provider = "AWS"
    # CloudTrail Event history. A trail delivering to S3 keeps events for as
    # long as the bucket does, but this adapter reads Event history, so 90 is
    # the honest figure for what it can retrieve.
    provider_retention_days = 90

    def __init__(self, credentials: Dict[str, Any], *, collect_read_only: bool = False) -> None:
        super().__init__(credentials, collect_read_only=collect_read_only)
        self.auth = AWSAuth(credentials)
        self._account_id: Optional[str] = None

    # -- lifecycle ------------------------------------------------------------

    async def authenticate(self) -> bool:
        ok = await self.auth.validate()
        # The account id is needed on every event as `account_ref`, and STS has
        # just told us. Reading it here avoids a GetCallerIdentity per scope.
        try:
            import asyncio

            from app.providers.scan_pool import scan_pool

            def _identity():
                return self.auth.get_client("sts").get_caller_identity().get("Account")

            self._account_id = await asyncio.get_event_loop().run_in_executor(
                scan_pool(), _identity
            )
        except Exception as exc:
            # Not fatal: the account id also appears on each event as
            # `recipientAccountId`, so this is a convenience, not a dependency.
            logger.debug("Could not pre-read AWS account id: %s", exc)
        return ok

    async def scopes(self) -> List[str]:
        """One scope per enabled region.

        CloudTrail is regional, and a global-service event (IAM, STS,
        CloudFront) is recorded in us-east-1, so the home region alone would
        miss every IAM change — the events an audit trail exists for. The
        region list mirrors AWSScanner._get_regions: opted-in and
        opt-in-not-required only, because a region the account has not enabled
        answers with an endpoint error rather than an empty list.
        """
        counters = ScopeResult(scope="regions", events=[], complete=True)

        def _fetch():
            ec2 = self.auth.get_client("ec2")
            resp = ec2.describe_regions(
                Filters=[{"Name": "opt-in-status",
                          "Values": ["opt-in-not-required", "opted-in"]}]
            )
            return [r["RegionName"] for r in resp.get("Regions", [])]

        try:
            regions = await self._call(_fetch, label="describe_regions", counters=counters)
        except Exception as exc:
            logger.warning(
                "AWS region enumeration failed (%s) — collecting from the home "
                "region only. Global-service events (IAM, STS) live in us-east-1, "
                "so they may be missed until this succeeds.", exc,
            )
            regions = [self.auth.region]

        regions = sorted(set(regions or [self.auth.region]))
        # us-east-1 first: it carries the global-service events, so if a run is
        # cut short the most security-relevant scope has already been read.
        if "us-east-1" in regions:
            regions.remove("us-east-1")
            regions.insert(0, "us-east-1")
        return [f"region:{r}" for r in regions]

    @staticmethod
    def _parse_scope(scope: str) -> str:
        return scope.split(":", 1)[1] if ":" in scope else scope

    # -- collection -----------------------------------------------------------

    async def collect_scope(self, scope: str, start: datetime, end: datetime) -> ScopeResult:
        region = self._parse_scope(scope)
        result = ScopeResult(scope=scope, events=[], complete=False)

        # ReadOnly=false halves nothing and removes 80-95% of the volume: on a
        # busy account the read calls are the volume. Applied as an API-side
        # attribute filter rather than dropped after retrieval, so the pages we
        # pay for are the ones we keep.
        lookup_attributes = (
            [] if self.collect_read_only
            else [{"AttributeKey": "ReadOnly", "AttributeValue": "false"}]
        )

        next_token: Optional[str] = None
        pages = 0
        watermark: Optional[datetime] = None

        while pages < self._MAX_PAGES_PER_SCOPE:
            token = next_token

            def _page():
                client = self.auth.get_client("cloudtrail", region, slow_api=True)
                kwargs: Dict[str, Any] = {
                    "StartTime": start,
                    "EndTime": end,
                    "MaxResults": 50,
                }
                if lookup_attributes:
                    kwargs["LookupAttributes"] = lookup_attributes
                if token:
                    kwargs["NextToken"] = token
                return client.lookup_events(**kwargs)

            try:
                response = await self._call(
                    _page, label=f"lookup_events {region}", counters=result
                )
            except Exception as exc:
                result.error = f"{type(exc).__name__}: {exc}"
                result.error_kind = classify_error(exc)
                logger.warning(
                    "AWS CloudTrail lookup failed in %s: %s", region, result.error
                )
                # complete stays False, so the checkpoint holds and this window
                # is re-read next run. Whatever pages did succeed are kept —
                # they are real events, and discarding them would mean an
                # account with one flaky region never shows any events.
                return result

            pages += 1
            records = response.get("Events", []) or []

            for record in records:
                event = self._normalize(record, region)
                if event is None:
                    result.malformed += 1
                    continue
                result.events.append(event)
                if watermark is None or event.timestamp > watermark:
                    watermark = event.timestamp

            next_token = response.get("NextToken")
            if not next_token:
                result.complete = True
                break

        if next_token and pages >= self._MAX_PAGES_PER_SCOPE:
            # Bounded run, not a failure — but the window was NOT fully read,
            # so the checkpoint may only advance to what was actually seen.
            # Saying complete=True here would skip the unread remainder.
            result.complete = False
            result.error = (
                f"Stopped after {pages} pages to stay within the API budget; "
                f"the rest of this window will be read on the next run."
            )
            result.error_kind = None

        result.watermark = watermark
        return result

    # -- normalization --------------------------------------------------------

    def _normalize(self, record: Dict[str, Any], region: str) -> Optional[CollectedEvent]:
        """One LookupEvents record → one CollectedEvent.

        Returns None for a record whose CloudTrail payload cannot be parsed or
        that carries no event time. Those are counted as malformed rather than
        stored with a substituted timestamp: a guessed time silently relocates
        the event in every chronological view, which is worse than not having
        it.
        """
        raw_json = record.get("CloudTrailEvent")
        detail: Dict[str, Any] = {}
        if raw_json:
            try:
                detail = json.loads(raw_json)
            except (TypeError, ValueError):
                logger.debug("Unparseable CloudTrailEvent for %s", record.get("EventId"))
                detail = {}

        timestamp = self.as_utc(detail.get("eventTime")) or self.as_utc(record.get("EventTime"))
        if timestamp is None:
            return None

        event_name = detail.get("eventName") or record.get("EventName") or "UnknownEvent"
        event_source = detail.get("eventSource") or record.get("EventSource")
        error_code = detail.get("errorCode")
        error_message = detail.get("errorMessage")

        # ── Status ───────────────────────────────────────────────────────────
        # CloudTrail records no explicit success flag: the ABSENCE of errorCode
        # is what success looks like. A denial is separated out because "you
        # may not do this" and "this broke" need different responses.
        if error_code:
            # CloudTrail namespaces its error codes — "Client.UnauthorizedOperation",
            # "Client.InvalidPermission.Duplicate" — so an equality check against
            # the bare code name misses every denial EC2 reports. Matching on
            # containment is what makes "Client.UnauthorizedOperation" a denial
            # rather than a generic failure, which is the difference between a
            # HIGH-risk refusal on the first page and a MEDIUM buried in the noise.
            code = str(error_code).replace(" ", "").lower()
            status = (
                STATUS_DENIED
                if any(marker in code for marker in _DENIAL_CODES)
                else STATUS_FAILED
            )
        elif detail:
            status = STATUS_SUCCESS
        else:
            # No parsed payload at all — we genuinely do not know how it went.
            status = STATUS_UNKNOWN

        identity = detail.get("userIdentity") or {}
        actor = self._actor(identity, record, detail)

        request_params = detail.get("requestParameters")
        response_elements = detail.get("responseElements")

        resources = self._resources(record, detail)
        primary = resources[0] if resources else {}

        user_agent = detail.get("userAgent")
        access_method = self.validate_access_method(
            self._access_method(identity, user_agent, detail)
        )

        event = CollectedEvent(
            provider="AWS",
            provider_event_id=(
                detail.get("eventID")
                or record.get("EventId")
                # No event id at all is unexpected but survivable; the hash
                # keeps dedup working rather than creating a row per poll.
                or self.fallback_event_id(
                    "AWS", region, event_name, timestamp.isoformat(),
                    actor["actor_id"], primary.get("id"),
                )
            )[:256],
            timestamp=timestamp,
            event_name=self.short(event_name, 256),
            event_source=self.short(event_source, 256),
            # For AWS the API name IS the event name; api_operation is filled so
            # the column means the same thing on all three providers.
            api_operation=self.short(
                f"{event_source}:{event_name}" if event_source else event_name, 512
            ),
            provider_category=detail.get("eventCategory") or "Management",
            read_only=self._read_only(record, detail),
            status=status,
            actor_id=self.short(actor["actor_id"], 512),
            actor_name=self.short(actor["actor_name"], 512),
            actor_email=actor["actor_email"],
            actor_type=actor["actor_type"],
            actor_role=self.short(actor["actor_role"], 512),
            actor_auth_method=self.short(actor["auth_method"], 120),
            actor_chain=actor["chain"] or None,
            account_ref=self.short(
                detail.get("recipientAccountId")
                or identity.get("accountId")
                or self._account_id, 256,
            ),
            region=self.short(detail.get("awsRegion") or region, 80),
            resource_id=self.short(primary.get("id"), 1024),
            resource_name=self.short(primary.get("name"), 512),
            resource_type=self.short(primary.get("type"), 120),
            resources=resources[1:] or None,
            source_ip=self.short(detail.get("sourceIPAddress"), 64),
            user_agent=user_agent,
            access_method=access_method,
            request_id=self.short(detail.get("requestID"), 256),
            # CloudTrail has no correlation id of its own. The shared-context
            # id it does have is the session, so events from one assumed-role
            # session can be related; leaving correlation_id NULL is the honest
            # answer rather than duplicating the request id into it.
            session_id=self.short(
                ((identity.get("sessionContext") or {}).get("attributes") or {})
                .get("creationDate"), 256,
            ),
            trace_id=self.short(detail.get("traceId") or detail.get("sharedEventID"), 256),
            error_code=self.short(error_code, 256),
            error_message=error_message,
            provider_metadata=self._metadata(detail, identity, request_params, response_elements),
            raw_event=detail or {"lookupSummary": self.to_jsonable(record)},
        )

        return self.finalize(
            event,
            request_parameters=request_params,
            response_elements=response_elements,
        )

    # -- field extraction -----------------------------------------------------

    def _actor(
        self, identity: Dict[str, Any], record: Dict[str, Any], detail: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Who made the call, and the chain that got them there.

        The chain is built only from what CloudTrail records. `sessionIssuer`
        names the role that was assumed and the account it lives in;
        `webIdFederationData` / `federatedProvider` name the identity provider
        for an SSO session. Where those are absent the chain is empty, which
        means "single-hop or not recorded" — not "we could not work it out",
        because there was nothing to work out.
        """
        raw_type = identity.get("type") or "Unknown"
        actor_type = _IDENTITY_TYPES.get(raw_type, ACTOR_UNKNOWN)

        session = identity.get("sessionContext") or {}
        attributes = session.get("attributes") or {}
        issuer = session.get("sessionIssuer") or {}
        web_identity = session.get("webIdFederationData") or {}

        # ── Display name ─────────────────────────────────────────────────────
        # Priority is "most human first". For an assumed role the session name
        # is often the human's identifier (SSO writes the username there), so
        # it beats the ARN. `Username` from the lookup summary is last: it is
        # the field most often blank or set to the role name.
        actor_name = (
            identity.get("userName")
            or attributes.get("sessionName")
            # An ARN's identifying part is its tail, but the separator differs:
            # a user/role ARN ends "…:user/saad" while the root ARN ends
            # "…::123456789012:root" with no slash at all. Splitting on only
            # "/" left root named by its full ARN — which reads like any other
            # principal, when "root" is precisely the thing that needs to stand
            # out. Splitting on both gives the right tail for either shape.
            or ((identity.get("arn") or "").rsplit("/", 1)[-1].rsplit(":", 1)[-1] or None)
            or identity.get("invokedBy")
            or record.get("Username")
        )

        if raw_type == "AWSService":
            # `invokedBy` is the service principal ("autoscaling.amazonaws.com").
            actor_name = identity.get("invokedBy") or actor_name

        chain: List[Dict[str, Any]] = []
        federated = web_identity.get("federatedProvider")
        if federated:
            chain.append({
                "step": "Federation",
                "type": "IdentityProvider",
                "name": federated,
                "id": (web_identity.get("attributes") or {}).get("cognito-identity.amazonaws.com:sub"),
            })
        if issuer:
            chain.append({
                "step": "AssumedRole",
                "type": issuer.get("type") or "Role",
                "name": issuer.get("userName") or (issuer.get("arn") or "").rsplit("/", 1)[-1],
                "id": issuer.get("principalId"),
                "arn": issuer.get("arn"),
                "account": issuer.get("accountId"),
            })
        if chain:
            chain.append({
                "step": "Operation",
                "type": "APICall",
                "name": detail.get("eventName"),
                "id": detail.get("eventID"),
            })

        # ── Authentication method ────────────────────────────────────────────
        # Assembled only from recorded fields. MFA presence is a documented
        # boolean, so it is reported; where nothing is recorded the value is
        # None and the UI says "Not available".
        auth_bits: List[str] = []
        if attributes.get("mfaAuthenticated") == "true":
            auth_bits.append("MFA")
        response_elements = detail.get("responseElements") or {}
        if detail.get("eventName") == "ConsoleLogin":
            auth_bits.append("Console login")
            if isinstance(response_elements, dict) and response_elements.get("ConsoleLogin"):
                auth_bits.append(str(response_elements["ConsoleLogin"]))
        elif raw_type == "AssumedRole":
            auth_bits.append("Assumed role")
        elif raw_type == "IAMUser" and identity.get("accessKeyId"):
            auth_bits.append("Access key")
        elif raw_type == "AWSService":
            auth_bits.append("Service principal")

        return {
            "actor_id": identity.get("principalId") or identity.get("arn"),
            "actor_name": actor_name,
            # CloudTrail does not carry an email address. Deriving one from a
            # username would fabricate an identity, so this stays None unless
            # the username genuinely IS an email (Identity Center often sets
            # it to one).
            "actor_email": self.email_or_none(actor_name),
            "actor_type": actor_type,
            "actor_role": issuer.get("arn") or (
                identity.get("arn") if raw_type in ("AssumedRole", "Role") else None
            ),
            "auth_method": " · ".join(auth_bits) if auth_bits else None,
            "chain": chain,
        }

    @staticmethod
    def _read_only(record: Dict[str, Any], detail: Dict[str, Any]) -> Optional[bool]:
        """The provider's own flag, never a guess from the operation name.

        The name-based derivation already happens in the classifier (which is
        allowed to guess, and says so); this column is the provider's
        statement, so it stays None when CloudTrail did not make one.
        """
        for source in (detail, record):
            value = source.get("readOnly") if source is detail else source.get("ReadOnly")
            if isinstance(value, bool):
                return value
            if isinstance(value, str) and value.lower() in ("true", "false"):
                return value.lower() == "true"
        return None

    def _resources(
        self, record: Dict[str, Any], detail: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Every resource the event touched, primary first.

        CloudTrail's `resources` array is authoritative when present but is
        populated for only some services. Where it is absent the request
        parameters usually name the target; those keys are read explicitly
        rather than by scanning for anything id-shaped, so the value is always
        a field AWS labelled as that resource.
        """
        out: List[Dict[str, Any]] = []
        for res in (detail.get("resources") or record.get("Resources") or []):
            if not isinstance(res, dict):
                continue
            arn = res.get("ARN") or res.get("arn") or res.get("ResourceName")
            rtype = res.get("type") or res.get("ResourceType")
            out.append({
                "id": arn,
                "name": (arn or "").rsplit("/", 1)[-1].rsplit(":", 1)[-1] or None,
                "type": _short_resource_type(rtype),
                "account": res.get("accountId"),
            })
        if out:
            return out

        params = detail.get("requestParameters")
        if isinstance(params, dict):
            for key in (
                "groupId", "instanceId", "bucketName", "roleName", "userName",
                "policyArn", "functionName", "dBInstanceIdentifier", "keyId",
                "volumeId", "vpcId", "subnetId", "tableName", "clusterName",
                "queueUrl", "topicArn", "secretId", "trailName", "name",
                "loadBalancerArn", "targetGroupArn", "streamName", "resourceArn",
            ):
                value = params.get(key)
                if isinstance(value, str) and value:
                    return [{
                        "id": value,
                        "name": value.rsplit("/", 1)[-1],
                        "type": _type_from_param(key, detail.get("eventSource")),
                        "source": f"requestParameters.{key}",
                    }]
        return []

    def _access_method(
        self, identity: Dict[str, Any], user_agent: Optional[str], detail: Dict[str, Any]
    ) -> Optional[str]:
        """How the call reached AWS.

        An `invokedBy` on the identity is a direct statement that a service
        made the call, so it outranks any user-agent guess. Otherwise the
        user agent is the only evidence, and the base helper turns it into a
        method or into None.
        """
        if identity.get("invokedBy"):
            return "Service"
        if identity.get("type") == "AWSService":
            return "Service"
        return self.access_method_from_user_agent(user_agent)

    def _metadata(
        self,
        detail: Dict[str, Any],
        identity: Dict[str, Any],
        request_params: Any,
        response_elements: Any,
    ) -> Dict[str, Any]:
        """The AWS-only fields, kept because they have no equivalent elsewhere.

        `request_parameters` lives here rather than in change_before/after on
        purpose: it is what was *asked for*, not what the resource was
        beforehand. Filing it as a "before" state would invent a prior
        configuration nobody observed — the specification's central prohibition.
        """
        meta: Dict[str, Any] = {
            "event_version": detail.get("eventVersion"),
            "event_type": detail.get("eventType"),
            "management_event": detail.get("managementEvent"),
            "identity_type": identity.get("type"),
            "identity_arn": identity.get("arn"),
            "access_key_id": identity.get("accessKeyId"),
            "invoked_by": identity.get("invokedBy"),
            "shared_event_id": detail.get("sharedEventID"),
            "recipient_account_id": detail.get("recipientAccountId"),
            "api_version": detail.get("apiVersion"),
            "tls_details": detail.get("tlsDetails"),
            "vpc_endpoint_id": detail.get("vpcEndpointId"),
            "additional_event_data": detail.get("additionalEventData"),
        }
        if request_params is not None:
            meta["request_parameters"] = request_params
            meta["request_parameters_note"] = (
                "The parameters AWS was ASKED to apply. CloudTrail does not report the "
                "resource's previous state, so this is not a before/after diff."
            )
        if response_elements is not None:
            meta["response_elements"] = response_elements
        return {k: v for k, v in meta.items() if v is not None}


def _short_resource_type(aws_type: Optional[str]) -> Optional[str]:
    """"AWS::EC2::SecurityGroup" → "SecurityGroup".

    The full CloudFormation-style name is kept in the raw event; the column
    holds the readable tail so the resource-type filter reads the same way for
    all three providers.
    """
    if not aws_type:
        return None
    return aws_type.rsplit("::", 1)[-1]


# Which resource type a request parameter names. Explicit, because guessing
# from the value shape ("sg-" → SecurityGroup) breaks the moment AWS changes
# an id prefix, and a wrong type is a wrong filter result.
_PARAM_TYPES = {
    "groupId": "SecurityGroup",
    "instanceId": "EC2Instance",
    "bucketName": "S3Bucket",
    "roleName": "IAMRole",
    "userName": "IAMUser",
    "policyArn": "IAMPolicy",
    "functionName": "LambdaFunction",
    "dBInstanceIdentifier": "RDSInstance",
    "keyId": "KMSKey",
    "volumeId": "EBSVolume",
    "vpcId": "VPC",
    "subnetId": "Subnet",
    "tableName": "DynamoDBTable",
    "clusterName": "Cluster",
    "queueUrl": "SQSQueue",
    "topicArn": "SNSTopic",
    "secretId": "Secret",
    "trailName": "CloudTrail",
    "loadBalancerArn": "LoadBalancer",
    "targetGroupArn": "TargetGroup",
    "streamName": "KinesisStream",
}


def _type_from_param(key: str, event_source: Optional[str]) -> Optional[str]:
    mapped = _PARAM_TYPES.get(key)
    if mapped:
        return mapped
    # "name" and "resourceArn" are generic, so the service is the best answer
    # available: "ec2.amazonaws.com" → "EC2". Better than asserting a specific
    # type the parameter never identified.
    if event_source:
        return event_source.split(".", 1)[0].upper()
    return None
