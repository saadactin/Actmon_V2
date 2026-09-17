"""Unit tests for the cost data contract: money arithmetic, the NA rule, the
response vocabulary, and the invariants that must never be violated.
No network, no DB.

Run: venv\\Scripts\\python.exe tests\\verify_cost_contract.py

Sections 1-4 pin the three rules that cause silent financial misreporting:
never add across currencies, never turn None into 0, never render an infinite
percentage. Section 10 restates them as explicit invariants.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.schemas.cost import (
    Completeness, CostEnvelope, CostRecord, CostSourceKind, CurrencyBreakdown,
    DataQuality, DataStatus, ErrorCategory, Period, Provenance,
)
from app.services import cost_errors as ce
from app.services import cost_money as money

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


print("1. THE INVARIANT -- different currencies are never added together")
mixed = money.total([(251.93, "USD"), (1322788.57, "INR"), (4523727.04, "INR")])
check("no single amount exists for a mixed scope", mixed.single_amount is None)
check("mixed flag set", mixed.is_mixed is True)
check("USD kept separate and exact", abs(mixed.by_currency["USD"] - 251.93) < 1e-6,
      str(mixed.by_currency.get("USD")))
check("INR summed within its own currency only",
      abs(mixed.by_currency["INR"] - 5846515.61) < 1e-4,
      str(mixed.by_currency.get("INR")))
check("no bucket equals the cross-currency sum",
      not any(abs(v - (251.93 + 5846515.61)) < 1e-4 for v in mixed.by_currency.values()))
check("na_reason names the currencies found",
      "USD" in mixed.na_reason() and "INR" in mixed.na_reason(), mixed.na_reason())

print("\n2. A single-currency scope DOES get a real total")
single = money.total([(100.0, "INR"), (23.5, "INR")])
check("single amount present", abs(single.single_amount - 123.5) < 1e-9,
      str(single.single_amount))
check("currency reported", single.single_currency == "INR")
check("not mixed", single.is_mixed is False)
check("na_reason is None when a real total exists", single.na_reason() is None)
check("case/whitespace normalized to one bucket",
      money.total([(1.0, "inr"), (2.0, " INR ")]).single_currency == "INR")

print("\n3. THE NA RULE -- None never becomes 0")
withnone = money.total([(None, "INR"), (50.0, "INR"), (None, "INR")])
check("unknowns excluded from the total", abs(withnone.single_amount - 50.0) < 1e-9,
      str(withnone.single_amount))
check("unknowns counted, not discarded silently", withnone.skipped_no_amount == 2,
      str(withnone.skipped_no_amount))
check("counted reflects only real values", withnone.counted == 1, str(withnone.counted))

allnone = money.total([(None, "INR"), (None, "USD")])
check("all-unknown scope has NO total (NA, not 0)", allnone.single_amount is None)
check("all-unknown scope is empty, not zero", allnone.is_empty is True)
check("all-unknown to_dict amount is None, never 0.0",
      allnone.to_dict()["amount"] is None, str(allnone.to_dict()["amount"]))
check("na_reason explains the missing amounts",
      "no cost value" in (allnone.na_reason() or ""), allnone.na_reason())

print("\n4. A real zero is preserved as zero, distinct from NA")
zero = money.total([(0.0, "USD")])
check("real zero total is 0.0, not None", zero.single_amount == 0.0,
      str(zero.single_amount))
check("real zero is not 'empty'", zero.is_empty is False)
check("real zero has no na_reason", zero.na_reason() is None)

print("\n4b. An empty total does not invent a cause")
# The regression this guards: an Azure subscription being rate-limited (HTTP
# 429) rendered as "the provider returned no billing records for this scope",
# which reads as an account with no spend. Its stored history held Rs 12.6 lakh
# at the time. An empty sum cannot tell why it is empty, so it must not say.
empty = money.total([])
check("an empty total is NA, not zero", empty.single_amount is None)
check("...and does not claim the provider answered",
      "returned no billing records" not in (empty.na_reason() or ""),
      (empty.na_reason() or "")[:60])
check("...but does say records were not counted",
      "not counted" in (empty.na_reason() or "").lower()
      or "no billing records were counted" in (empty.na_reason() or "").lower(),
      (empty.na_reason() or "")[:80])
check("...and points at the diagnostics",
      "diagnostic" in (empty.na_reason() or "").lower())
check("the fallback is flagged as NOT a diagnosis",
      empty.to_dict()["reason_is_diagnostic"] is False)

throttled = empty.with_reason("The provider is rate limiting billing queries.")
check("a caller's diagnosis replaces the fallback",
      throttled.na_reason() == "The provider is rate limiting billing queries.")
check("...and is flagged as a real diagnosis",
      throttled.to_dict()["reason_is_diagnostic"] is True)
check("the original total is unchanged", empty.unavailable_reason is None)

priced = money.total([(10.0, "INR")]).with_reason("ignored")
check("a total that exists never carries an excuse", priced.na_reason() is None)
check("...and keeps its amount", priced.single_amount == 10.0)

print("\n5. Missing currency keeps the money visible in an UNKNOWN bucket")
nocur = money.total([(10.0, None), (5.0, "")])
check("amount not discarded", nocur.by_currency.get(money.UNKNOWN_CURRENCY) == 15.0,
      str(nocur.by_currency))
check("gap is counted", nocur.skipped_no_currency == 2, str(nocur.skipped_no_currency))
check("UNKNOWN is not a real currency code", money.UNKNOWN_CURRENCY == "UNKNOWN")

print("\n6. total_from_rows works on billing-row dicts")
rows = [{"cost": 10.0, "currency": "INR"}, {"cost": None, "currency": "INR"},
        {"cost": 2.5, "currency": "INR"}]
t = money.total_from_rows(rows)
check("rows summed correctly", abs(t.single_amount - 12.5) < 1e-9, str(t.single_amount))
check("None row counted as unknown", t.skipped_no_amount == 1)

print("\n7. single_currency matches the existing cost_service behaviour")
check("one currency -> that currency", money.single_currency(["INR", "INR"]) == "INR")
check("mixed -> None", money.single_currency(["INR", "USD"]) is None)
check("empty -> None", money.single_currency([]) is None)
check("None entries ignored", money.single_currency([None, "USD", None]) == "USD")

print("\n8. NO INFINITE PERCENTAGES -- change from zero is 'New'")
c = money.percent_change(12400.0, 0.0, current_currency="INR", previous_currency="INR")
check("kind == new", c.kind == money.NEW, c.kind)
check("percent is None, not inf", c.percent is None, str(c.percent))
check("label reads 'New'", c.label == "New", c.label)
check("absolute change still reported", c.absolute == 12400.0, str(c.absolute))
check("to_dict percent is None", c.to_dict()["percent"] is None)

print("\n9. The rest of the change vocabulary")
c = money.percent_change(110.0, 100.0, current_currency="USD", previous_currency="USD")
check("ordinary rise -> changed +10%", c.kind == money.CHANGED and abs(c.percent - 10.0) < 1e-9,
      f"{c.kind} {c.percent}")
c = money.percent_change(90.0, 100.0)
check("ordinary fall -> -10%", abs(c.percent + 10.0) < 1e-9, str(c.percent))
c = money.percent_change(0.0, 100.0)
check("spend stopped -> ended, -100%", c.kind == money.ENDED and c.percent == -100.0,
      f"{c.kind} {c.percent}")
c = money.percent_change(0.0, 0.0)
check("zero to zero -> no_change, 0%", c.kind == money.NO_CHANGE and c.percent == 0.0)
c = money.percent_change(None, 100.0)
check("missing current -> not_comparable", c.kind == money.NOT_COMPARABLE, c.kind)
check("not_comparable renders as NA", c.label == "NA")
check("not_comparable explains itself", "nothing to compare" in (c.reason or ""))

print("\n10. A percentage across currencies is refused, not approximated")
c = money.percent_change(100.0, 100.0, current_currency="USD", previous_currency="INR")
check("cross-currency change -> not_comparable", c.kind == money.NOT_COMPARABLE, c.kind)
check("percent is None", c.percent is None)
check("reason names both currencies",
      "INR" in (c.reason or "") and "USD" in (c.reason or ""), c.reason)

print("\n11. Source vocabulary distinguishes spend from list price")
check("PROVIDER_BILLING exists", CostSourceKind.PROVIDER_BILLING.value == "provider_billing")
check("PROVIDER_PRICE_LIST is a SEPARATE kind from billing",
      CostSourceKind.PROVIDER_PRICE_LIST != CostSourceKind.PROVIDER_BILLING)
check("NOT_AVAILABLE is representable",
      CostSourceKind.NOT_AVAILABLE.value == "not_available")
check("all 6 source kinds present", len(list(CostSourceKind)) == 6,
      str([s.value for s in CostSourceKind]))

print("\n12. Status vocabulary separates partial/failed/unsupported/no_data")
values = {s.value for s in DataStatus}
check("has complete/partial/failed", {"complete", "partial", "failed"} <= values)
check("permission_denied and rate_limited are first-class",
      {"permission_denied", "rate_limited"} <= values)
check("not_supported is distinct from failed", "not_supported" in values)
check("no_data (a real empty result) is distinct from failed", "no_data" in values)

print("\n13. Completeness: only complete/no_data may be shown as a definitive total")
check("complete is trustworthy",
      Completeness(status=DataStatus.COMPLETE).is_trustworthy_as_total is True)
check("no_data is trustworthy (a real empty result)",
      Completeness(status=DataStatus.NO_DATA).is_trustworthy_as_total is True)
for bad in (DataStatus.PARTIAL, DataStatus.FAILED, DataStatus.RATE_LIMITED,
            DataStatus.PERMISSION_DENIED, DataStatus.NOT_SUPPORTED):
    check(f"{bad.value} is NOT presentable as a total",
          Completeness(status=bad).is_trustworthy_as_total is False)

print("\n14. ErrorCategory mirrors the classifier exactly")
check("schema enum == cost_errors.CATEGORIES",
      {e.value for e in ErrorCategory} == set(ce.CATEGORIES),
      str({e.value for e in ErrorCategory} ^ set(ce.CATEGORIES)))

print("\n15. CostRecord defaults are honest")
r = CostRecord(provider="AWS", account_id="a1")
check("amount defaults to None (NA), not 0.0", r.amount is None, str(r.amount))
check("in_inventory defaults False (unmatched until proven)", r.in_inventory is False)
check("source defaults to provider_billing", r.source == CostSourceKind.PROVIDER_BILLING)
check("dimensions is an empty dict, ready for provider-native fields",
      r.dimensions == {})

print("\n16. CostRecord preserves provider-native dimensions without flattening")
aws = CostRecord(provider="AWS", account_id="a", resource_id="arn:aws:ec2:...",
                 dimensions={"usage_type": "BoxUsage:t3.medium", "operation": "RunInstances",
                             "availability_zone": "ap-south-1a"})
oci = CostRecord(provider="OCI", account_id="b", resource_id="ocid1.instance...",
                 dimensions={"compartment": "prod", "sku": "B91962", "usage_unit": "GB"})
check("AWS-only dimensions round-trip", aws.dimensions["operation"] == "RunInstances")
check("OCI-only dimensions round-trip", oci.dimensions["sku"] == "B91962")
check("neither provider gained the other's fields",
      "sku" not in aws.dimensions and "operation" not in oci.dimensions)

print("\n17. The envelope can express 'partial' without pretending to succeed")
env = CostEnvelope(
    status=DataStatus.PARTIAL,
    data={"total": 1322788.57},
    completeness=Completeness(
        status=DataStatus.PARTIAL,
        reason="Cost Management throttled one sub-window.",
        covered=["2026-09-06..2026-09-10"], missing=["2026-09-01..2026-09-05"],
    ),
    quality=DataQuality.PARTIAL,
)
check("status is partial", env.status == DataStatus.PARTIAL)
check("succeeded_completely is False", env.succeeded_completely is False)
check("missing windows are enumerated, not hidden",
      env.completeness.missing == ["2026-09-01..2026-09-05"])

print("\n18. A clean envelope reports success only when there are no errors")
good = CostEnvelope(status=DataStatus.COMPLETE, data={}, quality=DataQuality.GOOD)
check("complete + no errors -> succeeded", good.succeeded_completely is True)
good_with_err = CostEnvelope(
    status=DataStatus.COMPLETE, data={},
    errors=[{"category": "rate_limited", "message": "throttled"}],
)
check("complete BUT with an error -> not a clean success",
      good_with_err.succeeded_completely is False)

print("\n19. CurrencyBreakdown round-trips a MoneyTotal")
cb = CurrencyBreakdown(**{k: v for k, v in mixed.to_dict().items()
                          if k in CurrencyBreakdown.model_fields})
check("mixed breakdown has no single amount", cb.amount is None)
check("mixed flag preserved", cb.mixed is True)
check("both currencies listed", set(cb.currencies) == {"USD", "INR"}, str(cb.currencies))

print("\n20. Provenance can express a cached price-list figure honestly")
p = Provenance(
    source=CostSourceKind.PROVIDER_PRICE_LIST,
    provider_api="OCI Price List API",
    currency="INR",
    period=Period(start="2026-08-12", end="2026-09-11", days=30),
    cached=True, age_seconds=900,
    assumptions=["PAYG list price", "Taxes excluded"],
)
check("source is price list, not billing", p.source == CostSourceKind.PROVIDER_PRICE_LIST)
check("cached is explicit", p.cached is True)
check("assumptions are carried", "Taxes excluded" in p.assumptions)
check("period days recorded", p.period.days == 30)
check("timezone defaults to UTC and is stated", p.period.timezone == "UTC")

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
