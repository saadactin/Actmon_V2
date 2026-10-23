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

# Vite resolves extensionless relative imports and node does not, so every
# suite runs behind a resolve hook rather than making src/ carry extensions
# for the benefit of a test runner. Always applied, with no per-suite
# opt-out: the hook only intervenes when node's own resolution FAILS (see
# ext-loader.mjs), so it is a true no-op for a module that already uses an
# explicit extension. There is no such thing as "this suite doesn't need
# the loader" -- there is only "this suite's imports happen not to trigger
# it today", which is not a property worth tracking per suite.
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
    @{ Name = "filter wire format: saved-view round trip"; Path = "tests/verify_resource_filters.mjs" },
    # The Alerts vocabulary. The load-bearing assertion is that none of the
    # three inconclusive evaluation states (UNKNOWN, ERROR, UNSUPPORTED) is
    # ever painted as healthy -- a monitoring tab that renders "could not read
    # the data" in the same green as "checked, all clear" is worse than one
    # that shows nothing. Also guards that alert state and EMAIL state never
    # share a word, and that the Overview consumes alert counts rather than
    # inventing its own.
    @{ Name = "alerts vocabulary: NA discipline, six states, attention items"; Path = "tests/verify_alerts_model.mjs" },
    # The Alerts API layer's wire format -- what axios actually sends, not
    # what the JS object looks like. Found and pins a real bug: listInstances
    # sent `state` as an array with no paramsSerializer, so axios emitted
    # `state[]=` while the backend's `List[str]` param only reads repeated
    # `state=` keys. The "Open" view listed resolved alerts on every load.
    @{ Name = "alerts API wire format: state[]= regression, verbs, destructive defaults"; Path = "tests/verify_api_alerts_wire.mjs" },
    # The Event Log API layer's wire format: all 30 filter keys against the
    # exact backend Query() names, and the property that matters most --
    # exportEvents must send the SAME filters as getEvents, or the
    # downloaded file silently disagrees with the table it came from.
    @{ Name = "events API wire format: 30 filters, export/table parity, timeouts"; Path = "tests/verify_api_events_wire.mjs" },
    # Security Center + Topology wire formats. Security Center joins arrays
    # with COMMAS; Topology's resources.api.js-style modules use repeated
    # keys -- two dialects in one codebase, both pinned so a "let's unify
    # this" refactor cannot silently break either one. Also pins that a
    # topology export can never drop a filter and return the whole graph.
    @{ Name = "security/topology API wire format: comma-joins, control-id encoding, export parity"; Path = "tests/verify_api_security_topology_wire.mjs" },
    # Cost/Drift/Overview wire formats. The load-bearing rule: getCostHistory
    # with only ONE of startDate/endDate must fall back to `days` and send
    # NEITHER date -- otherwise a chart can silently cover a different period
    # than the one its own title claims. Also pins the Overview reading
    # /security-center/{id}, not /security/{id} -- the fix for the two
    # security engines that used to disagree about the same account's score.
    @{ Name = "cost/drift/overview API wire format: custom-range rule, verb safety"; Path = "tests/verify_api_cost_drift_wire.mjs" },
    # The cross-cutting check: parses every @router.<verb>(...) and Query(...)
    # declaration straight from Backend/cloud/app/api/routes/*.py, then drives
    # all 13 api modules and asserts each request matches a real backend
    # route by path, method AND query-param names. This is what would have
    # caught cost.api.js's dead getAccountDiagnostic mechanically (it hit
    # /cloud-accounts/{id}/diagnostic, which matches nothing) instead of by
    # someone happening to notice.
    @{ Name = "API route contract: every frontend call matches a real backend route"; Path = "tests/verify_api_routes_contract.mjs" },
    # Money formatting. One rule governs it: null is NA and NA is not zero,
    # asserted in BOTH directions. Also pins that rising COST is toned red --
    # the opposite of most metrics, and the most likely well-meant "fix".
    @{ Name = "cost formatting: NA vs zero, lakh/crore, palette, cost-is-inverted tones"; Path = "tests/verify_cost_format.mjs" },
    # Graph placement. The highest-value assertion in the frontend: every
    # node gets a FINITE coordinate in all four layouts, for every category
    # the model defines. One NaN silently blanks the whole canvas, and with
    # the HMR overlay disabled there is nothing on screen to say why.
    @{ Name = "topology layout: finite coordinates, determinism, clustering"; Path = "tests/verify_topology_layout.mjs" },
    # The topology vocabulary. Pins that an IAM permission edge is DASHED --
    # drawing it solid turns "is allowed to reach" into "does reach", which
    # is a security lie in a diagram used to reason about blast radius.
    @{ Name = "topology model: category/order parity, dashed permission edges, badges"; Path = "tests/verify_topology_model.mjs" },
    # The Security Center vocabulary. Makes a product rule executable: this
    # product never tells anyone they are "secure" or "compliant", and
    # "Not determined" never looks like "clear".
    @{ Name = "security model: never claims secure/compliant, unknown is not a pass"; Path = "tests/verify_security_model.mjs" },
    # Clients, client reports and the certificate inventory. Money is never
    # merged across currencies and NA is never 0; posture is the worst score,
    # never an average; "nothing expiring" is green only when every store was
    # read; and no delivery label says sent when the e-mail was only queued.
    # The second half is parity with the backend PARSED FROM ITS SOURCE --
    # sections, delivery states, buckets, collection states, kinds, the
    # client-code rule, onboarding outcomes, scheduler statuses.
    @{ Name = "clients model: per-currency money, worst-not-average, queued-not-sent, backend parity"; Path = "tests/verify_clients_model.mjs" },
    # "What can I do" for one certificate / secret / key. Unknown use is never
    # "unused" (nothing leads with a deletion until it has said how to find
    # out), commands carry the object's real identifiers in an order that
    # breaks nothing (switch listeners, THEN delete), and every store the
    # backend collects -- parsed from its source -- has guidance.
    @{ Name = "credential guidance: unknown-is-not-unused, real ids, safe order, store parity"; Path = "tests/verify_credential_guidance.mjs" },
    # Event Log vocabulary and time handling. TIME_RANGES and RANGE_HOURS are
    # checked in both directions -- add a range to the selector and forget the
    # hour mapping and "Collect now" fetches the wrong window under the right
    # label, with no error anywhere.
    @{ Name = "event formatting: range/hours parity, UTC invariance, advice for red badges"; Path = "tests/verify_event_format.mjs" },
    # Provider/region/account scope. Oracle and OCI are one provider, a null
    # provider key means NO filter, and three OCI availability domains
    # collapse to one region (the bug that showed five "regions" for a
    # two-region tenancy).
    @{ Name = "scope model: Oracle/OCI alias, null-key-means-all, AZ collapsing"; Path = "tests/verify_scope_model.mjs" },
    # Static checks on the Alerts UI source. `npm run build` proves the modules
    # resolve; it says nothing about whether an icon name exists, whether a
    # Tailwind class will ever be generated, or whether a prop name matches
    # what the component destructures. All three fail SILENTLY at runtime, so
    # with no component-test framework this is the only thing that catches them.
    @{ Name = "alerts UI: icon names, static classes, prop contracts"; Path = "tests/verify_alerts_ui.mjs" },
    # The same idea as the suite above, generalised from 14 alert files to all
    # 125 files under features/cloud, plus rules that only make sense
    # tree-wide: every named import resolves to a real export, no page
    # reloads, raw hex only where it is documented as sanctioned, and
    # REFRESHED_ROOTS matching the query keys the hooks actually use. Kept
    # alongside the alerts-only suite rather than replacing it -- the
    # narrower one is fast and its specific prop traps are worth keeping.
    @{ Name = "cloud UI (all 125 files): icons, imports, props, tokens, query roots"; Path = "tests/verify_cloud_ui.mjs" },
    # Account refresh's model layer: the invalidation predicate that decides
    # which cached queries a completed refresh makes stale. Was orphaned from
    # this runner entirely until now -- 113 assertions that never ran as part
    # of "run the frontend suite". A wrong predicate here fails silently: cost
    # or security data just keeps showing pre-refresh numbers, with no error
    # anywhere to notice.
    @{ Name = "account refresh model: invalidation predicate, outcome messages"; Path = "src/features/cloud/utils/__tests__/refreshModel.test.mjs" },
    # Per-tab refresh: which tabs re-read the provider vs stored data, viewers
    # never offered provider work, provider work held while Refresh all runs,
    # and captions that never claim more than the response confirmed.
    @{ Name = "tab refresh model: source honesty, permissions, busy hold, captions"; Path = "src/features/cloud/utils/__tests__/tabRefreshModel.test.mjs" },
    # Resource Intelligence: unknown is never zero (N/A with the backend's
    # reason), filters survive the URL, and a summary card opens exactly the
    # list it counted.
    @{ Name = "intelligence model: N/A discipline, URL round trip, card filters"; Path = "src/features/cloud/utils/__tests__/intelligenceModel.test.mjs" },
    # Report builder: every option parsed against the backend schema (an
    # option it refuses fails the preview with a bare 422), old session drafts
    # mapped forward instead of refused, and the server's own message read out
    # of a Blob error body instead of "Request failed with status code 400".
    @{ Name = "report model: backend option parity, draft migration, Blob errors, NA"; Path = "src/features/cloud/utils/__tests__/reportModel.test.mjs" }
)

# ---- Discovery guard: catch the NEXT orphaned suite, not just this one ----
# This is the actual fix, not the one line above. A suite file that exists
# on disk but isn't in $suites above ran zero times and reported zero
# failures -- indistinguishable from a suite that doesn't need to exist.
# That is precisely how refreshModel.test.mjs went unrun despite having 113
# real assertions. Checked in both directions: unlisted-but-present, and
# listed-but-missing (a rename the runner would otherwise silently skip).
$repoRoot = (Get-Item .).FullName
$foundOnDisk = @()
if (Test-Path "tests") {
    $foundOnDisk += Get-ChildItem -Path "tests" -Filter "verify_*.mjs" -File |
        ForEach-Object { "tests/$($_.Name)" }
}
if (Test-Path "src") {
    $foundOnDisk += Get-ChildItem -Path "src" -Recurse -Filter "*.test.mjs" -File |
        ForEach-Object {
            ($_.FullName.Substring($repoRoot.Length + 1)) -replace '\\', '/'
        }
}

$listedPaths = $suites | ForEach-Object { $_.Path }
$unlisted = $foundOnDisk | Where-Object { $listedPaths -notcontains $_ }
$dangling = $listedPaths | Where-Object { -not (Test-Path $_) }

$guardFailed = $false
if ($unlisted) {
    Write-Host ""
    Write-Host "GUARD FAILED: suite file(s) exist but are not declared in `$suites above:" -ForegroundColor Red
    $unlisted | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Write-Host "Add each to run_frontend_tests.ps1, or it will never run." -ForegroundColor Red
    $guardFailed = $true
}
if ($dangling) {
    Write-Host ""
    Write-Host "GUARD FAILED: suite(s) declared above but missing on disk:" -ForegroundColor Red
    $dangling | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Write-Host "The suite was renamed or deleted; update run_frontend_tests.ps1." -ForegroundColor Red
    $guardFailed = $true
}

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
if ($failed -gt 0) {
    Write-Host "$failed frontend suite(s) failed." -ForegroundColor Red
    exit 1
}
if ($guardFailed) {
    Write-Host "All listed suites passed, but the discovery guard failed -- see above." -ForegroundColor Red
    exit 1
}
Write-Host "All frontend suites passed." -ForegroundColor Green
exit 0
