# Security Center verification. Run from Backend/cloud:
#   .\tests\run_security_tests.ps1
#
# Kept ASCII-only on purpose: powershell.exe reads .ps1 as ANSI unless there is
# a BOM, and a stray non-ASCII character desyncs the parser.
$py = ".\venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "No venv. Run: py -3 -m venv venv; venv\Scripts\python.exe -m pip install -r requirements.txt" -ForegroundColor Red
    exit 1
}

$suites = @(
    # What the engine CLAIMS is wrong. Two halves, and the negative half is the
    # load-bearing one: nothing may fire on the wrong provider, and nothing may
    # fire on absent data. Both of those shipped once. Pure logic, no DB.
    @{ Name = "rules + provider dispatch + missing-data (no DB)"; Args = @("tests\verify_security_rules.py") },
    # Score bounds and discrimination, compliance control arithmetic, Azure NSG
    # interval algebra, identity role powers, alert thresholds, and whether all
    # of it stays fast at 10,000 resources.
    @{ Name = "scoring, compliance, exposure, thresholds, scale (no DB)"; Args = @("tests\verify_security_engine.py") },
    # HTTP surface, RBAC, persistence and the finding/alert lifecycle:
    # incomplete assessments must not resolve, and a returning condition must
    # reopen. Creates and removes its own account.
    @{ Name = "HTTP API + RBAC + finding lifecycle"; Args = @("tests\verify_security_api.py") }
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
    Write-Host "All security suites passed." -ForegroundColor Green
    exit 0
}
Write-Host "$failed security suite(s) failed." -ForegroundColor Red
exit 1
