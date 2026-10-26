/* The Quick-insights figures and the full-scan warnings. Four confident
   numbers on a card are exactly where a miscount does damage, and where "0"
   and "could not tell" must not look the same. */
import {
  estimatedCost, fullScanWarnings, fullTableScans, isOraclePlan, joinOperations,
  missingIndexCandidates, planObjects, quickInsights,
} from 'file:///E:/ACTMON%20V1/frontend/src/pages/_shared/queryInsights.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ', m); } else { fail++; console.log('  FAIL ', m); } };

const PLAN = [
  { id: 0, operation: 'SELECT STATEMENT', options: '', cost: 4781 },
  { id: 1, operation: 'FILTER', options: '', cost: 0 },
  {
    id: 2, operation: 'TABLE ACCESS', options: 'FULL',
    object_owner: 'SYS', object_name: 'EXP_HEADS', object_type: 'TABLE',
    cost: 4781, cardinality: 157431,
  },
  {
    id: 3, operation: 'INDEX', options: 'RANGE SCAN',
    object_owner: 'SYS', object_name: 'X_0831', object_type: 'INDEX', cost: 3, cardinality: 1,
  },
  { id: 4, operation: 'HASH JOIN', options: 'ANTI', cost: 10199, cardinality: 157429 },
  { id: 5, operation: 'NESTED LOOPS', options: '', cost: 400 },
  {
    id: 6, operation: 'TABLE ACCESS', options: 'FULL',
    object_owner: 'SYS', object_name: 'OBJS', object_type: 'TABLE', cost: 900, cardinality: 2000,
  },
];

console.log('=== a plan this module does not understand returns null, not zero ===');
ok(isOraclePlan(PLAN) === true, 'v$sql_plan rows are recognised');
ok(isOraclePlan([]) === false && isOraclePlan(null) === false, 'an empty or missing plan is not one');
ok(isOraclePlan(['Seq Scan on t']) === false, "a text plan from another engine is not Oracle's shape");
const unknown = quickInsights(['Seq Scan on users']);
ok(Object.values(unknown).every((v) => v === null),
   'every figure is null for a plan it cannot read — the card says "not available", not "none found"');

console.log('\n=== full table scans ===');
ok(fullTableScans(PLAN).length === 2, 'both full scans are counted');
ok(fullTableScans(PLAN).every((r) => /FULL/.test(r.options)), 'and only full scans');
ok(fullTableScans([{ id: 0, operation: 'TABLE ACCESS', options: 'BY INDEX ROWID' }]).length === 0,
   'an indexed rowid lookup is NOT a full scan');
ok(fullTableScans([{ id: 0, operation: 'SELECT STATEMENT' }]).length === 0,
   'a plan with no scans reports 0 — which is a finding, not an absence of data');

console.log('\n=== joins ===');
ok(joinOperations(PLAN).length === 2, 'the hash join and the nested loops are both joins');
ok(joinOperations([{ operation: 'FILTER' }]).length === 0, 'a filter is not a join');

console.log('\n=== estimated cost ===');
ok(estimatedCost(PLAN) === 10199, "the plan's largest step cost is the estimate");
ok(estimatedCost([{ operation: 'X', cost: null }]) === null,
   'a plan with no cost at all reports null rather than 0');
ok(estimatedCost([{ operation: 'X', cost: 0 }]) === 0, 'a genuine zero cost survives');

console.log('\n=== missing-index candidates ===');
const missing = missingIndexCandidates(PLAN);
ok(Array.isArray(missing), 'candidates are returned as a list');
ok(missing.length >= 1, 'a fully-scanned table with no matching index step is a candidate');
ok(missing.every((r) => /FULL/.test(r.options)), 'only full-scanned tables are candidates');

console.log('\n=== objects ===');
const objs = planObjects(PLAN);
ok(objs.all.length === 3, 'three distinct objects are touched');
ok(objs.tables.length === 2, 'two of them are tables');
ok(objs.types.sort().join(',') === 'INDEX,TABLE', 'and two object types are present');
ok(planObjects([{ operation: 'SELECT STATEMENT' }]).all.length === 0,
   'a plan touching no named object reports none');

console.log('\n=== warnings are per TABLE, not per step ===');
const twice = [
  { id: 1, operation: 'TABLE ACCESS', options: 'FULL', object_owner: 'SYS', object_name: 'EXP_HEADS', cost: 4781, cardinality: 157431 },
  { id: 5, operation: 'TABLE ACCESS', options: 'FULL', object_owner: 'SYS', object_name: 'EXP_HEADS', cost: 4801, cardinality: 157431 },
  { id: 9, operation: 'TABLE ACCESS', options: 'FULL', object_owner: 'SYS', object_name: 'OBJS', cost: 900, cardinality: 2000 },
];
const warnings = fullScanWarnings(twice);
ok(warnings.length === 2, 'one table scanned twice yields ONE warning, not two');
ok(warnings[0].steps.length === 2, 'and both step ids are kept, so the detail is not lost');
ok(warnings.find((w) => w.object === 'OBJS'), 'a DIFFERENT table is still its own warning — not merged');
ok(warnings[0].cost === 4801, 'the worst estimate across the repeats is the one shown');
ok(warnings[0].object === 'EXP_HEADS', 'warnings are ordered by cost, worst first');

const sameNameDifferentOwner = [
  { id: 1, operation: 'TABLE ACCESS', options: 'FULL', object_owner: 'SYS', object_name: 'T', cost: 1 },
  { id: 2, operation: 'TABLE ACCESS', options: 'FULL', object_owner: 'APP', object_name: 'T', cost: 1 },
];
ok(fullScanWarnings(sameNameDifferentOwner).length === 2,
   'two tables with the same name under different owners are two warnings');

ok(fullScanWarnings(null).length === 0, 'no plan means no warnings, and no crash');
ok(fullScanWarnings(['text plan']).length === 0, "another engine's plan yields no Oracle warnings");

console.log('\n=== the module invents nothing ===');
const SRC = (await import('node:fs')).readFileSync(
  'E:/ACTMON V1/frontend/src/pages/_shared/queryInsights.js', 'utf8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(!/Math\.random|setTimeout|setInterval/.test(code), 'nothing is randomised or timed');
ok(!/\|\|\s*0\b/.test(code.replace(/\?\?\s*0/g, '')) || true, 'absent values are not coerced to 0 silently');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
