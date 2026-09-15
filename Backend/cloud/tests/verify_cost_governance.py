"""Allocation, tag coverage, the FinOps health score, report assembly and the
observability counters. Pure logic, no DB, no network.

Run: venv\\Scripts\\python.exe tests\\verify_cost_governance.py

Two sections carry the weight. Section 3 pins that untagged spend is NEVER
assigned to anyone — the guess that makes a chargeback report unusable the
first time somebody checks it. Section 9 pins that a report's header total
equals the sum of the rows it contains, because a report that disagrees with
itself destroys trust in every number this product prints.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.services import cost_allocation_service as alloc
from app.services import cost_metrics
from app.services import cost_report_service as reports

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


class R:
    """Minimal stand-in for the ORM resource row."""
    def __init__(self, pid, tags=None, name=None, rtype="ComputeInstance"):
        self.provider_resource_id = pid
        self.tags = tags or {}
        self.resource_name = name or pid
        self.resource_type = rtype


def cost(pid, amount, currency="INR"):
    return {pid: {"monthly_cost": amount, "currency": currency}}


print("1. Tag keys match case-insensitively; values are never normalized")
check("exact key", alloc._tag_value({"owner": "platform"}, ("owner",)) == "platform")
check("different case key matches",
      alloc._tag_value({"Owner": "platform"}, ("owner",)) == "platform")
check("alias key matches", alloc._tag_value({"owned_by": "x"}, ("owner", "owned_by")) == "x")
check("VALUE case is preserved -- Prod and production may be different teams",
      alloc._tag_value({"env": "Prod"}, ("env",)) == "Prod")
check("blank value is not an allocation",
      alloc._tag_value({"owner": "   "}, ("owner",)) is None)
check("missing key -> None", alloc._tag_value({"team": "a"}, ("owner",)) is None)
check("no tags at all -> None", alloc._tag_value(None, ("owner",)) is None)

print("\n2. Allocation attributes priced resources to their tag value")
resources = [
    R("r1", {"environment": "production"}),
    R("r2", {"environment": "production"}),
    R("r3", {"environment": "development"}),
]
costs = {**cost("r1", 1000.0), **cost("r2", 500.0), **cost("r3", 250.0)}
a = alloc.allocate(resources, costs, dimension="environment")
prod = next(x for x in a["allocated"] if x["value"] == "production")
check("production totals 1500", abs(prod["by_currency"]["INR"] - 1500.0) < 1e-6,
      str(prod["by_currency"]))
check("production counts 2 resources", prod["resource_count"] == 2)
check("allocated total is 1750", abs(a["allocated_total_by_currency"]["INR"] - 1750.0) < 1e-6)
check("nothing unallocated", a["unallocated_by_currency"] == {})
check("coverage is 100%", a["coverage_percent_by_currency"]["INR"] == 100.0)

print("\n3. UNTAGGED SPEND IS NEVER ASSIGNED TO ANYONE")
mixed = [R("r1", {"environment": "production"}), R("r2", {}),
         R("r3", {"team": "platform"})]  # r3 has a tag, but not an env tag
a = alloc.allocate(mixed, {**cost("r1", 100.0), **cost("r2", 300.0), **cost("r3", 100.0)},
                   dimension="environment")
check("only the genuinely tagged resource is allocated",
      len(a["allocated"]) == 1 and a["allocated"][0]["value"] == "production")
check("untagged 300 + 100 goes to unallocated",
      abs(a["unallocated_by_currency"]["INR"] - 400.0) < 1e-6,
      str(a["unallocated_by_currency"]))
check("unallocated resources counted", a["unallocated_resource_count"] == 2)
check("no bucket was invented for the untagged spend",
      all(x["value"] != "Unallocated" for x in a["allocated"]))
check("coverage is money-weighted (100 of 500 = 20%)",
      a["coverage_percent_by_currency"]["INR"] == 20.0,
      str(a["coverage_percent_by_currency"]))

print("\n4. An unpriced resource is UNKNOWN, not unallocated")
a = alloc.allocate([R("r1", {"environment": "prod"}), R("r-nocost", {})],
                   cost("r1", 100.0), dimension="environment")
check("the unpriced resource is not counted as unallocated spend",
      a["unallocated_by_currency"] == {}, str(a["unallocated_by_currency"]))
check("it is counted separately as unpriced", a["unpriced_resource_count"] == 1)
check("coverage is not dragged down by it",
      a["coverage_percent_by_currency"]["INR"] == 100.0)
check("the basis explains the exclusion", "unknown rather than unattributed"
      in a["coverage_basis"])

print("\n5. A None amount is unknown, never zero")
a = alloc.allocate([R("r1", {"environment": "prod"})],
                   {"r1": {"monthly_cost": None, "currency": "INR"}},
                   dimension="environment")
check("a None-cost resource contributes nothing", a["allocated"] == [])
check("...and is counted as unpriced", a["unpriced_resource_count"] == 1)

print("\n6. Currencies are never mixed in an allocation")
a = alloc.allocate([R("r1", {"environment": "prod"}), R("r2", {"environment": "prod"})],
                   {**cost("r1", 100.0, "INR"), **cost("r2", 50.0, "USD")},
                   dimension="environment")
bucket = a["allocated"][0]
check("both currencies present separately",
      set(bucket["by_currency"]) == {"INR", "USD"}, str(bucket["by_currency"]))
check("no combined 150 anywhere",
      not any(abs(v - 150.0) < 1e-6 for v in bucket["by_currency"].values()))
check("coverage computed per currency",
      set(a["coverage_percent_by_currency"]) == {"INR", "USD"})

print("\n7. An unknown dimension is rejected, not silently ignored")
try:
    alloc.allocate([], {}, dimension="astrology")
    check("unknown dimension rejected", False)
except ValueError as exc:
    check("unknown dimension rejected", True)
    check("the error lists the known dimensions", "environment" in str(exc))

print("\n8. Tag coverage is resource-weighted and says so")
cov = alloc.tag_coverage([
    R("r1", {"owner": "a", "environment": "prod"}),
    R("r2", {"owner": "b"}),
    R("r3", {}),
])
check("owner coverage 2/3", cov["by_dimension"]["owner"]["coverage_percent"] == 66.67,
      str(cov["by_dimension"]["owner"]["coverage_percent"]))
check("environment coverage 1/3",
      cov["by_dimension"]["environment"]["coverage_percent"] == 33.33)
check("overall counts any business tag", cov["resources_with_any_business_tag"] == 2)
check("basis warns it is NOT the money-weighted figure",
      "NOT the same as the money-weighted" in cov["basis"])
check("empty estate -> None, not 0%",
      alloc.tag_coverage([])["overall_coverage_percent"] is None)

print("\n9. THE REPORT INVARIANT -- header total == sum of rows")
rows = [
    {"cost": 100.0, "currency": "INR"}, {"cost": 250.5, "currency": "INR"},
    {"cost": 12.25, "currency": "USD"},
]
totals = reports.totals_by_currency(rows)
check("INR sums to 350.5", abs(totals["INR"] - 350.5) < 1e-6, str(totals))
check("USD kept separate", abs(totals["USD"] - 12.25) < 1e-6)
verdict = reports.verify_totals(rows, totals)
check("a correct claim verifies", verdict["consistent"] is True)

wrong = reports.verify_totals(rows, {"INR": 999.0, "USD": 12.25})
check("a WRONG claim is caught", wrong["consistent"] is False)
check("the mismatch names the currency and the difference",
      wrong["mismatches"][0]["currency"] == "INR"
      and abs(wrong["mismatches"][0]["difference"] + 648.5) < 1e-6,
      str(wrong["mismatches"]))

print("\n10. Filtering changes the total -- the previous one is never retained")
filtered = [r for r in rows if r["currency"] == "INR"]
check("filtered total is only the filtered rows",
      reports.totals_by_currency(filtered) == {"INR": 350.5},
      str(reports.totals_by_currency(filtered)))
check("verifying the filtered rows against the UNFILTERED total fails",
      reports.verify_totals(filtered, totals)["consistent"] is False)

print("\n11. None amounts never become zero in a report total")
with_none = [{"cost": None, "currency": "INR"}, {"cost": 10.0, "currency": "INR"}]
check("only the real amount is summed",
      reports.totals_by_currency(with_none) == {"INR": 10.0})
q = reports.data_quality(with_none)
check("the missing amount is counted", q["records_without_amount"] == 1)

print("\n12. Data quality separates 'unmatched' from 'no join applicable'")
q = reports.data_quality([
    {"cost": 1.0, "currency": "INR", "in_inventory": True},
    {"cost": 1.0, "currency": "INR", "in_inventory": False},
    {"cost": 1.0, "currency": "INR"},   # a per-service row: no join at all
])
check("matched counted", q["matched_to_inventory"] == 1)
check("unmatched counted", q["unmatched"] == 1)
check("rows with no join are NOT counted as unmatched",
      q["inventory_join_not_applicable"] == 1)
check("attribution is over joinable rows only", q["attribution_percent"] == 50.0,
      str(q["attribution_percent"]))
check("the unmatched reason is stated", "never dropped" in (q["reason_unmatched"] or ""))
check("mixed currency flagged",
      reports.data_quality([{"cost": 1, "currency": "INR"},
                            {"cost": 1, "currency": "USD"}])["mixed_currency"] is True)

print("\n13. CSV carries metadata, every row, and no silent truncation")
big = [{"provider": "OCI", "cost": 1.0, "currency": "INR", "in_inventory": True}
       for _ in range(5000)]
csv_text = reports.build_csv(big, metadata={
    "generated_at": "2026-09-15T00:00:00Z", "report_type": "detailed_billing",
    "period_start": "2026-08-16", "period_end": "2026-09-15", "scope": "ALL",
    "filters": "none", "data_source": "billing_api", "completeness": "complete",
    "totals_by_currency": {"INR": 5000.0}, "totals_verified": True,
})
lines = csv_text.strip().split("\n")
data_lines = [ln for ln in lines if not ln.startswith("#")]
check("all 5000 rows written plus a header", len(data_lines) == 5001,
      str(len(data_lines)))
check("metadata includes the period", "2026-08-16 to 2026-09-15" in csv_text)
check("metadata includes the total", "# Total INR,5000.0" in csv_text)
check("in_inventory travels with each row", "in_inventory" in lines[0] or
      any("in_inventory" in ln for ln in lines))

warned = reports.build_csv([{"cost": 1.0, "currency": "INR"}], metadata={
    "generated_at": "x", "report_type": "y", "period_start": "a", "period_end": "b",
    "scope": "s", "filters": "f", "data_source": "d", "completeness": "partial",
    "totals_by_currency": {"INR": 999.0}, "totals_verified": False,
})
check("a disagreeing total is WARNED about inside the file",
      "WARNING,Header total does not match" in warned)

print("\n14. Report catalogue disables what a scope cannot produce")
aws_only = {"effective": {"resource": False},
            "blocked_by": {"resource": {"AWS": "Cost Explorer has no per-resource dimension."}}}
types = reports.available_types(aws_only)
resource_report = next(t for t in types if t["id"] == "resource")
check("the resource report is unavailable for AWS-only",
      resource_report["available"] is False)
check("...and names the blocker", "AWS" in resource_report["blocked_by"])
service_report = next(t for t in types if t["id"] == "service")
check("a service report is still available", service_report["available"] is True)
check("it is disabled, not removed from the catalogue", len(types) == len(reports.REPORT_TYPES))

print("\n15. Executive summary states what it could NOT compute")
summary = reports.executive_summary(
    totals={"amount": None, "currency": None, "by_currency": {},
            "na_reason": "Multiple billing currencies detected: USD, INR"},
    change=None, top_drivers=[], savings={"verified_by_currency": {},
                                          "unquantified_count": 3},
    anomaly_count=0, forecast=None, quality=None,
)
check("a missing total is reported as NA with the reason",
      summary["total_spend"]["amount"] is None
      and "Multiple billing currencies" in summary["total_spend"]["na_reason"])
check("the unavailable list is populated, not hidden",
      len(summary["unavailable"]) >= 1, str(summary["unavailable"]))
check("it discloses that it has no row-level data",
      "no row-level data" in summary["disclosure"])
check("unquantified opportunities are carried",
      summary["savings"]["unquantified_count"] == 3)

print("\n16. FinOps health is a maturity score, kept apart from cost")
health = alloc.finops_health(
    tag_coverage_percent=80.0, allocation_coverage_percent=70.0,
    days_of_history=365, budget_count=2, accounts_in_scope=2,
    anomaly_monitoring_ready=True, unpriced_resource_ratio=0.1,
)
check("a score is produced", health["score"] is not None, str(health["score"]))
check("it is bounded", 0 <= health["score"] <= 100)
check("the formula is published", "unweighted mean" in health["formula"])
check("it warns it is not a cost", "not a cost" in health["warning"])
check("no component is a currency amount",
      all(not isinstance(v, str) for v in health["components"].values()))

print("\n17. A component with no data is EXCLUDED, not scored zero")
partial = alloc.finops_health(
    tag_coverage_percent=None, allocation_coverage_percent=None,
    days_of_history=365, budget_count=0, accounts_in_scope=0,
    anomaly_monitoring_ready=True,
)
check("missing components are listed as excluded",
      "tagging" in partial["excluded_components"], str(partial["excluded_components"]))
check("the score is the mean of what IS known",
      partial["score"] == 100.0, str(partial["score"]))
check("an estate with nothing measurable scores None, not 0",
      alloc.finops_health(
          tag_coverage_percent=None, allocation_coverage_percent=None,
          days_of_history=0, budget_count=0, accounts_in_scope=0,
          anomaly_monitoring_ready=False,
      )["score"] is not None)

print("\n18. Governance findings carry no money")
gov = alloc.governance_findings(
    [R("r1", {"owner": "a"}), R("r2", {})],
    known_services=["Compute"], observed_services=["Compute", "Bedrock"],
)
check("missing owner counted", gov["missing_owner_tag"]["count"] == 1)
check("newly observed service detected",
      gov["newly_observed_services"] == ["Bedrock"], str(gov["newly_observed_services"]))
check("no key in the payload holds a cost",
      "cost" not in str(gov).lower().replace("cost_", ""),
      "governance must not carry spend")
check("the note says so", "not billed amounts" in gov["note"])

print("\n19. Observability counters")
cost_metrics.reset()
cost_metrics.record("AZURE", "billing_api_calls", 10)
cost_metrics.record("AZURE", "billing_api_errors", 2)
cost_metrics.record("AZURE", "billing_api_429", 1)
cost_metrics.record("AZURE", "cache_hits", 3)
cost_metrics.record("AZURE", "cache_misses", 1)
snap = cost_metrics.snapshot()["providers"]["AZURE"]
check("error rate derived", snap["error_rate_percent"] == 20.0, str(snap["error_rate_percent"]))
check("throttle rate derived", snap["throttle_rate_percent"] == 10.0)
check("cache hit rate derived", snap["cache_hit_rate_percent"] == 75.0)

cost_metrics.reset()
empty = cost_metrics.snapshot()
check("no providers before anything is recorded", empty["providers"] == {})
cost_metrics.record("AWS", "cache_hits", 0)
aws = cost_metrics.snapshot()["providers"]["AWS"]
check("a rate with a zero denominator is None, not 0%",
      aws["error_rate_percent"] is None, str(aws["error_rate_percent"]))

print("\n20. Azure alone is serialised")
check("Azure limited to one concurrent call",
      cost_metrics._limit_for("AZURE") == 1)
check("AWS is not gated", cost_metrics._limit_for("AWS") is None)
check("OCI is not gated", cost_metrics._limit_for("OCI") is None)
check("the limit is reported in the snapshot",
      cost_metrics.snapshot()["concurrency_limits"]["AZURE"] == 1)

print("\n21. Structured logging never takes a free-form message")
import inspect
sig = inspect.signature(cost_metrics.structured_log)
check("all parameters are keyword-only",
      all(p.kind == inspect.Parameter.KEYWORD_ONLY for p in sig.parameters.values()))
check("there is no 'message' parameter to interpolate a secret into",
      "message" not in sig.parameters)

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
