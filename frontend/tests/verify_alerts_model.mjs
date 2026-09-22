// The Alerts tab's presentation model.
//
// This project has no component-test framework, so what is checked here is the
// pure logic — which is also where a silent defect is most likely and least
// visible. Three properties carry the weight:
//
//   1. NA is never rendered as 0. An alert count that could not be read and an
//      alert count of zero look identical on screen unless something enforces
//      the difference, and a delivery ledger that cannot be read must not
//      report "0 emails failed".
//
//   2. Every one of the six evaluation states has a distinct meaning attached,
//      and the three inconclusive ones are neither green nor red. Painting
//      UNKNOWN as healthy is the specific failure this whole feature exists to
//      avoid.
//
//   3. Alert state and notification state are never collapsed. An alert can be
//      correctly OPEN while its email failed to leave the building.
import {
  NOTIFICATION_META, RESULT_META, SEVERITY_META, STATE_META, humanDuration,
  notificationMeta, resultMeta, severityMeta, statesFor,
} from '../src/features/cloud/utils/alertModel.js';
import { buildAttentionItems } from '../src/features/cloud/utils/attentionModel.js';

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

console.log('\n1. The six evaluation states are all distinct and all explained');
const STATES = ['TRIGGERED', 'NOT_TRIGGERED', 'RESOLVED', 'UNKNOWN', 'ERROR', 'UNSUPPORTED'];
STATES.forEach((s) => {
  check(`${s} has a meaning attached`, !!RESULT_META[s]?.help && !!RESULT_META[s]?.label);
});
check('an unrecognised state falls back to "never evaluated", not to OK',
  resultMeta(undefined).label === 'Never evaluated'
  && resultMeta(undefined).tone !== 'success');

// The load-bearing one. If UNKNOWN ever renders as success, a monitoring system
// that cannot read its data source starts looking like a healthy estate.
check('UNKNOWN is NOT painted as healthy',
  RESULT_META.UNKNOWN.tone !== 'success', RESULT_META.UNKNOWN.tone);
check('ERROR is NOT painted as healthy',
  RESULT_META.ERROR.tone !== 'success', RESULT_META.ERROR.tone);
check('UNSUPPORTED is NOT painted as healthy',
  RESULT_META.UNSUPPORTED.tone !== 'success', RESULT_META.UNSUPPORTED.tone);
check('UNKNOWN explicitly says it is not the same as the condition being false',
  /NOT the same/i.test(RESULT_META.UNKNOWN.help));
check('only the two genuinely-clear states are green',
  STATES.filter((s) => RESULT_META[s].tone === 'success').sort().join(',')
  === 'NOT_TRIGGERED,RESOLVED');

console.log('\n2. Severity has one mapping, used everywhere');
['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].forEach((s) => {
  check(`${s} maps to a tone and a spelled-out label`,
    !!SEVERITY_META[s]?.tone && !!SEVERITY_META[s]?.label);
});
check('severity lookup is case-insensitive',
  severityMeta('critical').label === 'Critical');
check('an unknown severity does not silently become INFO-coloured green',
  severityMeta('banana').tone === 'neutral', severityMeta('banana').tone);

console.log('\n3. Alert state and notification state stay separate');
check('alert states are the three lifecycle values only',
  Object.keys(STATE_META).sort().join(',') === 'ACKNOWLEDGED,OPEN,RESOLVED');
// Notification statuses must NOT reuse the lifecycle words, or a reader will
// take "RESOLVED" in the notification column to mean the email succeeded.
const overlap = Object.keys(NOTIFICATION_META)
  .filter((k) => Object.keys(STATE_META).includes(k));
check('no notification status reuses an alert lifecycle word', overlap.length === 0,
  overlap.join(','));
check('a queued notification is not described as sent',
  !/\bsent\b/i.test(NOTIFICATION_META.QUEUED.label)
  && /not yet confirmed/i.test(NOTIFICATION_META.QUEUED.help));
check('"no recipient" is a warning, not a silent success',
  NOTIFICATION_META.NO_RECIPIENT.tone === 'warning');
check('a cooldown-suppressed notification says the alert is still open',
  /still open/i.test(NOTIFICATION_META.SKIPPED_COOLDOWN.help));

// The Security Center raises alerts directly and writes its own two statuses.
// 293 rows on the live estate carry `no_channel`, so these are the common case
// in the history table, not an edge case.
check('the Security Center\'s "no_channel" is understood, not shown raw',
  notificationMeta('no_channel').label === 'No channel'
  && notificationMeta('no_channel').tone === 'warning');
// The LABEL must not claim delivery; the HELP is where the caveat lives, and
// "Not yet confirmed sent" is the caveat — so it correctly contains the word.
check('"queued:3" is understood and its label does not claim delivery',
  notificationMeta('queued:3').label === 'Queued (3)'
  && !/\bsent\b/i.test(notificationMeta('queued:3').label)
  && /not yet confirmed/i.test(notificationMeta('queued:3').help),
  notificationMeta('queued:3').label);
check('"queued:1" does not render a pointless count',
  notificationMeta('queued:1').label === 'Queued');
check('an unrecognised status is shown verbatim rather than guessed at',
  notificationMeta('something_new').label === 'something_new'
  && notificationMeta('something_new').tone === 'neutral');
check('no status at all is "Not attempted", never "failed"',
  notificationMeta(null).label === 'Not attempted');

console.log('\n4. Durations read as English and 0 is never "0 seconds"');
check('300s is 5 minutes', humanDuration(300) === '5 minutes', humanDuration(300));
check('3600s is 1 hour', humanDuration(3600) === '1 hour', humanDuration(3600));
check('86400s is 1 day', humanDuration(86400) === '1 day', humanDuration(86400));
check('0 renders as the caller\'s word for off, not "0 seconds"',
  humanDuration(0) === 'Off' && humanDuration(0, { zero: 'None' }) === 'None');
// The important one: an interval that was never set is unknown, not instant.
check('null is NA, never 0', humanDuration(null) === 'NA');
check('undefined is NA, never 0', humanDuration(undefined) === 'NA');
check('a non-numeric value is NA rather than NaN',
  humanDuration('later') === 'NA', humanDuration('later'));

console.log('\n5. The history filter maps to real query states');
check('the default feed is what still needs attention',
  statesFor('').join(',') === 'OPEN,ACKNOWLEDGED');
check('"every state" genuinely means every state',
  statesFor('ALL').join(',') === 'OPEN,ACKNOWLEDGED,RESOLVED');
check('a single state selects only that state',
  statesFor('RESOLVED').join(',') === 'RESOLVED');

console.log('\n6. The Overview consumes alerts, and never invents them');
const noAlerts = buildAttentionItems({ summary: {}, alerts: undefined });
check('no alert data produces no alert items — not a reassuring zero',
  noAlerts.filter((i) => i.action === 'alerts').length === 0);

const withAlerts = buildAttentionItems({
  summary: {},
  alerts: {
    active_alerts: 9,
    alerts_by_severity: { CRITICAL: 2, HIGH: 1, MEDIUM: 6 },
    rules: { enabled: 4 },
    rules_inconclusive: 3,
    delivery: { ready: true },
  },
});
const critical = withAlerts.find((i) => i.id === 'active-alerts-critical');
const other = withAlerts.find((i) => i.id === 'active-alerts-other');
check('critical and high alerts are counted together and surfaced first',
  critical?.count === 3 && withAlerts[0].id === 'active-alerts-critical',
  String(critical?.count));
// 9 active minus the 3 critical/high — the two items must not double-count.
check('the remaining alerts are reported separately, not double-counted',
  other?.count === 6, String(other?.count));
check('a rule that could not read its source is surfaced as a blind spot',
  withAlerts.some((i) => i.id === 'alerts-inconclusive'
    && /unchecked, not clear/i.test(i.message)));
check('every alert item links to the Alerts tab',
  withAlerts.filter((i) => i.id.startsWith('alert')).every((i) => i.action === 'alerts'));

const undeliverable = buildAttentionItems({
  summary: {},
  alerts: {
    active_alerts: 0,
    alerts_by_severity: {},
    rules: { enabled: 5 },
    rules_inconclusive: 0,
    delivery: { ready: false },
  },
});
check('enabled rules with broken delivery are themselves an attention item',
  undeliverable.some((i) => i.id === 'alerts-undeliverable'));
// A quiet account with NO rules must not be accused of broken delivery.
const noRules = buildAttentionItems({
  summary: {},
  alerts: { active_alerts: 0, rules: { enabled: 0 }, delivery: { ready: false } },
});
check('an account with no enabled rules is not flagged for broken delivery',
  !noRules.some((i) => i.id === 'alerts-undeliverable'));

console.log('\n7. A held breach is never presented as an alert');
// PENDING is an internal state for a breach that has not yet cleared the
// minimum-duration bar. If it ever leaks into a state filter it would appear in
// the feed as a real incident, which is exactly what the hold-off prevents.
check('PENDING is not one of the visible lifecycle states',
  !Object.keys(STATE_META).includes('PENDING'), Object.keys(STATE_META).join(','));
check('no state filter can select PENDING',
  !['', 'ALL', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED']
    .flatMap((v) => statesFor(v)).includes('PENDING'));

console.log('\n8. Silence and cooldown are distinct notification outcomes');
check('SILENCED is its own status, not folded into cooldown',
  !!NOTIFICATION_META.SILENCED
  && NOTIFICATION_META.SILENCED.label !== NOTIFICATION_META.SKIPPED_COOLDOWN.label);
check('a silenced notification says the alert was still recorded',
  /still recorded|still open/i.test(NOTIFICATION_META.SILENCED.help),
  NOTIFICATION_META.SILENCED.help);
check('silence is a warning, not a neutral no-op',
  NOTIFICATION_META.SILENCED.tone === 'warning');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
