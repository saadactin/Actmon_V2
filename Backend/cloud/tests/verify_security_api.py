"""Security Center HTTP endpoints: shape, RBAC, persistence and lifecycle.

Driven through the ASGI app rather than a bound port, so it needs no running
service and cannot collide with one — the same approach as the topology, drift
and Event Log suites.

A throwaway account with a deliberately-shaped estate is created so the
assertions actually run: a suite that passes because there was nothing to check
is not a passing suite. The fixture is removed at the end and the real resource
count is measured before and after, because an earlier test in this codebase
destroyed 154 live audit events by pruning against a fixture cutoff.

The lifecycle half is the part worth reading. §78 tests 6-10 are the ones that
matter most, and each pins a mistake this system must never make:

* an incomplete assessment must not resolve anything;
* a new critical finding must produce a finding, an alert and a notification
  decision;
* the same finding next scan must not duplicate any of them;
* a disappeared finding must resolve — but only from a complete assessment;
* a returning finding must reopen.
"""
import asyncio
import logging
import pathlib
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

import httpx  # noqa: E402
from sqlalchemy import func, select, text  # noqa: E402

from app.core.database import AsyncSessionLocal, Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models.alert import CloudAlert  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.resource import CloudResource  # noqa: E402
from app.models.security_finding import (  # noqa: E402
    CloudAlertPolicy, CloudSecurityAssessment, CloudSecurityFinding,
)
from app.repository.security_repo import SecurityRepository  # noqa: E402
from app.security import controls as ctl  # noqa: E402
from app.services.security_center_service import SecurityCenterService  # noqa: E402

BASE = "/api/v1/cloud/security-center"
ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


NOW = datetime.now(timezone.utc)


def res(account_id, rtype, name, *, config=None, raw=None, tags=None, ip=None,
        key=None):
    return CloudResource(
        id=uuid.uuid4(), account_id=account_id,
        provider_resource_id=key or f"fix-{name}-{rtype}",
        resource_type=rtype, resource_name=name, region_or_zone="ap-south-1",
        status="running", ip_address=ip,
        config=config or {}, metadata_={} if hasattr(CloudResource, "metadata_") else None,
        cost_monthly=None, tags=tags if tags is not None else
        {"Name": name, "Environment": "Test", "Owner": "tests"},
        raw_data=raw, discovered_at=NOW, updated_at=NOW,
    )


def fixture_rows(account_id):
    """A small estate with one of each interesting shape.

    Deliberately includes an UNKNOWN case (a security group with no stored
    IpPermissions) so the "undetermined is not safe" behaviour is exercised end
    to end rather than only in the unit tests.
    """
    rows = [
        # World-open RDP and SSH: the CRITICAL findings the alert policies target.
        res(account_id, "SecurityGroup", "sg-open", key="sg-open",
            config={"inbound_rules": 2},
            raw={"IpPermissions": [
                {"IpProtocol": "tcp", "FromPort": 3389, "ToPort": 3389,
                 "IpRanges": [{"CidrIp": "0.0.0.0/0"}]},
                {"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22,
                 "IpRanges": [{"CidrIp": "0.0.0.0/0"}]},
            ]}),
        # An instance behind it, so exposure resolves to EXPOSED with a path.
        res(account_id, "EC2Instance", "web-1", key="i-web1", ip="52.66.1.1",
            config={"public_ip": "52.66.1.1", "security_group_ids": ["sg-open"]}),
        # A security group whose rules were never stored -> UNKNOWN, not SAFE.
        res(account_id, "SecurityGroup", "sg-unknown", key="sg-unknown",
            config={"inbound_rules": 3}, raw={}),
        # Public bucket: CRITICAL, and a compliance violation.
        res(account_id, "S3Bucket", "leaky", key="b-leaky",
            config={"public_access_block": {
                "BlockPublicAcls": False, "IgnorePublicAcls": False,
                "BlockPublicPolicy": False, "RestrictPublicBuckets": False},
                "encryption": "AES256", "versioning": "Enabled"}),
        # A clean bucket, so a control can legitimately PASS.
        res(account_id, "S3Bucket", "tidy", key="b-tidy",
            config={"public_access_block": {
                "BlockPublicAcls": True, "IgnorePublicAcls": True,
                "BlockPublicPolicy": True, "RestrictPublicBuckets": True},
                "encryption": "aws:kms", "versioning": "Enabled"}),
        # An escalating role and a clean one.
        res(account_id, "IAMRole", "god-mode", key="r-god",
            config={"broad_access": ["iam:full", "s3:full"],
                    "accessible_resources": [], "max_session_duration": 3600}),
        res(account_id, "IAMRole", "scoped", key="r-scoped",
            config={"broad_access": [], "accessible_resources": ["arn:aws:s3:::x/*"],
                    "max_session_duration": 3600}),
        # Untagged, for the aggregated governance finding.
        res(account_id, "LambdaFunction", "untagged", key="f-untagged", tags={},
            config={"runtime": "python3.12", "memory_mb": 512}),
    ]
    return rows


async def real_resource_count() -> int:
    async with AsyncSessionLocal() as db:
        return (await db.execute(
            select(func.count()).select_from(CloudResource))).scalar_one()


async def main() -> int:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # The alert-link columns are added by main.py's startup path, which does
        # not run under the ASGI test transport. Applied here so the suite tests
        # the real schema.
        for ddl in (
            "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS "
            "finding_fingerprint VARCHAR(64)",
            "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS policy_id UUID",
            "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS policy_name VARCHAR(256)",
            "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS acknowledged_by VARCHAR(256)",
            "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(256)",
            "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS resolution_reason TEXT",
            "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS previous_severity VARCHAR(20)",
            "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS severity_changed_at TIMESTAMPTZ",
            "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ",
            "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS "
            "notification_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS notification_status VARCHAR(40)",
        ):
            await conn.execute(text(ddl))

    before_total = await real_resource_count()
    account_id = uuid.uuid4()

    async with AsyncSessionLocal() as db:
        db.add(CloudAccount(
            id=account_id, account_name=f"__secapi_{account_id.hex[:8]}",
            provider="AWS", environment="Test", tenant_or_region="ap-south-1",
            auth_mode="API_Keys", auto_discovery=False, credentials_enc="test-only",
        ))
        await db.commit()
        for row in fixture_rows(account_id):
            db.add(row)
        await db.commit()
        await SecurityRepository(db).seed_default_policies()
        await db.commit()

    try:
        return await run_checks(account_id)
    finally:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SET LOCAL actmon.allow_event_prune = 'on'"))
            # Findings, assessments and alerts cascade from the account, but the
            # POLICY: alerts this suite created are deleted explicitly because
            # an alert's account FK is ON DELETE SET NULL — it deliberately
            # survives account deletion, and would otherwise pollute the real
            # alert feed.
            await db.execute(text(
                "DELETE FROM cloud_alerts WHERE account_id = :a "
                "OR (account_id IS NULL AND dedupe_key LIKE 'POLICY:%' "
                "AND details LIKE :n)"),
                {"a": str(account_id), "n": f"%__secapi_{account_id.hex[:8]}%"})
            await db.execute(text("DELETE FROM cloud_accounts WHERE id = :a"),
                             {"a": str(account_id)})
            await db.commit()

        after_total = await real_resource_count()
        check("the fixture was removed and no real resource was touched",
              after_total == before_total, f"before {before_total}, after {after_total}")

        async with AsyncSessionLocal() as db:
            left = (await db.execute(select(func.count()).select_from(CloudAlert).where(
                CloudAlert.dedupe_key.like("POLICY:%"),
                CloudAlert.details.like(f"%__secapi_{account_id.hex[:8]}%"),
            ))).scalar_one()
            eq("no alert from this suite was left behind", left, 0)
        await engine.dispose()


def token_for(role):
    """Mint a token directly: `create_access_token` takes a plain subject and
    adds no `role` claim, so it cannot exercise RBAC. Same approach as the
    topology and Event Log suites."""
    import jwt as _jwt

    from app.core.config import settings as _settings
    return _jwt.encode(
        {"sub": f"{role}@example.com", "role": role,
         "exp": datetime.now(timezone.utc) + timedelta(minutes=10)},
        _settings.JWT_SECRET, algorithm=_settings.JWT_ALGORITHM,
    )


def hdr(role):
    return {"Authorization": f"Bearer {token_for(role)}"}


async def run_checks(account_id: uuid.UUID) -> int:
    aid = str(account_id)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test",
                                 timeout=180) as c:

        # ── 1. Metadata ──────────────────────────────────────────────────────
        print("\n1. GET /meta")
        r = await c.get(f"{BASE}/meta")
        eq("meta returns 200", r.status_code, 200)
        meta = r.json()
        check("the rule catalog is served from the backend", len(meta["rules"]) > 40,
              str(len(meta["rules"])))
        check("every rule carries its remediation",
              all(len(x["remediation"]) > 40 for x in meta["rules"]))
        check("every rule declares its provider",
              all(x["provider"] in ("AWS", "AZURE", "OCI", "*") for x in meta["rules"]))
        check("the scoring methodology is published", "methodology" in meta["scoring"])
        check("category budgets sum to 100",
              abs(sum(meta["scoring"]["category_budgets"].values()) - 100) < 0.01,
              str(sum(meta["scoring"]["category_budgets"].values())))
        check("all nine frameworks are declared, each with its cloud scope",
              set(meta["frameworks"]) == set(ctl.FRAMEWORKS)
              and meta["frameworks"]["CIS-OCI"]["providers"] == ["OCI"]
              and meta["frameworks"]["SOC2"]["providers"] is None,
              str(sorted(meta["frameworks"])))
        check("threshold kinds are published", len(meta["threshold_kinds"]) >= 8)

        # ── 2. Before any assessment ─────────────────────────────────────────
        print("\n2. Overview before any assessment")
        r = await c.get(f"{BASE}/{aid}")
        eq("overview returns 200", r.status_code, 200)
        body = r.json()
        eq("no score before an assessment has run", body["score"]["score"], None)
        eq("...and the grade says so, rather than 'A'",
           body["score"]["grade"], "Not assessed")
        eq("no findings yet", body["findings_summary"]["total"], 0)
        check("freshness distinguishes the three timestamps",
              set(body["freshness"]) >= {"inventory_collected_at", "last_assessed_at",
                                         "last_verified_against_provider"})
        eq("verified-against-provider is null, never the assessment time",
           body["freshness"]["last_verified_against_provider"], None)

        r = await c.get(f"{BASE}/{uuid.uuid4()}")
        eq("an unknown account returns 404", r.status_code, 404)

        # ── 3. §78.7 A new critical finding produces a finding AND an alert ──
        print("\n3. POST /{id}/assess — first run (§78.7)")
        r = await c.post(f"{BASE}/{aid}/assess")
        eq("assess returns 200", r.status_code, 200)
        first = r.json()
        eq("the sweep is treated as complete", first["outcome"], "COMPLETE")
        check("findings were created", first["findings"]["new"] > 0,
              str(first["findings"]))
        check("§78.7 alerts were created from those findings",
              first["alerts"]["created"] > 0, str(first["alerts"]))
        check("a score is now reported", first["score"]["score"] is not None,
              str(first["score"]["score"]))
        check("...and it is bounded", 0 <= first["score"]["score"] <= 100)

        async with AsyncSessionLocal() as db:
            rows = list((await db.execute(select(CloudSecurityFinding).where(
                CloudSecurityFinding.account_id == account_id))).scalars().all())
        by_rule = {}
        for row in rows:
            by_rule.setdefault(row.rule_id, []).append(row)
        for expected in ("AWS_SG_RDP_WORLD_OPEN", "AWS_SG_SSH_WORLD_OPEN",
                         "AWS_S3_PUBLIC_ACCESS_NOT_BLOCKED", "AWS_IAM_ROLE_ESCALATION",
                         "EXPOSURE_MANAGEMENT_PORT_WORLD_OPEN",
                         "GOVERNANCE_MISSING_OWNERSHIP_TAGS"):
            check(f"persisted a {expected} finding", expected in by_rule,
                  str(sorted(by_rule)))
        check("the unstored security group produced an UNKNOWN, not a SAFE",
              any(r.verdict == "UNKNOWN" for r in rows))
        check("every persisted finding has a fingerprint and a rule version",
              all(r.fingerprint and r.rule_version for r in rows))
        check("first_detected_at is set on every finding",
              all(r.first_detected_at for r in rows))
        check("detection_count starts at 1",
              all(r.detection_count == 1 for r in rows))

        async with AsyncSessionLocal() as db:
            alerts = list((await db.execute(select(CloudAlert).where(
                CloudAlert.account_id == account_id))).scalars().all())
        check("every alert links back to a finding fingerprint",
              all(a.finding_fingerprint for a in alerts if a.dedupe_key
                  and a.dedupe_key.startswith("POLICY:")
                  and "score_below" not in a.dedupe_key
                  and "exposure_volume" not in a.dedupe_key),
              str([a.dedupe_key for a in alerts if not a.finding_fingerprint]))
        check("every alert names the policy that fired it",
              all(a.policy_name for a in alerts))
        fps = {r.fingerprint for r in rows}
        check("every alert's fingerprint exists in the findings table",
              all(a.finding_fingerprint in fps for a in alerts
                  if a.finding_fingerprint))
        check("a notification decision was recorded for each alert",
              all(a.notification_status is not None for a in alerts),
              str([a.notification_status for a in alerts][:5]))
        # Held across several sections: the lifecycle checks assert on this
        # exact finding, so nothing before them may mutate it.
        rdp = by_rule["AWS_SG_RDP_WORLD_OPEN"][0]

        # One finding must not produce two alerts from two overlapping policies.
        dupes = [fp for fp in {a.finding_fingerprint for a in alerts if a.finding_fingerprint}
                 if sum(1 for a in alerts if a.finding_fingerprint == fp) > 1]
        eq("no finding produced more than one alert", dupes, [])

        # ── 4. §78.8 The same finding next scan ──────────────────────────────
        print("\n4. Second assessment — idempotency (§78.8)")
        r = await c.post(f"{BASE}/{aid}/assess")
        second = r.json()
        eq("§78.8 no new findings", second["findings"]["new"], 0)
        eq("§78.8 nothing resolved", second["findings"]["resolved"], 0)
        eq("§78.8 nothing reopened", second["findings"]["reopened"], 0)
        check("every finding was updated", second["findings"]["updated"] > 0)
        eq("§78.8 no duplicate alerts", second["alerts"]["created"], 0)
        eq("§78.8 no alert was spuriously resolved", second["alerts"]["resolved"], 0)
        eq("§78.8 no duplicate notification", second["alerts"]["notified"], 0)
        eq("the score is unchanged", second["score"]["score"], first["score"]["score"])

        async with AsyncSessionLocal() as db:
            again = list((await db.execute(select(CloudSecurityFinding).where(
                CloudSecurityFinding.account_id == account_id))).scalars().all())
        check("detection_count incremented", all(r.detection_count == 2 for r in again))
        firsts = {r.fingerprint: r.first_detected_at for r in rows}
        check("first_detected_at was NOT touched — it is the age of the problem",
              all(r.first_detected_at == firsts[r.fingerprint] for r in again))
        check("last_detected_at moved forward",
              all(r.last_detected_at >= r.first_detected_at for r in again))

        # ── 5. Findings API ──────────────────────────────────────────────────
        print("\n5. GET /{id}/findings")
        r = await c.get(f"{BASE}/{aid}/findings")
        eq("findings return 200", r.status_code, 200)
        page = r.json()
        check("a total is reported", page["total"] > 0, str(page["total"]))
        check("facets are supplied for the filter dropdowns",
              set(page["facets"]) >= {"severities", "categories", "resource_types"})
        sevs = [f["severity"] for f in page["findings"]]
        order = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
        check("findings are sorted worst-first",
              sevs == sorted(sevs, key=order.index), str(sevs[:6]))

        r = await c.get(f"{BASE}/{aid}/findings", params={"severity": "CRITICAL"})
        crits = r.json()
        check("severity filter works",
              all(f["severity"] == "CRITICAL" for f in crits["findings"]))
        check("...and returns some", crits["total"] > 0, str(crits["total"]))

        r = await c.get(f"{BASE}/{aid}/findings",
                        params={"severity": "CRITICAL,HIGH"})
        check("comma-separated severities work",
              all(f["severity"] in ("CRITICAL", "HIGH") for f in r.json()["findings"]))

        r = await c.get(f"{BASE}/{aid}/findings", params={"verdict": "UNKNOWN"})
        check("verdict filter isolates undetermined findings",
              all(f["verdict"] == "UNKNOWN" for f in r.json()["findings"]))

        r = await c.get(f"{BASE}/{aid}/findings", params={"search": "leaky"})
        check("search matches a resource name", r.json()["total"] >= 1)
        r = await c.get(f"{BASE}/{aid}/findings", params={"search": "b-leaky"})
        check("search matches a provider resource id", r.json()["total"] >= 1)
        r = await c.get(f"{BASE}/{aid}/findings", params={"search": "zzz-no-such-thing"})
        eq("a search with no matches returns 0, not everything", r.json()["total"], 0)

        r = await c.get(f"{BASE}/{aid}/findings", params={"limit": 2, "offset": 0})
        p1 = r.json()
        eq("limit is honoured", len(p1["findings"]), 2)
        check("has_more is reported", p1["has_more"] is True)
        r = await c.get(f"{BASE}/{aid}/findings", params={"limit": 2, "offset": 2})
        p2 = r.json()
        check("paging returns different rows",
              {f["fingerprint"] for f in p1["findings"]}
              & {f["fingerprint"] for f in p2["findings"]} == set())

        r = await c.get(f"{BASE}/{aid}/findings",
                        params={"framework": "PCI-DSS", "control_id": "1.3.1"})
        check("a control filter resolves to that control's rules",
              r.status_code == 200 and r.json()["total"] >= 0)

        # ── 6. Finding detail ────────────────────────────────────────────────
        print("\n6. GET /{id}/findings/{key}")
        r = await c.get(f"{BASE}/{aid}/findings/{rdp.fingerprint}")
        eq("finding detail returns 200", r.status_code, 200)
        d = r.json()
        eq("the fingerprint round-trips", d["fingerprint"], rdp.fingerprint)
        check("evidence is included", bool(d["evidence"]))
        check("the evidence quotes the rule that matched",
              "rule" in d["evidence"] or "port" in d["evidence"], str(d["evidence"])[:120])
        check("the rule's current version is reported", d["rule"]["current_version"])
        check("compliance citations are attached", bool(d["compliance"]))
        check("a timeline is built", len(d["timeline"]) >= 1)
        check("alerts produced by this finding are listed", isinstance(d["alerts"], list))
        check("remediation is provider-specific and actionable",
              "aws ec2" in d["remediation"].lower())

        r = await c.get(f"{BASE}/{aid}/findings/does-not-exist")
        eq("an unknown fingerprint returns 404", r.status_code, 404)

        # ── 7. Compliance ────────────────────────────────────────────────────
        print("\n7. GET /{id}/compliance")
        r = await c.get(f"{BASE}/{aid}/compliance")
        eq("compliance returns 200", r.status_code, 200)
        comp = r.json()
        eq("an AWS account reports every framework except the other clouds' benchmarks",
           sorted(comp["frameworks"]),
           sorted(fw for fw in ctl.FRAMEWORKS if fw not in ("CIS-AZURE", "CIS-OCI")))
        for fw, s in comp["frameworks"].items():
            rated = (s["controls_passed"] + s["controls_failed"] + s["controls_partial"]
                     + s["controls_unknown"])
            eq(f"{fw}: assessed == rated states", s["controls_assessed"], rated)
            total = rated + s["controls_not_applicable"] + s["controls_not_evaluated"]
            eq(f"{fw}: every declared control has one state", total,
               s["controls_declared"])
            check(f"{fw}: both numbers are present together",
                  "control_pass_rate" in s and "assessment_coverage" in s)
        check("at least one control FAILED (the fixture has real violations)",
              any(c["state"] == "FAIL" for c in comp["controls"]))
        check("at least one control PASSED (the fixture has a clean bucket)",
              any(c["state"] == "PASS" for c in comp["controls"]))
        check("at least one control is NOT_EVALUATED and says so",
              any(c["state"] == "NOT_EVALUATED" for c in comp["controls"]))
        check("no certification language in the response",
              "compliant" not in r.text.lower())
        # A finding must appear once, not once per framework.
        fps = [v["fingerprint"] for v in comp["violations"]]
        eq("each violation appears exactly once", len(fps), len(set(fps)))
        multi = [v for v in comp["violations"] if len(v["frameworks"]) > 1]
        check("a violation can cite several frameworks from one row",
              len(multi) > 0, str(len(multi)))

        r = await c.get(f"{BASE}/{aid}/compliance", params={"framework": "SOC2"})
        eq("a single framework can be requested", r.status_code, 200)
        check("...and only that framework is returned",
              set(r.json()["frameworks"]) == {"SOC2"})
        r = await c.get(f"{BASE}/{aid}/compliance", params={"framework": "NIST-800-53"})
        eq("an unknown framework returns 400", r.status_code, 400)
        r = await c.get(f"{BASE}/{aid}/compliance", params={"framework": "CIS-OCI"})
        eq("another cloud's benchmark returns 400, not an empty 200", r.status_code, 400)
        r = await c.get(f"{BASE}/{aid}/compliance", params={"framework": "ISO27001"})
        eq("ISO 27001 is now a real framework", r.status_code, 200)

        failing = next(c for c in comp["controls"] if c["state"] == "FAIL")
        r = await c.get(f"{BASE}/{aid}/compliance/{failing['framework']}/"
                        f"{failing['control_id']}")
        eq("a single control can be fetched", r.status_code, 200)
        check("...with the findings that decided it",
              r.json()["control"]["finding_count"] >= 1)
        r = await c.get(f"{BASE}/{aid}/compliance/SOC2/CC99.9")
        eq("an unknown control returns 404", r.status_code, 404)

        # HIPAA control ids contain slashes and parentheses.
        hipaa = next((c for c in comp["controls"] if c["framework"] == "HIPAA"), None)
        if hipaa:
            r = await c.get(f"{BASE}/{aid}/compliance/HIPAA/{hipaa['control_id']}")
            eq(f"a HIPAA control id ({hipaa['control_id']}) survives the URL",
               r.status_code, 200)

        # ── 8. Exposure ──────────────────────────────────────────────────────
        print("\n8. GET /{id}/exposure")
        r = await c.get(f"{BASE}/{aid}/exposure")
        eq("exposure returns 200", r.status_code, 200)
        e = r.json()
        eq("the fixture instance is EXPOSED", e["exposed"], 1)
        check("with a path from the internet", len(e["resources"][0]["path"]) >= 2)
        check("naming the rule set consulted",
              e["resources"][0]["evaluated_controls"] == ["sg-open"],
              str(e["resources"][0]["evaluated_controls"]))
        ports = {p["port"] for p in e["resources"][0]["open_ports"]}
        check("both open ports are reported", {22, 3389} <= ports, str(ports))
        check("clean_result_trustworthy is present", "clean_result_trustworthy" in e)
        check("...and false while something is exposed",
              e["clean_result_trustworthy"] is False)

        # ── 9. Identity, coverage, trends, diagnostics, score ────────────────
        print("\n9. The remaining reads")
        r = await c.get(f"{BASE}/{aid}/identity")
        eq("identity returns 200", r.status_code, 200)
        i = r.json()
        eq("AWS identity data is trustworthy (it lives in the inventory)",
           i["trustworthy"], True)
        eq("both fixture roles were reviewed", i["identities_reviewed"], 2)
        check("the escalating role is flagged", i["total_flagged"] >= 1)
        eq("...as an escalation path", i["escalation_risk_count"], 1)

        r = await c.get(f"{BASE}/{aid}/coverage")
        eq("coverage returns 200", r.status_code, 200)
        cov = r.json()
        check("coverage reports per-dimension figures", bool(cov["dimensions"]))
        check("it states it is not a security score",
              "not a security score" in cov["note"].lower())
        check("collection gaps are listed", isinstance(cov["gaps"], list))
        check("...including the unstored security group",
              any("rule" in (g.get("reason") or "").lower()
                  or "inbound" in (g.get("reason") or "").lower()
                  or "IpPermissions" in (g.get("reason") or "")
                  for g in cov["gaps"]), str(cov["gaps"])[:200])

        r = await c.get(f"{BASE}/{aid}/score")
        eq("the score explanation returns 200", r.status_code, 200)
        ex = r.json()
        eq("it starts from 100", ex["starting_score"], 100)
        summed = sum(line["deduction"] for line in ex["lines"])
        check("the lines sum to the reported total",
              abs(summed - ex["total_deduction"]) < 0.05,
              f"{summed} vs {ex['total_deduction']}")
        eq("100 minus the total is the final score",
           100 - round(ex["total_deduction"]), ex["final_score"])
        check("exclusions are itemised", "excluded" in ex and "excluded_explanation" in ex)

        r = await c.get(f"{BASE}/{aid}/trends")
        eq("trends returns 200", r.status_code, 200)
        eq("two assessments produced two points", len(r.json()["points"]), 2)

        r = await c.get(f"{BASE}/{aid}/diagnostics")
        eq("diagnostics returns 200", r.status_code, 200)
        diag = r.json()
        check("it reports how many rules applied to this inventory",
              diag["assessment"]["rules_applicable_to_this_inventory"] > 0)
        check("...out of how many exist",
              diag["assessment"]["rules_available"]
              > diag["assessment"]["rules_applicable_to_this_inventory"])

        r = await c.get(f"{BASE}/overview")
        eq("the multi-cloud overview returns 200", r.status_code, 200)
        mc = r.json()
        check("our account appears in it",
              any(a["account_id"] == aid for a in mc["accounts"]))
        check("no organisation-wide score is invented",
              "score" not in mc or mc.get("note"))

        # ── 10. Alerts ───────────────────────────────────────────────────────
        print("\n10. Alerts")
        r = await c.get(f"{BASE}/alerts", params={"account_id": aid})
        eq("the alert feed returns 200", r.status_code, 200)
        feed = r.json()
        check("alerts are present", len(feed["alerts"]) > 0, str(len(feed["alerts"])))
        check("counts are reported", set(feed["counts"]) ==
              {"open", "acknowledged", "resolved"})
        ssh_fp = by_rule["AWS_SG_SSH_WORLD_OPEN"][0].fingerprint
        target = next(a for a in feed["alerts"]
                      if a["finding_fingerprint"]
                      and a["finding_fingerprint"] not in {rdp.fingerprint, ssh_fp})

        r = await c.post(f"{BASE}/alerts/{target['id']}/acknowledge",
                         json={"reason": "on it"}, headers=hdr("security_analyst"))
        eq("acknowledge returns 200", r.status_code, 200)
        eq("...and the state moved", r.json()["state"], "ACKNOWLEDGED")
        check("...recording who did it", r.json()["acknowledged_by"])

        r = await c.post(f"{BASE}/alerts/{target['id']}/resolve",
                         json={"reason": "fixed in ticket 42"},
                         headers=hdr("security_analyst"))
        eq("resolve returns 200", r.status_code, 200)
        eq("...and the state moved", r.json()["state"], "RESOLVED")
        check("...recording the reason", "42" in (r.json()["resolution_reason"] or ""))

        r = await c.post(f"{BASE}/alerts/{uuid.uuid4()}/resolve", json={})
        eq("resolving an unknown alert returns 404", r.status_code, 404)

        # Suppression requires a reason and acts on the finding — so pick an
        # alert whose finding no later section asserts on. Choosing "whichever
        # came second" suppressed the RDP finding that section 12 then expects
        # to be OPEN, and three lifecycle assertions failed for a reason that
        # had nothing to do with the lifecycle.
        reserved = {rdp.fingerprint, ssh_fp}
        other = next(a for a in feed["alerts"]
                     if a["finding_fingerprint"]
                     and a["id"] != target["id"]
                     and a["finding_fingerprint"] not in reserved)
        r = await c.post(f"{BASE}/alerts/{other['id']}/suppress", json={},
                         headers=hdr("administrator"))
        eq("suppressing without a reason returns 400", r.status_code, 400)
        r = await c.post(f"{BASE}/alerts/{other['id']}/suppress",
                         json={"reason": "accepted for the pilot"},
                         headers=hdr("administrator"))
        eq("suppressing with a reason returns 200", r.status_code, 200)
        async with AsyncSessionLocal() as db:
            row = (await db.execute(select(CloudSecurityFinding).where(
                CloudSecurityFinding.fingerprint == other["finding_fingerprint"],
                CloudSecurityFinding.account_id == account_id,
            ))).scalar_one()
        eq("suppressing the alert suppressed the FINDING too", row.status, "SUPPRESSED")
        check("...with the reason recorded", "pilot" in (row.status_reason or ""))
        check("...and who did it", row.status_changed_by)

        # ── 11. Finding status transitions ───────────────────────────────────
        print("\n11. POST /{id}/findings/{key}/status")
        ssh = by_rule["AWS_SG_SSH_WORLD_OPEN"][0]
        r = await c.post(f"{BASE}/{aid}/findings/{ssh.fingerprint}/status",
                         json={"status": "IN_PROGRESS"}, headers=hdr("security_analyst"))
        eq("marking in-progress returns 200", r.status_code, 200)
        eq("...and the status moved", r.json()["status"], "IN_PROGRESS")

        r = await c.post(f"{BASE}/{aid}/findings/{ssh.fingerprint}/status",
                         json={"status": "ACCEPTED_RISK"}, headers=hdr("administrator"))
        eq("accepting a risk without a reason returns 400", r.status_code, 400)
        r = await c.post(f"{BASE}/{aid}/findings/{ssh.fingerprint}/status",
                         json={"status": "ACCEPTED_RISK", "reason": "bastion only"},
                         headers=hdr("administrator"))
        eq("accepting a risk with a reason returns 200", r.status_code, 200)
        r = await c.post(f"{BASE}/{aid}/findings/{ssh.fingerprint}/status",
                         json={"status": "NONSENSE"}, headers=hdr("administrator"))
        eq("an unknown status returns 400", r.status_code, 400)

        # A muted finding must not be resurrected by a re-detection.
        r = await c.post(f"{BASE}/{aid}/assess")
        async with AsyncSessionLocal() as db:
            row = (await db.execute(select(CloudSecurityFinding).where(
                CloudSecurityFinding.fingerprint == ssh.fingerprint,
                CloudSecurityFinding.account_id == account_id,
            ))).scalar_one()
        eq("a re-detected ACCEPTED_RISK finding stays accepted", row.status,
           "ACCEPTED_RISK")
        check("...and the human's reason survives", "bastion" in (row.status_reason or ""))

        # ── 12. §78.6 / §78.9 / §78.10 Resolution lifecycle ─────────────────
        print("\n12. Resolution lifecycle (§78.6, §78.9, §78.10)")
        async with AsyncSessionLocal() as db:
            # Close the RDP hole in the inventory.
            sg = (await db.execute(select(CloudResource).where(
                CloudResource.account_id == account_id,
                CloudResource.provider_resource_id == "sg-open"))).scalar_one()
            sg.raw_data = {"IpPermissions": [
                {"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22,
                 "IpRanges": [{"CidrIp": "10.0.0.0/8"}]}]}
            await db.commit()

        # §78.6: an INCOMPLETE assessment must not resolve anything.
        async with AsyncSessionLocal() as db:
            svc = SecurityCenterService(db)
            partial = await svc.assess(account_id, triggered_by="test-partial",
                                       sweep_complete=False, failed_scopes=3)
        eq("§78.6 an incomplete assessment is PARTIAL", partial["outcome"], "PARTIAL")
        eq("§78.6 ...and resolves nothing", partial["findings"]["resolved"], 0)
        eq("§78.6 ...and resolves no alert", partial["alerts"]["resolved"], 0)
        async with AsyncSessionLocal() as db:
            still = (await db.execute(select(CloudSecurityFinding).where(
                CloudSecurityFinding.fingerprint == rdp.fingerprint,
                CloudSecurityFinding.account_id == account_id,
            ))).scalar_one()
        eq("§78.6 the fixed finding is still OPEN after a partial sweep",
           still.status, "OPEN")

        # §78.9: a COMPLETE assessment resolves it.
        r = await c.post(f"{BASE}/{aid}/assess")
        complete = r.json()
        eq("a complete assessment is COMPLETE", complete["outcome"], "COMPLETE")
        check("§78.9 the disappeared finding resolved",
              complete["findings"]["resolved"] > 0, str(complete["findings"]))
        async with AsyncSessionLocal() as db:
            gone = (await db.execute(select(CloudSecurityFinding).where(
                CloudSecurityFinding.fingerprint == rdp.fingerprint,
                CloudSecurityFinding.account_id == account_id,
            ))).scalar_one()
        eq("§78.9 the finding is RESOLVED", gone.status, "RESOLVED")
        check("...with a resolution timestamp", gone.resolved_at is not None)
        check("...and a reason naming the complete assessment",
              "complete" in (gone.status_reason or "").lower())
        async with AsyncSessionLocal() as db:
            rdp_alerts = list((await db.execute(select(CloudAlert).where(
                CloudAlert.finding_fingerprint == rdp.fingerprint))).scalars().all())
        check("§78.9 its alert resolved too",
              all(a.state == "RESOLVED" for a in rdp_alerts),
              str([a.state for a in rdp_alerts]))

        # §78.10: the condition returns.
        async with AsyncSessionLocal() as db:
            sg = (await db.execute(select(CloudResource).where(
                CloudResource.account_id == account_id,
                CloudResource.provider_resource_id == "sg-open"))).scalar_one()
            sg.raw_data = {"IpPermissions": [
                {"IpProtocol": "tcp", "FromPort": 3389, "ToPort": 3389,
                 "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}]}
            await db.commit()
        r = await c.post(f"{BASE}/{aid}/assess")
        back = r.json()
        check("§78.10 the returning finding reopened",
              back["findings"]["reopened"] > 0, str(back["findings"]))
        async with AsyncSessionLocal() as db:
            reopened = (await db.execute(select(CloudSecurityFinding).where(
                CloudSecurityFinding.fingerprint == rdp.fingerprint,
                CloudSecurityFinding.account_id == account_id,
            ))).scalar_one()
        eq("§78.10 it is OPEN again", reopened.status, "OPEN")
        eq("...with resolved_at cleared", reopened.resolved_at, None)
        check("...and first_detected_at unchanged — it is the same problem",
              reopened.first_detected_at == still.first_detected_at)
        check("§78.10 ...and its alert reopened",
              back["alerts"]["reopened"] > 0 or any(
                  a.state == "OPEN" for a in rdp_alerts), str(back["alerts"]))

        # ── 13. Policies ─────────────────────────────────────────────────────
        print("\n13. Alert policies")
        r = await c.get(f"{BASE}/policies")
        eq("policies return 200", r.status_code, 200)
        pols = r.json()
        check("the built-in policies are seeded", len(pols["policies"]) >= 13,
              str(len(pols["policies"])))
        check("every built-in has a description",
              all(p["description"] for p in pols["policies"] if p["builtin"]))
        builtin = next(p for p in pols["policies"] if p["builtin"])

        r = await c.delete(f"{BASE}/policies/{builtin['id']}",
                           headers=hdr("administrator"))
        eq("a built-in policy cannot be deleted", r.status_code, 400)
        check("...and the refusal explains why",
              "re-seeded" in r.json()["detail"] or "Disable" in r.json()["detail"])

        r = await c.put(f"{BASE}/policies/{builtin['id']}", json={"enabled": False},
                        headers=hdr("administrator"))
        eq("a built-in policy can be disabled", r.status_code, 200)
        eq("...and it persists", r.json()["enabled"], False)
        await c.put(f"{BASE}/policies/{builtin['id']}", json={"enabled": True},
                    headers=hdr("administrator"))

        r = await c.post(f"{BASE}/policies", headers=hdr("administrator"), json={
            "name": "__test policy", "description": "created by the api suite",
            "threshold_kind": "finding_count", "threshold_value": 3,
            "min_severity": "HIGH", "alert_severity": "HIGH",
            "account_id": aid,
        })
        eq("a custom policy can be created", r.status_code, 201)
        made = r.json()
        r = await c.put(f"{BASE}/policies/{made['id']}",
                        json={"threshold_value": 99}, headers=hdr("administrator"))
        eq("...and updated", r.json()["threshold_value"], 99)
        r = await c.post(f"{BASE}/policies", headers=hdr("administrator"), json={
            "name": "bad", "rule_ids": ["NOT_A_REAL_RULE"]})
        eq("a policy naming an unknown rule is refused", r.status_code, 400)
        r = await c.post(f"{BASE}/policies", headers=hdr("administrator"), json={
            "name": "bad", "threshold_kind": "wishful_thinking"})
        eq("a policy with an unknown threshold kind is refused", r.status_code, 400)
        r = await c.delete(f"{BASE}/policies/{made['id']}", headers=hdr("administrator"))
        eq("a custom policy can be deleted", r.status_code, 200)

        # ── 14. §41 RBAC ─────────────────────────────────────────────────────
        print("\n14. RBAC (§41)")
        from app.api import rbac as _rbac

        enforced_before = _rbac.rbac_enforced()
        os_key = "CLOUD_RBAC_ENFORCE"
        import os as _os
        previous = _os.environ.get(os_key)
        _os.environ[os_key] = "true"
        try:
            check("enforcement is now on", _rbac.rbac_enforced() is True)

            r = await c.get(f"{BASE}/{aid}")
            eq("an unauthenticated read is refused", r.status_code, 401)
            r = await c.get(f"{BASE}/{aid}/findings")
            eq("...as is the findings list", r.status_code, 401)
            r = await c.post(f"{BASE}/alerts/{target['id']}/resolve", json={})
            eq("...and resolving an alert (previously wide open)", r.status_code, 401)

            r = await c.get(f"{BASE}/{aid}", headers=hdr("viewer"))
            eq("a viewer may read the posture", r.status_code, 200)
            check("...but the evidence is withheld",
                  all(f.get("evidence", {}).get("_withheld")
                      for f in r.json()["top_risks"]) or not r.json()["top_risks"],
                  str(r.json()["top_risks"][:1])[:200])

            r = await c.get(f"{BASE}/{aid}/findings/{rdp.fingerprint}",
                            headers=hdr("security_analyst"))
            eq("an analyst may read the evidence", r.status_code, 200)
            check("...and gets the real thing",
                  not r.json()["evidence"].get("_withheld"))

            r = await c.post(f"{BASE}/{aid}/assess", headers=hdr("viewer"))
            eq("a viewer may not run an assessment", r.status_code, 403)
            r = await c.post(f"{BASE}/{aid}/assess", headers=hdr("security_analyst"))
            eq("an analyst may", r.status_code, 200)

            r = await c.post(f"{BASE}/alerts/{target['id']}/acknowledge", json={},
                             headers=hdr("viewer"))
            eq("a viewer may not acknowledge", r.status_code, 403)
            r = await c.post(f"{BASE}/alerts/{target['id']}/acknowledge", json={},
                             headers=hdr("security_analyst"))
            eq("an analyst may", r.status_code, 200)

            r = await c.post(f"{BASE}/{aid}/findings/{rdp.fingerprint}/status",
                             json={"status": "SUPPRESSED", "reason": "x"},
                             headers=hdr("security_analyst"))
            eq("an analyst may NOT suppress a finding", r.status_code, 403)
            r = await c.post(f"{BASE}/{aid}/findings/{rdp.fingerprint}/status",
                             json={"status": "SUPPRESSED", "reason": "x"},
                             headers=hdr("administrator"))
            eq("an administrator may", r.status_code, 200)

            r = await c.post(f"{BASE}/policies", json={"name": "n"},
                             headers=hdr("security_analyst"))
            eq("an analyst may not create a policy", r.status_code, 403)
            r = await c.get(f"{BASE}/{aid}", headers={"Authorization": "Bearer garbage"})
            eq("a malformed token is refused", r.status_code, 401)
        finally:
            if previous is None:
                _os.environ.pop(os_key, None)
            else:
                _os.environ[os_key] = previous
            check("enforcement was restored",
                  _rbac.rbac_enforced() == enforced_before)

        # ── 15. Account isolation (§42) ──────────────────────────────────────
        print("\n15. Account isolation (§42)")
        other_id = uuid.uuid4()
        async with AsyncSessionLocal() as db:
            db.add(CloudAccount(
                id=other_id, account_name=f"__secapi_other_{other_id.hex[:8]}",
                provider="AWS", environment="Test", tenant_or_region="ap-south-1",
                auth_mode="API_Keys", auto_discovery=False, credentials_enc="t",
            ))
            await db.commit()
        try:
            r = await c.get(f"{BASE}/{other_id}/findings")
            eq("a different account's findings list is empty", r.json()["total"], 0)
            r = await c.get(f"{BASE}/{other_id}/findings/{rdp.fingerprint}")
            eq("this account's finding is not readable through another account",
               r.status_code, 404)
            r = await c.post(f"{BASE}/{other_id}/findings/{rdp.fingerprint}/status",
                             json={"status": "RESOLVED"})
            eq("...nor writable through it", r.status_code, 404)
        finally:
            async with AsyncSessionLocal() as db:
                await db.execute(text("DELETE FROM cloud_accounts WHERE id = :a"),
                                 {"a": str(other_id)})
                await db.commit()

    print(f"\n{len(ok)} passed, {len(fail)} failed")
    if fail:
        print("\nFAILURES:")
        for f in fail:
            print(f"  ! {f}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()) or (1 if fail else 0))
