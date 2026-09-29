import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Select from '@/components/ui/Select';
import Table, { EmptyState } from '@/components/ui/Table';
import Toasts, { useToasts } from '@/components/ui/Toast';
import { PageLoading } from '@/components/ui/Loading';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudSection from '../components/CloudSection';
import ClientFormDialog from '../components/clients/ClientFormDialog';
import OnboardOrganizationDialog from '../components/clients/OnboardOrganizationDialog';
import {
  AccountSummaryTable, CertificateCell, FindingsCell, MoneyCell, PostureBadge, ProviderCounts,
  StatCard,
} from '../components/clients/ClientPrimitives';
import { useAssignAccounts, usePortfolio } from '../hooks/useClients';
import {
  certificateHealth, deliveryMeta, findingCounts, formatMoneyMap, moneyTitle, periodLabel,
  worstPostureLabel,
} from '../utils/clientModel';
import { formatCount, formatDateTime } from '../utils/securityModel';

/**
 * Every client side by side — the all-clients view.
 *
 * Each row is one client's accounts rolled up by the backend: counts add,
 * money adds only within a currency, and posture is the worst published score
 * rather than an average. The accounts nobody has claimed are listed below,
 * because an unassigned account is in no client's monthly report.
 */
export default function ClientsPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = usePortfolio();
  const assign = useAssignAccounts();
  const { toasts, push, dismiss } = useToasts();
  const [creating, setCreating] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [selected, setSelected] = useState([]);
  const [target, setTarget] = useState('');

  const clients = data?.clients || [];
  const unassigned = data?.unassigned?.accounts || [];
  const totals = data?.totals;

  const assignSelected = async () => {
    if (!target || !selected.length) return;
    try {
      const out = await assign.mutateAsync({ clientId: target, accountIds: selected });
      const name = clients.find((c) => c.client.id === target)?.client.name || 'the client';
      push(`Assigned ${out.assigned?.length || 0} account(s) to ${name}.`);
      setSelected([]);
    } catch (e) {
      push(e?.response?.data?.detail || 'Assigning failed.', 'error');
    }
  };

  const header = (
    <CloudPageHeader
      backTo="/cloud"
      icon="building"
      title="Clients"
      description="Every client's estate side by side — spend per currency, worst posture, expiring certificates and monthly reports."
      actions={(
        <div className="flex flex-wrap items-center gap-2">
          <Button icon="lock" onClick={() => navigate('/cloud/certificates')}>Certificates</Button>
          <Button icon="layers" onClick={() => setOnboarding(true)}>Onboard organisation</Button>
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New client</Button>
        </div>
      )}
    />
  );

  const dialogs = (
    <>
      <ClientFormDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(c) => { push(`Client ${c.name} created.`); navigate(`/cloud/clients/${c.id}`); }}
      />
      <OnboardOrganizationDialog open={onboarding} onClose={() => setOnboarding(false)} />
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );

  if (isLoading) return <>{header}<PageLoading title="Loading clients…" />{dialogs}</>;
  if (isError) {
    return (
      <>
        {header}
        <CloudSection>
          <EmptyState
            icon="alert"
            title="Clients unavailable"
            body={error?.response?.data?.detail || error?.message || 'The request failed.'}
          />
        </CloudSection>
        {dialogs}
      </>
    );
  }

  const tf = findingCounts(totals?.findings);
  const tc = certificateHealth(totals?.certificates);

  const clientRows = clients.map(({ client, summary, latest_report: latest, report_schedule: sched }) => {
    const worst = worstPostureLabel(summary);
    const delivery = latest ? deliveryMeta(latest.delivery_status) : null;
    return {
      key: client.id,
      onClick: () => navigate(`/cloud/clients/${client.id}`),
      cells: {
        client: (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate-safe text-[13px] font-semibold text-fg">{client.name}</span>
              {client.code && <Badge tone="outline" size="xs">{client.code}</Badge>}
            </div>
            {client.description && (
              <div className="truncate-safe text-[11px] text-subtle">{client.description}</div>
            )}
          </div>
        ),
        accounts: (
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-fg">{formatCount(summary.accounts)}</div>
            <ProviderCounts byProvider={summary.by_provider} />
          </div>
        ),
        spend: <MoneyCell map={summary.cost?.month_to_date} previous={summary.cost?.previous_month} />,
        posture: <PostureBadge security={summary.worst_posture} detail={worst.detail} />,
        findings: <FindingsCell findings={summary.findings} />,
        certs: <CertificateCell certs={summary.certificates} />,
        report: (
          <div className="min-w-0">
            <Badge tone={sched?.enabled ? 'info' : 'neutral'} size="xs">
              {sched?.enabled ? 'Scheduled' : 'Not scheduled'}
            </Badge>
            <div className="mt-0.5 truncate-safe text-[11px] text-subtle" title={delivery?.hint}>
              {latest
                ? `${periodLabel(latest.period)} · ${latest.status === 'FAILED' ? 'failed' : delivery.label}`
                : 'No report yet'}
            </div>
          </div>
        ),
      },
    };
  });

  return (
    <>
      {header}
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard
            label="Clients" icon="building" value={formatCount(clients.length)}
            sub={`${formatCount(totals?.accounts)} account(s) · ${formatCount(unassigned.length)} unassigned`}
          />
          <StatCard
            label="Spend this month" icon="chart-line" tone="bg-info-soft text-info-fg"
            value={formatMoneyMap(totals?.cost?.month_to_date)}
            title={moneyTitle(totals?.cost?.month_to_date)}
            sub={`Last month: ${formatMoneyMap(totals?.cost?.previous_month)}`}
          />
          <StatCard
            label="Confirmed findings" icon="shield" tone="bg-danger-soft text-danger-fg"
            value={`${formatCount(tf.critical)} critical · ${formatCount(tf.high)} high`}
            sub={`${formatCount(tf.total)} confirmed across every account`}
          />
          <StatCard
            label="Certificates" icon="lock" tone="bg-warning-soft text-warning-fg"
            value={tc.text} sub={tc.detail}
          />
          <StatCard
            label="Open alerts" icon="bell" tone="bg-danger-soft text-danger-fg"
            value={formatCount(totals?.open_alerts)}
            sub={`As of ${formatDateTime(data?.generated_at)}`}
          />
        </div>

        <CloudSection title="Clients" description={data?.note} bodyClassName="p-0">
          <Table
            columns={[
              { key: 'client', label: 'Client' },
              { key: 'accounts', label: 'Accounts', width: 130 },
              { key: 'spend', label: 'Spend this month', width: 190, hint: 'Month to date, per currency; last month beneath. Currencies are never added together.' },
              { key: 'posture', label: 'Worst posture', width: 190, hint: 'The lowest published score among the client’s accounts. Never an average.' },
              { key: 'findings', label: 'Findings', width: 170 },
              { key: 'certs', label: 'Certificates', width: 190 },
              { key: 'report', label: 'Monthly report', width: 180 },
            ]}
            rows={clientRows}
            empty={(
              <EmptyState
                icon="building"
                title="No clients yet"
                body="Create a client, then assign accounts to it — or onboard a whole AWS organisation or Azure tenant straight into one."
                action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New client</Button>}
              />
            )}
          />
        </CloudSection>

        <CloudSection
          title={`Accounts without a client (${formatCount(unassigned.length)})`}
          description="These appear in no client's monthly report."
          action={unassigned.length > 0 && clients.length > 0 && (
            <div className="flex items-center gap-2">
              <Select
                width="auto"
                size="sm"
                value={target}
                onChange={setTarget}
                placeholder="Choose a client…"
                options={clients.map(({ client }) => ({ id: client.id, label: client.name }))}
              />
              <Button
                size="sm"
                variant="primary"
                loading={assign.isPending}
                disabled={!target || !selected.length}
                onClick={assignSelected}
              >
                Assign {selected.length || ''}
              </Button>
            </div>
          )}
          bodyClassName="p-0"
        >
          <AccountSummaryTable
            accounts={unassigned}
            selectable={clients.length > 0}
            selectedKeys={selected}
            onSelectionChange={setSelected}
            empty={<EmptyState icon="check" title="Every account belongs to a client" />}
          />
        </CloudSection>
      </div>
      {dialogs}
    </>
  );
}
