// node src/pages/cpu/cpuAnalysis.test.mjs  — plain assertions, no framework.
import assert from 'node:assert/strict';
import { findSpikes, freshness, parseTs, splitWindows, stats, toSeries } from './cpuAnalysis.js';

const m = 60_000;
assert.equal(parseTs('2026-10-22 06:30:00').toISOString(), '2026-10-22T06:30:00.000Z', 'ClickHouse ts is UTC');
assert.equal(parseTs('2026-10-22T06:30:00+05:30').toISOString(), '2026-10-22T01:00:00.000Z');

const series = toSeries([
  { ts: '2026-10-22 06:02:00', host_cpu: 50 },
  { ts: '2026-10-22 06:00:00', host_cpu: 10 },
  { ts: '2026-10-22 06:01:00', host_cpu: null },      // missing: skipped, not 0
  { ts: 'bad', host_cpu: 99 },                          // unparseable: skipped
  { ts: '2026-10-22 06:03:00', host_cpu: '30' },
]);
assert.deepEqual(series.map((p) => p.v), [10, 50, 30], 'oldest-first, missing skipped');
const s = stats(series);
assert.equal(s.avg, 30); assert.equal(s.peak.v, 50); assert.equal(s.min.v, 10); assert.equal(s.count, 3);
assert.equal(stats([]), null);

const now = Date.UTC(2026, 9, 22, 7, 0);
const w = splitWindows([{ t: now - 90 * m, v: 1 }, { t: now - 30 * m, v: 2 }], 60, now);
assert.equal(w.previous.length, 1); assert.equal(w.current.length, 1);

const pts = [20, 80, 90, 85, 30, 30, 76, 20].map((v, i) => ({ t: i * m, v }));
const sp = findSpikes(pts, { threshold: 75 });
assert.equal(sp.length, 2);
assert.equal(sp[0].peak.v, 90); assert.equal(sp[0].samples, 3); assert.equal(sp[0].durationMs, 2 * m);
assert.equal(sp[0].beforeAvg, 20); assert.equal(sp[0].afterAvg, 39); // 5-min window after: 30,30,76,20
// a long gap splits a run instead of bridging it
const gap = findSpikes([{ t: 0, v: 90 }, { t: 60 * m, v: 90 }], { maxGapMs: 10 * m });
assert.equal(gap.length, 2);

assert.equal(freshness(now - 30_000, { collector: 'agent', now }).state, 'fresh');
assert.equal(freshness(now - 5 * m, { collector: 'agent', now }).state, 'stale');
assert.equal(freshness(now - 5 * m, { collector: 'ssh', now }).state, 'fresh');
assert.equal(freshness(null).state, 'none');
console.log('cpuAnalysis: all assertions passed');
