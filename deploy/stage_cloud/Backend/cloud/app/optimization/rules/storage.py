"""Storage rules: volumes, disks and buckets.

What these rules deliberately do NOT claim: how full a volume is. Guest
filesystem usage is not published by any of the three block-storage services —
it needs an agent inside the instance — so "500 GB provisioned, 72 GB used"
cannot be measured here and no "oversized volume" finding is produced. The
coverage panel lists that gap rather than filling it.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.optimization.model import (
    AWS, AZURE, CHECK_PASS, CHECK_UNKNOWN, CLEANUP, CONF_HIGH, CONF_MEDIUM, CONFIRM_FIRST,
    EV_CONFIGURATION, EV_DERIVED, FINDING, LOW, MEDIUM, OCI, RISK_HIGH, RISK_LOW,
    RISK_MEDIUM, SAFE, SAVINGS_LIST_PRICE, STORAGE, WITH_CARE, Savings, check, data_source,
    evidence, no_savings,
)
from app.optimization.rules.base import (
    SIG_CONFIGURATION, SIG_UNDERUTILIZED, SIG_UNUSED, Ctx, Outcome, Rule, age_days,
    billed_evidence, billed_savings, billing_source, cfg_num, clear, insufficient,
    metric_evidence, metric_source, money, not_applicable, telemetry_gate,
)
from app.optimization.telemetry import display, human_bytes

VOLUME_TYPES = ("BlockVolume", "BootVolume", "ManagedDisk", "EBSVolume")
BUCKET_TYPES = ("S3Bucket", "ObjectStorageBucket")
BALANCED_VPU = 10


def attachment(ctx: Ctx) -> Optional[str]:
    """ATTACHED / UNATTACHED, or None when the inventory does not say."""
    state = (getattr(ctx.resource, "attachment_state", None) or "").upper()
    if state in ("ATTACHED", "UNATTACHED"):
        return state
    cfg = ctx.config
    if ctx.provider == AZURE:
        ds = (cfg.get("disk_state") or "").lower()
        if not ds:
            return None
        return "UNATTACHED" if ds == "unattached" else "ATTACHED"
    st = (cfg.get("attachment_status") or "").lower()
    if st in ("attached", "attaching"):
        return "ATTACHED"
    if st in ("unattached", "detached", "available"):
        return "UNATTACHED"
    return None


def _size_gb(ctx: Ctx) -> Optional[float]:
    return cfg_num(ctx.config, "size_gb") if cfg_num(ctx.config, "size_gb") is not None \
        else cfg_num(ctx.config, "disk_size_gb")


def _perf_label(ctx: Ctx) -> Optional[str]:
    cfg = ctx.config
    if ctx.provider == OCI and cfg_num(cfg, "vpus_per_gb") is not None:
        vpu = cfg_num(cfg, "vpus_per_gb")
        tier = {0: "Lower Cost", 10: "Balanced", 20: "Higher Performance"}.get(int(vpu), "Ultra High Performance")
        return f"{tier} ({vpu:g} VPU/GB)"
    if ctx.provider == AZURE:
        return cfg.get("sku")
    if ctx.provider == AWS:
        return " ".join(str(x) for x in (cfg.get("volume_type"), f"{cfg.get('iops')} IOPS"
                                         if cfg.get("iops") else None) if x)
    return None


def _last_attached(ctx: Ctx) -> Optional[Dict[str, Any]]:
    hits = [h for h in ctx.history if (h.get("field") or "") in ("attached_to_name", "attached_to_id")
            and h.get("old") and not h.get("new")]
    return max(hits, key=lambda h: h.get("at") or "") if hits else None


# ── Unattached volume ────────────────────────────────────────────────────────

def _unattached(ctx: Ctx):
    state = attachment(ctx)
    if state is None:
        return insufficient("The inventory does not record whether this volume is attached.",
                            data_sources=[data_source("attachment", "Attachment state", False,
                                                      "not collected for this resource")])
    if state == "ATTACHED":
        return clear("The volume is attached.")
    gb = _size_gb(ctx)
    age = age_days(ctx)
    last = _last_attached(ctx)
    ev = [
        evidence("Attachment", "Unattached", kind=EV_CONFIGURATION, source="Provider storage API"),
        evidence("Provisioned size", gb, unit="GB", display=f"{gb:,.0f} GB" if gb else "N/A",
                 kind=EV_CONFIGURATION),
        evidence("Performance", _perf_label(ctx), kind=EV_CONFIGURATION),
        evidence("Age", age, display=f"{age:,.0f} days" if age is not None else "N/A",
                 kind=EV_CONFIGURATION, detail=None if age is not None else "Creation time not reported."),
    ]
    if last:
        ev.append(evidence("Last attached to", last.get("old"), kind=EV_CONFIGURATION,
                           source="Config Drift log", detail=f"detached by {last.get('at')}"))
    ev.append(billed_evidence(ctx))

    sav = billed_savings(ctx, what="this volume")
    alt = None
    if ctx.provider == OCI:
        vpu = cfg_num(ctx.config, "vpus_per_gb")
        if sav is None:
            amt, lines = ctx.prices.oci_volume_monthly(gb, vpu, label=ctx.resource.resource_name)
            if amt is not None:
                sav = Savings(method=SAVINGS_LIST_PRICE, amount=amt, currency=ctx.prices.currency,
                              basis=("OCI public price list: block storage capacity plus "
                                     f"performance units at {vpu:g} VPU/GB, pay-as-you-go."),
                              breakdown=lines)
        if vpu and ctx.config.get("is_auto_tune_enabled") is False and gb:
            perf = ctx.prices.oci_perf_monthly(gb, vpu)
            if perf:
                alt = (f"If it must be kept, enabling detached-volume auto-tune drops it to the "
                       f"Lower Cost tier while detached, saving about {money(perf, ctx.prices.currency)} "
                       "a month of performance charges at list price.")
    if sav is None:
        sav = no_savings(ctx.prices.billing_gap(ctx.provider))

    kind = "boot volume" if ctx.resource.resource_type == "BootVolume" else "volume"
    rec = (f"Delete the {kind} if it is no longer needed, after taking a backup. "
           + ("A boot volume left behind usually belongs to a terminated instance. "
              if kind == "boot volume" else "")
           + (alt or "")).strip()
    return Outcome(
        verdict=FINDING, severity=MEDIUM, signal=SIG_UNUSED,
        detail=f"Not attached to any instance{f'; {gb:,.0f} GB' if gb else ''}.",
        recommendation=rec,
        evidence=ev,
        current={"Size": f"{gb:,.0f} GB" if gb else None, "Performance": _perf_label(ctx),
                 "Attachment": "Unattached"},
        recommended={"Action": "Back up, then delete"},
        savings=sav,
        confidence=CONF_HIGH,
        confidence_reasons=["The provider reports the volume as not attached to anything."],
        risk=RISK_HIGH,
        risk_notes=["Deleting a volume is irreversible without a backup."],
        impact={"cost": "Ends the volume's storage charge.",
                "performance": "None — nothing reads from it.",
                "availability": "Anything that expects to re-attach it will fail."},
        safety={"verdict": CONFIRM_FIRST, "reversible": False, "checks": [
            check("Not attached to any instance", CHECK_PASS),
            check("A backup exists", CHECK_UNKNOWN,
                  "Backups are not collected, so this cannot be confirmed here."),
        ], "preconditions": ["Take a backup (it bills at a lower backup rate).",
                             "Confirm with the owner that it is not kept for a rebuild."]},
        data_sources=[data_source("attachment", "Attachment state", True, "Provider storage API"),
                      data_source("size", "Provisioned size", gb is not None),
                      billing_source(ctx)],
    )


# ── Attached volume with no I/O ──────────────────────────────────────────────

def _no_io(ctx: Ctx):
    if attachment(ctx) != "ATTACHED":
        return not_applicable("The volume is not attached.")
    host = (ctx.config.get("attached_to_status") or "").upper()
    if "STOP" in host or "DEALLOC" in host:
        return not_applicable("Its instance is stopped; the stopped-instance finding covers it.")
    sources = [metric_source(ctx, "volume_read_ops", "30-day read operations"),
               metric_source(ctx, "volume_write_ops", "30-day write operations"), billing_source(ctx)]
    for m in ("volume_read_ops", "volume_write_ops"):
        ok, why = telemetry_gate(ctx, m)
        if not ok:
            return insufficient(why, data_sources=sources)
    reads = ctx.telemetry.stat("volume_read_ops", "total") or 0.0
    writes = ctx.telemetry.stat("volume_write_ops", "total") or 0.0
    if reads > 0 or writes > 0:
        return clear(f"{reads + writes:,.0f} I/O operations in the window.")
    sav = billed_savings(ctx, what="this volume")
    if sav is None and ctx.provider == OCI:
        amt, lines = ctx.prices.oci_volume_monthly(_size_gb(ctx), cfg_num(ctx.config, "vpus_per_gb"),
                                                   label=ctx.resource.resource_name)
        if amt is not None:
            sav = Savings(method=SAVINGS_LIST_PRICE, amount=amt, currency=ctx.prices.currency,
                          basis="OCI public price list: capacity plus performance units.",
                          breakdown=lines)
    return Outcome(
        verdict=FINDING, severity=LOW, signal=SIG_UNUSED,
        detail=f"Attached to {ctx.config.get('attached_to_name') or 'an instance'} with zero reads "
               "and zero writes in 30 days.",
        recommendation="Confirm the volume is still needed; if not, detach it, back it up and delete it.",
        evidence=[metric_evidence(ctx, "volume_read_ops", "total", "Read operations, 30 days"),
                  metric_evidence(ctx, "volume_write_ops", "total", "Write operations, 30 days"),
                  evidence("Attached to", ctx.config.get("attached_to_name"), kind=EV_CONFIGURATION),
                  billed_evidence(ctx)],
        current={"Size": f"{_size_gb(ctx):,.0f} GB" if _size_gb(ctx) else None,
                 "Attached to": ctx.config.get("attached_to_name")},
        savings=sav or no_savings(ctx.prices.billing_gap(ctx.provider)),
        confidence=CONF_MEDIUM,
        confidence_reasons=["Zero I/O was measured for 30 days, but a volume can hold data that "
                            "is read rarely (an archive, a restore target)."],
        risk=RISK_HIGH, risk_notes=["Deleting a volume is irreversible without a backup."],
        impact={"cost": "Ends the volume's storage charge if deleted.",
                "performance": "None measured.", "availability": "Unmount it cleanly first."},
        safety={"verdict": CONFIRM_FIRST, "reversible": False, "checks": [
            check("No I/O for 30 days", CHECK_PASS)],
            "preconditions": ["Check the mount inside the instance before detaching."]},
        data_sources=sources,
    )


# ── Performance tier above what is used ──────────────────────────────────────

def _performance_tier(ctx: Ctx):
    vpu = cfg_num(ctx.config, "vpus_per_gb")
    gb = _size_gb(ctx)
    if vpu is None or gb is None:
        return insufficient("The volume's performance setting or size was not collected.")
    if vpu <= BALANCED_VPU:
        return not_applicable("Already Balanced or lower.")
    if attachment(ctx) != "ATTACHED":
        return not_applicable("Unattached — the unattached-volume finding covers it.")
    sources = [metric_source(ctx, "volume_read_ops", "30-day read operations"),
               metric_source(ctx, "volume_write_ops", "30-day write operations")]
    for m in ("volume_read_ops", "volume_write_ops"):
        ok, why = telemetry_gate(ctx, m)
        if not ok:
            return insufficient(why, data_sources=sources)
    # Sum of the two P95s is an upper bound on the P95 of their sum.
    iops_p95 = ((ctx.telemetry.stat("volume_read_ops", "p95") or 0.0)
                + (ctx.telemetry.stat("volume_write_ops", "p95") or 0.0)) / 3600.0
    balanced_limit = min(60.0 * gb, 25000.0)
    if iops_p95 >= 0.5 * balanced_limit:
        return clear(f"Measured IOPS P95 ≈ {iops_p95:,.0f} needs more than half of Balanced's "
                     f"{balanced_limit:,.0f} IOPS.")
    perf = ctx.prices.oci_perf_monthly(gb, vpu - BALANCED_VPU)
    sav = (Savings(method=SAVINGS_LIST_PRICE, amount=perf, currency=ctx.prices.currency,
                   basis=(f"OCI public price list: performance units, {vpu - BALANCED_VPU:g} VPU/GB "
                          f"× {gb:,.0f} GB fewer at Balanced."),
                   breakdown=[{"component": "Performance units removed",
                               "quantity": (vpu - BALANCED_VPU) * gb, "unit": "VPU-GB-month",
                               "monthly_cost": perf}],
                   assumptions=["Throughput was not checked against Balanced's limit."])
           if perf else no_savings("The OCI performance-unit price was unavailable."))
    return Outcome(
        verdict=FINDING, severity=LOW, signal=SIG_UNDERUTILIZED,
        detail=f"{vpu:g} VPU/GB, measured IOPS P95 ≈ {iops_p95:,.0f} (Balanced allows "
               f"{balanced_limit:,.0f}).",
        recommendation="Change the volume's performance to Balanced (10 VPU/GB). The change is "
                       "online and can be reversed.",
        evidence=[evidence("Performance", _perf_label(ctx), kind=EV_CONFIGURATION),
                  evidence("Measured IOPS P95 (upper bound)", round(iops_p95, 1), unit="ops",
                           display=f"{iops_p95:,.1f} IOPS", kind=EV_DERIVED,
                           source="read + write operations P95 / 3600"),
                  evidence("Balanced limit for this size", balanced_limit, display=f"{balanced_limit:,.0f} IOPS",
                           kind=EV_DERIVED, source="60 IOPS/GB, max 25,000 (OCI Balanced)")],
        current={"Performance": _perf_label(ctx), "Size": f"{gb:,.0f} GB"},
        recommended={"Performance": "Balanced (10 VPU/GB)"},
        savings=sav, confidence=CONF_MEDIUM,
        confidence_reasons=["IOPS were measured; throughput was not compared."],
        risk=RISK_LOW, risk_notes=["If a batch job needs the higher tier briefly, it will run slower."],
        impact={"cost": "Lower performance-unit charge.",
                "performance": "Lower IOPS and throughput ceiling.",
                "availability": "None — the change is online."},
        safety={"verdict": SAFE, "reversible": True, "checks": [
            check("Measured IOPS far below the Balanced limit", CHECK_PASS)],
            "preconditions": []},
        data_sources=sources,
    )


# ── Buckets ──────────────────────────────────────────────────────────────────

def _lifecycle_state(ctx: Ctx) -> Optional[bool]:
    """True/False when a lifecycle policy is known to exist / not exist."""
    if ctx.provider == AWS:
        rules = ctx.config.get("lifecycle_rules")
        if rules is None:
            return None
        return bool(rules)
    res = ctx.telemetry.result("lifecycle_enabled")
    if not res.ok:
        return None
    return (res.get("max") or 0) >= 1


def _size_evidence(ctx: Ctx) -> List[Dict[str, Any]]:
    return [metric_evidence(ctx, "stored_bytes", "max", "Stored data"),
            metric_evidence(ctx, "object_count", "max", "Objects")]


def _no_lifecycle(ctx: Ctx):
    state = _lifecycle_state(ctx)
    if state is None:
        why = ("S3 did not report the bucket's lifecycle configuration." if ctx.provider == AWS
               else ctx.telemetry.reason("lifecycle_enabled") or "Lifecycle state not published.")
        return insufficient(why)
    if state:
        return clear("A lifecycle policy is enabled.")
    stored = ctx.telemetry.stat("stored_bytes", "max")
    return Outcome(
        verdict=FINDING, severity=LOW, signal=SIG_CONFIGURATION,
        detail="No lifecycle policy" + (f"; {human_bytes(stored)} stored" if stored else "") + ".",
        recommendation=("Add a lifecycle rule that moves objects older than your retention need "
                        "to a cheaper tier, and expires what never needs keeping."),
        evidence=[evidence("Lifecycle policy", "None", kind=EV_CONFIGURATION,
                           source=("S3 GetBucketLifecycleConfiguration" if ctx.provider == AWS
                                   else "OCI Monitoring · oci_objectstorage EnabledOLM"))]
                 + _size_evidence(ctx),
        current={"Lifecycle policy": "None"},
        recommended={"Lifecycle policy": "Transition, then expire, by age"},
        savings=no_savings("The saving depends on how old the objects are and how often they "
                           "are read, and neither is published per bucket by the provider."),
        confidence=CONF_HIGH, confidence_reasons=["The provider reports that no policy exists."],
        risk=RISK_MEDIUM, risk_notes=["Expiry is irreversible; colder tiers charge for retrieval "
                                      "and have minimum storage durations."],
        impact={"cost": "Lower storage cost for data that is not read.",
                "performance": "Retrieval from a cold tier is slower.",
                "availability": "Expired objects are gone."},
        safety={"verdict": WITH_CARE, "reversible": False, "checks": [],
                "preconditions": ["Agree retention with the data owner before adding expiry."]},
        data_sources=[data_source("lifecycle", "Lifecycle configuration", True),
                      metric_source(ctx, "stored_bytes", "Stored bytes", required=False)],
    )


# OCI's public price-list part for Object Storage (Standard tier) capacity,
# verified by its published name before use. Uncommitted multipart parts are
# stored — and billed — like any other object in the bucket's tier.
OCI_OBJECT_STORAGE_PART = "B91628"
OCI_OBJECT_STORAGE_NAME = "Object Storage - Storage"
GIB = 1024 ** 3


def _incomplete_uploads(ctx: Ctx):
    # OCI's UncommittedParts is "Incomplete MultiPart Upload Size", in BYTES —
    # the size of parts never committed or aborted, not a count of them.
    res = ctx.telemetry.result("uncommitted_parts")
    if not res.ok:
        return insufficient(ctx.telemetry.reason("uncommitted_parts"))
    daily = (res.stats or {}).get("daily") or []
    latest = daily[-1]["max"] if daily else res.get("max")
    if not latest:
        return clear("No incomplete multipart uploads are stored.")
    size = human_bytes(latest)
    tier = (ctx.config.get("storage_tier") or "").strip()
    part = ctx.prices.oci_part(OCI_OBJECT_STORAGE_PART)
    gib = latest / GIB
    if tier.lower() != "standard":
        savings = no_savings(
            f"The bucket's storage tier is {tier or 'not recorded'}; only the Standard tier's "
            "rate is priced here, so the storage these parts occupy is not valued.")
    elif not part or OCI_OBJECT_STORAGE_NAME not in (part.get("display_name") or ""):
        savings = no_savings("The OCI price list did not return the Object Storage capacity rate "
                             f"({OCI_OBJECT_STORAGE_PART}), so the storage is not valued.")
    else:
        savings = Savings(
            method=SAVINGS_LIST_PRICE, amount=round(gib * part["value"], 2),
            currency=part["currency"],
            basis=(f"OCI public price list, {part['display_name']} ({part['part']}), "
                   "pay-as-you-go per GB-month, × the size OCI reports for the incomplete "
                   "uploads on the latest day."),
            breakdown=[{"component": f"{size} of incomplete multipart uploads",
                        "quantity": round(gib, 2), "unit": "GB-month",
                        "unit_price": part["value"],
                        "monthly_cost": round(gib * part["value"], 2)}],
            assumptions=[
                "1 GB = 1,073,741,824 bytes. At 1,000,000,000 bytes the figure would be 7.4% higher.",
                "The tenancy's free Object Storage allowance is taken by its other data; this "
                "bucket's parts are billed at the paid rate." if part.get("free_tier") else
                "No free allowance applies to this part.",
                "The size is the latest day's; parts uploaded or aborted since change it.",
            ])
    return Outcome(
        verdict=FINDING, severity=LOW, signal=SIG_UNUSED,
        detail=f"{size} of incomplete multipart uploads stored on the latest day.",
        recommendation=("Abort the incomplete multipart uploads (oci os multipart abort), and add a "
                        "lifecycle rule that removes uncommitted parts after a few days."),
        evidence=[metric_evidence(ctx, "uncommitted_parts", "max", "Incomplete upload size")],
        current={"Incomplete multipart uploads": size, "Storage tier": tier or "N/A"},
        recommended={"Incomplete multipart uploads": "0 B, with an abort rule"},
        savings=savings,
        confidence=CONF_HIGH, confidence_reasons=["Reported by OCI Object Storage itself."],
        risk=RISK_LOW, risk_notes=["An upload still in progress would have to restart."],
        impact={"cost": "Stops billing for parts no object will ever use.",
                "performance": "None.", "availability": "None."},
        safety={"verdict": WITH_CARE, "reversible": False, "checks": [],
                "preconditions": ["Make sure no large upload is running at the time."]},
        data_sources=[metric_source(ctx, "uncommitted_parts", "Incomplete upload size")],
    )


def _versions_unbounded(ctx: Ctx):
    versioning = (ctx.config.get("versioning") or "").lower()
    if not versioning:
        return insufficient("The bucket's versioning state was not collected.")
    if versioning != "enabled":
        return not_applicable("Versioning is not enabled.")
    state = _lifecycle_state(ctx)
    if state is None:
        return insufficient("Whether a lifecycle policy exists is not known for this bucket.")
    if state:
        return clear("A lifecycle policy is enabled and can expire old versions.")
    return Outcome(
        verdict=FINDING, severity=LOW, signal=SIG_CONFIGURATION,
        detail="Versioning is enabled with no lifecycle policy, so every overwritten or deleted "
               "object's previous versions are kept — and billed — forever.",
        recommendation="Add a lifecycle rule that expires previous versions after your retention period.",
        evidence=[evidence("Versioning", "Enabled", kind=EV_CONFIGURATION),
                  evidence("Lifecycle policy", "None", kind=EV_CONFIGURATION)] + _size_evidence(ctx),
        current={"Versioning": "Enabled", "Lifecycle policy": "None"},
        recommended={"Lifecycle policy": "Expire previous versions after N days"},
        savings=no_savings("How much of the bucket is previous versions is not published by the provider."),
        confidence=CONF_HIGH, confidence_reasons=["Both settings are reported by the provider."],
        risk=RISK_MEDIUM, risk_notes=["Expired versions cannot be recovered."],
        impact={"cost": "Bounds the growth of version history.", "performance": "None.",
                "availability": "Older versions stop being restorable after the retention period."},
        safety={"verdict": WITH_CARE, "reversible": False, "checks": [],
                "preconditions": ["Agree the version retention period with the data owner."]},
        data_sources=[data_source("versioning", "Versioning state", True),
                      data_source("lifecycle", "Lifecycle configuration", True)],
    )


RULES = [
    Rule(rule_id="VOLUME_UNATTACHED", version="1.0", providers=(AWS, AZURE, OCI),
         resource_types=VOLUME_TYPES, category=STORAGE, severity=MEDIUM, signal=SIG_UNUSED,
         title="Unattached volume is still billed",
         description="A block volume, boot volume or managed disk attached to nothing.",
         rationale="A volume bills for its provisioned size whether or not anything uses it. "
                   "Unattached volumes are usually left behind by a terminated instance.",
         remediation={OCI: "OCI console → Block Storage → Block/Boot Volumes → select → Create "
                           "backup, then Terminate.",
                      AZURE: "Azure portal → Disks → select → Create snapshot, then Delete.",
                      AWS: "EC2 console → Volumes → select → Create snapshot, then Delete volume."},
         risk=RISK_HIGH, effort="LOW", evaluate=_unattached),
    Rule(rule_id="VOLUME_NO_IO", version="1.0", providers=(AWS, OCI),
         resource_types=("BlockVolume", "EBSVolume"), category=STORAGE, severity=LOW,
         signal=SIG_UNUSED, title="Attached volume had no I/O for 30 days",
         description="An attached data volume with zero read and zero write operations measured.",
         rationale="A volume nothing reads or writes is storage being paid for without use.",
         remediation={"*": "Unmount it inside the instance, detach it, back it up, then delete it."},
         risk=RISK_HIGH, effort="LOW", evaluate=_no_io,
         metrics=("volume_read_ops", "volume_write_ops")),
    Rule(rule_id="VOLUME_PERFORMANCE_UNUSED", version="1.0", providers=(OCI,),
         resource_types=("BlockVolume", "BootVolume"), category=STORAGE, severity=LOW,
         signal=SIG_UNDERUTILIZED, title="Volume performance tier is higher than its I/O needs",
         description="A volume above Balanced whose measured IOPS fit comfortably within Balanced.",
         rationale="Performance units are billed per GB per month on top of capacity, whether or "
                   "not the extra IOPS are used.",
         remediation={OCI: "OCI console → Block Storage → volume → Edit → Volume performance → Balanced."},
         risk=RISK_LOW, effort="LOW", evaluate=_performance_tier,
         metrics=("volume_read_ops", "volume_write_ops")),
    Rule(rule_id="BUCKET_NO_LIFECYCLE", version="1.0", providers=(AWS, OCI),
         resource_types=BUCKET_TYPES, category=STORAGE, severity=LOW, signal=SIG_CONFIGURATION,
         title="Bucket has no lifecycle policy",
         description="No lifecycle policy, confirmed by the provider.",
         rationale="Without one, every object stays in its original storage class indefinitely, "
                   "whatever its age.",
         remediation={AWS: "S3 console → bucket → Management → Lifecycle rules → Create rule.",
                      OCI: "OCI console → Buckets → bucket → Lifecycle Policy Rules → Create Rule."},
         risk=RISK_MEDIUM, effort="LOW", evaluate=_no_lifecycle,
         metrics=("lifecycle_enabled", "stored_bytes", "object_count"),
         supersedes=("Missing S3 Lifecycle Policies",)),
    Rule(rule_id="BUCKET_INCOMPLETE_UPLOADS", version="1.0", providers=(OCI,),
         resource_types=("ObjectStorageBucket",), category=CLEANUP, severity=LOW, signal=SIG_UNUSED,
         title="Bucket holds incomplete multipart uploads",
         description="Uncommitted multipart-upload parts reported by the storage service.",
         rationale="Parts of an upload that was never committed or aborted are stored, and "
                   "billed, until something removes them.",
         remediation={OCI: "oci os multipart list / abort, and a lifecycle rule for uncommitted parts."},
         risk=RISK_LOW, effort="LOW", evaluate=_incomplete_uploads, metrics=("uncommitted_parts",)),
    Rule(rule_id="BUCKET_VERSIONS_UNBOUNDED", version="1.0", providers=(AWS, OCI),
         resource_types=BUCKET_TYPES, category=STORAGE, severity=LOW, signal=SIG_CONFIGURATION,
         title="Versioned bucket keeps every old version forever",
         description="Versioning enabled with no lifecycle policy to expire previous versions.",
         rationale="Each overwrite or delete keeps the previous version, and without expiry the "
                   "version history only grows.",
         remediation={AWS: "Add a lifecycle rule: NoncurrentVersionExpiration after N days.",
                      OCI: "Add a lifecycle rule targeting previous object versions."},
         risk=RISK_MEDIUM, effort="LOW", evaluate=_versions_unbounded, metrics=("lifecycle_enabled",)),
]
