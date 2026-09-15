"""Azure Activity Log adapter.

Reads the subscription's Activity Log through
`MonitorManagementClient.activity_logs.list`, which is the API behind the
portal's Activity log blade. Retention is **90 days** and is not configurable;
reaching further back requires a diagnostic setting that exports to Log
Analytics or storage, which this adapter does not assume exists.

Three Azure-specific facts drive the shape of this file:

*   **One operation produces several records.** Azure writes a `Started`
    record and then a `Succeeded`/`Failed` one for the same operation, sharing
    `correlationId` and `operationId` but each with its own `eventDataId`.
    They are genuinely distinct log records and are stored as such — folding
    them together would lose the timing — but the in-flight ones are marked
    `Partial` so the table can be read without mistaking a start for an
    outcome. The Related Events view is what re-joins them, via the
    correlation id Azure supplies for exactly that purpose.

*   **There is no user agent.** Azure records the caller's IP and their token
    claims, but nothing describing the client. So `access_method` is derived
    from the `appid` claim — the application the token was issued to — against
    the published list of Microsoft first-party client ids. Where the appid is
    absent or unrecognised the value is NULL and the UI says "Not available",
    rather than a guess at Console.

*   **The subscription is the only pollable scope.** Activity Log is not
    regional; a single call covers every region and resource group in the
    subscription. That makes Azure the cheapest of the three providers to
    collect and means one scope row, not nineteen.
"""
from __future__ import annotations

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
    ACTOR_AUTOMATED,
    ACTOR_CLOUD_SERVICE,
    ACTOR_HUMAN,
    ACTOR_SERVICE_PRINCIPAL,
    ACTOR_UNKNOWN,
    STATUS_DENIED,
    STATUS_FAILED,
    STATUS_PARTIAL,
    STATUS_SUCCESS,
    STATUS_UNKNOWN,
)
from app.providers.azure.azure_auth import AzureAuth

logger = logging.getLogger("cloud_svc.events.azure")


# Azure's `status.value`, which is a workflow state rather than a plain result.
# "Started"/"Accepted" are in-flight: the operation has not finished, so
# reporting it as a success would be wrong and reporting it as a failure would
# be alarming. Partial is exactly what it is.
_STATUS_MAP = {
    "succeeded": STATUS_SUCCESS,
    "success": STATUS_SUCCESS,
    "resolved": STATUS_SUCCESS,
    "completed": STATUS_SUCCESS,
    "failed": STATUS_FAILED,
    "failure": STATUS_FAILED,
    "canceled": STATUS_FAILED,
    "cancelled": STATUS_FAILED,
    "started": STATUS_PARTIAL,
    "accepted": STATUS_PARTIAL,
    "active": STATUS_PARTIAL,
    "inprogress": STATUS_PARTIAL,
    "updated": STATUS_SUCCESS,
}

# `subStatus.value` carries the HTTP reason phrase. The phrase → code mapping
# is the one from RFC 9110 and is a lookup, not an inference — "Forbidden" IS
# 403. Only the codes Azure actually emits here are listed; anything else
# leaves http_status NULL rather than being approximated.
_REASON_PHRASE_CODES = {
    "ok": 200, "created": 201, "accepted": 202, "nocontent": 204,
    "badrequest": 400, "unauthorized": 401, "paymentrequired": 402,
    "forbidden": 403, "notfound": 404, "methodnotallowed": 405,
    "conflict": 409, "gone": 410, "preconditionfailed": 412,
    "requestentitytoolarge": 413, "unprocessableentity": 422,
    "toomanyrequests": 429, "internalservererror": 500, "notimplemented": 501,
    "badgateway": 502, "serviceunavailable": 503, "gatewaytimeout": 504,
}

# Reason phrases that mean "refused" rather than "broke".
_DENIAL_PHRASES = frozenset({"forbidden", "unauthorized", "authorizationfailed"})

# Microsoft first-party client application ids. These are published, stable and
# identical in every tenant, so mapping one to the client it represents is a
# lookup of a recorded fact. Anything not on this list yields NULL.
_KNOWN_APP_IDS = {
    "c44b4083-3bb0-49c1-b47d-974e53cbdf3c": ("Azure Portal", "Console"),
    "04b07795-8ddb-461a-bbee-02f9e1bf7b46": ("Azure CLI", "CLI"),
    "1950a258-227b-4e31-a9cf-717495945fc2": ("Azure PowerShell", "CLI"),
    "1b730954-1685-4b74-9bfd-dac224a7b894": ("Azure AD PowerShell", "CLI"),
    "00000002-0000-0000-c000-000000000000": ("Azure AD Graph", "API"),
    "00000003-0000-0000-c000-000000000000": ("Microsoft Graph", "API"),
    "872cd9fa-d31f-45e0-9eab-6e460a02d1f1": ("Visual Studio", "SDK"),
    "aebc6443-996d-45c2-90f0-388ff96faa56": ("Visual Studio Code", "SDK"),
    "2793995e-0a7d-40d7-bd35-6968ba142197": ("Microsoft Azure PowerShell (legacy)", "CLI"),
}

# Azure's own `category.value`. Kept verbatim on the event as
# `provider_category`, because "Administrative" / "ServiceHealth" / "Policy"
# do not map onto our functional categories without losing meaning.
AZURE_CATEGORIES = (
    "Administrative", "Security", "ServiceHealth", "ResourceHealth",
    "Alert", "Autoscale", "Recommendation", "Policy",
)


class AzureEventAdapter(EventAdapter):
    provider = "Azure"
    provider_retention_days = 90

    def __init__(self, credentials: Dict[str, Any], *, collect_read_only: bool = False) -> None:
        super().__init__(credentials, collect_read_only=collect_read_only)
        self.auth = AzureAuth(credentials)

    async def authenticate(self) -> bool:
        return await self.auth.validate()

    async def scopes(self) -> List[str]:
        """One scope: the subscription.

        Activity Log is subscription-wide and not regional, so there is nothing
        to fan out over. The scope string still carries the subscription id so
        the sync-state row is self-describing when several subscriptions are
        registered.
        """
        return [f"subscription:{self.auth.subscription_id}"]

    async def collect_scope(self, scope: str, start: datetime, end: datetime) -> ScopeResult:
        result = ScopeResult(scope=scope, events=[], complete=False)

        # OData filter. Azure requires the timestamp bounds; anything else is
        # optional. The quoting and the ISO-8601 Z form are what the service
        # accepts — a naive datetime or an offset other than Z is rejected.
        window = (
            f"eventTimestamp ge '{_odata_time(start)}' and "
            f"eventTimestamp le '{_odata_time(end)}'"
        )

        def _list():
            from azure.mgmt.monitor import MonitorManagementClient

            client = self.auth.get_client(MonitorManagementClient)
            # Materialised inside the executor: the SDK's ItemPaged fetches
            # lazily, so iterating it on the event loop would put blocking HTTP
            # calls there. Bounded by the page cap for the same reason the AWS
            # adapter is — a cold start on a busy subscription must not run
            # unbounded.
            collected: List[Any] = []
            limit = self._MAX_PAGES_PER_SCOPE * 200
            for item in client.activity_logs.list(filter=window):
                collected.append(item)
                if len(collected) >= limit:
                    break
            return collected

        try:
            records = await self._call(_list, label="activity_logs.list", counters=result)
        except Exception as exc:
            result.error = f"{type(exc).__name__}: {exc}"
            result.error_kind = classify_error(exc)
            logger.warning("Azure Activity Log read failed: %s", result.error)
            return result

        watermark: Optional[datetime] = None
        for record in records:
            event = self._normalize(record)
            if event is None:
                result.malformed += 1
                continue
            if event.read_only and not self.collect_read_only:
                # Azure has no server-side ReadOnly filter, so unlike AWS this
                # has to be dropped after retrieval. Counted nowhere because it
                # was never an event we wanted, not one we failed to store.
                continue
            result.events.append(event)
            if watermark is None or event.timestamp > watermark:
                watermark = event.timestamp

        result.watermark = watermark
        # A truncated page cap means the window was not fully read, so the
        # checkpoint must not jump past it.
        result.complete = len(records) < self._MAX_PAGES_PER_SCOPE * 200
        if not result.complete:
            result.error = (
                "Stopped at the per-run record cap; the remainder of this window "
                "will be read on the next run."
            )
        return result

    # -- normalization --------------------------------------------------------

    def _normalize(self, record: Any) -> Optional[CollectedEvent]:
        timestamp = self.as_utc(getattr(record, "event_timestamp", None))
        if timestamp is None:
            return None

        operation = _localized(getattr(record, "operation_name", None))
        category = _localized(getattr(record, "category", None))
        status_text = _localized(getattr(record, "status", None))
        sub_status = _localized(getattr(record, "sub_status", None))
        resource_provider = _localized(getattr(record, "resource_provider_name", None))
        resource_type = _localized(getattr(record, "resource_type", None))

        properties = _as_dict(getattr(record, "properties", None))
        claims = _as_dict(getattr(record, "claims", None))
        authorization = getattr(record, "authorization", None)
        http_request = getattr(record, "http_request", None)

        status, http_status = self._status(status_text, sub_status, properties)
        actor = self._actor(record, claims, authorization)
        resource_id = getattr(record, "resource_id", None)

        # ── read_only ────────────────────────────────────────────────────────
        # Azure states this through the operation's own REST verb, which is
        # part of the operation name it published — so this is the provider's
        # statement, not a guess at the verb's meaning.
        read_only = None
        if operation:
            suffix = operation.rsplit("/", 1)[-1].lower()
            if suffix in ("read", "list"):
                read_only = True
            elif suffix in ("write", "delete", "action"):
                read_only = False

        event_data_id = getattr(record, "event_data_id", None)
        correlation_id = getattr(record, "correlation_id", None)

        event = CollectedEvent(
            provider="Azure",
            provider_event_id=self.short(
                event_data_id
                # eventDataId is documented as present on every record; the
                # composite is the specification's own fallback and is
                # deterministic, so a re-poll still dedupes.
                or self.fallback_event_id(
                    "Azure", correlation_id, timestamp.isoformat(), operation, resource_id,
                ),
                256,
            ),
            timestamp=timestamp,
            provider_received_at=self.as_utc(getattr(record, "submission_timestamp", None)),
            # The readable tail is the event name ("write", "securityRules/write"
            # is not a name); the full operation string is the precise form and
            # keeps its own column.
            event_name=self.short(_event_name(operation, record), 256),
            event_source=self.short(resource_provider, 256),
            api_operation=self.short(operation, 512),
            http_method=_http_method(http_request, operation),
            provider_category=self.short(category, 60),
            read_only=read_only,
            status=status,
            http_status=http_status,
            actor_id=self.short(actor["id"], 512),
            actor_name=self.short(actor["name"], 512),
            actor_email=actor["email"],
            actor_type=actor["type"],
            actor_role=self.short(actor["role"], 512),
            actor_auth_method=self.short(actor["auth_method"], 120),
            actor_chain=actor["chain"] or None,
            subscription_id=self.short(getattr(record, "subscription_id", None), 128),
            tenant_id=self.short(getattr(record, "tenant_id", None), 128),
            account_ref=self.short(getattr(record, "subscription_id", None), 256),
            resource_group=self.short(getattr(record, "resource_group_name", None), 256),
            # Activity Log carries no region field. The ARM resource id does not
            # encode one either, so this stays NULL — inferring a region from a
            # resource group's name would be a guess.
            region=None,
            resource_id=self.short(resource_id, 1024),
            resource_name=self.short(_resource_name(resource_id), 512),
            resource_type=self.short(_short_type(resource_type), 120),
            source_ip=self.short(getattr(http_request, "client_ip_address", None), 64),
            # No user agent exists in this API. NULL, not "Unknown".
            user_agent=None,
            access_method=self.validate_access_method(actor["access_method"]),
            request_id=self.short(
                getattr(http_request, "client_request_id", None)
                or getattr(record, "operation_id", None), 256,
            ),
            correlation_id=self.short(correlation_id, 256),
            error_code=self.short(_error_code(properties, sub_status, status), 256),
            error_message=_error_message(properties, record),
            provider_metadata=self._metadata(
                record, claims, authorization, http_request, properties,
                sub_status, status_text,
            ),
            raw_event=self.to_jsonable(record),
        )

        return self.finalize(
            event,
            # Azure's `properties` is where a write's payload lands
            # (requestbody, policy definition, role assignment). It is what the
            # risk rules need to see 0.0.0.0/0 or an Owner grant in.
            request_parameters=properties,
            response_elements=None,
        )

    # -- field extraction -----------------------------------------------------

    def _status(
        self, status_text: Optional[str], sub_status: Optional[str], properties: Dict[str, Any]
    ) -> tuple:
        """(normalized status, http status or None).

        A refusal is separated from a breakage here rather than downstream,
        because Azure expresses it in `subStatus` while `status` says only
        "Failed" — so the distinction is lost if this function does not make it.
        """
        normalized = _STATUS_MAP.get(_key(status_text), STATUS_UNKNOWN)

        # `properties.statusCode` carries the same reason phrase for many
        # resource providers, and is sometimes populated when subStatus is not.
        phrase = _key(sub_status) or _key(str(properties.get("statusCode") or ""))
        http_status = _REASON_PHRASE_CODES.get(phrase)

        if phrase in _DENIAL_PHRASES:
            normalized = STATUS_DENIED
        elif normalized == STATUS_FAILED and http_status == 403:
            normalized = STATUS_DENIED

        return normalized, http_status

    def _actor(
        self, record: Any, claims: Dict[str, Any], authorization: Any
    ) -> Dict[str, Any]:
        """Who called, from the token claims Azure recorded.

        `caller` alone is ambiguous — an email for a user, a GUID for a service
        principal, a resource id for a managed identity — so the claims decide
        the type. `idtyp: app` is Azure's own explicit statement that this was
        an app-only token, which is the most reliable signal available and is
        checked first.
        """
        caller = getattr(record, "caller", None)
        category = _localized(getattr(record, "category", None))

        upn = claims.get("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn")
        name_claim = claims.get("name")
        object_id = claims.get("http://schemas.microsoft.com/identity/claims/objectidentifier")
        app_id = claims.get("appid") or claims.get(
            "http://schemas.microsoft.com/identity/claims/appid"
        )
        id_type = str(claims.get("idtyp") or "").lower()

        if id_type == "app":
            actor_type = ACTOR_SERVICE_PRINCIPAL
        elif upn or self.email_or_none(caller) or name_claim:
            actor_type = ACTOR_HUMAN
        elif category == "Autoscale":
            # Autoscale records have no caller at all: the platform acted.
            actor_type = ACTOR_AUTOMATED
        elif category in ("ServiceHealth", "ResourceHealth", "Recommendation", "Alert"):
            actor_type = ACTOR_CLOUD_SERVICE
        elif app_id or (caller and _looks_like_guid(caller)):
            actor_type = ACTOR_SERVICE_PRINCIPAL
        elif caller and caller.startswith("/subscriptions/"):
            # A managed identity is recorded as its own resource id.
            actor_type = ACTOR_SERVICE_PRINCIPAL
        else:
            actor_type = ACTOR_UNKNOWN

        app_name, access_method = _KNOWN_APP_IDS.get(str(app_id).lower(), (None, None))

        # ── Authentication method ────────────────────────────────────────────
        # From the authnmethodsreferences claim, which lists what was actually
        # used ("pwd", "mfa", "rsa"). Absent → None.
        auth_refs = claims.get("http://schemas.microsoft.com/claims/authnmethodsreferences")
        auth_bits: List[str] = []
        if auth_refs:
            auth_bits.append(str(auth_refs).replace(",", " · "))
        if app_name:
            auth_bits.append(f"via {app_name}")
        elif id_type == "app":
            auth_bits.append("App-only token")

        chain: List[Dict[str, Any]] = []
        if app_id and actor_type == ACTOR_HUMAN and app_name:
            # A person acting through a first-party client: two recorded hops,
            # so the chain is real rather than assembled.
            chain = [
                {"step": "Client", "type": "Application", "name": app_name, "id": app_id},
                {"step": "Principal", "type": "User",
                 "name": upn or caller, "id": object_id},
            ]

        return {
            "id": object_id or app_id or caller,
            "name": upn or name_claim or caller,
            "email": self.email_or_none(upn) or self.email_or_none(caller),
            "type": actor_type,
            # SenderAuthorization.role is the RBAC role that permitted the call
            # — Azure's own statement of the authorization used.
            "role": getattr(authorization, "role", None),
            "auth_method": " · ".join(auth_bits) if auth_bits else None,
            "access_method": access_method,
            "chain": chain,
        }

    def _metadata(
        self,
        record: Any,
        claims: Dict[str, Any],
        authorization: Any,
        http_request: Any,
        properties: Dict[str, Any],
        sub_status: Optional[str],
        status_text: Optional[str],
    ) -> Dict[str, Any]:
        meta: Dict[str, Any] = {
            "azure_status": status_text,
            "azure_sub_status": sub_status,
            "level": str(getattr(record, "level", "") or "") or None,
            "description": getattr(record, "description", None) or None,
            "operation_id": getattr(record, "operation_id", None),
            "event_data_id": getattr(record, "event_data_id", None),
            "activity_log_id": getattr(record, "id", None),
        }
        if authorization is not None:
            meta["authorization"] = {
                "action": getattr(authorization, "action", None),
                "role": getattr(authorization, "role", None),
                "scope": getattr(authorization, "scope", None),
            }
        if http_request is not None:
            meta["http_request"] = {
                "method": getattr(http_request, "method", None),
                "uri": getattr(http_request, "uri", None),
                "client_ip_address": getattr(http_request, "client_ip_address", None),
                "client_request_id": getattr(http_request, "client_request_id", None),
            }
        if claims:
            meta["claims"] = claims
        if properties:
            meta["properties"] = properties
            meta["properties_note"] = (
                "The Activity Log's own properties bag. For a write it contains the "
                "request payload, which is what was ASKED for — Azure does not report "
                "the resource's previous state, so this is not a before/after diff."
            )
        return {k: v for k, v in meta.items() if v is not None}


# ── Small helpers ─────────────────────────────────────────────────────────────


def _odata_time(value: datetime) -> str:
    """The exact timestamp form the Activity Log filter accepts."""
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _localized(value: Any) -> Optional[str]:
    """Unwrap a LocalizableString.

    `value` is the invariant machine form and `localized_value` is translated
    for the caller's locale. The machine form is what filters and rules must
    match on — a German-localized "Schreiben" would break every pattern — so
    it wins, with the localized string kept as a fallback.
    """
    if value is None:
        return None
    if isinstance(value, str):
        return value or None
    return getattr(value, "value", None) or getattr(value, "localized_value", None) or None


def _as_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return {str(k): v for k, v in value.items()}
    if value is None:
        return {}
    attrs = getattr(value, "__dict__", None)
    if attrs:
        return {k.lstrip("_"): v for k, v in attrs.items() if not callable(v)}
    return {}


def _key(value: Optional[str]) -> str:
    return "".join(ch for ch in (value or "").lower() if ch.isalnum())


def _looks_like_guid(value: str) -> bool:
    stripped = value.strip().strip("{}")
    return len(stripped) == 36 and stripped.count("-") == 4


def _event_name(operation: Optional[str], record: Any) -> str:
    """A readable name for the operation.

    Azure operation names end in a REST verb, so the last segment alone
    ("write") says nothing. The last two segments are the useful unit —
    "securityRules/write", "roleAssignments/delete".
    """
    if operation:
        parts = [p for p in operation.split("/") if p]
        if len(parts) >= 2:
            return "/".join(parts[-2:])
        if parts:
            return parts[-1]
    return _localized(getattr(record, "event_name", None)) or "UnknownOperation"


def _http_method(http_request: Any, operation: Optional[str]) -> Optional[str]:
    """The HTTP method, only when Azure recorded one.

    The operation's verb suffix implies a method, but implying is not
    recording: "…/action" could be POST or PUT and the log does not say. NULL
    where `httpRequest` is absent.
    """
    method = getattr(http_request, "method", None)
    return str(method)[:10] if method else None


def _resource_name(resource_id: Optional[str]) -> Optional[str]:
    """The resource's own name from its ARM id — the final segment.

    ARM ids are `/subscriptions/…/providers/Microsoft.X/type/name`, optionally
    with `/childType/childName` appended, so the last segment is always the
    thing acted on.
    """
    if not resource_id:
        return None
    parts = [p for p in resource_id.split("/") if p]
    return parts[-1] if parts else None


def _short_type(resource_type: Optional[str]) -> Optional[str]:
    """"Microsoft.Network/networkSecurityGroups" → "networkSecurityGroups"."""
    if not resource_type:
        return None
    return resource_type.rsplit("/", 1)[-1]


def _error_code(
    properties: Dict[str, Any], sub_status: Optional[str], status: str
) -> Optional[str]:
    """An error code only for an event that actually failed.

    Azure puts a `statusCode` on successes too ("OK", "Created"); recording
    that as an error code would make every successful row look like it carried
    a fault.
    """
    if status not in (STATUS_FAILED, STATUS_DENIED):
        return None
    return (
        properties.get("statusCode")
        or (properties.get("errorCode") if isinstance(properties, dict) else None)
        or sub_status
        or None
    )


def _error_message(properties: Dict[str, Any], record: Any) -> Optional[str]:
    for key in ("statusMessage", "message", "errorMessage", "eventDescription"):
        value = properties.get(key)
        if value:
            return str(value)
    return None
