/**
 * Cloud Resource Intelligence — presentation model.
 *
 * Run: node src/features/cloud/utils/__tests__/intelligenceModel.test.mjs
 *
 * The three rules this page can quietly break: unknown is never zero, a
 * filter survives the URL, and a card's count is the list it opens. Every
 * check calls the production function (see test-mirrors-prove-nothing).
 */
import {
  CATEGORY_META, CATEGORY_ORDER, DEFAULT_STATUS, STATUS_GROUPS, cardFilters, chartSeries,
  checkMeta, emptyFilters, filtersToParams, formatAxisTick, formatMetric, healthText, healthTone,
  lastCheckText, needsReason, orderTelemetry, parseFilters, resolveLinks, safetyMeta,
  savingsTotalView, savingsView, statusActions, timelineView, toApiFilters, toggleIn,
} from '../intelligenceModel.js';
import { seedFromLink } from '../alertModel.js';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass += 1; else fail += 1;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log('\n1. Unknown is never zero');
{
  const na = savingsView({ priced: false, amount: null, reason: 'OCI does not publish these rates.' });
  eq('an unpriced saving reads N/A', na.text, 'N/A');
  eq('…and carries the backend reason verbatim', na.reason, 'OCI does not publish these rates.');
  eq('a missing savings object is N/A, not ₹0', savingsView(null).text, 'N/A');
  const priced = savingsView({ priced: true, amount: 4254.62, currency: 'INR', method: 'LIST_PRICE' });
  check('a priced saving shows the amount per month', priced.text.includes('/mo') && priced.text.includes('₹'),
    priced.text);
  eq('…and names where it came from', priced.sub, 'provider list price');
  eq('an amount of 0 with priced=false is still N/A', savingsView({ priced: false, amount: 0 }).text, 'N/A');
  eq('the savings card with no priced finding is N/A', savingsTotalView({}).text, 'N/A');
  eq('two currencies are shown side by side, never summed',
    savingsTotalView({ INR: 1500, USD: 20 }).parts.length, 2);
  eq('a metric with no value is N/A', formatMetric(null, 'percent'), 'N/A');
  eq('a real 0% is shown as 0.0%', formatMetric(0, 'percent'), '0.0%');
  eq('bytes are humanised', formatMetric(1536, 'bytes'), '1.5 KB');
  eq('an axis tick for 100% reads 100%, not a clipped "00.0%"', formatAxisTick(100, 'percent'), '100%');
  eq('a large count is short on the axis', formatAxisTick(26000, 'count'), '26K');
  eq('bytes are short on the axis', formatAxisTick(3.3 * 1024 ** 3, 'bytes'), '3.3G');
  eq('a missing tick is blank, not 0', formatAxisTick(null, 'percent'), '');
  eq('a health score that could not be computed is N/A', healthText(null), 'N/A');
  eq('…with a neutral tone, not red', healthTone(null), 'neutral');
  eq('health 85 is good', healthTone(85), 'success');
  eq('health 40 is poor', healthTone(40), 'danger');
}

console.log('\n2. Filters survive the URL');
{
  const f = { ...emptyFilters(), category: ['RIGHTSIZING', 'STORAGE'], severity: ['HIGH'],
    provider: ['OCI'], search: 'koe', has_savings: true, sort: 'savings' };
  const params = filtersToParams(f);
  const back = parseFilters(new URLSearchParams(params));
  eq('a full filter round-trips through the URL', back, f);
  eq('the default status is not written to the URL', filtersToParams(emptyFilters()), {});
  eq('an empty URL means active findings (Open + Acknowledged)', parseFilters(new URLSearchParams()).status,
    DEFAULT_STATUS);
  eq('status=all selects every status', parseFilters(new URLSearchParams({ status: 'all' })).status,
    STATUS_GROUPS);
  eq('unknown values in a shared link are dropped, not guessed',
    parseFilters(new URLSearchParams({ category: 'RIGHTSIZING,BOGUS' })).category, ['RIGHTSIZING']);
  const api = toApiFilters({ ...emptyFilters(), status: [] });
  eq('an emptied status filter falls back to the active statuses, never "everything"', api.status,
    DEFAULT_STATUS);
  eq('toggle adds then removes', toggleIn(toggleIn([], 'COST'), 'COST'), []);
}

console.log('\n3. A card opens exactly the list it counted');
{
  const c = cardFilters({ id: 'critical', filter: { severity: ['CRITICAL'] } });
  eq('the Critical card filters to CRITICAL', c.severity, ['CRITICAL']);
  eq('…with the default status, like its count', c.status, DEFAULT_STATUS);
  eq('…and nothing else carried over', c.category, []);
  eq('the savings card filters to priced findings', cardFilters({ filter: { has_savings: true } }).has_savings,
    true);
  eq('the Unused card filters by signal', cardFilters({ filter: { signal: ['UNUSED'] } }).signal, ['UNUSED']);
  eq('a card with no list (resources analysed) returns null', cardFilters({ filter: null }), null);
}

console.log('\n4. Vocabulary is complete');
{
  const missing = CATEGORY_ORDER.filter((c) => !CATEGORY_META[c]);
  eq('every category in the chip order has presentation', missing, []);
  eq('13 categories, as the backend declares', CATEGORY_ORDER.length, 13);
  eq('an unknown safety verdict is "cannot be determined", never "safe"', safetyMeta('???').label,
    'Cannot be determined');
  eq('an unknown check state is not shown as verified', checkMeta('???').label, 'Not verifiable here');
}

console.log('\n5. Actions');
{
  eq('an open finding can be acknowledged, suppressed or marked resolved', statusActions('OPEN'),
    ['ACKNOWLEDGED', 'SUPPRESSED', 'RESOLVED']);
  eq('a suppressed finding can only be reopened', statusActions('SUPPRESSED'), ['OPEN']);
  check('suppressing needs a reason', needsReason('SUPPRESSED') && !needsReason('ACKNOWLEDGED'));
}

console.log('\n6. Links, charts, history');
{
  const links = resolveLinks({
    resource: '/cloud/resources/r1', monitoring: '/cloud/resources/r1/metrics',
    cost: { tab: 'cost', query: '?resource=r1' }, drift: { tab: 'drift', query: '?resource=r1&range=30d' },
    alert: { condition: 'intelligence_finding_count', config: { category_filter: 'RIGHTSIZING' } },
  }, '/cloud/oci-accounts/a1');
  eq('a tab hand-off resolves against the account route', links.cost, '/cloud/oci-accounts/a1/cost?resource=r1');
  check('the alert link carries the condition and its config to the Alerts tab',
    links.alert.startsWith('/cloud/oci-accounts/a1/alerts?newRule=intelligence_finding_count&config=')
    && decodeURIComponent(links.alert.split('config=')[1]).includes('RIGHTSIZING'), links.alert);
  eq('no account route → no tab links', resolveLinks({ cost: { tab: 'cost' } }, null).cost, null);
  const series = chartSeries({ series: [[200, 5], [100, 3]], peak_series: [[100, 9]] });
  eq('series are sorted and converted to milliseconds', series.map((p) => p.t), [100000, 200000]);
  eq('the per-hour peak is merged in by timestamp', series[0].peak, 9);
  eq('a point without a peak has none invented', series[1].peak, undefined);
  eq('CPU charts before network', orderTelemetry([{ metric: 'network_in' }, { metric: 'cpu_percent' }])
    .map((r) => r.metric), ['cpu_percent', 'network_in']);
  const tl = timelineView([{ at: '2026-09-30T10:00', event: 'resolved', by: 'analysis' },
    { at: '2026-09-29T10:00', event: 'detected', by: 'analysis' }]);
  eq('the timeline is oldest first', tl.map((e) => e.label), ['Detected', 'Resolved']);
  eq('analysis entries are attributed to the analysis', tl[0].by, 'Analysis');
  check('an open finding whose re-check could not decide says so',
    (lastCheckText({ verdict: 'INSUFFICIENT_DATA', reason: 'CPU: timeout' }) || '').includes('stays open'));
  eq('a re-confirmed finding says so', lastCheckText({ verdict: 'FINDING' }),
    'Re-confirmed by the latest analysis.');
}

console.log('\n7. "Create alert" seeds the rule builder from the backend catalog');
{
  const caps = { categories: [
    { key: 'resource', conditions: [{ key: 'intelligence_finding_count', label: 'Open optimization findings',
      summary: 's', fields: [{ key: 'category_filter' }, { key: 'severity_filter' }, { key: 'operator' },
        { key: 'threshold' }] }] },
    { key: 'security', conditions: [{ key: 'security_finding_count', label: 'Open security findings',
      fields: [{ key: 'severity_filter' }] }] },
  ] };
  const seed = seedFromLink('intelligence_finding_count',
    JSON.stringify({ category_filter: 'RIGHTSIZING', severity_filter: 'HIGH', bogus: 1 }), caps);
  eq('the seed carries the condition and its category from the catalog',
    [seed.condition_type, seed.category], ['intelligence_finding_count', 'resource']);
  eq('…keeps only the fields the condition declares', Object.keys(seed.condition_config).sort(),
    ['category_filter', 'severity_filter']);
  eq('…and takes its severity from the finding', seed.severity, 'HIGH');
  eq('an unknown condition opens nothing', seedFromLink('made_up', '{}', caps), null);
  eq('malformed config is ignored, not fatal',
    seedFromLink('security_finding_count', '{not json', caps).condition_config, {});
  eq('no catalog loaded yet → no seed', seedFromLink('security_finding_count', '{}', null), null);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
