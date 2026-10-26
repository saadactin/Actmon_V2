import test from 'node:test';
import assert from 'node:assert/strict';
import { step, stageOf, sequenceFor, initialState, DWELL_MS, nodeState } from './stages.js';

const run = (seq, evs) => evs.reduce((s, e) => step(seq, s, e), initialState());

test('does not move before the scene is on screen', () => {
  const seq = sequenceFor('oracleRac');
  const s = run(seq, [{ now: 0 }, { now: 99999 }]);
  assert.equal(stageOf(seq, s), 1);
});

test('advances one stage per dwell while pending, and parks on 9', () => {
  const seq = sequenceFor('oracleRac');
  let s = initialState();
  for (let t = 0; t <= DWELL_MS * 20; t += 250) s = step(seq, s, { now: t, sceneReady: true });
  assert.equal(stageOf(seq, s), 9);
});

test('never reveals without success, however long it runs', () => {
  const seq = sequenceFor('cloud');
  let s = initialState();
  for (let t = 0; t <= 600000; t += 1000) s = step(seq, s, { now: t, sceneReady: true });
  assert.notEqual(stageOf(seq, s), 10);
});

test('success reveals immediately from any stage (no forced tour)', () => {
  const seq = sequenceFor('oracleRac');
  const s = run(seq, [{ now: 0, sceneReady: true }, { now: 100, done: true }]);
  assert.equal(stageOf(seq, s), 10);
});

test('failure freezes the tour', () => {
  const seq = sequenceFor('databases');
  let s = run(seq, [{ now: 0, sceneReady: true }, { now: 10, failed: true }]);
  s = step(seq, s, { now: DWELL_MS * 9, sceneReady: true });
  assert.equal(stageOf(seq, s), 1);
  assert.equal(s.frozen, true);
});

test('each context visits only its own stages', () => {
  assert.ok(!sequenceFor('oracleRac').includes(6));
  assert.ok(!sequenceFor('oracleRac').includes(7));
  assert.deepEqual(sequenceFor('cloud'), [1, 6, 8, 9]);
  assert.deepEqual(sequenceFor('nope'), sequenceFor('route'));
});

test('reduced motion shows one still composition', () => {
  const seq = sequenceFor('infrastructure');
  assert.equal(stageOf(seq, run(seq, [{ now: 0, reducedMotion: true }])), 9);
});

test('RAC node state is never assumed healthy', () => {
  assert.equal(nodeState({}), 'unknown');
  assert.equal(nodeState({ instance_status: 'OPEN' }), 'known');
  assert.equal(nodeState({ instance_status: 'MOUNTED' }), 'connecting');
  assert.equal(nodeState({ instance_status: 'SHUTDOWN' }), 'failed');
  assert.equal(nodeState({ error: 'x' }), 'failed');
});
