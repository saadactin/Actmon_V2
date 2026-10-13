/**
 * What to do about one certificate, secret or key — the "what can I do" half
 * of the inventory drawer.
 *
 * Pure: `credentialGuidance(object, now)` turns one inventory row (the shape
 * /cloud/certificates returns) into a headline, an explanation of what is
 * known about its use, and ordered steps. Every command is filled in with the
 * object's REAL identifiers — load balancer OCID, ARN, vault, resource group,
 * thumbprint — so it can be copied as it stands; the only placeholders are the
 * files and passwords that only the operator has (renewed.pfx, <pfx-password>).
 *
 * Two rules, pinned by tests/verify_credential_guidance.mjs:
 *
 * * **Unknown use is not "unused".** Nothing here suggests deleting an object
 *   whose use could not be determined until the steps have said how to find
 *   out, and the headline for an expired certificate of unknown use is as
 *   urgent as one known to be in use.
 * * **Nothing here is reassurance.** No step calls an action "safe", and no
 *   headline says the object is fine — it says how long it is valid for.
 */

// ── Small helpers ───────────────────────────────────────────────────────────

/** Shell-quote a value only when it needs it. OCIDs, ARNs and most names are
 *  left bare, so the common command reads the way a person would type it. */
export function shellQuote(value) {
  const s = String(value ?? '');
  if (/^[A-Za-z0-9._:/@=+,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function whole(days) {
  if (days === null || days === undefined || Number.isNaN(Number(days))) return null;
  return Math.floor(Math.abs(Number(days)));
}

/** "/subscriptions/x/resourceGroups/RG/providers/..." -> "RG" */
export function resourceGroupOf(armId) {
  const parts = String(armId || '').split('/');
  const i = parts.findIndex((p) => p.toLowerCase() === 'resourcegroups');
  return i >= 0 && parts[i + 1] ? parts[i + 1] : null;
}

/** "Listener prd-listener (port 443)" -> {kind:'listener', name, port} */
function parseLbUse(entry) {
  let m = /^Listener (.+) \(port (\S+)\)$/.exec(entry || '');
  if (m) return { kind: 'listener', name: m[1], port: m[2] };
  m = /^Backend set (.+) \(TLS to backends\)$/.exec(entry || '');
  if (m) return { kind: 'backend', name: m[1] };
  return { kind: 'other', name: entry };
}

/** "tor-api/staging: staging.example.com" -> {app:'tor-api', slot:'staging', host} */
function parseAppBinding(entry) {
  const m = /^(.+?): (.+)$/.exec(entry || '');
  if (!m) return null;
  const [app, slot] = m[1].split('/');
  return { app, slot: slot || null, host: m[2] };
}

const stamp = (now) => `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

function plusDaysIso(now, days) {
  const d = new Date(now.getTime() + days * 86400000);
  return `${d.toISOString().slice(0, 19)}Z`;
}

// ── State ───────────────────────────────────────────────────────────────────

export function lifecycleOf(o) {
  const bucket = o?.bucket;
  // A replaced certificate keeps its real expiry state for the store steps
  // (an expired leftover is still deleted the same way).
  const replaced = bucket === 'replaced';
  const left = Number(o?.days_left);
  return {
    disabled: o?.enabled === false,
    replaced,
    superseded: !!o?.superseded_by,
    expired: bucket === 'expired' || (replaced && left < 0),
    urgent: bucket === 'within_7',
    soon: bucket === 'within_7' || bucket === 'within_30'
      || (replaced && left >= 0 && left <= 30),
    noExpiry: bucket === 'no_expiry' || (!o?.expires_at && bucket !== 'expired'),
    use: o?.in_use === true ? 'in_use' : o?.in_use === false ? 'unused' : 'unknown',
    renews: o?.managed_renewal === true,
    days: whole(o?.days_left),
  };
}

/** What Actmon knows about whether anything uses the object, in words. */
export function usageExplanation(o) {
  const s = lifecycleOf(o);
  const uses = o?.in_use_by || [];
  const source = o?.source;
  if (s.use === 'in_use') {
    return {
      known: true,
      text: uses.length
        ? `In use by ${plural(uses.length, 'binding')}.`
        : 'In use — the provider did not say by what.',
      items: uses,
    };
  }
  if (s.use === 'unused') {
    const why = {
      'oci:load-balancer-certificates': `No listener or backend set on ${o.container_name || 'its load balancer'} references it (read from the load balancer when this was collected).`,
      'azure:app-service-certificates': `No web app or deployment slot in resource group ${o.details?.resource_group || resourceGroupOf(o.object_key) || '?'} binds it — the only apps that can.`,
      'azure:application-gateway': `No listener on ${o.container_name || 'its gateway'} uses it.`,
      'aws:acm': 'ACM reports no AWS resource associated with it.',
    }[source];
    return { known: true, text: why || 'Not in use.', items: [] };
  }
  const why = {
    'oci:load-balancer-certificates': 'The load balancer\'s listeners could not be read when this was collected. Refresh all reads them again.',
    'azure:app-service-certificates': 'The web apps in its resource group could not be read, so its bindings are unknown.',
    'azure:keyvault:certificates': 'Key Vault does not record what references a certificate — check the App Gateways, App Service apps and other services that read this vault.',
    'azure:keyvault:secrets': 'Key Vault does not record who reads a secret.',
    'azure:keyvault:keys': 'Key Vault does not record who uses a key.',
    'aws:iam-server-certificates': 'IAM does not record which load balancer serves a server certificate — check the listeners of your Classic / Application load balancers.',
    'aws:secretsmanager': o?.details?.last_accessed
      ? `Secrets Manager records when a secret was last read (${o.details.last_accessed.slice(0, 10)}), not by whom.`
      : 'Secrets Manager does not record who reads a secret.',
    'oci:certificates': 'OCI Certificates does not report which resources reference a certificate.',
    'oci:vault-secrets': 'OCI Vault does not record who reads a secret.',
  }[source];
  return { known: false, text: why || 'Whether anything uses it is not known.', items: [] };
}

function headline(o, s) {
  const noun = { CERTIFICATE: 'certificate', SECRET: 'secret', KEY: 'key' }[o?.kind] || 'item';
  if (s.disabled) {
    return { tone: 'neutral', text: `Disabled — this ${noun} is not served or returned while disabled.` };
  }
  if (s.superseded) {
    const n = o.superseded_by;
    const until = n.expires_at ? String(n.expires_at).slice(0, 10) : 'a later date';
    const state = s.expired ? 'Expired' : 'Expiring';
    if (s.use === 'unused') {
      return {
        tone: 'info',
        text: `Replaced by the renewal ${n.name} (valid until ${until}), and nothing uses this one. It is a leftover — delete it to tidy up.`,
      };
    }
    if (s.use === 'in_use') {
      return {
        tone: s.expired ? 'danger' : 'warning',
        text: n.usable_in_place === false
          ? `${state} and still in use. A renewal, ${n.name} (valid until ${until}), exists elsewhere — upload it here and switch the binding to it.`
          : `${state} and still in use — but it has already been renewed as ${n.name} (valid until ${until}). Switch the binding to the renewal, then delete this one.`,
      };
    }
    return {
      tone: s.expired ? 'danger' : 'warning',
      text: `${state}. It has been renewed as ${n.name} (valid until ${until}), but whether anything still uses this one is unknown — find out before you remove it.`,
    };
  }
  if (s.expired) {
    const ago = s.days === null ? '' : s.days < 1 ? ' today' : ` ${plural(s.days, 'day')} ago`;
    if (s.use === 'in_use') {
      return {
        tone: 'danger',
        text: `Expired${ago} and still in use. Anything that validates it gets a certificate error — replace it now.`,
      };
    }
    if (s.use === 'unused') {
      return {
        tone: 'warning',
        text: `Expired${ago}, and nothing Actmon can see uses it. Remove it once you have confirmed nothing outside this account depends on it.`,
      };
    }
    return {
      tone: 'danger',
      text: `Expired${ago}. Whether anything still uses it is unknown — find out before you remove it.`,
    };
  }
  if (s.soon) {
    const when = s.days === null ? 'soon' : s.days < 1 ? 'today' : `in ${plural(s.days, 'day')}`;
    if (s.renews) {
      return {
        tone: 'warning',
        text: `Expires ${when}. It is set to renew automatically, but has not renewed yet — check why.`,
      };
    }
    return {
      tone: s.urgent ? 'danger' : 'warning',
      text: `Expires ${when} and nothing renews it. ${s.urgent ? 'Renew it now.' : 'Plan the renewal.'}`,
    };
  }
  if (s.noExpiry) {
    if (o?.rotation_enabled === true) {
      return {
        tone: 'info',
        text: `Rotated automatically${o.rotation_interval_days ? ` every ${plural(o.rotation_interval_days, 'day')}` : ''}.`,
      };
    }
    return { tone: 'warning', text: `No expiry date is set, so nothing forces this ${noun} to be replaced.` };
  }
  return {
    tone: 'info',
    text: `Valid for ${s.days === null ? 'a while' : plural(s.days, 'more day')}${s.renews ? ', and set to renew automatically' : ''}.`,
  };
}

// ── Steps per store ─────────────────────────────────────────────────────────

function ociLoadBalancer(o, s, now) {
  const lb = o.container_key;
  const region = o.region;
  const steps = [];
  const uses = (o.in_use_by || []).map(parseLbUse);
  const listeners = uses.filter((u) => u.kind === 'listener');
  const backends = uses.filter((u) => u.kind === 'backend');
  const deleteStep = {
    id: 'delete',
    title: s.use === 'unused' ? 'Delete it' : 'Delete the old certificate once nothing uses it',
    body: s.use === 'unused'
      ? `No listener or backend set on ${o.container_name} references it.`
      : 'Only after every listener and backend set above has been switched to the renewal.',
    command: `oci lb certificate delete --load-balancer-id ${lb} --certificate-name ${shellQuote(o.name)} --region ${region}`,
  };
  const findOut = {
    id: 'find-use',
    title: 'Find out what uses it',
    body: 'Refresh all reads the load balancer\'s listeners and records which certificate each serves. To look yourself:',
    command: `oci lb load-balancer get --load-balancer-id ${lb} --region ${region} --query 'data.listeners'`,
    console: `OCI Console → Networking → Load balancers → ${o.container_name} → Listeners`,
  };

  if (s.expired && s.use === 'unused') return [deleteStep];
  if (s.use === 'unused') {
    return [{
      ...deleteStep,
      title: 'Nothing uses it — delete it if it is not a renewal waiting to be switched in',
    }];
  }
  if (s.use === 'unknown' && (s.expired || s.soon)) steps.push(findOut);
  if (s.expired || s.soon || s.use === 'unknown') {
    steps.push({
      id: 'upload',
      title: `Upload the renewed certificate to ${o.container_name}`,
      body: 'A load balancer certificate cannot be edited in place, so the renewal goes in under a new name. The certificate, private key and CA chain files are yours to supply.',
      command: `oci lb certificate create --load-balancer-id ${lb} --certificate-name ${shellQuote(`${o.name}-${stamp(now)}`)} --public-certificate-file cert.pem --private-key-file key.pem --ca-certificate-file ca-chain.pem --region ${region}`,
    });
    const targets = [
      ...listeners.map((l) => `listener ${l.name} (port ${l.port})`),
      ...backends.map((b) => `backend set ${b.name}`),
    ];
    steps.push({
      id: 'switch',
      title: targets.length ? `Switch ${targets.length === 1 ? targets[0] : `these ${targets.length}`} to the renewal` : 'Switch every listener that uses it to the renewal',
      body: targets.length > 1 ? targets.join(' · ') : null,
      console: `OCI Console → Networking → Load balancers → ${o.container_name} → ${backends.length && !listeners.length ? 'Backend sets' : 'Listeners'} → Edit → SSL certificate`,
      caution: 'Use the console\'s Edit: it keeps the listener\'s other settings. `oci lb listener update` must restate its backend set, port and protocol, and anything omitted is lost.',
    });
    steps.push(deleteStep);
  }
  return steps;
}

function ociCertificates(o, s) {
  const imported = o.details?.config_type === 'IMPORTED';
  const steps = [];
  if (imported && (s.expired || s.soon)) {
    steps.push({
      id: 'import-version',
      title: 'Import the renewed certificate as a new version',
      body: 'Resources that reference this certificate by its OCID — a load balancer listener, say — use the new version with no other change.',
      command: `oci certs-mgmt certificate update-certificate-by-importing-config-details --certificate-id ${o.object_key} --certificate-pem file://cert.pem --private-key-pem file://key.pem --cert-chain-pem file://ca-chain.pem --region ${o.region}`,
    });
  } else if (!imported && !s.renews) {
    steps.push({
      id: 'renewal-rule',
      title: 'Add a renewal rule',
      body: 'Certificates issued by an OCI certificate authority renew themselves only with a renewal rule.',
      console: `OCI Console → Identity & Security → Certificates → ${o.name} → Edit → Renewal rules`,
    });
  } else if (s.renews && (s.soon || s.expired)) {
    steps.push({
      id: 'check-renewal',
      title: 'Check why it has not renewed',
      console: `OCI Console → Identity & Security → Certificates → ${o.name} → Versions`,
    });
  }
  return steps;
}

function ociVaultSecret(o, s) {
  const steps = [];
  if (s.noExpiry || s.expired) {
    steps.push({
      id: 'expiry-rule',
      title: s.expired ? 'Create a new version, and keep an expiry rule on it' : 'Add an expiry rule',
      body: 'An expiry rule makes each secret version expire after the interval (90 days here), so a stale secret is caught.',
      command: `oci vault secret update-base64 --secret-id ${o.object_key} --secret-rules '[{"ruleType": "SECRET_EXPIRY_RULE", "secretVersionExpiryInterval": "P90D", "isSecretContentRetrievalBlockedOnExpiry": false}]' --region ${o.region}`,
    });
  }
  if (o.rotation_enabled !== true) {
    steps.push({
      id: 'rotation',
      title: 'Turn on automatic rotation where the target supports it',
      console: `OCI Console → Identity & Security → Vault → Secrets → ${o.name} → Edit → Rotation`,
    });
  }
  return steps;
}

function awsAcm(o, s) {
  const arn = o.object_key;
  const region = o.region;
  const type = o.details?.type;
  const steps = [];
  if (s.expired && s.use === 'unused') {
    return [{
      id: 'delete',
      title: 'Delete it',
      body: 'ACM reports nothing using it, and ACM refuses to delete a certificate that is in use.',
      command: `aws acm delete-certificate --certificate-arn ${arn} --region ${region}`,
    }];
  }
  if (type === 'IMPORTED') {
    if (s.expired || s.soon || s.use === 'unknown') {
      steps.push({
        id: 'reimport',
        title: 'Re-import the renewed certificate into the same ARN',
        body: 'Everything using this certificate picks up the renewal with no other change — no listener or distribution needs editing.',
        command: `aws acm import-certificate --certificate-arn ${arn} --certificate fileb://cert.pem --private-key fileb://key.pem --certificate-chain fileb://ca-chain.pem --region ${region}`,
      });
    }
    steps.push({
      id: 'acm-issued',
      title: 'Or move it to an ACM-issued certificate',
      body: 'Public certificates issued by ACM are free and renew automatically while their DNS validation records stay in place.',
    });
    return steps;
  }
  if (s.expired) {
    const domain = o.name;
    const sans = (o.dns_names || []).filter((d) => d && d !== domain);
    steps.push({
      id: 'request',
      title: 'Request a replacement',
      body: 'An expired ACM-issued certificate cannot be renewed. Request a new one for the same names, then point everything that used the old one at the new ARN.',
      command: `aws acm request-certificate --domain-name ${shellQuote(domain)}${sans.length ? ` --subject-alternative-names ${sans.map(shellQuote).join(' ')}` : ''} --validation-method DNS --region ${region}`,
    });
  } else if (s.soon || o.renewal_status) {
    steps.push({
      id: 'renewal',
      title: 'Check the automatic renewal',
      body: o.renewal_status
        ? `ACM reports the renewal as ${o.renewal_status}. PENDING_VALIDATION or FAILED means the DNS validation CNAME records ACM shows for each domain must be restored.`
        : 'ACM renews it while it is in use and its validation records are in place.',
      command: `aws acm describe-certificate --certificate-arn ${arn} --region ${region} --query Certificate.RenewalSummary`,
    });
  }
  return steps;
}

function awsIamServerCert(o, s, now) {
  const steps = [];
  if (s.expired || s.soon) {
    steps.push({
      id: 'upload',
      title: 'Upload the renewal under a new name',
      body: 'IAM server certificates are never renewed and cannot be managed in the AWS console — only with the CLI or API.',
      command: `aws iam upload-server-certificate --server-certificate-name ${shellQuote(`${o.name}-${stamp(now)}`)} --certificate-body file://cert.pem --private-key file://key.pem --certificate-chain file://ca-chain.pem`,
    });
    steps.push({
      id: 'switch',
      title: 'Point the load balancer listener at the new certificate\'s ARN',
      body: 'IAM does not record which listener uses a server certificate, so check each HTTPS listener.',
    });
    // Only after a replacement: IAM never says what uses a server
    // certificate, so deleting one on its own is a guess.
    steps.push({
      id: 'delete',
      title: 'Delete the old one once nothing uses it',
      command: `aws iam delete-server-certificate --server-certificate-name ${shellQuote(o.name)}`,
    });
  }
  steps.push({
    id: 'acm',
    title: 'Better: move it to ACM',
    body: 'Imported into ACM it can be re-imported in place; issued by ACM it renews itself.',
  });
  return steps;
}

function awsSecret(o, s, now) {
  const arn = o.object_key;
  const region = o.region;
  const owner = o.details?.owning_service;
  if (owner) {
    return [{
      id: 'owner',
      title: `Rotate it through ${owner}`,
      body: `This secret is managed by ${owner}, which runs its rotation — change the schedule there, not in Secrets Manager.`,
    }];
  }
  if (o.rotation_enabled !== true) {
    return [{
      id: 'rotation',
      title: 'Turn on rotation',
      body: 'Rotation needs a function that knows how to change the credential. The console can create one for RDS, Redshift and DocumentDB secrets.',
      command: `aws secretsmanager rotate-secret --secret-id ${arn} --rotation-lambda-arn <rotation-function-arn> --rotation-rules AutomaticallyAfterDays=30 --region ${region}`,
    }];
  }
  const next = o.next_rotation_at ? new Date(o.next_rotation_at) : null;
  if (next && next.getTime() < now.getTime()) {
    return [{
      id: 'overdue',
      title: 'Rotation is on but overdue — check the rotation function',
      body: 'A failed rotation leaves the old value in place. The function\'s CloudWatch logs say why.',
      command: `aws secretsmanager describe-secret --secret-id ${arn} --region ${region}`,
    }];
  }
  return [];
}

function azureKeyVault(o, s, now) {
  const vault = o.container_name;
  const name = shellQuote(o.name);
  if (o.kind === 'CERTIFICATE') {
    const steps = [];
    if (s.expired || s.soon) {
      steps.push({
        id: 'import',
        title: 'Import the renewal as a new version of the same certificate',
        body: 'App Gateways and App Service apps that reference the versionless ID pick up the new version on their own.',
        command: `az keyvault certificate import --vault-name ${vault} --name ${name} --file renewed.pfx --password <pfx-password>`,
      });
    }
    if (!s.renews) {
      steps.push({
        id: 'auto-renew',
        title: 'Turn on automatic renewal',
        body: 'Key Vault renews a certificate itself only when it was issued by an integrated CA (DigiCert, GlobalSign) or is self-signed; otherwise it can only e-mail the contacts.',
        console: `Azure portal → Key Vault ${vault} → Certificates → ${o.name} → Issuance Policy → Lifetime Action Type → Automatically renew at a given percentage lifetime`,
      });
    }
    return steps;
  }
  if (o.kind === 'SECRET') {
    const steps = [];
    if (s.expired) {
      steps.push({
        id: 'new-version',
        title: 'Store a new version',
        body: 'The expiry date has passed. Readers still get the value — nothing enforces it — but it is overdue for rotation.',
        command: `az keyvault secret set --vault-name ${vault} --name ${name} --file new-value.txt --expires ${plusDaysIso(now, 90)}`,
      });
    } else if (s.noExpiry) {
      steps.push({
        id: 'expiry',
        title: 'Set an expiry date',
        body: 'CIS asks for an expiry on every secret, so a forgotten one is caught. 90 days from today here:',
        command: `az keyvault secret set-attributes --vault-name ${vault} --name ${name} --expires ${plusDaysIso(now, 90)}`,
      });
    }
    return steps;
  }
  // KEY
  const steps = [{
    id: 'rotation-policy',
    title: 'Give it a rotation policy',
    body: 'Key Vault rotates the key on the schedule in the policy file, and can notify before expiry.',
    command: `az keyvault key rotation-policy update --vault-name ${vault} --name ${name} --value @rotation-policy.json`,
  }];
  if (s.noExpiry) {
    steps.push({
      id: 'expiry',
      title: 'Set an expiry date',
      command: `az keyvault key set-attributes --vault-name ${vault} --name ${name} --expires ${plusDaysIso(now, 365)}`,
    });
  }
  return steps;
}

function azureAppService(o, s) {
  const rg = o.details?.resource_group || resourceGroupOf(o.object_key) || '<resource-group>';
  const thumb = o.details?.thumbprint;
  const bindings = (o.in_use_by || []).map(parseAppBinding).filter(Boolean);
  const deleteStep = {
    id: 'delete',
    title: s.use === 'unused' ? 'Delete it' : 'Delete the old certificate once nothing is bound to it',
    command: thumb ? `az webapp config ssl delete --resource-group ${rg} --certificate-thumbprint ${thumb}` : null,
  };
  if (s.renews) {
    return s.soon || s.expired ? [{
      id: 'managed',
      title: 'Check why the managed certificate has not renewed',
      body: 'App Service renews managed certificates only while the custom domain still points at the app (its CNAME or A record) and the app is reachable.',
    }] : [];
  }
  if (s.expired && s.use === 'unused') return [deleteStep];
  if (s.use === 'unused' && deleteStep.command) {
    return [{ ...deleteStep, title: 'Nothing is bound to it — delete it if it is not a renewal waiting to be bound' }];
  }
  const steps = [];
  if (s.use === 'unknown' && thumb) {
    steps.push({
      id: 'find-use',
      title: 'Find out what is bound to it',
      body: 'Refresh all reads every app and slot in the resource group. To look yourself (production slots):',
      command: `az webapp list --resource-group ${rg} --query "[].{app: name, hosts: hostNameSslStates[?thumbprint=='${thumb}'].name}"`,
    });
  }
  if (s.expired || s.soon || s.use === 'unknown') {
    const firstApp = bindings[0]?.app || '<app-name>';
    steps.push({
      id: 'upload',
      title: 'Upload the renewed certificate',
      body: 'It is uploaded through one app but lands in the resource group\'s shared store, so every app there can bind it.',
      command: `az webapp config ssl upload --resource-group ${rg} --name ${firstApp} --certificate-file renewed.pfx --certificate-password <pfx-password>`,
    });
    const binds = bindings.length ? bindings : [{ app: '<app-name>', slot: null, host: null }];
    steps.push({
      id: 'bind',
      title: bindings.length ? `Rebind ${plural(bindings.length, 'hostname')} to the new thumbprint` : 'Bind the new certificate where the old one was used',
      body: bindings.length ? bindings.map((b) => `${b.app}${b.slot ? ` (slot ${b.slot})` : ''}: ${b.host}`).join(' · ') : null,
      command: [...new Set(binds.map((b) => `az webapp config ssl bind --resource-group ${rg} --name ${b.app}${b.slot ? ` --slot ${b.slot}` : ''} --certificate-thumbprint <new-thumbprint> --ssl-type SNI`))].join('\n'),
    });
    if (deleteStep.command) steps.push(deleteStep);
  }
  steps.push({
    id: 'managed-cert',
    title: 'Stop renewing by hand',
    body: 'A free App Service Managed Certificate renews itself for a custom domain; or keep the certificate in Key Vault and import it from there — App Service picks up new versions within a day.',
  });
  return steps;
}

function azureAppGateway(o, s) {
  const rg = resourceGroupOf(o.container_key || o.object_key) || '<resource-group>';
  const gw = o.container_name;
  const del = {
    id: 'delete',
    title: 'Delete it',
    body: `No listener on ${gw} uses it.`,
    command: `az network application-gateway ssl-cert delete --resource-group ${rg} --gateway-name ${gw} --name ${shellQuote(o.name)}`,
  };
  if (s.expired && s.use === 'unused') return [del];
  if (s.use === 'unused') {
    return [{ ...del, title: 'Nothing uses it — delete it if it is not a renewal waiting to be switched in' }];
  }
  const steps = [];
  if (s.expired || s.soon || s.use === 'unknown') {
    steps.push({
      id: 'update',
      title: 'Replace it in place',
      body: 'Listeners keep pointing at the same certificate name, so none of them needs editing.',
      command: `az network application-gateway ssl-cert update --resource-group ${rg} --gateway-name ${gw} --name ${shellQuote(o.name)} --cert-file renewed.pfx --cert-password <pfx-password>`,
    });
  }
  steps.push({
    id: 'key-vault',
    title: 'Stop renewing by hand',
    body: 'Reference a Key Vault secret instead (--key-vault-secret-id with the versionless ID) and the gateway picks up renewed versions itself.',
  });
  return steps;
}

const BUILDERS = {
  'oci:load-balancer-certificates': ociLoadBalancer,
  'oci:certificates': ociCertificates,
  'oci:vault-secrets': ociVaultSecret,
  'aws:acm': awsAcm,
  'aws:iam-server-certificates': awsIamServerCert,
  'aws:secretsmanager': awsSecret,
  'azure:keyvault:certificates': azureKeyVault,
  'azure:keyvault:secrets': azureKeyVault,
  'azure:keyvault:keys': azureKeyVault,
  'azure:app-service-certificates': azureAppService,
  'azure:application-gateway': azureAppGateway,
};

/** The stores guidance is written for — checked against the backend's
 *  SOURCE_LABEL (minus the vault listing, which holds no objects). */
export const GUIDED_SOURCES = Object.keys(BUILDERS);

/** A portal link, only where the link format is certain: Azure resources
 *  open by ARM id. Key Vault items are data-plane objects, so they link to
 *  their vault's resource page, which is an ARM id. */
export function portalLink(o) {
  const id = String(o?.source || '').startsWith('azure:keyvault:') ? o?.container_key
    : o?.source === 'azure:app-service-certificates' || o?.source === 'azure:application-gateway'
      ? o?.object_key : null;
  return id && id.startsWith('/subscriptions/') ? `https://portal.azure.com/#resource${id}` : null;
}

/** Steps that put a NEW renewal in place — dropped when one already exists. */
const RENEWAL_STEP_IDS = new Set([
  'upload', 'import', 'import-version', 'reimport', 'request', 'new-version',
]);

export function credentialGuidance(o, now = new Date()) {
  if (!o) return null;
  const s = lifecycleOf(o);
  const build = BUILDERS[o.source];
  let steps = s.disabled ? [] : (build ? build(o, s, now) : []);
  // Already renewed: uploading or requesting another renewal is the wrong
  // advice. What is left is moving the bindings over and deleting this one.
  if (s.superseded && s.use !== 'unused') {
    const n = o.superseded_by;
    const where = [n.container_name, n.source_label, n.region].filter(Boolean).join(', ');
    const until = String(n.expires_at || '').slice(0, 10);
    // A renewal on another load balancer / gateway / resource group / region
    // cannot be bound here: the upload steps still apply, with its files.
    steps = n.usable_in_place === false ? [{
      id: 'renewal-exists',
      title: `A renewal exists elsewhere: ${n.name}`,
      body: `${n.name}${where ? ` (${where})` : ''} covers the same domains and is valid until ${until}, but it is not held where this certificate is, so it cannot be bound here directly. Upload the same renewed certificate here, as below.`,
    }, ...steps] : [{
      id: 'renewal-exists',
      title: `The renewal is already uploaded: ${n.name}`,
      body: `${n.name}${where ? ` (${where})` : ''} covers the same domains and is valid until ${until}. Point every binding below at it instead of uploading another certificate.`,
    }, ...steps.filter((x) => !RENEWAL_STEP_IDS.has(x?.id))];
  }
  // Whatever else applies, a certificate that someone renews by hand can be
  // watched: the account's Alerts tab has a template for exactly this.
  if (!s.disabled && o.kind === 'CERTIFICATE' && o.expires_at && !s.renews
      && s.use !== 'unused') {
    steps.push({
      id: 'alert',
      title: 'Get warned before the next expiry',
      body: 'The account\'s Alerts tab has a "Certificate expiring" template: it fires 30 days ahead and again once a certificate has expired, and can e-mail.',
      action: 'alerts',
    });
  }
  return {
    headline: headline(o, s),
    usage: usageExplanation(o),
    steps: steps.filter(Boolean).map((step, i) => ({ ...step, n: i + 1 })),
    guided: !!build,
    portal: portalLink(o),
  };
}
