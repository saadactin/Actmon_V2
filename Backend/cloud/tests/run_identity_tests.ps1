# Identity & Access (CIEM) verification. Run from Backend/cloud:
#   .\tests\run_identity_tests.ps1
#
# Kept ASCII-only on purpose: powershell.exe reads .ps1 as ANSI unless there is
# a BOM, and a stray non-ASCII character desyncs the parser.
$py = ".\venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "No venv. Run: py -3 -m venv venv; venv\Scripts\python.exe -m pip install -r requirements.txt" -ForegroundColor Red
    exit 1
}

$suites = @(
    # The vocabulary and the capability mapper. The headline property is the
    # DIRECTION of the glob match: the grant is the pattern and a concrete
    # operation is the string. Backwards, this reported Azure's built-in Reader
    # as full subscription control on 23 live assignments.
    @{ Name = "vocabulary + capability mapper (no DB)"; Args = @("tests\verify_identity_model.py") },
    # The three effective-permission evaluators against the semantics they
    # model: AWS deny precedence and uncollected SCPs, Azure NotActions scoping
    # and the control/data plane split, OCI ranked verbs and allow-only policy.
    @{ Name = "AWS/Azure/OCI effective permissions (no DB)"; Args = @("tests\verify_identity_evaluation.py") },
    # Everything derived from the inventory plus the Event Log, and the §35
    # rule that runs through all of it: missing data never becomes a
    # reassuring value.
    @{ Name = "usage, dormancy, credentials, trust, blast radius (no DB)"; Args = @("tests\verify_identity_analysis.py") },
    # One finding engine, not two: the analyser's rule ids and the Security
    # Center registry must agree in both directions. Also the scoped
    # persistence that stops a partial producer resolving another analyser's
    # findings, and the authorization boundary.
    @{ Name = "findings = registry, scoped persistence, RBAC (no DB)"; Args = @("tests\verify_identity_findings.py") }
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
    Write-Host "All identity suites passed." -ForegroundColor Green
    exit 0
}
Write-Host "$failed identity suite(s) failed." -ForegroundColor Red
exit 1
