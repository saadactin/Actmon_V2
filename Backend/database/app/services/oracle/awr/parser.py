"""BeautifulSoup-based AWR HTML parser.

Ported from the standalone oracle-awr-analyzer project's
app/parsers/html_parser.py. The parser locates AWR tables by the nearest
preceding heading text rather than Oracle's named HTML anchors, which makes
it tolerant of AWR template variations across Oracle versions at the cost
of being a heuristic rather than an anchor-exact match — treat parse
failures/empty sections on an unfamiliar report format as "unsupported
layout", not a crash.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from datetime import datetime

from bs4 import BeautifulSoup

from .schema import AWREvent, AWRHeader, AWRMetric, AWRReport, AWRSQLStat


# Oracle tags every AWR table with summary="This table displays ...". 12c+
# reports print Load Profile / Instance Efficiency / Top 10 events with no
# heading of their own, so the nearest-heading title lumps them in with
# "Report Summary" and they were never parsed; their summary attribute is exact.
_SUMMARY_TITLES = {
    "this table displays load profile": "load profile",
    "this table displays instance efficiency percentages": "instance efficiency percentages",
    "this table displays top 10 wait events by total wait time": "top 10 timed events",
}


class ProductionAWRParser:
    """Parse common Oracle AWR HTML report sections into typed structures."""

    def __init__(self, html_content: str):
        self.soup = BeautifulSoup(html_content, "html.parser")

    def parse_all(self) -> AWRReport:
        sections = self._extract_tables()
        return AWRReport(
            header=self._parse_header(sections),
            load_profile=self._parse_metric_section(sections, "load profile"),
            instance_efficiency=self._parse_metric_section(sections, "instance efficiency", paired=True),
            top_wait_events=self._parse_wait_events(sections),
            sql_by_elapsed_time=self._parse_sql_section(sections, "sql ordered by elapsed time"),
            sql_by_cpu_time=self._parse_sql_section(sections, "sql ordered by cpu time"),
            raw_sections=sections,
        )

    def summary_tables(self) -> dict[str, list[list[str]]]:
        """Every table that carries Oracle's summary="This table displays …" label,
        as raw cell rows (header row first), keyed by the lower-cased summary.
        A repeated summary (the instance table appears twice) gets " #2", " #3"."""
        if hasattr(self, "_summary_cache"):
            return self._summary_cache
        tables: dict[str, list[list[str]]] = {}
        for table in self.soup.find_all("table"):
            summary = self._clean(table.get("summary") or "").lower()
            if not summary:
                continue
            key, n = summary, 1
            while key in tables:
                n += 1
                key = f"{summary} #{n}"
            rows = [[self._clean(c.get_text(" ", strip=True)) for c in tr.find_all(["th", "td"])] for tr in table.find_all("tr")]
            tables[key] = [r for r in rows if any(r)]
        self._summary_cache = tables
        return tables

    def _extract_tables(self) -> dict[str, list[dict[str, str]]]:
        sections: dict[str, list[dict[str, str]]] = {}
        for table in self.soup.find_all("table"):
            summary = self._clean(table.get("summary") or "").lower()
            title = _SUMMARY_TITLES.get(summary) or self._nearest_title(table)
            rows = self._table_to_rows(table)
            if rows:
                sections.setdefault(title, []).extend(rows)
        return sections

    def _nearest_title(self, table) -> str:
        for sibling in table.find_all_previous(["h1", "h2", "h3", "a", "b", "font"], limit=8):
            text = self._clean(sibling.get_text(" ", strip=True))
            if text and len(text) <= 120:
                return text.lower()
        caption = table.find("caption")
        if caption:
            return self._clean(caption.get_text(" ", strip=True)).lower()
        return "untitled"

    def _table_to_rows(self, table) -> list[dict[str, str]]:
        trs = table.find_all("tr")
        if not trs:
            return []

        parsed = [[self._clean(cell.get_text(" ", strip=True)) for cell in tr.find_all(["th", "td"])] for tr in trs]
        parsed = [row for row in parsed if any(row)]
        if not parsed:
            return []

        headers = parsed[0]
        if len(headers) < 2 or self._looks_like_data(headers):
            headers = [f"col_{i + 1}" for i in range(max(len(row) for row in parsed))]
            data_rows = parsed
        else:
            data_rows = parsed[1:]

        rows: list[dict[str, str]] = []
        for row in data_rows:
            record = {}
            for idx, value in enumerate(row):
                key = headers[idx] if idx < len(headers) and headers[idx] else f"col_{idx + 1}"
                record[self._normalize_key(key)] = value
            if any(record.values()):
                rows.append(record)
        return rows

    def _parse_header(self, sections: dict[str, list[dict[str, str]]]) -> AWRHeader:
        header_values: dict[str, str] = {}
        for title, rows in sections.items():
            if "db" in title or "snapshot" in title or "workload repository" in title:
                for row in rows[:20]:
                    items = list(row.values())
                    for left, right in zip(items[0::2], items[1::2]):
                        if left and right:
                            header_values[self._normalize_key(left)] = right
                    header_values.update({k: v for k, v in row.items() if v})

        return AWRHeader(
            db_name=self._first(header_values, "db_name", "db", "database_name") or "UNKNOWN",
            db_id=self._first(header_values, "db_id"),
            instance_name=self._first(header_values, "instance_name", "inst_name"),
            instance_number=self._first(header_values, "instance_number", "inst_num"),
            host_name=self._first(header_values, "host_name", "host"),
            platform=self._first(header_values, "platform"),
            begin_snap=self._first(header_values, "begin_snap", "begin_snapshot"),
            end_snap=self._first(header_values, "end_snap", "end_snapshot"),
            elapsed_minutes=self._to_float(self._first(header_values, "elapsed", "elapsed_time_mins")),
        )

    def parse_window(self) -> dict[str, object]:
        text = self.soup.get_text(" ", strip=True)
        begin = re.search(r"Begin Snap:\s*(\d+)\s+(\d{1,2}-[A-Za-z]{3}-\d{2,4}\s+\d{2}:\d{2}:\d{2})", text)
        end = re.search(r"End Snap:\s*(\d+)\s+(\d{1,2}-[A-Za-z]{3}-\d{2,4}\s+\d{2}:\d{2}:\d{2})", text)
        db_time = re.search(r"DB Time:\s*([\d,]+\.?\d*)\s*\(mins\)", text)
        elapsed = re.search(r"Elapsed:\s*([\d,]+\.?\d*)\s*\(mins\)", text)
        return {
            "begin_snap": begin.group(1) if begin else None,
            "begin_time": self._parse_snap_time(begin.group(2)) if begin else None,
            "end_snap": end.group(1) if end else None,
            "end_time": self._parse_snap_time(end.group(2)) if end else None,
            "db_time_minutes": self._to_float(db_time.group(1)) if db_time else None,
            "elapsed_minutes": self._to_float(elapsed.group(1)) if elapsed else None,
        }

    @staticmethod
    def _parse_snap_time(value: str) -> str | None:
        for fmt in ("%d-%b-%y %H:%M:%S", "%d-%b-%Y %H:%M:%S"):
            try:
                return datetime.strptime(value, fmt).isoformat()
            except ValueError:
                continue
        return None

    def _parse_metric_section(self, sections: dict[str, list[dict[str, str]]], section_name: str, paired: bool = False) -> list[AWRMetric]:
        metrics: list[AWRMetric] = []
        for title, rows in self._matching_sections(sections, section_name):
            for row in rows:
                if paired:
                    # Instance Efficiency prints two metrics per row:
                    # "Buffer Nowait %: | 99.99 | Redo NoWait %: | 100.00".
                    values = list(row.values())
                    for name, raw_value in zip(values[0::2], values[1::2]):
                        if name and not self._looks_like_data([name]):
                            metrics.append(AWRMetric(name=name, value=self._to_float(raw_value), raw_value=raw_value, context={"section": title}))
                    continue
                name = self._first(row, "name", "metric", "statistic", "col_1")
                raw_value = self._first(row, "per_second", "per_sec", "value", "col_2")
                if name:
                    metrics.append(AWRMetric(name=name, value=self._to_float(raw_value), raw_value=raw_value, context={"section": title, **row}))
        return metrics

    def _parse_wait_events(self, sections: dict[str, list[dict[str, str]]]) -> list[AWREvent]:
        events: list[AWREvent] = []
        seen: set[str] = set()
        for title, rows in self._matching_sections(sections, "foreground wait events", "timed events", "wait events"):
            # Background events report "% bg time", not "% DB time" — mixing them
            # in would let a background figure trip a DB-time threshold.
            if "background" in title:
                continue
            for row in rows[:20]:
                name = self._first(row, "event", "event_name", "col_1")
                if not name or name.lower() in {"event", "wait class"} or name.lower() in seen:
                    continue
                seen.add(name.lower())
                events.append(
                    AWREvent(
                        name=name,
                        waits=self._to_float(self._first(row, "waits", "total_waits", "col_2")),
                        time_seconds=self._to_float(self._first(row, "time_s", "time_sec", "wait_time_s", "total_wait_time_sec", "total_wait_time_s", "col_3")),
                        avg_wait_ms=self._to_ms(self._first(row, "avg_wait_ms", "avg_wait", "wait_avg_ms", "col_4")),
                        percent_db_time=self._to_float(self._first(row, "db_time", "%db_time", "percent_db_time", "col_5")),
                        wait_class=self._first(row, "wait_class", "class"),
                        raw=row,
                    )
                )
        return events

    def _parse_sql_section(self, sections: dict[str, list[dict[str, str]]], section_name: str) -> list[AWRSQLStat]:
        stats: list[AWRSQLStat] = []
        for _, rows in self._matching_sections(sections, section_name):
            for row in rows[:20]:
                sql_id = self._first(row, "sql_id", "sqlid")
                sql_text = self._first(row, "sql_text", "sql_module", "col_1")
                if not sql_id and not sql_text:
                    continue
                stats.append(
                    AWRSQLStat(
                        sql_id=sql_id,
                        sql_text=sql_text,
                        elapsed_time_seconds=self._to_float(self._first(row, "elapsed_time_s", "elapsed_time_sec", "elapsed_time", "col_2")),
                        cpu_time_seconds=self._to_float(self._first(row, "cpu_time_s", "cpu_time_sec", "cpu_time")),
                        executions=self._to_float(self._first(row, "executions", "execs")),
                        buffer_gets=self._to_float(self._first(row, "buffer_gets", "gets")),
                        disk_reads=self._to_float(self._first(row, "physical_reads", "disk_reads", "reads")),
                        parse_calls=self._to_float(self._first(row, "parse_calls", "parses")),
                        raw=row,
                    )
                )
        return stats

    def _matching_sections(self, sections: dict[str, list[dict[str, str]]], *needles: str) -> Iterable[tuple[str, list[dict[str, str]]]]:
        for title, rows in sections.items():
            title_lower = title.lower()
            if any(needle in title_lower for needle in needles):
                yield title, rows

    def _first(self, mapping: dict[str, str], *keys: str) -> str | None:
        normalized = {self._normalize_key(k): v for k, v in mapping.items()}
        for key in keys:
            value = normalized.get(self._normalize_key(key))
            if value not in (None, ""):
                return value
        return None

    @staticmethod
    def _clean(value: str) -> str:
        return re.sub(r"\s+", " ", value or "").strip()

    @staticmethod
    def _normalize_key(value: str) -> str:
        return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")

    @staticmethod
    def _looks_like_data(row: list[str]) -> bool:
        return any(re.search(r"\d", cell) for cell in row)

    @staticmethod
    def _to_ms(value: str | None) -> float | None:
        """Average wait as milliseconds. 12c+ prints the unit per cell ("216.45ms",
        "735.09us", "33.17 s"); a bare number is the column's own (ms) unit."""
        match = re.match(r"\s*(-?[\d,]*\.?\d+)\s*([a-zµ]*)", value or "", re.IGNORECASE)
        if not match:
            return None
        number = float(match.group(1).replace(",", ""))
        unit = match.group(2).lower()
        return number * {"ns": 1e-6, "us": 1e-3, "µs": 1e-3, "s": 1000.0, "sec": 1000.0}.get(unit, 1.0)

    @staticmethod
    def _to_float(value: str | None) -> float | None:
        if not value:
            return None
        # AWR abbreviates large totals ("98.2K", "1.3M"); stripping the suffix
        # would silently read 98,200 seconds as 98.2.
        scaled = re.fullmatch(r"\s*(-?[\d,]*\.?\d+)\s*([KMGT])\s*", value)
        if scaled:
            factor = {"K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12}[scaled.group(2)]
            return float(scaled.group(1).replace(",", "")) * factor
        cleaned = re.sub(r"[^0-9.\-]", "", value)
        if cleaned in {"", "-", "."}:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
