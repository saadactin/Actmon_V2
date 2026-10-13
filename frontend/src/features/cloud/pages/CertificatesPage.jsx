import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from '@/components/ui/Button';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';
import { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudSection from '../components/CloudSection';
import { BucketStrip, CertificateTable } from '../components/certificates/CertificatePrimitives';
import { useCertificateEstate } from '../hooks/useCertificates';
import { useClientOptions } from '../hooks/useClients';
import { accountRoute, KIND_ORDER, kindMeta } from '../utils/clientModel';
import { formatCount, formatDateTime, providerLabel } from '../utils/securityModel';

const WINDOWS = [7, 30, 60, 90, 180, 365].map((d) => ({ id: String(d), label: `Within ${d} days` }));
const UNASSIGNED = '__unassigned__';

/**
 * What expires next, across every account — or one client's.
 *
 * Read from the stored inventory (collected with each discovery scan), never
 * from a live provider call, and never a secret value. An account whose
 * stores could not be read is listed above the table, so "nothing expiring"
 * is never mistaken for "nothing looked at".
 */
export default function CertificatesPage() {
  const navigate = useNavigate();
  const [scope, setScope] = useState('');
  const [within, setWithin] = useState('30');
  const [kind, setKind] = useState('');
  const [noExpiry, setNoExpiry] = useState(false);
  const { data: clients } = useClientOptions();
  const { data, isLoading, isError, error, isFetching } = useCertificateEstate({
    clientId: scope && scope !== UNASSIGNED ? scope : undefined,
    unassigned: scope === UNASSIGNED,
    withinDays: Number(within),
    kind: kind || undefined,
    includeNoExpiry: noExpiry,
  });

  const accounts = data?.accounts || [];
  const neverCollected = accounts.filter((a) => a.never_collected);
  const failing = accounts.filter((a) => !a.never_collected && a.sources_failing > 0);

  const header = (
    <CloudPageHeader
      backTo="/cloud"
      icon="lock"
      title="Certificates & Secrets"
      description="Certificates, secrets and keys across AWS, Azure and OCI — soonest expiry first. Metadata only; no secret value is ever read."
      actions={<Button icon="building" onClick={() => navigate('/cloud/clients')}>Clients</Button>}
    />
  );

  if (isLoading) return <>{header}<PageLoading title="Loading the inventory…" /></>;
  if (isError) {
    return (
      <>
        {header}
        <CloudSection>
          <EmptyState icon="alert" title="Certificates unavailable"
            body={error?.response?.data?.detail || error?.message || 'The request failed.'} />
        </CloudSection>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            width="auto"
            value={scope}
            onChange={setScope}
            options={[
              { id: '', label: 'All accounts' },
              { id: UNASSIGNED, label: 'Accounts without a client' },
              ...(clients || []).map((c) => ({ id: c.id, label: c.name, group: 'Clients' })),
            ]}
          />
          <Select width="auto" value={within} onChange={setWithin} options={WINDOWS} />
          <Select
            width="auto"
            value={kind}
            onChange={setKind}
            options={[{ id: '', label: 'All kinds' }, ...KIND_ORDER.map((k) => ({ id: k, label: kindMeta(k).label }))]}
          />
          <label className="flex items-center gap-2 text-[12px] text-muted">
            <Switch checked={noExpiry} onChange={setNoExpiry} label="Include items with no expiry" size="sm" />
            Include items with no expiry
          </label>
        </div>

        {(neverCollected.length > 0 || failing.length > 0) && (
          <Notice tone="warning" title="Not every store was read.">
            {neverCollected.length > 0 && (
              <>{neverCollected.length} account(s) have never been collected ({neverCollected.map((a) => a.account_name).join(', ')}). </>
            )}
            {failing.length > 0 && (
              <>{failing.length} account(s) have stores that could not be read on the last attempt. </>
            )}
            Anything in those stores may be missing below — this is not a clean result for them.
          </Notice>
        )}

        <BucketStrip byBucket={data?.summary?.by_bucket} />

        <CloudSection
          title={`Expiring within ${within} days${noExpiry ? ', plus items with no expiry' : ''}`}
          description={`${formatCount(data?.objects?.length)} shown. The tiles above count everything tracked in this scope, whatever the window.`}
          bodyClassName="p-0"
        >
          <CertificateTable objects={data?.objects} showAccount loading={isFetching} />
          {data?.truncated && (
            <p className="px-card py-2 text-meta text-warning-fg">Only the first 2,000 are shown; narrow the filters.</p>
          )}
        </CloudSection>

        <CloudSection
          title="Collection by account"
          description="Certificates and secrets are read with every refresh. Use Refresh all on an account to read them again, or open its Security Center to see why a store failed."
        >
          {accounts.length === 0 ? (
            <EmptyState icon="cloud" title="No accounts in this scope" />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {accounts.map((a) => {
                const route = accountRoute(a.provider, a.account_id);
                return (
                  <button
                    key={a.account_id}
                    type="button"
                    disabled={!route}
                    onClick={() => route && navigate(`${route}/security?view=certificates`)}
                    className="rounded-control border border-border p-3 text-left transition-colors hover:border-strong"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate-safe text-[13px] font-medium text-fg">{a.account_name}</span>
                      <span className="text-meta text-subtle">{providerLabel(a.provider)}</span>
                    </div>
                    <div className="mt-1 text-meta text-muted">
                      {a.never_collected
                        ? 'Never collected'
                        : `${a.sources_total - a.sources_failing} of ${a.sources_total} store scope(s) read · last attempt ${formatDateTime(a.last_attempt_at)}`}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CloudSection>
      </div>
    </>
  );
}
