# Phase 1.1 verification. Run from Backend/cloud:  .\tests\run_alert_tests.ps1
# Kept ASCII-only on purpose: powershell.exe reads .ps1 as ANSI unless there is
# a BOM, and a stray non-ASCII character desyncs the parser.
$py = ".\venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "No venv. Run: py -3 -m venv venv; venv\Scripts\python.exe -m pip install -r requirements.txt" -ForegroundColor Red
    exit 1
}

$suites = @(
    @{ Name = "storage rule (which resources get flagged)"; Args = @("tests\verify_alert_storage_rule.py") },
    @{ Name = "lifecycle, dedupe, auto-resolve"; Args = @("tests\verify_alert_persistence.py", "--phase", "write") },
    # Separate process on purpose: this is what proves alerts outlive a restart.
    @{ Name = "survives a process restart"; Args = @("tests\verify_alert_persistence.py", "--phase", "read") },
    @{ Name = "HTTP API + response shape"; Args = @("tests\verify_alert_api.py") }
)

$pattern = '\[PASS\]|\[FAIL\]|\[SKIP\]|passed,|FAILED|Traceback|Error'
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
if ($failed -gt 0) {
    Write-Host "$failed suite(s) failed" -ForegroundColor Red
    exit 1
}
Write-Host "All alert suites passed." -ForegroundColor Green
