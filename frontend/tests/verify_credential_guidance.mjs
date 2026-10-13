// utils/credentialGuidance.js — "what can I do" for one certificate / secret / key.
//
// Pins three things:
//   * Unknown use is never treated as "unused": the steps say how to find out
//     BEFORE anything suggests deleting, and the headline stays urgent.
//   * Every command is filled in with the object's real identifiers — the
//     load balancer OCID, the ARN, the vault, the resource group — and in the
//     order that does not break anything (switch listeners, THEN delete).
//   * Coverage: every store the backend collects (parsed from its source) has
//     guidance written for it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GUIDED_SOURCES, credentialGuidance, lifecycleOf, portalLink, resourceGroupOf, shellQuote,
  usageExplanation,
} from '../src/features/cloud/utils/credentialGuidance.js';

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const NOW = new Date('2026-09-29T06:00:00Z');
const ids = (g) => g.steps.map((s) => s.id);
const step = (g, id) => g.steps.find((s) => s.id === id);

// Shaped like the live KOEL rows returned by /cloud/certificates/{account}.
const LB = 'ocid1.loadbalancer.oc1.ap-mumbai-1.aaaaexample';
const ociLb = (over = {}) => ({
  id: 'r1', account_id: 'acc-oci', account_name: 'oci_test', provider: 'OCI',
  source: 'oci:load-balancer-certificates', source_label: 'OCI load balancer certificates',
  kind: 'CERTIFICATE', object_key: `${LB}/certificates/LGM_IND_25New`, name: 'LGM_IND_25New',
  container_name: 'koebomebslbpub01', container_key: LB, region: 'ap-mumbai-1',
  expires_at: '2026-01-29T00:00:00+00:00', days_left: -243.2, bucket: 'expired',
  managed_renewal: false, in_use: true,
  in_use_by: ['Listener prd-indi4-listener (port 443)'], details: { usage_source: 'live' },
  ...over,
});

console.log('\n1. OCI load balancer certificates (the KOEL case)');
{
  const g = credentialGuidance(ociLb(), NOW);
  eq('expired + in use -> upload, switch, delete, then an alert', ids(g),
    ['upload', 'switch', 'delete', 'alert']);
  check('the headline is danger and says it is still in use',
    g.headline.tone === 'danger' && /still in use/.test(g.headline.text), g.headline.text);
  check('...and how long ago it expired', /243 days ago/.test(g.headline.text), g.headline.text);
  const up = step(g, 'upload').command;
  check('upload names the real load balancer and region',
    up.includes(`--load-balancer-id ${LB}`) && up.includes('--region ap-mumbai-1'), up);
  check('...under a new name (a load balancer certificate cannot be edited in place)',
    up.includes('--certificate-name LGM_IND_25New-202609'), up);
  check('switch names the listener and its port',
    /prd-indi4-listener \(port 443\)/.test(step(g, 'switch').title), step(g, 'switch').title);
  check('...points at the console, and warns what the CLI update loses',
    /Listeners → Edit → SSL certificate/.test(step(g, 'switch').console)
    && /restate/.test(step(g, 'switch').caution));
  check('delete names the OLD certificate and comes only after the switch',
    step(g, 'delete').command.includes('--certificate-name LGM_IND_25New')
    && ids(g).indexOf('delete') > ids(g).indexOf('switch'));

  const unused = credentialGuidance(ociLb({ in_use: false, in_use_by: [] }), NOW);
  eq('expired + unused -> just delete (no alert for something nothing uses)', ids(unused), ['delete']);
  eq('...and the headline is a warning, not an alarm', unused.headline.tone, 'warning');

  const unknown = credentialGuidance(ociLb({ in_use: null, in_use_by: [], details: {} }), NOW);
  eq('expired + usage UNKNOWN -> find out first', ids(unknown)[0], 'find-use');
  check('...and never deletes before a replacement is in place',
    ids(unknown).indexOf('delete') > ids(unknown).indexOf('switch'), ids(unknown).join(','));
  eq('...headline stays danger: unknown use is not "unused"', unknown.headline.tone, 'danger');

  const backend = credentialGuidance(ociLb({
    in_use_by: ['Listener a (port 443)', 'Backend set ebs (TLS to backends)'],
  }), NOW);
  check('two users -> both named in the switch step',
    /listener a \(port 443\)/.test(step(backend, 'switch').body)
    && /backend set ebs/.test(step(backend, 'switch').body), step(backend, 'switch').body);

  const valid = credentialGuidance(ociLb({
    name: 'KOEL_WC_2026', bucket: 'within_90', days_left: 74.4, expires_at: '2026-12-12T00:00:00+00:00',
  }), NOW);
  eq('valid + in use -> only the expiry alert', ids(valid), ['alert']);
  check('...headline says how long it is valid, with no reassurance',
    /Valid for 74 more days/.test(valid.headline.text), valid.headline.text);
  const spare = credentialGuidance(ociLb({
    bucket: 'within_90', days_left: 74, in_use: false, in_use_by: [],
  }), NOW);
  check('valid + unused -> deletion offered, but as a possible staged renewal',
    ids(spare).join() === 'delete' && /renewal waiting/.test(spare.steps[0].title));
}

console.log('\n2. AWS');
{
  const arn = 'arn:aws:acm:ap-south-1:381491836000:certificate/1234-abcd';
  const acm = (over) => ({
    source: 'aws:acm', kind: 'CERTIFICATE', object_key: arn, name: 'shop.example.com',
    region: 'ap-south-1', dns_names: ['shop.example.com', 'www.shop.example.com'],
    in_use: true, in_use_by: ['arn:aws:elasticloadbalancing:ap-south-1:1:loadbalancer/app/web/1'],
    bucket: 'within_30', days_left: 12, expires_at: '2026-10-11T00:00:00Z', ...over,
  });
  const imp = credentialGuidance(acm({ details: { type: 'IMPORTED' }, managed_renewal: false }), NOW);
  check('an imported ACM certificate is re-imported into the SAME ARN',
    step(imp, 'reimport').command.includes(`--certificate-arn ${arn}`)
    && step(imp, 'reimport').command.startsWith('aws acm import-certificate'));
  const issuedExpired = credentialGuidance(acm({
    details: { type: 'AMAZON_ISSUED' }, managed_renewal: true, bucket: 'expired', days_left: -3,
  }), NOW);
  const req = step(issuedExpired, 'request').command;
  check('an expired ACM-issued certificate is re-requested for the same names',
    req.includes('--domain-name shop.example.com')
    && req.includes('--subject-alternative-names www.shop.example.com')
    && !/--subject-alternative-names .*shop\.example\.com shop/.test(req), req);
  const renewing = credentialGuidance(acm({
    details: { type: 'AMAZON_ISSUED' }, managed_renewal: true, renewal_status: 'PENDING_VALIDATION',
  }), NOW);
  check('a stuck renewal is explained and checkable',
    /PENDING_VALIDATION/.test(step(renewing, 'renewal').body)
    && step(renewing, 'renewal').command.includes('RenewalSummary'));
  check('...and the headline says it should have renewed itself', /renew automatically/.test(renewing.headline.text));
  eq('expired + unused ACM -> delete only',
    ids(credentialGuidance(acm({ details: { type: 'IMPORTED' }, bucket: 'expired', in_use: false, in_use_by: [] }), NOW)),
    ['delete']);

  const iam = credentialGuidance({
    source: 'aws:iam-server-certificates', kind: 'CERTIFICATE', name: 'old web cert',
    object_key: 'arn:aws:iam::1:server-certificate/old', region: 'global', bucket: 'expired',
    days_left: -30, expires_at: '2026-08-30T00:00:00Z', managed_renewal: false, in_use: null,
  }, NOW);
  check('an IAM server certificate: upload under a new (quoted) name, then delete the old one',
    step(iam, 'upload').command.includes("--server-certificate-name 'old web cert-202609'")
    && step(iam, 'delete').command.includes("--server-certificate-name 'old web cert'"),
    step(iam, 'upload').command);
  check('...no --region on a global IAM command', !/--region/.test(step(iam, 'upload').command));

  const secretArn = 'arn:aws:secretsmanager:ap-south-1:1:secret:db-AbCd';
  const sm = (over) => ({
    source: 'aws:secretsmanager', kind: 'SECRET', object_key: secretArn, name: 'db',
    region: 'ap-south-1', bucket: 'no_expiry', expires_at: null, details: {}, ...over,
  });
  check('rotation off -> rotate-secret on the real ARN',
    step(credentialGuidance(sm({ rotation_enabled: false }), NOW), 'rotation').command
      .includes(`--secret-id ${secretArn}`));
  eq('a service-owned secret -> rotate it through that service, nothing else',
    ids(credentialGuidance(sm({ details: { owning_service: 'rds' } }), NOW)), ['owner']);
  eq('rotation on but overdue -> check the rotation function',
    ids(credentialGuidance(sm({ rotation_enabled: true, next_rotation_at: '2026-09-01T00:00:00Z' }), NOW)),
    ['overdue']);
  eq('rotation on and on time -> nothing to do',
    ids(credentialGuidance(sm({ rotation_enabled: true, next_rotation_at: '2026-10-20T00:00:00Z' }), NOW)), []);
}

console.log('\n3. Azure');
{
  const rgId = '/subscriptions/s1/resourcegroups/RG-Web/providers/microsoft.web/certificates/tor-26';
  const app = (over) => ({
    source: 'azure:app-service-certificates', kind: 'CERTIFICATE', object_key: rgId,
    name: 'toriotcom-26', region: 'Central India', bucket: 'expired', days_left: -60,
    expires_at: '2026-07-30T00:00:00Z', managed_renewal: null, in_use: true,
    in_use_by: ['tor-api: api.tor-iot.com', 'tor-api/staging: staging.tor-iot.com'],
    details: { thumbprint: 'AB12CD', resource_group: 'RG-Web' }, ...over,
  });
  const bound = credentialGuidance(app(), NOW);
  eq('expired + bound -> upload, rebind, delete, stop renewing by hand, alert', ids(bound),
    ['upload', 'bind', 'delete', 'managed-cert', 'alert']);
  check('upload goes through one of the bound apps, in its resource group',
    step(bound, 'upload').command.includes('--resource-group RG-Web --name tor-api'));
  const bind = step(bound, 'bind').command;
  check('one bind per app, the slot passed as --slot',
    bind.includes('--name tor-api --certificate-thumbprint') && bind.includes('--name tor-api --slot staging'), bind);
  check('delete removes the OLD thumbprint', step(bound, 'delete').command.includes('--certificate-thumbprint AB12CD'));
  eq('expired + unbound -> delete only',
    ids(credentialGuidance(app({ in_use: false, in_use_by: [] }), NOW)), ['delete']);
  const unknownApp = credentialGuidance(app({ in_use: null, in_use_by: [] }), NOW);
  check('usage unknown -> a query for the thumbprint comes first',
    ids(unknownApp)[0] === 'find-use' && step(unknownApp, 'find-use').command.includes("thumbprint=='AB12CD'"));
  eq('a managed certificate that did not renew -> check the domain',
    ids(credentialGuidance(app({ managed_renewal: true, bucket: 'within_7', days_left: 3 }), NOW)), ['managed']);

  const vault = '/subscriptions/s1/resourcegroups/rg-kv/providers/microsoft.keyvault/vaults/kv-prod';
  const kv = (over) => ({
    kind: 'SECRET', source: 'azure:keyvault:secrets', name: 'db-password', container_name: 'kv-prod',
    container_key: vault, object_key: 'https://kv-prod.vault.azure.net/secrets/db-password',
    bucket: 'no_expiry', expires_at: null, ...over,
  });
  check('a Key Vault secret with no expiry gets one, 90 days out',
    step(credentialGuidance(kv(), NOW), 'expiry').command
      === 'az keyvault secret set-attributes --vault-name kv-prod --name db-password --expires 2026-12-28T06:00:00Z');
  check('a Key Vault key gets a rotation policy',
    step(credentialGuidance(kv({ kind: 'KEY', source: 'azure:keyvault:keys' }), NOW), 'rotation-policy')
      .command.startsWith('az keyvault key rotation-policy update --vault-name kv-prod'));
  const kvCert = credentialGuidance(kv({
    kind: 'CERTIFICATE', source: 'azure:keyvault:certificates', bucket: 'within_30', days_left: 20,
    expires_at: '2026-10-19T00:00:00Z', managed_renewal: null,
  }), NOW);
  check('a Key Vault certificate: import a new version, and turn on auto-renew',
    ids(kvCert).includes('import') && ids(kvCert).includes('auto-renew'));
  eq('Key Vault items link to their vault in the portal',
    portalLink(kv()), `https://portal.azure.com/#resource${vault}`);

  const gw = credentialGuidance({
    source: 'azure:application-gateway', kind: 'CERTIFICATE', name: 'wildcard',
    object_key: '/subscriptions/s1/resourcegroups/rg-net/providers/microsoft.network/applicationgateways/agw1/sslcertificates/wildcard',
    container_name: 'agw1', container_key: '/subscriptions/s1/resourcegroups/rg-net/providers/microsoft.network/applicationgateways/agw1',
    bucket: 'within_7', days_left: 5, expires_at: '2026-10-04T00:00:00Z', in_use: true, in_use_by: [],
  }, NOW);
  check('an App Gateway certificate is replaced in place (listeners untouched)',
    step(gw, 'update').command.includes('--resource-group rg-net --gateway-name agw1 --name wildcard'));
}

console.log('\n4. Rules that hold for every store and state');
{
  const variants = [];
  const sources = GUIDED_SOURCES;
  for (const source of sources) {
    for (const bucket of ['expired', 'within_7', 'within_30', 'within_90', 'later', 'no_expiry']) {
      for (const inUse of [true, false, null]) {
        const kind = /secret/.test(source) ? 'SECRET' : /keys$/.test(source) ? 'KEY' : 'CERTIFICATE';
        variants.push({
          source, kind, bucket, in_use: inUse, in_use_by: inUse ? ['Listener l (port 443)'] : [],
          name: 'thing', object_key: 'ocid1.thing.oc1..x', container_key: '/subscriptions/s/resourcegroups/rg/x',
          container_name: 'box', region: 'r1', days_left: bucket === 'expired' ? -5 : 10,
          expires_at: bucket === 'no_expiry' ? null : '2026-10-09T00:00:00Z',
          details: { thumbprint: 'T1', resource_group: 'rg', type: 'IMPORTED' },
        });
      }
    }
  }
  const all = variants.map((o) => [o, credentialGuidance(o, NOW)]);
  check(`${all.length} store × expiry × use combinations produce guidance without throwing`,
    all.every(([, g]) => g && g.headline && Array.isArray(g.steps)));
  const words = all.flatMap(([, g]) => [g.headline.text, ...g.steps.flatMap((s) => [s.title, s.body, s.caution])])
    .filter(Boolean).join(' ');
  check('nothing calls an action "safe", or an item "secure" or "compliant"',
    !/\bsafe\b|\bsecure\b|\bcompliant\b/i.test(words));
  const unknownFirstDelete = all.filter(([o, g]) => o.in_use === null && g.steps[0]?.id === 'delete');
  check('usage unknown: the first step is NEVER a deletion', unknownFirstDelete.length === 0,
    unknownFirstDelete.map(([o]) => `${o.source}/${o.bucket}`).join(', '));
  const expiredUnknownCalm = all.filter(([o, g]) => o.in_use === null && o.bucket === 'expired'
    && g.headline.tone !== 'danger');
  check('expired with unknown use is always a danger headline', expiredUnknownCalm.length === 0);
  const numbered = all.every(([, g]) => g.steps.every((s, i) => s.n === i + 1));
  check('steps are numbered in order', numbered);
  const noPlaceholderIds = all.flatMap(([, g]) => g.steps).filter((s) => s.command)
    .every((s) => !/<(load-balancer|certificate-arn|secret-id|vault)[^>]*>/.test(s.command));
  check('identifiers are never placeholders — only files and passwords are', noPlaceholderIds);
  eq('a disabled item gets no steps', credentialGuidance({ ...variants[0], enabled: false }, NOW).steps, []);
}

console.log('\n5. Helpers');
{
  eq('an OCID is left bare', shellQuote(LB), LB);
  eq('an ARN is left bare', shellQuote('arn:aws:acm:r:1:certificate/x'), 'arn:aws:acm:r:1:certificate/x');
  eq('a name with a space is quoted', shellQuote('my cert'), "'my cert'");
  eq("a single quote is escaped the POSIX way", shellQuote("it's"), "'it'\\''s'");
  eq('resource group from an ARM id, any case',
    resourceGroupOf('/subscriptions/s/resourceGroups/My-RG/providers/x'), 'My-RG');
  eq('no resource group in a non-ARM id', resourceGroupOf('ocid1.x'), null);
  eq('no portal link for OCI', portalLink(ociLb()), null);
  eq('an unknown store gets no steps but still a headline',
    credentialGuidance({ source: 'gcp:whatever', kind: 'CERTIFICATE', bucket: 'expired', days_left: -1 }, NOW).guided,
    false);
  const u = usageExplanation(ociLb({ in_use: null, in_use_by: [] }));
  check('unknown use explains why, and how to find out', !u.known && /Refresh all/.test(u.text), u.text);
  eq('lifecycle reads no_expiry for a secret with no date', lifecycleOf({ bucket: 'no_expiry' }).noExpiry, true);
}

console.log('\n5b. Renewed under a new name (the Azure TOR toriotcom-26 -> toriotcom-27 case)');
{
  const RENEWAL = {
    object_key: '/subscriptions/s/resourcegroups/tor-rg/providers/microsoft.web/certificates/toriotcom-27',
    name: 'toriotcom-27', expires_at: '2027-01-23T00:00:00+00:00',
    source: 'azure:app-service-certificates', source_label: 'App Service certificates',
    container_name: 'App Service', region: 'centralindia', in_use: true, same_holder: true,
  };
  const az = (over = {}) => ({
    id: 'a1', account_id: 'acc-az', provider: 'AZURE', kind: 'CERTIFICATE',
    source: 'azure:app-service-certificates', source_label: 'App Service certificates',
    object_key: '/subscriptions/s/resourcegroups/tor-rg/providers/microsoft.web/certificates/toriotcom-26',
    name: 'toriotcom-26', container_name: 'App Service', region: 'centralindia',
    expires_at: '2026-07-31T00:00:00+00:00', days_left: -67, bucket: 'replaced',
    in_use: false, in_use_by: [], superseded_by: RENEWAL,
    details: { resource_group: 'tor-rg', thumbprint: 'AB12' }, ...over,
  });
  const g = credentialGuidance(az(), NOW);
  check('replaced + unused -> an info headline naming the renewal, not a danger one',
    g.headline.tone === 'info' && /toriotcom-27/.test(g.headline.text), g.headline.text);
  check('...and the only step is deleting it', ids(g).length === 1 && /delete/.test(ids(g)[0]),
    JSON.stringify(ids(g)));
  eq('a replaced, expired row still reads as expired for the store steps',
    lifecycleOf(az()).expired, true);

  const busy = credentialGuidance(az({ bucket: 'expired', in_use: true,
    in_use_by: ['tor-api: api.tor-iot.com'] }), NOW);
  check('renewed but STILL BOUND -> danger headline that says switch the binding',
    busy.headline.tone === 'danger' && /Switch the binding/.test(busy.headline.text),
    busy.headline.text);
  eq('...first step says the renewal already exists', ids(busy)[0], 'renewal-exists');
  check('...and no step uploads or imports another renewal',
    !ids(busy).some((x) => ['upload', 'import', 'reimport', 'request', 'new-version',
      'import-version'].includes(x)), JSON.stringify(ids(busy)));

  const elsewhere = credentialGuidance(az({ bucket: 'expired', in_use: true,
    in_use_by: ['tor-api: api.tor-iot.com'],
    superseded_by: { ...RENEWAL, same_holder: false, usable_in_place: false } }), NOW);
  check('renewal held in ANOTHER resource group -> the upload/import steps are kept',
    ids(elsewhere)[0] === 'renewal-exists' && ids(elsewhere).length > 2
      && /cannot be bound here/.test(elsewhere.steps[0].body), JSON.stringify(ids(elsewhere)));
  check('...and the headline says upload it here, not just switch',
    /upload it here/.test(elsewhere.headline.text), elsewhere.headline.text);

  const unknown = credentialGuidance(az({ bucket: 'expired', in_use: null }), NOW);
  check('renewed, use unknown -> never leads with a deletion',
    unknown.steps[0]?.id !== 'delete' && unknown.headline.tone === 'danger',
    JSON.stringify(ids(unknown)));
}

console.log('\n6. Parity: every store the backend collects has guidance');
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.resolve(__dirname,
    '../../Backend/cloud/app/security/credentials.py'), 'utf8');
  const block = (src.match(/SOURCE_LABEL = \{([\s\S]*?)\n\}/) || [, ''])[1];
  const sources = [...block.matchAll(/"([a-z]+:[a-z:-]+)":/g)].map((m) => m[1]);
  check('the backend SOURCE_LABEL parsed', sources.length >= 10, sources.join(', '));
  // The vault LISTING holds no objects of its own — its contents are the
  // keyvault:certificates / secrets / keys stores.
  const collected = sources.filter((s) => s !== 'azure:keyvault-vaults');
  const missing = collected.filter((s) => !GUIDED_SOURCES.includes(s));
  check('no collected store is without guidance', missing.length === 0, missing.join(', '));
  const stale = GUIDED_SOURCES.filter((s) => !sources.includes(s));
  check('no guidance for a store the backend does not have', stale.length === 0, stale.join(', '));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
