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
    # Contextual risk and attack paths. The negative half is load-bearing:
    # missing evidence must never dampen a finding, and an UNKNOWN exposure
    # must never start an attack path. Both would invent safety. Pure logic.
    @{ Name = "contextual risk + attack-path traversal (no DB)"; Args = @("tests\verify_attack_paths.py") },
    # The declarative rule DSL. The load-bearing test is the equivalence matrix:
    # a YAML rule and the hand-written rule it mirrors must agree on every
    # input, especially absent and null, or "migrate a rule to YAML" is a
    # hopeful operation rather than a safe one. Pure logic.
    @{ Name = "declarative rule packs + YAML/Python equivalence (no DB)"; Args = @("tests\verify_rulepack.py") },
    # Software identity and the vulnerability provider seam. The property that
    # matters: with no feed configured nothing may read as "no vulnerabilities",
    # and an OS is never inferred from a resource name. Pure logic.
    @{ Name = "software identity + honest zero without a CVE feed (no DB)"; Args = @("tests\verify_vulnerability.py") },
    # Secrets detection. The load-bearing assertion is that no input value
    # survives into any output -- a tool that stores the secrets it finds has
    # enlarged the problem it was bought to shrink. Pure logic.
    @{ Name = "secrets detection + no-leak guarantee (no DB)"; Args = @("tests\verify_secrets.py") },
    # Ransomware resilience posture. Object Lock, MFA Delete and backup policy
    # are collected by nothing, so the suite pins that NOT_ASSESSED can never
    # render as configured, and that no score is produced from a partial view.
    @{ Name = "ransomware resilience posture (no DB)"; Args = @("tests\verify_ransomware.py") },
    # Behavioural detection and incident correlation. Pins that a detector whose
    # input field is empty reports UNAVAILABLE rather than a clean result, and
    # that an incident needs two DIFFERENT kinds of signal. Pure logic.
    @{ Name = "threat detection + incident correlation (no DB)"; Args = @("tests\verify_threat.py") },
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
