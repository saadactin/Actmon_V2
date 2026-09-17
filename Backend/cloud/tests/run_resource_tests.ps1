# Resource workspace verification. Run from Backend/cloud:
#   .\tests\run_resource_tests.ps1
#
# Kept ASCII-only on purpose: powershell.exe reads .ps1 as ANSI unless there is
# a BOM, and a stray non-ASCII character desyncs the parser.
$py = ".\venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "No venv. Run: py -3 -m venv venv; venv\Scripts\python.exe -m pip install -r requirements.txt" -ForegroundColor Red
    exit 1
}

$suites = @(
    # Normalization. Three providers, three vocabularies, and one rule that
    # decides every one of them: a missing value is never upgraded into a good
    # one. The load-bearing case is the Azure VM whose status column holds a
    # PROVISIONING state -- 'Succeeded' means ARM finished building it and says
    # nothing about whether it is running. 57 of this estate's 75 Azure VMs are
    # in exactly that state, so reading it as "on" would paint most of the
    # fleet green on no evidence. Pure logic, no DB.
    @{ Name = "normalization: status, type, freshness, tags (no DB)"; Args = @("tests\verify_resource_model.py") },
    # What each provider integration can actually DO with a resource, checked
    # against the provider classes themselves so a flag cannot outlive the
    # method backing it. The entry that must never quietly flip: every mutating
    # capability is false, because app/providers/ contains no write call at
    # all. A Delete button must not ship ahead of the permission check, the
    # dependency check and the audit trail. Pure logic, no DB.
    @{ Name = "provider capabilities + source cross-check (no DB)"; Args = @("tests\verify_resource_capabilities.py") },
    # The server-side query itself: pagination, filters, sorting, facets,
    # grouping, export. Two assertions carry the weight. Unknown sorts LAST in
    # both directions -- Postgres puts NULLs first on DESC, so "most expensive"
    # would otherwise open with every resource whose cost nobody knows. And
    # "no findings" is kept distinct from "never assessed", because collapsing
    # them renders a brand-new account as an estate with perfect posture.
    # Creates and removes its own accounts; asserts the count is restored.
    @{ Name = "server-side query: paging, filters, sort, facets, export"; Args = @("tests\verify_resource_query.py") },
    # HTTP surface. Leads with route ordering because /{account_id} is a
    # single-segment path that matches any literal declared after it -- the
    # identical shape in the cost routes swallowed /cloud/cost/budgets and made
    # it 422 on a UUID parse. Also pins the error envelope, the page-size cap,
    # and that every route declares a permission.
    @{ Name = "HTTP API: route order, error envelope, RBAC, CSV"; Args = @("tests\verify_resource_api.py") },
    # Saved views. A stored view is a stored REQUEST, so it is validated by
    # building the real query rather than by checking key names against a list
    # kept alongside it -- a view that saves cleanly and then fails when
    # applied is worse than one that refuses to save. The other entry that
    # matters: a stored filter the query layer no longer supports is dropped
    # AND reported, because silently ignoring it returns more rows than the
    # view used to and still looks like it worked.
    @{ Name = "saved views: validation, overwrite, scope, ownership"; Args = @("tests\verify_resource_views.py") },
    # The account Overview. It is an aggregation layer, so its failure mode is
    # not a crash -- it is quietly disagreeing with the page it links to. The
    # entry that must never flip: there is exactly ONE security source. The
    # dashboard used to call an older engine that scored oci_test 0/F while the
    # Security Center scored the same account 35/F, so clicking through to "see
    # the detail" changed the number. Checked against the frontend source, not
    # just the API, because the second engine was a second CALL.
    @{ Name = "overview: one security source, no estate download, counts reconcile"; Args = @("tests\verify_overview.py") },
    # Resource actions. This suite guards a deliberate CLOSED state: nothing can
    # mutate a cloud resource, because no adapter in app/providers/ implements a
    # write. If a "supported" assertion here starts failing, a capability flag
    # has been turned on and this is the alarm. The other entry that matters:
    # a resource the topology graph cannot place reports its dependents as
    # UNKNOWN, never as none -- "nothing depends on this" is the most dangerous
    # sentence a delete confirmation can get wrong.
    @{ Name = "resource actions: gates, dependencies, audit, idempotency"; Args = @("tests\verify_resource_actions.py") }
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
    Write-Host "All resource suites passed." -ForegroundColor Green
    exit 0
}
Write-Host "$failed resource suite(s) failed." -ForegroundColor Red
exit 1
