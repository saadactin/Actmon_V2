"""Forecast, anomaly detection, change analysis, month-over-month and the
spend calendar. Pure logic against synthetic series — no DB, no network.

Run: venv\\Scripts\\python.exe tests\\verify_cost_analytics.py

Three properties are pinned throughout, because each has exactly one safe
answer and violating any of them produces confident nonsense:

  * every calculation stays inside one currency;
  * too little history returns NA with a reason, never a number;
  * change analysis reports association, never cause.
"""
import pathlib
import sys
from datetime import date, timedelta

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.services import cost_analytics as ca

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def series(amounts, *, currency="INR", start=date(2026, 8, 1)):
    """A daily series of the given amounts, one per consecutive day."""
    return [
        {"date": (start + timedelta(days=i)).isoformat(),
         "currency": currency, "amount": a, "records": 1}
        for i, a in enumerate(amounts)
    ]


print("1. Forecast refuses to project from too little history")
short = ca.forecast(series([100.0] * 5))
inr = short["by_currency"]["INR"]
check("not available", inr["available"] is False)
check("value is None (NA), never 0", inr["value"] is None, str(inr["value"]))
check("says how many days exist", inr["days_available"] == 5, str(inr["days_available"]))
check("says how many are needed", inr["days_required"] == ca.MIN_DAYS_FORECAST)
check("reason mentions a backfill", "backfill" in inr["reason"].lower())

print("\n2. A steady series projects, with high confidence")
steady = ca.forecast(series([100.0] * 30), today=date(2026, 8, 30))
inr = steady["by_currency"]["INR"]
check("available", inr["available"] is True)
check("daily average is 100", abs(inr["daily_average"] - 100.0) < 1e-9,
      str(inr["daily_average"]))
check("30-day horizon is 3000", abs(inr["horizons"]["next_30_days"] - 3000.0) < 1e-6,
      str(inr["horizons"]["next_30_days"]))
check("confidence high for a flat series", inr["confidence"] == "high", inr["confidence"])
check("method is labelled a run rate, NOT a prediction",
      steady["method"] == "run_rate_projection", steady["method"])
check("basis states the sample size", "30 observed days" in inr["basis"], inr["basis"])

print("\n3. A volatile series still projects, but says confidence is low")
volatile = ca.forecast(series([10, 500, 20, 800, 5, 900, 15, 750, 30, 650,
                               12, 880, 25, 700, 18, 820, 22, 760, 14, 910,
                               28, 640, 16, 890, 24, 720, 19, 830, 21, 770]))
inr = volatile["by_currency"]["INR"]
check("available", inr["available"] is True)
check("confidence low", inr["confidence"] == "low", inr["confidence"])
check("basis names the variability", "variable" in inr["basis"].lower(), inr["basis"])
check("volatility reported numerically", inr["volatility"] > 0.4, str(inr["volatility"]))

print("\n4. Month-to-date actual and projection stay SEPARATE")
# 1-15 Aug at 100/day, asked on the 15th of a 31-day month.
mtd = ca.forecast(series([100.0] * 15, start=date(2026, 8, 1)),
                  today=date(2026, 8, 15))
month = mtd["by_currency"]["INR"]["current_month"]
check("actual is the 15 days measured", abs(month["month_to_date_actual"] - 1500.0) < 1e-6,
      str(month["month_to_date_actual"]))
check("days remaining computed from the real month length",
      month["days_remaining"] == 16, str(month["days_remaining"]))
check("projected remainder is separate", abs(month["projected_remainder"] - 1600.0) < 1e-6,
      str(month["projected_remainder"]))
check("projected total = actual + remainder",
      abs(month["projected_total"] - 3100.0) < 1e-6, str(month["projected_total"]))
check("labelled a projection, not a measured total",
      "projection" in month["label"].lower(), month["label"])

print("\n5. CURRENCIES NEVER MIX in a forecast")
mixed = ca.forecast(series([100.0] * 30) + series([10.0] * 30, currency="USD"))
check("two independent currency blocks", set(mixed["by_currency"]) == {"INR", "USD"},
      str(sorted(mixed["by_currency"])))
check("INR average is 100", abs(mixed["by_currency"]["INR"]["daily_average"] - 100.0) < 1e-9)
check("USD average is 10", abs(mixed["by_currency"]["USD"]["daily_average"] - 10.0) < 1e-9)
check("no blended 55 average anywhere",
      not any(abs(v["daily_average"] - 55.0) < 1e-6
              for v in mixed["by_currency"].values()))

print("\n6. None amounts are excluded, never averaged in as zero")
withnone = series([100.0] * 20)
withnone[5]["amount"] = None
res = ca.forecast(withnone)["by_currency"]["INR"]
check("average is still 100, not 95", abs(res["daily_average"] - 100.0) < 1e-9,
      str(res["daily_average"]))
check("observed days counts only real values", res["observed_days"] == 19,
      str(res["observed_days"]))

print("\n7. Anomaly detection needs a real baseline first")
short = ca.detect_anomalies(series([100.0] * 10))
check("not available", short["by_currency"]["INR"]["available"] is False)
check("says 30 days are required",
      short["by_currency"]["INR"]["days_required"] == ca.MIN_DAYS_ANOMALY)
check("total is 0 and available False, not a fabricated finding",
      short["available"] is False)

print("\n8. A real spike is caught")
spiky = series([100.0] * 39 + [400.0])
found = ca.detect_anomalies(spiky)["by_currency"]["INR"]
check("available", found["available"] is True)
check("exactly one anomaly", found["count"] == 1, str(found["count"]))
hit = found["anomalies"][0]
check("it is the spike day", hit["date"] == spiky[-1]["date"], hit["date"])
check("baseline is the preceding mean", abs(hit["baseline"] - 100.0) < 1e-6,
      str(hit["baseline"]))
check("300% increase reported", abs(hit["percent_increase"] - 300.0) < 1e-6,
      str(hit["percent_increase"]))
check("severity CRITICAL at 300%", hit["severity"] == "CRITICAL", hit["severity"])
check("basis quotes the baseline window", "preceding" in hit["basis"], hit["basis"])

print("\n9. BOTH bars must be cleared -- tiny absolute rises are not anomalies")
# 1 -> 2 is +100% but only +1 absolute.
tiny = series([1.0] * 39 + [2.0])
res = ca.detect_anomalies(tiny, min_absolute=10.0)["by_currency"]["INR"]
check("1 -> 2 is NOT flagged when min_absolute is 10", res["count"] == 0, str(res["count"]))
res = ca.detect_anomalies(tiny, min_absolute=0.5)["by_currency"]["INR"]
check("...but IS flagged when the absolute bar is lowered", res["count"] == 1)

big = series([1000.0] * 39 + [1100.0])   # +10%, large absolute
res = ca.detect_anomalies(big)["by_currency"]["INR"]
check("a +10% rise is not flagged at the 20% default", res["count"] == 0, str(res["count"]))

print("\n10. A spike cannot raise its own baseline to hide")
# The baseline window must EXCLUDE the day under test.
sustained = series([100.0] * 30 + [1000.0] * 10)
res = ca.detect_anomalies(sustained)["by_currency"]["INR"]
check("the first spike day is flagged",
      any(a["date"] == sustained[30]["date"] for a in res["anomalies"]),
      str([a["date"] for a in res["anomalies"]][:3]))
first = next(a for a in res["anomalies"] if a["date"] == sustained[30]["date"])
check("its baseline is 100 (pre-spike), not inflated by itself",
      abs(first["baseline"] - 100.0) < 1e-6, str(first["baseline"]))

print("\n11. Decreases are not anomalies")
drop = series([100.0] * 39 + [10.0])
res = ca.detect_anomalies(drop)["by_currency"]["INR"]
check("a 90% DROP is not reported as an anomaly", res["count"] == 0, str(res["count"]))

print("\n12. Change analysis reports movement, and never claims cause")
current = [{"service": "Database", "currency": "INR", "amount": 300.0},
           {"service": "Storage", "currency": "INR", "amount": 120.0},
           {"service": "Compute", "currency": "INR", "amount": 50.0}]
previous = [{"service": "Database", "currency": "INR", "amount": 120.0},
            {"service": "Storage", "currency": "INR", "amount": 50.0},
            {"service": "Compute", "currency": "INR", "amount": 80.0}]
change = ca.change_analysis(current, previous)
inr = change["by_currency"]["INR"]
check("net change is +220", abs(inr["net_change"] - 220.0) < 1e-6, str(inr["net_change"]))
check("ranked by absolute movement, Database first",
      inr["movements"][0]["service"] == "Database", inr["movements"][0]["service"])
check("Database delta +180", abs(inr["movements"][0]["delta"] - 180.0) < 1e-6)
check("decreases are kept, not dropped",
      any(m["service"] == "Compute" and m["delta"] < 0 for m in inr["movements"]))
check("increases and decreases split out",
      len(inr["increases"]) == 2 and len(inr["decreases"]) == 1,
      f"{len(inr['increases'])}/{len(inr['decreases'])}")
check("the wording says association, NOT cause",
      "not causes" in change["interpretation"], change["interpretation"][:60])
check("'cause' is never claimed as a key", "cause" not in inr)

print("\n13. A newly-appearing service is 'new', not an infinite percentage")
change = ca.change_analysis(
    [{"service": "Bedrock", "currency": "USD", "amount": 82.31}],
    [],
)
mv = change["by_currency"]["USD"]["movements"][0]
check("kind is new", mv["kind"] == "new", mv["kind"])
check("percent is None, not inf", mv["percent"] is None, str(mv["percent"]))
check("delta still reported", abs(mv["delta"] - 82.31) < 1e-6)

print("\n14. Change analysis keeps currencies apart")
change = ca.change_analysis(
    [{"service": "EC2", "currency": "USD", "amount": 100.0},
     {"service": "ADB", "currency": "INR", "amount": 5000.0}],
    [{"service": "EC2", "currency": "USD", "amount": 50.0},
     {"service": "ADB", "currency": "INR", "amount": 4000.0}],
)
check("two currency blocks", set(change["by_currency"]) == {"USD", "INR"})
check("USD net is +50", abs(change["by_currency"]["USD"]["net_change"] - 50.0) < 1e-6)
check("INR net is +1000", abs(change["by_currency"]["INR"]["net_change"] - 1000.0) < 1e-6)
check("no block shows the meaningless +1050 sum",
      not any(abs(b["net_change"] - 1050.0) < 1e-6 for b in change["by_currency"].values()))

print("\n15. Month-over-month marks the running month partial")
monthly = [
    {"month": "2026-07", "currency": "INR", "amount": 4210000.0, "records": 300,
     "provisional_records": 0, "settled": True},
    {"month": "2026-08", "currency": "INR", "amount": 1500000.0, "records": 150,
     "provisional_records": 150, "settled": False},
]
fc = ca.forecast(series([100000.0] * 15, start=date(2026, 8, 1)), today=date(2026, 8, 15))
mom = ca.month_over_month(monthly, today=date(2026, 8, 15), forecast_result=fc)
months = mom["by_currency"]["INR"]["months"]
check("July is not partial", months[0]["partial"] is False)
check("August IS partial", months[1]["partial"] is True)
check("August carries a projection", months[1]["projected_total"] is not None)
check("the projection is labelled", months[1]["projection_label"] == "Run-rate projection")

comparison = mom["by_currency"]["INR"]["change"]
check("comparison uses the PROJECTION for the partial month",
      comparison["to_is_projection"] is True)
check("so it does not report a fake collapse",
      comparison["percent"] > -50, str(comparison["percent"]))
check("from/to months named", comparison["from_month"] == "2026-07"
      and comparison["to_month"] == "2026-08")

print("\n16. A month with provisional rows is never called settled")
check("August not settled", months[1]["settled"] is False)
check("its provisional count is carried", months[1]["provisional_records"] == 150)

print("\n17. Spend calendar scales intensity within a currency only")
cal = ca.spend_calendar(series([50.0, 100.0, 200.0])
                        + series([1.0, 2.0, 4.0], currency="USD"))
inr_days = cal["by_currency"]["INR"]["days"]
usd_days = cal["by_currency"]["USD"]["days"]
check("INR peak is 200", cal["by_currency"]["INR"]["peak"] == 200.0)
check("INR max day has intensity 1.0", max(d["intensity"] for d in inr_days) == 1.0)
check("USD max day ALSO has intensity 1.0 (scaled within its own currency)",
      max(d["intensity"] for d in usd_days) == 1.0)
check("USD is not crushed by the larger INR scale",
      min(d["intensity"] for d in usd_days) > 0.2,
      str(min(d["intensity"] for d in usd_days)))

print("\n18. Calendar omits missing days rather than inventing zeros")
sparse = series([100.0, 200.0])
sparse[0]["amount"] = None
cal = ca.spend_calendar(sparse)
days = cal["by_currency"]["INR"]["days"]
check("the unknown day has amount None", days[0]["amount"] is None)
check("and intensity None, not 0.0", days[0]["intensity"] is None, str(days[0]["intensity"]))
check("the note states the rule", "omitted" in cal["by_currency"]["INR"]["note"])

print("\n19. Calendar marks anomalous days")
spiky = series([100.0] * 39 + [400.0])
anomalies = ca.detect_anomalies(spiky)
cal = ca.spend_calendar(spiky, anomalies=anomalies)
days = cal["by_currency"]["INR"]["days"]
check("the spike day is marked anomalous", days[-1]["anomalous"] is True)
check("ordinary days are not", days[0]["anomalous"] is False)

print("\n20. Empty input yields NA everywhere, never zeros")
check("forecast unavailable", ca.forecast([])["available"] is False)
check("anomalies unavailable", ca.detect_anomalies([])["available"] is False)
check("change analysis unavailable", ca.change_analysis([], [])["available"] is False)
check("calendar unavailable", ca.spend_calendar([])["available"] is False)

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
