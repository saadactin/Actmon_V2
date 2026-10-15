"""The single source of truth for which verify_*.py suites exist and how to run them.

Both `run_all_tests.ps1` and `verify_suite_manifest.py` read this list -- the
PowerShell runner via `python -c "import json, suite_manifest; ..."`, the
manifest guard via a plain import. One list, two consumers, so the runner and
the guard that checks the runner cannot disagree with each other.

Each entry:
    Area  -- groups suites in the summary; matches an existing run_<area>_tests.ps1
              where one exists.
    File  -- path relative to Backend/cloud, e.g. "tests/verify_x.py".
    Db    -- True if the suite touches Postgres (directly or through the app).
              Drives the -NoDb fast-loop switch.
    Tier  -- 0 meta, 1 pure logic (no DB, no ASGI), 2 Postgres fixtures,
              3 in-process ASGI (also DB, via the app). Ascending tiers fail
              fast on cheap structural problems before anything pays for a
              database fixture.
    Args  -- extra argv, e.g. the alert-persistence write/read phase split.
    Label -- human description, shown in the runner's section header. Optional;
              falls back to the filename.

This suite is deliberately run SEQUENTIALLY by the runner. Every DB-backed
suite purges its own `zz<area>-test-%` rows on the way in (self-healing after
a crashed run) -- running two suites concurrently makes them purge each
other's fixtures mid-run. See run_all_tests.ps1's header comment before
"optimising" this into parallelism.
"""

SUITES = [
    # ── Tier 0: meta ─────────────────────────────────────────────────────────
    # This suite about the manifest itself always runs first -- if IT is
    # wrong, every other tier's results are unreliable.
    {"Area": "meta", "File": "tests/verify_suite_manifest.py", "Db": False,
     "Tier": 0, "Label": "every verify_*.py is declared and runnable"},
    {"Area": "meta", "File": "tests/verify_schema_drift.py", "Db": True,
     "Tier": 0, "Label": "ORM models agree with the live database (cloud + database services)"},

    # ── Tier 1: pure logic, no Postgres, no ASGI (25 suites) ────────────────
    {"Area": "drift", "File": "tests/verify_client_reuse.py", "Db": False, "Tier": 1,
     "Label": "provider client/connection reuse + auth preflight"},
    {"Area": "cost", "File": "tests/verify_cost_contract.py", "Db": False, "Tier": 1,
     "Label": "data contract: currency, NA rule, change math"},
    {"Area": "cost", "File": "tests/verify_cost_capabilities.py", "Db": False, "Tier": 1,
     "Label": "provider capability registry + source cross-check"},
    {"Area": "cost", "File": "tests/verify_cost_errors.py", "Db": False, "Tier": 1,
     "Label": "error classification incl. Azure 429 regression"},
    {"Area": "cost", "File": "tests/verify_cost_analytics.py", "Db": False, "Tier": 1,
     "Label": "analytics: forecast, anomalies, change, MoM, calendar"},
    {"Area": "cost", "File": "tests/verify_cost_correlation.py", "Db": False, "Tier": 1,
     "Label": "cost/drift/security correlation without causation"},
    {"Area": "cost", "File": "tests/verify_cost_governance.py", "Db": False, "Tier": 1,
     "Label": "allocation, reports, FinOps health, metrics"},
    {"Area": "drift", "File": "tests/verify_drift_rules.py", "Db": False, "Tier": 1,
     "Label": "classification rules"},
    {"Area": "events", "File": "tests/verify_event_classification.py", "Db": False, "Tier": 1,
     "Label": "classification + redaction"},
    {"Area": "events", "File": "tests/verify_event_adapters.py", "Db": False, "Tier": 1,
     "Label": "provider adapter normalization"},
    {"Area": "security", "File": "tests/verify_exposure_logic.py", "Db": False, "Tier": 1,
     "Label": "internet exposure + IAM review against synthetic rule shapes"},
    {"Area": "resources", "File": "tests/verify_resource_model.py", "Db": False, "Tier": 1,
     "Label": "normalization: status, type, freshness, tags"},
    {"Area": "resources", "File": "tests/verify_resource_capabilities.py", "Db": False, "Tier": 1,
     "Label": "provider capabilities + source cross-check"},
    {"Area": "resources", "File": "tests/verify_resource_services.py", "Db": False, "Tier": 1,
     "Label": "cloud service classification (Lambda, App Service, Object Storage...)"},
    {"Area": "security", "File": "tests/verify_security_rules.py", "Db": False, "Tier": 1,
     "Label": "rules + provider dispatch + missing-data"},
    {"Area": "security", "File": "tests/verify_security_engine.py", "Db": False, "Tier": 1,
     "Label": "scoring, compliance, exposure, thresholds, scale"},
    {"Area": "security", "File": "tests/verify_attack_paths.py", "Db": False, "Tier": 1,
     "Label": "contextual risk + attack-path traversal, incl. the never-dampen-on-absence rule"},
    {"Area": "security", "File": "tests/verify_rulepack.py", "Db": False, "Tier": 1,
     "Label": "declarative rule DSL: Kleene logic, null-never-a-finding, YAML/Python equivalence"},
    {"Area": "security", "File": "tests/verify_vulnerability.py", "Db": False, "Tier": 1,
     "Label": "software identity per provider + the honest zero when no CVE feed is configured"},
    {"Area": "security", "File": "tests/verify_secrets.py", "Db": False, "Tier": 1,
     "Label": "secrets in config/tags: the value never leaves, unread surfaces are reported"},
    {"Area": "security", "File": "tests/verify_ransomware.py", "Db": False, "Tier": 1,
     "Label": "ransomware resilience: NOT_ASSESSED never reads as configured, and no score"},
    {"Area": "security", "File": "tests/verify_threat.py", "Db": False, "Tier": 1,
     "Label": "behavioural detection + incident correlation; unavailable != nothing detected"},
    {"Area": "topology", "File": "tests/verify_topology_rules.py", "Db": False, "Tier": 1,
     "Label": "relationship rules + negative tests"},
    {"Area": "topology", "File": "tests/verify_topology_graph.py", "Db": False, "Tier": 1,
     "Label": "graph traversal, impact, scale"},
    {"Area": "alerts", "File": "tests/verify_alert_templates.py", "Db": False, "Tier": 1,
     "Label": "every template describes a condition the engine can evaluate"},
    {"Area": "alerts", "File": "tests/verify_alert_policy.py", "Db": False, "Tier": 1,
     "Label": "CRITICAL never batched, quiet hours delay not cancel, escalation 0 = off"},
    {"Area": "security", "File": "tests/verify_credentials_analysis.py", "Db": False,
     "Tier": 1,
     "Label": "certificates/secrets: parsing, expired vs expiring, unread stores never pass"},
    {"Area": "security", "File": "tests/verify_compliance_frameworks.py", "Db": False,
     "Tier": 1,
     "Label": "10 frameworks: strict CIS, per-type controls, provider scope, *:* visible"},
    {"Area": "resources", "File": "tests/verify_reports.py", "Db": False, "Tier": 1,
     "Label": "report builder: scope cap, section toggles, NA-never-zero across CSV/JSON/PDF/XLSX"},
    {"Area": "discovery", "File": "tests/verify_scan_coverage.py", "Db": False, "Tier": 1,
     "Label": "sweep coverage: share read not 0%, not-offered is no failure, denials named"},
    {"Area": "clients", "File": "tests/verify_client_reports_logic.py", "Db": False,
     "Tier": 1,
     "Label": "report periods, local schedule times, no catch-up flood, money, PDF"},
    {"Area": "intelligence", "File": "tests/verify_optimization_engine.py", "Db": False,
     "Tier": 1,
     "Label": "optimization rules: no invented savings, unknown is N/A, sizing never below peak"},
    {"Area": "identity", "File": "tests/verify_identity_model.py", "Db": False, "Tier": 1,
     "Label": "CIEM vocabulary + capability mapper (glob direction: Reader is not Owner)"},
    {"Area": "identity", "File": "tests/verify_identity_evaluation.py", "Db": False,
     "Tier": 1,
     "Label": "AWS/Azure/OCI effective permissions: deny wins, SCP gaps, scope, planes"},
    {"Area": "identity", "File": "tests/verify_identity_analysis.py", "Db": False,
     "Tier": 1,
     "Label": "usage windows, dormancy, credentials, MFA, trust, blast radius, right-sizing"},
    {"Area": "identity", "File": "tests/verify_identity_findings.py", "Db": False,
     "Tier": 1,
     "Label": "CIEM findings = registry rules, scoped persistence, RBAC, write-off-by-default"},

    # ── Tier 2: Postgres fixtures, no ASGI (11 files, 12 invocations) ───────
    {"Area": "account_refresh", "File": "tests/verify_account_refresh.py", "Db": True, "Tier": 2,
     "Label": "schedule tz arithmetic, grading, one-per-account lock, isolation"},
    {"Area": "alerts", "File": "tests/verify_alert_storage_rule.py", "Db": True, "Tier": 2,
     "Label": "storage rule (which resources get flagged)"},
    {"Area": "alerts", "File": "tests/verify_alert_persistence.py", "Db": True, "Tier": 2,
     "Args": ["--phase", "write"], "Label": "lifecycle, dedupe, auto-resolve"},
    {"Area": "alerts", "File": "tests/verify_alert_persistence.py", "Db": True, "Tier": 2,
     "Args": ["--phase", "read"],
     "Label": "survives a process restart (separate process, on purpose)"},
    {"Area": "alerts", "File": "tests/verify_alert_rules.py", "Db": True, "Tier": 2,
     "Label": "rule engine, dedupe, cooldown, notification safety"},
    {"Area": "drift", "File": "tests/verify_drift_capture.py", "Db": True, "Tier": 2,
     "Label": "capture through the repository + DB"},
    {"Area": "events", "File": "tests/verify_event_collector.py", "Db": True, "Tier": 2,
     "Label": "checkpointing, retries, failure isolation"},
    {"Area": "cost", "File": "tests/verify_refresh_only_fetch.py", "Db": True, "Tier": 2,
     "Label": "AWS read only during a refresh: page views, polls and loops never call it"},
    {"Area": "events", "File": "tests/verify_event_storage.py", "Db": True, "Tier": 2,
     "Label": "dedup, immutability, paging, retention"},
    {"Area": "resources", "File": "tests/verify_overview.py", "Db": True, "Tier": 2,
     "Label": "one security source, no estate download, counts reconcile"},
    {"Area": "resources", "File": "tests/verify_resource_query.py", "Db": True, "Tier": 2,
     "Label": "server-side query: paging, filters, sort, facets, export"},
    {"Area": "resources", "File": "tests/verify_resource_views.py", "Db": True, "Tier": 2,
     "Label": "saved views: validation, overwrite, scope, ownership"},
    {"Area": "resources", "File": "tests/verify_resource_actions.py", "Db": True, "Tier": 2,
     "Label": "action gates, dependencies, audit, idempotency"},
    {"Area": "resources", "File": "tests/verify_resource_assessment.py", "Db": True, "Tier": 2,
     "Label": "assessment export: category mapping, NA-vs-clean anomalies, degradation, CSV guard"},
    {"Area": "discovery", "File": "tests/verify_discovery_worker.py", "Db": True, "Tier": 2,
     "Label": "the two data-loss guards, refresh component stamping, one event path"},
    {"Area": "alerts", "File": "tests/verify_notification_bridge.py", "Db": True, "Tier": 2,
     "Label": "what gets queued, account-scoped recipients, no secrets in the payload"},
    {"Area": "clients", "File": "tests/verify_onboarding.py", "Db": True, "Tier": 2,
     "Label": "organisation onboarding: recognised members, role per member, isolation"},

    # ── Tier 3: in-process ASGI (also DB, via the app) (13 suites) ──────────
    {"Area": "alerts", "File": "tests/verify_alert_api.py", "Db": True, "Tier": 3,
     "Label": "HTTP API + response shape"},
    {"Area": "cost", "File": "tests/verify_cost_api.py", "Db": True, "Tier": 3,
     "Label": "HTTP API + capabilities + freshness + RBAC"},
    {"Area": "cost", "File": "tests/verify_cost_ingestion.py", "Db": True, "Tier": 3,
     "Label": "persistence: idempotent ingestion, finality, coverage"},
    {"Area": "cost", "File": "tests/verify_cost_budgets.py", "Db": True, "Tier": 3,
     "Label": "budgets + alert policies: dedupe, escalation, RBAC"},
    {"Area": "cost", "File": "tests/verify_cost_budget_guardrails.py", "Db": True, "Tier": 3,
     "Label": "forecast-to-breach alerting + the budget scheduler's config"},
    {"Area": "cost", "File": "tests/verify_finops_scorecard.py", "Db": True, "Tier": 3,
     "Label": "FinOps scorecard: phases, Crawl/Walk/Run, the budget-scoping fix, per-client aggregation"},
    {"Area": "cost", "File": "tests/verify_cost_recommendations.py", "Db": True, "Tier": 3,
     "Label": "recommendations: priority, savings honesty, lifecycle"},
    {"Area": "drift", "File": "tests/verify_drift_api.py", "Db": True, "Tier": 3,
     "Label": "HTTP API + response shape"},
    {"Area": "events", "File": "tests/verify_event_api.py", "Db": True, "Tier": 3,
     "Label": "HTTP API + RBAC"},
    {"Area": "resources", "File": "tests/verify_resource_api.py", "Db": True, "Tier": 3,
     "Label": "HTTP API: route order, error envelope, RBAC, CSV"},
    {"Area": "security", "File": "tests/verify_security_api.py", "Db": True, "Tier": 3,
     "Label": "HTTP API + RBAC + finding lifecycle"},
    {"Area": "topology", "File": "tests/verify_topology_api.py", "Db": True, "Tier": 3,
     "Label": "HTTP API + RBAC + export"},
    {"Area": "clients", "File": "tests/verify_clients_api.py", "Db": True, "Tier": 3,
     "Label": "clients, portfolio, reports, scheduler idempotency, attachment, RBAC"},
    {"Area": "security", "File": "tests/verify_certificates_api.py", "Db": True, "Tier": 3,
     "Label": "certificates: scope replacement, views, assessment, expiry alerts"},
    {"Area": "intelligence", "File": "tests/verify_intelligence_api.py", "Db": True, "Tier": 3,
     "Label": "Resource Intelligence: two engines one list, resolution rules, cards = lists, RBAC"},
    {"Area": "identity", "File": "tests/verify_identity_api.py", "Db": True, "Tier": 3,
     "Label": "CIEM API: failed collect keeps inventory, scoped resolution, RBAC, "
              "approval workflow with execution off"},
]

# Helper scripts that live under tests/ but are not suites: they never define
# main()/check(), so verify_suite_manifest.py must not expect them to. Keep
# this list short and named -- anything not here and not in SUITES is either
# a suite that needs declaring above, or a file that shouldn't be in tests/.
NON_SUITE_FILES = {
    "tests/reclassify_drift.py",       # maintenance script, has its own --apply flag
    "tests/suite_manifest.py",         # this file
}


def all_files():
    """Every distinct suite FILE this manifest declares (persistence's two
    phases collapse to one file, since the glob check is file-based)."""
    return sorted({s["File"] for s in SUITES})


if __name__ == "__main__":
    import json
    import sys

    print(json.dumps({"suites": SUITES, "non_suite_files": sorted(NON_SUITE_FILES)}))
    sys.exit(0)
