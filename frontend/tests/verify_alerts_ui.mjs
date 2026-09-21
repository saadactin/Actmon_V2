// Static checks on the Alerts UI source.
//
// This project has no component-test framework, and `npm run build` proves only
// that the modules resolve — it says nothing about whether an <Icon name="..."/>
// exists, whether a Tailwind class will ever be generated, or whether a prop
// name matches what the component actually destructures. Every one of those
// fails silently at runtime: a missing icon renders nothing, a dynamic class
// renders unstyled, a misnamed prop renders undefined.
//
// So this reads the source and checks the things a build cannot.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ALERTS = join(SRC, 'features/cloud/components/alerts');
const PAGES = join(SRC, 'features/cloud/pages');

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

const files = [
  ...readdirSync(ALERTS).filter((f) => f.endsWith('.jsx')).map((f) => join(ALERTS, f)),
  join(PAGES, 'AlertsPage.jsx'),
];
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const short = (f) => f.split(/[\\/]/).pop();

console.log(`\n1. Every <Icon name="..."> exists in the registry (${files.length} files)`);
const iconSrc = readFileSync(join(SRC, 'components/ui/Icon.jsx'), 'utf8');
// The registry is `name: Component` pairs inside the ICONS map.
const registered = new Set(
  [...iconSrc.matchAll(/^\s{2}'?([a-z0-9-]+)'?:\s/gm)].map((m) => m[1]),
);
check('the icon registry was parsed', registered.size > 50, `${registered.size} icons`);

const missing = [];
for (const [file, src] of sources) {
  for (const m of src.matchAll(/name=["']([a-z0-9-]+)["']/g)) {
    if (!registered.has(m[1])) missing.push(`${short(file)}:${m[1]}`);
  }
}
check('no alert component uses an unregistered icon', missing.length === 0,
  [...new Set(missing)].join(', '));

console.log('\n2. No dynamically-built Tailwind class names');
// Tailwind scans source text, so `text-${tone}` is never generated and the
// element renders unstyled. This has bitten this codebase before.
const dynamic = [];
for (const [file, src] of sources) {
  // A template literal inside a className that interpolates into a utility.
  for (const m of src.matchAll(/className=\{`[^`]*\b(bg|text|border|from|to)-\$\{/g)) {
    dynamic.push(`${short(file)}: ${m[0].slice(0, 50)}`);
  }
}
check('no className interpolates a Tailwind colour utility', dynamic.length === 0,
  dynamic.join(' | '));

console.log('\n3. Component props match what the components destructure');
const uiDir = join(SRC, 'components/ui');
const propsOf = (name) => {
  const src = readFileSync(join(uiDir, `${name}.jsx`), 'utf8');
  const m = src.match(new RegExp(`function ${name}\\(\\s*\\{([^}]*)\\}`, 's'))
    || src.match(/function\s+\w+\(\s*\{([^}]*)\}/s);
  return m ? new Set(m[1].split(',').map((s) => s.split(/[:=]/)[0].trim()).filter(Boolean)) : null;
};

// The three that have bitten before: Tabs takes `value` not `active`,
// ConfirmDialog takes `onCancel` not `onClose`, CopyButton takes `text`.
const tabsProps = propsOf('Tabs');
check('Tabs is passed `value`, the prop it actually reads',
  tabsProps?.has('value'), [...(tabsProps || [])].join(','));
const usesActive = [...sources].some(([, s]) => /<Tabs[^>]*\sactive=/.test(s));
check('no caller passes Tabs an `active` prop', !usesActive);

const confirmProps = propsOf('ConfirmDialog');
check('ConfirmDialog reads `onCancel`', confirmProps?.has('onCancel'));
const confirmMisuse = [...sources]
  .filter(([, s]) => /<ConfirmDialog[\s\S]{0,400}?onClose=/.test(s))
  .map(([f]) => short(f));
check('no caller passes ConfirmDialog an `onClose` prop',
  confirmMisuse.length === 0, confirmMisuse.join(', '));

console.log('\n4. Table `empty` is a node, not a config object');
// Table renders `{empty}` directly — an object child throws
// "Objects are not valid as a React child" at runtime, not at build.
const badEmpty = [...sources]
  .filter(([, s]) => /empty=\{\{/.test(s))
  .map(([f]) => short(f));
check('no Table receives an object as `empty`', badEmpty.length === 0,
  badEmpty.join(', '));

console.log('\n5. Severity and status are never conveyed by colour alone');
for (const [file, src] of sources) {
  if (!/SeverityBadge|ResultBadge|StateBadge/.test(src)) continue;
  // Those badges render meta.label alongside the tone, which is the
  // accessibility guarantee. Assert nobody replaced them with a bare dot.
  check(`${short(file)} uses a labelled badge rather than a colour swatch`,
    !/className="[^"]*rounded-full[^"]*bg-(danger|warning|success)\b[^"]*"\s*\/>/.test(src));
}

console.log('\n6. Every mutation the page calls exists in the hooks module');
const pageSrc = sources.get(join(PAGES, 'AlertsPage.jsx'));
const hooksSrc = readFileSync(join(SRC, 'features/cloud/hooks/useAlerts.js'), 'utf8');
const exported = new Set(
  [...hooksSrc.matchAll(/export const (use\w+)/g)].map((m) => m[1]),
);
const imported = (pageSrc.match(/from '\.\.\/hooks\/useAlerts'/)
  ? pageSrc.split("from '../hooks/useAlerts'")[0].split('import {').pop()
  : '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('use'));
const notExported = imported.filter((h) => !exported.has(h));
check('every hook the page imports is exported', notExported.length === 0,
  notExported.join(', '));
check('the page imports a meaningful number of hooks', imported.length > 15,
  `${imported.length}`);

console.log('\n7. API layer and hooks agree');
const apiSrc = readFileSync(join(SRC, 'features/cloud/api/alerts.api.js'), 'utf8');
const apiExports = new Set(
  [...apiSrc.matchAll(/export const (\w+)/g)].map((m) => m[1]),
);
// The destructured list ends at the closing brace, which would otherwise come
// through as a bare "}" entry and fail against every real export name.
const hookImports = (hooksSrc.split("from '../api/alerts.api'")[0]
  .split('import {').pop() || '')
  .replace(/\}\s*$/, '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const missingApi = hookImports.filter((n) => !apiExports.has(n));
check('every function the hooks import is exported by the API layer',
  missingApi.length === 0, missingApi.join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
