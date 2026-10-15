"""Diagnostic heuristic rules for a parsed AWR report.

Ported as-is from the standalone oracle-awr-analyzer project's
app/engine/rule_engine.py. This is a small, auditable set of hardcoded
Python thresholds (~6 distinct checks) — not a YAML/DSL rule system, and
not an ML model. Findings here are facts about the parsed report cross-
checked against common DBA review thresholds, not predictions.
"""

from __future__ import annotations

from .schema import AWRReport, DiagnosticFinding


class ComprehensiveDiagnosticEngine:
    """Apply DBA-oriented heuristic checks to parsed AWR data."""

    def __init__(self, awr_model: AWRReport):
        self.awr = awr_model

    def run_all_checks(self) -> list[DiagnosticFinding]:
        findings: list[DiagnosticFinding] = []
        findings.extend(self._check_wait_profile())
        findings.extend(self._check_instance_efficiency())
        findings.extend(self._check_top_sql())
        if not findings:
            findings.append(
                DiagnosticFinding(
                    severity="INFO",
                    category="Baseline",
                    title="No high-risk heuristic findings detected",
                    evidence="Parsed AWR sections did not cross built-in warning thresholds.",
                    recommendation="Review the generated report and validate workload-specific expectations with application owners.",
                )
            )
        return findings

    def _check_wait_profile(self) -> list[DiagnosticFinding]:
        findings: list[DiagnosticFinding] = []
        for event in self.awr.top_wait_events[:10]:
            pct = event.percent_db_time or 0
            name = event.name.lower()
            # The Top 10 table lists DB CPU alongside waits, but it is time spent
            # working, not waiting; a high share is often a healthy instance.
            if name == "db cpu":
                continue
            if pct >= 25:
                findings.append(
                    DiagnosticFinding(
                        severity="HIGH",
                        category="Wait Events",
                        title=f"{event.name} dominates DB time",
                        evidence=f"{event.name} accounts for approximately {pct:.1f}% of DB time.",
                        recommendation=self._wait_recommendation(name),
                    )
                )
            elif pct >= 10:
                findings.append(
                    DiagnosticFinding(
                        severity="MEDIUM",
                        category="Wait Events",
                        title=f"{event.name} is a material wait contributor",
                        evidence=f"{event.name} accounts for approximately {pct:.1f}% of DB time.",
                        recommendation=self._wait_recommendation(name),
                    )
                )
        return findings

    def _check_instance_efficiency(self) -> list[DiagnosticFinding]:
        findings: list[DiagnosticFinding] = []
        for metric in self.awr.instance_efficiency:
            name = metric.name.lower()
            value = metric.value
            if value is None:
                continue
            if "buffer nowait" in name and value < 95:
                findings.append(self._efficiency_finding(metric.name, value, "Investigate buffer contention, hot blocks, and SQL causing repeated logical reads."))
            if "library hit" in name and value < 95:
                findings.append(self._efficiency_finding(metric.name, value, "Review hard parsing, cursor sharing, bind variable usage, and shared pool pressure."))
            if "soft parse" in name and value < 95:
                findings.append(self._efficiency_finding(metric.name, value, "Reduce hard parses by using bind variables and checking session cursor cache settings."))
        return findings

    def _check_top_sql(self) -> list[DiagnosticFinding]:
        findings: list[DiagnosticFinding] = []
        for sql in self.awr.sql_by_elapsed_time[:5]:
            if sql.elapsed_time_seconds and sql.elapsed_time_seconds >= 300:
                identifier = sql.sql_id or (sql.sql_text or "unknown SQL")[:40]
                findings.append(
                    DiagnosticFinding(
                        severity="HIGH",
                        category="SQL",
                        title=f"High elapsed-time SQL: {identifier}",
                        evidence=f"Elapsed time is approximately {sql.elapsed_time_seconds:.1f} seconds in the snapshot.",
                        recommendation="Inspect execution plan, object statistics, predicates, bind sensitivity, and opportunities for indexing or SQL rewrite.",
                    )
                )
        return findings

    @staticmethod
    def _efficiency_finding(name: str, value: float, recommendation: str) -> DiagnosticFinding:
        return DiagnosticFinding(
            severity="MEDIUM",
            category="Instance Efficiency",
            title=f"{name} below target",
            evidence=f"{name} is {value:.1f}%, below the common 95% review threshold.",
            recommendation=recommendation,
        )

    @staticmethod
    def _wait_recommendation(name: str) -> str:
        if "db file sequential read" in name:
            return "Review single-block read SQL, index access paths, storage latency, and object statistics."
        if "db file scattered read" in name:
            return "Review full scan drivers, missing selective predicates, parallelism, and multiblock read behavior."
        if "log file sync" in name:
            return "Inspect commit frequency, redo I/O latency, and application transaction batching."
        if "enq" in name or "lock" in name:
            return "Identify blockers and hot application transactions; review locking order and commit timing."
        if "cpu" in name:
            return "Profile top SQL by CPU, execution counts, parse load, and plan regressions."
        return "Correlate the wait with top SQL, time model statistics, OS metrics, and application activity during the snapshot."
