"""Serverless rules: invocation, errors, throttling, timeouts, memory.

"Not invoked" is concluded only from a query that SUCCEEDED and returned no
invocation datapoints. Both Lambda and OCI Functions publish invocation counts
only for periods in which the function ran, so that is how each provider says
"nothing ran". A query that failed, or that the credentials may not run, is
INSUFFICIENT_DATA — never "not invoked".

Memory over-allocation is declared but can never produce a finding: the memory
a Lambda invocation actually used is only in its REPORT log line (or Lambda
Insights), which is not collected. The rule exists so the coverage panel says
so, instead of the old Cost-tab rule flagging any function over 1 GB.
"""
from __future__ import annotations

from app.optimization.model import (
    AWS, CHECK_PASS, CLEANUP, CONF_HIGH, CONF_MEDIUM, EV_CONFIGURATION, EV_DERIVED, FINDING,
    HIGH, INFO, LOW, MEDIUM, OCI, PERFORMANCE, RELIABILITY, RIGHTSIZING, RISK_LOW,
    RISK_MEDIUM, SAFE, WITH_CARE, check, data_source, evidence, no_savings,
)
from app.optimization.rules.base import (
    SIG_CONFIGURATION, SIG_CONSTRAINED, SIG_RISK, SIG_UNUSED, Ctx, Outcome, Rule,
    cfg_num, clear, insufficient, metric_evidence, metric_source, not_applicable,
)
from app.optimization.telemetry import ST_NO_DATA

FUNCTION_TYPES = ("LambdaFunction", "Function")


def _timeout_ms(ctx: Ctx):
    s = cfg_num(ctx.config, "timeout_s")
    if s is None:
        s = cfg_num(ctx.config, "timeout_in_seconds")
    return s * 1000.0 if s is not None else None


def _memory_mb(ctx: Ctx):
    m = cfg_num(ctx.config, "memory_mb")
    return m if m is not None else cfg_num(ctx.config, "memory_in_mbs")


def _not_invoked(ctx: Ctx):
    res = ctx.telemetry.result("invocations")
    sources = [metric_source(ctx, "invocations", "30-day invocation count")]
    if res.status == ST_NO_DATA:
        pass
    elif res.ok:
        if (res.get("total") or 0) > 0:
            return clear(f"{res.get('total'):,.0f} invocations in the last 30 days.")
    else:
        return insufficient(ctx.telemetry.reason("invocations"), data_sources=sources)
    return Outcome(
        verdict=FINDING, severity=LOW, signal=SIG_UNUSED,
        title="Function was not invoked in 30 days",
        detail="No invocation was recorded by the provider's monitoring in the last 30 days.",
        recommendation=("Confirm the function is still needed; delete it if not. Check its "
                        "triggers first — a monthly or yearly schedule would not show in 30 days."),
        evidence=[evidence("Invocations, 30 days", 0, display="0 (no datapoints)",
                           kind="telemetry", source=res.source, detail=res.reason),
                  evidence("Runtime", ctx.config.get("runtime") or ctx.config.get("image"),
                           kind=EV_CONFIGURATION),
                  evidence("Event sources", len(ctx.config.get("event_source_arns") or []),
                           kind=EV_CONFIGURATION)],
        current={"Invocations, 30 days": "0", "Memory": f"{_memory_mb(ctx):g} MB" if _memory_mb(ctx) else None},
        recommended={"Action": "Delete if unused"},
        savings=no_savings("An uninvoked function incurs no compute charge — both Lambda and OCI "
                           "Functions bill per invocation and duration. The benefit is a smaller "
                           "attack surface and less to maintain."),
        confidence=CONF_HIGH if ctx.provider == AWS else CONF_MEDIUM,
        confidence_reasons=["The monitoring query succeeded and returned no invocation datapoints."],
        risk=RISK_LOW, risk_notes=["A rarely-scheduled job (monthly, yearly) would be lost."],
        impact={"cost": "None directly.", "performance": "None.",
                "availability": "Anything that calls it later will fail."},
        safety={"verdict": WITH_CARE, "reversible": False, "checks": [
            check("No invocations for 30 days", CHECK_PASS)],
            "preconditions": ["Check its triggers and schedules for anything less frequent than monthly."]},
        data_sources=sources,
    )


def _error_rate(ctx: Ctx):
    inv = ctx.telemetry.stat("invocations", "total")
    if ctx.telemetry.result("invocations").status == ST_NO_DATA:
        return not_applicable("The function was not invoked in the window, so it has no error rate.")
    if not ctx.telemetry.ok("invocations"):
        return insufficient(ctx.telemetry.reason("invocations") or "Invocations not collected.")
    if not ctx.telemetry.ok("errors"):
        if ctx.telemetry.result("errors").status == ST_NO_DATA:
            return clear("No errors recorded.")
        return insufficient(ctx.telemetry.reason("errors"))
    errors = ctx.telemetry.stat("errors", "total") or 0.0
    th = ctx.thresholds
    if not inv or inv < th["function_min_invocations"]:
        return not_applicable(f"Fewer than {th['function_min_invocations']:g} invocations — too "
                              "few for an error rate to mean much.")
    rate = 100.0 * errors / inv
    if rate < th["function_error_rate_pct"]:
        return clear(f"Error rate {rate:.2f}%.")
    return Outcome(
        verdict=FINDING, severity=HIGH if rate >= 25 else MEDIUM, signal=SIG_RISK,
        title="Function has a high error rate",
        detail=f"{errors:,.0f} errors in {inv:,.0f} invocations ({rate:.1f}%) over 30 days.",
        recommendation="Read the function's error logs for the failing invocations, and add a "
                       "dead-letter destination so failed events are not lost.",
        evidence=[metric_evidence(ctx, "invocations", "total", "Invocations, 30 days"),
                  metric_evidence(ctx, "errors", "total", "Errors, 30 days"),
                  evidence("Error rate", round(rate, 2), unit="percent", display=f"{rate:.1f}%",
                           kind=EV_DERIVED, source="errors / invocations")],
        current={"Error rate": f"{rate:.1f}%"},
        savings=no_savings("A reliability recommendation, not a saving."),
        confidence=CONF_HIGH, confidence_reasons=["Both counts are published by the provider."],
        risk=RISK_LOW, risk_notes=[],
        impact={"cost": "Failed invocations are still billed.", "performance": "None.",
                "availability": "Every error is a request or event that did not complete."},
        safety={"verdict": SAFE, "reversible": True, "checks": [], "preconditions": []},
        data_sources=[metric_source(ctx, "invocations", "Invocations"),
                      metric_source(ctx, "errors", "Errors")],
    )


def _throttled(ctx: Ctx):
    res = ctx.telemetry.result("throttles")
    if res.status == ST_NO_DATA:
        return clear("No throttling recorded.")
    if not res.ok:
        return insufficient(ctx.telemetry.reason("throttles"))
    total = res.get("total") or 0.0
    if total <= 0:
        return clear("No throttling recorded.")
    return Outcome(
        verdict=FINDING, severity=MEDIUM, signal=SIG_CONSTRAINED,
        title="Function invocations are being throttled",
        detail=f"{total:,.0f} invocation requests throttled in 30 days.",
        recommendation="Raise the function's reserved concurrency (or the account limit), or smooth "
                       "the upstream burst with a queue.",
        evidence=[metric_evidence(ctx, "throttles", "total", "Throttles, 30 days"),
                  metric_evidence(ctx, "invocations", "total", "Invocations, 30 days")],
        current={"Throttles, 30 days": f"{total:,.0f}"},
        savings=no_savings("A performance recommendation, not a saving."),
        confidence=CONF_HIGH, confidence_reasons=["Throttles are counted by Lambda."],
        risk=RISK_LOW, risk_notes=["More concurrency can overload a downstream database."],
        impact={"cost": "None directly.", "performance": "Fewer rejected invocations.",
                "availability": "Synchronous callers see throttling errors today."},
        safety={"verdict": WITH_CARE, "reversible": True, "checks": [], "preconditions": [
            "Check what the function calls can take the extra concurrency."]},
        data_sources=[metric_source(ctx, "throttles", "Throttles")],
    )


def _near_timeout(ctx: Ctx):
    timeout = _timeout_ms(ctx)
    if timeout is None:
        return insufficient("The function's timeout was not collected.")
    if not ctx.telemetry.ok("duration_ms"):
        if ctx.telemetry.result("duration_ms").status == ST_NO_DATA:
            return not_applicable("The function did not run in the window.")
        return insufficient(ctx.telemetry.reason("duration_ms"))
    peak = ctx.telemetry.stat("duration_ms", "peak")
    share = 100.0 * peak / timeout if peak is not None else None
    if share is None or share < ctx.thresholds["function_timeout_margin_pct"]:
        return clear(f"Longest invocation used {share or 0:.0f}% of the timeout.")
    return Outcome(
        verdict=FINDING, severity=MEDIUM, signal=SIG_CONSTRAINED,
        title="Function runs close to its timeout",
        detail=f"Longest invocation took {peak:,.0f} ms of a {timeout:,.0f} ms timeout ({share:.0f}%).",
        recommendation="Find what makes the slow invocations slow; raise the timeout only once "
                       "that is understood, or the failures just take longer.",
        evidence=[metric_evidence(ctx, "duration_ms", "avg", "Duration, average"),
                  metric_evidence(ctx, "duration_ms", "peak", "Duration, peak"),
                  evidence("Timeout", timeout, unit="ms", display=f"{timeout:,.0f} ms",
                           kind=EV_CONFIGURATION)],
        current={"Timeout": f"{timeout / 1000:g} s", "Peak duration": f"{peak:,.0f} ms"},
        savings=no_savings("A reliability recommendation, not a saving."),
        confidence=CONF_HIGH, confidence_reasons=["Duration is measured by the provider."],
        risk=RISK_LOW, risk_notes=[],
        impact={"cost": "Timed-out invocations are billed for their full duration.",
                "performance": "Slow invocations.", "availability": "Invocations past the timeout fail."},
        safety={"verdict": SAFE, "reversible": True, "checks": [], "preconditions": []},
        data_sources=[metric_source(ctx, "duration_ms", "Duration")],
    )


def _memory_unmeasured(ctx: Ctx):
    mem = _memory_mb(ctx)
    if mem is None or mem < 1024:
        return not_applicable("Memory allocation under 1 GB.")
    return insufficient(
        f"{mem:g} MB is allocated, but the memory an invocation actually uses is only reported "
        "in its log line (or by Lambda Insights), which is not collected — so whether it is "
        "over-allocated cannot be measured.",
        data_sources=[data_source("memory_used", "Memory used per invocation", False,
                                  "Not published as a metric by the provider")])


RULES = [
    Rule(rule_id="FUNCTION_NOT_INVOKED", version="1.0", providers=(AWS, OCI),
         resource_types=FUNCTION_TYPES, category=CLEANUP, severity=LOW, signal=SIG_UNUSED,
         title="Function was not invoked in 30 days",
         description="No invocation datapoints in 30 days from a query that succeeded.",
         rationale="Unused functions are code, permissions and triggers nobody maintains.",
         remediation={AWS: "Lambda console → Functions → select → Actions → Delete.",
                      OCI: "OCI console → Functions → Applications → function → Delete."},
         risk=RISK_LOW, effort="LOW", evaluate=_not_invoked, metrics=("invocations",)),
    Rule(rule_id="FUNCTION_HIGH_ERROR_RATE", version="1.0", providers=(AWS,),
         resource_types=("LambdaFunction",), category=RELIABILITY, severity=MEDIUM,
         signal=SIG_RISK, title="Function has a high error rate",
         description="Errors at or above 5% of at least 100 invocations in 30 days.",
         rationale="Each error is an event or request that did not complete — and is still billed.",
         remediation={AWS: "CloudWatch Logs → the function's log group → filter for ERROR."},
         risk=RISK_LOW, effort="MEDIUM", evaluate=_error_rate, metrics=("invocations", "errors")),
    Rule(rule_id="FUNCTION_THROTTLED", version="1.0", providers=(AWS,),
         resource_types=("LambdaFunction",), category=PERFORMANCE, severity=MEDIUM,
         signal=SIG_CONSTRAINED, title="Function invocations are being throttled",
         description="Invocation requests refused for concurrency in 30 days.",
         rationale="Throttled synchronous invocations fail; throttled asynchronous ones are delayed.",
         remediation={AWS: "Lambda console → function → Configuration → Concurrency."},
         risk=RISK_LOW, effort="LOW", evaluate=_throttled, metrics=("throttles", "invocations")),
    Rule(rule_id="FUNCTION_NEAR_TIMEOUT", version="1.0", providers=(AWS, OCI),
         resource_types=FUNCTION_TYPES, category=PERFORMANCE, severity=MEDIUM,
         signal=SIG_CONSTRAINED, title="Function runs close to its timeout",
         description="The longest measured invocation used 90% or more of the configured timeout.",
         rationale="An invocation that reaches its timeout fails and is billed for the full duration.",
         remediation={"*": "Profile the slow path, then adjust the timeout deliberately."},
         risk=RISK_LOW, effort="MEDIUM", evaluate=_near_timeout, metrics=("duration_ms",)),
    Rule(rule_id="FUNCTION_MEMORY_UNMEASURED", version="1.0", providers=(AWS,),
         resource_types=("LambdaFunction",), category=RIGHTSIZING, severity=INFO,
         signal=SIG_CONFIGURATION, title="Function memory allocation cannot be judged",
         description="Large memory allocations, where the memory actually used is not published.",
         rationale="Lambda bills memory × duration, but it scales CPU with memory too, so reducing "
                   "memory without measuring it can make a function slower and cost more.",
         remediation={AWS: "Enable Lambda Insights, or read Max Memory Used from REPORT log lines."},
         risk=RISK_MEDIUM, effort="MEDIUM", evaluate=_memory_unmeasured,
         supersedes=("Review Lambda Memory Size",)),
]
