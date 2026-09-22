/**
 * Account refresh — pure logic.
 *
 * Run: node src/features/cloud/utils/__tests__/refreshModel.test.mjs
 *
 * The invalidation predicate gets most of the attention here because it is the
 * one piece that fails silently: if it matches nothing, every panel keeps
 * showing pre-refresh data and the only symptom is a user reaching for F5. If
 * it matches too much, one account's refresh drags every other account's
 * provider-backed queries along with it.
 */
import {
  componentProgress, isActive, isTerminal, mentionsAccount, outcomeMessage,
  REFRESHED_ROOTS, shouldInvalidate,
} from '../refreshModel.js';

let pass = 0;
let fail = 0;
const results = [];

function check(name, cond, detail) {
  if (cond) { pass += 1; results.push(`  PASS  ${name}`); } else {
    fail += 1;
    results.push(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
}
const eq = (name, got, want) => check(
  name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
);

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

/* ── Status helpers ──────────────────────────────────────────────────────── */
check('SUCCEEDED is terminal', isTerminal('SUCCEEDED'));
check('PARTIAL is terminal', isTerminal('PARTIAL'));
check('FAILED is terminal', isTerminal('FAILED'));
check('CANCELLED is terminal', isTerminal('CANCELLED'));
check('RUNNING is not terminal', !isTerminal('RUNNING'));
check('QUEUED is not terminal', !isTerminal('QUEUED'));
check('QUEUED is active', isActive('QUEUED'));
check('SUCCEEDED is not active', !isActive('SUCCEEDED'));
check('unknown status is neither', !isTerminal('WAT') && !isActive('WAT'));

/* ── mentionsAccount ─────────────────────────────────────────────────────── */
check('finds a bare id', mentionsAccount([A], A));
check('finds an id inside an object', mentionsAccount([{ account_id: A }], A));
check('finds an id nested two deep',
  mentionsAccount([{ filters: { account_id: A } }], A));
check('does not match a different account', !mentionsAccount([B], A));
check('does not match a substring',
  !mentionsAccount([`${A}-suffix`], A));
check('ignores numbers and booleans', !mentionsAccount([30, true, null], A));
check('empty accountId never matches', !mentionsAccount([A], null));
check('stops recursing on deeply nested structures',
  !mentionsAccount([[[[[[A]]]]]], A));

/* ── shouldInvalidate ────────────────────────────────────────────────────── */
// Real keys, copied from the hooks that build them.
const REAL_KEYS = [
  ['cloudOverview', 'inventory', A, null],
  ['cloudOverview', 'posture', A],
  ['cloudOverview', 'costTotal', A],
  ['cloudOverview', 'costSeries', A, 30],
  ['cloudOverview', 'events', A, '7d'],
  ['cloudOverview', 'topology', A],
  ['cloudOverview', 'discovery', A],
  ['cloudOverview', 'changes', A, 30],
  ['cloudResources', 'query', A, { status: 'RUNNING' }, {}],
  ['cloudResources', 'summary', A, {}],
  ['cloudResources', 'facets', A, {}],
  ['securityCenter', 'overview', A],
  ['securityCenter', 'findings', A, {}],
  ['securityCenter', 'score', A],
  ['internetExposure', A],
  ['iamReview', A],
  ['costAnalytics', A],
  ['costHistory', A, 30, 'service', {}],
  ['costQuality', A],
  ['costCoverage', A],
  ['costAnomalies', A, 30, {}],
  ['driftChanges', A, 30, {}],
  ['driftSummary', A, 30],
  ['driftFacets', A, 30],
  ['cloudEvents', { account_id: A }, {}],
  ['cloudEventStats', { account_id: A }],
  ['cloudEventFacets', A, '7d'],
  ['topology', A, { view: null }],
  ['cloudAlerts', 'summary', A],
  ['cloudAlerts', 'instances', A, {}],
  ['accountDiagnostics', A],
];
REAL_KEYS.forEach((key) => {
  check(`invalidates ${key[0]}/${key[1] ?? ''}`.trim(), shouldInvalidate(key, A),
    `key ${JSON.stringify(key)} did not match`);
});

// The isolation guarantee: the same keys for ANOTHER account must not match.
REAL_KEYS.forEach((key) => {
  check(`leaves other account's ${key[0]} alone`, !shouldInvalidate(key, B));
});

// Roots that are not account data must be left alone even when the id appears.
[
  ['cloudEventSettings'],
  ['cloudEventSavedQueries'],
  ['costMetrics'],
  ['costAlertPolicies'],
  ['appTheme', A],
  ['discoveryStatus', A],
].forEach((key) => {
  check(`does not invalidate ${key[0]}`, !shouldInvalidate(key, A));
});

check('a root with no account in the key does not match',
  !shouldInvalidate(['cloudResources', 'accountCounts'], A));
check('the root alone is not enough',
  !shouldInvalidate(['cloudOverview'], A));
check('a non-array key is refused', !shouldInvalidate('cloudOverview', A));
check('a missing accountId invalidates nothing',
  !shouldInvalidate(['cloudOverview', 'posture', A], null));
check('every declared root is a non-empty string',
  REFRESHED_ROOTS.every((r) => typeof r === 'string' && r.length > 0));
check('no duplicate roots',
  new Set(REFRESHED_ROOTS).size === REFRESHED_ROOTS.length);

/* ── componentProgress ───────────────────────────────────────────────────── */
const COMPONENTS = {
  connection: { label: 'Account connection', status: 'SUCCEEDED' },
  resources: { label: 'Resource discovery', status: 'SUCCEEDED' },
  drift: { label: 'Configuration drift', status: 'SUCCEEDED' },
  cost: { label: 'Cost data', status: 'RUNNING' },
  security: { label: 'Security assessment', status: 'PENDING' },
  events: { label: 'Event collection', status: 'PENDING' },
};
const prog = componentProgress(COMPONENTS);
eq('progress counts total', prog.total, 6);
eq('progress counts finished components', prog.done, 3);
eq('progress names the running component', prog.running, 'Cost data');
eq('progress lists no failures yet', prog.failed, []);
check('progress carries no percentage field',
  !('percent' in prog) && !('pct' in prog));

const partial = componentProgress({
  ...COMPONENTS,
  cost: { label: 'Cost data', status: 'FAILED' },
  security: { label: 'Security assessment', status: 'SKIPPED' },
  events: { label: 'Event collection', status: 'SUCCEEDED' },
});
eq('failed components are named', partial.failed, ['Cost data']);
eq('skipped components are named', partial.skipped, ['Security assessment']);
eq('nothing is running once everything settled', partial.running, null);
eq('empty components give a zero total', componentProgress(null).total, 0);

/* ── outcomeMessage ──────────────────────────────────────────────────────── */
eq('success message', outcomeMessage({ status: 'SUCCEEDED', components: COMPONENTS }),
  'Account refresh completed.');

const partialMsg = outcomeMessage({
  status: 'PARTIAL',
  components: {
    cost: { label: 'Cost data', status: 'FAILED' },
    security: { label: 'Security assessment', status: 'SKIPPED' },
  },
});
check('partial message names what failed', partialMsg.includes('Cost data'), partialMsg);
check('partial message names what was skipped',
  partialMsg.includes('Security assessment'), partialMsg);
check('partial message says old data was kept',
  partialMsg.includes('Previous data was kept'), partialMsg);

const failMsg = outcomeMessage({
  status: 'FAILED',
  error: 'The AWS credentials were rejected.',
  components: {},
});
check('failure message carries the real reason',
  failMsg.includes('The AWS credentials were rejected.'), failMsg);
check('failure message reassures that data was kept',
  failMsg.includes('Existing data was kept'), failMsg);
check('failure with no recorded reason still says data was kept',
  outcomeMessage({ status: 'FAILED', components: {} })
    .includes('Existing data was kept'));
check('cancelled message says data was kept',
  outcomeMessage({ status: 'CANCELLED', components: {} })
    .includes('Existing data was kept'));
eq('a running refresh has no outcome message',
  outcomeMessage({ status: 'RUNNING', components: COMPONENTS }), null);
eq('no refresh, no message', outcomeMessage(null), null);

// No message may claim success the record does not carry.
['PARTIAL', 'FAILED', 'CANCELLED'].forEach((status) => {
  const msg = outcomeMessage({ status, components: {} }) || '';
  check(`${status} never reads as a plain success`,
    !/^Account refresh completed\.$/.test(msg), msg);
});

/* ── Report ──────────────────────────────────────────────────────────────── */
console.log('\nAccount refresh — model tests\n');
console.log(results.join('\n'));
console.log(`\nPASS ${pass}  FAIL ${fail}\n`);
process.exit(fail ? 1 : 0);
