# Multi-Cloud Topology verification. Run from Backend/cloud:
#   .\tests\run_topology_tests.ps1
#
# Kept ASCII-only on purpose: powershell.exe reads .ps1 as ANSI unless there is
# a BOM, and a stray non-ASCII character desyncs the parser.
$py = ".\venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "No venv. Run: py -3 -m venv venv; venv\Scripts\python.exe -m pip install -r requirements.txt" -ForegroundColor Red
    exit 1
}

$suites = @(
    # What the topology CLAIMS is connected. Two halves: every supported
    # provider relationship produces an edge, and nothing else does. The
    # negative half matters more - a wrong edge is indistinguishable from a
    # real one. Pure logic, no DB, no network.
    @{ Name = "relationship rules + negative tests (no DB)"; Args = @("tests\verify_topology_rules.py") },
    # Traversal, path finding, impact direction, coverage arithmetic, and
    # whether all of it stays fast at 10,000 nodes.
    @{ Name = "graph traversal, impact, scale (no DB)"; Args = @("tests\verify_topology_graph.py") },
    # HTTP surface: status codes, response shape, filters, export, RBAC,
    # snapshots and cache invalidation. Creates and removes its own account.
    @{ Name = "HTTP API + RBAC + export"; Args = @("tests\verify_topology_api.py") }
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
    Write-Host "All topology suites passed." -ForegroundColor Green
    exit 0
}
Write-Host "$failed topology suite(s) failed." -ForegroundColor Red
exit 1
