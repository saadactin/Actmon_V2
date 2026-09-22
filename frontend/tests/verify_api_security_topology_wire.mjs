// Security Center and Topology API wire formats.
//
// Two things worth knowing before touching either file:
//
// securityCenter.api.js's `toQuery` joins arrays with COMMAS
// (`severity=CRITICAL,HIGH`) -- the OPPOSITE convention from
// resources.api.js's `serialize`, which sends repeated keys
// (`type=A&type=B`). Both are correct for the backend each one talks to
// (security_center.py's `_csv()` splits on comma; resources' route reads
// `List[str]` via repeated keys) -- but the two dialects sitting side by
// side in one codebase is exactly the kind of thing a well-meant "let's
// unify this" refactor breaks. Pinning both stops that.
//
// topology.api.js's `toParams` is shared verbatim between the graph
// request and the export request, specifically so an export can never
// silently drop a filter and return the whole cloud instead of the
// filtered view someone asked for.
import { cloudAxios } from '../src/features/cloud/api/axios.js';
import * as sc from '../src/features/cloud/api/securityCenter.api.js';
import * as topo from '../src/features/cloud/api/topology.api.js';

// exportTopology feeds its blob response to URL.createObjectURL and a
// document-created <a> after the request completes. Node 22 ships its OWN
// createObjectURL that requires a real Blob and throws on a plain object --
// both are stubbed unconditionally so the suite can inspect the REQUEST
// without needing a real browser.
globalThis.URL.createObjectURL = () => 'blob:mock';
globalThis.URL.revokeObjectURL = () => {};
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: () => ({ click() {}, remove() {} }),
    body: { appendChild() {}, removeChild() {} },
  };
}

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

let captured = null;
cloudAxios.defaults.adapter = async (config) => {
  captured = config;
  return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
};

async function capture(label, fn, ...args) {
  captured = null;
  await fn(...args);
  if (!captured) {
    check(`${label}: reached the stub adapter`, false, 'vacuous otherwise');
    return { uri: '', method: '' };
  }
  return { uri: cloudAxios.getUri(captured), method: captured.method };
}

const query = (uri) => (uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : '');

console.log('\n1. Security Center: arrays are COMMA-joined, never repeated keys');
{
  const { uri } = await capture('getFindings with two severities', sc.getFindings,
    'ACC-1', { severity: ['CRITICAL', 'HIGH'] });
  check('severity=CRITICAL,HIGH (comma-joined, one key)',
    decodeURIComponent(query(uri)).includes('severity=CRITICAL,HIGH'), uri);
  check('never sends severity twice as repeated keys',
    (uri.match(/severity=/g) || []).length === 1, uri);
}

console.log('\n2. Security Center: booleans are literal strings, never 1/0/empty');
{
  // getAlerts is the real boolean-typed caller through this same toQuery
  // helper -- the backend's list_alerts declares
  // `include_resolved: bool = Query(False)` (security_center.py:232).
  const { uri: trueUri } = await capture('getAlerts include_resolved:true', sc.getAlerts,
    { include_resolved: true });
  check('a boolean true becomes the literal string "true"',
    trueUri.includes('include_resolved=true'), trueUri);
  const { uri: falseUri } = await capture('getAlerts include_resolved:false', sc.getAlerts,
    { include_resolved: false });
  check('a boolean false becomes the literal string "false", not omitted or "0"',
    falseUri.includes('include_resolved=false'), falseUri);
}

console.log('\n3. Security Center: toQuery produces no bare "?" and drops empties');
{
  const { uri } = await capture('getFindings with no filters', sc.getFindings, 'ACC-1', {});
  check('no filters at all -> no trailing "?" on the URL',
    !uri.endsWith('?'), uri);
  const { uri: emptyArr } = await capture('getFindings with an empty array filter',
    sc.getFindings, 'ACC-1', { severity: [] });
  check('an empty array filter is omitted entirely, not sent as severity=',
    !emptyArr.includes('severity='), emptyArr);
}

console.log('\n4. Security Center: the status alias — status_filter on the backend, status on the wire');
{
  const { uri } = await capture('getFindings status:OPEN', sc.getFindings, 'ACC-1', { status: 'OPEN' });
  check('getFindings sends "status" (the backend Query alias), not "status_filter"',
    uri.includes('status=OPEN') && !uri.includes('status_filter'), uri);
}

console.log('\n5. Security Center: getControl encodes a control id containing a slash');
{
  // A HIPAA-shaped id (164.312(a)(2)(iv)) has no slash -- encodeURIComponent
  // deliberately leaves "(" ")" "." unescaped (they are valid path
  // characters), so a control id like that round-trips unchanged, correctly.
  // The property that actually matters is the one the source comment names:
  // a "/" inside a control id must become %2F, or it silently adds an extra
  // path segment and the request resolves to the wrong route entirely.
  const hipaaId = '164.312(a)(2)(iv)';
  const { uri: hipaaUri } = await capture('getControl with a HIPAA-shaped id', sc.getControl,
    'ACC-1', 'HIPAA', hipaaId);
  check('a control id with no slash round-trips unchanged (parens need no escaping)',
    decodeURIComponent(hipaaUri.split('/').pop()) === hipaaId
    && hipaaUri.endsWith(hipaaId), hipaaUri);

  const slashId = 'AC-2/3';
  const { uri: slashUri } = await capture('getControl with a slash in the id', sc.getControl,
    'ACC-1', 'NIST', slashId);
  check('a "/" in the control id becomes %2F, not a literal slash '
    + '(a literal slash would silently add a path segment)',
    slashUri.includes('AC-2%2F3') && !slashUri.includes('AC-2/3'), slashUri);
  check('the encoded slash-bearing id still round-trips back to the original',
    decodeURIComponent(slashUri.split('/').pop()) === slashId, slashUri);
}

console.log('\n6. Security Center: writes use the right verbs and carry no accidental filters');
{
  const { method: assess } = await capture('runAssessment', sc.runAssessment, 'ACC-1');
  check('runAssessment is POST', assess === 'post', assess);
  const { method: collect } = await capture('collectIdentity', sc.collectIdentity, 'ACC-1');
  check('collectIdentity is POST', collect === 'post', collect);
  const { method: setStatus } = await capture('setFindingStatus', sc.setFindingStatus,
    'ACC-1', 'k1', { status: 'SUPPRESSED', reason: 'known-safe' });
  check('setFindingStatus is POST', setStatus === 'post', setStatus);
  const { method: act } = await capture('actOnAlert', sc.actOnAlert, 'a1', 'resolve', 'fixed');
  check('actOnAlert is POST', act === 'post', act);
}

console.log('\n7. Topology: view is omitted when it is the server default');
{
  const { uri: defaultView } = await capture('getTopology default view', topo.getTopology, 'aws', {});
  check('view=infrastructure is OMITTED (it is the server default)',
    !defaultView.includes('view='), defaultView);
  const { uri: otherView } = await capture('getTopology network view', topo.getTopology,
    'aws', { view: 'network' });
  check('a non-default view IS sent', otherView.includes('view=network'), otherView);
}

console.log('\n8. Topology: refresh is only sent when explicitly requested');
{
  const { uri: noRefresh } = await capture('getTopology, no options', topo.getTopology, 'aws', {});
  check('getTopology({}) sends no refresh param at all', !noRefresh.includes('refresh'), noRefresh);
  const { uri: withRefresh } = await capture('getTopology, refresh:true', topo.getTopology,
    'aws', { refresh: true });
  check('refresh:true sends refresh=true', withRefresh.includes('refresh=true'), withRefresh);
}

console.log('\n9. Topology: booleans are send-when-true only (false is the default server-side)');
{
  const { uri } = await capture('getTopology with filters', topo.getTopology, 'aws', {
    filters: {
      provider: 'AWS', hasDrift: true, hasEvents: false, exposed: true, hasBroadAccess: false,
    },
  });
  check('provider is sent', uri.includes('provider=AWS'), uri);
  check('has_drift:true is sent', uri.includes('has_drift=true'), uri);
  check('has_events:false is OMITTED, not sent as has_events=false', !uri.includes('has_events'), uri);
  check('exposed:true is sent', uri.includes('exposed=true'), uri);
  check('has_broad_access:false is OMITTED', !uri.includes('has_broad_access'), uri);
}

console.log('\n10. Topology: hasActiveFilters ignores view/refresh/nodeLimit/contextHops');
{
  check('a view + nodeLimit + contextHops + refresh with no real filter is NOT active',
    topo.hasActiveFilters({ view: 'network', nodeLimit: 500, contextHops: 2, refresh: true }) === false);
  check('a real filter IS active',
    topo.hasActiveFilters({ filters: { provider: 'AWS' } }) === true);
  check('a search term IS active',
    topo.hasActiveFilters({ search: 'i-123' }) === true);
  check('nothing at all is NOT active', topo.hasActiveFilters({}) === false);
  check('nothing at all (no args) is NOT active', topo.hasActiveFilters() === false);
}

console.log('\n11. Topology: exportTopology sends the SAME filters as getTopology, plus fmt');
{
  const options = { view: 'network', filters: { provider: 'Azure', exposed: true }, search: 'vm-1' };
  const { uri: graphUri } = await capture('getTopology', topo.getTopology, 'aws', options);
  const { uri: exportUri } = await capture('exportTopology', topo.exportTopology, 'aws', options);

  const stripFmt = (uri) => query(uri).split('&').filter((p) => !p.startsWith('fmt=')).sort().join('&');
  check('exportTopology and getTopology send identical filter params (minus fmt)',
    stripFmt(graphUri) === stripFmt(exportUri),
    `graph: ${query(graphUri)}  |  export: ${query(exportUri)}`);
  check('exportTopology carries fmt', exportUri.includes('fmt=json'), exportUri);
}

console.log('\n12. Topology: getPath joins relationshipTypes with commas');
{
  const { uri } = await capture('getPath with relationship types', topo.getPath, 'aws', {
    source: 'r1', target: 'r2', relationshipTypes: ['depends_on', 'permission'],
  });
  check('relationship_types is comma-joined',
    uri.includes('relationship_types=depends_on%2Cpermission') || uri.includes('relationship_types=depends_on,permission'),
    uri);
  const { uri: noTypes } = await capture('getPath with no relationship types', topo.getPath, 'aws', {
    source: 'r1', target: 'r2',
  });
  check('no relationshipTypes -> no relationship_types param', !noTypes.includes('relationship_types'), noTypes);
}

console.log('\n13. Topology: mutating/export endpoints use the right verbs');
{
  const { method: snapshot } = await capture('takeSnapshot', topo.takeSnapshot, 'aws', { label: 'x' });
  check('takeSnapshot is POST', snapshot === 'post', snapshot);
  const { method: del } = await capture('deleteSnapshot', topo.deleteSnapshot, 's1');
  check('deleteSnapshot is DELETE', del === 'delete', del);
  const { method: exportGet } = await capture('exportTopology', topo.exportTopology, 'aws', {});
  check('exportTopology is a GET (a blob download, not a write)', exportGet === 'get', exportGet);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
