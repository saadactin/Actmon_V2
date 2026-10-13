import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Dialog from '@/components/ui/Dialog';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';
import Table, { EmptyState } from '@/components/ui/Table';
import { Field, Segmented } from '@/components/ui/Field';
import {
  useClientOptions, useDiscoverOrganization, useOnboardOrganization,
} from '../../hooks/useClients';
import {
  accountRoute, onboardOutcomeMeta, selectableMemberIds,
} from '../../utils/clientModel';
import { formatCount } from '../../utils/securityModel';

const PROVIDERS = [
  { id: 'AWS', label: 'AWS Organizations' },
  { id: 'Azure', label: 'Azure tenant' },
];

const ENVIRONMENTS = ['Production', 'Staging', 'Development'].map((e) => ({ id: e, label: e }));

const EMPTY_CREDS = {
  access_key_id: '', secret_access_key: '', session_token: '', region: 'us-east-1',
  role_name: 'OrganizationAccountAccessRole', external_id: '',
  tenant_id: '', client_id: '', client_secret: '', management_group_id: '',
};

/** Only the fields the chosen provider uses, blanks dropped, so an AWS key
 *  typed and then abandoned never travels with an Azure request. */
function credentialPayload(provider, creds) {
  const keys = provider === 'AWS'
    ? ['access_key_id', 'secret_access_key', 'session_token', 'region', 'role_name', 'external_id']
    : ['tenant_id', 'client_id', 'client_secret', 'management_group_id'];
  const out = { provider };
  for (const k of keys) {
    const v = (creds[k] || '').trim();
    if (v) out[k] = v;
  }
  return out;
}

const accessTone = (m) => {
  if (m.already_connected) return 'neutral';
  return m.access?.can_access ? 'success' : 'danger';
};
const accessLabel = (m) => {
  if (m.already_connected) return 'Already connected';
  return m.access?.can_access ? 'Can read' : 'No access';
};

/** Azure reports three capabilities per subscription; true / false / not probed. */
function Capability({ label, value }) {
  const tone = value === true ? 'success' : value === false ? 'danger' : 'neutral';
  const mark = value === true ? 'yes' : value === false ? 'no' : '?';
  return <Badge tone={tone} size="xs">{label}: {mark}</Badge>;
}

/**
 * Onboard a whole AWS organisation or Azure tenant in one pass.
 *
 * Listing stores nothing. Onboarding re-lists on the server (it never trusts
 * this dialog's copy of the members), then creates one ordinary account per
 * chosen member, each authenticated and committed on its own.
 */
export default function OnboardOrganizationDialog({ open, onClose, defaultClientId = null }) {
  const navigate = useNavigate();
  const [step, setStep] = useState('credentials');
  const [provider, setProvider] = useState('AWS');
  const [creds, setCreds] = useState(EMPTY_CREDS);
  const [selected, setSelected] = useState([]);
  const [clientId, setClientId] = useState(defaultClientId || '');
  const [prefix, setPrefix] = useState('');
  const [environment, setEnvironment] = useState('Production');
  const [startDiscovery, setStartDiscovery] = useState(false);

  const { data: clients } = useClientOptions();
  const discover = useDiscoverOrganization();
  const onboard = useOnboardOrganization();
  const listing = discover.data;
  const members = useMemo(() => listing?.members || [], [listing]);

  // Wipe everything — above all the credentials — whenever the dialog closes.
  useEffect(() => {
    if (!open) {
      setStep('credentials');
      setCreds(EMPTY_CREDS);
      setSelected([]);
      setPrefix('');
      setStartDiscovery(false);
      discover.reset();
      onboard.reset();
    } else {
      setClientId(defaultClientId || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultClientId]);

  const set = (key) => (e) => setCreds((c) => ({ ...c, [key]: e.target.value }));
  const busy = discover.isPending || onboard.isPending;

  const runDiscover = async () => {
    try {
      const out = await discover.mutateAsync(credentialPayload(provider, creds));
      setSelected(selectableMemberIds(out.members));
      setStep('members');
    } catch {
      /* shown from discover.error */
    }
  };

  const runOnboard = async () => {
    try {
      await onboard.mutateAsync({
        ...credentialPayload(provider, creds),
        members: selected,
        target_client_id: clientId || null,
        environment,
        name_prefix: prefix.trim() || null,
        start_discovery: startDiscovery,
      });
      setStep('results');
    } catch {
      /* shown from onboard.error */
    }
  };

  const errorOf = (m) => m.error?.response?.data?.detail || m.error?.message;
  const listed = listing?.status === 'Collected';

  const memberRows = members.map((m) => ({
    key: m.member_id,
    cells: {
      member: (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate-safe text-[13px] font-medium text-fg">{m.name || m.member_id}</span>
            {m.is_management_account && <Badge tone="info" size="xs">Management</Badge>}
          </div>
          <div className="font-mono text-meta text-subtle">{m.member_id}</div>
        </div>
      ),
      detail: <span className="truncate-safe text-[12px] text-muted">{m.detail || '—'}</span>,
      state: <span className="text-[12px] text-muted">{m.state || '—'}</span>,
      access: (
        <div className="min-w-0 space-y-1">
          <Badge tone={accessTone(m)}>{accessLabel(m)}</Badge>
          {provider === 'Azure' && m.access?.probed && (
            <div className="flex flex-wrap gap-1">
              <Capability label="Inventory" value={m.access.inventory} />
              <Capability label="Cost" value={m.access.cost} />
              <Capability label="Identity" value={m.access.identity} />
            </div>
          )}
          {m.reason && <p className="line-clamp-2 text-meta leading-snug text-muted" title={m.reason}>{m.reason}</p>}
        </div>
      ),
    },
  }));

  const results = onboard.data?.results || [];
  const resultRows = results.map((r) => {
    const meta = onboardOutcomeMeta(r.outcome);
    const route = accountRoute(onboard.data?.provider, r.account_id);
    return {
      key: `${r.member_id}:${r.outcome}`,
      cells: {
        member: <span className="font-mono text-[12px] text-fg">{r.member_id}</span>,
        outcome: <Badge tone={meta.tone}>{meta.label}</Badge>,
        detail: (
          <span className="text-[12px] text-muted">
            {r.outcome === 'created' ? r.account_name : r.detail || '—'}
          </span>
        ),
        open: route ? (
          <Button size="sm" variant="ghost" iconRight="chevron-right" onClick={() => { onClose?.(); navigate(route); }}>
            Open
          </Button>
        ) : null,
      },
    };
  });

  const footer = (
    <div className="flex items-center justify-between gap-2">
      <div className="text-[12px] text-muted">
        {step === 'members' && listed && `${formatCount(selected.length)} of ${formatCount(listing.summary?.selectable)} selectable member(s) chosen`}
      </div>
      <div className="flex items-center gap-2">
        {step === 'credentials' && (
          <>
            <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon="search" loading={discover.isPending} onClick={runDiscover}>
              {discover.isPending ? 'Listing and probing members…' : 'List members'}
            </Button>
          </>
        )}
        {step === 'members' && (
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setStep('credentials')}>Back</Button>
            <Button
              variant="primary"
              icon="plus"
              loading={onboard.isPending}
              disabled={!listed || !selected.length}
              onClick={runOnboard}
            >
              {onboard.isPending ? 'Onboarding…' : `Onboard ${selected.length} account${selected.length === 1 ? '' : 's'}`}
            </Button>
          </>
        )}
        {step === 'results' && <Button variant="primary" onClick={onClose}>Done</Button>}
      </div>
    </div>
  );

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      title="Onboard an organisation"
      subtitle="Connect every account in an AWS organisation or every subscription in an Azure tenant at once."
      icon="layers"
      width={step === 'credentials' ? 620 : 1040}
      footer={footer}
    >
      {step === 'credentials' && (
        <div className="space-y-4">
          {discover.isError && <Notice tone="danger">{String(errorOf(discover))}</Notice>}
          <Segmented options={PROVIDERS} value={provider} onChange={setProvider} />
          <p className="text-meta leading-relaxed text-subtle">
            OCI is not listed: a tenancy is already one account covering every compartment —
            add it from Add Account. Listing stores nothing; these credentials are used for the
            listing and dropped.
          </p>

          {provider === 'AWS' ? (
            <div className="space-y-3">
              <Notice tone="info">
                Use keys of the management account or a delegated administrator. Each member
                is stored with the role to assume into it, so it is scanned with that
                role&apos;s permissions — never the management account&apos;s own.
              </Notice>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="Access key ID"><Input value={creds.access_key_id} onChange={set('access_key_id')} autoComplete="off" /></Field>
                <Field label="Secret access key"><Input type="password" value={creds.secret_access_key} onChange={set('secret_access_key')} autoComplete="new-password" /></Field>
                <Field label="Session token (optional)"><Input type="password" value={creds.session_token} onChange={set('session_token')} autoComplete="new-password" /></Field>
                <Field label="Region"><Input value={creds.region} onChange={set('region')} /></Field>
                <Field label="Member role name" hint="Created automatically in accounts made from the organisation; an invited account needs it created by hand.">
                  <Input value={creds.role_name} onChange={set('role_name')} />
                </Field>
                <Field label="External ID (optional)"><Input value={creds.external_id} onChange={set('external_id')} autoComplete="off" /></Field>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Notice tone="info">
                A service principal with Reader on each subscription, or on a management group
                above them. Cost needs Cost Management Reader; certificates and secrets in Key
                Vault need Key Vault Reader. Each capability is probed per subscription.
              </Notice>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="Tenant ID"><Input value={creds.tenant_id} onChange={set('tenant_id')} autoComplete="off" /></Field>
                <Field label="Client (application) ID"><Input value={creds.client_id} onChange={set('client_id')} autoComplete="off" /></Field>
                <Field label="Client secret"><Input type="password" value={creds.client_secret} onChange={set('client_secret')} autoComplete="new-password" /></Field>
                <Field label="Management group ID (optional)" hint="Only subscriptions under this group are listed.">
                  <Input value={creds.management_group_id} onChange={set('management_group_id')} />
                </Field>
              </div>
            </div>
          )}
        </div>
      )}

      {step === 'members' && listing && (
        <div className="space-y-4">
          {!listed ? (
            <Notice tone="danger" title={`${listing.status}.`}>
              {listing.error || 'The organisation could not be listed.'}
              {listing.missing_permission && (
                <> Missing permission: <span className="font-mono">{listing.missing_permission}</span>.</>
              )}
            </Notice>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge tone="neutral">{formatCount(listing.summary?.total)} member(s)</Badge>
                <Badge tone="success">{formatCount(listing.summary?.selectable)} can be onboarded</Badge>
                <Badge tone="neutral">{formatCount(listing.summary?.already_connected)} already connected</Badge>
                <Badge tone="danger">{formatCount(listing.summary?.no_access)} without access</Badge>
                {listing.organization?.id && <Badge tone="outline">Organisation {listing.organization.id}</Badge>}
                {listing.tenant_id && <Badge tone="outline">Tenant {listing.tenant_id}</Badge>}
              </div>
              {listing.truncated && (
                <Notice tone="warning">The listing was truncated at the per-request limit; members beyond it are not shown.</Notice>
              )}
              {listing.management_group_error && <Notice tone="info">{listing.management_group_error}</Notice>}
              {onboard.isError && <Notice tone="danger">{String(errorOf(onboard))}</Notice>}

              <div className="rounded-card border border-border">
                <Table
                  columns={[
                    { key: 'member', label: provider === 'AWS' ? 'Account' : 'Subscription' },
                    { key: 'detail', label: provider === 'AWS' ? 'E-mail' : 'Tenant', width: 220 },
                    { key: 'state', label: 'State', width: 100 },
                    { key: 'access', label: 'Access', width: 300 },
                  ]}
                  rows={memberRows}
                  selectable
                  selectedKeys={selected}
                  onSelectionChange={setSelected}
                  isSelectable={(row) => members.find((m) => m.member_id === row.key)?.selectable}
                  empty={<EmptyState icon="layers" title="No members" body="The organisation listed no members." />}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="Assign to client">
                  <Select
                    value={clientId}
                    onChange={setClientId}
                    options={[{ id: '', label: 'No client' },
                      ...(clients || []).map((c) => ({ id: c.id, label: c.code ? `${c.name} (${c.code})` : c.name }))]}
                  />
                </Field>
                <Field label="Environment">
                  <Select value={environment} onChange={setEnvironment} options={ENVIRONMENTS} />
                </Field>
                <Field label="Name prefix (optional)" hint="Prefixed to each member's own name, e.g. “KOEL - ”.">
                  <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} />
                </Field>
                <Field
                  label="Start discovery now"
                  hint="At most five scans start at once; the rest are created without a scan and can be started from each account."
                  inline
                >
                  <Switch checked={startDiscovery} onChange={setStartDiscovery} label="Start discovery now" />
                </Field>
              </div>
            </>
          )}
        </div>
      )}

      {step === 'results' && onboard.data && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Badge tone="success">{formatCount(onboard.data.summary?.created)} created</Badge>
            <Badge tone="neutral">{formatCount(onboard.data.summary?.skipped)} already connected</Badge>
            <Badge tone="danger">{formatCount(onboard.data.summary?.failed)} failed</Badge>
            {onboard.data.discovery_started?.length > 0 && (
              <Badge tone="info">Discovery started for {onboard.data.discovery_started.length}</Badge>
            )}
          </div>
          {onboard.data.note && <Notice tone="info">{onboard.data.note}</Notice>}
          <div className="rounded-card border border-border">
            <Table
              columns={[
                { key: 'member', label: 'Member', width: 260 },
                { key: 'outcome', label: 'Outcome', width: 170 },
                { key: 'detail', label: 'Detail' },
                { key: 'open', label: '', width: 90, align: 'right' },
              ]}
              rows={resultRows}
              empty={<EmptyState icon="layers" title="Nothing was onboarded" />}
            />
          </div>
        </div>
      )}
    </Dialog>
  );
}
