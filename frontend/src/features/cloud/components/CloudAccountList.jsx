import { useNavigate } from 'react-router-dom';
import cn from '@/lib/cn';
import { useCloudAccounts, useDeleteCloudAccount } from '../hooks/useCloudAccounts';
import { useCloudScope } from '../hooks/useCloudScope';
import { useCloudStore } from '../state/cloudStore';
import { useTriggerDiscovery } from '../hooks/useDiscovery';
import { useAllResources } from '../hooks/useResources';
import { formatDate } from '../utils/formatters';
import { providerKeyOf, slugForProvider } from '../utils/providerScope';
import { usePermissions } from '@/hooks/usePermissions';
import Table, { EmptyState } from '@/components/ui/Table';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';

// Same list-view cell system as AgentsPage.jsx's own darkHeader table — kept
// identical (font size/weight/colour, not just the header band) so every
// darkHeader list in the app reads as one consistent pattern.
const CELL_SIZE = 'whitespace-nowrap text-[1rem] leading-[1.125rem]';
const CELL_TEXT = cn(CELL_SIZE, 'font-medium');
const CELL_TEXT_STYLE = { color: 'var(--agent-gray)' };
const STATUS_BADGE_COLORS = {
  success: { bg: 'var(--agent-green-soft)', fg: 'var(--agent-green-fg)' },
  danger: { bg: 'var(--agent-red-soft)', fg: 'var(--agent-red-fg)' },
  warning: { bg: 'var(--agent-yellow-soft)', fg: 'var(--agent-yellow-fg)' },
  info: { bg: 'var(--info-soft)', fg: 'var(--info-fg)' },
};

// Provider brand colours are pinned (external identity), not theme tokens —
// same badge look CloudProviderSelector uses for these same three providers.
function providerBadgeClass(provider) {
  const p = (provider || '').toLowerCase();
  if (p.includes('azure')) return 'bg-sky-50 text-sky-700 border-sky-200';
  if (p.includes('aws')) return 'bg-orange-50 text-orange-700 border-orange-200';
  if (p.includes('oci') || p.includes('oracle')) return 'bg-red-50 text-red-700 border-red-200';
  return 'bg-sunken text-muted border-border';
}

// The account row itself carries no health flag — `last_discovery_status` is
// derived server-side from that account's most recent discovery job
// (never_scanned | scanning | failed | ok), see CloudAccountService.list_accounts.
// scanning/never_scanned both read as "needs attention" — neither confirms the
// connection is actually healthy, the same bar mysql-servers' Warning bucket sets.
const STATUS_META = {
  ok: { label: 'Online', tone: 'success', icon: 'check', bucket: 'online' },
  scanning: { label: 'Scanning', tone: 'info', icon: 'refresh', bucket: 'warning' },
  never_scanned: { label: 'Not Scanned', tone: 'warning', icon: 'alert', bucket: 'warning' },
  failed: { label: 'Offline', tone: 'danger', icon: 'ban', bucket: 'offline' },
};
const statusMetaOf = (acc) => STATUS_META[acc.last_discovery_status] || STATUS_META.never_scanned;

const COLUMNS = [
  { key: 'srNo', label: 'Sr. No.', align: 'center', width: 64 },
  { key: 'account', label: 'Account', width: 280 },
  { key: 'environment', label: 'Environment', align: 'center' },
  { key: 'region', label: 'Region', align: 'center' },
  { key: 'status', label: 'Status', align: 'center', width: 150 },
  { key: 'resources', label: 'Resources', align: 'center' },
  { key: 'lastScan', label: 'Last Scan', align: 'center' },
  { key: 'actions', label: 'Action', align: 'center', width: 90 },
];

export const CloudAccountList = ({
  search = '',
  providerFilter = null,
  environmentFilter = null,
  statusFilter = null,
  view = 'list',
}) => {
  const { isLoading } = useCloudAccounts();
  const { data: allResources } = useAllResources();
  const { mutate: deleteAccount } = useDeleteCloudAccount();
  const { mutate: triggerScan } = useTriggerDiscovery();
  const { selectedAccountId, setSelectedAccountId, activeDiscoveryJobs } = useCloudStore();
  // Only list accounts for the provider currently scoped (all when unscoped).
  const scope = useCloudScope();
  const { canHere } = usePermissions();
  const navigate = useNavigate();

  const q = search.trim().toLowerCase();
  // Two stages, kept separate: `providerScoped` decides whether "no rows" means
  // genuinely no accounts for this provider vs. a search term filtering them all
  // out — checking scope.scopedAccounts alone (unaware of the providerFilter
  // prop) said "there ARE accounts" whenever a different provider had any,
  // showing "No accounts match your filters" on an empty AWS-only store scope
  // opened via a direct link to e.g. /cloud/azure-accounts.
  const providerScoped = scope.scopedAccounts.filter((acc) => (
    !providerFilter || providerKeyOf(acc.provider) === providerFilter
  ));
  const accounts = providerScoped.filter((acc) => (
    (!environmentFilter || environmentFilter === 'All' || acc.environment === environmentFilter)
    && (!statusFilter || statusMetaOf(acc).bucket === statusFilter)
    && (!q || acc.account_name.toLowerCase().includes(q))
  ));

  const resourceCountOf = (accountId) => (allResources || []).filter((r) => r.account_id === accountId).length;
  const isScanningRow = (accountId) => !!activeDiscoveryJobs?.[accountId];

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-card py-24">
        <Icon name="spinner" size={28} className="animate-spin text-accent-text" />
        <span className="text-[13px] text-muted">Loading accounts…</span>
      </div>
    );
  }

  const emptyState = (
    <EmptyState
      icon="cloud"
      title={providerScoped.length > 0
        ? 'No accounts match your filters'
        : providerFilter ? `No ${providerFilter} Accounts` : 'No Cloud Accounts'}
      body={providerScoped.length > 0
        ? 'Try a different search term or provider.'
        : providerFilter ? `Connect ${/^[aeiou]/i.test(providerFilter) ? 'an' : 'a'} ${providerFilter} account to get started.` : 'Connect a provider to get started.'}
    />
  );

  const goToAccount = (acc) => {
    setSelectedAccountId(acc.id);
    navigate(`/cloud/${slugForProvider(acc.provider)}-accounts/${acc.id}`);
  };

  const rowActions = (acc) => (
    <div className="flex items-center justify-center gap-1">
      {canHere('execute') && (
        <Button
          variant="ghost"
          size="sm"
          icon="refresh"
          loading={isScanningRow(acc.id)}
          aria-label="Run discovery scan"
          title="Run discovery scan"
          onClick={(e) => { e.stopPropagation(); triggerScan(acc.id); }}
        />
      )}
      {canHere('delete') && (
        <Button
          variant="danger-ghost"
          size="sm"
          icon="trash"
          aria-label="Delete account"
          title="Delete account"
          onClick={(e) => { e.stopPropagation(); deleteAccount(acc.id); }}
        />
      )}
    </div>
  );

  if (view === 'grid') {
    if (!accounts.length) {
      return <div className="px-card py-16">{emptyState}</div>;
    }
    return (
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
        {accounts.map((acc) => {
          const isSelected = selectedAccountId === acc.id;
          const meta = statusMetaOf(acc);
          return (
            <button
              key={acc.id}
              type="button"
              onClick={() => goToAccount(acc)}
              className={`flex flex-col gap-3 rounded-2xl border bg-surface p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${
                isSelected ? 'border-accent ring-2 ring-accent-soft' : 'border-border'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className={`truncate text-[13px] ${isSelected ? 'font-bold text-accent-text' : 'font-semibold text-fg'}`}>
                    {acc.account_name}
                  </p>
                  <span className={`mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${providerBadgeClass(acc.provider)}`}>
                    {acc.provider}
                  </span>
                </div>
                <Badge tone={meta.tone}><Icon name={meta.icon} size={11} />{meta.label}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[12px] text-muted">
                <div><p className="text-[10px] uppercase tracking-wide text-subtle">Environment</p>{acc.environment || 'NA'}</div>
                <div><p className="text-[10px] uppercase tracking-wide text-subtle">Region</p>{acc.tenant_or_region || 'NA'}</div>
                <div><p className="text-[10px] uppercase tracking-wide text-subtle">Resources</p>{resourceCountOf(acc.id)}</div>
                <div><p className="text-[10px] uppercase tracking-wide text-subtle">Last Scan</p>{acc.last_discovery ? formatDate(acc.last_discovery) : 'NA'}</div>
              </div>
              <div className="flex justify-end border-t border-border pt-2">{rowActions(acc)}</div>
            </button>
          );
        })}
      </div>
    );
  }

  const rows = (accounts || []).map((acc, i) => {
    const isSelected = selectedAccountId === acc.id;
    const meta = statusMetaOf(acc);
    return {
      key: acc.id,
      onClick: () => goToAccount(acc),
      cells: {
        srNo: <span className={cn(CELL_TEXT, 'tabular-nums')} style={CELL_TEXT_STYLE}>{i + 1}</span>,
        // Single line — "Name PROVIDER", bold name / badge suffix — same
        // shape as AgentsPage.jsx's Agent/Host column.
        account: (
          <div className="flex items-center gap-2">
            <span className={cn(CELL_SIZE, isSelected ? 'font-bold text-accent-text' : 'font-bold text-fg')}>
              {acc.account_name}
            </span>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase ${providerBadgeClass(acc.provider)}`}>
              {acc.provider}
            </span>
          </div>
        ),
        environment: <span className={CELL_TEXT} style={CELL_TEXT_STYLE}>{acc.environment || '—'}</span>,
        region: <span className={CELL_TEXT} style={CELL_TEXT_STYLE}>{acc.tenant_or_region || 'NA'}</span>,
        // Fixed 178×48 pill, same dimensions/typography as AgentsPage.jsx's
        // own Status column (Figma spec), just wearing this account's tone.
        status: (
          <span className="inline-flex justify-center">
            <Badge
              tone={meta.tone}
              size="xs"
              className="w-[11.125rem] justify-center gap-[0.625rem]"
              style={{
                height: '3rem',
                paddingTop: '0.25rem', paddingRight: '0.5rem', paddingBottom: '0.25rem', paddingLeft: '0.5rem',
                fontSize: '1rem', lineHeight: '1.125rem', fontWeight: 500,
                ...(STATUS_BADGE_COLORS[meta.tone] && {
                  background: STATUS_BADGE_COLORS[meta.tone].bg,
                  color: STATUS_BADGE_COLORS[meta.tone].fg,
                }),
              }}
            >
              <Icon name={meta.icon} size={11} />
              {meta.label}
            </Badge>
          </span>
        ),
        resources: <span className={cn(CELL_TEXT, 'tabular-nums')} style={CELL_TEXT_STYLE}>{resourceCountOf(acc.id)}</span>,
        lastScan: (
          <span className={CELL_TEXT} style={CELL_TEXT_STYLE}>{acc.last_discovery ? formatDate(acc.last_discovery) : 'NA'}</span>
        ),
        actions: rowActions(acc),
      },
    };
  });

  return (
    <Table
      columns={COLUMNS}
      rows={rows}
      selectedKeys={selectedAccountId ? [selectedAccountId] : []}
      rowHeight={64}
      darkHeader
      empty={emptyState}
    />
  );
};
