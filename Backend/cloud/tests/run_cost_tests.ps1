# Cost Intelligence verification. Run from Backend/cloud:
#   .\tests\run_cost_tests.ps1
#
# Kept ASCII-only on purpose: powershell.exe reads .ps1 as ANSI unless there is
# a BOM, and a stray non-ASCII character desyncs the parser.
$py = ".\venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "No venv. Run: py -3 -m venv venv; venv\Scripts\python.exe -m pip install -r requirements.txt" -ForegroundColor Red
    exit 1
}

$suites = @(
    # The money rules. Three things that silently misreport real currency and
    # each shipped as a bug somewhere in this industry: adding USD to INR,
    # turning an unknown into a zero, and dividing by a zero baseline to get
    # an infinite percentage. Pure logic, no DB.
    @{ Name = "data contract: currency, NA rule, change math (no DB)"; Args = @("tests\verify_cost_contract.py") },
    # What each provider's integration can actually answer, cross-checked
    # against the provider methods' own source so a capability flag cannot
    # drift from the query that backs it. The load-bearing case is AWS
    # per-resource cost, which must stay unavailable until a CUR pipeline
    # exists. Pure logic, no DB.
    @{ Name = "provider capability registry + source cross-check (no DB)"; Args = @("tests\verify_cost_capabilities.py") },
    # Why a billing call failed, in terms a user can act on. The regression
    # this pins: Azure HTTP 429 used to classify as 'unknown', so a throttled
    # subscription reported an unexpected error instead of a wait time.
    # Pure logic, no DB.
    @{ Name = "error classification incl. Azure 429 regression (no DB)"; Args = @("tests\verify_cost_errors.py") },
    # HTTP surface: the capability and quality endpoints, freshness per
    # dataset, and the RBAC now declared on every cost route. Creates and
    # removes its own accounts; asserts the count is restored.
    @{ Name = "HTTP API + capabilities + freshness + RBAC"; Args = @("tests\verify_cost_api.py") },
    # Persistence. The load-bearing assertion is that re-ingesting a window
    # CORRECTS history rather than doubling it -- forecasts, anomaly baselines
    # and budget burn are all only as good as that. Also pins why the
    # idempotency key is a hash (NULL != NULL in SQL, so a composite UNIQUE
    # over nullable dimensions does not dedupe) and that `final` is never
    # asserted, since no provider here reports finality.
    @{ Name = "persistence: idempotent ingestion, finality, coverage"; Args = @("tests\verify_cost_ingestion.py") },
    # Analytics over stored history. Pins the three rules that stop these
    # producing confident nonsense: every calculation stays inside one
    # currency, too little history returns NA rather than a number, and
    # change analysis reports association and never claims cause. Pure logic.
    @{ Name = "analytics: forecast, anomalies, change, MoM, calendar (no DB)"; Args = @("tests\verify_cost_analytics.py") },
    # Budgets and cost alert policies. The load-bearing half is dedupe: a
    # budget is re-evaluated every cycle, so getting it wrong either
    # re-announces 75% forever or -- far worse -- stays silent exactly when
    # spend crosses 100%. Both cases are pinned. Alerts are raised through the
    # EXISTING cloud_alerts table and notification bridge, never a second one.
    @{ Name = "budgets + alert policies: dedupe, escalation, RBAC"; Args = @("tests\verify_cost_budgets.py") },
    # The recommendations engine. Two things carry the weight: savings in
    # different currencies are never summed and an unpriceable opportunity is
    # counted but never valued; and the fingerprint survives re-derivation, so
    # a user's dismissal keeps applying after the next discovery scan instead
    # of the same finding nagging forever.
    @{ Name = "recommendations: priority, savings honesty, lifecycle"; Args = @("tests\verify_cost_recommendations.py") },
    # Allocation, reports and observability. Two assertions carry the weight:
    # untagged spend is NEVER assigned to anyone (the guess that makes a
    # chargeback report unusable the first time it is checked), and a report's
    # header total equals the sum of the rows it contains. Pure logic.
    @{ Name = "allocation, reports, FinOps health, metrics (no DB)"; Args = @("tests\verify_cost_governance.py") }
)

$pattern = '\[PASS\]|\[FAIL\]|\[SKIP\]|passed,|FAILED|Traceback|^!|^  !'
$failed = 0

foreach ($s in $suites) {
    Write-Host ""
    Write-Host "=== $($s.Name) ===" -ForegroundColor Cyan
    & $py @($s.Args) 2>&1 | Select-String -Pattern $pattern | Select-String -Pattern '\[FAIL\]|passed,|^!|^  !'
    if ($LASTEXITCODE -ne 0) {
        $failed++
        Write-Host "SUITE FAILED: $($s.Name)" -ForegroundColor Red
    }
}

Write-Host ""
if ($failed -eq 0) {
    Write-Host "All cost suites passed." -ForegroundColor Green
    exit 0
}
Write-Host "$failed cost suite(s) failed." -ForegroundColor Red
exit 1
