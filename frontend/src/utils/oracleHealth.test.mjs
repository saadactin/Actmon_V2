/* The health scorer must distinguish "nothing was wrong" from "nothing was
   measured". A connection that answers nothing used to score 100. */
import { computeInstanceHealthScore, bandForScore } from
  './oracleHealth.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ', m); } else { fail++; console.log('  FAIL ', m); } };

console.log('=== nothing measured is not perfect health ===');
ok(computeInstanceHealthScore({}) === null, 'an empty reading set scores null, not 100');
ok(computeInstanceHealthScore() === null, 'no argument at all scores null');
ok(computeInstanceHealthScore({
  sessionPct: null, bufHitPct: null, maxTsPct: null, waitCount: null, hostCpuPct: null,
}) === null, 'all-null inputs score null — this is the failed-connection case');
ok(bandForScore(null).label === 'Unknown', 'null bands as Unknown');
ok(bandForScore(undefined).label === 'Unknown', 'undefined bands as Unknown');

console.log('\n=== a real zero is still a reading ===');
ok(computeInstanceHealthScore({ hostCpuPct: 0 }) === 100,
   'an idle instance that genuinely reported 0% CPU is healthy, not unknown');
ok(computeInstanceHealthScore({ waitCount: 0 }) === 100, 'zero waits is a reading');

console.log('\n=== scoring is unchanged where inputs exist ===');
ok(computeInstanceHealthScore({ sessionPct: 95 }) === 75, 'session pressure still penalised');
ok(computeInstanceHealthScore({ bufHitPct: 70 }) === 75, 'low buffer cache still penalised');
ok(computeInstanceHealthScore({ maxTsPct: 99 }) === 75, 'full tablespace still penalised');
ok(computeInstanceHealthScore({ hostCpuPct: 95 }) === 85, 'high host CPU still penalised');
ok(computeInstanceHealthScore({ sessionPct: 95, maxTsPct: 99, hostCpuPct: 95 }) === 35,
   'penalties still compound');
ok(computeInstanceHealthScore({ sessionPct: 50, hostCpuPct: 10 }) === 100,
   'a healthy instance still scores 100');
ok(bandForScore(85).label === 'Healthy' && bandForScore(70).label === 'Warning'
   && bandForScore(10).label === 'Critical', 'the existing bands are unchanged');


/* ── a failed read must not arrive as a healthy zero ────────────────────── */
const { failedMetricsOf, healthInputsFromPayload } = await import(
  'file:///E:/ACTMON%20V1/frontend/src/utils/oracleHealth.js');

console.log('\n=== failedMetricsOf ===');
ok(failedMetricsOf({}).size === 0, 'an empty payload has no failed metrics');
ok(failedMetricsOf({ failed_metrics: ['osstat'] }).has('osstat'),
   'the backend list is used when present');
ok(failedMetricsOf({ errors: ['max_sessions: ORA-00942: no such view'] }).has('max_sessions'),
   'an older backend without failed_metrics still reports, via the errors list');
ok(failedMetricsOf({ errors: ['connection refused'] }).size === 0,
   'an error naming no metric is skipped, not guessed at');

console.log('\n=== a totally failed collection scores unknown, not 100 ===');
const deadPayload = {
  health_summary: { session_pct: 0, buffer_cache_hit_pct: 0, host_cpu_pct: 0 },
  tablespaces: [], wait_events: [],
  failed_metrics: ['active_sessions', 'buffer_cache_hit', 'max_sessions',
                   'osstat', 'tablespaces', 'top_waits', 'total_sessions'],
};
const dead = healthInputsFromPayload(deadPayload);
ok(Object.values(dead).every((v) => v === null),
   'every input is null when every source query failed');
ok(computeInstanceHealthScore(dead) === null,
   'the dead connection scores null — this is the "Health 100" bug');
ok(bandForScore(computeInstanceHealthScore(dead)).label === 'Unknown',
   'and bands as Unknown');

console.log('\n=== a real zero from a healthy instance still scores ===');
const idle = healthInputsFromPayload({
  health_summary: { session_pct: 2, buffer_cache_hit_pct: 99, host_cpu_pct: 0 },
  tablespaces: [{ used_pct: 40 }], wait_events: [], failed_metrics: [],
});
ok(idle.hostCpuPct === 0, 'a genuinely idle CPU stays 0, not null');
ok(idle.waitCount === 0, 'zero wait events is a reading');
ok(idle.maxTsPct === 40, 'the fullest tablespace is carried through');
ok(computeInstanceHealthScore(idle) === 100, 'an idle healthy instance still scores 100');

console.log('\n=== a partial failure keeps the metrics that did read ===');
const partial = healthInputsFromPayload({
  health_summary: { session_pct: 95, buffer_cache_hit_pct: 0, host_cpu_pct: 0 },
  tablespaces: [{ used_pct: 50 }], wait_events: [{ event: 'db file read' }],
  failed_metrics: ['buffer_cache_hit', 'osstat'],
});
ok(partial.sessionPct === 95, 'the session reading survives');
ok(partial.bufHitPct === null, 'the failed buffer-cache read is null, not 0');
ok(partial.hostCpuPct === null, 'a failed osstat read nulls host CPU');
ok(partial.waitCount === 1, 'waits still counted');
ok(computeInstanceHealthScore(partial) === 75,
   'the score reflects only what was measured — session pressure, nothing else');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
