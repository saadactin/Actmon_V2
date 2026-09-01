# Configuration-drift verification. Run from Backend/cloud:  .\tests\run_drift_tests.ps1
# Kept ASCII-only on purpose: powershell.exe reads .ps1 as ANSI unless there is
# a BOM, and a stray non-ASCII character desyncs the parser.
$py = ".\venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "No venv. Run: py -3 -m venv venv; venv\Scripts\python.exe -m pip install -r requirements.txt" -ForegroundColor Red
    exit 1
}

$suites = @(
    # Pure rules: what counts as drift, and what pillar/severity/direction it gets.
    @{ Name = "classification rules (no DB)"; Args = @("tests\verify_drift_rules.py") },
    # The invariants: baseline suppression, old-value capture, DELETED outliving
    # the resource row, and an incomplete sweep's diffs being discarded.
    @{ Name = "capture through the repository + DB"; Args = @("tests\verify_drift_capture.py") },
    @{ Name = "HTTP API + response shape"; Args = @("tests\verify_drift_api.py") },
    # Not drift itself, but the thing that decides whether drift can be
    # collected often enough to be useful: a sweep's wall-clock is dominated by
    # HTTPS connection setup, so these pin the per-provider client reuse that
    # keeps connections warm. Runs here because it needs no DB and no network.
    @{ Name = "provider client/connection reuse"; Args = @("tests\verify_client_reuse.py") }
)

$pattern = '\[PASS\]|\[FAIL\]|\[SKIP\]|passed,|FAILED|Traceback|Error|^!|^  !'
$failed = 0

foreach ($s in $suites) {
    Write-Host ""
    Write-Host "=== $($s.Name) ===" -ForegroundColor Cyan
    & $py @($s.Args) 2>&1 | Select-String -Pattern $pattern
    if ($LASTEXITCODE -ne 0) {
        $failed++
        Write-Host "SUITE FAILED: $($s.Name)" -ForegroundColor Red
    }
}

Write-Host ""
if ($failed -eq 0) {
    Write-Host "All drift suites passed." -ForegroundColor Green
    exit 0
}
Write-Host "$failed drift suite(s) failed." -ForegroundColor Red
exit 1
