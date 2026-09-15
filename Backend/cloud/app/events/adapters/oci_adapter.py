"""OCI Audit adapter.

Reads `oci.audit.AuditClient.list_events`, which is the API behind the console's
Audit page. OCI keeps audit events for **365 days** — four times AWS's and
Azure's Event-history window — which makes it the only one of the three that
can answer a question about last quarter.

OCI is also the only provider of the three that reports **previous state**.
`data.stateChange.previous` and `data.stateChange.current` are exactly the
before/after pair the change-diff view needs, so those populate
`change_before` / `change_after` and a real field-level diff is computed from
them. AWS and Azure report the parameters that were *requested* instead, which
is a different claim and is filed under `provider_metadata` on those adapters —
the reason the diff panel is populated for OCI events and honestly empty for
the other two.

The cost is fan-out. `list_events` takes a single compartment and does **not**
support a subtree flag, so a tenancy with 40 compartments across 3 regions is
120 independent scopes. Each is checkpointed separately, and the collector
rotates through them oldest-checkpoint-first rather than trying to sweep all of
them every run — the same reasoning as the inventory scanner's concurrency cap
(see oci_scanner._MAX_CONCURRENT_SCANS): on this network, asking for more at
once buys retries, not throughput.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from app.events.adapters.base import (
    CollectedEvent,
    EventAdapter,
    ScopeResult,
    classify_error,
)
from app.models.cloud_event import (
    ACTOR_CLOUD_SERVICE,
    ACTOR_HUMAN,
    ACTOR_ROOT,
    ACTOR_SERVICE_ACCOUNT,
    ACTOR_SERVICE_PRINCIPAL,
    ACTOR_UNKNOWN,
    STATUS_DENIED,
    STATUS_FAILED,
    STATUS_SUCCESS,
    STATUS_UNKNOWN,
)
from app.providers.oci.oci_auth import OCIAuth
from app.providers.scan_pool import scan_pool

logger = logging.getLogger("cloud_svc.events.oci")

# OCI principal types, from `data.identity.principalType`.
_PRINCIPAL_TYPES = {
    "user": ACTOR_HUMAN,
    "instance": ACTOR_SERVICE_PRINCIPAL,
    "resource": ACTOR_SERVICE_PRINCIPAL,
    "service": ACTOR_CLOUD_SERVICE,
    "unauthenticated": ACTOR_UNKNOWN,
}

# OCI's `identity.authType`.
_AUTH_TYPES = {
    "natv": "Native (API key)",
    "instance": "Instance principal",
    "resource": "Resource principal",
    "federated": "Federated (IdP)",
    "service": "Service principal",
}

# HTTP statuses that mean refused rather than broken.
_DENIAL_STATUSES = frozenset({"401", "403", "404"})

# `list_events` accepts a window, but the service is documented to reject a
# range wider than 14 days. Requests are split into chunks under that so a
# scope that has been unreachable for a fortnight still catches up rather than
# failing every run with a validation error.
_MAX_WINDOW = timedelta(days=7)


class OCIEventAdapter(EventAdapter):
    provider = "OCI"
    provider_retention_days = 365

    def __init__(self, credentials: Dict[str, Any], *, collect_read_only: bool = False) -> None:
        super().__init__(credentials, collect_read_only=collect_read_only)
        self.auth = OCIAuth(credentials)
        self._compartment_names: Dict[str, str] = {}

    async def authenticate(self) -> bool:
        return await self.auth.validate()

    # -- scopes ---------------------------------------------------------------

    async def scopes(self) -> List[str]:
        """One scope per (region, compartment).

        Both dimensions are required: audit events are recorded in the region
        the call was made to, and `list_events` reads one compartment at a
        time. The root tenancy compartment is included and comes first — it is
        where IAM activity is recorded, which is the highest-value audit data
        in the tenancy.
        """
        regions = await self._regions()
        compartments = await self._compartments()
        scopes: List[str] = []
        for region in regions:
            for compartment in compartments:
                scopes.append(f"region:{region}|compartment:{compartment}")
        return scopes

    @staticmethod
    def _parse_scope(scope: str) -> Tuple[str, str]:
        region = ""
        compartment = ""
        for part in scope.split("|"):
            if part.startswith("region:"):
                region = part[len("region:"):]
            elif part.startswith("compartment:"):
                compartment = part[len("compartment:"):]
        return region, compartment

    async def _regions(self) -> List[str]:
        """Subscribed regions, home region first.

        Mirrors OCIScanner._get_subscribed_regions, including its fallback: if
        region discovery fails, the home region is still collectable and
        collecting one region beats collecting none.
        """
        import asyncio

        import oci

        def _fetch():
            identity = oci.identity.IdentityClient(self.auth.get_config(), timeout=(10, 60))
            subs = identity.list_region_subscriptions(self.auth.tenancy_ocid).data
            return [s.region_name for s in subs if s.status == "READY"]

        try:
            regions = await asyncio.get_event_loop().run_in_executor(scan_pool(), _fetch)
        except Exception as exc:
            logger.warning(
                "OCI region discovery failed for audit collection (%s) — using the "
                "home region only.", exc,
            )
            return [self.auth.region]

        regions = sorted(set(regions or [self.auth.region]))
        if self.auth.region in regions:
            regions.remove(self.auth.region)
            regions.insert(0, self.auth.region)
        return regions

    async def _compartments(self) -> List[str]:
        """Root tenancy plus every ACTIVE compartment, root first.

        Names are cached alongside so each event can carry a readable
        compartment rather than only an OCID — the OCID is what the API
        returns, and a table of 90-character identifiers is unusable.
        """
        import asyncio

        import oci

        def _fetch():
            identity = oci.identity.IdentityClient(self.auth.get_config(), timeout=(10, 60))
            names: Dict[str, str] = {}
            try:
                names[self.auth.tenancy_ocid] = (
                    identity.get_tenancy(self.auth.tenancy_ocid).data.name or "root"
                )
            except Exception:
                names[self.auth.tenancy_ocid] = "root"
            compartments = oci.pagination.list_call_get_all_results(
                identity.list_compartments,
                self.auth.tenancy_ocid,
                compartment_id_in_subtree=True,
            ).data
            ids = [self.auth.tenancy_ocid]
            for comp in compartments:
                if comp.lifecycle_state == "ACTIVE":
                    ids.append(comp.id)
                    names[comp.id] = comp.name
            return ids, names

        try:
            ids, names = await asyncio.get_event_loop().run_in_executor(scan_pool(), _fetch)
        except Exception as exc:
            logger.warning(
                "OCI compartment discovery failed for audit collection (%s) — "
                "collecting the tenancy root compartment only.", exc,
            )
            return [self.auth.tenancy_ocid]

        self._compartment_names = names
        return ids

    # -- collection -----------------------------------------------------------

    async def collect_scope(self, scope: str, start: datetime, end: datetime) -> ScopeResult:
        import oci

        region, compartment_id = self._parse_scope(scope)
        result = ScopeResult(scope=scope, events=[], complete=False)
        if not region or not compartment_id:
            result.error = f"Malformed scope {scope!r}"
            result.error_kind = None
            return result

        watermark: Optional[datetime] = None
        pages = 0

        for chunk_start, chunk_end in _windows(start, end):
            next_page: Optional[str] = None
            while pages < self._MAX_PAGES_PER_SCOPE:
                token = next_page

                def _page():
                    cfg = dict(self.auth.get_config())
                    cfg["region"] = region
                    # A fresh client per call, matching oci_scanner's measured
                    # decision — on this network a shared pool accumulates dead
                    # connections that every later caller inherits.
                    client = oci.audit.AuditClient(cfg, timeout=(10, 60))
                    kwargs: Dict[str, Any] = {
                        "compartment_id": compartment_id,
                        "start_time": chunk_start,
                        "end_time": chunk_end,
                    }
                    if token:
                        kwargs["page"] = token
                    response = client.list_events(**kwargs)
                    return response.data, response.headers.get("opc-next-page")

                try:
                    records, next_page = await self._call(
                        _page, label=f"list_events {region}", counters=result
                    )
                except Exception as exc:
                    result.error = f"{type(exc).__name__}: {exc}"
                    result.error_kind = classify_error(exc)
                    logger.warning(
                        "OCI audit read failed in %s/%s: %s",
                        region, self._compartment_names.get(compartment_id, compartment_id),
                        result.error,
                    )
                    result.watermark = watermark
                    return result

                pages += 1
                for record in records or []:
                    event = self._normalize(record, region, compartment_id)
                    if event is None:
                        result.malformed += 1
                        continue
                    if event.read_only and not self.collect_read_only:
                        continue
                    result.events.append(event)
                    if watermark is None or event.timestamp > watermark:
                        watermark = event.timestamp

                if not next_page:
                    break

            if pages >= self._MAX_PAGES_PER_SCOPE:
                result.error = (
                    f"Stopped after {pages} pages to stay within the API budget; the "
                    f"rest of this window will be read on the next run."
                )
                result.watermark = watermark
                return result

        result.watermark = watermark
        result.complete = True
        return result

    # -- normalization --------------------------------------------------------

    def _normalize(
        self, record: Any, region: str, compartment_id: str
    ) -> Optional[CollectedEvent]:
        timestamp = self.as_utc(getattr(record, "event_time", None))
        if timestamp is None:
            return None

        data = getattr(record, "data", None)
        if data is None:
            return None

        identity = getattr(data, "identity", None)
        request = getattr(data, "request", None)
        response = getattr(data, "response", None)
        state_change = getattr(data, "state_change", None)

        event_name = getattr(data, "event_name", None) or getattr(record, "event_type", None)
        request_action = getattr(request, "action", None)
        status_code = str(getattr(response, "status", "") or "") or None
        status, http_status = self._status(status_code)

        actor = self._actor(identity, data)
        before, after, changed = _diff_state(state_change)

        request_parameters = self.to_jsonable(getattr(request, "parameters", None))
        response_payload = self.to_jsonable(getattr(response, "payload", None))

        resource_id = getattr(data, "resource_id", None)
        user_agent = getattr(identity, "user_agent", None) if identity else None

        event = CollectedEvent(
            provider="OCI",
            provider_event_id=self.short(
                getattr(record, "event_id", None)
                or getattr(request, "id", None)
                or self.fallback_event_id(
                    "OCI", region, compartment_id, event_name,
                    timestamp.isoformat(), resource_id,
                ),
                256,
            ),
            timestamp=timestamp,
            event_name=self.short(event_name, 256),
            # OCI's `source` is the service that emitted the event.
            event_source=self.short(getattr(record, "source", None), 256),
            # The cloud-event type is OCI's precise operation identity:
            # "com.oraclecloud.virtualnetwork.createvcn".
            api_operation=self.short(getattr(record, "event_type", None), 512),
            http_method=self.short(request_action, 10),
            provider_category=self.short(getattr(record, "event_type_version", None), 60),
            # OCI states this only through the request verb. GET/HEAD are reads;
            # anything else is not, and an absent verb leaves this NULL.
            read_only=_read_only(request_action),
            status=status,
            http_status=http_status,
            actor_id=self.short(actor["id"], 512),
            actor_name=self.short(actor["name"], 512),
            actor_email=actor["email"],
            actor_type=actor["type"],
            actor_role=None,  # OCI does not name a role on the audit event.
            actor_auth_method=self.short(actor["auth_method"], 120),
            actor_chain=actor["chain"] or None,
            tenancy_id=self.short(
                (getattr(identity, "tenant_id", None) if identity else None)
                or self.auth.tenancy_ocid, 256,
            ),
            account_ref=self.short(
                (getattr(identity, "tenant_id", None) if identity else None)
                or self.auth.tenancy_ocid, 256,
            ),
            compartment_id=self.short(
                getattr(data, "compartment_id", None) or compartment_id, 256
            ),
            compartment_name=self.short(
                getattr(data, "compartment_name", None)
                or self._compartment_names.get(compartment_id), 256,
            ),
            region=self.short(region, 80),
            resource_id=self.short(resource_id, 1024),
            resource_name=self.short(getattr(data, "resource_name", None), 512),
            resource_type=self.short(_resource_type(record, resource_id), 120),
            source_ip=self.short(
                getattr(identity, "ip_address", None) if identity else None, 64
            ),
            user_agent=user_agent,
            access_method=self.validate_access_method(
                self._access_method(identity, user_agent)
            ),
            request_id=self.short(getattr(request, "id", None), 256),
            # OCI has no correlation id of its own. `opc-request-id` IS the
            # request id, already carried above; duplicating it into the
            # correlation column would make unrelated events look correlated.
            correlation_id=None,
            trace_id=self.short(getattr(record, "event_id", None), 256),
            error_code=self.short(_error_code(response, status), 256),
            error_message=(getattr(response, "message", None) if response else None),
            # The one provider that genuinely reports prior state.
            change_before=before,
            change_after=after,
            changed_fields=changed or None,
            provider_metadata=self._metadata(
                record, data, identity, request, response,
                request_parameters, response_payload,
            ),
            raw_event=self.to_jsonable(record),
        )

        return self.finalize(
            event,
            request_parameters=request_parameters,
            response_elements=response_payload,
            request_action=request_action,
        )

    # -- field extraction -----------------------------------------------------

    @staticmethod
    def _status(status_code: Optional[str]) -> Tuple[str, Optional[int]]:
        """OCI reports the literal HTTP status of the original call.

        A refusal (401/403/404) is separated from a breakage: on OCI a 404 is
        routinely how a permission failure is reported, because the service
        will not confirm the existence of something the caller may not see.
        """
        if not status_code:
            return STATUS_UNKNOWN, None
        digits = "".join(ch for ch in status_code if ch.isdigit())
        code = int(digits) if digits else None
        if code is None:
            return STATUS_UNKNOWN, None
        if 200 <= code < 300:
            return STATUS_SUCCESS, code
        if str(code) in _DENIAL_STATUSES:
            return STATUS_DENIED, code
        return STATUS_FAILED, code

    def _actor(self, identity: Any, data: Any) -> Dict[str, Any]:
        principal_type = str(getattr(identity, "principal_type", "") or "").lower()
        actor_type = _PRINCIPAL_TYPES.get(principal_type, ACTOR_UNKNOWN)

        principal_name = getattr(identity, "principal_name", None) if identity else None
        principal_id = getattr(identity, "principal_id", None) if identity else None
        tenant_id = getattr(identity, "tenant_id", None) if identity else None
        auth_type = str(getattr(identity, "auth_type", "") or "")

        # A call made by the tenancy OCID itself as the principal is the
        # tenancy administrator — OCI's equivalent of root, and the one actor
        # type worth flagging on its own.
        if principal_id and tenant_id and principal_id == tenant_id:
            actor_type = ACTOR_ROOT
        elif actor_type == ACTOR_UNKNOWN and auth_type.lower() == "service":
            actor_type = ACTOR_CLOUD_SERVICE
        elif actor_type == ACTOR_UNKNOWN and principal_name and not principal_id:
            actor_type = ACTOR_SERVICE_ACCOUNT

        auth_label = _AUTH_TYPES.get(auth_type.lower(), auth_type or None)
        credentials = getattr(identity, "credentials", None) if identity else None
        auth_bits = [bit for bit in (auth_label,) if bit]
        if credentials:
            # The credential FINGERPRINT, which is what OCI records — not the
            # key. Useful for "which key did this", and not itself a secret.
            auth_bits.append(f"key {str(credentials)[-12:]}")

        chain: List[Dict[str, Any]] = []
        # A federated principal has an IdP hop OCI names explicitly, and an
        # instance/resource principal is a machine acting for a resource whose
        # id is recorded. Both are real recorded hops.
        if auth_type.lower() == "federated" and principal_name:
            chain = [
                {"step": "Federation", "type": "IdentityProvider",
                 "name": principal_name.split("/", 1)[0] if "/" in principal_name else None,
                 "id": None},
                {"step": "Principal", "type": "User",
                 "name": principal_name, "id": principal_id},
            ]
        elif principal_type in ("instance", "resource"):
            chain = [
                {"step": "Principal", "type": principal_type.capitalize() + "Principal",
                 "name": principal_name, "id": principal_id},
                {"step": "Operation", "type": "APICall",
                 "name": getattr(data, "event_name", None), "id": None},
            ]

        return {
            "id": principal_id,
            "name": principal_name,
            # OCI's principalName is a username, not an address. It becomes an
            # email only when it genuinely is one (a federated principal often
            # is), never by appending a domain.
            "email": self.email_or_none(principal_name),
            "type": actor_type,
            "auth_method": " · ".join(auth_bits) if auth_bits else None,
            "chain": [step for step in chain if step.get("name")],
        }

    def _access_method(self, identity: Any, user_agent: Optional[str]) -> Optional[str]:
        auth_type = str(getattr(identity, "auth_type", "") or "").lower()
        if auth_type in ("instance", "resource"):
            # A machine principal is by definition automation, and OCI has said
            # so — this is not a guess at a user agent.
            return "Automation"
        if auth_type == "service":
            return "Service"
        return self.access_method_from_user_agent(user_agent)

    def _metadata(
        self,
        record: Any,
        data: Any,
        identity: Any,
        request: Any,
        response: Any,
        request_parameters: Any,
        response_payload: Any,
    ) -> Dict[str, Any]:
        meta: Dict[str, Any] = {
            "cloud_events_version": getattr(record, "cloud_events_version", None),
            "event_type": getattr(record, "event_type", None),
            "event_type_version": getattr(record, "event_type_version", None),
            "content_type": getattr(record, "content_type", None),
            "availability_domain": getattr(data, "availability_domain", None),
            "compartment_path": getattr(data, "compartment_name", None),
            "additional_details": self.to_jsonable(
                getattr(data, "additional_details", None)
            ),
        }
        if identity is not None:
            meta["identity"] = {
                "principal_id": getattr(identity, "principal_id", None),
                "principal_name": getattr(identity, "principal_name", None),
                "principal_type": getattr(identity, "principal_type", None),
                "auth_type": getattr(identity, "auth_type", None),
                "tenant_id": getattr(identity, "tenant_id", None),
                "ip_address": getattr(identity, "ip_address", None),
                "user_agent": getattr(identity, "user_agent", None),
                "console_session_id": getattr(identity, "console_session_id", None),
                # The fingerprint of the API key used, which OCI records and
                # which is an identifier rather than a secret.
                "credentials": getattr(identity, "credentials", None),
            }
        if request is not None:
            meta["request"] = {
                "id": getattr(request, "id", None),
                "path": getattr(request, "path", None),
                "action": getattr(request, "action", None),
                "headers": self.to_jsonable(getattr(request, "headers", None)),
            }
            if request_parameters is not None:
                meta["request"]["parameters"] = request_parameters
        if response is not None:
            meta["response"] = {
                "status": getattr(response, "status", None),
                "response_time": self.to_jsonable(getattr(response, "response_time", None)),
                "message": getattr(response, "message", None),
                "headers": self.to_jsonable(getattr(response, "headers", None)),
            }
            if response_payload is not None:
                meta["response"]["payload"] = response_payload
        return {k: v for k, v in meta.items() if v is not None}


# ── Helpers ───────────────────────────────────────────────────────────────────


def _windows(start: datetime, end: datetime) -> List[Tuple[datetime, datetime]]:
    """Split a range into chunks the API will accept.

    OCI rejects a window wider than 14 days outright, so a scope that has been
    unreachable for longer than that would otherwise fail on every run forever
    — the checkpoint never advances, so the requested window only grows.
    """
    out: List[Tuple[datetime, datetime]] = []
    cursor = start
    while cursor < end:
        stop = min(cursor + _MAX_WINDOW, end)
        out.append((cursor, stop))
        cursor = stop
    return out or [(start, end)]


def _read_only(request_action: Optional[str]) -> Optional[bool]:
    if not request_action:
        return None
    verb = request_action.strip().upper()
    if verb in ("GET", "HEAD"):
        return True
    if verb in ("POST", "PUT", "PATCH", "DELETE"):
        return False
    return None


def _diff_state(state_change: Any) -> Tuple[Optional[dict], Optional[dict], List[str]]:
    """The real before/after pair, and which fields moved between them.

    OCI populates `stateChange.previous` only for some operations, and an
    update-in-place typically reports just the fields that changed rather than
    the whole resource. So:

    *   Both sides present  → a genuine diff; changed_fields is the symmetric
                              difference of keys plus the keys whose values
                              differ.
    *   Only `current`      → a creation, or an update where OCI did not
                              record the prior value. `change_before` stays
                              NULL, and the UI says the before state is not
                              available — it does NOT show an empty object,
                              which would read as "it was empty before".
    *   Neither             → both NULL and the panel says so.
    """
    if state_change is None:
        return None, None, []

    previous = getattr(state_change, "previous", None)
    current = getattr(state_change, "current", None)

    before = previous if isinstance(previous, dict) and previous else None
    after = current if isinstance(current, dict) and current else None

    if before is None or after is None:
        return before, after, []

    changed: List[str] = []
    for key in sorted(set(before) | set(after)):
        if before.get(key) != after.get(key):
            changed.append(key)
    return before, after, changed


def _resource_type(record: Any, resource_id: Optional[str]) -> Optional[str]:
    """The kind of resource acted on.

    Taken from the OCID, which encodes it in its second segment
    ("ocid1.instance.oc1..." → "instance"). This is OCID structure, documented
    and stable, not a heuristic. Falls back to the service name in the cloud
    event type, and to NULL when neither is present.
    """
    if resource_id and resource_id.startswith("ocid1."):
        parts = resource_id.split(".")
        if len(parts) > 1 and parts[1]:
            return parts[1]
    event_type = getattr(record, "event_type", None)
    if event_type:
        # "com.oraclecloud.virtualnetwork.createvcn" → "virtualnetwork"
        segments = event_type.split(".")
        if len(segments) >= 3:
            return segments[2]
    return None


def _error_code(response: Any, status: str) -> Optional[str]:
    """An error code only for a failed or denied event.

    OCI's response `status` is the HTTP code for successes too; recording 200
    as an error code would make every successful row look faulted.
    """
    if status not in (STATUS_FAILED, STATUS_DENIED) or response is None:
        return None
    return str(getattr(response, "status", "") or "") or None
