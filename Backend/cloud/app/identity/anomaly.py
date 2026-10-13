"""Identity activity baselines, and describing how current activity differs.

§28's requirement and its constraint are both unusual and both load-bearing:
build an explainable detection, and *do not make unsupported claims about
attacker intent*. So every signal this module emits is phrased as a comparison
between two observed sets — "this differs from previously observed behaviour" —
and the vocabulary is deliberately neutral. There is no `suspicious` field and
no `threat` field, because this platform cannot know either.

**A baseline built from too little data cannot support a deviation claim.** A
principal with 6 events in 90 days has no baseline; its seventh event in a new
region is not a signal, it is the second data point. `sufficient` gates every
comparison, and an insufficient baseline produces no deviations at all rather
than a stream of first-sightings.

**First-seen is not the same as changed.** A brand-new identity does everything
for the first time. Deviations are only computed where the baseline window
closed before the comparison window opened and the baseline is sufficient.
"""
from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from app.identity.capability import classify_action
from app.identity.model import HIGH_IMPACT_CAPABILITIES, normalize_provider
from app.identity.usage import normalize_event_action

# A baseline needs at least this much to be worth comparing against.
MIN_BASELINE_EVENTS = 30
MIN_BASELINE_DAYS = 14

# Signal ids. Neutral names on purpose — each states what was observed, not
# what it means.
SIG_DORMANT_REACTIVATED = "DORMANT_IDENTITY_ACTIVE"
SIG_NEW_REGION = "NEW_REGION"
SIG_NEW_SERVICE = "NEW_SERVICE"
SIG_NEW_HIGH_IMPACT = "NEW_HIGH_IMPACT_CAPABILITY"
SIG_VOLUME_SPIKE = "VOLUME_ABOVE_BASELINE"
SIG_NEW_SOURCE_IP = "NEW_SOURCE_NETWORK"
SIG_FAILURE_SPIKE = "ELEVATED_FAILURE_RATE"

SIGNAL_LABEL = {
    SIG_DORMANT_REACTIVATED: "Previously dormant identity became active",
    SIG_NEW_REGION: "Activity in a region not seen in the baseline",
    SIG_NEW_SERVICE: "Activity against a service not seen in the baseline",
    SIG_NEW_HIGH_IMPACT: "A high-impact capability exercised for the first time",
    SIG_VOLUME_SPIKE: "Call volume above the baseline range",
    SIG_NEW_SOURCE_IP: "Calls from a network not seen in the baseline",
    SIG_FAILURE_SPIKE: "Failure rate above the baseline",
}


@dataclass
class Baseline:
    """What a principal was observed doing over the baseline window."""

    start: datetime
    end: datetime
    days: int
    event_count: int = 0
    services: Set[str] = field(default_factory=set)
    regions: Set[str] = field(default_factory=set)
    capabilities: Set[str] = field(default_factory=set)
    source_networks: Set[str] = field(default_factory=set)
    daily_counts: List[int] = field(default_factory=list)
    failure_rate: float = 0.0

    @property
    def sufficient(self) -> bool:
        return (self.event_count >= MIN_BASELINE_EVENTS
                and self.days >= MIN_BASELINE_DAYS)

    @property
    def insufficient_reason(self) -> Optional[str]:
        if self.sufficient:
            return None
        if self.days < MIN_BASELINE_DAYS:
            return (f"The baseline window is {self.days} days; at least "
                    f"{MIN_BASELINE_DAYS} are needed before a change can be called one.")
        return (f"Only {self.event_count} events were observed in the baseline window; "
                f"at least {MIN_BASELINE_EVENTS} are needed for a comparison to mean "
                "anything.")

    @property
    def median_daily(self) -> Optional[float]:
        return statistics.median(self.daily_counts) if self.daily_counts else None

    @property
    def p95_daily(self) -> Optional[float]:
        if not self.daily_counts:
            return None
        ordered = sorted(self.daily_counts)
        index = min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1))))
        return float(ordered[index])

    def to_dict(self) -> Dict[str, Any]:
        return {
            "window": {"start": self.start.isoformat(), "end": self.end.isoformat(),
                       "days": self.days, "event_count": self.event_count},
            "services": sorted(self.services),
            "regions": sorted(self.regions),
            "capabilities": sorted(self.capabilities),
            "source_networks": sorted(self.source_networks),
            "median_daily_events": self.median_daily,
            "p95_daily_events": self.p95_daily,
            "failure_rate": round(self.failure_rate, 3),
            "sufficient": self.sufficient,
            "insufficient_reason": self.insufficient_reason,
        }


def build_baseline(
    provider: str, events: Iterable[Any], *, start: datetime, end: datetime,
) -> Baseline:
    """Fold events into a baseline. Events outside the window are ignored."""
    days = max(1, int((end - start).total_seconds() // 86400))
    baseline = Baseline(start=start, end=end, days=days)
    per_day: Counter = Counter()
    failures = 0

    for event in events or []:
        get = (lambda k: event.get(k)) if isinstance(event, dict) \
            else (lambda k: getattr(event, k, None))
        when = get("timestamp")
        if when and not (start <= when <= end):
            continue
        baseline.event_count += 1
        if when:
            per_day[when.date()] += 1
        source = get("event_source")
        if source:
            baseline.services.add(str(source))
        region = get("region")
        if region:
            baseline.regions.add(str(region))
        action = normalize_event_action(
            provider, api_operation=get("api_operation"),
            event_name=get("event_name"), event_source=source)
        if action:
            capability = classify_action(provider, action)
            if capability:
                baseline.capabilities.add(capability)
        ip = get("source_ip")
        if ip:
            baseline.source_networks.add(_network(str(ip)))
        if (get("status") or "").upper() in ("FAILURE", "FAILED", "DENIED", "ERROR"):
            failures += 1

    baseline.daily_counts = [per_day.get(start.date() + timedelta(days=i), 0)
                             for i in range(days)]
    baseline.failure_rate = (failures / baseline.event_count) if baseline.event_count else 0.0
    return baseline


def compare(
    provider: str,
    *,
    baseline: Baseline,
    current: Baseline,
    was_dormant: bool = False,
    dormant_days: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Differences between current activity and the baseline.

    Returns an explainable list. Each entry names the baseline, the current
    observation and the difference, and nothing in it asserts a cause.
    """
    if not baseline.sufficient:
        if was_dormant and current.event_count > 0:
            # The one signal that does not need a baseline: the principal was
            # dormant by last-used metadata and is now making calls. That is a
            # fact about two observations, not a statistical claim.
            return [{
                "signal": SIG_DORMANT_REACTIVATED,
                "label": SIGNAL_LABEL[SIG_DORMANT_REACTIVATED],
                "baseline": (f"No activity for {dormant_days} days"
                             if dormant_days else "No recent activity"),
                "current": f"{current.event_count} event(s) in the last "
                           f"{current.days} days",
                "detail": "This identity had been dormant and is now making API calls.",
                "first_observed": current.start.isoformat(),
            }]
        return []

    signals: List[Dict[str, Any]] = []

    if was_dormant and current.event_count > 0:
        signals.append({
            "signal": SIG_DORMANT_REACTIVATED,
            "label": SIGNAL_LABEL[SIG_DORMANT_REACTIVATED],
            "baseline": f"No activity for {dormant_days} days" if dormant_days
                        else "No recent activity",
            "current": f"{current.event_count} event(s) in {current.days} days",
            "detail": "This identity had been dormant and is now making API calls.",
            "first_observed": current.start.isoformat(),
        })

    new_regions = sorted(current.regions - baseline.regions)
    if new_regions:
        signals.append({
            "signal": SIG_NEW_REGION, "label": SIGNAL_LABEL[SIG_NEW_REGION],
            "baseline": ", ".join(sorted(baseline.regions)) or "none observed",
            "current": ", ".join(new_regions),
            "detail": f"Calls were made in {len(new_regions)} region(s) that do not "
                      "appear in the baseline window.",
            "values": new_regions,
        })

    new_services = sorted(current.services - baseline.services)
    if new_services:
        signals.append({
            "signal": SIG_NEW_SERVICE, "label": SIGNAL_LABEL[SIG_NEW_SERVICE],
            "baseline": f"{len(baseline.services)} service(s)",
            "current": ", ".join(new_services[:10]),
            "detail": f"Calls were made against {len(new_services)} service(s) not seen "
                      "in the baseline window.",
            "values": new_services,
        })

    new_caps = sorted((current.capabilities - baseline.capabilities)
                      & set(HIGH_IMPACT_CAPABILITIES))
    if new_caps:
        signals.append({
            "signal": SIG_NEW_HIGH_IMPACT, "label": SIGNAL_LABEL[SIG_NEW_HIGH_IMPACT],
            "baseline": ", ".join(sorted(baseline.capabilities & set(HIGH_IMPACT_CAPABILITIES)))
                        or "no high-impact capability exercised",
            "current": ", ".join(new_caps),
            "detail": "A capability on the high-impact catalog was exercised for the "
                      "first time relative to the baseline.",
            "values": new_caps,
        })

    new_networks = sorted(current.source_networks - baseline.source_networks)
    if new_networks:
        signals.append({
            "signal": SIG_NEW_SOURCE_IP, "label": SIGNAL_LABEL[SIG_NEW_SOURCE_IP],
            "baseline": f"{len(baseline.source_networks)} network(s)",
            "current": ", ".join(new_networks[:10]),
            "detail": f"Calls arrived from {len(new_networks)} network(s) not seen in "
                      "the baseline window.",
            "values": new_networks,
        })

    p95 = baseline.p95_daily
    current_peak = max(current.daily_counts) if current.daily_counts else 0
    if p95 is not None and p95 > 0 and current_peak > max(p95 * 3, p95 + 20):
        signals.append({
            "signal": SIG_VOLUME_SPIKE, "label": SIGNAL_LABEL[SIG_VOLUME_SPIKE],
            "baseline": f"95th percentile {p95:.0f} calls/day",
            "current": f"peak {current_peak} calls/day",
            "detail": "Daily call volume exceeded three times the baseline 95th "
                      "percentile.",
        })

    if baseline.failure_rate < 0.2 and current.failure_rate > 0.5 \
            and current.event_count >= 20:
        signals.append({
            "signal": SIG_FAILURE_SPIKE, "label": SIGNAL_LABEL[SIG_FAILURE_SPIKE],
            "baseline": f"{baseline.failure_rate:.0%} of calls failed",
            "current": f"{current.failure_rate:.0%} of calls failed",
            "detail": "A high proportion of calls are being refused. This often means "
                      "a permission was removed or a credential expired; it is also "
                      "what enumeration looks like. The platform does not distinguish "
                      "between them.",
        })

    return signals


def _network(ip: str) -> str:
    """A /24 (or /64) label, so a dynamic address does not read as a new network."""
    if ":" in ip:
        parts = ip.split(":")
        return ":".join(parts[:4]) + "::/64"
    parts = ip.split(".")
    if len(parts) == 4:
        return ".".join(parts[:3]) + ".0/24"
    return ip
