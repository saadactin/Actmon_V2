"""Request/response shapes for the resource assessment report builder.

One request schema, four renderers (CSV/JSON/PDF/XLSX) consuming the same
normalized dataset `report_service.build_report_dataset` returns. See that
module's docstring for what each section actually contains and why.
"""
from __future__ import annotations

import calendar
import uuid
from datetime import date, datetime, timedelta, timezone as dt_timezone
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field, field_validator, model_validator

SCOPE_RESOURCES = "resources"
SCOPE_FILTERED = "filtered"
SCOPE_ACCOUNT = "account"
SCOPE_MODES = (SCOPE_RESOURCES, SCOPE_FILTERED, SCOPE_ACCOUNT)

FORMAT_CSV = "csv"
FORMAT_JSON = "json"
FORMAT_PDF = "pdf"
FORMAT_XLSX = "xlsx"
FORMATS = (FORMAT_CSV, FORMAT_JSON, FORMAT_PDF, FORMAT_XLSX)

# Three levels, each of which changes what every format contains -- see
# `report_service.apply_detail_level`. There used to be a fourth
# ("technical") that rendered exactly like "detailed"; a draft saved before it
# was removed is read as "detailed" rather than refused.
DETAIL_EXECUTIVE = "executive"
DETAIL_STANDARD = "standard"
DETAIL_DETAILED = "detailed"
DETAIL_LEVELS = (DETAIL_EXECUTIVE, DETAIL_STANDARD, DETAIL_DETAILED)
_LEGACY_DETAIL = {"technical": DETAIL_DETAILED}

GROUP_BY_OPTIONS = ("region", "resource_type", "severity")
SORT_BY_OPTIONS = ("severity", "resource_name", "cost", "detected_at")

# Day-granular on purpose. Billing is daily and every finding is a current
# snapshot, so "last hour" / "last 6 hours" presets selected a window nothing
# in the report could honour.
PERIOD_DAY_PRESETS = {"7d": 7, "30d": 30, "90d": 90}
PERIOD_MTD = "mtd"
PERIOD_LAST_MONTH = "last_month"
PERIOD_CUSTOM = "custom"
DATE_PRESETS = (*PERIOD_DAY_PRESETS, PERIOD_MTD, PERIOD_LAST_MONTH, PERIOD_CUSTOM)
MAX_CUSTOM_PERIOD_DAYS = 366

_PRESET_LABELS = {
    "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days",
    PERIOD_MTD: "Month to date", PERIOD_LAST_MONTH: "Last calendar month",
    PERIOD_CUSTOM: "Custom range",
}


def _zone(name: str):
    from zoneinfo import ZoneInfo

    return ZoneInfo(name)


class ReportScope(BaseModel):
    """What the report covers.

    `resources`: an explicit, hand-picked list of resource ids (the current
    "Export Assessment" button's behaviour).
    `filtered`: every resource in the account matching `filters` — the same
    filter shape `resource_filters`/`ResourceQueryRepository` already use, so
    a filter that works on the Resources table works here unchanged.
    `account`: every resource in the account (filters, if any, are ignored).
    """

    mode: str = Field(default=SCOPE_RESOURCES)
    resource_ids: List[uuid.UUID] = Field(default_factory=list)
    filters: Dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _check_mode(self) -> "ReportScope":
        if self.mode not in SCOPE_MODES:
            raise ValueError(f"scope.mode must be one of {SCOPE_MODES}, got {self.mode!r}")
        if self.mode == SCOPE_RESOURCES and not self.resource_ids:
            raise ValueError("scope.resource_ids must not be empty when mode is 'resources'.")
        return self


class ReportSections(BaseModel):
    """Which sections to include. Executive summary and data quality default
    on — everything else is opt-in so a user who wants "just security" gets
    exactly that, not six sections they have to scroll past."""

    executive_summary: bool = True
    inventory: bool = True
    security: bool = True
    utilization: bool = False
    performance: bool = False
    anomalies: bool = False
    recommendations: bool = False
    cost: bool = False
    # Account-level views from the other engines. Off by default: each is a
    # page or more, and a report someone asked for "just security" should not
    # grow five sections they never chose.
    posture: bool = False        # Security Center score + compliance frameworks
    identity: bool = False       # Identity & Access (CIEM) summary
    certificates: bool = False   # certificates/secrets/keys expired or expiring
    changes: bool = False        # configuration changes within the period
    activity: bool = False       # Event Log activity within the period
    data_quality: bool = True


class ReportDateRange(BaseModel):
    """The reporting period, in whole days in `timezone`.

    It governs the two sections built from history: account spend (cost) and
    spend anomalies. Inventory, findings and per-resource billed cost are the
    current state, and the report says so next to them.
    """

    preset: str = "30d"
    start: Optional[date] = None
    end: Optional[date] = None
    timezone: str = "UTC"

    @field_validator("start", "end", mode="before")
    @classmethod
    def _date_part(cls, value):
        # The builder used to send <input type="datetime-local"> values
        # ("2026-10-01T09:30"). The period is day-granular, so the time part
        # is dropped rather than refused -- a draft saved by the old form
        # still loads.
        if isinstance(value, str) and len(value) > 10:
            return value[:10]
        if isinstance(value, datetime):
            return value.date()
        return value

    @model_validator(mode="after")
    def _check(self) -> "ReportDateRange":
        if self.preset not in DATE_PRESETS:
            raise ValueError(f"date_range.preset must be one of {DATE_PRESETS}")
        try:
            _zone(self.timezone)
        except Exception:  # noqa: BLE001 - ZoneInfoNotFoundError, ValueError
            raise ValueError(f"date_range.timezone {self.timezone!r} is not a known IANA time zone.")
        if self.preset == PERIOD_CUSTOM:
            if self.start is None or self.end is None:
                raise ValueError("date_range.start and .end are required when preset is 'custom'.")
            if self.start > self.end:
                raise ValueError("date_range.start must be on or before date_range.end.")
            if (self.end - self.start).days + 1 > MAX_CUSTOM_PERIOD_DAYS:
                raise ValueError(f"A custom period can span at most {MAX_CUSTOM_PERIOD_DAYS} days.")
        return self

    def today(self, now: Optional[datetime] = None) -> date:
        now = now or datetime.now(dt_timezone.utc)
        return now.astimezone(_zone(self.timezone)).date()

    def resolve(self, now: Optional[datetime] = None) -> Tuple[date, date]:
        """(first_day, last_day), both inclusive, in this range's timezone."""
        today = self.today(now)
        if self.preset in PERIOD_DAY_PRESETS:
            return today - timedelta(days=PERIOD_DAY_PRESETS[self.preset] - 1), today
        if self.preset == PERIOD_MTD:
            return today.replace(day=1), today
        if self.preset == PERIOD_LAST_MONTH:
            last_day = today.replace(day=1) - timedelta(days=1)
            return last_day.replace(day=1), last_day
        return self.start, self.end  # custom, validated above

    def resolved_days(self, now: Optional[datetime] = None) -> int:
        """Window length in days, inclusive of both ends."""
        start, end = self.resolve(now)
        return (end - start).days + 1

    def describe(self, now: Optional[datetime] = None) -> Dict[str, Any]:
        start, end = self.resolve(now)
        label = _PRESET_LABELS.get(self.preset, self.preset)
        if self.preset == PERIOD_LAST_MONTH:
            label = f"{calendar.month_name[start.month]} {start.year}"
        return {
            "preset": self.preset,
            "label": label,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "days": (end - start).days + 1,
            "timezone": self.timezone,
        }


class ReportMetadata(BaseModel):
    title: Optional[str] = None
    subtitle: Optional[str] = None
    organization: Optional[str] = None
    prepared_by: Optional[str] = None
    confidentiality: Optional[str] = None
    reference: Optional[str] = None


class ReportLayout(BaseModel):
    format: str = FORMAT_CSV
    detail_level: str = DETAIL_STANDARD
    group_by: Optional[str] = None
    sort_by: Optional[str] = None
    metadata: ReportMetadata = Field(default_factory=ReportMetadata)

    @field_validator("detail_level", mode="before")
    @classmethod
    def _legacy_detail(cls, value):
        return _LEGACY_DETAIL.get(value, value)

    @field_validator("group_by", "sort_by", mode="before")
    @classmethod
    def _blank_is_none(cls, value):
        return value or None

    @model_validator(mode="after")
    def _check_choices(self) -> "ReportLayout":
        if self.format not in FORMATS:
            raise ValueError(f"layout.format must be one of {FORMATS}")
        if self.detail_level not in DETAIL_LEVELS:
            raise ValueError(f"layout.detail_level must be one of {DETAIL_LEVELS}")
        if self.group_by is not None and self.group_by not in GROUP_BY_OPTIONS:
            raise ValueError(f"layout.group_by must be one of {GROUP_BY_OPTIONS}")
        if self.sort_by is not None and self.sort_by not in SORT_BY_OPTIONS:
            raise ValueError(f"layout.sort_by must be one of {SORT_BY_OPTIONS}")
        return self


class ReportRequest(BaseModel):
    account_id: uuid.UUID
    scope: ReportScope
    sections: ReportSections = Field(default_factory=ReportSections)
    date_range: ReportDateRange = Field(default_factory=ReportDateRange)
    layout: ReportLayout = Field(default_factory=ReportLayout)
    # Generate only: keep a copy in the account's report history (and use it
    # as the baseline for the next report's "since the last report").
    keep: bool = True
    # The template the request came from, when it did -- shown in history.
    template_name: Optional[str] = Field(default=None, max_length=120)
