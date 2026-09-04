"""Provider connection handling and auth-preflight behaviour. No network.

This file used to assert the OPPOSITE of what it asserts now, and the story is
worth keeping, because the mistake is an easy one to repeat.

An isolated measurement said a cached, warm OCI client answered a list call in
~0.04s against ~18s through a freshly built one, so clients were cached per
(service, region) and the scan concurrency was raised to fill the thread pool.
Measured end to end on the live tenancy, that made things far worse:

    per-call client, concurrency 8      57m   468 resources     1 failed scope
    cached client,   concurrency 24     88m   104 resources   636 failed scopes
    cached client,   concurrency 8     370m   363 resources   261 failed scopes

The isolated number was real but unrepresentative. This network aborts TLS
constantly (scan_pool documents the 10053/10054 and SSL UNEXPECTED_EOF pattern),
and a shared pool hands those dead connections to every caller, while a per-call
client lets a broken connection die with its owner. Building a client per call is
not waste here — it is what keeps the sweep resilient.

So the invariants below are: clients are NOT shared, the things that hold no
sockets (a boto3 Session, an Azure credential) ARE, and the empirically tuned
concurrency limits stay put.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_passed = 0
_failed = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    if ok:
        _passed += 1
        print(f"  [PASS] {label}" + (f"  {detail}" if detail else ""))
    else:
        _failed += 1
        print(f"  [FAIL] {label}" + (f"  {detail}" if detail else ""))


def _fake_oci_auth():
    """An OCIAuth stand-in with a real (throwaway) key, since the SDK parses it."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()

    class FakeAuth:
        region = "ap-mumbai-1"
        tenancy_ocid = "ocid1.tenancy.oc1..aaaa"

        def get_config(self):
            return {
                "user": "ocid1.user.oc1..aaaa",
                "fingerprint": "aa:" * 15 + "aa",
                "tenancy": self.tenancy_ocid,
                "region": self.region,
                "key_content": pem,
            }

    return FakeAuth()


# ── OCI ───────────────────────────────────────────────────────────────────────
def test_oci() -> None:
    print("\n=== OCI: a client per call, not a shared pool ===")
    import oci
    from app.providers.oci.oci_scanner import OCIScanner

    sc = OCIScanner(_fake_oci_auth())

    a = sc._client_for_region(oci.core.ComputeClient, "ap-mumbai-1")
    b = sc._client_for_region(oci.core.ComputeClient, "ap-mumbai-1")
    check("two calls return DISTINCT clients (no shared connection pool)",
          a is not b, f"id {id(a)} vs {id(b)}")

    c = sc._client_for_region(oci.core.ComputeClient, "ap-hyderabad-1")
    check("the client is configured for the region asked for",
          c.base_client.config.get("region") == "ap-hyderabad-1",
          str(c.base_client.config.get("region")))
    check("a different region does not disturb the first client's region",
          a.base_client.config.get("region") == "ap-mumbai-1",
          str(a.base_client.config.get("region")))
    check("self.config is not mutated by per-region construction",
          sc.config.get("region") == "ap-mumbai-1", str(sc.config.get("region")))

    # The failing version mounted a pool_block=True adapter. Nothing should be
    # remounting adapters now; the default per-client pool is the point.
    check("no client cache is kept on the scanner",
          not hasattr(sc, "_client_cache"),
          "found _client_cache" if hasattr(sc, "_client_cache") else "")
    check("no pool-widening hook remains", not hasattr(sc, "_widen_pool"))

    ident = sc._identity_client()
    check("_identity_client builds its own client too", ident is not sc._identity_client())
    check("_identity_client uses the home region",
          ident.base_client.config.get("region") == "ap-mumbai-1",
          str(ident.base_client.config.get("region")))


# ── AWS ───────────────────────────────────────────────────────────────────────
def test_aws() -> None:
    print("\n=== AWS: shared Session, per-call clients ===")
    from app.providers.aws.aws_auth import AWSAuth

    auth = AWSAuth({
        "access_key_id": "AKIAIOSFODNN7EXAMPLE",
        "secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "region": "ap-south-1",
    })

    # A Session holds no sockets — only parsed service models — so sharing it is
    # free and saves re-parsing JSON on every one of ~200 calls per sweep.
    s1, s2 = auth.get_session(), auth.get_session()
    check("get_session returns the SAME session (holds no sockets)", s1 is s2)

    a = auth.get_client("ec2", "ap-south-1")
    b = auth.get_client("ec2", "ap-south-1")
    check("get_client returns DISTINCT clients (each with its own pool)", a is not b)
    check("no client cache is kept", not hasattr(auth, "_clients"))

    check("the client targets the region asked for",
          a.meta.region_name == "ap-south-1", a.meta.region_name)
    check("a different region is honoured",
          auth.get_client("ec2", "us-east-1").meta.region_name == "us-east-1")

    # slow_api still has to select the longer timeouts, cache or no cache.
    slow = auth.get_client("ce", "ap-south-1", slow_api=True)
    fast = auth.get_client("ce", "ap-south-1", slow_api=False)
    check("slow_api keeps the long read timeout",
          slow.meta.config.read_timeout == 60, str(slow.meta.config.read_timeout))
    check("normal keeps the short read timeout",
          fast.meta.config.read_timeout == 30, str(fast.meta.config.read_timeout))

    # get_client calls get_session, which takes the same lock. Non-reentrant
    # would deadlock every scan thread.
    import threading

    done = threading.Event()

    def build():
        AWSAuth({
            "access_key_id": "AKIAIOSFODNN7EXAMPLE",
            "secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "region": "ap-south-1",
        }).get_client("ec2")
        done.set()

    t = threading.Thread(target=build, daemon=True)
    t.start()
    t.join(timeout=60)
    check("get_client does not deadlock on the session lock", done.is_set(),
          "timed out — lock is not reentrant" if not done.is_set() else "")


# ── Azure ─────────────────────────────────────────────────────────────────────
def test_azure() -> None:
    print("\n=== Azure: shared credential, per-call clients ===")
    from azure.mgmt.network import NetworkManagementClient
    from azure.mgmt.resource import ResourceManagementClient

    from app.providers.azure.azure_auth import AzureAuth

    auth = AzureAuth({
        "tenant_id": "00000000-0000-0000-0000-000000000000",
        "client_id": "11111111-1111-1111-1111-111111111111",
        "client_secret": "not-a-real-secret",
        "subscription_id": "22222222-2222-2222-2222-222222222222",
    })

    # The credential holds an OAuth token, not sockets — caching it avoids a
    # token fetch per call and is unrelated to the connection-pool problem.
    check("get_credential returns the SAME credential (token cache survives)",
          auth.get_credential() is auth.get_credential())

    a = auth.get_client(NetworkManagementClient)
    b = auth.get_client(NetworkManagementClient)
    check("get_client returns DISTINCT clients", a is not b)
    check("no client cache is kept", not hasattr(auth, "_clients"))
    check("no shared transport is kept", not hasattr(auth, "_transport_obj"))
    check("get_resource_client returns the right type",
          isinstance(auth.get_resource_client(), ResourceManagementClient))


# ── Fan-out limits ────────────────────────────────────────────────────────────
def test_limits() -> None:
    print("\n=== concurrency limits are empirical, not spare capacity ===")
    from app.providers.aws.aws_scanner import AWSScanner
    from app.providers.oci.oci_scanner import OCIScanner
    from app.providers.scan_pool import SCAN_POOL_SIZE

    # Above the pool size the extra tasks only queue inside the executor while
    # holding a semaphore slot, which buys nothing.
    check("OCI concurrency does not exceed the scan pool",
          OCIScanner._MAX_CONCURRENT_SCANS <= SCAN_POOL_SIZE,
          f"{OCIScanner._MAX_CONCURRENT_SCANS} vs pool {SCAN_POOL_SIZE}")
    check("AWS concurrency does not exceed the scan pool",
          AWSScanner._MAX_CONCURRENT_SCANS <= SCAN_POOL_SIZE,
          f"{AWSScanner._MAX_CONCURRENT_SCANS} vs pool {SCAN_POOL_SIZE}")

    # There is deliberately NO "concurrency should equal the pool" check. The
    # pool is shared across providers and accounts, so a provider using less of
    # it is not a bug. Raising OCI 8 -> 24 to satisfy that idea produced 636
    # failed scopes and an incomplete sweep.
    check("OCI concurrency is still the measured-good 8",
          OCIScanner._MAX_CONCURRENT_SCANS == 8,
          str(OCIScanner._MAX_CONCURRENT_SCANS))


# ── Auth preflight ────────────────────────────────────────────────────────────
def test_preflight() -> None:
    """The preflight gates the whole scan, so it must be as resilient as the
    calls behind it — and must never call a dropped connection a credential
    problem. A live AWS account was reported as having "lost access" because one
    STS handshake was cut."""
    print("\n=== auth preflight retry + failure classification ===")
    import asyncio

    from app.providers import scan_pool as sp
    from app.providers.scan_pool import ProviderUnreachable, preflight

    real_sleep = asyncio.sleep
    slept = []

    async def fake_sleep(n):
        slept.append(n)
        await real_sleep(0)

    asyncio.sleep = fake_sleep
    try:
        # The exact failure that aborted a real AWS scan, as the real botocore
        # exception type. Classifying this as permanent is what reported a
        # working account as having lost access.
        from botocore.exceptions import (
            ConnectionClosedError, EndpointConnectionError, ReadTimeoutError,
        )

        real = ConnectionClosedError(endpoint_url="https://sts.ap-south-1.amazonaws.com/")
        check("botocore ConnectionClosedError is transient", sp.is_transient(real),
              str(real)[:70])
        check("botocore ConnectionClosedError is not a denial", not sp.is_denial(real))
        for exc in (
            EndpointConnectionError(endpoint_url="https://rds.sa-east-1.amazonaws.com/"),
            ReadTimeoutError(endpoint_url="https://ec2.ap-south-1.amazonaws.com/"),
        ):
            check(f"botocore {type(exc).__name__} is transient", sp.is_transient(exc))
        check("a denial stays a denial",
              sp.is_denial(Exception("AccessDenied: not authorized")))

        calls = []

        def ok():
            calls.append(1)
            return True

        assert asyncio.run(preflight(ok, provider="AWS")) is True
        check("a working check passes on the first attempt", len(calls) == 1,
              f"{len(calls)} call(s)")

        attempts = []

        def flaky():
            attempts.append(1)
            if len(attempts) < 3:
                raise Exception(
                    'Connection was closed before we received a valid response '
                    'from endpoint URL: "https://sts.ap-south-1.amazonaws.com/".'
                )
            return True

        slept.clear()
        assert asyncio.run(preflight(flaky, provider="AWS")) is True
        check("a dropped connection is retried until it succeeds",
              len(attempts) == 3, f"{len(attempts)} attempts")
        check("retries back off between attempts", slept == [2, 4], str(slept))

        denied = []

        def denial():
            denied.append(1)
            raise Exception("AccessDenied: User is not authorized to perform sts:GetCallerIdentity")

        try:
            asyncio.run(preflight(denial, provider="AWS"))
            check("a denial raises", False, "no exception")
        except ValueError as exc:
            check("a denial raises ValueError (a real credential answer)", True)
            check("a denial is NOT retried", len(denied) == 1, f"{len(denied)} attempts")
            check("the denial message says authentication failed",
                  "authentication failed" in str(exc).lower())
        except ProviderUnreachable:
            check("a denial must not be reported as unreachable", False)

        forever = []

        def always_dropped():
            forever.append(1)
            raise Exception("SSL: UNEXPECTED_EOF_WHILE_READING")

        try:
            asyncio.run(preflight(always_dropped, provider="AWS",
                                  endpoint="sts.ap-south-1.amazonaws.com"))
            check("exhausted transient raises", False, "no exception")
        except ProviderUnreachable as exc:
            check("exhausted transient raises ProviderUnreachable, not ValueError", True)
            check("it used every attempt", len(forever) == sp.PREFLIGHT_ATTEMPTS,
                  f"{len(forever)} of {sp.PREFLIGHT_ATTEMPTS}")
            msg = str(exc).lower()
            check("the message names the endpoint", "sts.ap-south-1.amazonaws.com" in msg)
            check("the message says the credentials were NOT checked",
                  "never checked" in msg, str(exc)[:90])
            check("the message never claims authentication failed",
                  "authentication failed" not in msg, str(exc)[:90])
            check("any mention of lost access is explicitly negated",
                  "lost access" not in msg or "not lost access" in msg, str(exc)[:90])
        except ValueError:
            check("a network drop must not be reported as an auth failure", False)

        def bad_key():
            raise Exception("Invalid private key format")

        try:
            asyncio.run(preflight(bad_key, provider="OCI"))
            check("a bad credential raises", False)
        except ValueError as exc:
            check("a non-transient error is an auth failure",
                  "authentication failed" in str(exc).lower())
        except ProviderUnreachable:
            check("a bad credential must not read as unreachable", False)
    finally:
        asyncio.sleep = real_sleep


if __name__ == "__main__":
    for fn in (test_oci, test_aws, test_azure, test_limits, test_preflight):
        try:
            fn()
        except Exception as exc:  # a broken harness must not read as a pass
            _failed += 1
            print(f"  [FAIL] {fn.__name__} raised {type(exc).__name__}: {exc}")
    print(f"\n=== {_passed} passed, {_failed} failed ===")
    sys.exit(1 if _failed else 0)
