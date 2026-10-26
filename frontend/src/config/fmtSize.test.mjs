/* Sizes read in the unit a person expects. "32.9K MB" and "13590.572 GB" were
   both on screen before this; neither is a unit anyone reads. The helpers are
   re-declared from the source text so this runs without a JSX loader. */
import { readFileSync } from 'node:fs';
const SRC = readFileSync('E:/ACTMON V1/frontend/src/config/dbCatalog.jsx', 'utf8');
const body = (name) => {
  const i = SRC.indexOf(`export function ${name}(`);
  let d = 0, j = SRC.indexOf('{', i);
  for (let k = j; k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}' && --d === 0) return SRC.slice(i, k + 1).replace('export ', ''); }
};
// eslint-disable-next-line no-new-func
const { fmtMB, fmtGB } = new Function(`${body('fmtMB')}\n${body('fmtGB')}\nreturn { fmtMB, fmtGB };`)();

let pass = 0, fail = 0;
const eq = (a, b, m) => { if (a === b) { pass++; console.log('  PASS ', m, '→', a); } else { fail++; console.log('  FAIL ', m, '→', a, '(want', b + ')'); } };

console.log('=== the values from the screenshots ===');
eq(fmtMB(32900), '32.1 GB', 'SGA 32.9K MB');
eq(fmtMB(2900), '2.83 GB', 'PGA 2.9K MB');
eq(fmtMB(3700), '3.61 GB', 'PGA target 3.7K MB');
eq(fmtMB(11400), '11.1 GB', 'SGA total 11.4K MB');
eq(fmtMB(1500), '1.46 GB', 'PGA allocated 1.5K MB');
eq(fmtMB(20000), '19.5 GB', 'chart axis 20.0K MB');
eq(fmtGB(13590.572), '13.3 TB', 'database size 13590.572 GB');

console.log('\n=== small values stay small ===');
eq(fmtMB(512), '512 MB', 'under a gigabyte stays in MB');
eq(fmtMB(1023), '1,023 MB', 'just under the boundary');
eq(fmtMB(1024), '1 GB', 'exactly one gigabyte');
eq(fmtMB(0), '0 MB', 'a genuine zero is a size');

console.log('\n=== big values keep scaling ===');
eq(fmtGB(2048 * 1024), '2 PB', 'petabytes');
eq(fmtMB(5 * 1024 * 1024), '5 TB', 'terabytes from MB');

console.log('\n=== absent is not zero ===');
eq(fmtMB(null), '—', 'null is "not reported", not 0 MB');
eq(fmtMB(undefined), '—', 'undefined likewise');
eq(fmtMB('abc'), '—', 'garbage is not a size');
eq(fmtGB(null), '—', 'fmtGB null');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
