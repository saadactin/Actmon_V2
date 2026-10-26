"""Compute rules: rightsizing, constraint, stopped-but-billing, previous generation.

The rightsizing rule is where "never invent a number" is hardest, so its
behaviour is worth stating plainly:

* It needs 14+ days of hourly CPU datapoints covering 60%+ of the window, or
  it concludes INSUFFICIENT_DATA — no recommendation at all.
* An exact target size is named ONLY when the provider publishes the sizes
  that could replace this one, with their capacity: OCI Flex shapes (OCPU and
  memory are independent, limits from ListShapes) and Azure sizes (vCPU and
  memory per size from the Resource SKUs API). The target must keep the
  measured P95 at or under 60% and P99 at or under 85% at the new size.
* Memory that was not measured is never reduced. A target that would need to
  shrink unmeasured memory is not proposed; the finding says "evaluate a
  smaller size" and why an exact size could not be calculated.
* Accelerated instances (GPU families) are not judged on CPU at all: their
  capacity is the accelerator, which none of the three clouds report without
  an in-guest agent.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from app.optimization.model import (
    AWS, AZURE, CHECK_FAIL, CHECK_PASS, CHECK_UNKNOWN, CLEANUP, CONF_HIGH, CONF_LOW,
    CONF_MEDIUM, CONFIGURATION, CONFIRM_FIRST, COST, EV_CONFIGURATION, EV_DERIVED, FINDING,
    HIGH, LOW, MEDIUM, OCI, PERFORMANCE, RIGHTSIZING, RISK_HIGH, RISK_LOW, RISK_MEDIUM,
    SAFE, SAVINGS_LIST_PRICE, WITH_CARE, Savings, check, data_source, evidence, no_savings,
)
from app.optimization.rules.base import (
    SIG_CONFIGURATION, SIG_CONSTRAINED, SIG_UNDERUTILIZED, SIG_UNUSED, Ctx, Outcome,
    Rule, billed_evidence, billed_savings, billing_source, ceil_to, cfg_num, clear,
    insufficient, is_running, metric_evidence, metric_source, money, not_applicable,
    since_change, telemetry_gate,
)
from app.optimization.pricebook import commitment_gap, effective_rate
from app.optimization.telemetry import display

COMPUTE_TYPES = ("EC2Instance", "VirtualMachine", "ComputeInstance")
HOURS_PER_MONTH = 730


class NoSmaller(str):
    """A sizing answer meaning "there is no smaller configuration to move to" —
    as opposed to "an exact size could not be calculated". The first makes a
    finding pointless unless the instance is nearly idle; the second still
    leaves "evaluate a smaller size" as honest advice."""

_AWS_ACCEL_FAMILIES = ("g", "p", "inf", "trn", "dl", "f", "vt")
_AWS_PREVIOUS = {"t1", "t2", "m1", "m2", "m3", "m4", "c1", "c3", "c4", "r3", "r4",
                 "i2", "d2", "x1", "g2", "g3", "p2", "cc2", "cr1", "hs1"}


# ── Capacity: what the instance has, from the provider ───────────────────────

def capacity(ctx: Ctx) -> Dict[str, Any]:
    """vCPU/OCPU and memory of the current size, with where the numbers came from."""
    cfg = ctx.config
    if ctx.provider == OCI:
        ocpus, mem = cfg_num(cfg, "ocpus"), cfg_num(cfg, "memory_gb")
        return {"size": cfg.get("shape"), "cpu": ocpus, "cpu_unit": "OCPU",
                "memory_gb": mem, "source": "OCI Compute API (instance shape configuration)",
                "known": ocpus is not None and mem is not None}
    if ctx.provider == AZURE:
        cap = (ctx.facts or {}).get("capacity") or {}
        return {"size": cfg.get("vm_size"), "cpu": cap.get("vcpus"), "cpu_unit": "vCPU",
                "memory_gb": cap.get("memory_gb"), "family": cap.get("family"),
                "gpus": cap.get("gpus"), "source": "Azure Resource SKUs API",
                "known": bool(cap.get("vcpus") and cap.get("memory_gb"))}
    itype = cfg.get("instance_type")
    cat = ((ctx.catalogs or {}).get("aws_instance_types") or {}).get(itype) or {}
    return {"size": itype, "cpu": cat.get("vcpus"), "cpu_unit": "vCPU",
            "memory_gb": cat.get("memory_gb"), "gpus": cat.get("gpus"),
            "source": "AWS EC2 DescribeInstanceTypes",
            "known": bool(cat.get("vcpus") and cat.get("memory_gb"))}


def accelerated(ctx: Ctx, cap: Dict[str, Any]) -> Optional[str]:
    """Why CPU is the wrong capacity to judge this instance on, if it is."""
    size = cap.get("size") or ""
    if cap.get("gpus"):
        return (f"{size} has {int(cap['gpus'])} GPU(s). Its capacity is the accelerator, and "
                "GPU utilization is not published by the provider without an in-guest agent, "
                "so CPU alone cannot say whether it is oversized.")
    if ctx.provider == AWS and size:
        # The leading letters name the family: g6e → "g", inf2 → "inf", p4d → "p".
        family = size.split(".")[0].lower()
        lead = ""
        for ch in family:
            if not ch.isalpha():
                break
            lead += ch
        if lead in _AWS_ACCEL_FAMILIES or lead == "gr":
            return (f"{size} is an accelerated-computing instance type. Its capacity is the "
                    "accelerator, and CloudWatch does not publish GPU utilization without the "
                    "agent's NVIDIA plugin, so CPU alone cannot say whether it is oversized.")
    if ctx.provider == OCI and "GPU" in size.upper():
        return (f"{size} is a GPU shape; GPU utilization is not published by OCI Monitoring "
                "without the compute agent's GPU plugin, so CPU alone cannot judge it.")
    return None


def _cpu_label(cap):
    unit = cap.get("cpu_unit") or "vCPU"
    return f"{cap['cpu']:g} {unit}" if cap.get("cpu") is not None else None


def _mem_label(gb):
    return f"{gb:g} GiB" if gb is not None else None


def _current_config(ctx: Ctx, cap: Dict[str, Any]) -> Dict[str, Any]:
    out = {"Size": cap.get("size"),
           cap.get("cpu_unit") or "vCPU": _cpu_label(cap),
           "Memory": _mem_label(cap.get("memory_gb")),
           "Region": getattr(ctx.resource, "region_or_zone", None),
           "State": getattr(ctx.resource, "status", None)}
    if ctx.provider == OCI:
        out["Attached storage"] = (f"{ctx.config.get('attached_storage_gb'):g} GB"
                                   if cfg_num(ctx.config, "attached_storage_gb") is not None else None)
    return {k: v for k, v in out.items() if v not in (None, "")}


def _utilization_evidence(ctx: Ctx) -> List[Dict[str, Any]]:
    ev = [
        metric_evidence(ctx, "cpu_percent", "avg", "CPU average"),
        metric_evidence(ctx, "cpu_percent", "p95", "CPU P95"),
        metric_evidence(ctx, "cpu_percent", "peak", "CPU peak"),
        metric_evidence(ctx, "memory_percent", "avg", "Memory average"),
        metric_evidence(ctx, "memory_percent", "p95", "Memory P95"),
        metric_evidence(ctx, "memory_percent", "peak", "Memory peak"),
    ]
    for key, label in (("network_in", "Network in, average per hour"),
                       ("network_out", "Network out, average per hour")):
        ev.append(metric_evidence(ctx, key, "avg", label))
    return ev


def _utilization_sources(ctx: Ctx) -> List[Dict[str, Any]]:
    return [
        metric_source(ctx, "cpu_percent", "30-day CPU telemetry"),
        metric_source(ctx, "memory_percent", "30-day memory telemetry", required=False),
        metric_source(ctx, "network_in", "30-day network telemetry", required=False),
        data_source("configuration", "Current size and capacity", capacity(ctx)["known"],
                    capacity(ctx)["source"]),
        billing_source(ctx),
    ]


# ── Sizing ───────────────────────────────────────────────────────────────────

def _need(current: float, p95: Optional[float], p99: Optional[float],
          t95: float, t99: float) -> float:
    need = 0.0
    if p95 is not None:
        need = max(need, current * p95 / t95)
    if p99 is not None:
        need = max(need, current * p99 / t99)
    return need


def _memory_peak_need(tm, capacity_gb: float, th) -> float:
    """GiB the measured peak memory hour needs under the peak ceiling. Zero when
    no per-hour maximum was published (P99 then carries the constraint)."""
    res = tm.result("memory_percent")
    if not res.ok or (res.stats or {}).get("peak_source") != "maximum":
        return 0.0
    return capacity_gb * (res.get("peak") or 0.0) / th["sizing_memory_peak_max"]


def oci_flex_target(ctx: Ctx, cap: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], str]:
    """(target, reason). The smallest Flex configuration that keeps the measured
    load under the targets, within the shape's published limits."""
    shape = cap.get("size") or ""
    if not shape.endswith(".Flex"):
        return None, (f"{shape} is a fixed shape, so there is no smaller configuration of the "
                      "same shape; moving to a Flex shape is a migration, not a resize.")
    th = ctx.thresholds
    tm = ctx.telemetry
    ocpus, mem = cap.get("cpu"), cap.get("memory_gb")
    if ocpus is None or mem is None:
        return None, "The instance's OCPU and memory configuration was not collected."
    limits = ((ctx.catalogs or {}).get("oci_shapes") or {}).get(shape) or {}
    need_cpu = _need(ocpus, tm.stat("cpu_percent", "p95"), tm.stat("cpu_percent", "p99"),
                     th["sizing_target_cpu_p95"], th["sizing_target_cpu_p99"])
    new_ocpu = max(limits.get("ocpu_min") or 1.0, ceil_to(need_cpu, 1.0))
    mem_measured = tm.ok("memory_percent")
    if mem_measured:
        need_mem = _need(mem, tm.stat("memory_percent", "p95"), tm.stat("memory_percent", "p99"),
                         th["sizing_target_memory_p95"], th["sizing_target_memory_p99"])
        need_mem = max(need_mem, _memory_peak_need(tm, mem, th))
        new_mem = ceil_to(max(need_mem, 1.0), 1.0)
    else:
        new_mem = mem   # never shrink what was not measured
    per_max = limits.get("memory_per_ocpu_max")
    per_min = limits.get("memory_per_ocpu_min")
    if per_max:
        new_ocpu = max(new_ocpu, ceil_to(new_mem / per_max, 1.0))
    if per_min:
        new_mem = max(new_mem, new_ocpu * per_min)
    new_mem = max(new_mem, limits.get("memory_min") or 1.0)
    new_ocpu, new_mem = min(new_ocpu, ocpus), min(new_mem, mem)
    if new_ocpu >= ocpus and new_mem >= mem:
        return None, NoSmaller("Utilization is low, but the measured peaks and the shape's minimums "
                               "leave no smaller configuration of this shape.")
    return {"shape": shape, "ocpus": new_ocpu, "memory_gb": new_mem,
            "limits_source": "OCI Compute ListShapes" if limits else None,
            "memory_measured": mem_measured}, ""


def azure_target(ctx: Ctx, cap: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], str]:
    region = (getattr(ctx.resource, "region_or_zone", "") or "").lower()
    catalog = ((ctx.catalogs or {}).get("azure_skus") or {}).get(region) or {}
    size = cap.get("size")
    cur = catalog.get(size)
    if not cur or not cur.get("vcpus") or not cur.get("memory_gb"):
        return None, ("The Resource SKUs API did not list this size in the VM's region, so "
                      "the sizes that could replace it are unknown.")
    th = ctx.thresholds
    tm = ctx.telemetry
    need_cpu = _need(cur["vcpus"], tm.stat("cpu_percent", "p95"), tm.stat("cpu_percent", "p99"),
                     th["sizing_target_cpu_p95"], th["sizing_target_cpu_p99"])
    if not tm.ok("memory_percent"):
        return None, ("Memory utilization was not measured, and a smaller Azure size has "
                      "less memory, so no exact size can be named safely.")
    need_mem = _need(cur["memory_gb"], tm.stat("memory_percent", "p95"),
                     tm.stat("memory_percent", "p99"),
                     th["sizing_target_memory_p95"], th["sizing_target_memory_p99"])
    need_mem = max(need_mem, _memory_peak_need(tm, cur["memory_gb"], th))
    options = [
        s for s in catalog.values()
        if s.get("family") == cur.get("family") and not s.get("restricted")
        and s.get("vcpus") and s.get("memory_gb")
        and (s.get("gpus") or 0) == (cur.get("gpus") or 0)
        and (s.get("premium_io") or not cur.get("premium_io"))
        and s["vcpus"] >= need_cpu and s["memory_gb"] >= need_mem
        and s["vcpus"] <= cur["vcpus"] and s["memory_gb"] <= cur["memory_gb"]
        and (s["vcpus"] < cur["vcpus"] or s["memory_gb"] < cur["memory_gb"])
    ]
    if not options:
        smaller_exist = any(
            s.get("family") == cur.get("family") and s.get("vcpus") and s.get("memory_gb")
            and s["vcpus"] <= cur["vcpus"] and s["memory_gb"] <= cur["memory_gb"]
            and (s["vcpus"] < cur["vcpus"] or s["memory_gb"] < cur["memory_gb"])
            for s in catalog.values())
        if not smaller_exist:
            return None, NoSmaller(f"{size} is already the smallest size in the {cur.get('family') or 'same'} "
                          "family. A smaller configuration means changing series (for example to "
                          "a burstable B-series size), which changes the CPU performance model and "
                          "has to be evaluated against the workload.")
        return None, NoSmaller(f"Smaller sizes exist in the {cur.get('family') or 'same'} family, but none "
                      "has enough vCPU and memory for the measured P95 and P99 at the sizing targets.")
    best = min(options, key=lambda s: (s["vcpus"], s["memory_gb"], s["name"]))
    return {"size": best["name"], "vcpus": best["vcpus"], "memory_gb": best["memory_gb"],
            "family": best.get("family"), "current_vcpus": cur["vcpus"],
            "current_memory_gb": cur["memory_gb"]}, ""


# ── Rule: underutilized ──────────────────────────────────────────────────────

def _underutilized(ctx: Ctx):
    running = is_running(ctx.resource)
    if running is False:
        return not_applicable("The instance is not running.")
    cap = capacity(ctx)
    acc = accelerated(ctx, cap)
    sources = _utilization_sources(ctx)
    if acc:
        return insufficient(acc, data_sources=sources)
    ok, why = telemetry_gate(ctx, "cpu_percent")
    if not ok:
        return insufficient(why, data_sources=sources)
    tm, th = ctx.telemetry, ctx.thresholds
    cpu_p95 = tm.stat("cpu_percent", "p95")
    cpu_p99 = tm.stat("cpu_percent", "p99")
    if cpu_p95 > th["underutilized_cpu_p95"]:
        return clear(f"CPU P95 is {cpu_p95:.1f}%, above the {th['underutilized_cpu_p95']:g}% "
                     "underutilization bar.")
    if cpu_p99 is not None and cpu_p99 > th["underutilized_cpu_peak"]:
        return clear(f"CPU P95 is low ({cpu_p95:.1f}%) but its busiest hours reach "
                     f"{cpu_p99:.1f}% (P99): a smaller size would saturate then.")
    mem_ok, mem_why = telemetry_gate(ctx, "memory_percent")
    mem_p95 = tm.stat("memory_percent", "p95") if mem_ok else None
    if mem_ok and mem_p95 > th["underutilized_memory_p95"]:
        return clear(f"CPU is low, but memory P95 is {mem_p95:.1f}% — memory is what this "
                     "size is carrying.")

    idle = cpu_p95 <= th["idle_cpu_p95"] and (mem_p95 is None or mem_p95 <= 30.0)
    severity = HIGH if idle else MEDIUM
    title = ("Compute resource is nearly idle" if idle
             else "Compute resource appears underutilized")

    # Exact target, when the provider publishes the alternatives.
    target, target_reason = (None, "")
    recommended = None
    savings: Optional[Savings] = None
    pricing_request = None
    projected: Dict[str, Optional[float]] = {}
    if ctx.provider == OCI:
        target, target_reason = oci_flex_target(ctx, cap)
        if target:
            projected["cpu_p95"] = cpu_p95 * cap["cpu"] / target["ocpus"]
            if mem_ok:
                projected["memory_p95"] = mem_p95 * cap["memory_gb"] / target["memory_gb"]
            recommended = {
                "Size": f"{target['shape']} (same shape)",
                "OCPU": f"{target['ocpus']:g} OCPU",
                "Memory": f"{target['memory_gb']:g} GiB"
                          + ("" if target["memory_measured"] else " (unchanged — memory not measured)"),
                "Projected CPU P95": display(projected["cpu_p95"], "percent"),
                "Projected memory P95": display(projected.get("memory_p95"), "percent"),
            }
            cur_price = ctx.prices.oci_flex_hourly(target["shape"], cap["cpu"], cap["memory_gb"])
            new_price = ctx.prices.oci_flex_hourly(target["shape"], target["ocpus"], target["memory_gb"])
            gap = (commitment_gap(ctx.billed, cur_price[0], ctx.prices.oci_flex[target["shape"]]["currency"],
                                  (tm.result("cpu_percent").stats or {}).get("samples"))
                   if cur_price else None)
            if gap:
                savings = no_savings(gap)
            elif cur_price and new_price:
                monthly = (cur_price[0] - new_price[0]) * HOURS_PER_MONTH
                cur_ccy = ctx.prices.oci_flex[target["shape"]]["currency"]
                rate = effective_rate(ctx.billed, cur_price[0], cur_ccy,
                                      (tm.result("cpu_percent").stats or {}).get("samples"))
                extra = ([f"At this instance's effective rate (its billed cost is {rate * 100:.0f}% of "
                          "list for the hours it ran) the saving would be about "
                          f"{money(monthly * rate, cur_ccy)} a month."]
                         if rate is not None and rate < 0.97 else [])
                savings = Savings(
                    method=SAVINGS_LIST_PRICE, amount=round(monthly, 2),
                    currency=cur_ccy,
                    basis=("OCI public price list, pay-as-you-go OCPU-hour and GB-hour rates for "
                           f"{target['shape']}, × {HOURS_PER_MONTH} hours a month. A negotiated or "
                           "committed-use rate makes the real saving smaller."),
                    breakdown=(
                        [{**l, "component": f"Current · {l['component']}"} for l in cur_price[1]]
                        + [{**l, "component": f"Recommended · {l['component']}"} for l in new_price[1]]
                        + [{"component": "Difference per hour",
                            "hourly_cost": round(cur_price[0] - new_price[0], 4)},
                           {"component": f"× {HOURS_PER_MONTH} hours",
                            "monthly_cost": round(monthly, 2)}]),
                    assumptions=[f"{HOURS_PER_MONTH} hours per month (8,760 / 12), running continuously."]
                    + extra,
                )
            else:
                savings = no_savings(
                    f"No OCI price-list part is verified for {target['shape']} in this build, "
                    "so the OCPU and memory reduction is not priced.")
    elif ctx.provider == AZURE:
        target, target_reason = azure_target(ctx, cap)
        if target:
            projected["cpu_p95"] = cpu_p95 * target["current_vcpus"] / target["vcpus"]
            if mem_ok:
                projected["memory_p95"] = mem_p95 * target["current_memory_gb"] / target["memory_gb"]
            recommended = {
                "Size": target["size"],
                "vCPU": f"{target['vcpus']:g} vCPU",
                "Memory": f"{target['memory_gb']:g} GiB",
                "Projected CPU P95": display(projected["cpu_p95"], "percent"),
                "Projected memory P95": display(projected.get("memory_p95"), "percent"),
            }
            pricing_request = {"kind": "azure_vm", "region": (ctx.resource.region_or_zone or "").lower(),
                               "os": ctx.config.get("os_type"), "current": cap.get("size"),
                               "target": target["size"], "billed": ctx.billed,
                               "running_hours": (tm.result("cpu_percent").stats or {}).get("samples")}
    else:
        target_reason = ("AWS does not report memory without the CloudWatch agent, and the "
                         "AWS price list is not available to these credentials, so no exact "
                         "size or saving is calculated.")

    if target is None and isinstance(target_reason, NoSmaller):
        if not idle:
            return clear(str(target_reason))
        severity = LOW
        title = "Compute resource is nearly idle at its smallest size"
        target_reason = NoSmaller(
            "It is nearly idle and already at its smallest configuration: confirm it is still "
            "needed, or move its workload elsewhere. " + str(target_reason))

    if target is None and savings is None:
        savings = no_savings(target_reason or "No exact target size could be calculated.")

    if target is None and isinstance(target_reason, NoSmaller):
        recommendation = str(target_reason)
    elif target is None:
        recommendation = ("Evaluate one or more smaller sizes. " + (target_reason or "")).strip()
    elif ctx.provider == OCI:
        recommendation = (f"Reduce the shape configuration to {target['ocpus']:g} OCPU and "
                          f"{target['memory_gb']:g} GiB. At the measured load that keeps CPU P95 "
                          f"near {projected['cpu_p95']:.0f}%.")
    else:
        recommendation = (f"Resize to {target['size']} ({target['vcpus']:g} vCPU, "
                          f"{target['memory_gb']:g} GiB). At the measured load that keeps CPU "
                          f"P95 near {projected['cpu_p95']:.0f}%.")

    reasons = []
    obs_days = (tm.result("cpu_percent").stats or {}).get("observed_days") or 0
    if mem_ok:
        reasons.append("CPU and memory were both measured.")
    else:
        reasons.append(f"Memory was not measured: {mem_why}")
    if target is not None:
        reasons.append("The target size comes from the provider's published sizes and limits.")
    if (cap.get("size") or "").lower().startswith(("standard_b", "t2.", "t3.", "t4g.")):
        reasons.append("Burstable size: smaller sizes also have lower CPU credit baselines — "
                       "check the credit balance before resizing.")
    confidence = (CONF_HIGH if mem_ok and target is not None and obs_days >= 28
                  and not any("Burstable" in r for r in reasons)
                  else CONF_MEDIUM if mem_ok or target is not None else CONF_LOW)

    checks = [
        check("CPU measured for at least 14 days", CHECK_PASS,
              f"{obs_days:g} days of hourly datapoints"),
        check("Memory measured", CHECK_PASS if mem_ok else CHECK_UNKNOWN,
              None if mem_ok else mem_why),
    ]
    if projected.get("cpu_p95") is not None:
        p99_new = (cpu_p99 or 0) * (cap["cpu"] / target["ocpus"] if ctx.provider == OCI
                                    else target["current_vcpus"] / target["vcpus"])
        checks.append(check(
            "Busiest hours stay under the P99 target at the new size",
            CHECK_PASS if p99_new <= ctx.thresholds["sizing_target_cpu_p99"] else CHECK_FAIL,
            f"projected CPU P99 {p99_new:.1f}%"))
    cpu_res = tm.result("cpu_percent")
    if projected.get("cpu_p95") is not None and (cpu_res.stats or {}).get("peak_source") == "maximum":
        ratio = (cap["cpu"] / target["ocpus"] if ctx.provider == OCI
                 else target["current_vcpus"] / target["vcpus"])
        peak_new = (cpu_res.get("peak") or 0.0) * ratio
        checks.append(check(
            "The measured busiest hour fits the new size",
            CHECK_PASS if peak_new <= 100.0 else CHECK_FAIL,
            f"projected CPU peak {peak_new:.0f}%"
            + ("" if peak_new <= 100.0 else " - those hours would be CPU-bound (slower, not failed)")))
    checks.append(check("Part of an auto-scaling group or cluster", CHECK_UNKNOWN,
                        "Not collected — a scaling group may resize or replace it on its own."))

    return Outcome(
        verdict=FINDING, severity=severity, title=title,
        detail=(f"CPU P95 {cpu_p95:.1f}% over {obs_days:g} days"
                + (f", memory P95 {mem_p95:.1f}%" if mem_ok else ", memory not measured") + "."),
        recommendation=recommendation,
        evidence=_utilization_evidence(ctx) + [billed_evidence(ctx)],
        current=_current_config(ctx, cap),
        recommended=recommended,
        savings=savings,
        pricing_request=pricing_request,
        confidence=confidence, confidence_reasons=reasons,
        risk=RISK_MEDIUM,
        risk_notes=["Resizing restarts the instance.",
                    "A workload with rare, heavy peaks can need the headroom the averages do not show."],
        impact={
            "cost": "Lower compute charge." if target else "Potentially lower compute charge.",
            "performance": ("Requires validation — projected CPU P95 "
                            f"{display(projected.get('cpu_p95'), 'percent')} at the new size."
                            if projected else "Requires validation against the workload."),
            "availability": "The change restarts the instance; plan a maintenance window.",
        },
        safety={"verdict": WITH_CARE, "reversible": True, "checks": checks,
                "preconditions": ["Schedule a window: the resize restarts the instance.",
                                  "Watch CPU and memory for a week afterwards, and resize back "
                                  "if P95 climbs past the target."]},
        data_sources=_utilization_sources(ctx),
    )


# ── Rules: constrained ───────────────────────────────────────────────────────

def _constrained(metric: str, noun: str):
    def evaluate(ctx: Ctx):
        if is_running(ctx.resource) is False:
            return not_applicable("The instance is not running.")
        ok, why = telemetry_gate(ctx, metric)
        sources = _utilization_sources(ctx)
        if not ok:
            return insufficient(why, data_sources=sources)
        p95 = ctx.telemetry.stat(metric, "p95")
        bar = ctx.thresholds[f"constrained_{noun}_p95"]
        if p95 < bar:
            return clear(f"{noun.title()} P95 is {p95:.1f}%, under the {bar:g}% constraint bar.")
        cap = capacity(ctx)
        return Outcome(
            verdict=FINDING, severity=HIGH if p95 >= 97.0 else MEDIUM,
            detail=f"{noun.title()} P95 {p95:.1f}% over the last 30 days.",
            recommendation=(f"Evaluate a larger size or spreading the load. {noun.title()} spends "
                            f"at least 5% of hours above {p95:.0f}%, where requests queue or the "
                            "operating system starts reclaiming memory."),
            evidence=_utilization_evidence(ctx) + [billed_evidence(ctx)],
            current=_current_config(ctx, cap),
            savings=no_savings("This recommendation adds capacity; it raises cost rather than "
                               "saving it."),
            confidence=CONF_HIGH, confidence_reasons=[f"{noun.title()} was measured hourly by the provider."],
            risk=RISK_MEDIUM, risk_notes=["A resize restarts the instance."],
            impact={"cost": "Higher compute charge.",
                    "performance": "Relieves the measured constraint.",
                    "availability": "The change restarts the instance."},
            safety={"verdict": WITH_CARE, "reversible": True, "checks": [
                check(f"{noun.title()} measured for at least 14 days", CHECK_PASS)],
                "preconditions": ["Check whether the load is a runaway process before adding capacity."]},
            data_sources=sources, signal=SIG_CONSTRAINED,
        )
    return evaluate


# ── Rule: stopped but still billing ──────────────────────────────────────────

def _attached_volumes(ctx: Ctx) -> List[Any]:
    key = (ctx.resource.provider_resource_id or "").lower()
    return list(ctx.attached.get(key, []))


def _volume_gb(v) -> Optional[float]:
    cfg = v.config or {}
    return cfg_num(cfg, "size_gb") if cfg_num(cfg, "size_gb") is not None else cfg_num(cfg, "disk_size_gb")


def _stopped(ctx: Ctx):
    if is_running(ctx.resource) is not False:
        return not_applicable("The instance is not stopped.")
    power = (ctx.config.get("power_state") or "").lower()
    vols = _attached_volumes(ctx)
    since = since_change(ctx, ("status", "power_state", "normalized_status"),
                         ("stopped", "vm stopped", "vm deallocated", "deallocated"))
    ev = [evidence("State", getattr(ctx.resource, "status", None) or power,
                   kind=EV_CONFIGURATION, source="Provider compute API")]
    if since:
        ev.append(evidence("Stopped since", since.get("at"), kind=EV_CONFIGURATION,
                           source="Config Drift log", detail="first sweep that saw it stopped"))
    total_gb = sum(g for g in (_volume_gb(v) for v in vols) if g is not None)
    ev.append(evidence("Attached volumes", len(vols), display=(
        f"{len(vols)} ({total_gb:,.0f} GB)" if vols else "None found in the inventory"),
        kind=EV_CONFIGURATION, source="Inventory attachment records"))

    # Azure: a VM shut down from inside the OS is "stopped", not "deallocated",
    # and Azure keeps billing its compute. That is a different, cheaper fix.
    if ctx.provider == AZURE and power == "vm stopped":
        sav = billed_savings(ctx, what="this VM")
        return Outcome(
            verdict=FINDING, severity=HIGH, signal=SIG_UNUSED,
            title="VM is stopped but not deallocated — compute is still billed",
            detail="Power state 'VM stopped' (not deallocated).",
            recommendation=("Deallocate the VM (Stop in the portal, or az vm deallocate). A VM "
                            "shut down from inside the operating system stays allocated and "
                            "keeps billing for compute."),
            evidence=ev + [billed_evidence(ctx)],
            current=_current_config(ctx, capacity(ctx)),
            recommended={"Power state": "Stopped (deallocated)"},
            savings=sav or no_savings(ctx.prices.billing_gap(ctx.provider)),
            confidence=CONF_HIGH, confidence_reasons=["Azure reports the power state directly."],
            risk=RISK_LOW, risk_notes=["A dynamic public IP is released on deallocation."],
            impact={"cost": "Ends the compute charge while it is stopped.",
                    "performance": "None while stopped.",
                    "availability": "Starting it again takes the usual boot time."},
            safety={"verdict": SAFE, "reversible": True, "checks": [
                check("VM is not running", CHECK_PASS, "power state 'VM stopped'")],
                "preconditions": ["If it holds a dynamic public IP something depends on, "
                                  "make the IP static first."]},
            data_sources=[data_source("state", "Power state", True, "Azure compute API"),
                          billing_source(ctx)],
        )

    sav = billed_savings(ctx, what="its attached volumes", resources=vols, include_self=False)
    if sav is None and ctx.provider == OCI:
        lines, total, cur = [], 0.0, None
        for v in vols:
            gb, vpu = _volume_gb(v), cfg_num(v.config or {}, "vpus_per_gb")
            amt, ls = ctx.prices.oci_volume_monthly(gb, vpu, label=v.resource_name)
            if amt is None:
                lines = []
                break
            total += amt
            lines += ls
        if lines:
            sav = Savings(method=SAVINGS_LIST_PRICE, amount=round(total, 2),
                          currency=ctx.prices.currency,
                          basis=("OCI public price list: block storage capacity plus performance "
                                 "units at each volume's own VPU setting, pay-as-you-go."),
                          breakdown=lines,
                          assumptions=["The volumes are deleted with the instance."])
    if sav is None:
        sav = no_savings(ctx.prices.billing_gap(ctx.provider) if ctx.provider != OCI
                         else "Neither per-volume billing nor volume sizes were available.")

    lb_ips = ((ctx.catalogs or {}).get("lb_backend_ips") or {})
    ip = ctx.config.get("private_ip")
    lb_hits = lb_ips.get(ip) if ip else None
    checks = [check("Instance is stopped", CHECK_PASS, getattr(ctx.resource, "status", None) or power),
              check("Attached volumes identified", CHECK_PASS if vols else CHECK_UNKNOWN,
                    f"{len(vols)} volume(s)" if vols else "No attachment records in the inventory"),
              check("A backup of its volumes exists", CHECK_UNKNOWN,
                    "Backups are not collected, so this cannot be confirmed here.")]
    if ip:
        checks.append(check("Not a load-balancer backend",
                            CHECK_FAIL if lb_hits else CHECK_PASS,
                            f"still a backend of {', '.join(lb_hits)}" if lb_hits
                            else f"{ip} is not a backend of any load balancer in the inventory"))
    return Outcome(
        verdict=FINDING, severity=MEDIUM, signal=SIG_UNUSED,
        detail=(f"Stopped, with {len(vols)} attached volume(s)"
                + (f" totalling {total_gb:,.0f} GB" if vols else "") + " still billing."),
        recommendation=("If it is no longer needed, back up its volumes and terminate it "
                        "together with them. If it is needed occasionally, keep it — but its "
                        "storage bills for every hour it exists."),
        evidence=ev + [billed_evidence(ctx, "Instance billed cost, last 30 days")],
        current=_current_config(ctx, capacity(ctx)),
        recommended={"Action": "Terminate with its volumes (after a backup)"},
        savings=sav,
        confidence=CONF_HIGH,
        confidence_reasons=["The provider reports the stopped state and the attachments."],
        risk=RISK_HIGH,
        risk_notes=["Terminating deletes the boot volume, and any attached volume selected for "
                    "deletion. Only a backup makes it recoverable."],
        impact={"cost": "Ends the storage charge for its volumes.",
                "performance": "None — it is not running.",
                "availability": "Anything that expects to start this instance later will fail."},
        safety={"verdict": CONFIRM_FIRST, "reversible": False, "checks": checks,
                "preconditions": ["Take a backup of each attached volume.",
                                  "Confirm with the owner that it is not a cold standby."]},
        data_sources=[data_source("state", "Instance state", True, "Provider compute API"),
                      data_source("attachments", "Attached volumes", bool(vols),
                                  f"{len(vols)} found" if vols else "none recorded"),
                      billing_source(ctx)],
    )


# ── Rule: previous generation ────────────────────────────────────────────────

def _previous_generation(ctx: Ctx):
    size = ctx.config.get("instance_type") or ctx.config.get("vm_size") or ctx.config.get("shape")
    if not size:
        return insufficient("The instance size was not collected.")
    current_gen = None
    note = None
    if ctx.provider == AWS:
        family = size.split(".")[0]
        if family not in _AWS_PREVIOUS:
            return clear(f"{size} is a current-generation type.")
        current_gen = {
            "t": "t3, or the Graviton t4g", "m": "m6i/m7i, or the Graviton m7g",
            "c": "c6i/c7i, or the Graviton c7g", "r": "r6i/r7i, or the Graviton r7g",
            "i": "i4i", "d": "d3", "x": "x2idn", "g": "g5/g6", "p": "p4d/p5",
        }.get(family[0], "its current-generation family") + " with the same vCPU and memory"
    elif ctx.provider == AZURE:
        low = size.lower()
        version = next((int(p[1:]) for p in low.split("_") if p.startswith("v") and p[1:].isdigit()), None)
        if version is None and not low.startswith(("standard_a", "standard_b")):
            return clear(f"{size} has no version suffix to judge.")
        if version is not None and version >= 5:
            return clear(f"{size} is a v{version} (current) size.")
        current_gen = "the v5 or v6 size with the same vCPU and memory"
    else:
        s = size.upper()
        if s.startswith(("VM.STANDARD2.", "BM.STANDARD2.", "VM.STANDARD1.", "VM.STANDARD.E2.")):
            current_gen = "VM.Standard.E5.Flex or VM.Standard3.Flex with the same OCPU and memory"
        elif s.startswith("VM.STANDARD.E3."):
            current_gen = "VM.Standard.E5.Flex (or E4.Flex) with the same OCPU and memory"
        else:
            return clear(f"{size} is a current shape.")

    savings = no_savings("The current-generation equivalent is not priced automatically for "
                         "this size; compare list prices for the specific target before migrating.")
    if ctx.provider == OCI and size.upper().startswith("VM.STANDARD2."):
        x7 = ctx.prices.oci_part("B88514")
        ocpus, mem = cfg_num(ctx.config, "ocpus"), cfg_num(ctx.config, "memory_gb")
        new = ctx.prices.oci_flex_hourly("VM.Standard.E4.Flex", ocpus, mem) if ocpus and mem else None
        if x7 and "X7" in (x7.get("display_name") or "") and new and ocpus:
            cur_hourly = ocpus * x7["value"]
            diff = cur_hourly - new[0]
            if diff > 0:
                savings = Savings(
                    method=SAVINGS_LIST_PRICE, amount=round(diff * HOURS_PER_MONTH, 2),
                    currency=x7["currency"],
                    basis=("OCI public price list: X7 OCPU-hour (memory included) against "
                           "VM.Standard.E4.Flex OCPU-hour and GB-hour for the same OCPU and "
                           f"memory, × {HOURS_PER_MONTH} hours."),
                    breakdown=[{"component": f"Current · {x7['display_name']} ({x7['part']})",
                                "quantity": ocpus, "unit": "OCPU-hour", "unit_price": x7["value"],
                                "hourly_cost": round(cur_hourly, 4)}]
                              + [{**l, "component": f"E4.Flex · {l['component']}"} for l in new[1]],
                    assumptions=[f"Same {ocpus:g} OCPU and {mem:g} GiB on VM.Standard.E4.Flex.",
                                 f"{HOURS_PER_MONTH} hours per month."])
            else:
                savings = no_savings("At list price the current-generation equivalent costs the "
                                     "same or more; the benefit is performance and support life.")
        note = "Standard2 (X7) shapes predate OCI's Flex shapes."
    return Outcome(
        verdict=FINDING, severity=LOW, signal=SIG_CONFIGURATION,
        detail=f"{size} is a previous-generation size." + (f" {note}" if note else ""),
        recommendation=f"Plan a move to {current_gen}.",
        evidence=[evidence("Size", size, kind=EV_CONFIGURATION, source="Provider compute API")],
        current={"Size": size},
        recommended={"Target": current_gen},
        savings=savings,
        confidence=CONF_HIGH if savings.priced else CONF_MEDIUM,
        confidence_reasons=["The size is reported by the provider; its generation is published."],
        risk=RISK_MEDIUM,
        risk_notes=["A generation change can need new drivers or an image update; test first."],
        impact={"cost": "Usually a better price/performance ratio.",
                "performance": "Newer processors; validate the workload.",
                "availability": "Requires a stop/start or a rebuild."},
        safety={"verdict": WITH_CARE, "reversible": True, "checks": [],
                "preconditions": ["Test the workload on the new generation first."]},
        data_sources=[data_source("configuration", "Instance size", True, "Provider compute API")],
    )


RULES = [
    Rule(
        rule_id="COMPUTE_UNDERUTILIZED", version="1.0", providers=(AWS, AZURE, OCI),
        resource_types=COMPUTE_TYPES, category=RIGHTSIZING, severity=MEDIUM,
        signal=SIG_UNDERUTILIZED,
        title="Compute resource appears underutilized",
        description="Running compute whose measured CPU (and memory, where published) stays "
                    "well below its capacity for the last 30 days.",
        rationale="Compute is billed for its provisioned size whether or not it is used. A size "
                  "that is consistently far larger than its load is paid for continuously.",
        remediation={
            OCI: "OCI console → Compute → Instances → Edit → Edit shape → set OCPUs and memory. "
                 "The instance restarts.",
            AZURE: "Azure portal → VM → Size → choose the size → Resize. The VM restarts.",
            AWS: "Stop the instance, change its instance type, and start it again.",
        },
        risk=RISK_MEDIUM, effort="MEDIUM", evaluate=_underutilized,
        metrics=("cpu_percent", "memory_percent", "network_in", "network_out"),
        supersedes=(),
    ),
    Rule(
        rule_id="COMPUTE_CPU_CONSTRAINED", version="1.0", providers=(AWS, AZURE, OCI),
        resource_types=COMPUTE_TYPES, category=PERFORMANCE, severity=MEDIUM,
        signal=SIG_CONSTRAINED, title="Compute resource is CPU-constrained",
        description="CPU P95 at or above 90% over the last 30 days.",
        rationale="Sustained CPU saturation queues work: response times climb before anything "
                  "fails outright.",
        remediation={"*": "Find the process responsible; if the load is legitimate, move to a "
                          "larger size or add instances behind the load balancer."},
        risk=RISK_MEDIUM, effort="MEDIUM", evaluate=_constrained("cpu_percent", "cpu"),
        metrics=("cpu_percent",),
    ),
    Rule(
        rule_id="COMPUTE_MEMORY_CONSTRAINED", version="1.0", providers=(AWS, AZURE, OCI),
        resource_types=COMPUTE_TYPES, category=PERFORMANCE, severity=MEDIUM,
        signal=SIG_CONSTRAINED, title="Compute resource is memory-constrained",
        description="Memory P95 at or above 90% over the last 30 days.",
        rationale="At sustained high memory use the operating system swaps or kills processes; "
                  "the failure looks like random slowness or restarts.",
        remediation={"*": "Check for a leak; if the working set is legitimate, add memory "
                          "(OCI Flex: raise memory alone) or move to a larger size."},
        risk=RISK_MEDIUM, effort="MEDIUM", evaluate=_constrained("memory_percent", "memory"),
        metrics=("memory_percent",),
    ),
    Rule(
        rule_id="COMPUTE_STOPPED_STILL_BILLING", version="1.0", providers=(AWS, AZURE, OCI),
        resource_types=COMPUTE_TYPES, category=CLEANUP, severity=MEDIUM, signal=SIG_UNUSED,
        title="Stopped instance still bills its storage",
        description="A stopped instance whose volumes — or, on Azure, whose compute when it is "
                    "not deallocated — keep billing.",
        rationale="Stopping ends compute billing (except an Azure VM that is only shut down), "
                  "but every attached volume keeps billing for as long as it exists.",
        remediation={
            OCI: "OCI console → Compute → Instances → Terminate, ticking 'permanently delete the "
                 "attached boot volume' once a backup exists.",
            AZURE: "Azure portal → VM → Delete, choosing to delete its disks, once snapshots exist.",
            AWS: "EC2 console → snapshot each attached volume → Terminate the instance.",
        },
        risk=RISK_HIGH, effort="LOW", evaluate=_stopped,
        supersedes=("Terminate Stopped EC2 Instance", "Stopped OCI Compute Instance"),
    ),
    Rule(
        rule_id="COMPUTE_PREVIOUS_GENERATION", version="1.0", providers=(AWS, AZURE, OCI),
        resource_types=COMPUTE_TYPES, category=CONFIGURATION, severity=LOW,
        signal=SIG_CONFIGURATION, title="Previous-generation compute size",
        description="The instance uses a size family the provider has superseded.",
        rationale="Previous generations usually cost more per unit of performance, and are the "
                  "first to lose capacity and support.",
        remediation={"*": "Move to the current-generation size with the same vCPU/OCPU and "
                          "memory during a planned window."},
        risk=RISK_MEDIUM, effort="MEDIUM", evaluate=_previous_generation,
        supersedes=("Upgrade Legacy EC2 Generation",),
    ),
]
