"""Why a billing call failed, in terms a UI can act on.

A failed cost fetch used to collapse into one of two shapes: a bare "NA", or
the catch-all category ``unknown``. Both are useless to the person looking at
the page, because the four things they might need to do are completely
different:

    permission      -- grant a role, then retry. Will never fix itself.
    credentials     -- re-add the account. Will never fix itself.
    rate_limited    -- wait. Fixes itself, and we know roughly when.
    network/timeout -- retry. Probably already fixed itself.

The category that mattered most and was wrong most often is ``rate_limited``.
Azure Cost Management throttles aggressively; ``AzureProvider._cm_query``
retries with Retry-After and then re-raises, and the re-raised HTTP 429 landed
in the old classifier's final ``return "unknown"`` because nothing above it
matched. So the UI told users an unexpected error had occurred, when the true
answer was "Azure asked us to wait 32 seconds." That is the bug this module
exists to close, and ``verify_cost_errors.py`` pins it.

Ordering matters here. Checks run most-specific first: a 429 response body can
easily contain the word "connection" or "timeout", and a permission denial can
mention a client ID. Whichever check runs first wins, so the order below is
deliberate, not incidental.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional, Tuple

# ── Categories ────────────────────────────────────────────────────────────────
CREDENTIALS = "credentials"
PERMISSION = "permission"
RATE_LIMITED = "rate_limited"
NETWORK = "network"
TIMEOUT = "timeout"
PROVIDER_UNAVAILABLE = "provider_unavailable"
UNSUPPORTED = "unsupported"
INVALID_REQUEST = "invalid_request"
PARTIAL = "partial"
UNKNOWN = "unknown"

CATEGORIES = (
    CREDENTIALS, PERMISSION, RATE_LIMITED, NETWORK, TIMEOUT,
    PROVIDER_UNAVAILABLE, UNSUPPORTED, INVALID_REQUEST, PARTIAL, UNKNOWN,
)

# Categories that will not resolve on their own -- a human must change
# something. The UI uses this to decide between "retrying..." and "action
# needed", and the cache uses it to avoid pointless fast retries.
TERMINAL_CATEGORIES = frozenset({CREDENTIALS, PERMISSION, UNSUPPORTED, INVALID_REQUEST})

# Categories worth retrying quickly, because the next attempt may well succeed.
RETRYABLE_CATEGORIES = frozenset(
    {RATE_LIMITED, NETWORK, TIMEOUT, PROVIDER_UNAVAILABLE}
)


class NotSupportedError(RuntimeError):
    """Raised when a caller asks a provider for a dimension its integration
    cannot supply -- e.g. AWS per-resource cost. Distinct from a failure:
    nothing is broken, the answer genuinely does not exist, and the UI must
    say so rather than showing zero."""

    def __init__(self, message: str, *, provider: str = None, dimension: str = None):
        super().__init__(message)
        self.provider = provider
        self.dimension = dimension


@dataclass(frozen=True)
class CostError:
    """A classified billing failure, ready to serialize into an API envelope."""

    category: str
    message: str
    retry_after_seconds: Optional[int] = None
    http_status: Optional[int] = None
    provider: Optional[str] = None

    @property
    def terminal(self) -> bool:
        return self.category in TERMINAL_CATEGORIES

    @property
    def retryable(self) -> bool:
        return self.category in RETRYABLE_CATEGORIES

    def to_dict(self) -> dict:
        return {
            "category": self.category,
            "message": self.message,
            "retry_after_seconds": self.retry_after_seconds,
            "http_status": self.http_status,
            "provider": self.provider,
            "terminal": self.terminal,
            "retryable": self.retryable,
        }


# ── Signal extraction ─────────────────────────────────────────────────────────

def _http_status(exc: Exception) -> Optional[int]:
    """The HTTP status an SDK exception carries, without string-matching.

    Each SDK puts it somewhere different: azure-core sets `status_code` on the
    exception, botocore nests it under response['ResponseMetadata'], and the
    OCI SDK sets `.status`. Reading the structured value first means a message
    that merely *mentions* 403 cannot masquerade as one.
    """
    for attr in ("status_code", "status"):
        value = getattr(exc, attr, None)
        if isinstance(value, int) and 100 <= value < 600:
            return value

    response = getattr(exc, "response", None)
    if response is not None:
        value = getattr(response, "status_code", None)
        if isinstance(value, int):
            return value
        if isinstance(response, dict):
            meta = response.get("ResponseMetadata") or {}
            value = meta.get("HTTPStatusCode")
            if isinstance(value, int):
                return value
    return None


def _retry_after(exc: Exception) -> Optional[int]:
    """Seconds the provider asked us to wait, from the Retry-After header.

    Header first, because it is authoritative. Falls back to parsing the
    common "retry after N seconds" phrasing out of the message, since some
    SDKs surface the hint only in prose.
    """
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if headers is not None:
        try:
            raw = headers.get("Retry-After") or headers.get("retry-after")
            if raw is not None:
                return max(0, int(str(raw).strip()))
        except (ValueError, TypeError, AttributeError):
            pass

    match = re.search(
        r"retry[\s\-]?after[:\s]+(\d+)", str(exc), re.IGNORECASE
    ) or re.search(
        r"try again in (\d+)\s*second", str(exc), re.IGNORECASE
    )
    if match:
        try:
            return max(0, int(match.group(1)))
        except ValueError:
            return None
    return None


def _has(low: str, *needles: str) -> bool:
    return any(n in low for n in needles)


# ── Classification ────────────────────────────────────────────────────────────

def classify(exc: Exception, *, provider: Optional[str] = None) -> CostError:
    """Turn a provider exception into a CostError.

    Checks run most-specific first; see the module docstring on why the order
    is load-bearing.
    """
    from app.services.cost_service import ProviderUnavailableError  # local: cycle

    message = str(exc)
    low = message.lower()
    status = _http_status(exc)

    def built(category: str, text: str, *, retry_after: Optional[int] = None) -> CostError:
        return CostError(
            category=category,
            message=text,
            retry_after_seconds=retry_after,
            http_status=status,
            provider=provider,
        )

    # 1. Not supported. A deliberate signal from our own code, never inferred.
    if isinstance(exc, NotSupportedError):
        return built(UNSUPPORTED, message)

    # 2. Our own "cannot even build the provider" signal.
    if isinstance(exc, ProviderUnavailableError):
        return built(CREDENTIALS, message)

    # 3. Rate limiting. FIRST among the string checks, and keyed on the status
    #    code when there is one -- this is the case the old classifier dropped
    #    into `unknown`, and a throttled response body mentioning "connection"
    #    must not be allowed to steal it.
    if status == 429 or _has(
        low, "too many requests", "429", "throttl", "rate limit", "ratelimit",
        "requestlimitexceeded", "toomanyrequests", "slowdown",
    ):
        wait = _retry_after(exc)
        detail = (
            f"The provider is rate limiting billing queries. It asked us to wait "
            f"{wait} seconds before retrying."
            if wait is not None else
            "The provider is rate limiting billing queries. This resolves on its "
            "own; the next refresh will retry."
        )
        return built(RATE_LIMITED, f"{detail} Raw error: {message[:400]}", retry_after=wait)

    # 4. Permission. Status code first, then each provider's distinctive
    #    error codes -- matched case-sensitively because they are literal
    #    SDK identifiers, not prose.
    if status == 403 or any(k in message for k in (
        "AuthorizationFailed", "AccessDenied", "AccessDeniedException", "Forbidden",
        "NotAuthorizedOrNotFound", "UnauthorizedOperation", "AuthorizationError",
        "InsufficientPrivileges", "NotAuthorized",
    )):
        return built(
            PERMISSION,
            "The account's credentials authenticated successfully but are not "
            "authorized to read billing data. Grant the billing/cost read role on "
            f"this account and retry. Raw error: {message[:400]}",
        )

    # 5. Credentials. 401 means the identity itself was rejected.
    if status == 401 or _has(
        low, "expired", "invalidclienttokenid", "signaturedoesnotmatch",
        "invalid_client", "invalid_grant", "unauthorized_client",
        "invalidauthenticationtoken", "authenticationfailed",
        "could not decrypt", "failed to decrypt", "invalid credentials",
    ):
        return built(
            CREDENTIALS,
            "The account's credentials are invalid, expired, or could not be "
            f"decrypted. Re-add the account. Raw error: {message[:400]}",
        )

    # 6. Timeout, split out from network: a timeout may mean the query is too
    #    large rather than the link being down, which is a different fix.
    if _has(low, "timed out", "timeout", "readtimeout", "connecttimeout",
            "deadline exceeded"):
        return built(
            TIMEOUT,
            "The provider's billing API did not respond in time. Large windows "
            "(180-365 days) are the usual cause; the refresh continues in the "
            f"background. Raw error: {message[:400]}",
        )

    # 7. Provider-side outage. 5xx is the provider's problem, not the caller's.
    if (status is not None and 500 <= status < 600) or _has(
        low, "service unavailable", "internal server error", "bad gateway",
        "serviceunavailable", "internalerror",
    ):
        return built(
            PROVIDER_UNAVAILABLE,
            "The provider's billing service returned a server-side error. This is "
            f"on their side and usually transient. Raw error: {message[:400]}",
        )

    # 8. Transport. Deliberately after timeout/5xx so it catches only what is
    #    genuinely a connection problem.
    if _has(low, "connection", "network", "resolve host", "unreachable",
            "max retries exceeded", "ssl", "unexpected_eof", "forcibly closed",
            "10053", "10054", "remotedisconnected", "endpointconnectionerror"):
        return built(
            NETWORK,
            "A network error occurred while contacting the provider's billing "
            f"API. This usually clears on retry. Raw error: {message[:400]}",
        )

    # 9. We asked for something malformed -- a bad window, an unsupported
    #    granularity, too many groupBy keys. Actionable, but by us, not the user.
    if status == 400 or _has(
        low, "bad request", "validationexception", "invalidparameter",
        "is more than 93 days", "invalid date range", "unsupported granularity",
        "invalid_request",
    ):
        return built(
            INVALID_REQUEST,
            "The billing query itself was rejected as invalid by the provider. "
            "This is a defect in the query, not a problem with the account. "
            f"Raw error: {message[:400]}",
        )

    return built(
        UNKNOWN,
        f"An unexpected error occurred while fetching billing data. Raw error: {message[:400]}",
    )


def categorize(exc: Exception, *, provider: Optional[str] = None) -> Tuple[str, str]:
    """Back-compatible (category, message) pair.

    ``cost_service._categorize_error`` returned this shape and the diagnostics
    payload is built from it, so the tuple form is kept rather than rewriting
    every call site at once.
    """
    err = classify(exc, provider=provider)
    return err.category, err.message


def describe(category: str) -> str:
    """A short, plain explanation of a category, for the diagnostics modal."""
    return {
        CREDENTIALS: "The stored credentials are invalid, expired, or undecryptable.",
        PERMISSION: "The credentials are valid but lack billing-read permission.",
        RATE_LIMITED: "The provider is throttling billing queries. This clears on its own.",
        NETWORK: "A network error interrupted the request to the provider.",
        TIMEOUT: "The provider's billing API did not respond in time.",
        PROVIDER_UNAVAILABLE: "The provider's billing service is returning server errors.",
        UNSUPPORTED: "This provider's billing integration cannot answer this question.",
        INVALID_REQUEST: "The billing query was rejected as malformed by the provider.",
        PARTIAL: "Some sub-queries succeeded and others did not.",
        UNKNOWN: "The failure did not match any known category.",
    }.get(category, "Unrecognized error category.")


def required_permission(provider: Optional[str]) -> Optional[str]:
    """The provider-native permission a `permission` failure is asking for.

    Named explicitly rather than described in prose, because the whole value of
    a permission diagnostic is that the reader can paste it into an IAM policy.
    """
    key = (provider or "").strip().upper()
    if key == "AZURE":
        return "Microsoft.CostManagement/Query/read"
    if key == "AWS":
        return "ce:GetCostAndUsage"
    if key in ("OCI", "ORACLE"):
        return "usage-report READ on the tenancy (Usage API)"
    return None
