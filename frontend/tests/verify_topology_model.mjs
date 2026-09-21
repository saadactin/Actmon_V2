// utils/topologyModel.js — the topology graph's vocabulary.
//
// The security-relevant rule in this module is the edge dash pattern. An IAM
// permission edge says "is ALLOWED to reach", not "does reach". Drawing it
// solid, identically to an observed network path, turns a statement about
// policy into a claim about traffic — a security lie drawn in a diagram
// someone will use to reason about blast radius. Permission-shaped edges are
// asserted dashed.
//
// The rule most likely to break silently is CATEGORY_ORDER vs CATEGORY_META
// drifting apart: a category in one and not the other either vanishes from
// the legend or lands in an unordered column, and topologyLayout derives its
// placement from the same set (see verify_topology_layout.mjs section 2,
// where a missing category surfaces as a NaN coordinate).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATEGORY_META, CATEGORY_ORDER, EDGE_STYLE, HEALTH_META, HEALTH_OPTIONS,
  HOP_OPTIONS, ISOLATION_LABEL, LAYOUTS, PROVIDER_META, REFERENCE_CLASS_LABEL,
  TYPE_META, VIEW_MODES,
  clip, edgeStyle, formatAge, formatCount, formatMoment, formatPct, healthMeta,
  nodeBadges, providerMeta, typeMeta,
} from '../src/features/cloud/utils/topologyModel.js';

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

console.log('\n1. CATEGORY_ORDER and CATEGORY_META are the same set, both ways');
{
  for (const category of CATEGORY_ORDER) {
    check(`CATEGORY_ORDER "${category}" has styling in CATEGORY_META`,
      category in CATEGORY_META,
      'an ordered category with no styling renders unstyled and lays out at NaN');
  }
  for (const category of Object.keys(CATEGORY_META)) {
    check(`CATEGORY_META "${category}" appears in CATEGORY_ORDER`,
      CATEGORY_ORDER.includes(category),
      'a styled category with no order lands in an unordered column');
  }
  check('no duplicate entries in CATEGORY_ORDER',
    new Set(CATEGORY_ORDER).size === CATEGORY_ORDER.length);
  check('every category has both a colour and an icon',
    Object.values(CATEGORY_META).every((m) => m.color && m.icon));
}

console.log('\n2. SECURITY: a permission edge is never drawn as observed traffic');
{
  // These edge kinds describe what is PERMITTED or MANAGED, not what was
  // observed flowing. They must be visually distinguishable from an
  // observed network path, or a diagram claims traffic that may never happen.
  const PERMISSION_SHAPED = ['permission', 'dataflow', 'managed-by'];
  for (const type of PERMISSION_SHAPED) {
    check(`"${type}" is DASHED — it says "is allowed to reach", never "does reach"`,
      typeof EDGE_STYLE[type].dash === 'string' && EDGE_STYLE[type].dash.length > 0,
      JSON.stringify(EDGE_STYLE[type]));
  }
  check('an observed containment edge is NOT dashed (so the two are '
    + 'distinguishable at a glance)', !EDGE_STYLE.contains.dash);
  check('an observed network edge is NOT dashed', !EDGE_STYLE.network.dash);

  for (const [type, style] of Object.entries(EDGE_STYLE)) {
    check(`EDGE_STYLE "${type}" has a colour and a label`,
      !!style.color && !!style.label, JSON.stringify(style));
  }
  check('an UNKNOWN edge type falls back to a visible style, never undefined — '
    + 'an unstyled edge is an invisible line',
    edgeStyle('something-new') === EDGE_STYLE.unknown
    && !!EDGE_STYLE.unknown.color, JSON.stringify(edgeStyle('something-new')));
  check('a null edge type still resolves', !!edgeStyle(null).color);
}

console.log('\n3. "It exists so it must be fine" is never inferred');
{
  check('an unknown health resolves to the Unknown entry',
    healthMeta('nope') === HEALTH_META.Unknown);
  check('a null health resolves to Unknown', healthMeta(null) === HEALTH_META.Unknown);
  check('Unknown health is NOT toned success — the backend refuses to infer '
    + 'health from existence, and the UI must not undo that',
    HEALTH_META.Unknown.tone !== 'success', HEALTH_META.Unknown.tone);
  check('Unknown health reads "Not reported", not "Healthy" or "OK"',
    HEALTH_META.Unknown.label === 'Not reported', HEALTH_META.Unknown.label);
  check('Healthy is the only health toned success',
    Object.entries(HEALTH_META).filter(([, m]) => m.tone === 'success')
      .map(([k]) => k).join(',') === 'Healthy');
  check('every health entry has a tone, colour and label',
    Object.values(HEALTH_META).every((m) => m.tone && m.color && m.label));

  check('HEALTH_OPTIONS leads with an "Any health" entry',
    HEALTH_OPTIONS[0].id === '', JSON.stringify(HEALTH_OPTIONS[0]));
  check('HEALTH_OPTIONS otherwise mirrors HEALTH_META exactly — a derived '
    + 'list drifting from its source offers a filter that matches nothing',
    HEALTH_OPTIONS.slice(1).map((o) => o.id).join(',') === Object.keys(HEALTH_META).join(','),
    HEALTH_OPTIONS.map((o) => o.id).join(','));
  check('every HEALTH_OPTIONS label matches its HEALTH_META label',
    HEALTH_OPTIONS.slice(1).every((o) => o.label === HEALTH_META[o.id].label));
}

console.log('\n4. Oracle and OCI are one provider here too');
{
  check('providerMeta("Oracle") is labelled OCI',
    providerMeta('Oracle').label === 'OCI', providerMeta('Oracle').label);
  check('Oracle and OCI share a colour', providerMeta('Oracle').color === providerMeta('OCI').color);
  check('Oracle and OCI share a badge class', providerMeta('Oracle').badge === providerMeta('OCI').badge);
  check('an unknown provider falls back to the Unknown entry, not undefined',
    providerMeta('nope') === PROVIDER_META.Unknown && providerMeta(undefined) === PROVIDER_META.Unknown);
  check('every provider entry has a colour, badge and label',
    Object.values(PROVIDER_META).every((m) => m.color && m.badge && m.label));
}

console.log('\n5. Unknown resource types degrade to a label, never a blank');
{
  check('an unregistered type keeps its own name as the label',
    typeMeta('SomethingNew').label === 'SomethingNew', typeMeta('SomethingNew').label);
  check('an unregistered type still gets a colour', !!typeMeta('SomethingNew').color);
  check('an undefined type reads "Unknown", not "undefined"',
    typeMeta(undefined).label === 'Unknown', typeMeta(undefined).label);
  check('every registered type has a colour and a label',
    Object.values(TYPE_META).every((m) => m.color && m.label));
}

console.log('\n6. Option lists match what the API and layout engine accept');
{
  // From Backend/cloud/app/api/routes/topology.py's accepted `view` values.
  const BACKEND_VIEWS = ['infrastructure', 'network', 'security', 'dataflow', 'identity'];
  for (const mode of VIEW_MODES) {
    check(`VIEW_MODES "${mode.id}" is a view the backend accepts`,
      BACKEND_VIEWS.includes(mode.id), 'a view the API would 422 on');
  }
  check('"infrastructure" is first — it is the default the wire format omits',
    VIEW_MODES[0].id === 'infrastructure', VIEW_MODES[0].id);

  // computeLayout switches on exactly these four.
  const LAYOUT_CASES = ['architecture', 'hierarchical', 'radial', 'dependency'];
  for (const layout of LAYOUTS) {
    check(`LAYOUTS "${layout.id}" is a layout computeLayout implements`,
      LAYOUT_CASES.includes(layout.id),
      'a layout offered in the toolbar that silently falls through to architecture');
  }
  check('every layout carries a hint explaining what it does',
    LAYOUTS.every((l) => typeof l.hint === 'string' && l.hint.length > 10));

  for (const list of [VIEW_MODES, LAYOUTS, HOP_OPTIONS, HEALTH_OPTIONS]) {
    const ids = list.map((o) => o.id);
    check(`option ids are unique (${ids.slice(0, 3).join('/')}...)`,
      new Set(ids).size === ids.length, ids.join(', '));
  }
  check('HOP_OPTIONS ids are numeric strings', HOP_OPTIONS.every((o) => /^\d+$/.test(o.id)));
}

console.log('\n7. Formatters: null is null, zero is zero');
{
  check('formatCount(null) is an em dash', formatCount(null) === '—');
  check('formatCount(0) is a real "0"', formatCount(0) === '0');
  check('formatCount groups thousands', formatCount(12345).includes(','));

  check('formatPct(null) reads "Not applicable", never "0%"',
    formatPct(null) === 'Not applicable', formatPct(null));
  check('formatPct(0) is a real "0%"', formatPct(0) === '0%');

  // formatMoment returns NULL, not an em dash: callers branch on falsiness,
  // so a '—' string here would read as a real value.
  check('formatMoment(null) returns null (not "—") — callers branch on it',
    formatMoment(null) === null, JSON.stringify(formatMoment(null)));
  check('formatMoment("garbage") returns null, never "Invalid Date"',
    formatMoment('garbage') === null, JSON.stringify(formatMoment('garbage')));
  check('formatMoment renders a named month, not a locale-reversible number',
    /^\d{2}-[A-Z][a-z]{2,4}-\d{4}/.test(formatMoment('2026-09-08T14:32:00Z')),
    formatMoment('2026-09-08T14:32:00Z'));

  check('formatAge(null) returns null', formatAge(null) === null);
  check('formatAge(30) is "just now"', formatAge(30) === 'just now');
  check('formatAge(3600) reads in hours', formatAge(3600) === '1h ago', formatAge(3600));
  check('formatAge past 48h reads in days', formatAge(3 * 86400) === '3d ago', formatAge(3 * 86400));
}

console.log('\n8. clip: SVG labels cannot ellipsize themselves');
{
  check('a long string is cut to EXACTLY the max, ellipsis included',
    clip('abcdef', 3) === 'ab…' && clip('abcdef', 3).length === 3, clip('abcdef', 3));
  check('a short string is untouched (no gratuitous ellipsis)',
    clip('ab', 5) === 'ab', clip('ab', 5));
  check('a string exactly at the limit is untouched', clip('abc', 3) === 'abc');
  check('null clips to an empty string, never "null"',
    clip(null, 5) === '', JSON.stringify(clip(null, 5)));
  check('undefined clips to an empty string', clip(undefined, 5) === '');
  check('a number is stringified rather than crashing', clip(12345678, 4) === '123…');
}

console.log('\n9. nodeBadges: every badge is a measurement, and none double up');
{
  check('a bare node carries no badges', nodeBadges({}).length === 0);

  const one = nodeBadges({ drift_count: 1 });
  check('one change reads singular', one[0].label === '1 change', one[0].label);
  const two = nodeBadges({ drift_count: 2 });
  check('two changes read plural', two[0].label === '2 changes', two[0].label);

  // The else-if matters: a resource with both counts must not get two drift
  // badges saying overlapping things.
  const both = nodeBadges({ drift_count: 5, significant_drift_count: 2 });
  const driftBadges = both.filter((b) => b.id === 'drift');
  check('significant drift SUPPRESSES the plain drift badge — one resource, '
    + 'one drift badge, not two describing the same changes',
    driftBadges.length === 1 && /significant/.test(driftBadges[0].label),
    driftBadges.map((b) => b.label).join(' + '));

  const events = nodeBadges({ event_count: 4, high_risk_event_count: 1 });
  const eventBadges = events.filter((b) => b.id === 'events');
  check('high-risk events likewise suppress the plain event badge',
    eventBadges.length === 1 && /high-risk/.test(eventBadges[0].label),
    eventBadges.map((b) => b.label).join(' + '));
  check('a high-risk event badge is toned danger', eventBadges[0].tone === 'danger');

  check('every badge carries a non-empty title (a chip with no hover '
    + 'explanation is a mystery, not information)',
    nodeBadges({
      exposed: true, drift_count: 1, event_count: 1,
      broad_access: ['*'], is_default: true, is_synthetic: true,
    }).every((b) => typeof b.title === 'string' && b.title.length > 10));
  check('every badge carries an id and a label',
    nodeBadges({ exposed: true, drift_count: 1 }).every((b) => b.id && b.label));
}

console.log('\n10. Exposure badges: severity drives tone, and "0 ports" is never claimed');
{
  const critical = nodeBadges({ exposed: true, exposure_severity: 'CRITICAL' })[0];
  check('CRITICAL exposure is toned danger', critical.tone === 'danger', critical.tone);
  const high = nodeBadges({ exposed: true, exposure_severity: 'HIGH' })[0];
  check('HIGH exposure is toned danger', high.tone === 'danger');
  const medium = nodeBadges({ exposed: true, exposure_severity: 'MEDIUM' })[0];
  check('MEDIUM exposure is toned warning, not danger', medium.tone === 'warning', medium.tone);
  check('the severity is named in the label', critical.label === 'Public (CRITICAL)', critical.label);

  const noPorts = nodeBadges({ exposed: true })[0];
  check('an exposed node with NO port list says "one or more", never '
    + '"reachable on 0 world-open ports" — which reads as not exposed at all',
    /one or more/.test(noPorts.title) && !/\b0\b/.test(noPorts.title), noPorts.title);
  const withPorts = nodeBadges({ exposed: true, exposure_open_ports: [22, 3389] })[0];
  check('a real port count is stated', /\b2\b/.test(withPorts.title), withPorts.title);
  check('a node that is not exposed gets no exposure badge',
    !nodeBadges({ exposed: false }).some((b) => b.id === 'exposed'));
}

console.log('\n11. Reason-key labels exist for every key the backend can send');
{
  for (const [key, label] of Object.entries(ISOLATION_LABEL)) {
    check(`ISOLATION_LABEL "${key}" has a human label, not the raw key`,
      typeof label === 'string' && label.length > 0 && !label.includes('_'), label);
  }
  for (const [key, label] of Object.entries(REFERENCE_CLASS_LABEL)) {
    check(`REFERENCE_CLASS_LABEL "${key}" has a human label`,
      typeof label === 'string' && !label.includes('_'), label);
  }
  check('both reason maps are non-empty',
    Object.keys(ISOLATION_LABEL).length >= 4 && Object.keys(REFERENCE_CLASS_LABEL).length >= 2);
}

console.log('\n12. Every icon this module names is registered in Icon.jsx');
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const iconSource = fs.readFileSync(
    path.resolve(__dirname, '../src/components/ui/Icon.jsx'), 'utf8',
  );
  const registered = new Set(
    [...iconSource.matchAll(/^\s{2}'?([a-z0-9-]+)'?:/gm)].map((m) => m[1]),
  );
  check('the Icon registry parsed', registered.size > 50, `${registered.size} icons`);

  const named = [...new Set(Object.values(CATEGORY_META).map((m) => m.icon))];
  check('CATEGORY_META names a non-trivial number of icons', named.length >= 8, `${named.length}`);
  const missing = named.filter((i) => !registered.has(i));
  check('EVERY category icon resolves in Icon.jsx — these are reached as '
    + '<Icon name={meta.icon} />, so a typo renders nothing at all',
    missing.length === 0, missing.join(', '));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
