/**
 * Report builder — vocabulary, draft migration, error surfacing.
 *
 * Run: node --import ./tests/register.mjs src/features/cloud/utils/__tests__/reportModel.test.mjs
 *
 * The option lists are checked against Backend/cloud/app/schemas/reports.py
 * PARSED FROM SOURCE: an option the backend refuses makes the preview fail
 * with a 422 and nothing on screen says which control caused it. Every other
 * check calls the production function (see test-mirrors-prove-nothing).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DETAIL_LEVELS, GROUP_BY_OPTIONS, PERIOD_PRESETS, PREVIEW_COLUMNS, ROW_SECTIONS,
  SECTION_LABELS, SORT_BY_OPTIONS, WEEKDAYS, cellText, changeText, configFromDraft,
  coverageSentence, customPeriodProblem, daysLeft, describeSchedule, draftFromConfig, errorMessage,
  normalizeDraft, postureText, saveProblem,
} from '../reportModel.js';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass += 1; else fail += 1;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '../../../../../../Backend/cloud/app');
const schema = fs.readFileSync(path.join(APP, 'schemas/reports.py'), 'utf8');
const service = fs.readFileSync(path.join(APP, 'services/report_service.py'), 'utf8');
const tuple = (name) => {
  const m = schema.match(new RegExp(`^${name} = \\(([^)]*)\\)`, 'm'));
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null;
};
const sortSet = (xs) => [...xs].sort();

console.log('\n1. Every option is one the backend accepts, and every backend option is offered');
{
  const dayPresets = [...schema.match(/^PERIOD_DAY_PRESETS = \{([^}]*)\}/m)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const named = ['PERIOD_MTD', 'PERIOD_LAST_MONTH', 'PERIOD_CUSTOM']
    .map((c) => schema.match(new RegExp(`^${c} = "([^"]+)"`, 'm'))[1]);
  eq('period presets match DATE_PRESETS', sortSet(PERIOD_PRESETS.map((p) => p.id)), sortSet([...dayPresets, ...named]));
  check('...and no sub-day preset is offered', !PERIOD_PRESETS.some((p) => /^\d+h$/.test(p.id)));

  const detailIds = ['DETAIL_EXECUTIVE', 'DETAIL_STANDARD', 'DETAIL_DETAILED']
    .map((c) => schema.match(new RegExp(`^${c} = "([^"]+)"`, 'm'))[1]);
  eq('detail levels match DETAIL_LEVELS', DETAIL_LEVELS.map((d) => d.id), detailIds);
  eq('group-by options match GROUP_BY_OPTIONS (plus "none")',
    sortSet(GROUP_BY_OPTIONS.map((g) => g.id).filter(Boolean)), sortSet(tuple('GROUP_BY_OPTIONS')));
  eq('sort-by options match SORT_BY_OPTIONS (plus "default")',
    sortSet(SORT_BY_OPTIONS.map((g) => g.id).filter(Boolean)), sortSet(tuple('SORT_BY_OPTIONS')));

  const backendRows = service.match(/^ROW_SECTIONS = \(([^)]*)\)/m)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  eq('row sections match report_service.ROW_SECTIONS, in order', ROW_SECTIONS, backendRows);
  check('every row section has a label and preview columns',
    ROW_SECTIONS.every((s) => SECTION_LABELS[s] && PREVIEW_COLUMNS[s]));
}

console.log('\n2. A draft saved by an older form still loads');
{
  const old = {
    scope: { mode: 'account' },
    date_range: { preset: '6h', start: '2026-10-01T09:30', end: '2026-10-05T18:00', timezone: 'UTC' },
    layout: { format: 'pdf', detail_level: 'technical', group_by: 'owner', sort_by: null },
  };
  const n = normalizeDraft(old, { timeZone: 'Asia/Kolkata' });
  eq('an hourly preset becomes the default 30 days', n.date_range.preset, '30d');
  eq('datetime-local values keep their date', [n.date_range.start, n.date_range.end], ['2026-10-01', '2026-10-05']);
  eq('a default UTC zone becomes the viewer\'s', n.date_range.timezone, 'Asia/Kolkata');
  eq('"technical" becomes "detailed"', n.layout.detail_level, 'detailed');
  eq('an unknown group-by is dropped, not sent', n.layout.group_by, null);
  eq('everything else is left alone', [n.layout.format, n.scope.mode], ['pdf', 'account']);
  eq('a zone the viewer chose is kept',
    normalizeDraft({ ...old, date_range: { preset: '7d', timezone: 'Europe/London' } }, { timeZone: 'Asia/Kolkata' })
      .date_range.timezone, 'Europe/London');
}

console.log('\n3. A custom period is checked before it is sent');
{
  eq('a non-custom preset needs nothing', customPeriodProblem({ preset: '7d' }), null);
  check('missing dates are named', /both/.test(customPeriodProblem({ preset: 'custom', start: '2026-10-01' })));
  check('start after end is named', /after/.test(customPeriodProblem({ preset: 'custom', start: '2026-10-05', end: '2026-10-01' })));
  check('over 366 days is named', /366/.test(customPeriodProblem({ preset: 'custom', start: '2025-01-01', end: '2026-10-01' })));
  eq('a valid range passes', customPeriodProblem({ preset: 'custom', start: '2026-09-01', end: '2026-09-30' }), null);
}

console.log('\n4. The server\'s message survives a Blob response');
{
  const blob = new Blob([JSON.stringify({ detail: '1200 resources were requested; a report is capped at 1000 per request.' })],
    { type: 'application/json' });
  eq('a download\'s JSON error is read out of the Blob',
    await errorMessage({ response: { data: blob }, message: 'Request failed with status code 400' }),
    '1200 resources were requested; a report is capped at 1000 per request.');
  eq('a validation error lists its messages',
    await errorMessage({ response: { data: { detail: [{ msg: 'Value error, bad zone' }] } } }), 'Value error, bad zone');
  eq('a structured error uses its message',
    await errorMessage({ response: { data: { detail: { error: { message: 'Scope not found' } } } } }), 'Scope not found');
  eq('no body falls back to the transport message', await errorMessage({ message: 'Network Error' }), 'Network Error');
}

console.log('\n5. NA is not zero');
{
  const cost = PREVIEW_COLUMNS.cost.find((c) => c.key === 'cost_amount');
  eq('a missing billed cost reads "Not available"', cellText({ cost_amount: null, currency: 'INR' }, cost), 'Not available');
  check('a real amount keeps its currency', cellText({ cost_amount: 1309674.22, currency: 'INR' }, cost).startsWith('₹'),
    cellText({ cost_amount: 1309674.22, currency: 'INR' }, cost));
  eq('a zero amount is shown as zero, not as missing',
    cellText({ cost_amount: 0, currency: 'USD' }, cost), '$0.00');
}

console.log('\n6. Coverage sentences');
{
  eq('a section that could not be read says so',
    coverageSentence('security', { status: 'unavailable', error: 'timeout' }), 'Could not be read: timeout');
  eq('cost coverage says unknown, not zero',
    coverageSentence('cost', { status: 'ok', resources_checked: 477, resources_without_data: 263 }),
    '263 of 477 resource(s) have no billed cost reported (unknown, not zero).');
  check('account-level findings left out of a scoped report are mentioned',
    /left out/.test(coverageSentence('security', {
      status: 'ok', resources_checked: 3, resources_without_data: 0,
      account_level_findings: 2, account_level_included: false,
    })));
  eq('nothing to say is null', coverageSentence('performance', { status: 'ok', resources_checked: 3, resources_without_data: 0 }), null);
}

console.log('\n7. Every backend section has a switch and a default');
{
  const body = schema.match(/class ReportSections\(BaseModel\):([\s\S]*?)\n\nclass /)[1];
  const fields = [...body.matchAll(/^\s{4}(\w+): bool = /gm)].map((m) => m[1]);
  const FRONT = path.resolve(__dirname, '../..');
  const selector = fs.readFileSync(path.join(FRONT, 'components/reports/ReportSectionSelector.jsx'), 'utf8');
  const switches = [...selector.matchAll(/key: '(\w+)'/g)].map((m) => m[1]);
  const page = fs.readFileSync(path.join(FRONT, 'pages/reports/ReportBuilderPage.jsx'), 'utf8');
  const draftBody = page.match(/sections: \{([\s\S]*?)\}/)[1];
  const defaults = [...draftBody.matchAll(/(\w+): (?:true|false)/g)].map((m) => m[1]);
  check('the schema had sections to read', fields.length >= 14, String(fields.length));
  eq('every schema section has a switch, and nothing else does', sortSet(switches), sortSet(fields));
  eq('every schema section has a draft default', sortSet(defaults), sortSet(fields));
  check('every section has a label', fields.every((f) => SECTION_LABELS[f]), fields.filter((f) => !SECTION_LABELS[f]).join(','));
}

console.log('\n8. Expiry, spend change, posture wording');
{
  eq('an expired item reads "days ago"', daysLeft(-907.2), '907 days ago');
  eq('a valid item reads its days left', daysLeft(12.4), '12');
  eq('unknown expiry is NA, not 0', daysLeft(null), 'NA');
  check('a real change shows sign and both amounts',
    changeText({ percent: 5.64, previous: 100, current: 105.64 }, 'INR').startsWith('+5.6% (₹100.00'),
    changeText({ percent: 5.64, previous: 100, current: 105.64 }, 'INR'));
  eq('a not-comparable change gives its reason, never a percent',
    changeText({ percent: null, label: 'NA', reason: 'Not like for like' }, 'INR'), 'NA — Not like for like');
  eq('a withheld score never shows its number',
    postureText({ status: 'ok', reliable: false, score: 62, grade: 'C' }), 'Withheld (grade C)');
  eq('a reliable score shows score and grade', postureText({ status: 'ok', reliable: true, score: 15, grade: 'F' }), '15/100 · grade F');
  eq('certificate coverage names unreadable stores',
    coverageSentence('certificates', { status: 'ok', resources_checked: 40, resources_without_data: 36 }),
    '36 of 40 credential store(s) could not be read — anything in them is missing.');
  eq('changes coverage lists the kinds', coverageSentence('changes', { status: 'ok', by_change_type: { MODIFIED: 64, CREATED: 2 } }),
    '2 created, 64 modified');
}

console.log('\n9. Templates and schedules');
{
  const defaults = {
    scope: { mode: 'account', resource_ids: [], filters: {} },
    sections: { executive_summary: true, security: true, cost: false },
    date_range: { preset: '30d', start: null, end: null, timezone: 'UTC' },
    layout: { format: 'csv', detail_level: 'standard', group_by: null, sort_by: null, metadata: { title: '' } },
  };
  const picked = { ...defaults, scope: { mode: 'resources', resource_ids: ['r1'], filters: {} } };
  check('hand-picked resources cannot be saved, and the reason is given', /Hand-picked/.test(saveProblem(picked) || ''));
  const cfg = configFromDraft({ ...defaults, scope: { mode: 'filtered', resource_ids: ['r1'], filters: { region: ['a'] } } });
  check('a saved config never carries resource ids', !('resource_ids' in cfg.scope), JSON.stringify(cfg.scope));
  eq('...but keeps its filters', cfg.scope.filters, { region: ['a'] });
  const applied = draftFromConfig({ sections: { cost: true }, layout: { format: 'pdf' }, date_range: { preset: 'last_month' } },
    defaults, { timeZone: 'Asia/Kolkata' });
  eq('a template turns sections on over the defaults', [applied.sections.cost, applied.sections.security], [true, true]);
  eq('...sets its layout and period', [applied.layout.format, applied.date_range.preset], ['pdf', 'last_month']);
  eq('...and a template without a zone uses the viewer\'s', applied.date_range.timezone, 'Asia/Kolkata');
  eq('...and never brings hand-picked resources', applied.scope.resource_ids, []);
  eq('a weekly schedule reads as a sentence',
    describeSchedule({ frequency: 'weekly', day_of_week: 0, send_time: '09:00', timezone: 'Asia/Kolkata' }),
    'Every Monday at 09:00 (Asia/Kolkata)');
  eq('a monthly one too',
    describeSchedule({ frequency: 'monthly', day_of_month: 3, send_time: '07:30', timezone: 'UTC' }),
    'On day 3 of every month at 07:30 (UTC)');
  const svc = fs.readFileSync(path.join(APP, 'services/account_report_service.py'), 'utf8');
  const backendWeekly = svc.includes('day.weekday() != day_of_week');
  check('WEEKDAYS starts on Monday, as Python weekday() does (0 = Monday)', WEEKDAYS[0] === 'Monday' && backendWeekly);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
