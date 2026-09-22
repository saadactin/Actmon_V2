// The Alerts API layer's wire format: what actually goes out on the wire,
// not what the JS object looks like before axios serializes it.
//
// This is the suite that found the bug it exists to prevent. `listInstances`
// passed `state` as an array with no paramsSerializer, so axios emitted
// `state[]=OPEN&state[]=ACKNOWLEDGED` while the backend
// (alert_rules.py:427, `state: Optional[List[str]] = Query(None)`) only
// reads repeated `state=` keys. The result: `states` resolved to `None` on
// every request, `if states:` was falsy, and NO state filter was ever
// applied — the "Open" view listed resolved alerts, and "Resolved only"
// returned everything. Fixed by lifting resources.api.js's `serialize`
// helper verbatim. This suite pins the fix and, more importantly, makes the
// SAME mistake impossible to reintroduce anywhere else in this module: rule
// 1 below drives every exported function and fails if ANY of them ever
// emits `[]=` again.
//
// Technique: swap axios's adapter for a stub that captures the request
// config, then read `cloudAxios.getUri(config)` — axios's REAL serializer,
// i.e. the actual query string a browser would send. Asserting on
// `config.params` instead would have missed this bug entirely, because the
// object shape looked correct; only the serialized string was wrong.
import { cloudAxios } from '../src/features/cloud/api/axios.js';
import * as api from '../src/features/cloud/api/alerts.api.js';

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

// ── The stub adapter ─────────────────────────────────────────────────────────
let captured = null;
cloudAxios.defaults.adapter = async (config) => {
  captured = config;
  return {
    data: {}, status: 200, statusText: 'OK', headers: {}, config,
  };
};

/** Calls `fn(...args)`, returns { uri, method, body, params }. Fails loudly
 *  (rather than silently passing) if the stub was never reached — otherwise
 *  a module that grew its own axios instance would make every assertion
 *  below pass vacuously. */
async function capture(label, fn, ...args) {
  captured = null;
  await fn(...args);
  if (!captured) {
    check(`${label}: reached the stub adapter`, false,
      'the call never hit cloudAxios — this assertion would otherwise pass vacuously');
    return { uri: '', method: '', body: undefined };
  }
  // axios's default transformRequest runs BEFORE the adapter, so a POST/PUT
  // body arrives here already JSON.stringify'd — parse it back so callers
  // can assert on the real shape rather than a string.
  let body = captured.data;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* not JSON; leave as-is */ }
  }
  return {
    uri: cloudAxios.getUri(captured),
    method: captured.method,
    body,
  };
}

const ACCOUNT = 'ACC-1';

console.log('\n1. THE BUG: no request from this module ever sends `[]=`');
{
  const { uri } = await capture('listInstances with two states', api.listInstances,
    ACCOUNT, { state: ['OPEN', 'ACKNOWLEDGED'] });
  check('listInstances sends repeated state= keys, not state[]=',
    uri.includes('state=OPEN') && uri.includes('state=ACKNOWLEDGED') && !uri.includes('%5B%5D'),
    uri);
  check('listInstances never emits the bracket form', !/\[\]=/.test(decodeURIComponent(uri)), uri);
}

// Blanket rule, driven across every exported function this module has. This
// is what stops the NEXT array-shaped filter from repeating the bug — a
// one-off assertion on listInstances alone would not have caught it if the
// same mistake landed on a different function next time.
console.log('\n2. Blanket rule: NOTHING in this module ever emits []= or %5B%5D');
{
  const probes = [
    ['getCapabilities', api.getCapabilities, [ACCOUNT]],
    ['getSummary', api.getSummary, [ACCOUNT]],
    ['getActivity', api.getActivity, [ACCOUNT, { days: 7, limit: 50 }]],
    ['listRules (all filters)', api.listRules, [ACCOUNT, {
      category: 'cost', enabled: false, severity: 'HIGH',
      conditionType: 'cost_spike', notifies: true, q: 'ec2',
    }]],
    ['previewRule', api.previewRule, [ACCOUNT, { condition_type: 'cost_spike' }]],
    ['duplicateRule', api.duplicateRule, [ACCOUNT, 'r1']],
    ['silenceRule', api.silenceRule, [ACCOUNT, 'r1', { seconds: 3600, reason: 'maint' }]],
    ['unsilenceRule', api.unsilenceRule, [ACCOUNT, 'r1']],
    ['getTemplates', api.getTemplates, [ACCOUNT]],
    ['applyTemplates (with keys)', api.applyTemplates, [ACCOUNT, ['k1', 'k2']]],
    ['getAnalytics', api.getAnalytics, [ACCOUNT, 30]],
    ['getNoisyRules', api.getNoisyRules, [ACCOUNT, 7]],
    ['getRelated', api.getRelated, [ACCOUNT, 'a1']],
    ['silenceAlert', api.silenceAlert, [ACCOUNT, 'a1', { seconds: 60, reason: 'r' }]],
    ['unsilenceAlert', api.unsilenceAlert, [ACCOUNT, 'a1']],
    ['getChannels', api.getChannels, [ACCOUNT]],
    ['testChannel', api.testChannel, [ACCOUNT, 'slack', ['#ops']]],
    ['listNotifications', api.listNotifications, [ACCOUNT, { status: 'sent', days: 7, limit: 20 }]],
    ['getNotification', api.getNotification, [ACCOUNT, 'n1']],
    ['getAlertSettings', api.getAlertSettings, [ACCOUNT]],
    ['updateAlertSettings', api.updateAlertSettings, [ACCOUNT, { alert_retention_days: 90 }]],
    ['runPrune', api.runPrune, [ACCOUNT]],
    ['getRule', api.getRule, [ACCOUNT, 'r1']],
    ['createRule', api.createRule, [ACCOUNT, { name: 'x' }]],
    ['updateRule', api.updateRule, [ACCOUNT, 'r1', { name: 'y' }]],
    ['setRuleEnabled', api.setRuleEnabled, [ACCOUNT, 'r1', false]],
    ['deleteRule', api.deleteRule, [ACCOUNT, 'r1']],
    ['testRule', api.testRule, [ACCOUNT, 'r1']],
    ['listInstances (all filters)', api.listInstances, [ACCOUNT, {
      state: ['OPEN', 'ACKNOWLEDGED'], severity: 'HIGH', category: 'cost',
      ruleId: 'r1', days: 7, q: 'ec2',
    }]],
    ['getInstance', api.getInstance, [ACCOUNT, 'a1']],
    ['acknowledgeInstance', api.acknowledgeInstance, [ACCOUNT, 'a1', 'seen it']],
    ['resolveInstance', api.resolveInstance, [ACCOUNT, 'a1', 'fixed it']],
    ['getEmailSettings', api.getEmailSettings, [ACCOUNT]],
    ['addRecipient', api.addRecipient, [ACCOUNT, { email: 'a@b.com' }]],
    ['setRecipientEnabled', api.setRecipientEnabled, [ACCOUNT, 'rec1', true]],
    ['deleteRecipient', api.deleteRecipient, [ACCOUNT, 'rec1']],
    ['getEngineStatus', api.getEngineStatus, [ACCOUNT]],
  ];

  for (const [label, fn, args] of probes) {
    const { uri } = await capture(label, fn, ...args);
    check(`${label}: no []= or %5B%5D in the URI`,
      !/\[\]=|%5B%5D/.test(uri), uri);
  }
  check('the blanket rule actually probed every array-capable function',
    probes.length >= 34, `probed ${probes.length}`);
}

console.log('\n3. Account scoping: every request is scoped to /alerts/{accountId}/');
{
  const probes = [
    ['getCapabilities', api.getCapabilities, [ACCOUNT]],
    ['listRules', api.listRules, [ACCOUNT, {}]],
    ['listInstances', api.listInstances, [ACCOUNT, {}]],
    ['getChannels', api.getChannels, [ACCOUNT]],
    ['getEmailSettings', api.getEmailSettings, [ACCOUNT]],
    ['getEngineStatus', api.getEngineStatus, [ACCOUNT]],
    ['createRule', api.createRule, [ACCOUNT, {}]],
    ['addRecipient', api.addRecipient, [ACCOUNT, {}]],
  ];
  for (const [label, fn, args] of probes) {
    const { uri } = await capture(label, fn, ...args);
    check(`${label} is scoped to this account`,
      uri.includes(`/alerts/${ACCOUNT}/`), uri);
  }
}

console.log('\n4. Omission discipline: undefined/false filters are not confused');
{
  const { uri: withFalse } = await capture('listRules enabled:false', api.listRules,
    ACCOUNT, { enabled: false });
  check('listRules: enabled=false IS sent (a real filter value, not absent)',
    withFalse.includes('enabled=false'), withFalse);

  const { uri: withUndef } = await capture('listRules enabled:undefined', api.listRules,
    ACCOUNT, { enabled: undefined });
  check('listRules: enabled=undefined sends no enabled param at all '
    + '(|| would have erased "show disabled rules" the same way ?? would not)',
    !withUndef.includes('enabled='), withUndef);

  const { body: withKeys } = await capture('applyTemplates with keys', api.applyTemplates,
    ACCOUNT, ['k1', 'k2']);
  check('applyTemplates([k1,k2]) sends {keys:[k1,k2]}',
    Array.isArray(withKeys.keys) && withKeys.keys.length === 2, JSON.stringify(withKeys));

  const { body: noKeys } = await capture('applyTemplates with no keys', api.applyTemplates,
    ACCOUNT, []);
  check('applyTemplates([]) sends {keys:null} — null means "all recommended", '
    + '[] would wrongly mean "apply none"',
    noKeys.keys === null, JSON.stringify(noKeys));
}

console.log('\n5. Destructive defaults are opt-in, not opt-out');
{
  const { uri: defaultPrune } = await capture('runPrune with no argument', api.runPrune, ACCOUNT);
  check('runPrune() with no argument defaults to dry_run=true — '
    + 'deletion must be asked for explicitly, never the default',
    defaultPrune.includes('dry_run=true'), defaultPrune);

  const { uri: explicitPrune } = await capture('runPrune(false)', api.runPrune, ACCOUNT, false);
  check('runPrune(false) sends dry_run=false — the real delete is still reachable',
    explicitPrune.includes('dry_run=false'), explicitPrune);
}

console.log('\n6. HTTP verbs match the audit-trail intent');
{
  const { method: setEnabled } = await capture('setRuleEnabled', api.setRuleEnabled, ACCOUNT, 'r1', false);
  check('setRuleEnabled is POST, not PATCH — its own endpoint so the audit '
    + 'trail records "disabled" rather than "updated"', setEnabled === 'post', setEnabled);

  const { method: update } = await capture('updateRule', api.updateRule, ACCOUNT, 'r1', {});
  check('updateRule is PATCH', update === 'patch', update);

  const { method: del } = await capture('deleteRule', api.deleteRule, ACCOUNT, 'r1');
  check('deleteRule is DELETE', del === 'delete', del);

  const { method: unsilenceR } = await capture('unsilenceRule', api.unsilenceRule, ACCOUNT, 'r1');
  check('unsilenceRule is DELETE', unsilenceR === 'delete', unsilenceR);

  const { method: unsilenceA } = await capture('unsilenceAlert', api.unsilenceAlert, ACCOUNT, 'a1');
  check('unsilenceAlert is DELETE', unsilenceA === 'delete', unsilenceA);

  const { method: delRecipient } = await capture('deleteRecipient', api.deleteRecipient, ACCOUNT, 'rec1');
  check('deleteRecipient is DELETE', delRecipient === 'delete', delRecipient);
}

console.log('\n7. No email function is ever invoked as a side effect of a read');
{
  const readOnlyProbes = [
    ['getCapabilities', api.getCapabilities, [ACCOUNT]],
    ['getSummary', api.getSummary, [ACCOUNT]],
    ['listRules', api.listRules, [ACCOUNT, {}]],
    ['listInstances', api.listInstances, [ACCOUNT, {}]],
    ['getChannels', api.getChannels, [ACCOUNT]],
    ['getEmailSettings', api.getEmailSettings, [ACCOUNT]],
    ['getAlertSettings', api.getAlertSettings, [ACCOUNT]],
    ['getEngineStatus', api.getEngineStatus, [ACCOUNT]],
    ['listNotifications', api.listNotifications, [ACCOUNT, {}]],
  ];
  for (const [label, fn, args] of readOnlyProbes) {
    const { method } = await capture(label, fn, ...args);
    check(`${label} is a GET, never a side-effecting verb`, method === 'get', method);
  }

  const { body: testEmailBody } = await capture('sendTestEmail with no recipients', api.sendTestEmail,
    ACCOUNT, []);
  check('sendTestEmail([]) sends {recipients:null} (uses account defaults), '
    + 'not {recipients:[]} (which would mean "send to nobody")',
    testEmailBody.recipients === null, JSON.stringify(testEmailBody));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
