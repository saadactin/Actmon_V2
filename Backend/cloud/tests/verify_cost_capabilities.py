"""Unit tests for the provider cost-capability registry. No network, no DB.

Run: venv\\Scripts\\python.exe tests\\verify_cost_capabilities.py

A capability registry is only worth having if it cannot drift from the code it
describes. So beyond the plain assertions, sections 6 and 7 read the provider
methods' own source and check that the GroupBy each flag claims is really
there -- if someone adds REGION to the AWS daily query without flipping
daily_region, or flips a flag without changing the query, these fail.
"""
import inspect
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.providers import capabilities as caps
from app.providers.aws.aws_provider import AWSProvider
from app.providers.azure.azure_provider import AzureProvider
from app.providers.oci.oci_provider import OCIProvider

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


print("1. Provider lookup, including the ORACLE/OCI alias")
check("AWS resolves", caps.for_provider("AWS") is caps.AWS)
check("azure lowercase resolves", caps.for_provider("azure") is caps.AZURE)
check("OCI resolves", caps.for_provider("OCI") is caps.OCI)
check("ORACLE (how accounts are stored) resolves to OCI",
      caps.for_provider("ORACLE") is caps.OCI)
check("whitespace tolerated", caps.for_provider("  aws  ") is caps.AWS)
check("unknown provider -> None, NOT a permissive default",
      caps.for_provider("GCP") is None)
check("None -> None", caps.for_provider(None) is None)

print("\n2. THE AWS LIMITATION -- resource cost must stay unavailable without CUR")
check("AWS resource == False", caps.AWS.resource is False)
check("AWSProvider genuinely has no get_cost_by_resource",
      not hasattr(AWSProvider, "get_cost_by_resource"))
reason = caps.AWS.reason("resource")
check("reason names CUR", "Cost & Usage Report" in reason or "CUR" in reason)
check("reason names the query engine", "Athena" in reason)
check("reason promises cost is never inferred from inventory",
      "never inferred from inventory" in reason)
check("reason() returns None for a SUPPORTED dimension",
      caps.AWS.reason("service") is None)

print("\n3. Azure and OCI DO support resource cost, and the code backs it")
check("Azure resource == True", caps.AZURE.resource is True)
check("AzureProvider.get_cost_by_resource exists",
      hasattr(AzureProvider, "get_cost_by_resource"))
check("OCI resource == True", caps.OCI.resource is True)
check("OCIProvider.get_cost_by_resource exists",
      hasattr(OCIProvider, "get_cost_by_resource"))

print("\n4. Aggregate vs daily dimensions are tracked separately")
check("AWS region (aggregate) == True", caps.AWS.region is True)
check("AWS daily_region == False -- the daily query has no region",
      caps.AWS.daily_region is False)
check("AWS daily_region reason explains the GroupBy",
      "GroupBy=[SERVICE]" in caps.AWS.reason("daily_region"))
check("Azure daily_region == True", caps.AZURE.daily_region is True)
check("OCI daily_region == True", caps.OCI.daily_region is True)

print("\n5. Window limits reflect each provider's real constraint")
check("OCI splits at 90 days (93-day API cap, 3 days margin)",
      caps.OCI.window_split_days == 90, str(caps.OCI.window_split_days))
check("AWS needs no split", caps.AWS.window_split_days is None)
check("Azure splits adaptively on next_link, not a fixed span",
      caps.AZURE.window_split_days is None)
check("every provider caps lookback at MAX_REPORT_DAYS (365)",
      all(c.max_lookback_days == 365 for c in (caps.AWS, caps.AZURE, caps.OCI)))
check("only Azure is flagged rate-limit sensitive",
      caps.AZURE.rate_limit_sensitive is True
      and caps.AWS.rate_limit_sensitive is False
      and caps.OCI.rate_limit_sensitive is False)

print("\n6. SOURCE CHECK -- daily_region claims match the real GroupBy")
aws_daily = inspect.getsource(AWSProvider.get_cost_report)
check("AWS daily query really groups by SERVICE", '"Key": "SERVICE"' in aws_daily)
check("AWS daily query really does NOT group by REGION -> daily_region=False is honest",
      '"Key": "REGION"' not in aws_daily)

azure_daily = inspect.getsource(AzureProvider.get_cost_report)
check("Azure daily query really groups by ResourceLocation -> daily_region=True",
      "ResourceLocation" in azure_daily)

oci_daily = inspect.getsource(OCIProvider.get_cost_report)
check("OCI daily query really groups by region -> daily_region=True",
      '"region"' in oci_daily)

print("\n7. SOURCE CHECK -- aggregate region claims match the real GroupBy")
aws_agg = inspect.getsource(AWSProvider.get_cost_data)
check("AWS aggregate query really groups by REGION -> region=True",
      '"Key": "REGION"' in aws_agg)

print("\n8. SOURCE CHECK -- OCI's documented 90-day split is the code's constant")
oci_split = inspect.getsource(OCIProvider._summarize_usages_windowed)
check("MAX_WINDOW_DAYS = 90 in the splitter", "MAX_WINDOW_DAYS = 90" in oci_split)

print("\n9. Nothing claims a provider API that is not wired up")
for c in (caps.AWS, caps.AZURE, caps.OCI):
    check(f"{c.provider} forecast_api == False (run-rate only)", c.forecast_api is False)
    check(f"{c.provider} budget_api == False", c.budget_api is False)
    check(f"{c.provider} usage_type == False (no query requests it)",
          c.usage_type is False)
    check(f"{c.provider} tags == False (no query requests them)", c.tags is False)

print("\n10. Every unavailable dimension owes a reason -- no silent False")
for c in (caps.AWS, caps.AZURE, caps.OCI):
    missing = [d for d in caps.DIMENSIONS
               if not c.supports(d) and d not in c.unsupported_reasons]
    check(f"{c.provider}: every False flag has an explanation", not missing, str(missing))
    empty = [d for d, r in c.unsupported_reasons.items() if not r or len(r) < 20]
    check(f"{c.provider}: no placeholder reasons", not empty, str(empty))

print("\n11. Registry is consistent with the provider classes")
problems = caps.verify_against_implementation()
for provider, issues in problems.items():
    check(f"{provider} registry matches implementation", not issues, "; ".join(issues))

print("\n12. Native resource identifiers are provider-correct")
check("AWS -> ARN", caps.AWS.native_resource_id == "ARN")
check("Azure -> ARM resource ID", caps.AZURE.native_resource_id == "ARM resource ID")
check("OCI -> OCID", caps.OCI.native_resource_id == "OCID")

print("\n13. intersect() -- a mixed view only offers what EVERY provider can do")
both = caps.intersect(["AZURE", "ORACLE"])
check("Azure+OCI CAN do resource cost", both["resource"] is True)
with_aws = caps.intersect(["AWS", "AZURE", "ORACLE"])
check("adding AWS removes resource cost from the combined view",
      with_aws["resource"] is False)
check("service survives all three", with_aws["service"] is True)
check("daily_region does not survive AWS", with_aws["daily_region"] is False)

print("\n14. intersect() treats an unknown provider as capable of nothing")
mixed = caps.intersect(["OCI", "GCP"])
check("unknown provider zeroes every dimension",
      all(v is False for v in mixed.values()), str(mixed))
check("empty scope offers nothing rather than everything",
      all(v is False for v in caps.intersect([]).values()))

print("\n15. unsupported_in_scope() names WHICH cloud blocks a dimension")
blockers = caps.unsupported_in_scope(["AWS", "AZURE", "ORACLE"], "resource")
check("only AWS blocks resource cost", set(blockers) == {"AWS"}, str(sorted(blockers)))
check("the blocker carries the real reason", "CUR" in blockers["AWS"])
check("nothing blocks 'service'",
      caps.unsupported_in_scope(["AWS", "AZURE", "ORACLE"], "service") == {})
unknown = caps.unsupported_in_scope(["GCP"], "service")
check("unknown provider is reported as unknown, not silently capable",
      "not a recognized cloud provider" in unknown.get("GCP", ""))

print("\n16. to_dict / all_capabilities are JSON-shaped for the API")
d = caps.AWS.to_dict()
for key in ("provider", "resource", "daily_region", "max_lookback_days",
            "native_resource_id", "unsupported_reasons"):
    check(f"to_dict has {key}", key in d)
everything = caps.all_capabilities()
check("all_capabilities covers exactly AWS/AZURE/OCI",
      set(everything) == {"AWS", "AZURE", "OCI"}, str(sorted(everything)))

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
