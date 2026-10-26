/* The progress controller. A loading bar is a claim about work, and these are
   the rules that stop it becoming a claim about nothing: no percentage without
   registered work, never above 100, and 100 only when the work is actually
   finished. */
import {
  readProgress, currentLabel, TASK,
} from 'file:///E:/ACTMON%20V1/frontend/src/components/loader/loadProgressStore.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ', m); } else { fail++; console.log('  FAIL ', m); } };

const snap = (tasks) => ({
  tasks: Object.fromEntries(tasks.map((t) => [t.id, { weight: 1, label: t.id, ...t }])),
  order: tasks.map((t) => t.id),
});

console.log('=== a registered task keeps what the UI needs to draw it ===');
{
  const { useLoadProgress } = await import(
    'file:///E:/ACTMON%20V1/frontend/src/components/loader/loadProgressStore.js');
  useLoadProgress.getState().begin([
    { id: 'a', label: 'Authenticating', panel: 'Authentication', slot: 'slot-3', kind: 'security', weight: 3 },
  ]);
  const t = useLoadProgress.getState().tasks.a;
  // Dropping these left the loader with a correct percentage and no panels:
  // the panel and its 3D platform are both positioned from `slot`.
  ok(t.slot === 'slot-3', 'the slot survives registration');
  ok(t.kind === 'security', 'and the kind, which picks the icon and the 3D emblem');
  ok(t.panel === 'Authentication' && t.weight === 3, 'along with the panel name and weight');
  useLoadProgress.getState().reset();
}

console.log('\n=== no registered work means no percentage ===');
const none = readProgress(snap([]));
ok(none.determinate === false, 'an empty store is not determinate');
ok(none.percent === null, 'and reports no percentage at all, rather than 0');
ok(readProgress(null).determinate === false, 'a missing snapshot is handled the same way');
ok(readProgress(undefined).percent === null, 'undefined too');

console.log('\n=== progress is a ratio of real work ===');
const half = readProgress(snap([
  { id: 'a', status: TASK.done }, { id: 'b', status: TASK.pending },
]));
ok(half.determinate === true, 'registered work gives a denominator');
ok(half.percent === 50, 'one of two tasks is 50%');
ok(half.finished === false, 'and is not finished');

const weighted = readProgress(snap([
  { id: 'a', weight: 3, status: TASK.done }, { id: 'b', weight: 1, status: TASK.pending },
]));
ok(weighted.percent === 75, 'weights count: a 3-of-4 task done is 75%');

console.log('\n=== 100 only when the work actually finished ===');
const nearly = readProgress(snap([
  { id: 'a', status: TASK.done }, { id: 'b', status: TASK.active },
]));
ok(nearly.percent === 50, 'a task that is RUNNING contributes nothing — it is not half done');
ok(nearly.finished === false, 'and the operation is not finished');
const all = readProgress(snap([{ id: 'a', status: TASK.done }, { id: 'b', status: TASK.done }]));
ok(all.percent === 100 && all.finished === true, 'every task done is 100 and finished');

console.log('\n=== the bar can never exceed 100 ===');
const dup = readProgress(snap([
  { id: 'a', weight: 5, status: TASK.done }, { id: 'b', weight: 1, status: TASK.done },
]));
ok(dup.percent === 100, 'all-done is exactly 100, never more');
let max = 0;
for (let done = 0; done <= 7; done++) {
  const p = readProgress(snap(Array.from({ length: 7 }, (_, i) => ({
    id: `t${i}`, weight: i + 1, status: i < done ? TASK.done : TASK.pending,
  })))).percent;
  ok(p >= 0 && p <= 100, `with ${done}/7 done the percentage stays in range (${p}%)`);
  ok(p >= max, 'and never goes backwards');
  max = p;
}

console.log('\n=== failure ends the operation, it does not stall it ===');
const failed = readProgress(snap([
  { id: 'a', status: TASK.done }, { id: 'b', status: TASK.failed, error: 'boom' },
]));
ok(failed.finished === true, 'a failed task is settled — the bar does not hang below 100 forever');
ok(failed.failed.length === 1, 'the failure is reported');
ok(failed.failedAll === false, 'a partial failure is not a total one');
ok(failed.operationFailed === true,
   'but a blocking sequence with ANY failed step HAS failed — otherwise a full bar '
   + 'sits over a session that was never established');
ok(readProgress(snap([{ id: 'a', status: TASK.done }])).operationFailed === false,
   'and a clean run has not failed');
const dead = readProgress(snap([{ id: 'a', status: TASK.failed }]));
ok(dead.failedAll === true, 'everything failing is reported as such, so the UI can show the error');

console.log('\n=== the status line follows the real work ===');
const s = snap([
  { id: 'a', label: 'Authenticating', status: TASK.done },
  { id: 'b', label: 'Loading permissions', status: TASK.active },
  { id: 'c', label: 'Preparing dashboard', status: TASK.pending },
]);
ok(currentLabel(s) === 'Loading permissions', 'the running task names the line');
const between = snap([
  { id: 'a', label: 'Authenticating', status: TASK.done },
  { id: 'b', label: 'Loading permissions', status: TASK.pending },
]);
ok(currentLabel(between) === 'Loading permissions',
   'between tasks the line names what is next, rather than going blank');
ok(currentLabel(snap([]), 'Initializing ACTMON…') === 'Initializing ACTMON…',
   'with no tasks the caller\'s own wording is used');

console.log('\n=== the source contains no timer-driven progress ===');
const SRC = (await import('node:fs')).readFileSync(
  'E:/ACTMON V1/frontend/src/components/loader/loadProgressStore.js', 'utf8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(!/setInterval|setTimeout/.test(code),
   'no timer: progress advances because work finished, not because time passed');
ok(!/Math\.random/.test(code), 'and nothing is randomised');
ok(/Math\.min\(100/.test(code), 'the clamp is present in the source, not just in these tests');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
