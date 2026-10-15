"""Request/response shapes for the resource assessment report builder.

One request schema, four renderers (CSV/JSON/PDF/XLSX) consuming the same
normalized dataset `report_service.build_report_dataset` returns. See that
module's docstring for what each section actually contains and why.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, model_validator

SCOPE_RESOURCES = "resources"
SCOPE_FILTERED = "filtered"
SCOPE_ACCOUNT = "account"
SCOPE_MODES = (SCOPE_RESOURCES, SCOPE_FILTERED, SCOPE_ACCOUNT)

FORMAT_CSV = "csv"
FORMAT_JSON = "json"
FORMAT_PDF = "pdf"
FORMAT_XLSX = "xlsx"
FORMATS = (FORMAT_CSV, FORMAT_JSON, FORMAT_PDF, FORMAT_XLSX)

DETAIL_EXECUTIVE = "executive"
DETAIL_STANDARD = "standard"
DETAIL_DETAILED = "detailed"
DETAIL_TECHNICAL = "technical"
DETAIL_LEVELS = (DETAIL_EXECUTIVE, DETAIL_STANDARD, DETAIL_DETAILED, DETAIL_TECHNICAL)

DATE_PRESETS = ("1h", "6h", "24h", "7d", "30d", "90d", "custom")


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
    data_quality: bool = True


class ReportDateRange(BaseModel):
    """Applied to the sections that support historical queries (cost,
    anomalies). Inventory and security are a snapshot — see
    `report_service`'s docstring for why that is disclosed, not hidden."""

    preset: str = "30d"
    start: Optional[datetime] = None
    end: Optional[datetime] = None
    timezone: str = "UTC"

    @model_validator(mode="after")
    def _check_preset(self) -> "ReportDateRange":
        if self.preset not in DATE_PRESETS:
            raise ValueError(f"date_range.preset must be one of {DATE_PRESETS}")
        if self.preset == "custom" and (self.start is None or self.end is None):
            raise ValueError("date_range.start and .end are required when preset is 'custom'.")
        return self

    def resolved_days(self) -> int:
        """Window length in days, for sections that only take a day count."""
        table = {"1h": 1, "6h": 1, "24h": 1, "7d": 7, "30d": 30, "90d": 90}
        if self.preset != "custom":
            return table.get(self.preset, 30)
        if self.start and self.end:
            return max(1, (self.end.date() - self.start.date()).days or 1)
        return 30


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

    @model_validator(mode="after")
    def _check_choices(self) -> "ReportLayout":
        if self.format not in FORMATS:
            raise ValueError(f"layout.format must be one of {FORMATS}")
        if self.detail_level not in DETAIL_LEVELS:
            raise ValueError(f"layout.detail_level must be one of {DETAIL_LEVELS}")
        return self


class ReportRequest(BaseModel):
    account_id: uuid.UUID
    scope: ReportScope
    sections: ReportSections = Field(default_factory=ReportSections)
    date_range: ReportDateRange = Field(default_factory=ReportDateRange)
    layout: ReportLayout = Field(default_factory=ReportLayout)
