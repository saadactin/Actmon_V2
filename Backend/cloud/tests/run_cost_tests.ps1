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
    @{ Name = "HTTP API + capabilities + freshness + RBAC"; Args = @("tests\verify_cost_api.py") }
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
