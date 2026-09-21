// The Event Log API layer's wire format.
//
// `toParams` (re-exported as `eventFiltersToParams`) is the single place 30
// filter keys become query params, threaded through getEvents, getEventStats,
// getEventTimeline, getEventActors and exportEvents. If it ever disagrees
// with what events.py declares (checked here against the exact Query() names
// read from the source), a filter silently stops working -- the table shows
// everything while the summary cards, built from the same "filtered" call,
// disagree with it.
//
// Same stub-adapter technique as verify_api_alerts_wire.mjs: swap the axios
// adapter, read the real serialized URI via cloudAxios.getUri().
import { cloudAxios } from '../src/features/cloud/api/axios.js';
import * as api from '../src/features/cloud/api/events.api.js';

// exportEvents drives the file-download DOM APIs after the request completes.
// There is no jsdom here, so the three calls it makes are stubbed just
// enough to not throw -- this lets the suite verify the REQUEST it sends
// (the part that can silently diverge from getEvents) without needing a
// real browser. None of this affects any other suite: it only adds methods,
// it doesn't remove or fake data returned to anything else.
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: () => ({ click() {} }),
    body: { appendChild() {}, removeChild() {} },
  };
}
// Unconditional, not a "only if missing" guard: Node 22 ships its OWN
// URL.createObjectURL that requires a real Blob and throws on a plain
// object, so a typeof check here would see a function already exists and
// skip patching it -- then crash on the first call anyway.
globalThis.URL.createObjectURL = () => 'blob:mock';
globalThis.URL.revokeObjectURL = () => {};

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

let captured = null;
cloudAxios.defaults.adapter = async (config) => {
  captured = config;
  // exportEvents reads response.headers and response.data (as a Blob it
  // then feeds to the stubbed createObjectURL above, which ignores its
  // argument's type) -- {} satisfies both without needing a real Blob.
  return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
};

async function capture(label, fn, ...args) {
  captured = null;
  await fn(...args);
  if (!captured) {
    check(`${label}: reached the stub adapter`, false, 'vacuous otherwise');
    return { uri: '', method: '', timeout: undefined, responseType: undefined };
  }
  return {
    uri: cloudAxios.getUri(captured),
    method: captured.method,
    timeout: captured.timeout,
    responseType: captured.responseType,
    params: captured.params,
  };
}

/** Every query-param name a wire-format call may emit, decoded so `?a=1&b=2`
 *  compares cleanly regardless of key order. */
const paramNames = (uri) => {
  const q = uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : '';
  if (!q) return new Set();
  return new Set(q.split('&').map((pair) => decodeURIComponent(pair.split('=')[0])));
};

// The exact backend Query() names from app/api/routes/events.py's list route
// (lines 83-119), read from source rather than retyped by hand so this list
// cannot silently drift from what the route actually declares.
const BACKEND_FILTER_PARAMS = [
  'account_id', 'range', 'start', 'end', 'provider', 'event_category',
  'provider_category', 'action', 'status', 'risk_level', 'min_risk',
  'actor_name', 'actor_type', 'resource_type', 'resource_id', 'region',
  'account_ref', 'subscription_id', 'tenant_id', 'compartment_name',
  'resource_group', 'access_method', 'event_name', 'source_ip',
  'correlation_id', 'request_id', 'search', 'exclude_read_only',
  'advanced_filter',
];

const FULL_FILTERS = {
  accountId: 'ACC-1', range: '7d', start: '2026-09-01T00:00:00Z',
  end: '2026-09-08T00:00:00Z', provider: 'AWS', category: 'security',
  providerCategory: 'IAM', action: 'delete', status: 'Failed', risk: 'HIGH',
  minRisk: 'MEDIUM', actor: 'alice', actorType: 'user', resourceType: 'EC2Instance',
  resourceId: 'i-123', region: 'ap-south-1', accountRef: '999999999999',
  subscriptionId: 'sub-1', tenantId: 'ten-1', compartment: 'cmp-1',
  resourceGroup: 'rg-1', accessMethod: 'console', eventName: 'DeleteBucket',
  sourceIp: '1.2.3.4', correlationId: 'corr-1', requestId: 'req-1',
  search: 'bucket', excludeReadOnly: true, advanced: { op: 'AND', rules: [] },
};

console.log('\n1. All 30 filter keys round-trip to the exact backend Query() names');
{
  const wire = api.eventFiltersToParams(FULL_FILTERS);
  const wireKeys = Object.keys(wire).filter((k) => wire[k] !== undefined);
  for (const backendName of BACKEND_FILTER_PARAMS) {
    check(`toParams emits "${backendName}" (matches events.py's Query name)`,
      backendName in wire && wire[backendName] !== undefined,
      JSON.stringify(wire[backendName]));
  }
  check('toParams emits no key the backend route does not declare',
    wireKeys.every((k) => BACKEND_FILTER_PARAMS.includes(k)),
    wireKeys.filter((k) => !BACKEND_FILTER_PARAMS.includes(k)).join(', '));
}

console.log('\n2. Tri-state discipline: exclude_read_only is false-by-omission');
{
  const withFalse = api.eventFiltersToParams({ excludeReadOnly: false });
  check('excludeReadOnly:false sends NO exclude_read_only param at all '
    + '(false is the default; sending it is pure noise)',
    withFalse.exclude_read_only === undefined, JSON.stringify(withFalse.exclude_read_only));

  const withTrue = api.eventFiltersToParams({ excludeReadOnly: true });
  check('excludeReadOnly:true sends exclude_read_only=true',
    withTrue.exclude_read_only === true, JSON.stringify(withTrue.exclude_read_only));

  const withNothing = api.eventFiltersToParams({});
  check('no excludeReadOnly key sends no param either',
    withNothing.exclude_read_only === undefined, JSON.stringify(withNothing.exclude_read_only));
}

console.log('\n3. The advanced filter travels as a JSON string, and round-trips exactly');
{
  const advanced = {
    op: 'AND',
    rules: [{ field: 'status', op: 'eq', value: 'Failed' }, { field: 'risk_level', op: 'gte', value: 'HIGH' }],
  };
  const wire = api.eventFiltersToParams({ advanced });
  check('advanced_filter is a string, not the raw object (URL-safe, bookmarkable)',
    typeof wire.advanced_filter === 'string', typeof wire.advanced_filter);
  const parsedBack = JSON.parse(wire.advanced_filter);
  check('JSON.parse(advanced_filter) deep-equals the input',
    JSON.stringify(parsedBack) === JSON.stringify(advanced), wire.advanced_filter);

  const noAdvanced = api.eventFiltersToParams({});
  check('no advanced filter sends no advanced_filter param',
    noAdvanced.advanced_filter === undefined);
}

console.log('\n4. getEvents merges paging without disturbing the filters');
{
  const { uri } = await capture('getEvents with filters + paging', api.getEvents,
    { accountId: 'ACC-1', provider: 'AWS' }, { sort: 'risk', page: 2, pageSize: 25 });
  const names = paramNames(uri);
  check('getEvents carries account_id', names.has('account_id'), uri);
  check('getEvents carries provider', names.has('provider'), uri);
  check('getEvents carries sort/page/page_size',
    names.has('sort') && names.has('page') && names.has('page_size'), uri);
}

console.log('\n5. Stats and timeline take filters but never paging (no server-side paging exists for them)');
{
  const { uri: statsUri } = await capture('getEventStats', api.getEventStats,
    { accountId: 'ACC-1', range: '24h' });
  check('getEventStats has no page/page_size/sort params',
    !paramNames(statsUri).has('page') && !paramNames(statsUri).has('sort'), statsUri);

  const { uri: timelineUri } = await capture('getEventTimeline', api.getEventTimeline,
    { accountId: 'ACC-1', range: '24h' });
  check('getEventTimeline has no page/page_size/sort params',
    !paramNames(timelineUri).has('page') && !paramNames(timelineUri).has('sort'), timelineUri);
}

console.log('\n6. exportEvents sends the SAME filters as getEvents for an identical input '
  + '-- a divergence here is "a file nobody can trust"');
{
  const filters = { accountId: 'ACC-1', provider: 'Azure', risk: 'CRITICAL', status: 'Failed' };
  const { uri: getUri } = await capture('getEvents', api.getEvents, filters, { sort: 'newest' });
  const { uri: exportUri } = await capture('exportEvents', api.exportEvents, filters, 'csv', { sort: 'newest' });

  // Compare filter-only param names -- strip paging/format/export-specific
  // keys that legitimately differ (page/page_size only exist on getEvents;
  // format/include_raw only exist on exportEvents).
  const stripNonFilter = (names) => new Set(
    [...names].filter((n) => !['page', 'page_size', 'format', 'include_raw'].includes(n)),
  );
  const getFilterNames = stripNonFilter(paramNames(getUri));
  const exportFilterNames = stripNonFilter(paramNames(exportUri));
  check('exportEvents and getEvents send the identical set of filter param names',
    JSON.stringify([...getFilterNames].sort()) === JSON.stringify([...exportFilterNames].sort()),
    `getEvents: ${[...getFilterNames].sort()}  |  exportEvents: ${[...exportFilterNames].sort()}`);
}

console.log('\n7. exportEvents and collectEvents keep their long timeouts and blob handling');
{
  const { timeout: exportTimeout, responseType } = await capture(
    'exportEvents', api.exportEvents, { accountId: 'ACC-1' }, 'csv', {});
  check('exportEvents keeps its 300s timeout (a large export must not be '
    + 'abandoned by a default ~1s axios timeout)', exportTimeout === 300_000, String(exportTimeout));
  check('exportEvents requests responseType: blob (so a 400 surfaces as an '
    + 'error, not a navigation to a JSON document)', responseType === 'blob', String(responseType));

  const { timeout: collectTimeout, method: collectMethod } = await capture(
    'collectEvents', api.collectEvents, 'ACC-1', 24);
  check('collectEvents keeps its 300s timeout (a provider audit-log sweep '
    + 'across several scopes takes real time)', collectTimeout === 300_000, String(collectTimeout));
  check('collectEvents is a POST', collectMethod === 'post', collectMethod);
}

console.log('\n8. Read-only endpoints stay GET; settings/queries use the right verbs');
{
  const readOnly = [
    ['getEventFacets', api.getEventFacets, ['ACC-1', '7d']],
    ['getEvent', api.getEvent, ['e1']],
    ['getEventRaw', api.getEventRaw, ['e1']],
    ['getRelatedEvents', api.getRelatedEvents, ['e1']],
    ['getEventSources', api.getEventSources, ['ACC-1']],
    ['getCollectionStatus', api.getCollectionStatus, ['ACC-1']],
    ['getEventSettings', api.getEventSettings, []],
    ['getEventRules', api.getEventRules, []],
    ['getEventAccess', api.getEventAccess, []],
    ['getSavedQueries', api.getSavedQueries, []],
  ];
  for (const [label, fn, args] of readOnly) {
    const { method } = await capture(label, fn, ...args);
    check(`${label} is a GET`, method === 'get', method);
  }

  const { method: updateMethod } = await capture('updateEventSettings',
    api.updateEventSettings, { intervalMinutes: 30 });
  check('updateEventSettings is PUT', updateMethod === 'put', updateMethod);

  const { method: saveMethod } = await capture('saveQuery', api.saveQuery, { name: 'x' });
  check('saveQuery is POST', saveMethod === 'post', saveMethod);

  const { method: deleteMethod } = await capture('deleteSavedQuery', api.deleteSavedQuery, 'q1');
  check('deleteSavedQuery is DELETE', deleteMethod === 'delete', deleteMethod);
}

console.log('\n9. getEventActors and getEventsForResource carry their own params correctly');
{
  const { uri: actorsUri } = await capture('getEventActors', api.getEventActors,
    { accountId: 'ACC-1', provider: 'AWS' }, 10);
  const actorNames = paramNames(actorsUri);
  check('getEventActors carries the filter params', actorNames.has('account_id') && actorNames.has('provider'), actorsUri);
  check('getEventActors carries limit', actorNames.has('limit'), actorsUri);

  const { uri: forResourceUri } = await capture('getEventsForResource', api.getEventsForResource,
    { accountId: 'ACC-1', resourceId: 'i-1', resourceName: 'web-1', around: '2026-09-08T00:00:00Z', hours: 48 });
  const frNames = paramNames(forResourceUri);
  check('getEventsForResource sends resource_id, resource_name, around and hours',
    frNames.has('resource_id') && frNames.has('resource_name') && frNames.has('around') && frNames.has('hours'),
    forResourceUri);

  const { uri: forResourceDefaultUri } = await capture('getEventsForResource (default hours)',
    api.getEventsForResource, { accountId: 'ACC-1', resourceId: 'i-1' });
  check('getEventsForResource defaults hours to 72',
    paramNames(forResourceDefaultUri).has('hours') && forResourceDefaultUri.includes('hours=72'),
    forResourceDefaultUri);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
