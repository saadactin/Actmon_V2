// utils/eventFormat.js — the Event Log's vocabulary and time handling.
//
// Two classes of bug this pins:
//
// Time. An audit trail that shows a timestamp without a zone, or quietly an
// hour out, is worse than one that shows nothing — people reconstruct
// incidents from these. formatUtc is asserted to be timezone-INVARIANT by
// construction, so this suite gives the same answer on any machine.
//
// Derived lists drifting apart. TIME_RANGES feeds the selector, RANGE_HOURS
// feeds "Collect now". Add "48h" to the first and forget the second and the
// button silently fetches 24 hours under a label that says 48 — no error
// anywhere. Checked in BOTH directions.
import {
  ACTION_OPTIONS, ACTOR_TYPE_OPTIONS, CATEGORY_CHIPS, DEFAULT_RANGE,
  MIN_RISK_OPTIONS, PAGE_SIZE_OPTIONS, RANGE_HOURS,
  RISK_OPTIONS, RISK_ORDER, RISK_TONE, SORT_OPTIONS, SOURCE_STATUS_ADVICE,
  SOURCE_STATUS_META, STATUS_OPTIONS, STATUS_TONE, TIME_RANGES,
  collectionLookbackHours, formatCount, formatEventDate, formatEventTime,
  formatUtc, relativeTime,
} from '../src/features/cloud/utils/eventFormat.js';
// The provider badge palette moved out of eventFormat into the one brand
// registry. Asserting against the real styling function rather than a map of
// class strings also means this now exercises the Oracle→OCI normalisation
// itself, instead of checking that someone remembered to type two keys.
import { PROVIDER_COLOR, providerBadgeStyle } from '../src/features/cloud/utils/providerTheme.js';

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

console.log('\n1. TIME_RANGES and RANGE_HOURS agree, in both directions');
{
  const rangeIds = TIME_RANGES.map((r) => r.id);
  const hourKeys = Object.keys(RANGE_HOURS);

  for (const id of rangeIds) {
    check(`the selector offers "${id}" and RANGE_HOURS knows it`,
      Object.prototype.hasOwnProperty.call(RANGE_HOURS, id),
      'a range with no hour mapping silently collects the DEFAULT window');
  }
  for (const key of hourKeys) {
    check(`RANGE_HOURS "${key}" is actually offered by the selector`,
      rangeIds.includes(key), 'an orphan mapping nothing can select');
  }
  check('DEFAULT_RANGE is one of the offered ranges',
    rangeIds.includes(DEFAULT_RANGE), DEFAULT_RANGE);
  check('every range id is unique', new Set(rangeIds).size === rangeIds.length);
  check('every range has a human label',
    TIME_RANGES.every((r) => typeof r.label === 'string' && r.label.length > 0));
  check('every RANGE_HOURS value is a whole number of hours, at least 1 '
    + '(the API takes whole hours and rejects 0)',
    Object.values(RANGE_HOURS).every((h) => Number.isInteger(h) && h >= 1));
}

console.log('\n2. collectionLookbackHours always returns a usable whole number');
{
  check('a named range maps to its hours', collectionLookbackHours({ range: '7d' }) === 168,
    String(collectionLookbackHours({ range: '7d' })));
  check('an UNKNOWN range falls back to the default window, never NaN — '
    + 'lookback_hours=NaN is a 422 the user reads as "collection failed"',
    collectionLookbackHours({ range: 'nonsense' }) === RANGE_HOURS[DEFAULT_RANGE],
    String(collectionLookbackHours({ range: 'nonsense' })));

  for (const input of [
    {}, { range: '15m' }, { range: '365d' }, { range: undefined },
    { useCustom: true }, { useCustom: true, start: 'nonsense' },
    { useCustom: true, start: '2026-09-01T00:00:00Z', end: '2026-08-01T00:00:00Z' },
  ]) {
    const hours = collectionLookbackHours(input);
    check(`collectionLookbackHours(${JSON.stringify(input)}) is a whole number >= 1`,
      Number.isInteger(hours) && hours >= 1, String(hours));
  }

  // A custom window that ENDS in the past still has to reach back from now.
  const now = Date.now();
  const custom = collectionLookbackHours({
    useCustom: true,
    start: new Date(now - 72 * 3_600_000).toISOString(),
    end: new Date(now - 48 * 3_600_000).toISOString(),
  });
  check('a custom window 72h..48h ago asks for ~72 hours, not the window WIDTH '
    + '(24) — the tempting (to-from) simplification under-fetches and returns '
    + 'an empty result for any past window',
    custom >= 71 && custom <= 73, String(custom));

  const recent = collectionLookbackHours({
    useCustom: true, start: new Date(now - 10 * 60_000).toISOString(),
  });
  check('a custom window starting 10 minutes ago rounds UP to 1, never 0',
    recent === 1, String(recent));

  const reversed = collectionLookbackHours({
    useCustom: true, range: '7d',
    start: new Date(now).toISOString(), end: new Date(now - 3_600_000).toISOString(),
  });
  check('a REVERSED custom window falls back to the named range rather than '
    + 'returning a negative', reversed === 168, String(reversed));
}

console.log('\n3. Risk and status tones: nothing dangerous is ever painted green');
{
  for (const level of RISK_ORDER) {
    check(`RISK_TONE covers "${level}"`,
      Object.prototype.hasOwnProperty.call(RISK_TONE, level),
      'an unmapped risk level renders unstyled');
  }
  check('CRITICAL and HIGH share the danger tone',
    RISK_TONE.CRITICAL === 'danger' && RISK_TONE.HIGH === 'danger',
    `${RISK_TONE.CRITICAL}/${RISK_TONE.HIGH}`);
  check('NO risk level is toned "success" — an audit event is never good news, '
    + 'and a green INFO row reads as "checked, all clear"',
    !Object.values(RISK_TONE).includes('success'),
    JSON.stringify(RISK_TONE));
  check('RISK_ORDER runs low to high, ending at CRITICAL',
    RISK_ORDER[RISK_ORDER.length - 1] === 'CRITICAL' && RISK_ORDER[0] === 'INFO');
  check('every STATUS_TONE entry is a non-empty string',
    Object.values(STATUS_TONE).every((t) => typeof t === 'string' && t.length > 0));
}

console.log('\n4. Every option list is well-formed');
{
  const lists = {
    CATEGORY_CHIPS, ACTOR_TYPE_OPTIONS, ACTION_OPTIONS, STATUS_OPTIONS,
    RISK_OPTIONS, MIN_RISK_OPTIONS, SORT_OPTIONS,
  };
  for (const [name, list] of Object.entries(lists)) {
    const ids = list.map((o) => o.id);
    check(`${name}: ids are unique (a duplicate is a React key warning and an `
      + `ambiguous <select> value)`, new Set(ids).size === ids.length,
    ids.filter((id, i) => ids.indexOf(id) !== i).join(', '));
    check(`${name}: every entry has a label`,
      list.every((o) => typeof o.label === 'string' && o.label.length > 0));

    const blanks = ids.filter((id) => id === '');
    if (blanks.length) {
      check(`${name}: exactly one "All" entry, and it is first`,
        blanks.length === 1 && ids[0] === '', `${blanks.length} blank ids`);
    }
  }

  check('RISK_OPTIONS ids are real risk levels (or the All entry) — a "CRIT" '
    + 'for "CRITICAL" silently returns zero rows',
    RISK_OPTIONS.every((o) => o.id === '' || RISK_ORDER.includes(o.id)),
    RISK_OPTIONS.map((o) => o.id).join(', '));
  check('MIN_RISK_OPTIONS ids are real risk levels (or the All entry)',
    MIN_RISK_OPTIONS.every((o) => o.id === '' || RISK_ORDER.includes(o.id)),
    MIN_RISK_OPTIONS.map((o) => o.id).join(', '));

  // PAGE_SIZE_OPTIONS are {id, label} objects with STRING ids, so they drop
  // straight into a <Select> alongside every other option list here.
  check('PAGE_SIZE_OPTIONS ids are numeric strings, ascending',
    PAGE_SIZE_OPTIONS.every((o, i) => /^\d+$/.test(o.id)
      && (i === 0 || Number(o.id) > Number(PAGE_SIZE_OPTIONS[i - 1].id))),
    PAGE_SIZE_OPTIONS.map((o) => o.id).join(', '));
  check('PAGE_SIZE_OPTIONS labels say what the number means',
    PAGE_SIZE_OPTIONS.every((o) => /per page/.test(o.label)),
    PAGE_SIZE_OPTIONS.map((o) => o.label).join(', '));
}

console.log('\n5. SORT_OPTIONS match what the backend can actually sort by');
{
  // From Backend/cloud/app/repository/*event*.py's SORTABLE dict. The backend
  // falls back to "newest" for an unknown key rather than erroring, so a
  // wrong id here does not 422 -- it silently sorts by something else.
  const BACKEND_SORTABLE = [
    'newest', 'oldest', 'risk', 'actor', 'resource', 'provider', 'status',
    'event_type', 'category',
  ];
  for (const option of SORT_OPTIONS) {
    check(`SORT_OPTIONS "${option.id}" is a key the backend's SORTABLE knows`,
      BACKEND_SORTABLE.includes(option.id),
      'the backend silently falls back to "newest" for an unknown sort key');
  }
}

console.log('\n6. Timestamps always carry a zone, and UTC is genuinely UTC');
{
  const iso = '2026-09-08T14:32:11Z';
  check('formatUtc renders the exact UTC instant with an explicit UTC suffix — '
    + 'TZ-invariant by construction, so an audit trail cannot drift an hour',
    formatUtc(iso) === '2026-09-08 14:32:11 UTC', formatUtc(iso));

  check('formatEventTime carries a zone suffix by default',
    formatEventTime(iso).trim().split(' ').length >= 3, formatEventTime(iso));
  check('formatEventTime can be asked to omit the zone',
    formatEventTime(iso, { withZone: false }).length > 0);
  // DD-Mon-YYYY with a NAMED month, which is the point — 08/09/2026 reverses
  // meaning between readers. The month abbreviation comes from ICU, which
  // renders September as "Sept" (4 letters), so the month is matched as 3-5
  // letters rather than exactly 3. The module's own docstring example says
  // "08-Sep-2026"; that comment is one letter out, the code is correct.
  check('formatEventTime renders an unambiguous DD-Mon-YYYY date with a named month',
    /^\d{2}-[A-Z][a-z]{2,4}-\d{4}/.test(formatEventTime(iso)), formatEventTime(iso));
  check('formatEventTime never renders a numeric-month date that reverses by locale',
    !/^\d{2}[/-]\d{2}[/-]\d{4}/.test(formatEventTime(iso)), formatEventTime(iso));

  for (const bad of [null, '', 'not-a-date', undefined]) {
    for (const [name, fn] of Object.entries({
      formatEventTime, formatEventDate, formatUtc, relativeTime,
    })) {
      check(`${name}(${JSON.stringify(bad)}) is an em dash, never "Invalid Date NaN"`,
        fn(bad) === '—', fn(bad));
    }
  }
}

console.log('\n7. relativeTime thresholds');
{
  const now = Date.now();
  const at = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString();
  check('under 5 seconds reads "just now"', relativeTime(at(4)) === 'just now', relativeTime(at(4)));
  check('6 seconds reads in seconds', relativeTime(at(6)) === '6s ago', relativeTime(at(6)));
  check('90 seconds rounds to 2m', relativeTime(at(90)) === '2m ago', relativeTime(at(90)));
  check('25 hours reads 1d', relativeTime(at(25 * 3600)) === '1d ago', relativeTime(at(25 * 3600)));
  check('40 days falls back to a DATE, not "40d ago" — past a month, the '
    + 'actual date is what someone needs',
    /^\d{2}-[A-Z][a-z]{2}/.test(relativeTime(at(40 * 86400))), relativeTime(at(40 * 86400)));
}

console.log('\n8. formatCount: unknown is a dash, zero is a zero');
{
  check('formatCount(null) is an em dash', formatCount(null) === '—');
  check('formatCount(undefined) is an em dash', formatCount(undefined) === '—');
  check('formatCount(0) is "0" — a real zero is not an unknown',
    formatCount(0) === '0', formatCount(0));
  check('formatCount groups thousands', formatCount(1234567).includes(','), formatCount(1234567));
}

console.log('\n9. Every alarming collection status carries advice');
{
  for (const [status, meta] of Object.entries(SOURCE_STATUS_META)) {
    check(`SOURCE_STATUS_META.${status} has a tone and a label`,
      !!meta.tone && !!meta.label, JSON.stringify(meta));
  }
  for (const [status, meta] of Object.entries(SOURCE_STATUS_META)) {
    if (meta.tone === 'danger' || meta.tone === 'warning') {
      check(`"${status}" is ${meta.tone} and therefore MUST carry advice — `
        + `"a red badge with no next step just tells someone to worry"`,
        typeof SOURCE_STATUS_ADVICE[status] === 'string'
        && SOURCE_STATUS_ADVICE[status].length > 20,
        SOURCE_STATUS_ADVICE[status] || 'MISSING');
    }
  }
  for (const status of Object.keys(SOURCE_STATUS_ADVICE)) {
    check(`advice for "${status}" describes a real status`,
      Object.prototype.hasOwnProperty.call(SOURCE_STATUS_META, status),
      'advice for a status nothing can report');
  }
  check('Connected is the only status toned success',
    Object.entries(SOURCE_STATUS_META).filter(([, m]) => m.tone === 'success')
      .map(([k]) => k).join(',') === 'Connected');
  check('Partial is a warning, never a success — some scopes failing is '
    + 'neither Connected nor down',
    SOURCE_STATUS_META.Partial.tone === 'warning');
}

console.log('\n10. Provider badges know Oracle and OCI are the same cloud');
{
  const styleOf = (p) => JSON.stringify(providerBadgeStyle(p));

  check('"Oracle" and "OCI" style identically — the alias this codebase '
    + 'forgets in every new place',
    styleOf('OCI') === styleOf('Oracle'),
    `${styleOf('OCI')} vs ${styleOf('Oracle')}`);
  check('AWS and Azure have pinned brand hues too',
    Boolean(PROVIDER_COLOR.AWS && PROVIDER_COLOR.Azure && PROVIDER_COLOR.OCI),
    Object.keys(PROVIDER_COLOR).join(', '));

  // The bug the whole registry exists to prevent: a provider chip painted with
  // a fixed light-palette swatch is a near-white block on the three dark
  // themes. Every colour a badge carries must either mix against the live
  // theme or be the brand hue itself — never a literal #rrggbb background.
  const aws = providerBadgeStyle('AWS');
  check('badge surfaces mix against the theme rather than pinning a swatch',
    aws.backgroundColor.startsWith('color-mix(')
      && aws.borderColor.startsWith('color-mix('),
    `${aws.backgroundColor} / ${aws.borderColor}`);
  check('badge ink is mixed toward the theme foreground, so it stays readable '
    + 'on a white card and on a black one',
    aws.color.includes('var(--fg)'), aws.color);

  // An unrecognised provider must not silently borrow AWS orange.
  check('an unknown provider falls back to the theme\'s neutral ink',
    providerBadgeStyle('Nimbus').color.includes('var(--status-unknown)'),
    providerBadgeStyle('Nimbus').color);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
