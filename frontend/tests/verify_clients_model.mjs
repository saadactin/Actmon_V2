// utils/clientModel.js — clients, client reports and the certificate inventory.
//
// Two kinds of check. The first half pins the product rules: money is never
// merged across currencies, a missing figure is NA and never 0, posture is
// never averaged, a green "nothing expiring" requires every store to have
// been read, and no word here claims an e-mail was sent when it was only
// queued.
//
// The second half is parity with the BACKEND, parsed from its source rather
// than retyped: the report sections, the delivery states, the expiry buckets,
// the collection states, the kinds, the client-code rule, the onboarding
// outcomes and the scheduler's own statuses. A vocabulary the UI does not
// know renders as a raw code or a grey "—", with nothing on screen to say a
// label went missing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUCKET_META, BUCKET_ORDER, CLIENT_CODE_RE, COLLECTION_META, DELIVERY_META, KIND_META,
  KIND_ORDER, ONBOARD_OUTCOME_META, REPORT_SECTIONS, REPORT_STATUS_META,
  accountRoute, bucketMeta, certificateHealth, collectionMeta, daysLeftLabel, deliveryMeta,
  findingCounts, formatBytes, formatMoneyMap, invalidEmails, moneyEntries, moneyTitle,
  parseEmailList, periodLabel, periodOptions, postureLabel, scheduleRunMeta,
  selectableMemberIds, worstPostureLabel,
} from '../src/features/cloud/utils/clientModel.js';

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '../../Backend/cloud/app');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

console.log('\n1. Money: per currency, NA is not zero');
{
  const both = formatMoneyMap({ USD: 1500, INR: 250000 });
  check('two currencies render as two figures, never one sum',
    both.includes('₹') && both.includes('$') && both.includes(' · '), both);
  eq('an empty map is NA — no billing stored is not zero spend', formatMoneyMap({}), 'NA');
  eq('a missing map is NA', formatMoneyMap(undefined), 'NA');
  check('a real zero is a number, not NA', formatMoneyMap({ INR: 0 }) !== 'NA',
    formatMoneyMap({ INR: 0 }));
  eq('a null amount is dropped rather than shown as 0', moneyEntries({ INR: null, USD: 5 }),
    [['USD', 5]]);
  check('an UNKNOWN currency gets no guessed symbol',
    !/[$₹€£]/.test(formatMoneyMap({ UNKNOWN: 12 })), formatMoneyMap({ UNKNOWN: 12 }));
  check('the tooltip says when the currency was not reported',
    moneyTitle({ UNKNOWN: 12 }).includes('currency not reported'), moneyTitle({ UNKNOWN: 12 }));
  check('the tooltip for nothing says nothing is stored, not "0"',
    /no billing/i.test(moneyTitle({})), moneyTitle({}));
  check('exact style keeps the paise', formatMoneyMap({ INR: 1234.5 }, { style: 'exact' }).includes('.50'),
    formatMoneyMap({ INR: 1234.5 }, { style: 'exact' }));
  eq('currencies are listed in a stable order', moneyEntries({ USD: 1, EUR: 2, INR: 3 }).map((e) => e[0]),
    ['EUR', 'INR', 'USD']);
}

console.log('\n2. Posture: never averaged, withheld is not bad');
{
  eq('no assessment reads "Not assessed", in grey', postureLabel(null),
    { text: 'Not assessed', tone: 'neutral', provisional: false });
  const withheld = postureLabel({ score: null, grade: 'Insufficient data' });
  check('a withheld score is grey, not red — "we cannot say" is not "bad"',
    withheld.tone === 'neutral' && withheld.text === 'Insufficient data', JSON.stringify(withheld));
  eq('an F is danger', postureLabel({ score: 35, grade: 'F', score_reliable: true }).tone, 'danger');
  eq('an A is success', postureLabel({ score: 92, grade: 'A', score_reliable: true }).tone, 'success');
  check('a score published on low coverage is marked provisional',
    postureLabel({ score: 70, grade: 'C', score_reliable: false }).provisional === true);
  const group = worstPostureLabel({
    accounts: 3, accounts_unassessed: 1,
    worst_posture: { score: 35, grade: 'F', account_name: 'Prod', score_reliable: true },
  });
  check('a group shows its WORST score (35), not an average of 35 and anything else',
    group.text.startsWith('35'), group.text);
  check('...names the account it came from, and how many have none',
    group.detail.includes('Prod') && group.detail.includes('1 not assessed'), group.detail);
  eq('a group with no accounts shows a dash', worstPostureLabel({ accounts: 0 }).text, '—');
  check('a group where nothing is assessed says so rather than showing a number',
    worstPostureLabel({ accounts: 2, worst_posture: null }).text === 'Not assessed');
}

console.log('\n3. Certificates: green only when every store was read');
{
  eq('nothing collected reads "Not collected"',
    certificateHealth({ sources_total: 0, tracked: 0 }).text, 'Not collected');
  eq('an expired certificate is danger',
    certificateHealth({ expired: 2, sources_total: 3 }).tone, 'danger');
  eq('one expiring within 30 days is a warning',
    certificateHealth({ expiring_soon: 1, sources_total: 3 }).tone, 'warning');
  const partial = certificateHealth({ sources_total: 4, sources_failing: 1, tracked: 9 });
  check('"none expiring" with an unreadable store is a WARNING, not green',
    partial.tone === 'warning' && partial.detail.includes('1 of 4'), JSON.stringify(partial));
  eq('"none expiring" with every store read is green',
    certificateHealth({ sources_total: 4, sources_failing: 0, tracked: 9 }).tone, 'success');
  check('an expired count still mentions unreadable stores',
    (certificateHealth({ expired: 1, sources_total: 2, sources_failing: 1 }).detail || '').includes('could not be read'));

  eq('3.2 days ago reads "3 days ago" — whole days elapsed, not rounded up',
    daysLeftLabel(-3.2), 'Expired 3 days ago');
  eq('half a day ago is "today"', daysLeftLabel(-0.5), 'Expired today');
  eq('1.5 days ago is singular', daysLeftLabel(-1.5), 'Expired 1 day ago');
  eq('0.4 days left is "today"', daysLeftLabel(0.4), 'Expires today');
  eq('1.9 days left is "in 1 day"', daysLeftLabel(1.9), 'in 1 day');
  eq('12.5 days left', daysLeftLabel(12.5), 'in 12 days');
  eq('no expiry is not a number of days', daysLeftLabel(null), 'No expiry');
  eq('an unknown bucket falls back to its own code', bucketMeta('weird').label, 'weird');
  eq('only Collected is green', Object.entries(COLLECTION_META)
    .filter(([, m]) => m.tone === 'success').map(([k]) => k), ['Collected']);
  check('NotSupported is never a pass', COLLECTION_META.NotSupported.tone !== 'success');
  check('NeverRun is never a pass', COLLECTION_META.NeverRun.tone !== 'success');
  eq('an unknown collection state is labelled with itself', collectionMeta('Odd').label, 'Odd');
}

console.log('\n4. Reports: queued is not delivered');
{
  for (const [k, m] of Object.entries(DELIVERY_META)) {
    check(`delivery state ${k} does not claim "sent" or "delivered"`,
      !/\bsent\b|\bdelivered\b/i.test(m.label), m.label);
  }
  check('QUEUED says queued', /queued/i.test(DELIVERY_META.QUEUED.label), DELIVERY_META.QUEUED.label);
  check('...and its hint points at notification history for the real outcome',
    /notification history/i.test(DELIVERY_META.QUEUED.hint));
  check('a failure to queue is danger', DELIVERY_META.FAILED_TO_QUEUE.tone === 'danger');
  eq('an unknown delivery state shows its code', deliveryMeta('NEW_STATE').label, 'NEW_STATE');
  eq('a schedule that never ran', scheduleRunMeta(null).label, 'Never run');
  eq('a failed build is the headline', scheduleRunMeta('FAILED').tone, 'danger');
  eq('a schedule run reports its delivery state', scheduleRunMeta('QUEUED').label,
    DELIVERY_META.QUEUED.label);
  for (const s of REPORT_SECTIONS) {
    check(`section "${s.label}" does not claim "secure" or "compliant"`,
      !/\bsecure\b|\bcompliant\b/i.test(`${s.label} ${s.hint}`));
  }
}

console.log('\n5. Periods: complete months only, decided in UTC like the backend');
{
  const opts = periodOptions(new Date('2026-09-28T10:00:00Z'));
  eq('the newest option on 28 Sep 2026 is August', opts[0].id, '2026-08');
  eq('...labelled in words', opts[0].label, 'August 2026');
  eq('twelve months are offered', opts.length, 12);
  check('the current month is never offered (the backend refuses it)',
    !opts.some((o) => o.id === '2026-09'));
  eq('the oldest of the twelve', opts[11].id, '2025-09');
  eq('January offers the previous December first',
    periodOptions(new Date('2026-01-15T00:00:00Z'))[0].id, '2025-12');
  // 1 Oct 02:00 in India is still 30 Sep in UTC, where the backend decides
  // whether September has finished.
  eq('at 02:00 IST on 1 Oct (still 30 Sep in UTC) September is NOT yet offered',
    periodOptions(new Date('2026-09-30T20:30:00Z'))[0].id, '2026-08');
  eq('from 00:00 UTC on 1 Oct it is',
    periodOptions(new Date('2026-10-01T00:00:00Z'))[0].id, '2026-09');
  const ids = opts.map((o) => o.id);
  eq('no month is offered twice', new Set(ids).size, ids.length);
  eq('a bad period is returned unchanged', periodLabel('2026-13'), '2026-13');
  eq('a missing period is a dash', periodLabel(null), '—');
}

console.log('\n6. Forms, navigation and onboarding');
{
  eq('e-mails split on commas, semicolons, spaces and newlines; duplicates dropped ignoring case',
    parseEmailList('a@x.com, A@X.com; b@y.com\nc@z.com  '), ['a@x.com', 'b@y.com', 'c@z.com']);
  eq('an empty list is empty', parseEmailList(''), []);
  eq('only the invalid ones are flagged', invalidEmails(['nope', 'ok@ex.co', 'x@y']), ['nope', 'x@y']);
  eq('Azure (as the summary spells it) routes to its dashboard',
    accountRoute('AZURE', 'A1'), '/cloud/azure-accounts/A1');
  eq('an account stored as Oracle routes to OCI', accountRoute('Oracle', 'A1'), '/cloud/oci-accounts/A1');
  eq('an unknown provider has no route rather than a broken one', accountRoute('GCP', 'A1'), null);
  eq('only selectable members are pre-ticked', selectableMemberIds([
    { member_id: '1', selectable: true }, { member_id: '2', selectable: false },
    { member_id: '3', selectable: true, already_connected: null },
  ]), ['1', '3']);
  eq('findings total is the sum of the confirmed severities',
    findingCounts({ CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4, INFO: 5 }).total, 15);
  eq('missing findings count as none, not NaN', findingCounts(undefined).total, 0);
  eq('bytes', [formatBytes(512), formatBytes(20480), formatBytes(3 * 1024 * 1024), formatBytes(null)],
    ['512 B', '20 KB', '3.0 MB', '—']);
}

console.log('\n7. Parity with the backend, parsed from its source');
{
  const clientModel = read('models/client.py');
  const sections = (clientModel.match(/SECTIONS = \(([\s\S]*?)\)/) || [, ''])[1]
    .match(/"([a-z_]+)"/g)?.map((s) => s.replace(/"/g, '')) || [];
  check('the backend SECTIONS tuple parsed', sections.length >= 5, sections.join(','));
  eq('REPORT_SECTIONS is the backend SECTIONS, in the same order',
    REPORT_SECTIONS.map((s) => s.id), sections);

  const delivery = [...clientModel.matchAll(/^DELIVERY_\w+ = "([A-Z_]+)"/gm)].map((m) => m[1]);
  check('the backend DELIVERY_* constants parsed', delivery.length >= 5, delivery.join(','));
  eq('every backend delivery state has a label, and no label is for a state that does not exist',
    Object.keys(DELIVERY_META).sort(), [...delivery].sort());

  const statuses = [...clientModel.matchAll(/^REPORT_\w+ = "([A-Z_]+)"/gm)].map((m) => m[1]);
  eq('every report status has a label', Object.keys(REPORT_STATUS_META).sort(), [...statuses].sort());

  const service = read('services/credential_service.py');
  const buckets = (service.match(/^BUCKETS = \(([^)]*)\)/m) || [, ''])[1]
    .match(/"([a-z_0-9]+)"/g)?.map((s) => s.replace(/"/g, '')) || [];
  check('the backend BUCKETS parsed', buckets.length >= 5, buckets.join(','));
  eq('BUCKET_ORDER is the backend BUCKETS, in order', BUCKET_ORDER, buckets);
  eq('BUCKET_META covers exactly those buckets', Object.keys(BUCKET_META).sort(), [...buckets].sort());

  const inventory = read('models/credential_inventory.py');
  const collect = [...inventory.matchAll(/^COLLECT_\w+ = "(\w+)"/gm)].map((m) => m[1]);
  check('the backend COLLECT_* states parsed', collect.length >= 5, collect.join(','));
  eq('every collection state has a label', Object.keys(COLLECTION_META).sort(), [...collect].sort());
  const kinds = [...inventory.matchAll(/^KIND_\w+ = "(\w+)"/gm)].map((m) => m[1]);
  eq('every kind has a label', Object.keys(KIND_META).sort(), [...kinds].sort());
  eq('KIND_ORDER lists every kind once', [...KIND_ORDER].sort(), [...kinds].sort());

  const clientService = read('services/client_service.py');
  const code = (clientService.match(/_CODE_RE = re\.compile\(r"([^"]+)"\)/) || [])[1];
  check('the backend client-code pattern parsed', !!code, code);
  eq('the client-code rule is the backend\'s, character for character', CLIENT_CODE_RE.source, code);
  for (const [value, ok] of [['KOEL', true], ['tor.prod-1', true], ['-bad', false],
    ['has space', false], ['x'.repeat(33), false], ['x'.repeat(32), true]]) {
    check(`code ${JSON.stringify(value.length > 12 ? `${value.slice(0, 6)}…(${value.length})` : value)} is ${ok ? 'accepted' : 'refused'}`,
      CLIENT_CODE_RE.test(value) === ok);
  }

  const onboarding = read('services/onboarding_service.py');
  const outcomes = [...new Set([...onboarding.matchAll(/"outcome": "(\w+)"/g)].map((m) => m[1]))];
  check('the onboarding outcomes parsed', outcomes.length >= 3, outcomes.join(','));
  eq('every onboarding outcome has a label', Object.keys(ONBOARD_OUTCOME_META).sort(), [...outcomes].sort());

  const scheduler = read('services/client_report_scheduler.py');
  const own = [...new Set([
    ...[...scheduler.matchAll(/last_status = "([A-Z_]+)"/g)].map((m) => m[1]),
    ...[...scheduler.matchAll(/_advance\([^)]*?"([A-Z_]+)"/gs)].map((m) => m[1]),
  ])];
  check('the scheduler\'s own statuses parsed', own.length >= 2, own.join(','));
  for (const s of own) {
    check(`scheduler status ${s} has its own label, not a raw code`,
      scheduleRunMeta(s).label !== s, scheduleRunMeta(s).label);
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
