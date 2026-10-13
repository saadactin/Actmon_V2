import { useNavigate } from 'react-router-dom';
import cn from '@/lib/cn';
import { useCloudAccounts, useDeleteCloudAccount } from '../hooks/useCloudAccounts';
import { useCloudScope } from '../hooks/useCloudScope';
import { useCloudStore } from '../state/cloudStore';
import { useAccountResourceCounts } from '../hooks/useResources';
import { formatDate } from '../utils/formatters';
import { providerKeyOf, slugForProvider } from '../utils/providerScope';
import { providerBadgeStyle } from '../utils/providerTheme';
import { accountLocation } from '../utils/regions';
import ProviderLogo from './ProviderLogo';
import RefreshAllButton from './refresh/RefreshAllButton';
import { usePermissions } from '@/hooks/usePermissions';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
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

// Provider brand hues are pinned (external identity), but applied through the
// one registry so this list, the selector, the chooser and the topology all
// agree — and so the badge is a tint of the hue rather than a fixed
// light-palette swatch that turns white on the dark themes.
const BADGE_CLASS = 'inline-flex items-center rounded-full border px-2 py-0.5 font-bold uppercase';

// The account row itself carries no health flag — `last_discovery_status` is
// derived server-side from that account's most recent discovery job
// (never_scanned | scanning | failed | ok), see CloudAccountService.list_accounts.
// scanning/never_scanned both read as "needs attention" — neither confirms the
// connection is actually healthy, the same bar mysql-servers' Warning bucket sets.
// The label describes whether OUR last discovery scan of the account worked, not
// whether the cloud itself is up: a subscription that revoked our Reader role is
// perfectly healthy and still reads "Unreachable" here. "Online"/"Offline" implied
// the provider was down, so the wording now says what is actually being measured.
// `tooltip` spells out what the badge measures, on the badge itself, so the
// label doesn't have to carry that whole distinction on its own — "Reachable"
// read in isolation still invites "is the resource itself reachable?", which
// is exactly the mix-up the wording above is trying to avoid.
const STATUS_META = {
  ok: {
    label: 'Reachable', tone: 'success', icon: 'check', bucket: 'online',
    tooltip: 'Our last discovery scan could connect to and read this account. It does not reflect the live state of the account’s own resources.',
  },
  scanning: {
    label: 'Scanning', tone: 'info', icon: 'refresh', bucket: 'warning',
    tooltip: 'A discovery scan of this account is in progress.',
  },
  never_scanned: {
    label: 'Not Scanned', tone: 'warning', icon: 'alert', bucket: 'warning',
    tooltip: 'This account has never been scanned, so its connectivity is unverified.',
  },
  failed: {
    label: 'Scan Failed', tone: 'danger', icon: 'ban', bucket: 'offline',
    tooltip: 'Our last discovery scan could not connect to this account — often a lost or revoked credential/role, not necessarily a problem with the account itself.',
  },
};
const statusMetaOf = (acc) => STATUS_META[acc.last_discovery_status] || STATUS_META.never_scanned;

const COLUMNS = [
  { key: 'srNo', label: 'Sr. No.', align: 'center', width: 64 },
  { key: 'account', label: 'Account', width: 280 },
  { key: 'environment', label: 'Environment', align: 'center' },
  // Not always a region: Azure accounts may carry a tenant GUID here instead.
  { key: 'region', label: 'Region / Tenant', align: 'center' },
  // "Scan Status", not bare "Status" — this column reports whether OUR last
  // discovery scan could reach the account, not the live state of its
  // resources (see STATUS_META above), and the column header is the first
  // place a reader looks to tell those apart.
  { key: 'status', label: 'Scan Status', align: 'center', width: 150 },
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
  const { data: counts } = useAccountResourceCounts();
  const { mutate: deleteAccount } = useDeleteCloudAccount();
  const { selectedAccountId, setSelectedAccountId } = useCloudStore();
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

  // null, not 0, while the counts are still loading — an account whose count we
  // have not fetched yet has not been shown to be empty.
  const resourceCountOf = (accountId) => counts?.byAccount?.[accountId] ?? null;

  if (isLoading) {
    return <PageLoading title="Loading accounts…" illustration />;
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
      {/* The same Refresh all as inside the account — it used to start a
          plain discovery under a third name. */}
      <RefreshAllButton accountId={acc.id} variant="ghost" iconOnly />

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
                  <span className="mt-1 inline-flex items-center gap-1.5">
                    <ProviderLogo provider={acc.provider} size={14} />
                    <span className={cn(BADGE_CLASS, 'text-micro')} style={providerBadgeStyle(acc.provider)}>
                      {acc.provider}
                    </span>
                  </span>
                </div>
                <Badge tone={meta.tone}><Icon name={meta.icon} size={11} />{meta.label}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[12px] text-muted">
                <div><p className="text-micro uppercase tracking-wide text-subtle">Environment</p>{acc.environment || 'NA'}</div>
                <div>
                  <p className="text-micro uppercase tracking-wide text-subtle">
                    {accountLocation(acc).kind === 'tenant' ? 'Tenant' : 'Region'}
                  </p>
                  {accountLocation(acc).text}
                </div>
                <div><p className="text-micro uppercase tracking-wide text-subtle">Resources</p>{resourceCountOf(acc.id) ?? "—"}</div>
                <div><p className="text-micro uppercase tracking-wide text-subtle">Last Scan</p>{acc.last_discovery ? formatDate(acc.last_discovery) : 'NA'}</div>
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
            <ProviderLogo provider={acc.provider} size={16} className="shrink-0" />
            <span className={cn(CELL_SIZE, isSelected ? 'font-bold text-accent-text' : 'font-bold text-fg')}>
              {acc.account_name}
            </span>
            <span className={cn(BADGE_CLASS, 'text-meta')} style={providerBadgeStyle(acc.provider)}>
              {acc.provider}
            </span>
          </div>
        ),
        environment: <span className={CELL_TEXT} style={CELL_TEXT_STYLE}>{acc.environment || '—'}</span>,
        region: (() => {
          const loc = accountLocation(acc);
          return (
            <span className={CELL_TEXT} style={CELL_TEXT_STYLE} title={loc.title || undefined}>
              {loc.text}
            </span>
          );
        })(),
        // Fixed 178×48 pill, same dimensions/typography as AgentsPage.jsx's
        // own Status column (Figma spec), just wearing this account's tone.
        status: (
          <span className="inline-flex justify-center">
            <Badge
              tone={meta.tone}
              size="xs"
              title={meta.tooltip}
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
        resources: <span className={cn(CELL_TEXT, 'tabular-nums')} style={CELL_TEXT_STYLE}>{resourceCountOf(acc.id) ?? "—"}</span>,
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
