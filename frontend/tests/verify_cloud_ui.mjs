// Static analysis across the ENTIRE cloud feature, not just one tab.
//
// This generalises tests/verify_alerts_ui.mjs (which covered 14 alert files)
// to every .js/.jsx under features/cloud. The reasoning is unchanged and
// worth restating: this project has no component-test framework, and
// `npm run build` proves only that modules RESOLVE. It says nothing about
// whether an <Icon name="..."> exists, whether a Tailwind class will ever be
// generated, whether an imported symbol is actually exported, or whether a
// prop name matches what the component destructures.
//
// Every one of those fails SILENTLY at runtime — a missing icon renders
// nothing, a dynamic class renders unstyled, a bad named import renders
// `undefined` as a component. And with `hmr: { overlay: false }` in
// vite.config.js, a runtime React error shows no overlay either: the panel
// is simply blank. Source text is the only place left to catch them.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CLOUD = join(SRC, 'features/cloud');
const UI_DIR = join(SRC, 'components/ui');

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

/** Every source file under a directory, recursively. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue; // test fixtures are not product code
      walk(full, out);
    } else if (/\.(jsx?|mjs)$/.test(entry) && !entry.endsWith('.test.mjs')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Blank out comments and string-literal bodies, preserving offsets so
 * file:line stays accurate.
 *
 * Without this, every rule here reports its own documentation: refresh.api.js
 * has a docstring saying "nothing in this file calls window.location.reload()"
 * and ResourceFacetRail has a comment explaining why `text-${tone}` is wrong.
 * A scanner that flags the comment warning against a thing is worse than no
 * scanner -- it trains people to ignore it.
 */
function stripNoise(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

const FILES = walk(CLOUD);
const RAW = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]));
// Every rule below scans the comment-stripped text; only the export/import
// analysis uses the raw source, where comments cannot produce a false match.
const SOURCES = new Map([...RAW].map(([f, src]) => [f, stripNoise(src)]));
/** file:line, so a finding in 125 files is actionable rather than a hunt. */
const at = (file, src, index) => `${relative(CLOUD, file).replace(/\\/g, '/')}:${
  src.slice(0, index).split('\n').length}`;

console.log(`\n0. The file sweep found the cloud feature (${FILES.length} files)`);
check('a non-trivial number of cloud source files were found — a broken walk '
  + 'would make every check below vacuously pass',
FILES.length >= 100, `${FILES.length} files`);
check('both .jsx components and .js models are included',
  FILES.some((f) => f.endsWith('.jsx')) && FILES.some((f) => f.endsWith('.js')));

console.log('\n1. Every icon name resolves — from JSX, from model data, and from ternaries');
{
  const iconSrc = readFileSync(join(UI_DIR, 'Icon.jsx'), 'utf8');
  const registered = new Set(
    [...iconSrc.matchAll(/^\s{2}'?([a-z0-9-]+)'?:\s/gm)].map((m) => m[1]),
  );
  check('the icon registry parsed', registered.size > 50, `${registered.size} icons`);

  const found = [];
  for (const [file, src] of SOURCES) {
    // (a) <Icon ... name="x" />. Anchored on `<Icon` rather than a bare
    // /name=/ — the old pattern would also match <input name="search">.
    for (const m of src.matchAll(/<Icon\b[^>]*?\bname=["']([a-z0-9-]+)["']/g)) {
      found.push([m[1], at(file, src, m.index)]);
    }
    // (b) `icon: 'x'` literals in model files. This is where securityModel
    // and topologyModel keep theirs; they reach <Icon name={meta.icon} /> at
    // runtime and are invisible to any JSX-only scan.
    for (const m of src.matchAll(/\bicon:\s*'([a-z0-9-]+)'/g)) {
      found.push([m[1], at(file, src, m.index)]);
    }
    // (c) icon="x" as a component prop (EmptyState, Panel, Button, ...).
    for (const m of src.matchAll(/\bicon="([a-z0-9-]+)"/g)) {
      found.push([m[1], at(file, src, m.index)]);
    }
    // (d) icon={cond ? 'a' : 'b'} -- only the RESULT arms. Strings before the
    // `?` are the condition being tested, not icon names: `displayMode ===
    // 'graph' ? 'list' : 'network'` names two icons, not three.
    for (const m of src.matchAll(/\bicon=\{([^}]*)\}/g)) {
      const expr = m[1];
      const arms = expr.includes('?') ? expr.slice(expr.indexOf('?') + 1) : '';
      for (const s of arms.matchAll(/'([a-z0-9-]+)'/g)) {
        found.push([s[1], at(file, src, m.index)]);
      }
    }
  }

  check('a meaningful number of icon references were found',
    found.length >= 50, `${found.length} references`);
  const missing = [...new Set(found.filter(([n]) => !registered.has(n))
    .map(([n, where]) => `${where} -> "${n}"`))];
  check('EVERY icon name referenced anywhere in the cloud feature is registered '
    + 'in Icon.jsx — an unregistered name renders nothing at all, silently',
  missing.length === 0, missing.slice(0, 8).join(' | '));
}

console.log('\n2. No dynamically-built Tailwind class names');
{
  // Tailwind scans source TEXT, so `text-${tone}` is a class that is never
  // generated and the element renders unstyled.
  const UTILS = 'bg|text|border|from|to|via|ring|fill|stroke|shadow|divide|outline|accent|decoration|placeholder';
  const findings = [];
  for (const [file, src] of SOURCES) {
    for (const m of src.matchAll(new RegExp(`\\b(?:${UTILS})-\\$\\{`, 'g'))) {
      findings.push(`${at(file, src, m.index)} -> ${m[0]}`);
    }
    // String concatenation into a class, the other way to build one.
    for (const m of src.matchAll(new RegExp(`['"\`](?:${UTILS})-['"\`]\\s*\\+`, 'g'))) {
      findings.push(`${at(file, src, m.index)} -> ${m[0]}`);
    }
  }
  check('no source builds a Tailwind utility class by interpolation or '
    + 'concatenation (such a class is never generated, so it renders unstyled)',
  findings.length === 0, findings.slice(0, 8).join(' | '));
}

console.log('\n3. Every named import resolves to a real export');
{
  const resolve = (fromFile, spec) => {
    const base = join(fromFile, '..', spec);
    for (const candidate of [base, `${base}.js`, `${base}.jsx`,
      join(base, 'index.js'), join(base, 'index.jsx')]) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* not this one */ }
    }
    return null;
  };

  const exportsOf = (file) => {
    const src = SOURCES.get(file) ?? (() => {
      try { return readFileSync(file, 'utf8'); } catch { return null; }
    })();
    if (src === null) return null;
    const names = new Set();
    // `async` and generator forms included: `export async function x` is a
    // real export, and missing it reports a perfectly good import as broken.
    for (const m of src.matchAll(
      /export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+(\w+)/g,
    )) names.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      m[1].split(',').forEach((part) => {
        const alias = part.includes(' as ') ? part.split(' as ')[1] : part;
        const name = alias.trim();
        if (name) names.add(name);
      });
    }
    if (/export\s+default/.test(src)) names.add('default');
    // A module that re-exports everything from elsewhere cannot be checked
    // this cheaply; treat it as opaque rather than reporting false misses.
    if (/export\s+\*\s+from/.test(src)) names.add('*');
    return names;
  };

  const problems = [];
  let checked = 0;
  for (const [file, src] of SOURCES) {
    for (const m of src.matchAll(/import\s+([^;]+?)\s+from\s+'(\.[^']+)'/g)) {
      const clause = m[1];
      const target = resolve(file, m[2]);
      if (!target) {
        problems.push(`${at(file, src, m.index)} -> cannot resolve '${m[2]}'`);
        continue;
      }
      const available = exportsOf(target);
      if (!available || available.has('*')) continue;

      // Default import: `import Foo from './Foo'`
      const defaultMatch = clause.match(/^(\w+)\s*(?:,|$)/);
      if (defaultMatch && !available.has('default')) {
        problems.push(`${at(file, src, m.index)} -> '${m[2]}' has no default export `
          + `(imported as ${defaultMatch[1]}; renders as undefined)`);
      }
      // Named imports: `import { a, b as c } from './x'`
      const namedMatch = clause.match(/\{([^}]*)\}/);
      if (namedMatch) {
        for (const part of namedMatch[1].split(',')) {
          const name = part.split(' as ')[0].trim();
          if (!name) continue;
          checked += 1;
          if (!available.has(name)) {
            problems.push(`${at(file, src, m.index)} -> '${m[2]}' does not export '${name}'`);
          }
        }
      }
    }
  }
  check('a meaningful number of named imports were checked',
    checked >= 100, `${checked} named imports`);
  check('every relative import resolves, and every named import it asks for '
    + 'is actually exported (a bad named import is `undefined` at runtime, '
    + 'which React renders as nothing)',
  problems.length === 0, problems.slice(0, 8).join(' | '));
}

console.log('\n4. No page reloads, no native dialogs, no direct navigation');
{
  // Declared exceptions, with the reason. useDiscovery's two alert() calls
  // are the ONLY user-visible signal that a scan failed to start: no caller
  // of useTriggerDiscovery / useTriggerAllDiscovery renders the mutation's
  // error, so deleting the alert would silently swallow the failure, which
  // is strictly worse than a blocking dialog. Fixing it properly means
  // plumbing the Toast system down to these hooks; until then this is
  // declared debt rather than a silent pass.
  const ALLOWED_NATIVE_ALERT = new Set(['hooks/useDiscovery.js']);

  const banned = [
    // Anchored at statement position: `      alert(...)` is a call,
    // `resolved alert(s)` inside JSX text is not.
    [/^\s*window\.location\.reload\s*\(/gm, 'window.location.reload()', new Set()],
    [/^\s*document\.write\s*\(/gm, 'document.write()', new Set()],
    [/^\s*alert\s*\(/gm, 'native alert()', ALLOWED_NATIVE_ALERT],
    [/^\s*confirm\s*\(/gm, 'native confirm()', new Set()],
  ];
  for (const [pattern, why, allowed] of banned) {
    const findings = [];
    for (const [file, src] of SOURCES) {
      const rel = relative(CLOUD, file).replace(/\\/g, '/');
      if (allowed.has(rel)) continue;
      for (const m of src.matchAll(pattern)) findings.push(at(file, src, m.index));
    }
    check(`no cloud source uses ${why}`, findings.length === 0,
      findings.slice(0, 5).join(', '));
  }
  check('the native-alert exception list names only files that really still '
    + 'use it — a stale exemption hides a regression',
  [...ALLOWED_NATIVE_ALERT].every((rel) => {
    const entry = [...SOURCES].find(([f]) => relative(CLOUD, f).replace(/\\/g, '/') === rel);
    return entry && /^\s*alert\s*\(/m.test(entry[1]);
  }), [...ALLOWED_NATIVE_ALERT].join(', '));
}

console.log('\n5. Table `empty` is a node, not a config object');
{
  const findings = [];
  for (const [file, src] of SOURCES) {
    for (const m of src.matchAll(/empty=\{\{/g)) findings.push(at(file, src, m.index));
  }
  check('no Table receives an object as `empty` (Table renders it directly, so '
    + 'an object child throws "Objects are not valid as a React child" at '
    + 'runtime, never at build)', findings.length === 0, findings.join(', '));
}

console.log('\n6. Props passed to shared UI components are props those components read');
{
  // Build each ui/ component's accepted prop set from its destructured
  // signature. Components that spread ...rest accept anything, so they are
  // skipped rather than reported as false positives.
  const ALWAYS_OK = new Set(['className', 'children', 'key', 'ref', 'style', 'title', 'id']);
  const componentProps = new Map();
  const spreadsRest = new Set();

  for (const entry of readdirSync(UI_DIR)) {
    if (!entry.endsWith('.jsx')) continue;
    const name = entry.replace(/\.jsx$/, '');
    // Comment-stripped: these signatures carry per-prop JSDoc, and the
    // commas inside that prose break a naive split on ',' -- which silently
    // DROPS every prop documented that way. Pagination's `unit` is one, and
    // reporting five correct call sites as wrong is exactly the kind of
    // noise that gets a scanner switched off.
    const src = stripNoise(readFileSync(join(UI_DIR, entry), 'utf8'));
    const sig = src.match(new RegExp(`function ${name}\\(\\s*\\{([\\s\\S]*?)\\}`))
      || src.match(/function\s+\w+\(\s*\{([\s\S]*?)\}/);
    if (!sig) continue;
    const body = sig[1];
    if (/\.\.\.\w+/.test(body)) spreadsRest.add(name);
    const props = new Set(
      body.split(',').map((s) => s.split(/[:=]/)[0].trim().replace(/^\.\.\./, ''))
        .filter((s) => /^\w+$/.test(s)),
    );
    componentProps.set(name, props);
  }
  check('the ui/ component signatures parsed',
    componentProps.size >= 10, `${componentProps.size} components`);

  const problems = [];
  for (const [file, src] of SOURCES) {
    for (const [component, props] of componentProps) {
      if (spreadsRest.has(component)) continue; // accepts anything
      // Name collisions are real: AlertCharts renders recharts' <Tooltip>,
      // which has nothing to do with our ui/Tooltip. Only attribute props to
      // OUR component when this file actually imports it from components/ui.
      const importsOurs = new RegExp(
        `import\\s+(?:${component}\\b|[^;]*\\{[^}]*\\b${component}\\b[^}]*\\})[^;]*from\\s+'@?[^']*components/ui`,
      ).test(src);
      if (!importsOurs) continue;
      const tagRe = new RegExp(`<${component}\\b([^>]*?)/?>`, 'gs');
      for (const tag of src.matchAll(tagRe)) {
        // `[^>]*?` stops at the first `>`, which for a prop holding nested
        // JSX (`empty={<EmptyState icon="..." body={...} />}`) is the nested
        // element's own `>`. Everything from the first `{<` onward therefore
        // belongs to the CHILD, not to this component -- attributing it here
        // reported EmptyState's icon/body/action as bogus Table props.
        // A nested element always begins with `<`, whether written as
        // `empty={<EmptyState …/>}` or `empty={(\n  <EmptyState …/>\n)}`.
        // Cutting at the first `<` in the attribute region keeps only this
        // component's own props.
        const nested = tag[1].indexOf('<');
        const attrs = nested === -1 ? tag[1] : tag[1].slice(0, nested);
        for (const p of attrs.matchAll(/\b([a-zA-Z][\w-]*)=/g)) {
          const prop = p[1];
          if (ALWAYS_OK.has(prop) || prop.startsWith('data-') || prop.startsWith('aria-')) continue;
          if (!props.has(prop)) {
            problems.push(`${at(file, src, tag.index)} -> <${component} ${prop}=...> `
              + `(reads: ${[...props].join(',')})`);
          }
        }
      }
    }
  }
  check('every prop passed to a shared ui/ component is one that component '
    + 'actually destructures — a misnamed prop is silently undefined',
  problems.length === 0, [...new Set(problems)].slice(0, 6).join(' | '));
}

console.log('\n7. REFRESHED_ROOTS matches the query keys the hooks really use');
{
  // refreshModel.js claims "Each root below appears verbatim as queryKey[0]
  // somewhere in features/cloud/hooks". That is mechanically checkable, and
  // a guessed prefix invalidates NOTHING — silently reintroducing the F5
  // that the account-refresh feature exists to remove.
  const hooksDir = join(CLOUD, 'hooks');
  const roots = new Set();
  for (const entry of readdirSync(hooksDir)) {
    if (!entry.endsWith('.js')) continue;
    const src = readFileSync(join(hooksDir, entry), 'utf8');
    // (a) literal queryKey: ['x', ...]
    for (const m of src.matchAll(/queryKey:\s*\[\s*'([\w-]+)'/g)) roots.add(m[1]);
    // (b) const ROOT = ['securityCenter'] + key(...)
    for (const m of src.matchAll(/const\s+ROOT\s*=\s*\[\s*'([\w-]+)'/g)) roots.add(m[1]);
    // (c) const KEY = 'cloudAlerts' + [KEY, ...]
    for (const m of src.matchAll(/const\s+KEY\s*=\s*'([\w-]+)'/g)) roots.add(m[1]);
    // (d) invalidateQueries({ queryKey: ['x'] })
    for (const m of src.matchAll(/queryKey:\s*\[\s*"([\w-]+)"/g)) roots.add(m[1]);
  }
  check('query-key roots were extracted from the hooks', roots.size >= 20, `${roots.size} roots`);

  const refreshModel = readFileSync(join(CLOUD, 'utils/refreshModel.js'), 'utf8');
  const declared = [...refreshModel.matchAll(/^\s*'([\w-]+)',?/gm)].map((m) => m[1])
    .filter((n) => roots.has(n) || /^[a-z]/.test(n));
  const declaredSet = new Set(
    (refreshModel.match(/REFRESHED_ROOTS = \[([\s\S]*?)\];/) || [, ''])[1]
      .match(/'([\w-]+)'/g)?.map((s) => s.replace(/'/g, '')) || [],
  );
  check('REFRESHED_ROOTS was parsed', declaredSet.size >= 15, `${declaredSet.size} roots`);

  const phantom = [...declaredSet].filter((r) => !roots.has(r));
  check('every root REFRESHED_ROOTS declares is a real queryKey root used by a '
    + 'hook — a guessed prefix matches nothing and invalidates nothing, with '
    + 'no error anywhere to say so',
  phantom.length === 0, phantom.join(', '));

  // The inverse, with an explicit opt-out list. These are account-scoped
  // roots deliberately NOT invalidated by a refresh: a budget, a saved view
  // or a backfill job is not something a provider sweep changes. Listed by
  // name so the next hook added has to make the same decision consciously.
  const DELIBERATELY_NOT_REFRESHED = new Set([
    'costBudgets', 'costBudgetStatus', 'costAlertPolicies', 'costBackfill',
    'costMetrics', 'cloudEventSettings', 'cloudEventSavedQueries',
    'cloudEventAccess', 'cloudEventRules', 'cloudEventActors',
    'cloudEvent', 'cloudEventRaw', 'cloudEventRelated', 'cloudEventsForResource',
    'cloudEventTimeline', 'cloudAccounts', 'accountRefresh', 'discoveryStatus',
    'allResources', 'resourceMetrics', 'resources', 'resourceDetail',
    'resourceDrift', 'inventoryHistory', 'cloudEventSources',
    'cloudEventCollection', 'cloudEventStats', 'cloudEventFacets',
    // Clients: the portfolio and a client's page roll up MANY accounts, so no
    // key names one account for a refresh to match. They go stale on their
    // 30-second staleTime instead, and every client write invalidates them.
    'clients',
  ]);
  const unclassified = [...roots].filter(
    (r) => !declaredSet.has(r) && !DELIBERATELY_NOT_REFRESHED.has(r),
  );
  check('every query-key root is either refreshed or explicitly listed as '
    + 'deliberately not refreshed — an unclassified root is a decision '
    + 'nobody made',
  unclassified.length === 0,
  `unclassified: ${unclassified.join(', ')} — add to REFRESHED_ROOTS or to `
    + `DELIBERATELY_NOT_REFRESHED in this suite`);
}

console.log('\n8. Raw hex colours only where they are sanctioned');
{
  // securityModel and topologyModel document WHY their hexes are pinned:
  // grade colour is computed data, provider colours are external brand
  // identity. Everywhere else, chrome must come from design tokens.
  const ALLOWED = new Set([
    'utils/securityModel.js', 'utils/topologyModel.js', 'utils/eventFormat.js',
    'utils/topologyLayout.js', 'utils/costFormat.js',
    // Recharts renders to SVG and takes `fill`/`stroke` as concrete values,
    // not CSS custom properties, so a chart series cannot be tokenised the
    // way chrome is. The file pins them to the same values the severity
    // badges use, and says so, precisely so a CRITICAL bar and a CRITICAL
    // badge are one red rather than two that nearly match.
    'components/alerts/AlertCharts.jsx',
    // Provider BRAND colours — AWS orange, Azure blue, Oracle red, the AWS
    // navy in the logo mark. External identity, not chrome: they are the
    // same values for the same reason topologyModel's PROVIDER_META pins
    // its own, and a theme token would be the wrong home for them.
    'components/CloudProviderSelector.jsx',
    'components/ProviderLogo.jsx',
    // SVG `fill` on the canvas indicator dots. An SVG presentation attribute
    // takes a concrete colour, not a CSS custom property, so these cannot be
    // tokenised. The file already pairs each dot with a text label in the
    // resource panel, so the colour is never the only carrier of meaning.
    'components/TopologyCanvas.jsx',
    // The unknown-provider fallback swatch, mirroring PROVIDER_META's own
    // Unknown entry.
    'pages/CloudProviderAccountsPage.jsx',
  ]);
  const findings = [];
  for (const [file, src] of SOURCES) {
    const rel = relative(CLOUD, file).replace(/\\/g, '/');
    if (ALLOWED.has(rel)) continue;
    for (const m of src.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
      findings.push(`${at(file, src, m.index)} -> ${m[0]}`);
    }
  }
  check('no raw #rrggbb outside the modules that document why theirs are '
    + 'pinned — chrome colour belongs to the design tokens, or dark mode and '
    + 'the accent setting stop reaching it',
  findings.length === 0, [...new Set(findings)].slice(0, 6).join(' | '));
}

console.log('\n9. No console.log left in product code');
{
  const findings = [];
  for (const [file, src] of SOURCES) {
    for (const m of src.matchAll(/console\.log\s*\(/g)) findings.push(at(file, src, m.index));
  }
  check('no console.log in the cloud feature (console.warn/error are fine) — '
    + 'a noisy console is what makes a real runtime error easy to miss, and '
    + 'the browser console is the ONLY signal when the HMR overlay is off',
  findings.length === 0, findings.slice(0, 6).join(', '));
}

console.log('\n10. Every page is reachable, with the export shape its route expects');
{
  const pagesDir = join(CLOUD, 'pages');
  const pages = readdirSync(pagesDir).filter((f) => f.endsWith('.jsx'));
  const appSrc = readFileSync(join(SRC, 'App.jsx'), 'utf8');

  check('App.jsx was read', appSrc.length > 500, `${appSrc.length} bytes`);
  const unreferenced = pages.filter((p) => {
    const name = p.replace(/\.jsx$/, '');
    return !appSrc.includes(name) && ![...SOURCES].some(
      ([f, s]) => !f.endsWith(p) && new RegExp(`\\b${name}\\b`).test(s),
    );
  });
  check('every page under features/cloud/pages is referenced from App.jsx or '
    + 'another cloud module — an unreferenced page is dead code or a lost route',
  unreferenced.length === 0, unreferenced.join(', '));

  // A lazy route of the form `.then(m => ({ default: m.X }))` needs a NAMED
  // export X. A mismatch throws only when the route is navigated to, which
  // no build and no smoke test would catch.
  const problems = [];
  for (const m of appSrc.matchAll(/import\(['"]([^'"]+)['"]\)\.then\(\s*\(?\w+\)?\s*=>\s*\(\{\s*default:\s*\w+\.(\w+)\s*\}\)/g)) {
    const [, spec, named] = m;
    const guess = spec.replace(/^.*\//, '');
    const target = [...SOURCES.keys()].find((f) => f.endsWith(`${guess}.jsx`) || f.endsWith(`${guess}.js`));
    if (!target) continue;
    const src = SOURCES.get(target);
    if (!new RegExp(`export\\s+(?:const|function|class)\\s+${named}\\b`).test(src)
      && !new RegExp(`export\\s*\\{[^}]*\\b${named}\\b`).test(src)) {
      problems.push(`${guess} has no named export '${named}'`);
    }
  }
  check('every lazy route that destructures a NAMED export finds that export '
    + '(a mismatch throws only when the route is navigated to)',
  problems.length === 0, problems.join(' | '));
}

console.log('\n11. Two refresh names: "Refresh all" in the header, "Refresh <tab>" per tab');
{
  // There were six controls with six names — Refresh Account, Run Discovery
  // Scan, Run, Run assessment, Collect now, Retry — each re-reading a slice of
  // the same account, so nobody could tell which one made which tab current.
  // Now there are exactly two: the header's "Refresh all", and each tab's own
  // "Refresh <tab>", whose behaviour is declared in utils/tabRefreshModel.js.
  const rel = (f) => relative(CLOUD, f).replace(/\\/g, '/');
  const usersOf = (pattern, allowed) => [...SOURCES]
    .filter(([f, s]) => !allowed.includes(rel(f)) && pattern.test(s))
    .map(([f]) => rel(f));
  const rawOf = (file) => RAW.get([...RAW.keys()].find((f) => rel(f) === file)) || '';

  const starters = usersOf(/\b(useStartRefresh|startRefresh)\s*\(/,
    ['hooks/useAccountRefresh.js', 'api/refresh.api.js']);
  check('only the shared hook starts a refresh — every button goes through '
    + 'RefreshAllButton / useRefreshAll', starters.length === 0, starters.join(', '));

  const plainScans = usersOf(/\buseTriggerDiscovery\b/, ['hooks/useDiscovery.js']);
  check('no component starts a plain discovery scan by hand — the Resources tab '
    + 'refresh does it through useTabRefresh', plainScans.length === 0, plainScans.join(', '));

  // EventLogPage keeps its empty-state "Load events for the last Nh" window
  // backfill: a refresh collects forward from the checkpoint and never
  // reaches back, so that one is a different operation, not a refresh.
  const sliceRefreshers = usersOf(
    /\b(useRunAssessment|useCollectCertificates|useCollectIdentity|useCollectEvents)\b/,
    ['hooks/useSecurityCenter.js', 'hooks/useCertificates.js', 'hooks/useEvents.js',
      'pages/EventLogPage.jsx'],
  );
  check('no component re-reads a slice with its own ad-hoc button — slice '
    + 'refreshes go through TabRefreshButton', sliceRefreshers.length === 0,
  sliceRefreshers.join(', '));

  const hookFiles = ['hooks/useAccountRefresh.js', 'hooks/useDiscovery.js',
    'hooks/useSecurityCenter.js', 'hooks/useCertificates.js', 'hooks/useEvents.js'];
  const apiFiles = [...SOURCES.keys()].map(rel).filter((f) => f.startsWith('api/'));
  const sliceCalls = usersOf(
    /\b(triggerDiscovery|refreshCost|runAssessment|collectIdentity|collectCertificates|collectEvents|runAnalysis)\s*\(/,
    [...hookFiles, ...apiFiles],
  );
  check('the slice APIs are called only by hooks — a component calling one is a '
    + 'seventh refresh under a new name', sliceCalls.length === 0, sliceCalls.join(', '));

  const OLD_NAMES = ['Run Discovery Scan', 'Run assessment', 'Refresh Account',
    'Collect now', 'Re-check account', 'Scan Running'];
  const named = [];
  for (const [file, src] of SOURCES) {
    for (const name of OLD_NAMES) {
      const i = src.indexOf(name);
      if (i !== -1) named.push(`${at(file, src, i)} "${name}"`);
    }
  }
  check('none of the old names survives in code (comments are not code)',
    named.length === 0, named.slice(0, 6).join(', '));

  const bars = [...SOURCES].filter(([, s]) => /<AccountRefreshBar\b/.test(s)).map(([f]) => rel(f));
  check('the bar is rendered once, by the account header every tab shares',
    bars.length === 1 && bars[0] === 'pages/CloudDashboard.jsx', bars.join(', '));

  const tabButtons = [...SOURCES].filter(([, s]) => /<TabRefreshButton\b/.test(s))
    .map(([f]) => rel(f)).sort();
  check('tab refreshes render in exactly the two tab strips (account tabs, '
    + 'Security Center sub-tabs)',
  tabButtons.join(',') === 'pages/CloudDashboard.jsx,pages/SecurityCenterPage.jsx',
  tabButtons.join(', '));

  // Every tab a user can open must have a declared refresh — a tab missing
  // from the table silently renders no button.
  const model = rawOf('utils/tabRefreshModel.js');
  const tabIds = (file) => {
    const src = rawOf(file);
    const from = src.indexOf('const TABS = [');
    const body = from < 0 ? '' : src.slice(from, src.indexOf('];', from));
    return [...body.matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]);
  };
  const declared = (k) => model.includes(`  ${k}: {`) || model.includes(`  '${k}': {`);
  const delegated = ['security', 'compliance'];
  const mainIds = tabIds('pages/CloudDashboard.jsx');
  const subIds = tabIds('pages/SecurityCenterPage.jsx');
  const missing = [
    ...mainIds.filter((id) => !delegated.includes(id) && !declared(id)),
    ...subIds.map((id) => `security.${id}`).filter((k) => !declared(k)),
  ];
  // 9 since the Intelligence tab (Resource Intelligence) was added.
  check('the tab tables were read (9 account tabs, 9 Security Center sub-tabs)',
    mainIds.length === 9 && subIds.length === 9, `${mainIds.length} / ${subIds.length}`);
  check('every account tab and Security Center sub-tab declares its refresh in '
    + 'tabRefreshModel.js', missing.length === 0, missing.join(', '));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
