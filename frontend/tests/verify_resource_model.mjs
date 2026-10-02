// Exercises the Resources workspace's pure frontend logic against node.
// The two things worth pinning: a filter survives a round trip through the URL
// (otherwise a shared link silently drops filters), and an absent value never
// becomes a zero.
import {
  EMPTY_FILTERS, activeFilterCount, costText, filtersFromSearchParams,
  filtersToSearchParams, formatPct, relativeTime, riskMeta, statusMeta,
  toggleFacet,
} from '../src/features/cloud/utils/resourceModel.js';

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

console.log('\n1. Filters survive a round trip through the URL');
const rich = {
  ...EMPTY_FILTERS,
  q: 'payment-api',
  providers: ['AWS', 'Azure'],
  categories: ['COMPUTE'],
  statuses: ['STOPPED', 'UNKNOWN'],
  risk: ['CRITICAL'],
  attachment: 'UNATTACHED',
  hasTags: false,
  hasCost: true,
  stale: true,
  costMin: 100,
  includeDefaults: false,
};
const back = filtersFromSearchParams(new URLSearchParams(filtersToSearchParams(rich).toString()));
check('free text', back.q === 'payment-api');
check('multi-value provider', JSON.stringify(back.providers) === JSON.stringify(['AWS', 'Azure']));
check('multi-value status', JSON.stringify(back.statuses) === JSON.stringify(['STOPPED', 'UNKNOWN']));
check('attachment', back.attachment === 'UNATTACHED');
check('hasTags=false survives (not erased as falsy)', back.hasTags === false, String(back.hasTags));
check('hasCost=true survives', back.hasCost === true);
check('stale survives', back.stale === true);
check('numeric cost bound survives as a number', back.costMin === 100, typeof back.costMin);
check('includeDefaults=false survives', back.includeDefaults === false);

console.log('\n2. An empty filter produces a clean URL');
const emptyUrl = filtersToSearchParams(EMPTY_FILTERS).toString();
check('no parameters at all', emptyUrl === '', JSON.stringify(emptyUrl));
check('and round-trips to empty', activeFilterCount(filtersFromSearchParams(new URLSearchParams(''))) === 0);

console.log('\n3. Active filter count reflects what is narrowing the view');
check('empty is zero', activeFilterCount(EMPTY_FILTERS) === 0);
check('each selected value counts', activeFilterCount({ ...EMPTY_FILTERS, providers: ['AWS', 'Azure'] }) === 2);
check('hasTags=false counts as a filter', activeFilterCount({ ...EMPTY_FILTERS, hasTags: false }) === 1);

console.log('\n4. Facets toggle rather than accumulate');
const once = toggleFacet(EMPTY_FILTERS, 'statuses', 'STOPPED');
const twice = toggleFacet(once, 'statuses', 'STOPPED');
check('selecting adds', JSON.stringify(once.statuses) === '["STOPPED"]');
check('selecting again removes', JSON.stringify(twice.statuses) === '[]');

console.log('\n5. Absent is NA, and NA is never zero');
check('no cost object -> NA', costText(null).text === 'NA');
check('unavailable cost -> NA', costText({ available: false, amount: null }).text === 'NA');
check('...and carries the reason', costText({ available: false, amount: null, reason: 'AWS has no per-resource dimension.' }).title.includes('AWS'));
const real = costText({ available: true, amount: 12400, currency: 'INR', period_days: 30, source: 'billing_api' });
check('a real amount formats with its currency', real.text.includes('12,400'), real.text);
check('...and is marked available', real.available === true);
const zero = costText({ available: true, amount: 0, currency: 'INR' });
check('a REAL zero is 0, not NA', zero.text !== 'NA' && zero.text.includes('0'), zero.text);

console.log('\n6. Unknown is never healthy');
check('UNKNOWN status is neutral', statusMeta('UNKNOWN').tone === 'neutral');
check('...and says so in words', statusMeta('UNKNOWN').label === 'Not reported');
check('a null status is not success', statusMeta(null).tone !== 'success');
check("Azure's PROVISIONING is not success", statusMeta('PROVISIONING').tone !== 'success');
check('RUNNING is success', statusMeta('RUNNING').tone === 'success');
check('risk UNKNOWN is not the reassuring one', riskMeta('UNKNOWN').label === 'Not assessed');
check('risk NONE is distinct from UNKNOWN', riskMeta('NONE').label !== riskMeta('UNKNOWN').label);

console.log('\n7. Percentages and times do not invent values');
check('null percent is not 0%', formatPct(null) === 'Not applicable');
check('a real 0 percent prints as 0%', formatPct(0) === '0%');
check('null timestamp is null, not "just now"', relativeTime(null) === null);
check('a real timestamp formats', /ago|just now/.test(relativeTime(new Date(Date.now() - 6e4).toISOString())));
const ago = (ms) => relativeTime(new Date(Date.now() - ms).toISOString());
const H = 3600e3;
check('2 hours reads "2 hours ago"', ago(2 * H) === '2 hours ago', ago(2 * H));
check('30 hours rolls over into a day', ago(30 * H) === '1 day ago', ago(30 * H));
check('12 days reads "12 days ago", not "5 days ago"', ago(12 * 24 * H) === '12 days ago', ago(12 * 24 * H));
check('45 days reads "1 month ago"', ago(45 * 24 * H) === '1 month ago', ago(45 * 24 * H));
check('400 days reads "1 year ago"', ago(400 * 24 * H) === '1 year ago', ago(400 * 24 * H));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
