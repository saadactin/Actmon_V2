"""Client reports: period and schedule arithmetic, money, PDF, roll-ups.

No database. The rules pinned here:

* **A report covers a complete month.** The current month is refused; the
  default is the last complete one.
* **Schedule times are local.** "The 3rd at 09:00" means Asia/Kolkata when the
  schedule says so, and a 00:30 IST run on the 1st still reports on the
  previous month even though it is the day before in UTC.
* **No catch-up flood.** After downtime spanning several due dates, exactly
  one run happens (the latest), and the skipped periods are reported.
* **Money is per currency.** INR uses Indian digit grouping and an ISO code
  (the PDF fonts have no rupee sign); nothing is summed across currencies; an
  unknown amount is "NA", never 0.
* **Posture is never averaged** across accounts.
"""
import pathlib
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import logging  # noqa: E402

logging.disable(logging.CRITICAL)

from app.services.client_report_scheduler import plan_run  # noqa: E402
from app.services.client_report_service import (  # noqa: E402
    _totals, due_period, fmt_money, next_run_after, period_bounds,
)
from app.services.client_service import ClientError  # noqa: E402
from app.services.estate_summary import roll_up  # noqa: E402

ok, fail = [], []
UTC = timezone.utc


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


def raises(fn):
    try:
        fn()
    except ClientError:
        return True
    return False


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== A. Periods ===")
# ═════════════════════════════════════════════════════════════════════════════
eq("default period on 28 Sep is August", period_bounds(None, date(2026, 9, 28)),
   ("2026-08", date(2026, 8, 1), date(2026, 9, 1)))
eq("default in January is the previous December", period_bounds(None, date(2027, 1, 5)),
   ("2026-12", date(2026, 12, 1), date(2027, 1, 1)))
eq("February ends on 1 March", period_bounds("2026-02", date(2026, 9, 28))[2],
   date(2026, 3, 1))
check("the current month is refused (it has not finished)",
      raises(lambda: period_bounds("2026-09", date(2026, 9, 28))))
check("a future month is refused", raises(lambda: period_bounds("2027-01", date(2026, 9, 28))))
check("a malformed period is refused", raises(lambda: period_bounds("Aug 2026", date(2026, 9, 28))))
check("month 13 is refused", raises(lambda: period_bounds("2026-13", date(2026, 9, 28))))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== B. Schedule times are local ===")
# ═════════════════════════════════════════════════════════════════════════════
IST = "Asia/Kolkata"
n = next_run_after(datetime(2026, 9, 2, 12, 0, tzinfo=UTC), day_of_month=3,
                   send_time="09:00", tz_name=IST)
eq("the 3rd at 09:00 IST is 03:30 UTC", n, datetime(2026, 9, 3, 3, 30, tzinfo=UTC))
n = next_run_after(datetime(2026, 9, 3, 3, 30, tzinfo=UTC), day_of_month=3,
                   send_time="09:00", tz_name=IST)
eq("exactly at the run time, the NEXT run is next month (strictly after)", n,
   datetime(2026, 10, 3, 3, 30, tzinfo=UTC))
n = next_run_after(datetime(2026, 12, 20, tzinfo=UTC), day_of_month=3, send_time="09:00",
                   tz_name=IST)
eq("December rolls into January", n, datetime(2027, 1, 3, 3, 30, tzinfo=UTC))
n = next_run_after(datetime(2026, 9, 2, tzinfo=UTC), day_of_month=3, send_time="09:00",
                   tz_name="UTC")
eq("a UTC schedule is UTC", n, datetime(2026, 9, 3, 9, 0, tzinfo=UTC))
eq("a run on 3 Oct reports on September",
   due_period(datetime(2026, 10, 3, 3, 30, tzinfo=UTC), IST), "2026-09")
eq("a 00:30 IST run on 1 Oct (19:00 UTC on 30 Sep) still reports on September",
   due_period(datetime(2026, 9, 30, 19, 0, tzinfo=UTC), IST), "2026-09")
check("an unknown time zone is refused",
      raises(lambda: next_run_after(datetime(2026, 9, 1, tzinfo=UTC), day_of_month=3,
                                    send_time="09:00", tz_name="Mars/Olympus")))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== C. No catch-up flood ===")
# ═════════════════════════════════════════════════════════════════════════════
due = datetime(2026, 9, 3, 3, 30, tzinfo=UTC)
p = plan_run(due, due + timedelta(minutes=5), day_of_month=3, send_time="09:00", tz_name=IST)
eq("on time: runs the due period", p["period"], "2026-08")
eq("...skips nothing", p["skipped_periods"], [])
eq("...and schedules next month", p["next_run_at"], datetime(2026, 10, 3, 3, 30, tzinfo=UTC))
stale = datetime(2026, 6, 3, 3, 30, tzinfo=UTC)
p = plan_run(stale, datetime(2026, 9, 5, tzinfo=UTC), day_of_month=3, send_time="09:00",
             tz_name=IST)
eq("after three months of downtime, ONE run: the latest period", p["period"], "2026-08")
eq("...and the skipped periods are named, not mailed", p["skipped_periods"],
   ["2026-05", "2026-06", "2026-07"])
eq("...next run is the following month", p["next_run_at"],
   datetime(2026, 10, 3, 3, 30, tzinfo=UTC))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== D. Money ===")
# ═════════════════════════════════════════════════════════════════════════════
eq("INR uses Indian grouping and an ISO code", fmt_money(1882345.5, "INR"), "INR 18,82,345.50")
eq("crore grouping", fmt_money(22200000, "INR"), "INR 2,22,00,000.00")
eq("USD uses standard grouping", fmt_money(1234567.891, "usd"), "USD 1,234,567.89")
eq("small amounts", fmt_money(999, "INR"), "INR 999.00")
eq("negative amounts keep their sign", fmt_money(-1234.5, "INR"), "-INR 1,234.50")
eq("an unknown amount is NA, never 0", fmt_money(None, "INR"), "NA")
eq("a missing currency is shown as unknown, not guessed", fmt_money(10, None), "? 10.00")

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== E. Totals and roll-ups never mix currencies or average posture ===")
# ═════════════════════════════════════════════════════════════════════════════
accts = [
    {"account_name": "A", "cost": {"period": {"INR": 100.0}, "previous": {"INR": 80.0},
                                   "days_covered": 31, "days_in_period": 31, "has_data": True},
     "findings": {"HIGH": 2}, "certificates": [1, 2], "changes": {"total": 3},
     "alerts": {"opened": 1, "resolved": 0}, "gaps": ["x"]},
    {"account_name": "B", "cost": {"period": {"USD": 5.0, "INR": 50.0}, "previous": {},
                                   "days_covered": 31, "days_in_period": 31, "has_data": True},
     "findings": {"HIGH": 1}, "certificates": [], "changes": {"total": 0},
     "alerts": {"opened": 0, "resolved": 1}, "gaps": []},
]
t = _totals(accts)
eq("spend is totalled per currency", t["spend"], {"INR": 150.0, "USD": 5.0})
eq("a currency with no previous month is not compared",
   t["spend_change"]["USD"]["percent"], None)
# B was first billed this month. Comparing the whole group, (150-80)/80, calls
# B's first month "+87.5% growth" — the error the live TOR report printed
# ("+12.2%" over a 1.4% fall). Like for like, only A counts.
eq("INR's change is LIKE FOR LIKE: only the account billed in both months counts",
   t["spend_change"]["INR"]["percent"], 25.0)
eq("...naming what it counted", t["spend_change_basis"]["INR"]["included"], ["A"])
eq("...and what it left out, and why", t["spend_change_basis"]["INR"]["excluded"],
   [{"account": "B", "reason": "no billing in the previous month"}])
eq("findings add", t["findings"]["HIGH"], 3)
eq("accounts with gaps are counted", t["accounts_with_gaps"], 1)

partial = [
    {"account_name": "Full", "cost": {"period": {"INR": 200.0}, "previous": {"INR": 100.0},
                                      "days_covered": 31, "days_in_period": 31, "has_data": True}},
    {"account_name": "Half", "cost": {"period": {"INR": 40.0}, "previous": {"INR": 100.0},
                                      "days_covered": 15, "days_in_period": 31, "has_data": True}},
]
t = _totals(partial)
eq("an account billed for only part of the month is left out of the change "
   "(15 days against 31 would read as a fall)", t["spend_change"]["INR"]["percent"], 100.0)
eq("...with its reason", t["spend_change_basis"]["INR"]["excluded"],
   [{"account": "Half", "reason": "billed 15 of 31 days"}])
eq("...and listed as incomplete billing", t["spend_incomplete"],
   [{"account": "Half", "days_covered": 15, "days_in_period": 31}])
t = _totals([partial[1]])
eq("with nothing comparable the change is NA, not a number",
   (t["spend_change"]["INR"]["percent"], t["spend_change"]["INR"]["kind"]),
   (None, "not_comparable"))
check("...and says why", "both complete months" in (t["spend_change"]["INR"]["reason"] or ""))


def summ(name, score, reliable=True, provider="AWS"):
    return {"account_id": name, "account_name": name, "provider": provider, "resources": 1,
            "findings": {}, "open_alerts": 0,
            "certificates": {"expired": 0, "expiring_soon": 0, "expiring_horizon": 0,
                             "tracked": 0, "sources_failing": 0, "sources_total": 0},
            "cost": {"month_to_date": {"INR": 10.0}, "previous_month": {}},
            "security": None if score is None else {"score": score, "grade": "?",
                                                    "score_reliable": reliable}}


r = roll_up([summ("a", 80), summ("b", 35), summ("c", None), summ("d", 60, reliable=False)])
eq("the group shows its WORST published score, not an average", r["worst_posture"]["score"], 35)
eq("...naming the account", r["worst_posture"]["account_name"], "b")
eq("accounts without a score are counted, not scored", r["accounts_unassessed"], 1)
eq("unreliable scores are counted", r["accounts_unreliable_score"], 1)
eq("spend adds within a currency", r["cost"]["month_to_date"], {"INR": 40.0})
eq("an empty group has no posture at all", roll_up([])["worst_posture"], None)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== F. The PDF renders whatever it is given ===")
# ═════════════════════════════════════════════════════════════════════════════
from app.services.client_report_pdf import render  # noqa: E402

base = {"client": {"id": "c", "name": "Acme <&> Ltd", "code": "ACME"}, "period": "2026-08",
        "period_label": "August 2026", "period_start": "2026-08-01",
        "period_end": "2026-09-01", "days_in_period": 31,
        "generated_at": "2026-09-28T10:00:00+00:00",
        "sections": ["cost", "security", "compliance", "certificates", "changes", "alerts",
                     "data_gaps"], "notes": ["n"]}
hostile = [{
    "account_id": "a", "account_name": "Prod <script>alert(1)</script> & “quotes” ✓",
    "provider": "AWS", "environment": "Production", "last_discovery": None,
    "cost": {"period": {"INR": 1.0}, "previous": {}, "change": {}, "days_covered": 1,
             "days_in_period": 31, "provisional_records": 0,
             "top_services": [{"service": "Amazon <EC2>", "currency": "INR", "amount": 1.0}],
             "has_data": True},
    "security": {"score": None, "grade": "Insufficient data", "score_reliable": False,
                 "coverage_pct": None, "outcome": "PARTIAL", "assessed_at": None,
                 "basis": "latest"},
    "findings": {}, "top_findings": [{"severity": "CRITICAL", "title": "x" * 400,
                                      "resource": "r", "affected": 3}],
    "compliance": [{"framework": "CIS-AWS", "label": "CIS AWS", "passed": 0, "failed": 0,
                    "partial": 0, "unknown": 0, "assessed": 0, "declared": 20,
                    "pass_rate": None, "coverage": 0.0}],
    "certificates": [{"name": "c", "kind": "CERTIFICATE", "container": None, "region": None,
                      "expires_at": "2026-09-01T00:00:00+00:00", "days_left": -27.0,
                      "in_use": None, "managed_renewal": None}],
    "changes": {"total": 0, "by_severity": {}}, "alerts": {"opened": 0, "resolved": 0},
    "gaps": ["gap & <more>"]}]
try:
    pdf = render({**base, "accounts": hostile, "totals": _totals(hostile)})
    check("markup, quotes and non-Latin characters render instead of raising",
          pdf.startswith(b"%PDF") and pdf.rstrip().endswith(b"%%EOF"), f"{len(pdf)} bytes")
except Exception as exc:  # noqa: BLE001
    check("markup, quotes and non-Latin characters render instead of raising", False, repr(exc))
try:
    pdf = render({**base, "accounts": [], "totals": _totals([])})
    check("a client with no accounts renders a one-page explanation", pdf.startswith(b"%PDF"))
except Exception as exc:  # noqa: BLE001
    check("a client with no accounts renders a one-page explanation", False, repr(exc))
try:
    pdf = render({**base, "sections": ["cost"], "accounts": hostile,
                  "totals": _totals(hostile)})
    check("a schedule with one section renders only that section", pdf.startswith(b"%PDF"))
except Exception as exc:  # noqa: BLE001
    check("a schedule with one section renders only that section", False, repr(exc))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== G. What the PDF says, in words ===")
# ═════════════════════════════════════════════════════════════════════════════
from app.services.client_report_pdf import (  # noqa: E402
    _catalog_assessed, _in_use, _spend_glance, _t,
)

eq("an arrow in a finding title prints as '->' (it printed '?' in the live report)",
   _t("principal → Owner"), "principal -&gt; Owner")
eq("<= and >= survive as ASCII", _t("≤ 7 d, ≥ 30 d"), "&lt;= 7 d, &gt;= 30 d")
check("characters the fonts DO have are left alone", _t("café — “ok”")
      == "café — “ok”")
eq("catalog assessed counts only the controls that apply",
   _catalog_assessed({"assessed": 5, "not_evaluated": 4, "not_applicable": 2, "declared": 11}),
   "5 of 9 (2 n/a)")
eq("...with no n/a note when nothing is n/a",
   _catalog_assessed({"assessed": 3, "not_evaluated": 1, "not_applicable": 0, "declared": 4}),
   "3 of 4")
eq("...and a report stored before the split still renders",
   _catalog_assessed({"assessed": 5, "declared": 11}), "5 of 11")
eq("usage is Yes / No / Unknown, never folded", [_in_use(True), _in_use(False), _in_use(None)],
   ["Yes", "No", "Unknown"])
glance = _spend_glance(_totals(accts + partial))
check("the headline says the change is like for like", "like for like" in glance, glance)
check("...names every account it left out, with the reason",
      "B (no billing in the previous month)" in glance and "Half (billed 15 of 31 days)" in glance,
      glance)
check("...and flags incomplete billing on the headline itself",
      "Incomplete billing: Half (15 of 31 days)" in glance, glance)
check("...and counts what it compared", "INR: +25.0% (1 of 2 account(s))" not in glance
      and "(2 of 4 account(s))" in glance, glance)

print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    print("\nFAILURES:")
    for x in fail:
        print(f"  ! {x}")
sys.exit(1 if fail else 0)
