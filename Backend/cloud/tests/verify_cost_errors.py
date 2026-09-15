"""Unit tests for cost_errors.classify against the exception shapes each cloud
SDK actually raises. Pure logic, no network, no DB.

Run: venv\\Scripts\\python.exe tests\\verify_cost_errors.py

The load-bearing test here is #2: Azure's HTTP 429 used to classify as
`unknown`, so a throttled subscription told the user "an unexpected error
occurred" instead of "wait 32 seconds". Several tests deliberately bury
misleading words (connection, timeout, client) inside a 429 body to prove the
check ordering holds.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.services import cost_errors as ce
from app.services.cost_service import ProviderUnavailableError

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


class FakeHeaders(dict):
    """Header bag with the .get() azure-core responses expose."""


class FakeResponse:
    def __init__(self, status_code=None, headers=None):
        self.status_code = status_code
        self.headers = FakeHeaders(headers or {})


class AzureError(Exception):
    """Stand-in for azure.core.exceptions.HttpResponseError."""
    def __init__(self, message, status_code=None, headers=None):
        super().__init__(message)
        self.status_code = status_code
        self.response = FakeResponse(status_code, headers)


class BotoError(Exception):
    """Stand-in for botocore.exceptions.ClientError."""
    def __init__(self, message, status=None):
        super().__init__(message)
        self.response = {"ResponseMetadata": {"HTTPStatusCode": status}} if status else {}


class OciError(Exception):
    """Stand-in for oci.exceptions.ServiceError."""
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


print("1. Category vocabulary matches the specification")
expected = {"credentials", "permission", "rate_limited", "network", "timeout",
            "provider_unavailable", "unsupported", "invalid_request", "partial", "unknown"}
check("all 10 categories present", set(ce.CATEGORIES) == expected,
      str(sorted(set(ce.CATEGORIES) ^ expected)))
check("every category has a description",
      all(ce.describe(c) != "Unrecognized error category." for c in ce.CATEGORIES))

print("\n2. THE REGRESSION -- Azure 429 must be rate_limited, never unknown")
throttled = AzureError(
    "(429) Too many requests. Please retry.", status_code=429,
    headers={"Retry-After": "32"},
)
err = ce.classify(throttled, provider="AZURE")
check("category == rate_limited", err.category == ce.RATE_LIMITED, err.category)
check("category is NOT unknown", err.category != ce.UNKNOWN)
check("Retry-After parsed from header", err.retry_after_seconds == 32,
      str(err.retry_after_seconds))
check("http_status carried through", err.http_status == 429, str(err.http_status))
check("marked retryable", err.retryable is True)
check("NOT marked terminal", err.terminal is False)
check("message states the wait", "32 seconds" in err.message, err.message[:80])

print("\n3. 429 detection must not be stolen by misleading words in the body")
sneaky = AzureError(
    "(429) Too many requests: the connection to the backend timed out while "
    "the client was throttled.", status_code=429, headers={"Retry-After": "5"},
)
check("429 with 'connection' + 'timed out' in body still rate_limited",
      ce.classify(sneaky).category == ce.RATE_LIMITED,
      ce.classify(sneaky).category)

print("\n4. 429 with no Retry-After header -- still rate_limited, wait unknown")
no_header = AzureError("Too many requests", status_code=429)
err = ce.classify(no_header)
check("category == rate_limited", err.category == ce.RATE_LIMITED)
check("retry_after is None, not a guessed number", err.retry_after_seconds is None,
      str(err.retry_after_seconds))
check("message does not invent a duration", "seconds before retrying" not in err.message)

print("\n5. Retry-After recovered from prose when there is no header")
prose = Exception("Request throttled. Please retry after 17 seconds.")
err = ce.classify(prose)
check("category == rate_limited", err.category == ce.RATE_LIMITED, err.category)
check("17s parsed from prose", err.retry_after_seconds == 17, str(err.retry_after_seconds))

print("\n6. AWS throttling vocabulary")
for msg in ("ThrottlingException: Rate exceeded",
            "RequestLimitExceeded",
            "SlowDown: please reduce your request rate"):
    check(f"{msg[:28]!r} -> rate_limited",
          ce.classify(BotoError(msg)).category == ce.RATE_LIMITED,
          ce.classify(BotoError(msg)).category)

print("\n7. Permission -- by status code and by each SDK's error code")
cases = [
    (AzureError("(AuthorizationFailed) does not have authorization to perform "
                "action 'Microsoft.CostManagement/Query/read'", status_code=403), "AZURE"),
    (BotoError("AccessDeniedException: not authorized to perform ce:GetCostAndUsage",
               status=403), "AWS"),
    (OciError("NotAuthorizedOrNotFound", status=404), "OCI"),
]
for exc, prov in cases:
    err = ce.classify(exc, provider=prov)
    check(f"{prov} denial -> permission", err.category == ce.PERMISSION, err.category)
    check(f"{prov} denial is terminal", err.terminal is True)

print("\n8. Permission diagnostics name the exact provider permission")
check("Azure -> CostManagement/Query/read",
      ce.required_permission("AZURE") == "Microsoft.CostManagement/Query/read")
check("AWS -> ce:GetCostAndUsage",
      ce.required_permission("AWS") == "ce:GetCostAndUsage")
check("OCI -> usage-report READ", "usage-report" in (ce.required_permission("ORACLE") or ""))
check("unknown provider -> None, not a guess",
      ce.required_permission("GCP") is None)

print("\n9. Credentials vs permission -- 401 is identity, 403 is authorization")
check("401 -> credentials",
      ce.classify(AzureError("InvalidAuthenticationToken", status_code=401)).category
      == ce.CREDENTIALS)
check("403 -> permission",
      ce.classify(AzureError("AuthorizationFailed", status_code=403)).category
      == ce.PERMISSION)
check("expired secret -> credentials",
      ce.classify(Exception("AADSTS7000215: Invalid client secret provided, invalid_client"))
      .category == ce.CREDENTIALS)
check("our own ProviderUnavailableError -> credentials",
      ce.classify(ProviderUnavailableError("credentials failed to decrypt")).category
      == ce.CREDENTIALS)

print("\n10. Timeout is its own category, not folded into network")
err = ce.classify(Exception("Read timed out. (read timeout=60)"))
check("category == timeout", err.category == ce.TIMEOUT, err.category)
check("timeout is retryable", err.retryable is True)
check("message hints at the large-window cause", "365" in err.message)

print("\n11. Transport failures -> network")
for msg in ("SSL: UNEXPECTED_EOF_WHILE_READING",
            "ConnectionResetError(10054, 'forcibly closed by the remote host')",
            "EndpointConnectionError: Could not connect to the endpoint URL"):
    check(f"{msg[:30]!r} -> network",
          ce.classify(Exception(msg)).category == ce.NETWORK,
          ce.classify(Exception(msg)).category)

print("\n12. Provider-side 5xx is not blamed on the account")
err = ce.classify(AzureError("Internal server error", status_code=503))
check("503 -> provider_unavailable", err.category == ce.PROVIDER_UNAVAILABLE, err.category)
check("not terminal (their side, transient)", err.terminal is False)

print("\n13. Malformed query -> invalid_request, distinct from a broken account")
err = ce.classify(OciError("Daily date range is more than 93 days", status=400))
check("OCI 93-day rejection -> invalid_request", err.category == ce.INVALID_REQUEST,
      err.category)
check("message says it is a query defect, not an account problem",
      "not a problem with the account" in err.message)

print("\n14. NotSupportedError -> unsupported, and is terminal")
err = ce.classify(ce.NotSupportedError(
    "AWS resource-level cost requires a CUR pipeline", provider="AWS", dimension="resource"))
check("category == unsupported", err.category == ce.UNSUPPORTED, err.category)
check("terminal", err.terminal is True)
check("not retryable", err.retryable is False)

print("\n15. A genuinely unrecognized error stays unknown -- never force-fitted")
err = ce.classify(Exception("Something nobody has seen before"))
check("category == unknown", err.category == ce.UNKNOWN, err.category)
check("raw error preserved for debugging",
      "Something nobody has seen before" in err.message)

print("\n16. Structured status beats a status-shaped number in prose")
# A message merely MENTIONING 403 must not be read as a denial when the
# structured status says otherwise.
err = ce.classify(AzureError(
    "Query returned 403 rows for the period", status_code=200))
check("'403 rows' in prose does not become a permission error",
      err.category != ce.PERMISSION, err.category)

print("\n17. Back-compatible tuple form still works")
cat, msg = ce.categorize(AzureError("Too many requests", status_code=429), provider="AZURE")
check("categorize returns (category, message)", cat == ce.RATE_LIMITED and isinstance(msg, str))

print("\n18. to_dict is JSON-shaped for the API envelope")
d = ce.classify(throttled, provider="AZURE").to_dict()
check("has every envelope key",
      set(d) == {"category", "message", "retry_after_seconds", "http_status",
                 "provider", "terminal", "retryable"},
      str(sorted(d)))

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
