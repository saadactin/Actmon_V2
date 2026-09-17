# Frontend verification. Run from the frontend directory:
#   .\tests\run_frontend_tests.ps1
#
# This project has no component-test framework (no vitest, no jest), so this
# covers the pure logic only -- the part where a silent defect is both most
# likely and least visible. Rendering is verified by `npm run build` plus
# opening the page.
#
# Kept ASCII-only on purpose: powershell.exe reads .ps1 as ANSI unless there is
# a BOM, and a stray non-ASCII character desyncs the parser.
$ErrorActionPreference = "Stop"

# Vite resolves extensionless relative imports and node does not, so the suites
# run behind a resolve hook rather than making src/ carry extensions for the
# benefit of a test runner.
$import = "./tests/register.mjs"

$suites = @(
    # The Resources workspace's presentation model. Two properties carry the
    # weight. A filter must survive a round trip through the URL -- a shared
    # link that silently drops `has_tags=false` sends someone a different view
    # from the one being discussed. And absent must never become zero: an
    # unpriced resource reads NA, an unassessed one reads "not assessed", and
    # an Azure VM reporting PROVISIONING is never painted as running.
    @{ Name = "resource presentation model: URL round trip, NA discipline"; Path = "tests/verify_resource_model.mjs" },
    # The filter wire format, both directions. This one exists because of saved
    # views: a view is STORED in the backend's vocabulary and REOPENED in the
    # UI's, so if the two mappings ever disagree a saved view quietly reopens as
    # a different query -- same name, different rows, nothing visibly wrong.
    @{ Name = "filter wire format: saved-view round trip"; Path = "tests/verify_resource_filters.mjs" }
)

$failed = 0
foreach ($s in $suites) {
    Write-Host ""
    Write-Host "=== $($s.Name) ===" -ForegroundColor Cyan
    & node --import $import $s.Path
    if ($LASTEXITCODE -ne 0) {
        $failed++
        Write-Host "SUITE FAILED: $($s.Name)" -ForegroundColor Red
    }
}

Write-Host ""
if ($failed -eq 0) {
    Write-Host "All frontend suites passed." -ForegroundColor Green
    exit 0
}
Write-Host "$failed frontend suite(s) failed." -ForegroundColor Red
exit 1
