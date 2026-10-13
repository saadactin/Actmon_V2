"""Resource Intelligence: the optimization engine, its telemetry and its rules.

model.py       — vocabulary (categories, verdicts, statuses, savings methods)
telemetry.py   — metric catalog and statistics (pure)
collect_*.py   — provider monitoring adapters (CloudWatch, Azure Monitor, OCI Monitoring)
collector.py   — plan → fetch → summarise → persist
pricebook.py   — billed costs and list prices handed to the rules
rules/         — the rule registry, keyed by (provider, resource type)
engine.py      — one pure pass over an account: findings, coverage, outcome
health.py      — per-resource health scores, only where evidence exists
"""
