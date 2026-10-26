/* MongoDB Atlas: /databases card → connect form (test-before-save) → dashboard, every tab.
   API answered from fixtures; nothing touches Atlas.
     cd frontend && npx vite --port 2106
     node src/pages/mongoatlas/__atlascheck__/atlas.mjs <outDir> */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.APP_URL || 'http://localhost:2106';
const OUT = process.argv[2] || 'atlasshots';
const PORT = 9511;
mkdirSync(OUT, { recursive: true });
const now = Date.now();
const iso = (m) => new Date(now - m * 60000).toISOString();
const PID = '5f1e2d3c4b5a69788796a5b4';
let saved = null; const posts = []; let withApi = true; let dpAtlas = true;
const CONN = () => ({ id: 31, connection_name: 'Prod Atlas', environment: 'Production', auth_method: 'uri', host: 'cluster0.ab1cd.mongodb.net', has_uri: true, username: null, has_password: false,
  database_name: 'shop', project_label: 'Payments', project_id: withApi ? PID : null, api_public_key: withApi ? 'abcd…' : null, has_api_key: withApi, monitoring_scope: [], status: 'connected', last_checked: iso(1), last_error: null });
const sampled = Array.from({ length: 12 }, (_, i) => ({ ts: iso(12 - i), reads: 100 + i * 5, inserts: 20 + i, updates: 8, deletes: 1, commands: 30, net_in: 50000, net_out: 120000, connections: 40 + i, read_latency_ms: 2.5, write_latency_ms: 4.1 }));
const CLUSTERS = [
  { name: 'prod-atlas-cluster', state: 'IDLE', health: 'healthy', version: '7.0.12', type: 'REPLICASET', tier: 'M30', provider: 'AWS', regions: ['AP_SOUTH_1'], disk_gb: 80, backup: true, termination_protection: true, created: iso(90000) },
  { name: 'staging-cluster', state: 'UPDATING', health: 'warning', version: '7.0.12', type: 'REPLICASET', tier: 'M10', provider: 'AWS', regions: ['AP_SOUTH_1'], disk_gb: 20, backup: false },
];
const PROCS = [{ id: 'prod-atlas-cluster-shard-00-00.ab1cd.mongodb.net:27017', host: 'prod-atlas-cluster-shard-00-00.ab1cd.mongodb.net', port: 27017, type: 'REPLICA_PRIMARY', alias: 'prod-atlas-cluster-shard-00-00', replica_set: 'atlas-x-shard-0', version: '7.0.12', cluster: 'prod-atlas-cluster' },
  { id: 'prod-atlas-cluster-shard-00-01.ab1cd.mongodb.net:27017', host: 'prod-atlas-cluster-shard-00-01.ab1cd.mongodb.net', port: 27017, type: 'REPLICA_SECONDARY', alias: 'prod-atlas-cluster-shard-00-01', replica_set: 'atlas-x-shard-0', version: '7.0.12', cluster: 'prod-atlas-cluster' }];
const pts = (f) => Array.from({ length: 10 }, (_, i) => ({ ts: iso(10 - i), v: f(i) }));
const MEAS = { available: true, process: PROCS[0].id, period: '1h', granularity: 'PT1M', series: {
  SYSTEM_NORMALIZED_CPU_USER: { points: pts((i) => 20 + i) }, SYSTEM_NORMALIZED_CPU_KERNEL: { points: pts(() => 3) },
  SYSTEM_MEMORY_USED: { points: pts(() => 4000000) }, SYSTEM_MEMORY_AVAILABLE: { points: pts(() => 3000000) },
  OPCOUNTER_QUERY: { points: pts((i) => 9000 + i * 100) }, OPCOUNTER_INSERT: { points: pts(() => 1200) }, OPCOUNTER_UPDATE: { points: pts(() => 600) }, OPCOUNTER_DELETE: { points: pts(() => 40) },
  OP_EXECUTION_TIME_READS: { points: pts(() => 30) }, OP_EXECUTION_TIME_WRITES: { points: pts(() => 45) }, CONNECTIONS: { points: pts(() => 4200) },
  NETWORK_BYTES_IN: { points: pts(() => 2e6) }, NETWORK_BYTES_OUT: { points: pts(() => 6e6) }, QUERY_TARGETING_SCANNED_PER_RETURNED: { points: pts(() => 12) } },
  disks: [{ partition: 'nvme1n1', series: { DISK_PARTITION_SPACE_PERCENT_USED: { points: pts(() => 31) } } }] };
const ALERTS = [
  { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', event: 'OUTSIDE_METRIC_THRESHOLD', metric_name: 'NORMALIZED_SYSTEM_CPU_USER', status: 'OPEN', cluster: 'prod-atlas-cluster', host: 'prod-atlas-cluster-shard-00-00:27017', metric: 85, units: 'RAW', created: iso(5), updated: iso(1), severity: 'warning' },
  { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', event: 'NO_PRIMARY', status: 'OPEN', cluster: 'staging-cluster', created: iso(18), updated: iso(2), severity: 'critical' }];
const DP = { available: true, server: { version: '7.0.12' }, databases: [
  { name: 'analytics', storage_size: 48.6e9, data_size: 40e9, index_size: 6e9, collections: 32, objects: 12.4e6, indexes: 60 },
  { name: 'shop', storage_size: 18.2e9, data_size: 15e9, index_size: 2e9, collections: 28, objects: 5.8e6, indexes: 41 }],
  totals: { databases: 2, collections: 60, documents: 18.2e6, storage_bytes: 66.8e9, index_bytes: 8e9 },
  source: 'atlas', trends: { databases_week: 2, collections_week: 18, documents_24h_pct: 12.5 },
  history: Array.from({ length: 48 }, (_, i) => ({ ts: iso((48 - i) * 60), databases: i < 20 ? 0 : 2, collections: 42 + Math.round(i / 3), documents: 16e6 + i * 5e4, storage: 60e9 + i * 1e8 })) };
const NOAPI = (reason) => ({ available: false, reason, requires: 'api_key' });

function answer(url, method, postData) {
  const u = new URL(url); const p = u.pathname.replace(/\/+$/, '');
  if (method === 'POST' || method === 'PUT') posts.push({ p, body: postData ? JSON.parse(postData) : null });
  if (p.endsWith('/connections/mongoatlas/test')) {
    const b = JSON.parse(postData);
    return [200, (b.connection_uri || '').includes('wrongpw')
      ? { ok: false, results: { database: { ok: false, kind: 'auth', message: 'Authentication failed — check the database username and password (Atlas → Database Access).' } } }
      : { ok: true, results: { database: { ok: true, version: '7.0.12', set_name: 'atlas-x-shard-0', latency_ms: 41 }, ...(b.project_id ? { api: { ok: true, project_name: 'Payments', cluster_count: 2 } } : {}) } }];
  }
  if (p.endsWith('/connections/mongoatlas') && method === 'POST') { saved = CONN(); return [200, { status: 'success', connection: saved }]; }
  if (p.endsWith('/connections/mongoatlas') && method === 'GET') return [200, saved ? [saved] : []];
  const m = p.match(/\/connections\/mongoatlas\/31(\/.*)?$/);
  if (m) {
    const sub = m[1] || '';
    if (!sub) return [200, CONN()];
    if (sub === '/overview') return [200, { connection: CONN(), data_plane: dpAtlas ? DP : { ...DP, source: undefined, history: undefined, trends: undefined }, clusters: withApi ? { available: true, project: 'Payments', clusters: CLUSTERS } : NOAPI('Add an Atlas API key to see clusters, tiers and regions.'), alerts: withApi ? { available: true, alerts: ALERTS } : NOAPI('Atlas alerts need an Atlas API key.'), sampled, fetched_at: new Date().toISOString() }];
    if (sub === '/clusters') return [200, withApi ? { available: true, clusters: CLUSTERS, processes: PROCS } : NOAPI('Add an Atlas API key to see clusters, tiers and regions.')];
    if (sub === '/measurements') return [200, MEAS];
    if (sub === '/collections') return [200, { available: true, database: u.searchParams.get('database'), collections: [{ name: 'orders', type: 'collection', count: 5800000, size: 9e9, storage_size: 10e9, index_size: 1e9, indexes: 4, avg_obj_size: 1550 }, { name: 'v_recent', type: 'view' }] }];
    if (sub === '/indexes') return [200, { available: true, indexes: [{ name: '_id_', key: [['_id', 1]], unique: false, ops: 900 }, { name: 'email_1', key: [['email', 1]], unique: true, ops: 0, since: '2026-09-01T00:00:00' }] }];
    if (sub === '/replication') return [200, { available: true, replica_set: { set: 'atlas-x-shard-0', members: [{ name: 'n0:27017', state: 'PRIMARY', health: 1, lag_sec: 0, ping_ms: 0, uptime_sec: 900000 }, { name: 'n1:27017', state: 'SECONDARY', health: 1, lag_sec: 2, ping_ms: 1, sync_source: 'n0:27017', uptime_sec: 900000 }] }, sharding: { sharded: false } }];
    if (sub === '/current-ops') return [200, { available: true, ops: [{ opid: 7, op: 'query', ns: 'shop.orders', secs: 3, micros: 3200000, plan: 'COLLSCAN', client: 'api', waiting_lock: false }] }];
    if (sub === '/slow-queries') return [200, { available: true, queries: [{ ns: 'shop.orders', duration_ms: 2400, docs_examined: 500000, returned: 10, op: 'find', plan: 'COLLSCAN' }, { ns: 'shop.orders', duration_ms: 1200, docs_examined: 200000, returned: 5, plan: 'COLLSCAN' }], suggested_indexes: [{ ns: 'shop.orders', index: [{ email: 1 }], weight: 812.4 }] }];
    if (sub === '/alerts') return [200, { available: true, alerts: ALERTS }];
    if (/\/alerts\/\w+\/ack$/.test(sub)) return [200, { status: 'success' }];
    if (sub === '/backups') return [200, { available: true, clusters: [{ cluster: 'prod-atlas-cluster', backup_enabled: true, snapshots: [{ id: 's1', created: iso(120), status: 'completed', type: 'scheduled', frequency: 'hourly', size_bytes: 42e9, expires: iso(-9000) }], policy: [{ frequency: 'HOURLY', retention: '2 days' }] }, { cluster: 'staging-cluster', backup_enabled: false, snapshots: [] }] }];
    if (sub === '/security') return [200, { available: true, users: [{ username: 'appuser', auth_db: 'admin', roles: ['readWriteAnyDatabase@admin'], scopes: [], auth: 'SCRAM' }], access_list: [{ entry: '0.0.0.0/0', comment: 'temp', open_to_world: true }, { entry: '20.219.250.110/32', comment: 'ActMon' }] }];
    if (sub === '/cluster-usage') return [200, withApi ? { available: true, clusters: [{ name: 'prod-atlas-cluster', health: 'healthy', tier: 'M30', cpu: 32, memory: 45, storage: 31, ops: 12400 }, { name: 'staging-cluster', health: 'warning', tier: 'M10', cpu: 68, memory: 72, storage: 58, ops: 8100 }] } : NOAPI('Per-cluster CPU, memory and storage need an Atlas API key.')];
    if (sub === '/storage-trend') return [200, { available: true, source: 'atlas', series: pts((i) => 0).map((x, i) => ({ ts: x.ts, data: 200e9 + i * 1e9, index: 60e9 })) }];
    if (sub === '/nodes') return [200, { available: true, nodes: [{ id: PROCS[0].id, cpu: 32, memory: 45, connections: 4200, disk: 31, ops: 12400, last_sample: iso(1) }, { id: PROCS[1].id, cpu: 12, memory: 40, connections: 300, disk: 31, ops: 800, last_sample: iso(30) }] }];
    if (sub === '/cost') return [200, { available: false, reason: 'This API key cannot read billing. Cost & Usage needs an organisation API key with the Organization Billing Viewer role.', requires: 'billing_role' }];
    if (sub === '/test') return [200, { ok: true, results: { database: { ok: true, version: '7.0.12', latency_ms: 30 } } }];
  }
  if (p.endsWith('/connections/cosmosdb')) return [200, [{ id: 1, connection_name: 'cosmo' }]];
  return [200, []];
}

const profile = mkdtempSync(join(process.env.TMP || tmpdir(), 'atlas-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* */ } if (!wsUrl) await sleep(200); }
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let mid = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++mid; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const pageErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push((m.params.exceptionDetails?.exception?.description || '').split('\n')[0]);
  if (m.method === 'Fetch.requestPaused') {
    const r = m.params.request;
    const [code, body] = answer(r.url, r.method, r.postData);
    send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
  }
};
const js = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
async function waitFor(x, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await js(x)) return true; await sleep(150); } return false; }
const has = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;
const shot = async (n, h = 1000) => {
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(600);
  const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, n), Buffer.from(s.result.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
};
let passed = 0; let failed = 0;
const ok = (c, msg) => { if (c) { passed++; console.log('  PASS ', msg); } else { failed++; console.log('  FAIL ', msg); } };
const clickText = (sel, text) => js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
const typeInto = (placeholder, value) => js(`(() => { const el = document.querySelector('input[placeholder^=${JSON.stringify(placeholder)}]'); if (!el) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

await send('Runtime.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/*' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
const payload = Buffer.from(JSON.stringify({ sub: 'qa', exp: Math.floor(now / 1000) + 3600 })).toString('base64url');
await send('Page.navigate', { url: `${ORIGIN}/login` });
await sleep(1500);
await js(`localStorage.setItem('actmon_token', 'x.${payload}.y'); localStorage.setItem('actmon_user', JSON.stringify({ id: 1, username: 'qa', role_id: 1, org_id: 1 })); true`);

console.log('=== /databases card ===');
await send('Page.navigate', { url: `${ORIGIN}/databases` });
ok(await waitFor(has('Cloud-Based Databases'), 30000), 'databases page renders');
const order = await js(`(() => { const h = [...document.querySelectorAll('h2')].find(x => x.textContent.includes('Cloud-Based')); const grid = h.parentElement.nextElementSibling; return [...grid.querySelectorAll('h3')].map(x => x.textContent.trim()); })()`);
ok(order?.[0] === 'MongoDB Atlas' && order?.[1] === 'Azure Cosmos DB' && order.length === 9 && order.filter((x) => x === 'MongoDB Atlas').length === 1,
  `Atlas is first, Cosmos second, 9 cards, Atlas once (${(order || []).join(' | ')})`);
ok(await js(`${has('Popular')} && ${has('Connect Atlas')} && ${has('Connect Cosmos DB')} && ${has('View Details')}`), 'Popular badge, Connect Atlas / Connect Cosmos DB and View Details');
ok(await js(`(() => { const h = [...document.querySelectorAll('h3')].find(x => x.textContent === 'Amazon DynamoDB'); return h.closest('[aria-disabled]') && h.closest('div.rounded-2xl').innerText.toLowerCase().includes('coming soon'); })()`), 'other cloud cards stay Coming Soon');
await shot('databases.png', 1500);
await clickText('button', 'Connect Atlas');
ok(await waitFor(`location.pathname === '/mongoatlas/new'`), 'Connect Atlas opens the setup form');

console.log('=== connection form ===');
ok(await waitFor(has('Connection URI') + ' && ' + has('Database credentials') + ' && ' + has('Atlas API key')), 'three authentication methods');
ok(await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Save connection')).disabled`), 'Save is disabled before a test');
await clickText('button', 'Test Connection');
ok(await waitFor(has('Required')), 'empty form → field validation, no request');
ok(!posts.some((x) => x.p.endsWith('/test')), 'validation stopped the test request');
await typeInto('e.g. Prod Atlas', 'Prod Atlas');
await typeInto('mongodb+srv://', 'http://not-a-uri');
await clickText('button', 'Test Connection');
ok(await waitFor(has('Must start with mongodb+srv://')), 'bad URI format is rejected');
await typeInto('mongodb+srv://', 'mongodb+srv://u:wrongpw@cluster0.ab1cd.mongodb.net/');
await clickText('button', 'Test Connection');
ok(await waitFor(has('Authentication failed')), 'authentication failure is shown clearly');
ok(await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Save connection')).disabled`), 'still cannot save after a failed test');
ok(await js(`document.querySelector('input[placeholder^="mongodb+srv://"]').type === 'password'`), 'URI field is masked');
await typeInto('mongodb+srv://', 'mongodb+srv://u:goodpw@cluster0.ab1cd.mongodb.net/');
await js(`(() => { const c = [...document.querySelectorAll('label')].find(l => l.textContent.includes('Also add an Atlas Admin API key')).querySelector('input'); c.click(); return true; })()`);
await typeInto('24-char hex', PID);
await js(`(() => { const ins = [...document.querySelectorAll('input.font-mono')]; const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }; set(ins[ins.length - 2], 'abcdwxyz'); set(ins[ins.length - 1], 'priv-key-123'); return true; })()`);
await clickText('button', 'Test Connection');
ok(await waitFor(has('Connected — ready to save') + ' && ' + has('Project “Payments”')), 'successful test of cluster AND Atlas API');
await shot('form.png', 1200);
ok(await js(`![...document.querySelectorAll('button')].find(b => b.textContent.includes('Save connection')).disabled`), 'Save enabled after a successful test');
await clickText('button', 'Save connection');
ok(await waitFor(`location.pathname === '/mongoatlas-dashboard/31'`), 'saving opens the dashboard');
const created = posts.find((x) => x.p.endsWith('/connections/mongoatlas'));
ok(created && created.body.connection_uri.includes('goodpw') && created.body.api_private_key === 'priv-key-123' && created.body.project_id === PID, 'create sends the typed values to the ActMon backend only');

console.log('=== dashboard ===');
ok(await waitFor(has('MongoDB Atlas Dashboard') + ' && ' + has('Total Clusters'), 20000), 'dashboard header + KPIs');
ok(await js(`JSON.stringify([...document.querySelectorAll('[role=tab]')].map(b => b.textContent.trim())) === JSON.stringify(['Overview','Atlas Clusters','Databases','Collections','Performance','Replication & Sharding','Backups','Security & Access','Query Analytics','Schemas & Indexes','Capacity & Storage','Cost & Usage','Settings'])`), 'the 13 reference tabs, in reference order');
ok(await js(`document.querySelectorAll('aside nav, [class*="sidebar"]').length === 0`), 'no left sidebar');
ok(await waitFor(`['Total Clusters','Total Databases','Total Collections','Total Documents','Storage Usage','Active Alerts','Cluster Health','Operations (Ops/sec)','Latency (Average)','Top Clusters by Resource Usage','Database Size (Top 5)','Recent Alerts','Connections','Network Traffic','Storage Usage Trend'].every(t => document.body.innerText.includes(t))`), 'every reference card and panel, by title');
ok(await js(`${has('Monitor your MongoDB Atlas clusters, performance, and health in real-time')} && !!document.querySelector('select[aria-label="Time range"]') && !!document.querySelector('select[aria-label="Refresh interval"]') && ${has('Add Cluster')}`), 'header: subtitle, time range, refresh interval, Add Cluster');
ok(await waitFor(`${has('+2 this week')} && ${has('+18 this week')} && ${has('+12.5% (24h)')} && ${has('of 100 GB')} && ${has('1 Healthy')} && ${has('12.4 K')} && ${has('68%')} && ${has('No primary')} && ${has('analytics')}`), 'real values: storage of provisioned disk, cluster usage table, alerts, database sizes');
ok(await js(`document.querySelectorAll('.recharts-surface').length >= 6`), 'donut + five time-series charts drawn');
await send('Emulation.setDeviceMetricsOverride', { width: 1624, height: 926, deviceScaleFactor: 1, mobile: false }); await sleep(800);
{ await send('Emulation.setDeviceMetricsOverride', { width: 1632, height: 926, deviceScaleFactor: 1, mobile: false }); await sleep(800); const s2 = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, 'overview-1632.png'), Buffer.from(s2.result.data, 'base64')); }
await shot('overview.png', 1500);
dpAtlas = false;
const tabs = [['clusters', 'CLUSTER TOPOLOGY', 'SECONDARY'], ['performance', 'CPU usage (%)', 'Current operations'], ['databases', 'Databases (2)', 'analytics'], ['collections', 'Collections in', 'orders'],
  ['query', 'Slow queries (Performance Advisor)', 'shop.orders'], ['replication', 'Replica set atlas-x-shard-0', 'SECONDARY'],
  ['backups', 'Backups off', 'completed'], ['security', 'allows 0.0.0.0/0', 'appuser'], ['schemas', 'Indexes on orders', 'email_1'],
  ['capacity', 'Cluster disk capacity', 'Storage by database'], ['cost', 'Organization Billing Viewer', 'API Keys'], ['settings', 'Atlas project ID', 'private key stored encrypted']];
for (const [tid, a, b] of tabs) {
  await js(`[...document.querySelectorAll('[role=tab]')].find(x => x.textContent.trim().startsWith(${JSON.stringify(ATLAS_LABEL(tid))})).click(), true`);
  const good = await waitFor(`location.pathname.endsWith('/${tid}') && ${has(a)} && ${has(b)}`, 12000);
  ok(good, `tab ${tid}: ${a} / ${b}`);
  if (tid === 'clusters') ok(await waitFor(`${has('Accepts writes')} && ${has('Read replica')} && ${has('Reporting')} && ${has('No samples')}`), 'topology: primary + secondary node cards, fresh vs stale sample');
  if (['clusters', 'performance', 'query', 'security'].includes(tid)) await shot(`tab-${tid}.png`, 1400);
}
function ATLAS_LABEL(t) { return { clusters: 'Atlas Clusters', performance: 'Performance', databases: 'Databases', collections: 'Collections', query: 'Query Analytics', replication: 'Replication', backups: 'Backups', security: 'Security', schemas: 'Schemas', capacity: 'Capacity', cost: 'Cost', settings: 'Settings' }[t]; }
ok(!(await js(`document.body.innerText.includes('goodpw') || document.body.innerText.includes('priv-key-123')`)), 'no secret anywhere on the dashboard');

console.log('=== collections → indexes, alert detail + ack ===');
await send('Page.navigate', { url: `${ORIGIN}/mongoatlas-dashboard/31/collections` });
await waitFor(has('orders'));
await js(`[...document.querySelectorAll('tbody tr')].find(r => r.innerText.startsWith('orders')).click(), true`);
ok(await waitFor(`${has('email_1')} && ${has('unused since')}`), 'collection click → indexes drawer with usage');
await send('Page.navigate', { url: `${ORIGIN}/mongoatlas-dashboard/31` });
await waitFor(has('Recent Alerts'));
await js(`[...document.querySelectorAll('section')].find(x => x.querySelector('h3')?.textContent === 'Recent Alerts').querySelector('header button').click(), true`);
ok(await waitFor(`location.pathname.endsWith('/alerts') && ${has('Atlas alerts')}`), 'Recent Alerts → View All opens the alerts list');
await waitFor(has('No primary'));
await js(`[...document.querySelectorAll('tbody tr')].find(r => r.innerText.includes('No primary')).click(), true`);
ok(await waitFor(`${has('Acknowledge in Atlas')} && ${has('Triggered')}`), 'alert row → alert detail');
await clickText('button', 'Acknowledge');
ok(await waitFor(`!${has('Acknowledge in Atlas')}`) && posts.some((x) => /\/alerts\/bbbbbbbbbbbbbbbbbbbbbbbb\/ack$/.test(x.p) && x.body.hours === 24), 'acknowledge posts for THIS alert only');

console.log('=== without an API key ===');
withApi = false;
await send('Page.navigate', { url: `${ORIGIN}/mongoatlas-dashboard/31` });
ok(await waitFor(`${has('Needs an Atlas API key')} && ${has('Sampled by ActMon')}`, 20000), 'overview: API-only KPIs say what they need; ops chart is ActMon-sampled');
await send('Page.navigate', { url: `${ORIGIN}/mongoatlas-dashboard/31/backups` });
ok(await waitFor(`${has('Backups are read through the Atlas Admin API.')} && ${has('Add API key')}`), 'backups: explained unavailable state, no invented data');

withApi = true;
console.log('=== connections list ===');
await send('Page.navigate', { url: `${ORIGIN}/mongoatlas-servers` });
ok(await waitFor(`${has('Prod Atlas')} && ${has('Connected')} && !!document.querySelector('[aria-label="Remove Prod Atlas"]') && !!document.querySelector('[aria-label="Reconnect Prod Atlas"]')`), 'list shows status + reconnect / edit / remove');
ok(await waitFor(`${has('prod-atlas-cluster')} && ${has('PRIMARY')} && ${has('SECONDARY')} && ${has('Cluster dashboard')}`), 'connections page: cluster topology with node cards, like Oracle');
await shot('connections.png', 1300);
await js(`[...document.querySelectorAll('article')].find(a => a.innerText.includes('SECONDARY')).querySelector('button').click(), true`);
ok(await waitFor(`location.pathname === '/mongoatlas-dashboard/31' && location.search.includes('node=') && ${has('Instance · SECONDARY')}`), 'node Dashboard → instance-scoped dashboard');
ok(await js(`document.querySelector('select[aria-label="Scope"]').value.startsWith('n:prod-atlas-cluster-shard-00-01')`), 'scope picker shows the chosen instance');
await js(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent.startsWith('Performance')).click(), true`);
ok(await waitFor(`location.pathname.endsWith('/performance') && location.search.includes('node=')`), 'switching tabs keeps the instance scope');
await send('Page.navigate', { url: `${ORIGIN}/mongodb-atlas-servers` });
ok(await waitFor(has('Cluster dashboard')), '/mongodb-atlas-servers opens the same page');
await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Cluster dashboard')).click(), true`);
ok(await waitFor(`location.search.includes('cluster=prod-atlas-cluster') && ${has('Show all clusters')}`), 'cluster dashboard scope');
await send('Page.navigate', { url: `${ORIGIN}/mongoatlas-servers` });
await waitFor(has('Prod Atlas'));
await js(`document.querySelector('[aria-label="Remove Prod Atlas"]').click(), true`);
ok(await waitFor(has('Remove this Atlas connection?')), 'remove asks for confirmation');

ok(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(' | ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
chrome.kill(); process.exit(failed ? 1 : 0);
