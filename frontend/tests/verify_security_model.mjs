// utils/securityModel.js — the Security Center's vocabulary.
//
// This module encodes a product rule that exists nowhere else in executable
// form: **this product never tells anyone they are secure or compliant.** It
// reports what a check observed. "Control passed" is a statement about one
// control; "Compliant" is a claim about an organisation that no scanner can
// make. That rule currently lives only in prose, and prose does not fail a
// build — section 1 makes it fail one.
//
// The second load-bearing rule: VULNERABLE means the condition was confirmed,
// UNKNOWN means the data was not available. They must never look alike. An
// engine that cannot read a setting reporting the same green as one that
// read it and found nothing wrong is the single most damaging thing a
// security tool can do.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATEGORY_ICON, CONFIDENCE_META, CONTROL_STATE_META, CONTROL_STATE_ORDER,
  EXPOSURE_META, GRADE_COLOR, NON_SECURITY_CATEGORIES, PROVIDER_LABEL,
  SEVERITY_ACCENT, SEVERITY_ORDER, SEVERITY_TONE, STATUS_META,
  STATUS_NEEDS_REASON, VERDICT_META,
  categoryIcon, confidenceMeta, controlStateMeta, coverageTone, exposureMeta,
  dimensionLabel, formatAge, formatCount, formatDateTime, formatPct, gradeColor,
  groupFailedScopes, isRealGrade, providerLabel, severityAccent, severityRank,
  severityTone, statusMeta, verdictMeta,
} from '../src/features/cloud/utils/securityModel.js';

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

console.log('\n1. THE PRODUCT RULE: nothing here claims "secure" or "compliant"');
{
  const tables = {
    VERDICT_META, CONFIDENCE_META, STATUS_META, EXPOSURE_META, CONTROL_STATE_META,
  };
  for (const [name, table] of Object.entries(tables)) {
    for (const [key, meta] of Object.entries(table)) {
      check(`${name}.${key} label does not claim "secure" or "compliant"`,
        !/\bsecure\b|\bcompliant\b/i.test(meta.label), meta.label);
    }
  }
  check('a passing control says "Control passed", not "Compliant" — the '
    + 'former is a statement about one control, the latter a claim about an '
    + 'organisation that no scanner can make',
    CONTROL_STATE_META.PASS.label === 'Control passed', CONTROL_STATE_META.PASS.label);
  check('a clear check says "Checked — clear", not "Secure"',
    VERDICT_META.SAFE.label === 'Checked — clear', VERDICT_META.SAFE.label);
}

console.log('\n2. "Not determined" never looks like "clear"');
{
  check('UNKNOWN and SAFE do not share a tone',
    VERDICT_META.UNKNOWN.tone !== VERDICT_META.SAFE.tone,
    `${VERDICT_META.UNKNOWN.tone} vs ${VERDICT_META.SAFE.tone}`);
  check('UNKNOWN is never toned success', VERDICT_META.UNKNOWN.tone !== 'success');
  check('NOT_SCANNED is never toned success', VERDICT_META.NOT_SCANNED.tone !== 'success');
  check('UNKNOWN\'s meaning says out loud that it is NOT a pass',
    /not a pass/i.test(VERDICT_META.UNKNOWN.meaning), VERDICT_META.UNKNOWN.meaning);
  check('SAFE is the ONLY verdict toned success',
    Object.entries(VERDICT_META).filter(([, m]) => m.tone === 'success')
      .map(([k]) => k).join(',') === 'SAFE');
  check('every verdict carries a plain-language meaning',
    Object.values(VERDICT_META).every((m) => typeof m.meaning === 'string' && m.meaning.length > 10));
  check('an unrecognised verdict falls back to neutral, never success',
    verdictMeta('WAT').tone === 'neutral', verdictMeta('WAT').tone);

  // Control states: "Evidence unavailable" must not read like a pass either.
  check('UNKNOWN control state is "Evidence unavailable", never a pass',
    CONTROL_STATE_META.UNKNOWN.tone !== 'success'
    && /unavailable/i.test(CONTROL_STATE_META.UNKNOWN.label),
    CONTROL_STATE_META.UNKNOWN.label);
  check('PASS is the only control state toned success',
    Object.entries(CONTROL_STATE_META).filter(([, m]) => m.tone === 'success')
      .map(([k]) => k).join(',') === 'PASS');
  check('CONTROL_STATE_ORDER lists the worst state first',
    CONTROL_STATE_ORDER[0] === 'FAIL', CONTROL_STATE_ORDER[0]);
  check('CONTROL_STATE_ORDER covers exactly the declared states',
    new Set(CONTROL_STATE_ORDER).size === Object.keys(CONTROL_STATE_META).length
    && CONTROL_STATE_ORDER.every((s) => s in CONTROL_STATE_META),
    CONTROL_STATE_ORDER.join(', '));
}

console.log('\n3. Severity ranking sorts unknowns LAST, not above CRITICAL');
{
  check('CRITICAL ranks first', severityRank('CRITICAL') === 0);
  check('INFO ranks last among known levels', severityRank('INFO') === SEVERITY_ORDER.length - 1);
  check('an UNKNOWN severity ranks after every known one — indexOf returns -1, '
    + 'and -1 would sort it ABOVE CRITICAL at the top of the findings table',
    severityRank('bogus') === SEVERITY_ORDER.length, String(severityRank('bogus')));
  check('a null severity ranks last too', severityRank(null) === SEVERITY_ORDER.length);
  check('ranking is case-insensitive', severityRank('critical') === 0);

  check('severityTone is case-insensitive',
    severityTone('critical') === severityTone('CRITICAL') && severityTone('critical') === 'danger',
    severityTone('critical'));
  check('severityAccent is case-insensitive',
    severityAccent('high') === severityAccent('HIGH'));
  check('an unknown severity falls back to a neutral tone, not a crash',
    severityTone('nope') === 'neutral');
  check('every declared severity has a tone and an accent',
    SEVERITY_ORDER.every((s) => SEVERITY_TONE[s] && SEVERITY_ACCENT[s]),
    SEVERITY_ORDER.join(', '));
}

console.log('\n4. "We cannot say" is grey, not red');
{
  check('a real grade gets its own colour', gradeColor('A') === GRADE_COLOR.A);
  check('"Insufficient data" is grey', gradeColor('Insufficient data') === '#94a3b8',
    gradeColor('Insufficient data'));
  check('"Insufficient data" is NOT painted the same red as a failing estate — '
    + 'red reads as "this estate is failing"; the point is that we cannot say',
    gradeColor('Insufficient data') !== GRADE_COLOR.F);
  check('a null grade is grey', gradeColor(null) === '#94a3b8');
  check('isRealGrade is false for "Insufficient data"', isRealGrade('Insufficient data') === false);
  check('isRealGrade is false for null/empty', isRealGrade(null) === false && isRealGrade('') === false);
  check('isRealGrade is true for each real grade',
    ['A', 'B', 'C', 'D', 'F'].every(isRealGrade));
}

console.log('\n5. Percentages, counts and ages: null is not zero');
{
  check('formatPct(null) reads "Not applicable", never "0%"',
    formatPct(null) === 'Not applicable', formatPct(null));
  check('formatPct(undefined) reads "Not applicable"', formatPct(undefined) === 'Not applicable');
  check('formatPct(0) is a real "0%"', formatPct(0) === '0%', formatPct(0));
  check('a whole percentage carries no decimal', formatPct(50) === '50%', formatPct(50));
  check('a fractional percentage carries one decimal', formatPct(33.333) === '33.3%', formatPct(33.333));
  check('the null label is overridable', formatPct(null, { nullLabel: 'No data' }) === 'No data');

  check('formatCount(null) is an em dash', formatCount(null) === '—');
  check('formatCount(0) is a real "0"', formatCount(0) === '0');
  check('formatCount groups thousands', formatCount(1234).includes(','));

  check('formatAge(null) is "never" — not "just now"',
    formatAge(null) === 'never', formatAge(null));
  check('formatAge(59) is "just now"', formatAge(59) === 'just now');
  check('formatAge(60) is "1 min ago"', formatAge(60) === '1 min ago', formatAge(60));
  check('formatAge(86400) is singular "1 day ago"', formatAge(86400) === '1 day ago', formatAge(86400));
  check('formatAge(172800) is plural "2 days ago"', formatAge(172800) === '2 days ago', formatAge(172800));

  check('formatDateTime(null) is "Never"', formatDateTime(null) === 'Never');
  check('formatDateTime("garbage") is "Unknown", never "Invalid Date"',
    formatDateTime('garbage') === 'Unknown', formatDateTime('garbage'));
}

console.log('\n6. Coverage tone changes at the threshold where a score stops being reported');
{
  check('90% and above is success', coverageTone(90) === 'success' && coverageTone(100) === 'success');
  check('70-89% is info', coverageTone(70) === 'info' && coverageTone(89.9) === 'info');
  check('exactly 40% is a warning (the boundary, inclusive)',
    coverageTone(40) === 'warning', coverageTone(40));
  check('just below 40% is danger — this is where a score stops being '
    + 'reported at all, so the tone has to change here',
    coverageTone(39.9) === 'danger', coverageTone(39.9));
  check('UNKNOWN coverage is neutral, NOT danger — unknown coverage is not '
    + 'the same as bad coverage',
    coverageTone(null) === 'neutral' && coverageTone(undefined) === 'neutral',
    coverageTone(null));
  check('0% coverage is danger (a real, measured zero)', coverageTone(0) === 'danger');
}

console.log('\n7. Suppressing a finding always records a reason');
{
  check('SUPPRESSED requires a reason', typeof STATUS_NEEDS_REASON.SUPPRESSED === 'string');
  check('ACCEPTED_RISK requires a reason', typeof STATUS_NEEDS_REASON.ACCEPTED_RISK === 'string');
  for (const [status, sentence] of Object.entries(STATUS_NEEDS_REASON)) {
    check(`"${status}" is a real finding status`,
      status in STATUS_META, 'a reason requirement on a status nothing can set');
    check(`"${status}" explains WHY a reason is needed, so it does not read as friction`,
      sentence.length > 40, sentence.slice(0, 40));
  }
  check('an unknown status falls back without throwing',
    statusMeta('WAT').label === 'WAT' && statusMeta(null).label === '—');
  check('RESOLVED is the only finding status toned success',
    Object.entries(STATUS_META).filter(([, m]) => m.tone === 'success')
      .map(([k]) => k).join(',') === 'RESOLVED');
}

console.log('\n8. Exposure and confidence vocabularies');
{
  check('EXPOSED is danger', EXPOSURE_META.EXPOSED.tone === 'danger');
  check('UNKNOWN exposure is a warning, never success or neutral-green',
    EXPOSURE_META.UNKNOWN.tone === 'warning', EXPOSURE_META.UNKNOWN.tone);
  check('"No public address" is neutral, not a success claim',
    EXPOSURE_META.NOT_APPLICABLE.tone === 'neutral');
  check('an unknown exposure value falls back safely', exposureMeta('WAT').tone === 'neutral');

  check('LOW confidence says out loud that it is an indicator',
    /indicator/i.test(CONFIDENCE_META.LOW.label), CONFIDENCE_META.LOW.label);
  check('UNKNOWN confidence is neutral, never success',
    CONFIDENCE_META.UNKNOWN.tone !== 'success');
  check('an unknown confidence falls back safely', confidenceMeta('WAT').tone === 'neutral');
}

console.log('\n9. The non-security exclusion list names real categories');
{
  for (const category of NON_SECURITY_CATEGORIES) {
    check(`"${category}" is a real category with an icon — an exclusion list `
      + `naming a category that does not exist excludes NOTHING, and the `
      + `score silently counts Cost findings as security problems`,
      category in CATEGORY_ICON, Object.keys(CATEGORY_ICON).join(', '));
  }
  check('the exclusion list is non-empty', NON_SECURITY_CATEGORIES.size >= 2);
  check('an unknown category falls back to a generic icon',
    categoryIcon('Nope') === 'circle');
}

console.log('\n10. Every icon this module names is registered in Icon.jsx');
{
  // Read the icon registry as text. These icon names never appear in JSX --
  // they are data, reached at runtime as <Icon name={meta.icon} /> -- so a
  // typo renders NOTHING: no error, no warning, just a gap where a status
  // badge should be.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const iconSource = fs.readFileSync(
    path.resolve(__dirname, '../src/components/ui/Icon.jsx'), 'utf8',
  );
  const registered = new Set(
    [...iconSource.matchAll(/^\s{2}'?([a-z0-9-]+)'?:/gm)].map((m) => m[1]),
  );
  check('the Icon registry parsed (a broken parse would make every check '
    + 'below vacuous)', registered.size > 50, `${registered.size} icons`);

  const named = new Set();
  for (const table of [VERDICT_META, STATUS_META, EXPOSURE_META, CONTROL_STATE_META]) {
    Object.values(table).forEach((m) => m.icon && named.add(m.icon));
  }
  Object.values(CATEGORY_ICON).forEach((i) => named.add(i));
  named.add(categoryIcon('Nope')); // the fallback must resolve too
  named.add(verdictMeta('WAT').icon);
  named.add(controlStateMeta('WAT').icon);

  check('this module names a non-trivial number of icons', named.size >= 15, `${named.size} icons`);
  const missing = [...named].filter((i) => !registered.has(i));
  check('EVERY icon named by securityModel resolves in Icon.jsx — an '
    + 'unregistered name renders nothing at all, silently',
    missing.length === 0, missing.join(', '));
}

console.log('\n11. Provider labels (and a documented inconsistency)');
{
  check('providerLabel is case-insensitive for the three known providers',
    providerLabel('aws') === 'AWS' && providerLabel('azure') === 'Azure'
    && providerLabel('oci') === 'OCI');
  check('a null provider is an em dash, not "undefined"', providerLabel(null) === '—');
  check('PROVIDER_LABEL covers the three canonical keys',
    ['AWS', 'AZURE', 'OCI'].every((k) => k in PROVIDER_LABEL));

  // Documented divergence, asserted so it stays visible: providerScope
  // normalises Oracle -> OCI, this table does not, so an account stored as
  // "Oracle" is labelled "Oracle" here and "OCI" elsewhere in the same UI.
  // Pinning current behaviour rather than silently "fixing" it, because the
  // right fix is to route this through providerScope.providerKeyOf and that
  // is a change with its own blast radius.
  check('providerLabel("Oracle") echoes "Oracle" — providerScope.providerKeyOf '
    + 'would give "OCI". The two disagree; asserted so the divergence is '
    + 'visible rather than latent',
    providerLabel('Oracle') === 'Oracle', providerLabel('Oracle'));
}

console.log('\n12. Coverage: what the last sweep did not read');
{
  check('the iam dimension reads IAM, not "Iam"', dimensionLabel('iam') === 'IAM');
  check('other dimensions keep their words', dimensionLabel('internet_exposure') === 'internet exposure');
  check('a missing dimension key is empty, not "undefined"', dimensionLabel(undefined) === '');

  // Nine regions of one service dropping the connection, as a live sweep did.
  const regions = ['r-1', 'r-2', 'r-3', 'r-4', 'r-5', 'r-6', 'r-7', 'r-8', 'r-9'];
  const failed = [
    ...regions.map((r) => ({ scope: `ElastiCache [${r}]`, error: 'reset', transient: true })),
    { scope: 'ElastiCache [r-10]', error: 'InternalError: boom', transient: false },
    { scope: 'DynamoDB [r-2]', error: 'reset', transient: true },
    { scope: 'weird-scope', error: 'x', transient: false },
  ];
  const groups = groupFailedScopes(failed);
  const ec = groups.find((g) => g.service === 'ElastiCache' && g.transient);
  check('nine dropped regions of one service are one entry', ec && ec.regions.length === 9,
    JSON.stringify(ec));
  check('...listing every region, in order', ec && ec.regions.join() === regions.join());
  const ecErr = groups.find((g) => g.service === 'ElastiCache' && !g.transient);
  check('an error in the same service stays a separate entry, with its text',
    ecErr && ecErr.regions.join() === 'r-10' && ecErr.error === 'InternalError: boom');
  check('another service is its own entry',
    groups.some((g) => g.service === 'DynamoDB' && g.regions.join() === 'r-2'));
  check('a scope without a [region] is kept whole, not dropped',
    groups.some((g) => g.service === 'weird-scope' && g.regions.length === 0));
  check('every failure lands in exactly one entry',
    groups.reduce((n, g) => n + Math.max(1, g.regions.length), 0) === failed.length);
  check('null and empty lists give no entries',
    groupFailedScopes(null).length === 0 && groupFailedScopes([]).length === 0);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
