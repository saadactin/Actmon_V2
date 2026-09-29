import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Dialog from '@/components/ui/Dialog';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Table, { EmptyState } from '@/components/ui/Table';
import Tabs from '@/components/ui/Tabs';
import Toasts, { useToasts } from '@/components/ui/Toast';
import { PageLoading } from '@/components/ui/Loading';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudSection from '../components/CloudSection';
import ProviderLogo from '../components/ProviderLogo';
import ClientFormDialog from '../components/clients/ClientFormDialog';
import ClientReportsPanel from '../components/clients/ClientReportsPanel';
import OnboardOrganizationDialog from '../components/clients/OnboardOrganizationDialog';
import {
  AccountSummaryTable, ProviderCounts, StatCard,
} from '../components/clients/ClientPrimitives';
import { BucketStrip, CertificateTable } from '../components/certificates/CertificatePrimitives';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useCertificateEstate } from '../hooks/useCertificates';
import {
  useAssignAccounts, useClient, useDeleteClient, useUnassignAccount,
} from '../hooks/useClients';
import {
  certificateHealth, findingCounts, formatMoneyMap, moneyTitle, worstPostureLabel,
} from '../utils/clientModel';
import { formatCount, providerLabel } from '../utils/securityModel';

const TABS = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'accounts', label: 'Accounts', icon: 'cloud' },
  { id: 'reports', label: 'Monthly report', icon: 'report' },
  { id: 'certificates', label: 'Certificates & Secrets', icon: 'lock' },
];

const WINDOWS = [30, 60, 90, 180, 365].map((d) => ({ id: String(d), label: `Expiring within ${d} days` }));

/**
 * One client: its accounts rolled up, its monthly report, and what in its
 * estate expires next. Every number is the same one the portfolio shows —
 * both are computed by the backend's one estate summary.
 */
export default function ClientDetailPage() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useClient(clientId);
  const { toasts, push, dismiss } = useToasts();
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null);
  const del = useDeleteClient();
  const unassign = useUnassignAccount();

  const client = data?.client;
  const summary = data?.summary;
  const accounts = data?.accounts || [];

  const header = (
    <CloudPageHeader
      backTo="/cloud/clients"
      backLabel="All clients"
      icon="building"
      title={client?.name || 'Client'}
      description={client
        ? [client.code, `${formatCount(accounts.length)} account${accounts.length === 1 ? '' : 's'}`,
          client.description].filter(Boolean).join(' · ')
        : undefined}
      actions={client && (
        <div className="flex flex-wrap items-center gap-2">
          <Button icon="layers" onClick={() => setOnboarding(true)}>Onboard organisation</Button>
          <Button icon="file-edit" onClick={() => setEditing(true)}>Edit</Button>
          <Button variant="danger-ghost" icon="trash" onClick={() => setDeleting(true)}>Delete</Button>
        </div>
      )}
    />
  );

  if (isLoading) return <>{header}<PageLoading title="Loading client…" /></>;
  if (isError || !client) {
    return (
      <>
        {header}
        <CloudSection>
          <EmptyState
            icon="alert"
            title={error?.response?.status === 404 ? 'Client not found' : 'Client unavailable'}
            body={error?.response?.data?.detail || error?.message || 'The request failed.'}
            action={<Button onClick={() => navigate('/cloud/clients')}>All clients</Button>}
          />
        </CloudSection>
      </>
    );
  }

  const confirmDelete = async () => {
    try {
      await del.mutateAsync(client.id);
      // The portfolio it returns to no longer lists the client; a toast here
      // would unmount with this page before anyone saw it.
      navigate('/cloud/clients');
    } catch (e) {
      push(e?.response?.data?.detail || 'Deleting failed.', 'error');
      setDeleting(false);
    }
  };

  const confirmRemove = async () => {
    const a = removing;
    try {
      await unassign.mutateAsync({ clientId: client.id, accountId: a.account_id });
      push(`${a.account_name} removed from ${client.name}.`);
    } catch (e) {
      push(e?.response?.data?.detail || 'Removing failed.', 'error');
    } finally {
      setRemoving(null);
    }
  };

  const f = findingCounts(summary?.findings);
  const worst = worstPostureLabel(summary);
  const certs = certificateHealth(summary?.certificates);

  return (
    <>
      {header}
      <Tabs
        tabs={TABS.map((t) => (t.id === 'accounts' ? { ...t, count: accounts.length } : t))}
        value={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'overview' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Spend this month" icon="chart-line" tone="bg-info-soft text-info-fg"
              value={formatMoneyMap(summary?.cost?.month_to_date)}
              title={moneyTitle(summary?.cost?.month_to_date)}
              sub={`Last month: ${formatMoneyMap(summary?.cost?.previous_month)}`}
            />
            <StatCard
              label="Worst posture" icon="shield" tone="bg-warning-soft text-warning-fg"
              value={worst.text} sub={worst.detail}
            />
            <StatCard
              label="Confirmed findings" icon="alert" tone="bg-danger-soft text-danger-fg"
              value={`${f.critical} critical · ${f.high} high`}
              sub={`${formatCount(f.total)} confirmed · ${formatCount(summary?.open_alerts)} open alert(s)`}
            />
            <StatCard
              label="Certificates" icon="lock" tone="bg-warning-soft text-warning-fg"
              value={certs.text} sub={certs.detail}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted">
            <ProviderCounts byProvider={summary?.by_provider} />
            <span>·</span>
            <span>{formatCount(summary?.resources)} resources</span>
            {summary?.accounts_unassessed > 0 && (
              <>
                <span>·</span>
                <span>{summary.accounts_unassessed} account(s) never assessed</span>
              </>
            )}
          </div>

          <CloudSection title="Accounts" description={summary?.note} bodyClassName="p-0">
            <AccountSummaryTable
              accounts={accounts}
              empty={(
                <EmptyState
                  icon="cloud"
                  title="No accounts yet"
                  body="Assign existing accounts, or onboard an AWS organisation or Azure tenant into this client."
                  action={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add accounts</Button>}
                />
              )}
            />
          </CloudSection>
        </div>
      )}

      {tab === 'accounts' && (
        <CloudSection
          title="Accounts"
          description="Removing an account only takes it out of this client's report; nothing collected for it is deleted."
          action={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add accounts</Button>}
          bodyClassName="p-0"
        >
          <AccountSummaryTable
            accounts={accounts}
            onRemove={setRemoving}
            removingId={unassign.isPending ? removing?.account_id : null}
          />
        </CloudSection>
      )}

      {tab === 'reports' && <ClientReportsPanel clientId={client.id} clientName={client.name} push={push} />}

      {tab === 'certificates' && <ClientCertificates clientId={client.id} />}

      <ClientFormDialog
        open={editing}
        client={client}
        onClose={() => setEditing(false)}
        onSaved={(c) => push(`${c.name} saved.`)}
      />
      <OnboardOrganizationDialog
        open={onboarding}
        onClose={() => setOnboarding(false)}
        defaultClientId={client.id}
      />
      <AddAccountsDialog
        open={adding}
        onClose={() => setAdding(false)}
        client={client}
        memberIds={accounts.map((a) => a.account_id)}
        push={push}
      />
      <ConfirmDialog
        open={deleting}
        title={`Delete ${client.name}?`}
        message={`This deletes the client, its report schedule and its report history. Its ${
          accounts.length} account(s) are unassigned, never deleted — their inventory, findings and billing stay.`}
        confirmLabel="Delete client"
        cancelLabel="Keep"
        tone="danger"
        icon="trash"
        loading={del.isPending}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(false)}
      />
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.account_name || 'account'} from ${client.name}?`}
        message="It will appear in no client's report until it is assigned again. Nothing collected for it is deleted."
        confirmLabel="Remove"
        cancelLabel="Keep"
        tone="warning"
        loading={unassign.isPending}
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
      />
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );
}

/** Pick accounts to add. One already in another client is MOVED, and says so
 *  before anything is saved. */
function AddAccountsDialog({ open, onClose, client, memberIds, push }) {
  const { data: all, isLoading } = useCloudAccounts();
  const assign = useAssignAccounts();
  const [selected, setSelected] = useState([]);

  const candidates = useMemo(
    () => (all || []).filter((a) => !memberIds.includes(a.id))
      .sort((a, b) => a.account_name.localeCompare(b.account_name)),
    [all, memberIds],
  );
  const moving = candidates.filter((a) => selected.includes(a.id) && a.client_id);

  const close = () => { setSelected([]); onClose?.(); };
  const save = async () => {
    try {
      const out = await assign.mutateAsync({ clientId: client.id, accountIds: selected });
      const moved = out.moved || [];
      push(`Added ${out.assigned.length + moved.length} account(s) to ${client.name}`
        + (moved.length ? ` (${moved.length} moved from another client).` : '.'));
      close();
    } catch (e) {
      push(e?.response?.data?.detail || 'Adding failed.', 'error');
    }
  };

  const rows = candidates.map((a) => ({
    key: a.id,
    cells: {
      account: (
        <div className="flex min-w-0 items-center gap-2">
          <ProviderLogo provider={a.provider} size={18} />
          <div className="min-w-0">
            <div className="truncate-safe text-[13px] font-medium text-fg">{a.account_name}</div>
            <div className="text-[11px] text-subtle">{providerLabel(a.provider)} · {a.environment}</div>
          </div>
        </div>
      ),
      client: a.client_id
        ? <Badge tone="warning">In {a.client_name || 'another client'} — will move</Badge>
        : <span className="text-[12px] text-subtle">No client</span>,
    },
  }));

  return (
    <Dialog
      open={open}
      onClose={assign.isPending ? undefined : close}
      title={`Add accounts to ${client.name}`}
      icon="plus"
      width={720}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" disabled={assign.isPending} onClick={close}>Cancel</Button>
          <Button variant="primary" loading={assign.isPending} disabled={!selected.length} onClick={save}>
            Add {selected.length || ''}
          </Button>
        </div>
      )}
    >
      {moving.length > 0 && (
        <Notice tone="warning">
          {moving.length} of the chosen account(s) belong to another client and will be moved —
          they will leave that client&apos;s report.
        </Notice>
      )}
      {isLoading ? <PageLoading title="Loading accounts…" minHeight={160} /> : (
        <div className="rounded-card border border-border">
          <Table
            columns={[{ key: 'account', label: 'Account' }, { key: 'client', label: 'Current client', width: 260 }]}
            rows={rows}
            selectable
            selectedKeys={selected}
            onSelectionChange={setSelected}
            empty={<EmptyState icon="check" title="Every account is already in this client" />}
          />
        </div>
      )}
    </Dialog>
  );
}

function ClientCertificates({ clientId }) {
  const [within, setWithin] = useState('90');
  const { data, isLoading, isError, error, isFetching } = useCertificateEstate({
    clientId, withinDays: Number(within),
  });
  if (isLoading) return <PageLoading title="Loading certificates…" minHeight={200} />;
  if (isError) {
    return (
      <CloudSection>
        <EmptyState icon="alert" title="Certificates unavailable"
          body={error?.response?.data?.detail || error?.message || 'The request failed.'} />
      </CloudSection>
    );
  }
  const gaps = (data?.accounts || []).filter((a) => a.never_collected || a.sources_failing > 0);
  return (
    <div className="space-y-5">
      {gaps.length > 0 && (
        <Notice tone="warning" title="Not every store was read.">
          {gaps.map((a) => `${a.account_name}: ${a.never_collected
            ? 'never collected' : `${a.sources_failing} of ${a.sources_total} store scope(s) unreadable`}`).join('; ')}.
          {' '}Anything in those stores may be missing below.
        </Notice>
      )}
      <BucketStrip byBucket={data?.summary?.by_bucket} />
      <CloudSection
        title="Expiring"
        description="The tiles count everything tracked for this client; the table shows the chosen window, soonest first."
        action={<Select width="auto" size="sm" value={within} onChange={setWithin} options={WINDOWS} />}
        bodyClassName="p-0"
      >
        <CertificateTable objects={data?.objects} showAccount loading={isFetching} />
        {data?.truncated && (
          <p className="px-card py-2 text-[11px] text-warning-fg">Only the first 2,000 are shown.</p>
        )}
      </CloudSection>
    </div>
  );
}
