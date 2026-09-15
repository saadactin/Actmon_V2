"""Cross-feature correlation: cost next to config changes and security
findings, without ever claiming causation. Pure logic, no DB.

Run: venv\\Scripts\\python.exe tests\\verify_cost_correlation.py

Section 1 is the point of the module. A cost tool that says "this change caused
+40%" will be believed, and will eventually be wrong. Every correlated item
must carry the relationship kind and the disclaimer, and no field anywhere may
be named or worded as a cause.
"""
import pathlib
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.services import cost_correlation_service as corr

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


class Res:
    id = "r-1"
    provider_resource_id = "ocid1.instance.oc1..abc"
    resource_name = "web-1"
    resource_type = "ComputeInstance"
    region_or_zone = "ap-mumbai-1"
    status = "RUNNING"


class Change:
    def __init__(self, when, field="config.shape", old="VM.Standard2.1",
                 new="VM.Standard2.8"):
        self.detected_at = when
        self.field_path = field
        self.old_value = old
        self.new_value = new
        self.summary = f"{field}: {old} -> {new}"
        self.impact = ["cost"]
        self.severity = "MEDIUM"


class Finding:
    def __init__(self, when, title="Instance exposed to the internet"):
        self.first_seen_at = when
        self.title = title
        self.severity = "HIGH"
        self.category = "exposure"


def series(days, amount, *, start=date(2026, 9, 1), currency="INR"):
    return [
        {"date": (start + timedelta(days=i)).isoformat(),
         "amount": amount, "currency": currency}
        for i in range(days)
    ]


print("1. CAUSATION IS NEVER CLAIMED")
result = corr.correlate(
    resource=Res(),
    series=series(20, 100.0),
    changes=[Change(datetime(2026, 9, 10, tzinfo=timezone.utc))],
    findings=[Finding(datetime(2026, 9, 11, tzinfo=timezone.utc))],
    anomalies=[{"date": "2026-09-10", "currency": "INR"}],
)
check("items live under 'related_observations', not 'causes'",
      "related_observations" in result and "causes" not in result)
for obs in result["related_observations"]:
    check(f"{obs['kind']} states the relationship kind",
          obs["relationship"] == "temporal_proximity", obs["relationship"])
    check(f"{obs['kind']} carries the disclaimer", "not causation" in obs["disclaimer"])
blob = str(result).lower()
check("the word 'caused' appears nowhere in the payload", "caused" not in blob)
check("the word 'because' appears nowhere in the payload", "because" not in blob)
check("the top-level interpretation says so too",
      "not causation" in result["interpretation"])

print("\n2. Proximity is reported as a distance, not a verdict")
obs = next(o for o in result["related_observations"]
           if o["kind"] == "configuration_change")
check("the near anomaly is named", obs["near_cost_anomaly"] is not None)
check("with the days apart", obs["near_cost_anomaly"]["days_apart"] == 0,
      str(obs["near_cost_anomaly"]))

far = corr.correlate(
    resource=Res(), series=series(20, 100.0),
    changes=[Change(datetime(2026, 9, 2, tzinfo=timezone.utc))],
    anomalies=[{"date": "2026-09-18", "currency": "INR"}],
)
check("a distant anomaly is NOT linked",
      far["related_observations"][0]["near_cost_anomaly"] is None)
check("...but the change is still listed",
      far["counts"]["configuration_changes"] == 1)

print("\n3. Observed impact is MEASURED, never priced")
# 7 days at 100, then 7 days at 300, change on the boundary.
step = series(7, 100.0, start=date(2026, 9, 1)) + series(7, 300.0, start=date(2026, 9, 8))
impact = corr.observed_impact(step, date(2026, 9, 8))
check("available", impact["available"] is True, str(impact.get("reason")))
check("before is 100/day", abs(impact["daily_before"] - 100.0) < 1e-6,
      str(impact["daily_before"]))
check("after is 300/day", abs(impact["daily_after"] - 300.0) < 1e-6)
check("delta reported", abs(impact["delta_per_day"] - 200.0) < 1e-6)
check("percent reported", abs(impact["percent"] - 200.0) < 1e-6)
check("basis says it is measured spend, not a price difference",
      "not a computed price difference" in impact["basis"])

print("\n4. An unbalanced comparison is REFUSED, not reported")
# A full week before but only one day after would manufacture a dramatic and
# meaningless percentage.
lopsided = series(7, 100.0, start=date(2026, 9, 1)) + series(1, 900.0, start=date(2026, 9, 8))
impact = corr.observed_impact(lopsided, date(2026, 9, 8))
check("not available", impact["available"] is False)
check("values are None, not a computed number", impact["daily_after"] is None)
check("the reason names the shortfall", "found 7 before and 1 after" in impact["reason"],
      impact["reason"])

print("\n5. No history either side -> NA with a reason")
impact = corr.observed_impact([], date(2026, 9, 8))
check("not available", impact["available"] is False)
check("reason given", bool(impact["reason"]))

print("\n6. None amounts are skipped, never read as zero")
gappy = [{"date": "2026-09-01", "amount": None, "currency": "INR"}] \
    + series(6, 100.0, start=date(2026, 9, 2)) \
    + series(7, 100.0, start=date(2026, 9, 8))
impact = corr.observed_impact(gappy, date(2026, 9, 8))
check("the None day does not drag the mean down",
      abs(impact["daily_before"] - 100.0) < 1e-6, str(impact["daily_before"]))
check("it is excluded from the day count", impact["days_before"] == 6,
      str(impact["days_before"]))

print("\n7. A finding with no date still appears, with impact NA")
undated = corr.correlate(
    resource=Res(), series=series(20, 100.0),
    findings=[Finding(None)],
)
obs = undated["related_observations"][0]
check("the finding is listed", obs["kind"] == "security_finding")
check("its date is None", obs["date"] is None)
check("impact is NA with a reason",
      obs["observed_cost_impact"]["available"] is False
      and "no date" in obs["observed_cost_impact"]["reason"])

print("\n8. Nothing is filtered out for being uninteresting")
many = corr.correlate(
    resource=Res(), series=series(30, 100.0),
    changes=[Change(datetime(2026, 9, d, tzinfo=timezone.utc)) for d in (3, 10, 20)],
    findings=[Finding(datetime(2026, 9, 12, tzinfo=timezone.utc))],
)
check("every change is present", many["counts"]["configuration_changes"] == 3)
check("the finding is present", many["counts"]["security_findings"] == 1)
check("newest first",
      [o["date"] for o in many["related_observations"]]
      == sorted([o["date"] for o in many["related_observations"]], reverse=True))

print("\n9. Resource identity travels with the context")
check("provider-native id is carried",
      result["resource"]["provider_resource_id"] == "ocid1.instance.oc1..abc")
check("name alone is not the identity",
      result["resource"]["provider_resource_id"] != result["resource"]["name"])

print("\n10. Empty input is an empty context, not an error")
empty = corr.correlate(resource=Res(), series=[])
check("no observations", empty["related_observations"] == [])
check("counts are zero", empty["counts"]["configuration_changes"] == 0)
check("the disclaimer is still present", "not causation" in empty["interpretation"])

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
