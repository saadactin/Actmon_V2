# Event Log verification. Run from Backend/cloud:  .\tests\run_event_tests.ps1
# Kept ASCII-only on purpose: powershell.exe reads .ps1 as ANSI unless there is
# a BOM, and a stray non-ASCII character desyncs the parser.
$py = ".\venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "No venv. Run: py -3 -m venv venv; venv\Scripts\python.exe -m pip install -r requirements.txt" -ForegroundColor Red
    exit 1
}

$suites = @(
    # What the Event Log CALLS things: action verb, category, risk level, and
    # what never reaches storage. Pure logic, no DB, no network.
    @{ Name = "classification + redaction (no DB)"; Args = @("tests\verify_event_classification.py") },
    # Which provider field lands in which normalized column, and which columns
    # stay NULL because the provider said nothing. Real payload shapes, no network.
    @{ Name = "provider adapter normalization (no network)"; Args = @("tests\verify_event_adapters.py") },
    # Postgres behaviour: the dedup constraint, the append-only trigger, keyset
    # export paging, and retention pruning.
    @{ Name = "storage: dedup, immutability, paging, retention"; Args = @("tests\verify_event_storage.py") },
    # The reliability contract. Checkpoints only advance for a scope that was
    # fully read - the invariant that keeps the trail complete.
    @{ Name = "collector: checkpointing, retries, failure isolation"; Args = @("tests\verify_event_collector.py") },
    # HTTP surface: status codes, response shape, filter validation, RBAC.
    @{ Name = "HTTP API + RBAC"; Args = @("tests\verify_event_api.py") }
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
    Write-Host "All Event Log suites passed." -ForegroundColor Green
    exit 0
}
Write-Host "$failed Event Log suite(s) failed." -ForegroundColor Red
exit 1
