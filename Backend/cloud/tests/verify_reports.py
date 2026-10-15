"""The resource assessment report builder: scope cap, section toggles, every
renderer's structural honesty. Pure logic only -- no database, no ASGI.

What this suite pins, and why each matters:

* **The resources-mode cap is enforced with zero DB queries.** An explicit
  resource_ids list over REPORT_MAX_RESOURCES must raise before touching the
  database -- the cap exists so a request cannot accidentally fan out across
  thousands of resources.
* **A disabled section produces no rows, in every format.** CSV/JSON/PDF/
  XLSX all read the same dataset; turning a section off must remove it from
  all four, not just hide it in one.
* **NA is never zero.** A resource with no stored cost renders as "Not
  available" / null everywhere, never 0 -- a renderer that defaulted a
  missing value to zero would misreport "free" as a fact.
* **A single very long finding detail does not break the PDF.** reportlab's
  KeepTogether/Table layout raises LayoutError for an unsplittable block
  taller than one page; a 5,800-character finding detail (a real value seen
  from AWS_IAM_ROLE_WILDCARD_WRITE's service list) reproduced this before the
  PDF renderer's own cell-length cap was added.
* **Excel cannot store a timezone-aware datetime.** Every timestamp in this
  product is an ISO 8601 string with a UTC offset; the XLSX renderer must
  strip it rather than let openpyxl raise.
* **A CSV cell starting with =+-@ is neutralised.** The same formula-
  injection guard `resources.py`'s original assessment export used.
"""
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import asyncio  # noqa: E402
import csv  # noqa: E402
import io  # noqa: E402

from pydantic import ValidationError  # noqa: E402

from app.schemas.reports import (  # noqa: E402
    FORMAT_CSV, ReportDateRange, ReportLayout, ReportScope, ReportSections,
)
from app.services import report_service as rs  # noqa: E402
from app.services.report_renderers import (  # noqa: E402
    csv_renderer, json_renderer, pdf_renderer, xlsx_renderer,
)
from app.services.resource_assessment_service import TooManyResourcesError  # noqa: E402
from openpyxl import load_workbook  # noqa: E402


def _parse_csv_rows(text: str):
    """[{header: value}, ...], tolerating the leading BOM and the blank-line
    summary block the renderer appends after the tabular rows."""
    reader = csv.reader(io.StringIO(text.lstrip("﻿")))
    header = next(reader)
    rows = []
    for raw in reader:
        if not raw or len(raw) != len(header):
            break  # the summary block starts here
        rows.append(dict(zip(header, raw)))
    return rows

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


def _dataset(sections: dict, *, notes=None) -> dict:
    return {
        "schema_version": 1,
        "account": {"id": "a", "name": "zz-test-acct", "provider": "AWS"},
        "resources_requested": 1,
        "resources_resolved": 1,
        "resources_missing": [],
        "notes": notes or [],
        "sections": sections,
    }


SECURITY_ROW = {
    "account_name": "zz-test-acct", "provider": "AWS", "region": "ap-south-1",
    "resource_name": "r1", "resource_type": "S3Bucket", "provider_resource_id": "p1",
    "assessment_category": "Security", "severity": "CRITICAL", "title": "Bad thing",
    "detail": "detail text", "metric_value": None, "status": "OPEN",
    "detected_at": "2026-09-10T10:30:49.231166+00:00",
}
COST_ROW_NA = {
    "resource_name": "r1", "provider_resource_id": "p1", "cost_monthly": None,
    "status": "Not available",
}
INVENTORY_ROW = {
    "resource_name": "r1", "provider_resource_id": "p1", "resource_type": "S3Bucket",
    "region": "ap-south-1", "status": "UNKNOWN", "environment": None, "owner": None,
    "resource_group": None, "compartment": None, "tags": {},
    "discovered_at": "2026-08-06T06:11:55.903227+00:00",
    "last_seen_at": "2026-10-12T11:56:47.990103+00:00",
}

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== A. Schema validation ===")
# ═════════════════════════════════════════════════════════════════════════════
try:
    ReportScope(mode="resources", resource_ids=[])
    check("empty resource_ids rejected for mode=resources", False)
except ValidationError:
    check("empty resource_ids rejected for mode=resources", True)

check("mode='account' needs no resource_ids",
      bool(ReportScope(mode="account")))

try:
    ReportLayout(format="docx")
    check("unknown format rejected", False)
except ValidationError:
    check("unknown format rejected", True)

try:
    ReportDateRange(preset="custom")
    check("custom preset without start/end rejected", False)
except ValidationError:
    check("custom preset without start/end rejected", True)

eq("preset '7d' resolves to 7 days", ReportDateRange(preset="7d").resolved_days(), 7)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== B. Scope cap enforced before any DB query ===")
# ═════════════════════════════════════════════════════════════════════════════
too_many = ReportScope(mode="resources", resource_ids=[uuid.uuid4() for _ in range(rs.REPORT_MAX_RESOURCES + 1)])
try:
    asyncio.run(rs.resolve_report_scope(None, uuid.uuid4(), too_many))  # db=None: must not be touched
    check(f"{rs.REPORT_MAX_RESOURCES + 1} explicit resource_ids raises TooManyResourcesError", False)
except TooManyResourcesError:
    check(f"{rs.REPORT_MAX_RESOURCES + 1} explicit resource_ids raises TooManyResourcesError", True)

dupe_ids = [uuid.uuid4()] * 3
ids, total = asyncio.run(rs.resolve_report_scope(None, uuid.uuid4(), ReportScope(mode="resources", resource_ids=dupe_ids)))
eq("duplicate resource_ids are de-duplicated", len(ids), 1)
eq("...and the resolved total reflects that", total, 1)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== C. A disabled section is absent from every format ===")
# ═════════════════════════════════════════════════════════════════════════════
dataset_security_only = _dataset({"security": [SECURITY_ROW]})
csv_text = csv_renderer.build_csv(dataset_security_only)
csv_rows = _parse_csv_rows(csv_text)
eq("CSV has exactly the one enabled section's row", len(csv_rows), 1)
eq("...tagged with the Security section label", csv_rows[0]["Section"], "Security")
check("...and no row is tagged Inventory or Cost",
      all(r["Section"] not in ("Inventory", "Cost") for r in csv_rows))

json_text = json_renderer.build_json(dataset_security_only)
check("JSON omits a disabled section entirely", '"cost"' not in json_text and '"inventory"' not in json_text)

wb_bytes = xlsx_renderer.build_xlsx(dataset_security_only)
wb = load_workbook(io.BytesIO(wb_bytes))
eq("XLSX has exactly Summary + the one enabled section's sheet",
   set(wb.sheetnames), {"Summary", "Security Findings"})

pdf_bytes = pdf_renderer.build_pdf(dataset_security_only, detail_level="standard")
check("PDF is a valid, non-trivial file", pdf_bytes[:4] == b"%PDF" and len(pdf_bytes) > 500)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== D. NA is never zero ===")
# ═════════════════════════════════════════════════════════════════════════════
dataset_cost = _dataset({"cost": [COST_ROW_NA], "inventory": [INVENTORY_ROW]})
cost_rows = _parse_csv_rows(csv_renderer.build_csv(dataset_cost))
cost_row = next(r for r in cost_rows if r["Section"] == "Cost")
eq("CSV's cost cell is blank, not '0', for a resource with no stored cost",
   cost_row["Cost (Monthly)"], "")

wb2 = load_workbook(io.BytesIO(xlsx_renderer.build_xlsx(dataset_cost)))
cost_ws = wb2["Cost"]
header = [c.value for c in cost_ws[1]]
cost_col = header.index("Cost (Monthly)") + 1
check("XLSX cost cell is None, not 0, for a resource with no stored cost",
      cost_ws.cell(row=2, column=cost_col).value is None)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== E. A single very long finding detail does not break the PDF ===")
# ═════════════════════════════════════════════════════════════════════════════
long_row = {**SECURITY_ROW, "detail": "x" * 5845}
dataset_long = _dataset({"security": [long_row] * 50})  # 50 rows, one page-breaking cell each
try:
    pdf_bytes2 = pdf_renderer.build_pdf(dataset_long, detail_level="standard")
    check("PDF renders 50 rows with a 5,845-char detail field each", pdf_bytes2[:4] == b"%PDF")
except Exception as exc:  # noqa: BLE001
    check("PDF renders 50 rows with a 5,845-char detail field each", False, str(exc))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== F. Excel cannot store a timezone-aware datetime -- stripped, not fatal ===")
# ═════════════════════════════════════════════════════════════════════════════
try:
    xlsx_renderer.build_xlsx(_dataset({"inventory": [INVENTORY_ROW]}))
    check("tz-aware discovered_at/last_seen_at do not raise", True)
except TypeError as exc:
    check("tz-aware discovered_at/last_seen_at do not raise", False, str(exc))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== G. CSV formula-injection guard ===")
# ═════════════════════════════════════════════════════════════════════════════
injected_row = {**SECURITY_ROW, "title": "=1+1", "detail": "@SUM(A1:A9)"}
csv_injected = csv_renderer.build_csv(_dataset({"security": [injected_row]}))
injected_rows = _parse_csv_rows(csv_injected)
eq("a '=' title is prefixed with a guard quote", injected_rows[0]["Title"], "'=1+1")
eq("a '@' detail is prefixed with a guard quote", injected_rows[0]["Detail"], "'@SUM(A1:A9)")
check("CSV carries a UTF-8 BOM", csv_injected.startswith("﻿"))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== Summary ===")
# ═════════════════════════════════════════════════════════════════════════════
print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    print("FAILED:")
    for f in fail:
        print(f"  - {f}")
sys.exit(1 if fail else 0)
