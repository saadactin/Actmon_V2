import test from 'node:test';
import assert from 'node:assert/strict';
import { drillCrumbs, drillPath, parentPath } from './drillPaths.js';

const ctx = { service: 'APPLSYS.WF_CONTROL', inst: 1, sid: 1345, serial: 22111, sqlId: '8x3k2m1nq4abc' };

test('paths are ids only and encode the service name', () => {
  assert.equal(drillPath(5, { service: 'A/B$C' }), '/oracle-dashboard/5/services/A%2FB%24C');
  assert.equal(drillPath(5, { service: 'S', level: 'instances' }), '/oracle-dashboard/5/services/S/instances');
  assert.equal(drillPath(5, { service: 'S', inst: 2, level: 'sessions' }), '/oracle-dashboard/5/services/S/instances/2/sessions');
  assert.equal(drillPath(5, ctx), '/oracle-dashboard/5/services/APPLSYS.WF_CONTROL/instances/1/sessions/1345/22111/sql/8x3k2m1nq4abc');
});

test('the full trail, current page unlinked', () => {
  const c = drillCrumbs(5, ctx, { instance: 'KCDB1' });
  assert.deepEqual(c.map((x) => x.label),
    ['Oracle Dashboard', 'Services', 'APPLSYS.WF_CONTROL', 'Instances', 'KCDB1', 'Sessions', 'Session 1345', 'SQL 8x3k2m1nq4abc']);
  assert.equal(c.at(-1).to, null);
  assert.ok(c.slice(0, -1).every((x) => x.to));
});

test('back goes one level up at every depth', () => {
  assert.equal(parentPath(5, { service: 'S' }), '/oracle-dashboard/5/services');
  assert.equal(parentPath(5, { service: 'S', level: 'instances' }), '/oracle-dashboard/5/services/S');
  assert.equal(parentPath(5, { service: 'S', inst: 1 }), '/oracle-dashboard/5/services/S/instances');
  assert.equal(parentPath(5, { service: 'S', inst: 1, level: 'sessions' }), '/oracle-dashboard/5/services/S/instances/1');
  assert.equal(parentPath(5, { service: 'S', inst: 1, sid: 9, serial: 3 }), '/oracle-dashboard/5/services/S/instances/1/sessions');
  assert.equal(parentPath(5, { service: 'S', inst: 1, sid: 9, serial: 3, sqlId: 'abc' }), '/oracle-dashboard/5/services/S/instances/1/sessions/9/3');
});
