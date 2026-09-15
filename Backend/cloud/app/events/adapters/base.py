"""The provider-adapter contract for audit-event collection.

The design principle the specification is emphatic about, and the reason this
file exists: do NOT make AWS, Azure and OCI look identical internally. Each
adapter talks to its own API in its own idiom, then hands back rows in one
common shape with the original payload attached. Provider-specific logic stops
here and never reaches the service, the repository or the UI.

    CloudTrail / Activity Log / OCI Audit
                  |
             <Provider>Adapter      per-provider auth, paging, throttling
                  |
             CollectedEvent          one common shape + raw payload
                  |
             EventRepository         dedupe on (account, provider_event_id)

Each adapter yields **scopes** rather than a single flat stream. A scope is the
smallest unit a provider lets us poll independently — an AWS region, the Azure
subscription, an OCI region+compartment — and it is the unit of checkpointing
and of failure. That granularity is the difference between "one compartment is
unreadable" and "this account has no events": a per-account checkpoint that
advanced past a failed scope would lose those events permanently, which is the
one outcome an audit system may not have.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import random
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional

from app.events.classification import classify
from app.events.redaction import redact
from app.models.cloud_event import (
    ACCESS_METHODS,
    ACTOR_UNKNOWN,
    STATUS_UNKNOWN,
)
from app.providers.scan_pool import is_denial, is_transient, scan_pool

logger = logging.getLogger("cloud_svc.events.adapter")


# ── The common shape ──────────────────────────────────────────────────────────


@dataclass
class CollectedEvent:
    """One normalized audit event, ready for the repository.

    Every field defaults to None because "the provider did not say" is the
    normal case for most fields on most providers, and it must be
    indistinguishable from "the adapter forgot" only in the sense that both
    are honest — the UI renders None as "Not available" either way, and no
    code path substitutes a plausible-looking value.
    """

    provider: str
    provider_event_id: str
    timestamp: datetime
    event_name: str

    event_source: Optional[str] = None
    api_operation: Optional[str] = None
    http_method: Optional[str] = None
    provider_received_at: Optional[datetime] = None
    provider_category: Optional[str] = None
    read_only: Optional[bool] = None

    event_category: str = "Other"
    action: str = "Other"
    status: str = STATUS_UNKNOWN
    risk_level: str = "LOW"
    risk_reason: Optional[str] = None

    actor_id: Optional[str] = None
    actor_name: Optional[str] = None
    actor_email: Optional[str] = None
    actor_type: str = ACTOR_UNKNOWN
    actor_role: Optional[str] = None
    actor_auth_method: Optional[str] = None
    actor_chain: Optional[List[Dict[str, Any]]] = None

    account_ref: Optional[str] = None
    subscription_id: Optional[str] = None
    tenant_id: Optional[str] = None
    tenancy_id: Optional[str] = None
    compartment_id: Optional[str] = None
    compartment_name: Optional[str] = None
    resource_group: Optional[str] = None
    region: Optional[str] = None

    resource_id: Optional[str] = None
    resource_name: Optional[str] = None
    resource_type: Optional[str] = None
    resources: Optional[List[Dict[str, Any]]] = None

    source_ip: Optional[str] = None
    user_agent: Optional[str] = None
    access_method: Optional[str] = None
    source_location: Optional[str] = None

    request_id: Optional[str] = None
    correlation_id: Optional[str] = None
    session_id: Optional[str] = None
    trace_id: Optional[str] = None

    http_status: Optional[int] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None

    change_before: Optional[Dict[str, Any]] = None
    change_after: Optional[Dict[str, Any]] = None
    changed_fields: Optional[List[str]] = None

    provider_metadata: Dict[str, Any] = field(default_factory=dict)
    raw_event: Optional[Dict[str, Any]] = None
    redacted: bool = False


@dataclass
class ScopeResult:
    """One scope's worth of collection, plus how it went.

    `complete` is the load-bearing field. False means the checkpoint must NOT
    advance: whatever went wrong, this window has not been fully read, and
    re-reading it costs a few duplicate inserts that the unique constraint
    discards. Advancing anyway would drop real events with no way to notice.
    """

    scope: str
    events: List[CollectedEvent]
    complete: bool
    # Latest event time actually observed. The checkpoint is set from this
    # rather than from "now", so a provider that delivers events late does not
    # get its backlog skipped.
    watermark: Optional[datetime] = None
    error: Optional[str] = None
    # Which of the three failure kinds this was, so the sync-state row can say
    # "PermissionDenied" instead of a generic red light.
    error_kind: Optional[str] = None
    api_calls: int = 0
    api_errors: int = 0
    rate_limit_hits: int = 0
    # Rows the adapter received but could not normalize. Counted, never
    # silently dropped: a malformed event is a bug signal, not a non-event.
    malformed: int = 0


# ── Error classification ──────────────────────────────────────────────────────

ERROR_DENIED = "PermissionDenied"
ERROR_AUTH = "AuthenticationFailed"
ERROR_UNAVAILABLE = "Unavailable"

# Markers of a CREDENTIAL problem, as distinct from a permission problem
# (handled by is_denial) or a network problem (everything else).
#
# These are matched against the provider's message text, so they have to be the
# phrasings the providers actually use rather than the camel-cased exception
# names. AWS says "The security token included in the request is expired" — not
# "ExpiredToken" — so a marker list of concatenated words classified a genuinely
# expired credential as "provider unavailable" and told the operator to wait
# rather than to re-authenticate.
#
# Kept narrow on purpose: bare "certificate" and "keyid" were here and matched
# any message that merely mentioned a certificate or a KMS key id, turning
# ordinary resource errors into reports of broken credentials.
_AUTH_MARKERS = (
    "invalidclienttokenid", "signaturedoesnotmatch", "invalidaccesskeyid",
    "unrecognizedclient", "authenticationfailed", "authentication failed",
    "aadsts", "invalid_client", "unauthorized_client", "notauthenticated",
    "invalidsignature", "invalid signature", "invalid credentials",
    "expiredtoken", "tokenexpired", "token expired", "is expired",
    "has expired", "session expired", "expired credentials",
    "could not be authenticated", "unable to authenticate",
)
_RATE_LIMIT_MARKERS = (
    "throttl", "toomanyrequests", "rate exceeded", "429", "requestlimitexceeded",
    "too many requests", "slowdown", "limitexceeded",
)


def classify_error(exc: BaseException) -> str:
    """Which of the three operational conditions this exception represents.

    The distinction matters because the three need opposite responses: a
    denial needs a policy change, an auth failure needs a credential rotation,
    and unavailability needs nothing but patience. Collapsing them into one red
    light is what sends people to rotate keys that were working.
    """
    described = f"{type(exc).__name__} {exc}".lower()
    if is_denial(exc):
        return ERROR_DENIED
    if any(marker in described for marker in _AUTH_MARKERS):
        return ERROR_AUTH
    return ERROR_UNAVAILABLE


def is_rate_limit(exc: BaseException) -> bool:
    described = f"{type(exc).__name__} {exc}".lower()
    return any(marker in described for marker in _RATE_LIMIT_MARKERS)


def retry_after_seconds(exc: BaseException) -> Optional[float]:
    """Honour a provider's own Retry-After when it supplies one.

    Guessing a backoff when the provider has told us exactly how long to wait
    is how a throttled collection either hammers the API or sleeps far longer
    than needed. Both botocore and the Azure SDK surface the header on the
    response object; OCI puts it on the exception's headers.
    """
    for attr in ("response", "headers"):
        holder = getattr(exc, attr, None)
        if holder is None:
            continue
        headers = holder.get("ResponseMetadata", {}).get("HTTPHeaders", {}) \
            if isinstance(holder, dict) else getattr(holder, "headers", None)
        if headers is None and isinstance(holder, dict):
            headers = holder
        if not headers:
            continue
        try:
            for name in ("retry-after", "Retry-After", "x-ms-retry-after-ms"):
                value = headers.get(name) if hasattr(headers, "get") else None
                if value is None:
                    continue
                seconds = float(value)
                # x-ms-retry-after-ms is milliseconds, as its name says.
                if name.endswith("-ms"):
                    seconds /= 1000.0
                # A provider asking for an hour is either a bug or an outage;
                # either way this run should end rather than block a worker.
                return min(seconds, 120.0)
        except (TypeError, ValueError):
            continue
    return None


# ── The adapter ───────────────────────────────────────────────────────────────


class EventAdapter(ABC):
    """Base for the three provider adapters.

    Subclasses implement `scopes()` and `collect_scope()`. Everything shared —
    retrying a blocking SDK call on the scan pool, honouring rate limits,
    building the dedup identity, classifying, redacting — lives here so the
    three adapters differ only where the providers genuinely differ.
    """

    provider: str = "Unknown"

    # Management-event retention at the provider, in days. The hard ceiling on
    # how far back a first collection can reach; asking for older than this
    # returns nothing however generous our own retention setting is. Reported
    # to the UI so "Provider retention" and "Application retention" are never
    # conflated.
    provider_retention_days: int = 90

    # Retries for a dropped connection or a throttle. Matches
    # AWSScanner._TRANSIENT_ATTEMPTS: this collection runs on the same network
    # as the inventory sweep and has no reason to give up sooner.
    _TRANSIENT_ATTEMPTS = 4

    # Hard cap on pages per scope per run. A cold start on a busy account can
    # otherwise page for an hour and starve every other scope; the checkpoint
    # simply does not reach the present, and the next run continues from where
    # this one stopped. Bounded progress beats an unbounded run that gets
    # killed halfway.
    _MAX_PAGES_PER_SCOPE = 40

    def __init__(self, credentials: Dict[str, Any], *, collect_read_only: bool = False) -> None:
        self.credentials = credentials
        self.collect_read_only = collect_read_only

    # -- to implement ---------------------------------------------------------

    @abstractmethod
    async def authenticate(self) -> bool:
        """Validate credentials. Raises on failure, as the providers do."""

    @abstractmethod
    async def scopes(self) -> List[str]:
        """The independently-pollable scopes for this account, as opaque strings.

        Opaque to everything above: only the adapter that produced a scope
        string parses it back (see `_parse_scope` in each subclass).
        """

    @abstractmethod
    async def collect_scope(
        self, scope: str, start: datetime, end: datetime
    ) -> ScopeResult:
        """Read one scope's events in [start, end]. Never raises for an
        expected operational failure — returns a ScopeResult with
        complete=False and an error_kind instead, so one bad scope does not
        abort the account."""

    # -- shared machinery -----------------------------------------------------

    async def collect(
        self, start: datetime, end: datetime, *, scopes: Optional[List[str]] = None
    ) -> AsyncIterator[ScopeResult]:
        """Yield one ScopeResult per scope, sequentially.

        Sequential on purpose. CloudTrail's LookupEvents is documented at two
        requests per second per account, and OCI rate-limits audit reads; a
        fan-out across 18 regions turns into a throttle storm that collects
        less than a serial pass. The inventory scanners parallelise because
        they are latency-bound against generous limits; this is
        quota-bound, which is the opposite problem.
        """
        target_scopes = scopes if scopes is not None else await self.scopes()
        for scope in target_scopes:
            try:
                yield await self.collect_scope(scope, start, end)
            except Exception as exc:  # a bug in one scope must not lose the rest
                logger.warning(
                    "%s event collection raised for scope %s: %s",
                    self.provider, scope, exc, exc_info=True,
                )
                yield ScopeResult(
                    scope=scope,
                    events=[],
                    complete=False,
                    error=f"{type(exc).__name__}: {exc}",
                    error_kind=classify_error(exc),
                    api_errors=1,
                )

    async def _call(self, fn, *, label: str, counters: ScopeResult):
        """Run a blocking SDK call on the scan pool, retrying what deserves it.

        Retries a dropped connection or a throttle; never retries a denial,
        which is a real answer and would only delay reporting something true.
        Counters land on the ScopeResult so the observability endpoint reports
        measured API calls and rate-limit hits rather than estimates.
        """
        loop = asyncio.get_event_loop()
        last: Optional[BaseException] = None

        for attempt in range(self._TRANSIENT_ATTEMPTS):
            counters.api_calls += 1
            try:
                return await loop.run_in_executor(scan_pool(), fn)
            except Exception as exc:
                last = exc
                counters.api_errors += 1
                throttled = is_rate_limit(exc)
                if throttled:
                    counters.rate_limit_hits += 1
                if is_denial(exc) or not (throttled or is_transient(exc)):
                    raise
                if attempt == self._TRANSIENT_ATTEMPTS - 1:
                    break
                wait = retry_after_seconds(exc)
                if wait is None:
                    # Exponential with jitter. The jitter matters when several
                    # accounts are collecting: without it they all back off in
                    # lockstep and hit the next window together.
                    wait = min(2 ** attempt, 8) + random.uniform(0, 0.75)
                logger.info(
                    "%s %s: %s (attempt %d/%d) — retrying in %.1fs",
                    self.provider, label,
                    "throttled" if throttled else "connection dropped",
                    attempt + 1, self._TRANSIENT_ATTEMPTS, wait,
                )
                await asyncio.sleep(wait)

        raise last if last else RuntimeError(f"{self.provider} {label} failed")

    # -- normalization helpers ------------------------------------------------

    def finalize(
        self,
        event: CollectedEvent,
        *,
        request_parameters: Any = None,
        response_elements: Any = None,
        request_action: Optional[str] = None,
    ) -> CollectedEvent:
        """Classify, then redact, then return the event ready to store.

        Order matters and is the reason this is one function rather than two
        calls at the adapter's discretion. Classification needs the unredacted
        payload — spotting `0.0.0.0/0` in a security-rule write, or
        `AdministratorAccess` in a policy attach, is exactly what raises those
        to CRITICAL, and both live in fields redaction may touch. So: classify
        against the original, persist only the redacted copy.
        """
        labels = classify(
            provider=self.provider,
            event_name=event.event_name,
            api_operation=event.api_operation,
            event_source=event.event_source,
            resource_type=event.resource_type,
            resource_id=event.resource_id,
            status=event.status,
            actor_type=event.actor_type,
            read_only=event.read_only,
            request_action=request_action,
            request_parameters=request_parameters,
            response_elements=response_elements,
        )
        event.action = labels["action"]
        event.event_category = labels["event_category"]
        event.risk_level = labels["risk_level"]
        event.risk_reason = labels["risk_reason"]

        if event.raw_event is not None:
            event.raw_event, raw_touched = redact(event.raw_event)
        else:
            raw_touched = False
        if event.provider_metadata:
            event.provider_metadata, meta_touched = redact(event.provider_metadata)
        else:
            meta_touched = False
        if event.change_before is not None:
            event.change_before, before_touched = redact(event.change_before)
        else:
            before_touched = False
        if event.change_after is not None:
            event.change_after, after_touched = redact(event.change_after)
        else:
            after_touched = False

        event.redacted = bool(raw_touched or meta_touched or before_touched or after_touched)
        return event

    @staticmethod
    def fallback_event_id(*parts: Any) -> str:
        """A deterministic id for a provider event that arrived without one.

        Content-hashed rather than random, because the whole point is that the
        same event seen twice produces the same id and collides on the unique
        constraint. A random id would make every re-poll a fresh row, which is
        precisely the duplication the dedup design exists to prevent.
        """
        material = "|".join("" if p is None else str(p) for p in parts)
        return "sha256:" + hashlib.sha256(material.encode("utf-8")).hexdigest()

    @staticmethod
    def as_utc(value: Any) -> Optional[datetime]:
        """Coerce a provider timestamp to an aware UTC datetime.

        A naive value from an SDK is UTC by every one of these providers'
        documented behaviour, so it is stamped rather than shifted. Anything
        unparseable returns None instead of `now()` — a wrong timestamp on an
        audit event is worse than a missing one, because it silently moves the
        event in every time-ordered view.
        """
        if value is None:
            return None
        if isinstance(value, datetime):
            return value.replace(tzinfo=timezone.utc) if value.tzinfo is None \
                else value.astimezone(timezone.utc)
        if isinstance(value, str):
            text = value.strip()
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            try:
                parsed = datetime.fromisoformat(text)
            except ValueError:
                return None
            return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None \
                else parsed.astimezone(timezone.utc)
        return None

    # Attribute names that belong to the SDK's own model machinery rather than
    # to the provider's event. The OCI Python SDK hangs `attribute_map` and
    # `swagger_types` — two dicts naming every field of the class — on EVERY
    # model instance, so a naive walk stored two copies of the schema beside
    # each nested object. On live data that roughly tripled the size of a stored
    # OCI payload and buried the actual event in reflection metadata when
    # someone opened the Raw Event viewer.
    _SDK_INTERNALS = frozenset({
        "attribute_map", "swagger_types", "discriminator", "additional_properties",
        "serialize", "deserialize", "enable_additional_properties_sending",
    })

    @staticmethod
    def to_jsonable(value: Any) -> Any:
        """Make an SDK model JSON-storable without losing its fields.

        The Azure and OCI SDKs return typed model objects, not dicts. Both
        expose enough structure to walk (`__dict__`, with leading-underscore
        attribute names), and walking is what keeps `raw_event` a faithful copy
        of what the provider said rather than a `str()` of a Python repr.

        What is dropped is only the SDK's own plumbing (see `_SDK_INTERNALS`) —
        never a provider field. A field the provider set to null stays null.
        """
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, datetime):
            return EventAdapter.as_utc(value).isoformat() if value else None
        if isinstance(value, dict):
            return {str(k): EventAdapter.to_jsonable(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [EventAdapter.to_jsonable(v) for v in value]
        attrs = getattr(value, "__dict__", None)
        if attrs:
            out = {}
            for key, member in attrs.items():
                if key.startswith("__") or callable(member):
                    continue
                name = key.lstrip("_")
                if name in EventAdapter._SDK_INTERNALS:
                    continue
                out[name] = EventAdapter.to_jsonable(member)
            return out
        return str(value)

    @staticmethod
    def access_method_from_user_agent(user_agent: Optional[str]) -> Optional[str]:
        """Derive how the call was made — from the user agent ONLY.

        Returns None, not "Unknown", when there is no user agent: the caller
        stores None and the UI says "Not available", which is the truth. A
        derived "Unknown" would look like a determination that the method could
        not be identified, when in fact nothing was ever offered to identify.

        The mappings are the strings these clients actually send. Anything
        unrecognised is "SDK", which is defensible — a programmatic client is
        what a non-console, non-CLI, non-service agent is — and never
        "Console", the one answer that would wrongly imply a human at a
        browser.
        """
        if not user_agent:
            return None
        agent = user_agent.lower()
        if "terraform" in agent:
            return "Terraform"
        if "cloudformation" in agent or "arm-template" in agent or "resourcemanager" in agent:
            return "CloudFormation"
        if "console" in agent or "signin.amazonaws" in agent or "portal" in agent \
                or "oracle-console" in agent or "oci-console" in agent:
            return "Console"
        if "aws-cli" in agent or "oci-cli" in agent or "azurecli" in agent \
                or "azure-cli" in agent or "powershell" in agent:
            return "CLI"
        if ".amazonaws.com" in agent and "aws-sdk" not in agent and "boto" not in agent:
            # An AWS service calling on its own behalf sends its service
            # principal as the agent, e.g. "autoscaling.amazonaws.com".
            return "Service"
        if "automation" in agent or "lambda" in agent or "functions" in agent:
            return "Automation"
        if any(marker in agent for marker in (
            "sdk", "boto", "oci-python", "oci-java", "azure-sdk", "python-requests",
            "okhttp", "go-http-client", "apache-httpclient", "axios", "curl",
        )):
            return "SDK"
        if "mozilla" in agent or "chrome" in agent or "safari" in agent or "firefox" in agent:
            # A browser engine string with no console marker: a real browser,
            # but which surface is genuinely unknown, so say API rather than
            # asserting Console.
            return "API"
        return "SDK"

    @staticmethod
    def validate_access_method(value: Optional[str]) -> Optional[str]:
        """Keep the column inside its vocabulary. Anything else becomes None
        rather than being written through — a typo in an adapter should not
        silently create a new filter option that matches one row."""
        return value if value in ACCESS_METHODS else None

    @staticmethod
    def short(value: Optional[str], limit: int) -> Optional[str]:
        """Trim to a column's width, keeping the tail for identifiers.

        The distinguishing part of a resource id (an ARN's resource name, an
        OCID's unique suffix) is at the END, so a naive head-truncation turns
        several different resources into one identical string. Truncation is
        marked, so a trimmed value never reads as a complete one.
        """
        if value is None:
            return None
        text = str(value)
        if len(text) <= limit:
            return text
        keep = limit - 3
        return "..." + text[-keep:]

    @staticmethod
    def json_size(payload: Any) -> int:
        try:
            return len(json.dumps(payload, default=str))
        except Exception:
            return 0

    _EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

    @classmethod
    def email_or_none(cls, value: Optional[str]) -> Optional[str]:
        """An email only if it actually is one.

        Azure's `caller` is an email for a user and a GUID for a service
        principal; OCI's `principalName` is a username. Copying either into
        actor_email unconditionally is how a service principal ends up looking
        like a person in a search for "@company.com".
        """
        if value and cls._EMAIL_RE.match(value.strip()):
            return value.strip()
        return None
