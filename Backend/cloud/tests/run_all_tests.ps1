# The master test runner. Run from Backend/cloud:
#   .\tests\run_all_tests.ps1              # everything, ~18-25 min
#   .\tests\run_all_tests.ps1 -NoDb         # pure logic only, ~2.5 min
#   .\tests\run_all_tests.ps1 -Area cost    # one area
#   .\tests\run_all_tests.ps1 -Tier 0,1     # meta + pure logic
#   .\tests\run_all_tests.ps1 -Only *drift* # glob on filename
#   .\tests\run_all_tests.ps1 -ListOnly     # show the manifest, run nothing
#
# Kept ASCII-only on purpose: powershell.exe reads .ps1 as ANSI unless there
# is a BOM, and a stray non-ASCII character desyncs the parser.
#
# The suite list lives in ONE place: tests\suite_manifest.py. This script
# reads it via a subprocess rather than declaring its own copy, so the
# PowerShell runner and tests\verify_suite_manifest.py (which checks that
# every verify_*.py on disk is in that same list) can never disagree about
# what should run. Before this file existed, running every area's own
# run_<area>_tests.ps1 still missed two suites -- verify_account_refresh.py
# and verify_exposure_logic.py -- because nothing declared they should run
# anywhere. That is the gap this file exists to close permanently: the
# anti-drift guard (Tier 0) fails loudly the next time a suite is added and
# not wired in, rather than the omission going unnoticed for weeks.
#
# Deliberately SEQUENTIAL, tier by tier, suite by suite. Every Postgres-backed
# suite purges its own zz<area>-test-% rows on the way in (self-healing after
# a crashed run) -- two such suites running concurrently would purge each
# other's fixtures mid-run and fail nondeterministically for a reason that
# has nothing to do with what either suite claims to test. Do not
# "optimise" this into parallel jobs without first narrowing every suite's
# purge from the bare zz-test-% it uses today to its own zz<area>-test-%.
param(
    [string[]]$Area = @(),
    [string]$Only = "",
    [int[]]$Tier = @(),
    [switch]$ListOnly,
    [switch]$FailOnSkip,
    [switch]$NoDb
)

$py = ".\venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "No venv. Run: py -3 -m venv venv; venv\Scripts\python.exe -m pip install -r requirements.txt" -ForegroundColor Red
    exit 1
}

# One process reads the manifest as JSON. If suite_manifest.py itself fails
# to import (a real possibility -- it's Python, not data), that failure
# surfaces here immediately rather than as a confusing empty suite list.
$manifestJson = & $py -c "import json, sys; sys.path.insert(0, 'tests'); import suite_manifest; print(json.dumps(suite_manifest.SUITES))" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Could not read tests\suite_manifest.py:" -ForegroundColor Red
    Write-Host $manifestJson
    exit 1
}
$allSuites = $manifestJson | ConvertFrom-Json

# Stamp each entry with its position in the manifest. Windows PowerShell 5.1's
# Sort-Object is NOT stable and has no -Stable switch, so sorting by Tier alone
# can still reshuffle same-tier entries -- which is exactly what put
# verify_alert_persistence.py's `read` phase before its `write` phase. Sorting
# by (Tier, Ordinal) keeps tiers in order AND the manifest's own order inside
# each one.
$ordinal = 0
foreach ($s in $allSuites) {
    $s | Add-Member -NotePropertyName Ordinal -NotePropertyValue $ordinal -Force
    $ordinal++
}

# ---- Filter ------------------------------------------------------------
$suites = $allSuites
if ($Area.Count -gt 0) {
    $suites = $suites | Where-Object { $Area -contains $_.Area }
}
if ($Tier.Count -gt 0) {
    $suites = $suites | Where-Object { $Tier -contains $_.Tier }
}
if ($Only -ne "") {
    $suites = $suites | Where-Object { $_.File -like $Only }
}
if ($NoDb) {
    $suites = $suites | Where-Object { -not $_.Db }
}

if ($ListOnly) {
    Write-Host ""
    # Sorted by Tier only, so -ListOnly shows the ACTUAL execution order
    # (manifest order within each tier). Sorting further here would make the
    # listing disagree with what the runner really does.
    $suites | Sort-Object Tier, Ordinal | ForEach-Object {
        $dbTag = if ($_.Db) { "[DB]" } else { "[  ]" }
        $argsTag = if ($_.Args) { " " + ($_.Args -join " ") } else { "" }
        Write-Host ("  T{0} {1,-4} {2,-17} {3}{4}" -f $_.Tier, $dbTag, $_.Area, $_.File, $argsTag)
    }
    Write-Host ""
    Write-Host "$($suites.Count) suite invocation(s) would run."
    exit 0
}

if ($suites.Count -eq 0) {
    Write-Host "No suites matched the given filters." -ForegroundColor Yellow
    exit 0
}

# ---- Environment guards -------------------------------------------------
# Belt and braces against a suite that imports a background-loop module
# directly (rather than only through the ASGI app, which never runs the
# lifespan): none of these three loops -- or a real refresh/discovery -- may
# fire during a test run. CLOUD_TEST_MODE is the interlock new suites can
# check for and refuse to proceed if it is absent.
$env:EVENT_COLLECTOR_ENABLED = "false"
$env:REFRESH_SCHEDULER_ENABLED = "false"
$env:ALERT_ENGINE_ENABLED = "false"
$env:CLOUD_TEST_MODE = "1"

# ---- Run, tier by tier ---------------------------------------------------
# The bracket-less "PASS n   FAIL n   SKIP n" tail (used by the manifest
# guard and the alert-rules suite) previously matched NONE of the older
# runners' filter patterns, so their skip counts were silently discarded --
# exactly the dialect that reports skips, undermining "a skip is not a
# pass" for the two suites that actually say so. This pattern is the union
# of every dialect in use: the bracketed per-check lines, both summary
# tails, and the failure signatures that indicate a crashed harness.
$linePattern = '\[FAIL\]|\[SKIP\]|Traceback|^\s*FAILED|^\s*Error:'
$tailPatternA = '^===\s*(\d+)\s+passed,\s*(\d+)\s+failed\s*===\s*$'
$tailPatternB = '^(\d+)\s+passed,\s*(\d+)\s+failed\s*$'
$tailPatternC = '^PASS\s+(\d+)\s+FAIL\s+(\d+)\s+SKIP\s+(\d+)\s*$'

$areaStats = @{}
$totalPass = 0; $totalFail = 0; $totalSkip = 0; $failedSuites = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()

foreach ($tierNum in ($suites.Tier | Sort-Object -Unique)) {
    $tierSuites = $suites | Where-Object { $_.Tier -eq $tierNum }
    Write-Host ""
    Write-Host ("##### Tier {0} ({1} suite(s)) #####" -f $tierNum, $tierSuites.Count) -ForegroundColor Magenta

    # MANIFEST ORDER, deliberately not sorted. Sorting by Area/File looks
    # tidier and silently breaks the one suite whose order is load-bearing:
    # verify_alert_persistence.py runs --phase write and then --phase read in
    # two separate processes, which is the whole way it proves alerts outlive
    # a restart. Both entries share an Area and a File, so any sort on those
    # keys can put `read` first -- and it did, making the read phase assert
    # against data the write phase had not created yet. suite_manifest.py is
    # already grouped by area; its order is the intended order.
    foreach ($s in ($tierSuites | Sort-Object Ordinal)) {
        $label = if ($s.Label) { $s.Label } else { $s.File }
        $extraArgs = if ($s.Args) { $s.Args } else { @() }
        $invokeArgs = @($s.File) + $extraArgs

        Write-Host ""
        Write-Host "=== [$($s.Area)] $label ===" -ForegroundColor Cyan

        $suiteSw = [System.Diagnostics.Stopwatch]::StartNew()
        $output = & $py @invokeArgs 2>&1
        $suiteSw.Stop()
        $exitCode = $LASTEXITCODE

        $output | Select-String -Pattern $linePattern | ForEach-Object { Write-Host $_.Line }

        $pass = 0; $fail = 0; $skip = 0; $parsed = $false
        foreach ($line in $output) {
            if ($line -match $tailPatternA) {
                $pass = [int]$Matches[1]; $fail = [int]$Matches[2]; $parsed = $true; break
            }
            if ($line -match $tailPatternC) {
                $pass = [int]$Matches[1]; $fail = [int]$Matches[2]; $skip = [int]$Matches[3]; $parsed = $true; break
            }
            if ($line -match $tailPatternB) {
                $pass = [int]$Matches[1]; $fail = [int]$Matches[2]; $parsed = $true; break
            }
        }

        if (-not $parsed) {
            Write-Host "  (could not parse a summary line; judging by exit code only)" -ForegroundColor DarkYellow
            if ($exitCode -ne 0) { $fail = 1 } else { $pass = 1 }
        }

        # Belt and braces: a suite reporting FAIL 0 but exiting non-zero (or
        # the reverse) is a suite whose harness disagrees with itself. Either
        # counts as a failure for the run as a whole.
        $suiteFailed = ($exitCode -ne 0) -or ($fail -gt 0)
        if ($suiteFailed) {
            $failedSuites++
            Write-Host ("SUITE FAILED: [{0}] {1} ({2:N1}s)" -f $s.Area, $label, $suiteSw.Elapsed.TotalSeconds) -ForegroundColor Red
        } else {
            Write-Host ("  ok  ({0:N1}s)  PASS {1}  FAIL {2}  SKIP {3}" -f $suiteSw.Elapsed.TotalSeconds, $pass, $fail, $skip) -ForegroundColor Green
        }

        if (-not $areaStats.ContainsKey($s.Area)) {
            $areaStats[$s.Area] = @{ Suites = 0; Pass = 0; Fail = 0; Skip = 0; Seconds = 0.0 }
        }
        $areaStats[$s.Area].Suites += 1
        $areaStats[$s.Area].Pass += $pass
        $areaStats[$s.Area].Fail += $fail
        $areaStats[$s.Area].Skip += $skip
        $areaStats[$s.Area].Seconds += $suiteSw.Elapsed.TotalSeconds
        $totalPass += $pass; $totalFail += $fail; $totalSkip += $skip
    }
}

$sw.Stop()

# ---- Summary --------------------------------------------------------------
Write-Host ""
Write-Host "==================================================================="
Write-Host ("{0,-18} {1,7} {2,6} {3,6} {4,6} {5,8}" -f "AREA", "SUITES", "PASS", "FAIL", "SKIP", "TIME")
foreach ($areaName in ($areaStats.Keys | Sort-Object)) {
    $a = $areaStats[$areaName]
    Write-Host ("{0,-18} {1,7} {2,6} {3,6} {4,6} {5,7:N1}s" -f $areaName, $a.Suites, $a.Pass, $a.Fail, $a.Skip, $a.Seconds)
}
Write-Host "-------------------------------------------------------------------"
Write-Host ("{0,-18} {1,7} {2,6} {3,6} {4,6} {5,7:N1}s" -f "TOTAL", $suites.Count, $totalPass, $totalFail, $totalSkip, $sw.Elapsed.TotalSeconds)

if ($totalSkip -gt 0) {
    Write-Host ""
    Write-Host "$totalSkip check(s) were SKIPPED across the run -- these are NOT passes." -ForegroundColor Yellow
    Write-Host "Skips usually mean Postgres was unreachable for that suite's DB section." -ForegroundColor Yellow
}

Write-Host ""
if ($failedSuites -gt 0) {
    Write-Host "$failedSuites suite invocation(s) failed." -ForegroundColor Red
    exit 1
}
if ($FailOnSkip -and $totalSkip -gt 0) {
    Write-Host "Passing, but failing the run because -FailOnSkip was set and $totalSkip check(s) were skipped." -ForegroundColor Red
    exit 1
}
Write-Host "All suites passed." -ForegroundColor Green
exit 0
