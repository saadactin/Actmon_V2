"""Resource Intelligence: telemetry statistics, collector parsing, rules, engine.

Pure — no Postgres, no provider calls. Every check calls the production
function; nothing here re-implements the rule it is checking (see the
test-mirrors lesson in this repo's history).

The load-bearing sections:

* **1. A gap is not a zero.** Missing hours lower coverage; they never drag an
  average down. A peak is a peak only when a Maximum statistic measured it.
* **5. Rightsizing names a size only on published capacity** — OCI ListShapes /
  Azure Resource SKUs — and never shrinks unmeasured memory.
* **6. A list-price saving is withdrawn when billing shows a commitment.** Live
  data had a VM billed 21.97 INR in 30 days against ~7,600 INR at list; the
  first cut of this engine would have claimed a 3,864 INR monthly saving.
* **7. The unused-IP rule needs BOTH associations recorded.** On TOR, the
  address a NAT gateway uses has no NIC ip-configuration.
* **10. Resolution needs a re-check.** The engine records CLEAR per (rule,
  resource); INSUFFICIENT_DATA is never a re-check.
"""
import logging
import pathlib
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
# The labels use arrows and ellipses; a cp1252 console would crash on them.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
logging.disable(logging.CRITICAL)

from app.optimization import collect_aws, collect_azure, collect_common, collect_oci, collector, engine  # noqa: E402
from app.optimization import health  # noqa: E402
from app.optimization import rules as reg  # noqa: E402
from app.optimization.model import (  # noqa: E402
    CLEAR, FINDING, INSUFFICIENT_DATA, NOT_APPLICABLE, RUN_COMPLETE, RUN_PARTIAL,
    SAVINGS_BILLED, SAVINGS_LIST_PRICE, SAVINGS_NONE, Savings, fingerprint,
)
from app.optimization.pricebook import PriceBook, commitment_gap  # noqa: E402
from app.optimization.rules.base import THRESHOLDS, Ctx  # noqa: E402
from app.optimization.telemetry import (  # noqa: E402
    ST_DENIED, ST_ERROR, ST_NO_DATA, ST_NOT_COLLECTED, ST_OK, ST_SKIPPED, MetricResult,
    ResourceTelemetry, derive_percent_used, summarize,
)
from app.pricing.azure_pricing import pick_vm_rate  # noqa: E402

ok, fail = [], []
NOW = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)
START = NOW - timedelta(days=30)


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


def hours(n, value, *, start=START):
    return [(start + timedelta(hours=i), value(i) if callable(value) else value) for i in range(n)]


def res(rtype, *, provider_id=None, name="r1", status=None, nstatus=None, config=None,
        meta=None, region="ap-mumbai-1", attachment_state=None, environment=None, ip=None):
    return SimpleNamespace(
        id=uuid4(), resource_type=rtype, provider_resource_id=provider_id or f"id-{uuid4().hex[:8]}",
        resource_name=name, status=status, normalized_status=nstatus, config=config or {},
        metadata_=meta or {}, region_or_zone=region, tags={}, attachment_state=attachment_state,
        environment=environment, ip_address=ip, raw_data={})


def tm(**metrics):
    """ResourceTelemetry from {metric: stats-or-status}."""
    out = ResourceTelemetry()
    for key, spec in metrics.items():
        if isinstance(spec, str):
            out.metrics[key] = MetricResult(key, spec, reason=f"{spec} for test")
        else:
            out.metrics[key] = MetricResult(key, ST_OK, spec, source="test")
    return out


def stats(metric, value, n=720, peaks=None):
    return summarize(metric, hours(n, value), window_start=START, window_end=NOW,
                     peaks=hours(n, peaks) if peaks is not None else None)


def ctx_for(r, provider, *, telemetry=None, facts=None, billed=None, prices=None,
            catalogs=None, attached=None, history=None):
    prices = prices or PriceBook(currency="INR", billed={str(r.id): billed} if billed else {})
    return Ctx(resource=r, provider=provider, config=r.config, tags={}, meta=r.metadata_,
               telemetry=telemetry or ResourceTelemetry(), facts=facts or {},
               billed=prices.billed_for(r), prices=prices, index={}, attached=attached or {},
               history=history or [], now=NOW, thresholds=dict(THRESHOLDS),
               catalogs=catalogs or {})


def run(rule_id, ctx):
    out = reg.by_id(rule_id).evaluate(ctx)
    return out if not isinstance(out, list) else out[0]


# ═════════════════════════════════════════════════════════════════════════════
print("\n1. Telemetry statistics: gaps are not zeros, peaks are measured")
s = summarize("cpu_percent", [(START + timedelta(hours=i), float(i % 10)) for i in range(100)],
              window_start=START, window_end=NOW)
eq("100 samples over a 720-hour window → 13.9% coverage", s["coverage_pct"], 13.9)
eq("the average is over what was observed (4.5), not diluted by missing hours", s["avg"], 4.5)
eq("P95 is linear-interpolated like numpy (values 0-9 repeating → 9.0)", s["p95"], 9.0)
eq("with no Maximum series, the peak is labelled the highest hourly AVERAGE",
   s["peak_source"], "highest_period_average")
s2 = summarize("cpu_percent", hours(10, 5.0), window_start=START, window_end=NOW,
               peaks=hours(10, lambda i: 40.0 if i == 3 else 6.0))
eq("with a Maximum series, the peak is its maximum", (s2["peak"], s2["peak_source"]), (40.0, "maximum"))
s3 = summarize("cpu_percent", [], window_start=START, window_end=NOW)
eq("no datapoints → every statistic is None, never 0", (s3["avg"], s3["p95"], s3["samples"]), (None, None, 0))
dup = summarize("cpu_percent", [(START, 10.0), (START, 30.0), (START + timedelta(hours=1), 50.0)],
                window_start=START, window_end=NOW)
eq("a timestamp repeated across pages counts once", dup["samples"], 2)
c = summarize("invocations", hours(48, lambda i: 2.0 if i % 2 else 0.0), window_start=START, window_end=NOW)
eq("a counter carries its total and active periods", (c["total"], c["active_periods"]), (48.0, 24))
eq("the daily rollup has one row per UTC day with its sample count", len(c["daily"]) >= 2 and
   c["daily"][0]["samples"] > 0, True)
eq("available memory without a capacity yields no percentage", derive_percent_used(hours(5, 1e9), None), [])
used = derive_percent_used([(START, 2 * 1024 ** 3)], 8 * 1024 ** 3)
eq("2 GiB available of 8 GiB → 75% used", used[0][1], 75.0)
eq("a reading above capacity clamps to 0% used, not negative",
   derive_percent_used([(START, 9 * 1024 ** 3)], 8 * 1024 ** 3)[0][1], 0.0)

# ═════════════════════════════════════════════════════════════════════════════
print("\n2. Collector plumbing: statuses, retries, stream combination")
eq("AccessDenied → DENIED", collect_common.classify_error(Exception("AccessDeniedException: no"))[0], ST_DENIED)
eq("OCI NotAuthorizedOrNotFound → DENIED",
   collect_common.classify_error(Exception("NotAuthorizedOrNotFound"))[0], ST_DENIED)
eq("a 502 Bad Gateway is an ERROR, not a denial",
   collect_common.classify_error(Exception("502 Bad Gateway"))[0], ST_ERROR)
check("a dropped connection is retried (the OCI endpoint reset ~half the probe's calls)",
      collect_common.is_transient(Exception("Max retries exceeded with url")))
check("throttling is retried", collect_common.is_transient(Exception("Rate exceeded")))
check("a denial is not retried", not collect_common.is_transient(Exception("AccessDenied")))
a, b = [(START, 1.0), (START + timedelta(hours=1), 2.0)], [(START, 3.0)]
eq("sum combines listener streams", collect_common.combine_streams([a, b], "sum")[0][1], 4.0)
eq("mean combines per-node utilization", collect_common.combine_streams([a, b], "mean")[0][1], 2.0)
eq("max takes the busiest stream", collect_common.combine_streams([a, b], "max")[0][1], 3.0)

vm = res("ComputeInstance", nstatus="RUNNING", meta={"region": "ap-mumbai-1",
                                                      "time_created": (NOW - timedelta(days=2)).isoformat()})
p = collect_oci.plan(vm)
out = collector.assemble([p], {(str(vm.id), "cpu_percent"): collect_common.RawMetric(
    ST_OK, hours(48, 5.0, start=NOW - timedelta(days=2)))}, start=START, end=NOW, collected_at=NOW)
rows = [r for r in out.rows if r["resource_id"].hex == vm.id.hex]
eq("every planned metric gets exactly one row, whatever happened",
   sorted(r["metric"] for r in rows), sorted(m.metric for m in p.metrics))
cpu_row = next(r for r in rows if r["metric"] == "cpu_percent")
eq("a 2-day-old instance is measured from creation: 48 of 48 hours = 100% coverage",
   cpu_row["stats"]["coverage_pct"], 100.0)
eq("a metric the fetch produced nothing for is an ERROR row, not an empty OK",
   next(r for r in rows if r["metric"] == "memory_percent")["status"], ST_ERROR)
stopped = res("ComputeInstance", nstatus="STOPPED", meta={"region": "ap-mumbai-1"})
ps = collect_oci.plan(stopped)
eq("a stopped OCI instance is not queried; its metrics are SKIPPED with a reason",
   (ps.metrics, sorted(ps.skipped)[:1]), ([], ["cpu_percent"]))
net = next(m for m in p.metrics if m.metric == "network_in")
eq("OCI network counters are cumulative: rate() per second × 3600", (net.stat, net.scale), ("rate", 3600.0))
series = [({"resourceId": vm.provider_resource_id.upper()}, [(START, 1.0)]),
          ({"resourceId": "other"}, [(START, 9.0)])]
eq("OCI streams match the inventory id case-insensitively (ADB upper-cases its OCID)",
   collect_oci.match_streams(series, vm.provider_resource_id, ("resourceId",)), [[(START, 1.0)]])
bucket = res("ObjectStorageBucket", name="logs-bucket", meta={"region": "ap-mumbai-1"})
bp = collect_oci.plan(bucket)
eq("OCI buckets match on the bucket name, not the inventory key",
   (bp.metrics[0].match_value, bp.metrics[0].match_keys[0]), ("logs-bucket", "resourceDisplayName"))

eq("an EC2 availability zone maps to its region", collect_aws.aws_region(res("EC2Instance", region="ap-south-2a")),
   "ap-south-2")
lam = res("LambdaFunction", provider_id="arn:aws:lambda:ap-south-1:1:function:fn1", name="fn1",
          region="ap-south-1")
lp = collect_aws.plan(lam)
eq("Lambda metrics use the function NAME (the ARN matches no series)", lp.metrics[0].dims[0]["Value"], "fn1")
merged = collect_aws._parse_results([
    {"Id": "q1", "StatusCode": "PartialData", "Timestamps": [START], "Values": [1.0]},
    {"Id": "q1", "StatusCode": "Complete", "Timestamps": [START + timedelta(hours=1)], "Values": [2.0]}])
eq("GetMetricData pages for one id are merged, not overwritten", len(merged["q1"][1]), 2)
ec2_stopped = res("EC2Instance", status="stopped", region="ap-south-2a")
eq("a stopped EC2 instance is skipped", collect_aws.plan(ec2_stopped).metrics, [])

valid = collect_azure.valid_metrics_from_error(
    "(BadRequest) Failed to find metric configuration for provider: Microsoft.Sql, resource Type: "
    "servers/databases, metric: dtu_consumption_percent, Valid metrics: cpu_percent,"
    "physical_data_read_percent,log_write_percent,storage_percent")
eq("Azure's BadRequest lists the metrics that exist; the collector retries with them",
   valid[:2], ["cpu_percent", "physical_data_read_percent"])
generic_vm = res("VirtualMachine", config={"azure_type": "Microsoft.Compute/virtualMachines"},
                 region="centralindia")
eq("a generic ARM VM row with no size is not planned", collect_azure.plan(generic_vm), None)

ITEMS = [  # the shape the live API returned for Standard_D4as_v5 in centralindia
    {"armSkuName": "Standard_D4as_v5", "productName": "Virtual Machines Dasv5 Series Windows",
     "skuName": "D4as v5", "retailPrice": 28.1861, "unitOfMeasure": "1 Hour", "type": "Consumption",
     "serviceName": "Virtual Machines", "currencyCode": "INR", "meterName": "D4as v5"},
    {"armSkuName": "Standard_D4as_v5", "productName": "Virtual Machines Dasv5 Series Windows",
     "skuName": "D4as v5 Spot", "retailPrice": 5.2088, "unitOfMeasure": "1 Hour", "type": "Consumption",
     "serviceName": "Virtual Machines", "currencyCode": "INR", "meterName": "D4as v5 Spot"},
    {"armSkuName": "Standard_D4as_v5", "productName": "Virtual Machines Dasv5 Series",
     "skuName": "D4as v5 Low Priority", "retailPrice": 2.1, "unitOfMeasure": "1 Hour",
     "type": "Consumption", "serviceName": "Virtual Machines", "currencyCode": "INR", "meterName": "x"},
    {"armSkuName": "Standard_D4as_v5", "productName": "Virtual Machines Dasv5 Series",
     "skuName": "D4as v5", "retailPrice": 10.6056, "unitOfMeasure": "1 Hour", "type": "Consumption",
     "serviceName": "Virtual Machines", "currencyCode": "INR", "meterName": "D4as v5"},
    {"armSkuName": "Standard_D4as_v5", "productName": "Dasv5 Series Cloud Services",
     "skuName": "D4as v5", "retailPrice": 28.1861, "unitOfMeasure": "1 Hour", "type": "Consumption",
     "serviceName": "Virtual Machines", "currencyCode": "INR", "meterName": "D4as v5"},
]
eq("of the meters for one size, only the Linux pay-as-you-go one prices a Linux VM",
   pick_vm_rate(ITEMS, "Standard_D4as_v5", "Linux")["hourly"], 10.6056)
eq("…and the Windows one a Windows VM", pick_vm_rate(ITEMS, "Standard_D4as_v5", "Windows")["hourly"], 28.1861)
eq("two candidate meters is ambiguous → no price, not a guess",
   pick_vm_rate(ITEMS + [dict(ITEMS[3], retailPrice=11.0)], "Standard_D4as_v5", "Linux"), None)

# ═════════════════════════════════════════════════════════════════════════════
print("\n3. Registry: provider-aware dispatch")
eq("32 rules registered and validated", len(reg.RULES), 32)
check("an OCI-only load-balancer rule never runs on an AWS LoadBalancer",
      not any(r.rule_id.startswith("LB_") for r in reg.rules_for("AWS", "LoadBalancer")))
check("no rule is dispatched on a (provider, type) pair that provider's scanner never produces",
      not reg.rules_for("AWS", "BlockVolume") and not reg.rules_for("AZURE", "ComputeInstance"))
from app.services.cost_recommendation_service import RULES as LEGACY  # noqa: E402
OWNED_BY_SECURITY = {"Enable S3 Bucket Versioning", "Upgrade Deprecated Runtime",
                     "Enable Autonomous Database Auto-Scaling"}
DROPPED_NO_EVIDENCE = {"Review EKS Control Plane Utilization"}
unaccounted = set(LEGACY) - set(reg.SUPERSEDED_COST_RULES) - OWNED_BY_SECURITY - DROPPED_NO_EVIDENCE
eq("every old Cost-tab rule is superseded here, owned by the security engine, or deliberately "
   "dropped for having no evidence", sorted(unaccounted), [])

# ═════════════════════════════════════════════════════════════════════════════
print("\n4. Compute: insufficient data is not a finding")
oci_vm = res("ComputeInstance", nstatus="RUNNING",
             config={"shape": "VM.Standard.E4.Flex", "ocpus": 4, "memory_gb": 64})
short = tm(cpu_percent=stats("cpu_percent", 3.0, n=24 * 7))
o = run("COMPUTE_UNDERUTILIZED", ctx_for(oci_vm, "OCI", telemetry=short))
eq("7 days of CPU → INSUFFICIENT_DATA", o.verdict, INSUFFICIENT_DATA)
check("…and the reason says how much there was", "7" in (o.reason or ""), o.reason)
eq("CPU not collected at all → INSUFFICIENT_DATA",
   run("COMPUTE_UNDERUTILIZED", ctx_for(oci_vm, "OCI", telemetry=tm(cpu_percent=ST_ERROR))).verdict,
   INSUFFICIENT_DATA)
busy = tm(cpu_percent=stats("cpu_percent", 45.0), memory_percent=stats("memory_percent", 30.0))
eq("CPU P95 45% → CLEAR", run("COMPUTE_UNDERUTILIZED", ctx_for(oci_vm, "OCI", telemetry=busy)).verdict, CLEAR)
spiky = tm(cpu_percent=stats("cpu_percent", lambda i: 90.0 if i % 50 == 0 else 5.0),
           memory_percent=stats("memory_percent", 20.0))
eq("low P95 but busy hours at P99 → CLEAR (a smaller size would saturate then)",
   run("COMPUTE_UNDERUTILIZED", ctx_for(oci_vm, "OCI", telemetry=spiky)).verdict, CLEAR)
gpu = res("EC2Instance", status="running", nstatus="RUNNING", region="ap-south-2a",
          config={"instance_type": "g6e.2xlarge"})
o = run("COMPUTE_UNDERUTILIZED", ctx_for(gpu, "AWS", telemetry=tm(cpu_percent=stats("cpu_percent", 2.0))))
eq("a GPU instance is not judged on CPU", o.verdict, INSUFFICIENT_DATA)
eq("a stopped instance is NOT_APPLICABLE to rightsizing",
   run("COMPUTE_UNDERUTILIZED", ctx_for(res("ComputeInstance", nstatus="STOPPED"), "OCI")).verdict,
   NOT_APPLICABLE)

# ═════════════════════════════════════════════════════════════════════════════
print("\n5. Compute: exact sizes only from published capacity")
RATES = {"VM.Standard.E4.Flex": {
    "ocpu": {"part": "B93113", "value": 2.388625, "display_name": "Compute - Standard - E4 - OCPU", "currency": "INR"},
    "memory": {"part": "B93114", "value": 0.1433175, "display_name": "Compute - Standard - E4 - Memory", "currency": "INR"},
    "currency": "INR"}}
SHAPES = {"oci_shapes": {"VM.Standard.E4.Flex": {"ocpu_min": 1.0, "memory_min": 1.0,
                                                 "memory_per_ocpu_max": 64.0}}}
low = tm(cpu_percent=stats("cpu_percent", 8.0, peaks=20.0), memory_percent=stats("memory_percent", 20.0))
book = PriceBook(currency="INR", oci_flex=RATES)
o = run("COMPUTE_UNDERUTILIZED", ctx_for(oci_vm, "OCI", telemetry=low, prices=book, catalogs=SHAPES))
eq("OCI Flex: a FINDING with an exact target", (o.verdict, bool(o.recommended)), (FINDING, True))
eq("4 OCPU at 8% P95 → 1 OCPU (8×4/60 rounds up to 1)", o.recommended["OCPU"], "1 OCPU")
eq("64 GiB at 20% P95 → 18 GiB (64×20/75 = 17.1, rounded up)", o.recommended["Memory"], "18 GiB")
eq("the saving is list-price arithmetic from the verified parts", o.savings.method, SAVINGS_LIST_PRICE)
want = round(((4 * 2.388625 + 64 * 0.1433175) - (1 * 2.388625 + 18 * 0.1433175)) * 730, 2)
eq("…equal to (current − target) hourly × 730", o.savings.amount, want)
peaky_mem = tm(cpu_percent=stats("cpu_percent", 8.0, peaks=95.0),
               memory_percent=stats("memory_percent", 20.0, peaks=40.0))
o = run("COMPUTE_UNDERUTILIZED", ctx_for(oci_vm, "OCI", telemetry=peaky_mem, prices=book, catalogs=SHAPES))
eq("memory must also hold its measured PEAK hour: 64 GiB × 40% / 90% → 29 GiB, not 18",
   o.recommended["Memory"], "29 GiB")
cpu_peak_check = next(c for c in o.safety["checks"] if "busiest hour" in c["label"])
eq("a CPU peak of 95% on 4 OCPU projects to 380% on 1 → the safety check FAILS",
   cpu_peak_check["state"], "FAIL")
cpu_only = tm(cpu_percent=stats("cpu_percent", 8.0))
o = run("COMPUTE_UNDERUTILIZED", ctx_for(oci_vm, "OCI", telemetry=cpu_only, prices=book, catalogs=SHAPES))
check("memory not measured → memory is left unchanged, never shrunk",
      o.recommended and o.recommended["Memory"].startswith("64 GiB"), o.recommended)
eq("…and confidence is below HIGH", o.confidence != "HIGH", True)
# 1 OCPU / 1 GiB is the shape's floor (ocpu_min 1, memory_min 1): nothing smaller exists.
tiny = res("ComputeInstance", nstatus="RUNNING", config={"shape": "VM.Standard.E4.Flex", "ocpus": 1, "memory_gb": 1})
o = run("COMPUTE_UNDERUTILIZED", ctx_for(tiny, "OCI", telemetry=tm(
    cpu_percent=stats("cpu_percent", 20.0), memory_percent=stats("memory_percent", 50.0)),
    prices=book, catalogs=SHAPES))
eq("already at the shape minimum and not idle → CLEAR, not a pointless finding", o.verdict, CLEAR)
o = run("COMPUTE_UNDERUTILIZED", ctx_for(tiny, "OCI", telemetry=tm(
    cpu_percent=stats("cpu_percent", 1.0), memory_percent=stats("memory_percent", 70.0)),
    prices=book, catalogs=SHAPES))
eq("memory P95 70% is what the size carries → CLEAR", o.verdict, CLEAR)
idle_tiny = run("COMPUTE_UNDERUTILIZED", ctx_for(tiny, "OCI", telemetry=tm(
    cpu_percent=stats("cpu_percent", 1.0), memory_percent=stats("memory_percent", 20.0)),
    prices=book, catalogs=SHAPES))
eq("nearly idle at its smallest size → a LOW finding that says so",
   (idle_tiny.verdict, idle_tiny.severity), (FINDING, "LOW"))
check("…recommending it be questioned, with no invented target", idle_tiny.recommended is None
      and "smallest" in (idle_tiny.recommendation or ""), idle_tiny.recommendation)

SKUS = {"azure_skus": {"centralindia": {
    "Standard_D4as_v5": {"name": "Standard_D4as_v5", "family": "standardDASv5Family", "vcpus": 4, "memory_gb": 16},
    "Standard_D2as_v5": {"name": "Standard_D2as_v5", "family": "standardDASv5Family", "vcpus": 2, "memory_gb": 8},
    "Standard_E2as_v5": {"name": "Standard_E2as_v5", "family": "standardEASv5Family", "vcpus": 2, "memory_gb": 16},
}}}
az = res("VirtualMachine", nstatus="RUNNING", region="centralindia",
         config={"vm_size": "Standard_D4as_v5", "power_state": "VM running", "os_type": "Linux"})
cap = {"capacity": {"vcpus": 4, "memory_gb": 16, "family": "standardDASv5Family"}}
o = run("COMPUTE_UNDERUTILIZED", ctx_for(az, "AZURE", telemetry=low, facts=cap, catalogs=SKUS))
eq("Azure: the smallest same-family size that fits", o.recommended["Size"], "Standard_D2as_v5")
eq("…priced later from the retail API, never inline", (o.pricing_request or {}).get("target"), "Standard_D2as_v5")
o = run("COMPUTE_UNDERUTILIZED", ctx_for(az, "AZURE", telemetry=cpu_only, facts=cap, catalogs=SKUS))
eq("Azure with memory unmeasured → no exact size named", o.recommended, None)
check("…and the reason says memory was not measured", "Memory" in (o.recommendation or ""), o.recommendation)

# ═════════════════════════════════════════════════════════════════════════════
print("\n6. A list-price saving is withdrawn when billing shows a commitment")
gap = commitment_gap({"amount": 21.97, "currency": "INR", "period_days": 30}, 10.6056, "INR", 720)
check("billed 21.97 against ~7,636 at list for 720 hours → covered by a commitment", bool(gap), gap)
eq("an instance stopped for most of the month is not mistaken for a discounted one",
   commitment_gap({"amount": 1500.0, "currency": "INR"}, 10.6056, "INR", 200), None)
eq("under a week of running hours decides nothing", commitment_gap({"amount": 1.0, "currency": "INR"},
                                                                   10.0, "INR", 100), None)
eq("different currencies are not compared", commitment_gap({"amount": 1.0, "currency": "USD"}, 10.0,
                                                           "INR", 720), None)
billed_book = PriceBook(currency="INR", oci_flex=RATES,
                        billed={str(oci_vm.id): {"amount": 50.0, "currency": "INR", "period_days": 30}})
o = run("COMPUTE_UNDERUTILIZED", ctx_for(oci_vm, "OCI", telemetry=low, prices=billed_book, catalogs=SHAPES))
eq("OCI: a resize on a committed instance keeps its exact target…", bool(o.recommended), True)
eq("…but reports the saving as NA, with the billing that proves it", o.savings.method, SAVINGS_NONE)
check("…and that reason is on the finding", "reservation" in (o.savings.reason or ""), o.savings.reason)

# ═════════════════════════════════════════════════════════════════════════════
print("\n7. Network: the unused-IP rule needs both associations")
old = res("PublicIP", config={"attached_to_id": None, "sku": "Standard"}, region="centralindia")
eq("inventory without the NAT-gateway field → INSUFFICIENT_DATA, not 'unused'",
   run("PUBLIC_IP_UNUSED", ctx_for(old, "AZURE")).verdict, INSUFFICIENT_DATA)
nat = res("PublicIP", config={"attached_to_id": None, "nat_gateway_id": "/sub/x/natGateways/gw"})
eq("an address held by a NAT gateway → CLEAR", run("PUBLIC_IP_UNUSED", ctx_for(nat, "AZURE")).verdict, CLEAR)
free = res("PublicIP", config={"attached_to_id": None, "nat_gateway_id": None, "sku": "Standard",
                               "allocation_method": "Static"}, ip="20.1.2.3")
o = run("PUBLIC_IP_UNUSED", ctx_for(free, "AZURE", billed={"amount": 330.0, "currency": "INR", "period_days": 30,
                                                           "source": "Azure Cost Management"}))
eq("both empty → FINDING", o.verdict, FINDING)
eq("…with the address's own billed cost as the saving", (o.savings.method, o.savings.amount), (SAVINGS_BILLED, 330.0))
lb = res("LoadBalancer", config={"lb_type": "LoadBalancer", "backend_sets": [], "backend_ips": []})
eq("an OCI load balancer with no backend sets → FINDING", run("LB_NO_BACKENDS", ctx_for(lb, "OCI")).verdict, FINDING)
eq("a load balancer whose backends were never collected → INSUFFICIENT_DATA",
   run("LB_NO_BACKENDS", ctx_for(res("LoadBalancer", config={"lb_type": "LoadBalancer"}), "OCI")).verdict,
   INSUFFICIENT_DATA)

# ═════════════════════════════════════════════════════════════════════════════
print("\n8. Stopped instances, volumes, functions, databases")
inst = res("ComputeInstance", provider_id="ocid1.instance.x", nstatus="STOPPED", status="STOPPED",
           config={"private_ip": "10.0.0.5"})
vol = res("BlockVolume", config={"size_gb": 100, "vpus_per_gb": 10, "attached_to_id": "ocid1.instance.x"})
book2 = PriceBook(currency="INR", billed={str(vol.id): {"amount": 400.0, "currency": "INR", "period_days": 30,
                                                        "source": "OCI Usage API"},
                                          str(inst.id): {"amount": 9000.0, "currency": "INR", "period_days": 30}})
o = run("COMPUTE_STOPPED_STILL_BILLING", ctx_for(inst, "OCI", prices=book2,
                                                 attached={"ocid1.instance.x": [vol]},
                                                 catalogs={"lb_backend_ips": {"10.0.0.5": ["lb-1"]}}))
eq("stopped with a billed volume → FINDING", o.verdict, FINDING)
eq("the saving is the volume's billed cost only — compute already stopped accruing",
   (o.savings.method, o.savings.amount), (SAVINGS_BILLED, 400.0))
check("…and it flags that the instance is still a load-balancer backend",
      any(c["state"] == "FAIL" and "lb-1" in (c["detail"] or "") for c in o.safety["checks"]))
az_stopped = res("VirtualMachine", nstatus="STOPPED", config={"power_state": "VM stopped"})
o = run("COMPUTE_STOPPED_STILL_BILLING", ctx_for(az_stopped, "AZURE"))
eq("an Azure VM stopped but not deallocated is a HIGH cost finding", (o.verdict, o.severity), (FINDING, "HIGH"))
check("…whose fix is deallocation, not deletion", "Deallocate" in o.recommendation)

un = res("BlockVolume", attachment_state="UNATTACHED",
         config={"size_gb": 100, "vpus_per_gb": 10, "is_auto_tune_enabled": False})
blk = {"B91961": {"value": 2.4363975}, "B91962": {"value": 0.1624265}}
o = run("VOLUME_UNATTACHED", ctx_for(un, "OCI", prices=PriceBook(currency="INR", oci_block=blk)))
eq("an unattached OCI volume with no billed row falls back to list price", o.savings.method, SAVINGS_LIST_PRICE)
eq("…100 GB × (2.4364 + 10 × 0.1624)", o.savings.amount, round(100 * 2.4363975, 2) + round(100 * 10 * 0.1624265, 2))
check("…and suggests detached-volume auto-tune if it must be kept", "auto-tune" in o.recommendation)
eq("an Azure disk with no disk_state → INSUFFICIENT_DATA",
   run("VOLUME_UNATTACHED", ctx_for(res("ManagedDisk", config={"sku": "Premium_LRS"}), "AZURE")).verdict,
   INSUFFICIENT_DATA)

fn = res("LambdaFunction", config={"memory_mb": 128, "timeout_s": 3})
eq("a successful query with no invocation datapoints → FINDING (not invoked)",
   run("FUNCTION_NOT_INVOKED", ctx_for(fn, "AWS", telemetry=tm(invocations=ST_NO_DATA))).verdict, FINDING)
eq("a FAILED invocation query → INSUFFICIENT_DATA, never 'not invoked'",
   run("FUNCTION_NOT_INVOKED", ctx_for(fn, "AWS", telemetry=tm(invocations=ST_ERROR))).verdict,
   INSUFFICIENT_DATA)
eq("an uninvoked function has no error rate → NOT_APPLICABLE",
   run("FUNCTION_HIGH_ERROR_RATE", ctx_for(fn, "AWS", telemetry=tm(invocations=ST_NO_DATA))).verdict,
   NOT_APPLICABLE)
o = run("FUNCTION_NOT_INVOKED", ctx_for(fn, "AWS", telemetry=tm(invocations=ST_NO_DATA)))
eq("…and claims no saving (Lambda bills per invocation)", o.savings.priced, False)

li = res("DbSystem", config={"license_model": "LICENSE_INCLUDED", "cpu_core_count": 16, "node_count": 2,
                             "database_edition": "ENTERPRISE_EDITION_EXTREME_PERFORMANCE"})
o = run("DATABASE_LICENSE_INCLUDED", ctx_for(li, "OCI"))
eq("a license-included DB system → FINDING with an unpriced saving", (o.verdict, o.savings.priced), (FINDING, False))
check("…whose safety check names the licences needed, including RAC for two nodes",
      any("Real Application Clusters" in (c["detail"] or "") for c in o.safety["checks"]))
eq("BYOL → CLEAR", run("DATABASE_LICENSE_INCLUDED", ctx_for(res("DbSystem", config={
    "license_model": "BRING_YOUR_OWN_LICENSE"}), "OCI")).verdict, CLEAR)
maz = res("RDSInstance", config={"multi_az": True})
eq("Multi-AZ with NO environment tag is never questioned (a missing tag is not 'non-prod')",
   run("DATABASE_MULTI_AZ_NON_PROD", ctx_for(maz, "AWS")).verdict, INSUFFICIENT_DATA)
maz.environment = "dev"
eq("…tagged 'dev' → a LOW finding", run("DATABASE_MULTI_AZ_NON_PROD", ctx_for(maz, "AWS")).severity, "LOW")
s3 = res("S3Bucket", config={"lifecycle_rules": []})
eq("S3 lifecycle confirmed empty → FINDING", run("BUCKET_NO_LIFECYCLE", ctx_for(s3, "AWS")).verdict, FINDING)
eq("S3 lifecycle not reported → INSUFFICIENT_DATA",
   run("BUCKET_NO_LIFECYCLE", ctx_for(res("S3Bucket", config={"lifecycle_rules": None}), "AWS")).verdict,
   INSUFFICIENT_DATA)
# OCI's UncommittedParts is a SIZE in bytes ("Incomplete MultiPart Upload Size"),
# not a count: 20 GiB of parts once read as "21,474,836,480 parts".
twenty_gib = 20 * 1024 ** 3
parts_tm = tm(uncommitted_parts=stats("uncommitted_parts", float(twenty_gib), n=48))
os_part = {"part": "B91628", "value": 2.4363975, "display_name": "Object Storage - Storage",
           "currency": "INR", "free_tier": True}
bkt = res("ObjectStorageBucket", config={"storage_tier": "Standard"})
o = run("BUCKET_INCOMPLETE_UPLOADS", ctx_for(bkt, "OCI", telemetry=parts_tm,
                                             prices=PriceBook(currency="INR", oci_parts={"B91628": os_part})))
check("incomplete uploads are reported as a size, not a count of parts",
      "20.0 GB" in o.detail and "parts on" not in o.detail, o.detail)
eq("…and priced from the verified Object Storage rate: 20 GB × ₹2.4364",
   (o.savings.method, o.savings.amount), (SAVINGS_LIST_PRICE, round(20 * 2.4363975, 2)))
check("…with the GB definition stated as an assumption",
      any("1,073,741,824" in a for a in o.savings.assumptions))
o = run("BUCKET_INCOMPLETE_UPLOADS", ctx_for(bkt, "OCI", telemetry=parts_tm))
eq("no verified rate → the saving is N/A, never 0", o.savings.priced, False)
o = run("BUCKET_INCOMPLETE_UPLOADS", ctx_for(
    res("ObjectStorageBucket", config={"storage_tier": "Archive"}), "OCI", telemetry=parts_tm,
    prices=PriceBook(currency="INR", oci_parts={"B91628": os_part})))
eq("an Archive bucket is not priced at the Standard rate", o.savings.priced, False)
wrong = {**os_part, "display_name": "Archive Storage - Storage"}
o = run("BUCKET_INCOMPLETE_UPLOADS", ctx_for(bkt, "OCI", telemetry=parts_tm,
                                             prices=PriceBook(currency="INR", oci_parts={"B91628": wrong})))
eq("a part whose published name does not match is not used", o.savings.priced, False)
eq("no incomplete uploads → CLEAR", run("BUCKET_INCOMPLETE_UPLOADS", ctx_for(
    bkt, "OCI", telemetry=tm(uncommitted_parts=stats("uncommitted_parts", 0.0, n=48)))).verdict, CLEAR)

# ═════════════════════════════════════════════════════════════════════════════
print("\n9. Savings never become zero")
d = Savings(reason="not priced").to_dict()
eq("an unpriced saving serialises as amount None with its reason", (d["amount"], d["priced"]), (None, False))
d = Savings(method=SAVINGS_LIST_PRICE, amount=None).to_dict()
eq("a method with no amount is still unpriced", d["method"], SAVINGS_NONE)

# ═════════════════════════════════════════════════════════════════════════════
print("\n10. The engine: dispatch, isolation, resolution evidence")
good = res("PublicIP", provider_id="/pip/free", config={"attached_to_id": None, "nat_gateway_id": None})
clear_ip = res("PublicIP", provider_id="/pip/used", config={"attached_to_id": "/nic/1", "nat_gateway_id": None})
aws_lb = res("LoadBalancer", provider_id="arn:lb", config={})
a1 = engine.analyze(account_id="acc", provider="Azure", resources=[good, clear_ip], now=NOW)
eq("one finding for the free IP", [f.resource_key for f in a1.findings], ["/pip/free"])
eq("the associated IP's CLEAR is recorded for resolution",
   a1.evaluations[("PUBLIC_IP_UNUSED", "/pip/used")][0], CLEAR)
eq("a complete sweep and no telemetry problems → COMPLETE", a1.outcome, RUN_COMPLETE)
a2 = engine.analyze(account_id="acc", provider="Azure", resources=[good], sweep_complete=False, now=NOW)
eq("an incomplete sweep → PARTIAL", a2.outcome, RUN_PARTIAL)
eq("the fingerprint is stable across runs", a1.findings[0].fingerprint, a2.findings[0].fingerprint)
eq("…and built from provider + account + rule + provider id",
   a1.findings[0].fingerprint, fingerprint(provider="AZURE", account_id="acc", rule_id="PUBLIC_IP_UNUSED",
                                           resource_key="/pip/free"))
a3 = engine.analyze(account_id="acc", provider="AWS", resources=[aws_lb], now=NOW)
eq("no OCI load-balancer rule runs on an AWS load balancer", a3.rules_evaluated, 0)

original = reg.by_id("NIC_UNATTACHED").evaluate
object.__setattr__(reg.by_id("NIC_UNATTACHED"), "evaluate", lambda ctx: 1 / 0)
try:
    nic = res("NetworkInterface", config={"attachment_status": "Unattached"})
    a4 = engine.analyze(account_id="acc", provider="Azure", resources=[nic, good], now=NOW)
    eq("a crashing rule is recorded as an ERROR on that rule", a4.coverage["NIC_UNATTACHED"]["ERROR"], 1)
    eq("…and every other rule still runs", len(a4.findings), 1)
finally:
    object.__setattr__(reg.by_id("NIC_UNATTACHED"), "evaluate", original)
nodata = res("LambdaFunction", provider_id="arn:fn", config={"memory_mb": 128})
a5 = engine.analyze(account_id="acc", provider="AWS", resources=[nodata],
                    telemetry={str(nodata.id): tm(invocations=ST_ERROR)}, now=NOW)
eq("a rule that could not decide records INSUFFICIENT_DATA — which never resolves a finding",
   a5.evaluations[("FUNCTION_NOT_INVOKED", "arn:fn")][0], INSUFFICIENT_DATA)

# ═════════════════════════════════════════════════════════════════════════════
dup_real = res("VirtualMachine", provider_id="/subscriptions/s/resourceGroups/N8N/providers/Microsoft.Compute/virtualMachines/vm1",
               nstatus="RUNNING", config={"vm_size": "Standard_D2s_v3", "power_state": "VM running"})
dup_generic = res("VirtualMachine", provider_id="/subscriptions/s/resourceGroups/n8n/providers/Microsoft.Compute/virtualMachines/vm1",
                  nstatus="UNKNOWN", config={"azure_type": "Microsoft.Compute/virtualMachines"})
a6 = engine.analyze(account_id="acc", provider="Azure", resources=[dup_real, dup_generic], now=NOW)
eq("an ARM id repeated in another case is analysed once", (a6.duplicates, a6.resources_total), (1, 1))
check("…using the detailed copy: the previous-generation finding is raised on it",
      any(f.rule_id == "COMPUTE_PREVIOUS_GENERATION" and f.resource_id == str(dup_real.id) for f in a6.findings))
a7 = engine.analyze(account_id="acc", provider="Azure", resources=[dup_generic, dup_real], now=NOW)
eq("…whichever order the rows arrive in", [f.resource_id for f in a7.findings if f.rule_id ==
   "COMPUTE_PREVIOUS_GENERATION"], [str(dup_real.id)])

print("\n11. Health scores only where evidence exists")
h = health.score_resource(optimization_findings=[], security_findings=[], evaluations={},
                          security_assessed=False)
eq("nothing decided → no overall score", h["overall"], None)
check("…with the reason", "Insufficient" in h["overall_reason"])
h = health.score_resource(
    optimization_findings=[{"category": "RIGHTSIZING", "signal": "UNDERUTILIZED", "severity": "MEDIUM",
                            "rule_id": "COMPUTE_UNDERUTILIZED"}],
    security_findings=[{"verdict": "VULNERABLE", "severity": "HIGH", "rule_id": "X",
                        "unified_category": "SECURITY"}],
    evaluations={"COMPUTE_CPU_CONSTRAINED": CLEAR}, security_assessed=True)
eq("security 100 − 25 for a HIGH", h["dimensions"]["security"]["score"], 75)
eq("cost 100 − 12 for a MEDIUM", h["dimensions"]["cost"]["score"], 88)
eq("performance decided (CPU checked, clear) → 100", h["dimensions"]["performance"]["score"], 100)
eq("reliability never decided → N/A", h["dimensions"]["reliability"]["score"], None)
eq("overall is the mean of the scored dimensions", h["overall"], round((75 + 88 + 100) / 3))

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
sys.exit(1 if fail else 0)
