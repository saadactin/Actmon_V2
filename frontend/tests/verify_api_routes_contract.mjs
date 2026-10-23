// The cross-cutting check: does every frontend api call actually match a
// backend route, by path AND method AND query-param names?
//
// This is what would have caught cost.api.js's getAccountDiagnostic (Bug B)
// mechanically, rather than by someone happening to notice the URL was
// wrong: it hit `/cloud-accounts/{id}/diagnostic`, which matches no backend
// route at all (the real one is `/accounts/{id}/diagnostics` — different
// prefix, plural). The wire-format suites check each module's OWN
// consistency; this suite checks the module against the OTHER side of the
// wire — the actual `@router.get/post/put/patch/delete(...)` declarations
// and `Query(...)` parameters in Backend/cloud/app/api/routes/*.py, parsed
// from source, not retyped by hand.
//
// Deliberately conservative about what counts as a match: a route whose
// path is `{control_id:path}` is treated as a wildcard that can consume a
// slash-bearing segment, matching FastAPI's own `:path` converter
// semantics. Everything else is exact-segment matching.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudAxios } from '../src/features/cloud/api/axios.js';
import * as accounts from '../src/features/cloud/api/cloudAccounts.api.js';
import * as certificates from '../src/features/cloud/api/certificates.api.js';
import * as clients from '../src/features/cloud/api/clients.api.js';
import * as alerts from '../src/features/cloud/api/alerts.api.js';
import * as cost from '../src/features/cloud/api/cost.api.js';
import * as discovery from '../src/features/cloud/api/discovery.api.js';
import * as drift from '../src/features/cloud/api/drift.api.js';
import * as events from '../src/features/cloud/api/events.api.js';
import * as intelligence from '../src/features/cloud/api/intelligence.api.js';
import * as overview from '../src/features/cloud/api/overview.api.js';
import * as refresh from '../src/features/cloud/api/refresh.api.js';
import * as reports from '../src/features/cloud/api/reports.api.js';
import * as resources from '../src/features/cloud/api/resources.api.js';
import * as security from '../src/features/cloud/api/security.api.js';
import * as securityCenter from '../src/features/cloud/api/securityCenter.api.js';
import * as topology from '../src/features/cloud/api/topology.api.js';

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

// ── 1. Parse the backend route declarations from source ────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, '../../Backend/cloud/app/api/routes');

/** Scans forward from `defIdx` for `def`'s parameter list, balancing parens
 *  so a multi-line signature (every route handler in this codebase) is
 *  captured whole. */
function extractSignature(source, defIdx) {
  const openParen = source.indexOf('(', defIdx);
  let depth = 0;
  let i = openParen;
  for (; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(openParen + 1, i);
}

// Query(...) matches whose text spans a second parameter -- `a: T, b: U = Query(`
// on one line. The pattern below then attributes b's Query to `a` and b's
// real wire name is lost; the preview route's `period` was read as
// `client_id` exactly this way. Collected here and failed loudly below
// rather than silently mis-parsed.
const AMBIGUOUS_QUERY = [];

/** Every `name: ... = Query(...)` in a signature, mapped to its wire name
 *  (the `alias=` value when present, else the parameter name itself). */
function extractQueryParams(sigText) {
  const wireNames = new Set();
  const re = /(\w+)\s*:\s*[^=\n]*?=\s*Query\(/g;
  let m;
  while ((m = re.exec(sigText))) {
    const varName = m[1];
    if (/,\s*\w+\s*:/.test(m[0])) AMBIGUOUS_QUERY.push(m[0].replace(/\s+/g, ' '));
    // re.lastIndex sits right after the "(" the match already consumed, so
    // that character is at index (lastIndex - 1) -- depth starts at 1 to
    // account for it, and the scan begins on the NEXT character. Starting
    // the scan AT that "(" (as an earlier version of this function did)
    // double-counts it: depth opens at 2 instead of 1, so the balance scan
    // needs an extra ")" to close and swallows straight through the next
    // Query(...) call, silently merging two params' alias text together
    // and dropping the first param entirely. Caught by this suite's own
    // floor check when it under-counted account_id on events.py's
    // /facets route.
    const openIdx = re.lastIndex - 1;
    let depth = 1;
    let i = openIdx + 1;
    for (; i < sigText.length; i++) {
      if (sigText[i] === '(') depth++;
      else if (sigText[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const callText = sigText.slice(openIdx, i + 1);
    const aliasMatch = callText.match(/alias\s*=\s*"([^"]+)"/);
    wireNames.add(aliasMatch ? aliasMatch[1] : varName);
  }
  return wireNames;
}

/** Resolves one level of `param: T = Depends(some_local_function)`, so a
 *  route whose filters are declared once in a shared dependency (this
 *  codebase's `resource_filters` in resources.py) still reports the query
 *  params it actually accepts. Only follows a function defined in the SAME
 *  file -- good enough for the one place this pattern is used, and an
 *  unresolved cross-file Depends() simply contributes nothing, which fails
 *  toward under-reporting a param rather than over-trusting one. */
function resolveDependsParams(source, sigText) {
  const names = new Set();
  const dependsRe = /Depends\((\w+)\)/g;
  let dm;
  while ((dm = dependsRe.exec(sigText))) {
    const fnName = dm[1];
    const fnDefMatch = source.match(new RegExp(`\\bdef ${fnName}\\(`));
    if (!fnDefMatch) continue;
    const fnSig = extractSignature(source, fnDefMatch.index);
    for (const name of extractQueryParams(fnSig)) names.add(name);
  }
  return names;
}

function parseRouteFile(filePath, filename) {
  const source = fs.readFileSync(filePath, 'utf8');
  const prefixMatch = source.match(/^router = APIRouter\(prefix="([^"]+)"/m);
  if (!prefixMatch) return { routes: [], error: `no APIRouter(prefix=...) found` };

  const prefix = prefixMatch[1];
  const routes = [];
  const decoRe = /@router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g;
  let m;
  while ((m = decoRe.exec(source))) {
    const method = m[1];
    const routePath = m[2];
    const defIdx = source.indexOf('def ', m.index);
    if (defIdx === -1) continue;
    const sig = extractSignature(source, defIdx);
    const queryParams = extractQueryParams(sig);
    for (const name of resolveDependsParams(source, sig)) queryParams.add(name);
    routes.push({
      method,
      fullPath: `/api/v1${prefix}${routePath}`,
      queryParams,
      file: filename,
    });
  }
  return { routes, error: null };
}

const routeFiles = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.py') && f !== '__init__.py');
check('found the backend routes directory with a plausible number of files',
  routeFiles.length >= 12, `found ${routeFiles.length} files`);

const BACKEND_ROUTES = [];
const parseErrors = [];
for (const file of routeFiles) {
  const { routes, error } = parseRouteFile(path.join(ROUTES_DIR, file), file);
  if (error) parseErrors.push(`${file}: ${error}`);
  BACKEND_ROUTES.push(...routes);
}
check('every route file parsed without error (an unparseable file is a '
  + 'FAILURE here, not a silent skip -- a moved file must not turn this '
  + 'suite into a no-op)', parseErrors.length === 0, parseErrors.join('; '));

// Three routes are declared directly on `app`, not any router, and no
// frontend api module currently calls them -- named here so their absence
// from BACKEND_ROUTES is a documented choice, not an oversight.
check('no Query(...) parameter shares a line with the parameter before it -- '
  + 'the parser would credit it to the wrong name (put each on its own line)',
  AMBIGUOUS_QUERY.length === 0, AMBIGUOUS_QUERY.join(' | '));

const KNOWN_UNPROBED_APP_ROUTES = [
  'GET /', 'GET /health', 'GET /api/v1/cloud/{provider}/{account_id}/inventory',
];
check('3 routes are declared on `app` directly (health, root, legacy '
  + 'inventory) and are not expected in BACKEND_ROUTES',
  KNOWN_UNPROBED_APP_ROUTES.length === 3);

// Floors from a known-good run (185 routes, 144 query params) -- guards
// against the regex silently matching nothing after a source reformat.
check('parsed a floor number of routes (known-good run: 185)',
  BACKEND_ROUTES.length >= 150, `parsed ${BACKEND_ROUTES.length}`);
const totalQueryParams = BACKEND_ROUTES.reduce((sum, r) => sum + r.queryParams.size, 0);
check('parsed a floor number of query params across all routes, including '
  + 'those resolved through a local Depends() (known-good run: 284)',
  totalQueryParams >= 220, `parsed ${totalQueryParams}`);

// ── 2. Match a captured (method, path) against the parsed route table ──────
function splitPath(p) {
  return p.split('/').filter(Boolean);
}

function templateMatches(templateSegs, actualSegs) {
  let ti = 0;
  let ai = 0;
  while (ti < templateSegs.length) {
    const seg = templateSegs[ti];
    if (seg.startsWith('{') && seg.endsWith('}')) {
      const inner = seg.slice(1, -1);
      if (inner.includes(':path')) {
        // FastAPI's :path converter: consumes everything remaining, and
        // must be the last template segment.
        return ti === templateSegs.length - 1 && ai < actualSegs.length;
      }
      if (ai >= actualSegs.length) return false;
      ai++; ti++;
      continue;
    }
    if (actualSegs[ai] !== seg) return false;
    ai++; ti++;
  }
  return ai === actualSegs.length;
}

function matchRoute(method, actualPath) {
  const actualSegs = splitPath(actualPath);
  return BACKEND_ROUTES.find(
    (r) => r.method === method && templateMatches(splitPath(r.fullPath), actualSegs),
  ) || null;
}

// ── 3. Drive every module, capture (method, path, query param names) ───────
let captured = null;
cloudAxios.defaults.adapter = async (config) => {
  captured = config;
  return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
};
// Some probed functions (exportEvents/exportTopology) touch browser-only
// download APIs after the request resolves -- stubbed so the REQUEST can
// still be inspected without a real browser. See the sibling wire suites
// for why these specific overrides are needed on Node 22.
globalThis.URL.createObjectURL = () => 'blob:mock';
globalThis.URL.revokeObjectURL = () => {};
globalThis.document = {
  createElement: () => ({ click() {}, remove() {} }),
  body: { appendChild() {}, removeChild() {} },
};

async function capture(label, fn, ...args) {
  captured = null;
  await fn(...args);
  if (!captured) {
    check(`${label}: reached the stub adapter`, false, 'vacuous otherwise');
    return null;
  }
  const uri = cloudAxios.getUri(captured);
  const fullPath = uri.includes('?') ? uri.slice(0, uri.indexOf('?')) : uri;
  const query = uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : '';
  const queryNames = query
    ? new Set(query.split('&').map((p) => decodeURIComponent(p.split('=')[0])))
    : new Set();
  return { method: captured.method, fullPath, queryNames, uri };
}

// One probe per exported function across all 13 api modules. Where a
// function is already exercised in depth by a dedicated wire-format suite,
// one representative call is enough here -- this suite's job is route
// contract, not business rules.
const PROBES = [
  // cloudAccounts.api.js -- previously UNTESTED by any suite.
  ['getCloudAccounts', accounts.getCloudAccounts, []],
  ['createCloudAccount', accounts.createCloudAccount, [{ provider: 'AWS' }]],
  ['deleteCloudAccount', accounts.deleteCloudAccount, ['ACC-1']],
  ['getAccountDiagnostics', accounts.getAccountDiagnostics, ['ACC-1']],

  // discovery.api.js -- previously UNTESTED by any suite.
  ['triggerDiscovery', discovery.triggerDiscovery, ['ACC-1']],
  ['triggerAllDiscovery', discovery.triggerAllDiscovery, []],
  ['getDiscoveryStatus', discovery.getDiscoveryStatus, ['job-1']],

  // refresh.api.js -- previously UNTESTED by any suite (the feature built
  // earlier this session).
  ['startRefresh', refresh.startRefresh, ['ACC-1']],
  ['getLatestRefresh', refresh.getLatestRefresh, ['ACC-1']],
  ['getRefresh', refresh.getRefresh, ['ACC-1', 'ref-1']],
  ['cancelRefresh', refresh.cancelRefresh, ['ACC-1', 'ref-1']],
  ['getRefreshHistory', refresh.getRefreshHistory, ['ACC-1']],
  ['getRefreshSchedule', refresh.getRefreshSchedule, ['ACC-1']],
  ['updateRefreshSchedule', refresh.updateRefreshSchedule, ['ACC-1', { enabled: true }]],
  ['getRefreshCapabilities', refresh.getRefreshCapabilities, ['ACC-1']],

  // security.api.js -- the two surviving legacy endpoints.
  ['getInternetExposure', security.getInternetExposure, ['ACC-1']],
  ['getIamReview', security.getIamReview, ['ACC-1']],

  // resources.api.js -- has its own dedicated wire-format suite
  // (verify_resource_filters.mjs); one representative call per route here.
  ['queryResources', resources.queryResources, ['ACC-1', {}]],
  ['getResourceSummary', resources.getResourceSummary, ['ACC-1', {}]],
  ['getResourceFacets', resources.getResourceFacets, ['ACC-1', {}]],
  ['getResourceReference', resources.getResourceReference, ['ACC-1']],
  ['getAvailableActions', resources.getAvailableActions, ['AWS']],
  ['getActionHistory', resources.getActionHistory, [{}]],
  ['listSavedViews', resources.listSavedViews, ['ACC-1']],
  ['getResourceDetail', resources.getResourceDetail, ['r1']],
  ['getResourceMetrics', resources.getResourceMetrics, ['r1']],

  // alerts.api.js -- fully covered by verify_api_alerts_wire.mjs; one probe.
  ['alerts.getSummary', alerts.getSummary, ['ACC-1']],
  ['alerts.listRules', alerts.listRules, ['ACC-1', {}]],
  ['alerts.listInstances', alerts.listInstances, ['ACC-1', {}]],

  // events.api.js -- fully covered by verify_api_events_wire.mjs; one probe.
  ['events.getEvents', events.getEvents, [{}, {}]],
  ['events.getEventStats', events.getEventStats, [{}]],
  ['events.getEventFacets', events.getEventFacets, ['ACC-1', '7d']],

  // securityCenter.api.js -- fully covered by the security/topology wire
  // suite; one probe.
  ['securityCenter.getFindings', securityCenter.getFindings, ['ACC-1', {}]],
  // The certificate drawer's "findings for this one object" call.
  ['securityCenter.getFindings (one object)', securityCenter.getFindings,
    ['ACC-1', { resource_key: 'ocid1.loadbalancer.x/certificates/y', status: 'OPEN,IN_PROGRESS', limit: 20 }]],
  ['securityCenter.getOverview', securityCenter.getOverview, ['ACC-1']],
  // The audit export: `format` is the backend's Query alias for `fmt`, and the
  // path must not be swallowed by /compliance/{framework}/{control_id}.
  ['securityCenter.downloadComplianceExport', securityCenter.downloadComplianceExport,
    ['ACC-1', { framework: 'CIS-OCI', format: 'zip' }]],

  // topology.api.js -- fully covered by the security/topology wire suite;
  // one probe.
  ['topology.getTopology', topology.getTopology, ['aws', {}]],
  ['topology.getCoverage', topology.getCoverage, ['aws']],

  // cost.api.js / drift.api.js / overview.api.js -- fully covered by the
  // cost/drift wire suite; one probe each.
  ['cost.getCostHistory', cost.getCostHistory, ['ACC-1']],
  ['cost.getCostCapabilities', cost.getCostCapabilities, ['ACC-1']],
  ['drift.getDriftChanges', drift.getDriftChanges, ['ACC-1']],
  ['overview.getOverviewInventory', overview.getOverviewInventory, ['ACC-1']],

  // Clients, organisation onboarding and client reports.
  ['clients.getPortfolio', clients.getPortfolio, []],
  ['clients.getClientOptions', clients.getClientOptions, []],
  ['clients.getClient', clients.getClient, ['CL-1']],
  ['clients.createClient', clients.createClient, [{ name: 'x' }]],
  ['clients.updateClient', clients.updateClient, ['CL-1', { name: 'y' }]],
  ['clients.deleteClient', clients.deleteClient, ['CL-1']],
  ['clients.assignAccounts', clients.assignAccounts, ['CL-1', ['ACC-1']]],
  ['clients.unassignAccount', clients.unassignAccount, ['CL-1', 'ACC-1']],
  ['clients.discoverOrganization', clients.discoverOrganization, [{ provider: 'AWS' }]],
  ['clients.onboardOrganization', clients.onboardOrganization, [{ provider: 'AWS', members: ['1'] }]],
  ['clients.getReportSchedule', clients.getReportSchedule, ['CL-1']],
  ['clients.saveReportSchedule', clients.saveReportSchedule, ['CL-1', { enabled: false }]],
  ['clients.listReports', clients.listReports, ['CL-1']],
  ['clients.previewReport', clients.previewReport, ['CL-1', '2026-08']],
  ['clients.generateReport', clients.generateReport, ['CL-1', { period: '2026-08' }]],
  ['clients.sendReport', clients.sendReport, ['CL-1', 'REP-1']],
  ['clients.downloadReportPdf', clients.downloadReportPdf, ['CL-1', 'REP-1']],

  // Certificates, secrets and keys.
  ['certificates.getAccountCertificates', certificates.getAccountCertificates, ['ACC-1']],
  ['certificates.getCertificateEstate (every filter)', certificates.getCertificateEstate,
    [{ clientId: 'CL-1', withinDays: 30, kind: 'CERTIFICATE', includeNoExpiry: true }]],
  ['certificates.getCertificateEstate (unassigned)', certificates.getCertificateEstate,
    [{ unassigned: true, withinDays: 0 }]],
  ['certificates.collectCertificates', certificates.collectCertificates, ['ACC-1']],

  // Resource Intelligence.
  ['intelligence.getMeta', intelligence.getMeta, []],
  ['intelligence.getSummary', intelligence.getSummary, ['ACC-1']],
  ['intelligence.getFindings (every filter)', intelligence.getFindings, ['ACC-1', {
    category: ['RIGHTSIZING', 'COMPLIANCE'], severity: ['HIGH'], provider: ['OCI'],
    status: ['OPEN', 'ACKNOWLEDGED'], source: ['optimization'], signal: ['UNUSED'],
    search: 'vm', has_savings: true, sort: 'savings', limit: 25, offset: 25 }]],
  ['intelligence.getFinding', intelligence.getFinding, ['ACC-1', 'optimization', 'fp1']],
  ['intelligence.setFindingStatus', intelligence.setFindingStatus,
    ['ACC-1', 'security', 'fp1', { status: 'ACKNOWLEDGED' }]],
  ['intelligence.runAnalysis', intelligence.runAnalysis, ['ACC-1']],
  ['intelligence.getResourceHealth', intelligence.getResourceHealth, ['ACC-1', 'RES-1']],
  ['intelligence.getResourceTelemetry', intelligence.getResourceTelemetry, ['ACC-1', 'RES-1']],
  ['intelligence.getCoverage', intelligence.getCoverage, ['ACC-1']],
  ['intelligence.getRuns', intelligence.getRuns, ['ACC-1', 10]],

  // Account report builder: preview/generate, templates, history, schedules.
  ['reports.previewReport', reports.previewReport, [{ account_id: 'ACC-1' }]],
  ['reports.generateReport', reports.generateReport, [{ account_id: 'ACC-1', layout: { format: 'pdf' } }]],
  ['reports.listReportTemplates', reports.listReportTemplates, []],
  ['reports.saveReportTemplate (create)', reports.saveReportTemplate, [{ name: 'x' }]],
  ['reports.saveReportTemplate (update)', reports.saveReportTemplate, [{ name: 'x' }, 'TPL-1']],
  ['reports.deleteReportTemplate', reports.deleteReportTemplate, ['TPL-1']],
  ['reports.listReportHistory', reports.listReportHistory, ['ACC-1', 20]],
  ['reports.downloadHistoryReport', reports.downloadHistoryReport, ['ACC-1', 'REP-1']],
  ['reports.deleteHistoryReport', reports.deleteHistoryReport, ['ACC-1', 'REP-1']],
  ['reports.listReportSchedules', reports.listReportSchedules, ['ACC-1']],
  ['reports.saveReportSchedule (create)', reports.saveReportSchedule, ['ACC-1', { name: 'x' }]],
  ['reports.saveReportSchedule (update)', reports.saveReportSchedule, ['ACC-1', { name: 'x' }, 'SCH-1']],
  ['reports.deleteReportSchedule', reports.deleteReportSchedule, ['ACC-1', 'SCH-1']],
  ['reports.runReportSchedule', reports.runReportSchedule, ['ACC-1', 'SCH-1', { send: true }]],
];

check('the probe table covers all 15 api modules with a non-trivial number of calls',
  PROBES.length >= 30, `probed ${PROBES.length}`);

console.log(`\n1. Every probed request matches a real backend route (method + path)`);
const results = [];
for (const [label, fn, args] of PROBES) {
  const result = await capture(label, fn, ...args);
  if (!result) continue;
  results.push([label, result]);
  const route = matchRoute(result.method, result.fullPath);
  check(`${label}: ${result.method.toUpperCase()} ${result.fullPath} matches a declared backend route`,
    !!route, route ? '' : `no route in BACKEND_ROUTES matches this method+path -- this is a DEAD ENDPOINT`);
}

console.log(`\n2. Every query param name sent is one the matched route actually declares`);
for (const [label, result] of results) {
  const route = matchRoute(result.method, result.fullPath);
  if (!route) continue; // already failed above; don't cascade
  const unknown = [...result.queryNames].filter((n) => !route.queryParams.has(n));
  check(`${label}: every query param sent is declared on the matched route`,
    unknown.length === 0,
    unknown.length ? `unrecognised: ${unknown.join(', ')} (declared: ${[...route.queryParams].join(', ') || 'none'})` : '');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
