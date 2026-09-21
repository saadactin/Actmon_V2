// utils/costFormat.js — money formatting.
//
// One rule governs the whole module: null/undefined is NA, and NA is not
// zero. The backend returns null when a provider did not tell us a value and
// 0 only when it reported a real zero, so every assertion below checks BOTH
// directions — a missing value must never render as a real-looking 0, and a
// real 0 must never be hidden as NA.
//
// The single most likely well-meant regression in this file is the tone of
// `changeLabel`: in almost every other metric rising is green, but rising
// COST is bad. That one is pinned explicitly.
import {
  MAX_SERIES, NA, QUALITY_META, SERIES_VARS, SOURCE_LABELS, STATUS_META,
  axisTick, changeLabel, compact, exact, formatDate, formatDateShort,
  groupByCurrency, isMissing, percent, relativeTime, seriesColor, sourceLabel,
  symbolFor, topNWithOther,
} from '../src/features/cloud/utils/costFormat.js';

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

console.log('\n0. ICU guard — every locale assertion below depends on this');
// Node 18+ ships full ICU, but a small-ICU build would make en-IN silently
// fall back to en-US and turn half this suite red with a confusing diff.
// One clear failure here beats twenty misleading ones.
check('this Node has full ICU (en-IN grouping works)',
  (1234567.5).toLocaleString('en-IN').includes(','),
  (1234567.5).toLocaleString('en-IN'));

console.log('\n1. Missing is NA — and a real zero is NOT');
{
  check('exact(null) is NA', exact(null, 'USD') === NA, exact(null, 'USD'));
  check('exact(undefined) is NA', exact(undefined, 'USD') === NA);
  check('compact(null) is NA', compact(null, 'INR') === NA);
  check('percent(null) is NA', percent(null) === NA);
  check('percent(NaN) is NA', percent(NaN) === NA);
  check('relativeTime(null) is NA', relativeTime(null) === NA);
  check('formatDate(null) is NA', formatDate(null) === NA);
  check('formatDate("garbage") is NA', formatDate('garbage') === NA);
  check('isMissing treats NaN as missing', isMissing(NaN) === true);
  check('isMissing does NOT treat 0 as missing', isMissing(0) === false);

  // The inverse, and the reason the rule has two halves: a provider that
  // genuinely billed nothing must show a zero, not "we don't know".
  check('exact(0,USD) is a real $0.00, never NA', exact(0, 'USD') === '$0.00', exact(0, 'USD'));
  check('compact(0,INR) is a real ₹0, never NA', compact(0, 'INR') === '₹0', compact(0, 'INR'));
  check('percent(0) is 0.0%, never NA', percent(0) === '0.0%', percent(0));
}

console.log('\n2. Currency symbols are never guessed');
{
  check('symbolFor(undefined) is an empty string, never a guessed "$" — '
    + 'a dollar sign on an INR figure is a wrong number, not a cosmetic slip',
    symbolFor(undefined) === '', JSON.stringify(symbolFor(undefined)));
  check('symbolFor(null) is likewise empty', symbolFor(null) === '');
  check('symbolFor("INR") is the rupee sign', symbolFor('INR') === '₹');
  check('symbolFor("USD") is the dollar sign', symbolFor('USD') === '$');
  check('symbolFor of an unmapped code returns the CODE plus a trailing space '
    + '— the space is load-bearing, it concatenates straight onto the number',
    symbolFor('SGD') === 'SGD ', JSON.stringify(symbolFor('SGD')));
  check('a known currency uses its symbol', exact(5, 'INR') === '₹5.00', exact(5, 'INR'));
  check('an unmapped currency renders as "SGD 5.00", not a bare or guessed symbol',
    exact(5, 'SGD') === 'SGD 5.00', exact(5, 'SGD'));
  check('an unknown currency renders the number with no symbol at all',
    exact(5, undefined) === '5.00', exact(5, undefined));
}

console.log('\n3. Compact scaling: INR uses lakh/crore, everything else K/M/B');
{
  check('₹45,23,727 compacts to ₹45.24L', compact(4523727, 'INR') === '₹45.24L', compact(4523727, 'INR'));
  check('₹1,00,00,000 compacts to ₹1Cr (trailing .00 stripped)',
    compact(1e7, 'INR') === '₹1Cr', compact(1e7, 'INR'));
  check('$1,420 compacts to $1.42K', compact(1420, 'USD') === '$1.42K', compact(1420, 'USD'));
  check('$4,523,727 compacts to $4.52M (M, not L — the INR branch must not leak)',
    compact(4523727, 'USD') === '$4.52M', compact(4523727, 'USD'));
  check('$1,000,000,000 compacts to $1B', compact(1e9, 'USD') === '$1B', compact(1e9, 'USD'));

  // Sign placement: "-$1.50K" is right, "$-1.50K" is the obvious slip.
  // (The trailing-zero strip only removes an exact ".00", so 1.5 stays
  // "1.50" — that is the module's behaviour, not a rounding bug.)
  check('a negative compacts with the sign BEFORE the symbol, never "$-"',
    compact(-1500, 'USD').startsWith('-$') && compact(-1500, 'USD') === '-$1.50K',
    compact(-1500, 'USD'));
  check('a whole number strips its trailing .00 but a real fraction is kept',
    compact(2000, 'USD') === '$2K' && compact(2500, 'USD') === '$2.50K',
    `${compact(2000, 'USD')} / ${compact(2500, 'USD')}`);
}

console.log('\n4. Axis ticks carry no symbol (the axis label already does) and no NA');
{
  check('axisTick(null) is an empty string, NOT "NA" (an axis tick reading '
    + '"NA" is furniture, not information)', axisTick(null, 'USD') === '', axisTick(null, 'USD'));
  check('axisTick carries no currency symbol', !axisTick(1500, 'INR').includes('₹'), axisTick(1500, 'INR'));
  check('axisTick keeps the sign on a negative (credits and refunds are real)',
    axisTick(-1500, 'USD').startsWith('-'), axisTick(-1500, 'USD'));
  check('axisTick uses the INR scale for INR', axisTick(1e7, 'INR').endsWith('Cr'), axisTick(1e7, 'INR'));
  check('axisTick uses M/B outside INR', axisTick(1e6, 'USD').endsWith('M'), axisTick(1e6, 'USD'));
}

console.log('\n5. changeLabel: RISING COST IS BAD — the inverse of most metrics');
{
  check('a +5% change is toned "danger" (cost going UP is bad news)',
    changeLabel(5).tone === 'danger', changeLabel(5).tone);
  check('a -5% change is toned "success" (cost going DOWN is good news)',
    changeLabel(-5).tone === 'success', changeLabel(-5).tone);
  check('a 0% change is neutral', changeLabel(0).tone === 'neutral', changeLabel(0).tone);
  check('a positive change is signed with a +', changeLabel(5).text === '+5.0%', changeLabel(5).text);
  check('a zero change carries no + sign', changeLabel(0).text === '0.0%', changeLabel(0).text);
  check('direction tracks the sign',
    changeLabel(5).direction === 'up' && changeLabel(-5).direction === 'down'
    && changeLabel(0).direction === 'flat');

  // The whole reason this function exists rather than a bare percentage.
  const fromZero = changeLabel({ kind: 'new', percent: null, label: 'New' });
  check('a jump from zero reads "New", never an infinite percentage',
    fromZero.text === 'New' && fromZero.tone === 'warning', JSON.stringify(fromZero));
  for (const input of [5, -5, 0, { kind: 'new', percent: null, label: 'New' },
    { percent: 12.5 }, { percent: null, label: 'No baseline' }, null, undefined]) {
    const text = changeLabel(input).text;
    check(`changeLabel(${JSON.stringify(input)}) never renders Infinity or NaN`,
      !/Infinity|NaN/.test(text), text);
  }

  check('changeLabel(null) is NA/flat/neutral, not a crash',
    changeLabel(null).text === NA && changeLabel(null).tone === 'neutral');
  check('a Change object with a real percent is formatted like a bare number',
    changeLabel({ percent: 12.5 }).text === '+12.5%', changeLabel({ percent: 12.5 }).text);
  check('a Change object carries its reason through',
    changeLabel({ percent: 12.5, reason: 'partial window' }).reason === 'partial window');
}

console.log('\n6. The categorical palette is never cycled');
{
  check('seriesColor(0) is the first palette slot', seriesColor(0) === SERIES_VARS[0]);
  check('seriesColor(7) is the last palette slot', seriesColor(7) === SERIES_VARS[7]);
  check('seriesColor(8) falls back to the TRACK colour, it does NOT wrap to '
    + 'slot 0 — two different services in the same colour is the failure this '
    + 'module exists to prevent',
    seriesColor(8) === 'var(--chart-track)' && seriesColor(8) !== SERIES_VARS[0],
    seriesColor(8));
  check('every palette entry is distinct', new Set(SERIES_VARS).size === SERIES_VARS.length);
  check('MAX_SERIES matches the palette length', MAX_SERIES === SERIES_VARS.length);
}

console.log('\n7. topNWithOther: no premature bucketing, no NaN, no mutation');
{
  const five = [
    { name: 'a', amount: 5 }, { name: 'b', amount: 4 }, { name: 'c', amount: 3 },
    { name: 'd', amount: 2 }, { name: 'e', amount: 1 },
  ];
  const small = topNWithOther(five, 7);
  check('a list that fits gets NO "Other" bucket', small.other === null, JSON.stringify(small.other));
  check('a list that fits keeps every row', small.items.length === 5);

  const many = Array.from({ length: 12 }, (_, i) => ({ name: `s${i}`, amount: 12 - i }));
  const big = topNWithOther(many, 7);
  check('a list that overflows gets exactly 7 items plus Other', big.items.length === 7 && !!big.other);
  check('Other counts the rows it absorbed', big.other.count === 5, String(big.other.count));
  check('Other sums the amounts it absorbed', big.other.amount === 5 + 4 + 3 + 2 + 1,
    String(big.other.amount));

  // A single undefined amount must not poison the whole Other slice into NaN,
  // which renders as a missing wedge with no error anywhere.
  const withMissing = [
    ...Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, amount: 10 - i })),
    { name: 'x', amount: undefined }, { name: 'y', amount: 2 },
  ];
  const other = topNWithOther(withMissing, 7).other;
  check('an undefined amount does not turn the Other total into NaN',
    Number.isFinite(other.amount), String(other.amount));

  const input = [{ name: 'z', amount: 1 }, { name: 'a', amount: 9 }];
  const before = JSON.stringify(input);
  topNWithOther(input, 7);
  check('topNWithOther does not mutate or reorder its input array '
    + '(the caller\'s table would silently reorder)', JSON.stringify(input) === before);
}

console.log('\n8. Currencies are grouped, never summed together');
{
  const grouped = groupByCurrency([
    { currency: 'USD', amount: 10 }, { currency: 'INR', amount: 900 },
    { currency: 'USD', amount: 5 },
  ]);
  check('two currencies produce TWO blocks, never one combined total',
    grouped.length === 2, JSON.stringify(grouped.map((g) => g.currency)));
  check('rows land under their own currency',
    grouped.find((g) => g.currency === 'USD').items.length === 2);

  const unknown = groupByCurrency([{ amount: 1 }]);
  check('a row with no currency groups under UNKNOWN, not under a guessed one',
    unknown[0].currency === 'UNKNOWN', unknown[0].currency);
  check('groupByCurrency(null) is an empty list, not a crash',
    groupByCurrency(null).length === 0);
}

console.log('\n9. Vocabulary: list pricing is never called actual spend');
{
  for (const [key, label] of Object.entries(SOURCE_LABELS)) {
    check(`SOURCE_LABELS.${key} does not claim "actual" or "spend"`,
      !/actual|spend/i.test(label), label);
  }
  check('an unknown source falls back to a stated "Unknown source"',
    sourceLabel(null) === 'Unknown source', sourceLabel(null));
  check('an unrecognised source is echoed rather than mislabelled',
    sourceLabel('something_new') === 'something_new');
}

console.log('\n10. Status tones: only "complete" may read as success');
{
  const successes = Object.entries(STATUS_META)
    .filter(([, meta]) => meta.tone === 'success').map(([k]) => k);
  check('exactly one status is toned success, and it is "complete" — '
    + '"partial" reading as green is how incomplete billing looks healthy',
    successes.length === 1 && successes[0] === 'complete', successes.join(', '));
  check('partial is toned warning', STATUS_META.partial.tone === 'warning');
  check('failed and permission_denied are toned danger',
    STATUS_META.failed.tone === 'danger' && STATUS_META.permission_denied.tone === 'danger');
  check('every STATUS_META entry has both a label and a tone',
    Object.values(STATUS_META).every((m) => m.label && m.tone));
  check('every QUALITY_META entry has both a label and a tone',
    Object.values(QUALITY_META).every((m) => m.label && m.tone));
  check('QUALITY_META.unavailable is never toned success',
    QUALITY_META.unavailable.tone !== 'success');
}

console.log('\n11. Dates are unambiguous across locales');
{
  check('formatDate renders "01 Aug 2026", never a locale-reversible 08/01',
    formatDate('2026-08-01T00:00:00Z') === '01 Aug 2026', formatDate('2026-08-01T00:00:00Z'));
  check('formatDateShort drops the year but keeps the month name',
    formatDateShort('2026-08-01T00:00:00Z') === '01 Aug', formatDateShort('2026-08-01T00:00:00Z'));
  check('formatDateShort(null) is empty (it is used inline, not as a value)',
    formatDateShort(null) === '');
}

console.log('\n12. relativeTime never claims freshness it cannot know');
{
  const now = Date.now();
  check('30 seconds ago reads in seconds',
    relativeTime(new Date(now - 30_000).toISOString()).endsWith('s ago'));
  check('5 minutes ago reads in minutes',
    relativeTime(new Date(now - 300_000).toISOString()) === '5 min ago',
    relativeTime(new Date(now - 300_000).toISOString()));
  check('3 hours ago reads in hours',
    relativeTime(new Date(now - 3 * 3600_000).toISOString()) === '3h ago');
  check('2 days ago reads in days',
    relativeTime(new Date(now - 2 * 86400_000).toISOString()) === '2d ago');
  check('an unparseable timestamp is NA, never "just now"',
    relativeTime('not-a-date') === NA);
  // A clock skew that puts the timestamp in the future must not render a
  // negative age.
  check('a future timestamp clamps to 0s rather than going negative',
    !relativeTime(new Date(now + 60_000).toISOString()).includes('-'),
    relativeTime(new Date(now + 60_000).toISOString()));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
