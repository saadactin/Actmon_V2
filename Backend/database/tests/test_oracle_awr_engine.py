"""Tests for the ported AWR parser + rule engine (no DB/network needed)."""
from app.services.oracle.awr.parser import ProductionAWRParser

SAMPLE_AWR_HTML = """
<html><body>
<h2>WORKLOAD REPOSITORY report for</h2>
<table>
<tr><td>DB Name</td><td>Prod DB Id</td><td>Instance</td><td>Host</td></tr>
<tr><td>ORCLPROD</td><td>1234567890</td><td>orclprod1</td><td>dbhost01</td></tr>
</table>

<h3>Load Profile</h3>
<table>
<tr><th>Name</th><th>Per Second</th></tr>
<tr><td>DB Time(s):</td><td>12.5</td></tr>
<tr><td>Redo size (bytes):</td><td>500000</td></tr>
</table>

<h3>Instance Efficiency Percentages</h3>
<table>
<tr><th>Name</th><th>Value</th></tr>
<tr><td>Buffer Nowait %:</td><td>90.0</td></tr>
<tr><td>Library Hit %:</td><td>99.8</td></tr>
<tr><td>Soft Parse %:</td><td>99.5</td></tr>
</table>

<h3>Top 10 Foreground Wait Events</h3>
<table>
<tr><th>Event</th><th>Waits</th><th>Time(s)</th><th>Avg Wait(ms)</th><th>%DB time</th><th>Wait Class</th></tr>
<tr><td>db file sequential read</td><td>50000</td><td>900</td><td>18</td><td>32.5</td><td>User I/O</td></tr>
<tr><td>log file sync</td><td>20000</td><td>300</td><td>15</td><td>12.0</td><td>Commit</td></tr>
</table>

<h3>SQL ordered by Elapsed Time</h3>
<table>
<tr><th>SQL Id</th><th>Elapsed Time (s)</th><th>CPU Time (s)</th><th>Executions</th></tr>
<tr><td>abcd1234efgh</td><td>450.2</td><td>120.1</td><td>10</td></tr>
</table>
</body></html>
"""


def test_parser_extracts_header_and_sections():
    awr = ProductionAWRParser(SAMPLE_AWR_HTML).parse_all()

    assert awr.header.db_name == "ORCLPROD"
    assert awr.header.host_name == "dbhost01"
    assert len(awr.load_profile) >= 1
    assert len(awr.instance_efficiency) == 3
    assert len(awr.top_wait_events) == 2
    assert awr.top_wait_events[0].name == "db file sequential read"
    assert awr.top_wait_events[0].percent_db_time == 32.5
    assert len(awr.sql_by_elapsed_time) == 1
    assert awr.sql_by_elapsed_time[0].sql_id == "abcd1234efgh"
    assert awr.sql_by_elapsed_time[0].elapsed_time_seconds == 450.2


def test_parser_handles_empty_and_malformed_html():
    awr = ProductionAWRParser("<html><body><p>not an awr report</p></body></html>").parse_all()
    assert awr.header.db_name == "UNKNOWN"
    assert awr.top_wait_events == []
    assert awr.sql_by_elapsed_time == []

    # Must not raise on completely invalid/garbage input.
    awr2 = ProductionAWRParser("<<<not even valid markup>>>").parse_all()
    assert awr2.header.db_name == "UNKNOWN"


# Shape of a real 12c+ AWR report: the summary tables have no heading of their
# own (they sit under "Report Summary") and are identified only by Oracle's
# summary="This table displays ..." attribute.
MODERN_AWR_HTML = """
<html><body class="awr">
<h1 class="awr">WORKLOAD REPOSITORY report for</h1>
<table summary="This table displays database instance information">
<tr><th>DB Name</th><th>DB Id</th><th>Unique Name</th></tr>
<tr><td>PRODCDB</td><td>3087234541</td><td>PRODCDB</td></tr></table>
<table summary="This table displays snapshot information">
<tr><th></th><th>Snap Id</th><th>Snap Time</th></tr>
<tr><td>Begin Snap:</td><td>38076</td><td>28-Mar-26 14:30:50</td></tr>
<tr><td>End Snap:</td><td>38080</td><td>28-Mar-26 18:30:10</td></tr>
<tr><td>Elapsed:</td><td></td><td>239.33 (mins)</td></tr>
<tr><td>DB Time:</td><td></td><td>5,315.08 (mins)</td></tr></table>
<h2 class="awr">Report Summary</h2>
<table summary="This table displays load profile">
<tr><th></th><th>Per Second</th><th>Per Transaction</th></tr>
<tr><td>DB Time(s):</td><td>22.2</td><td>0.3</td></tr>
<tr><td>Redo size (bytes):</td><td>4,123,456.0</td><td>52,000.0</td></tr></table>
<table summary="This table displays instance efficiency percentages">
<tr><td>Buffer Nowait %:</td><td>100.00</td><td>Redo NoWait %:</td><td>99.98</td></tr>
<tr><td>Library Hit %:</td><td>91.20</td><td>Soft Parse %:</td><td>99.50</td></tr></table>
<table summary="This table displays top 10 wait events by total wait time">
<tr><th>Event</th><th>Waits</th><th>Total Wait Time (sec)</th><th>Wait Avg(ms)</th><th>% DB time</th><th>Wait Class</th></tr>
<tr><td>DB CPU</td><td></td><td>133.3K</td><td></td><td>41.8</td><td></td></tr>
<tr><td>log file sync</td><td>9,000,000</td><td>98.1K</td><td>10.9</td><td>30.8</td><td>Commit</td></tr></table>
<h3 class="awr">Foreground Wait Events</h3>
<table summary="This table displays Foreground Wait Events and their wait statistics">
<tr><th>Event</th><th>Waits</th><th>Total Wait Time (s)</th><th>Avg wait (ms)</th><th>%DB time</th></tr>
<tr><td>log file sync</td><td>9,000,000</td><td>98,100</td><td>10.90</td><td>30.8</td></tr>
<tr><td>db file sequential read</td><td>4,000,000</td><td>40,400</td><td>10.10</td><td>12.7</td></tr></table>
<h3 class="awr">Background Wait Events</h3>
<table summary="This table displays background wait events statistics">
<tr><th>Event</th><th>Waits</th><th>Total Wait Time (s)</th><th>Avg wait (ms)</th><th>% bg time</th></tr>
<tr><td>log file parallel write</td><td>5,000,000</td><td>20,000</td><td>4.00</td><td>88.0</td></tr></table>
</body></html>
"""


def test_parser_reads_summary_attribute_sections_of_modern_awr():
    awr = ProductionAWRParser(MODERN_AWR_HTML).parse_all()

    assert awr.header.db_name == "PRODCDB"
    assert [m.name for m in awr.load_profile] == ["DB Time(s):", "Redo size (bytes):"]
    assert awr.load_profile[0].value == 22.2
    # Two metrics per row: both pairs must be read, not just the first.
    eff = {m.name: m.value for m in awr.instance_efficiency}
    assert eff == {"Buffer Nowait %:": 100.0, "Redo NoWait %:": 99.98, "Library Hit %:": 91.2, "Soft Parse %:": 99.5}


def test_wait_events_skip_background_and_deduplicate():
    names = [e.name for e in ProductionAWRParser(MODERN_AWR_HTML).parse_all().top_wait_events]

    assert "log file parallel write" not in names  # background: "% bg time" is not "% DB time"
    assert names.count("log file sync") == 1  # in both the Top 10 and Foreground tables
    assert names == ["DB CPU", "log file sync", "db file sequential read"]


def test_parse_window_reads_snapshot_range_and_db_time():
    window = ProductionAWRParser(MODERN_AWR_HTML).parse_window()

    assert window["begin_snap"] == "38076" and window["end_snap"] == "38080"
    assert window["begin_time"] == "2026-03-28T14:30:50"
    assert window["elapsed_minutes"] == 239.33
    assert window["db_time_minutes"] == 5315.08


def test_average_wait_units_are_normalised_to_milliseconds():
    to_ms = ProductionAWRParser._to_ms
    assert to_ms("216.45ms") == 216.45
    assert abs(to_ms("735.09us") - 0.73509) < 1e-9  # microseconds, not ms
    assert to_ms("33.17 s") == 33170.0
    assert to_ms("10.90") == 10.9  # bare number = the column's own ms unit
    assert to_ms("") is None


def test_abbreviated_totals_keep_their_magnitude():
    to_float = ProductionAWRParser._to_float
    assert to_float("98.2K") == 98200.0
    assert to_float("1.3M") == 1300000.0
    assert to_float("4,873.3") == 4873.3
    assert to_float("5,315.08 (mins)") == 5315.08


# ── upload validation (runs before any database access, so no DB is needed) ──
import pytest

from app.services.oracle import oracle_awr_service as svc


@pytest.mark.parametrize("filename, size, message", [
    ("report.txt", 40, "only .html/.htm"),
    ("report.exe", 40, "only .html/.htm"),
    ("report.html", 0, "the file is empty"),
    ("report.html", svc.MAX_UPLOAD_BYTES + 1, "upload limit"),
], ids=["txt", "exe", "empty", "oversized"])
def test_ingest_rejects_bad_uploads_before_touching_disk_or_db(filename, size, message):
    contents = b"x" * size
    with pytest.raises(svc.AwrInputError, match=message):
        svc.ingest_report(org_id=1, filename=filename, contents=contents, db=None)


def test_upload_filenames_cannot_escape_the_storage_directory():
    assert svc._safe_filename("../../etc/passwd.html") == "passwd.html"
    assert svc._safe_filename(r"..\..\windows\evil.html") == "evil.html"
    assert svc._safe_filename("") == "report.html"
