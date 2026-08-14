import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, LayoutGrid, List } from 'lucide-react';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useAllResources } from '../hooks/useResources';
import { useCloudStore } from '../state/cloudStore';
import { PROVIDER_META } from '../components/CloudProviderSelector';
import { CloudAccountList } from '../components/CloudAccountList';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudFilterBar from '../components/CloudFilterBar';
import CloudSection from '../components/CloudSection';
import { KEY_TO_SLUG, keyFromSlug, providerKeyOf } from '../utils/providerScope';
import Icon from '@/components/ui/Icon';

// Real taxonomy this app's Cloud accounts are tagged with — see
// AddCloudAccountForm's <select name="environment"> options. Not the same
// set as the Databases module's ENV_FILTERS (no UAT/Testing here).
const ENV_FILTERS = ['All', 'Production', 'Staging', 'Development'];

// last_discovery_status is derived server-side from the account's most recent
// discovery job (never_scanned | scanning | failed | ok) — never_scanned and
// scanning both read as "needs attention", the same bar mysql-servers' Warning
// bucket sets, since neither confirms the connection is actually healthy.
const bucketOf = (acc) => {
  const status = acc.last_discovery_status;
  if (status === 'ok') return 'online';
  if (status === 'failed') return 'offline';
  return 'warning';
};

// `provider` ('aws' | 'azure' | 'oci') comes in as a literal prop from the
// route definition (App.jsx), the same way DatabaseServersPage takes a
// `tech` prop per /{tech}-servers route, rather than a dynamic :provider
// param — each provider gets its own clean, bookmarkable URL.
export default function CloudProviderAccountsPage({ provider: slug }) {
  const navigate = useNavigate();
  const setDrawerOpen = useCloudStore((state) => state.setAddAccountDrawerOpen);
  const providerKey = keyFromSlug(slug) || slug;
  const meta = PROVIDER_META[providerKey] || { label: providerKey, color: '#64748b', bg: '#f1f5f9', logo: '☁️' };

  const { data: accounts } = useCloudAccounts();
  const { data: allResources } = useAllResources();
  const [search, setSearch] = useState('');
  const [envFilter, setEnvFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState(null);
  const [view, setView] = useState('list');

  const providerAccounts = (accounts || []).filter((a) => providerKeyOf(a.provider) === providerKey);
  const providerAccountIds = new Set(providerAccounts.map((a) => a.id));
  const totalResources = (allResources || []).filter((r) => providerAccountIds.has(r.account_id)).length;
  const onlineCount = providerAccounts.filter((a) => bucketOf(a) === 'online').length;
  const warningCount = providerAccounts.filter((a) => bucketOf(a) === 'warning').length;
  const offlineCount = providerAccounts.filter((a) => bucketOf(a) === 'offline').length;

  const KPI_CARDS = [
    {
      key: null,
      icon: null,
      logo: meta.logo,
      iconBg: meta.bg,
      iconColor: meta.color,
      label: 'Total',
      value: providerAccounts.length,
      sub: 'accounts',
      ring: 'ring-accent-soft',
    },
    {
      key: 'online',
      icon: 'check',
      iconBg: 'var(--success-soft)',
      iconColor: 'var(--success-fg)',
      label: 'Online',
      value: onlineCount,
      sub: 'last scan ok',
      ring: 'ring-success-soft',
    },
    {
      key: 'warning',
      icon: 'alert',
      iconBg: 'var(--warning-soft)',
      iconColor: 'var(--warning-fg)',
      label: 'Warning',
      value: warningCount,
      sub: 'needs attention',
      ring: 'ring-warning-soft',
    },
    {
      key: 'offline',
      icon: 'ban',
      iconBg: 'var(--danger-soft)',
      iconColor: 'var(--danger-fg)',
      label: 'Offline',
      value: offlineCount,
      sub: 'scan failed',
      ring: 'ring-danger-soft',
    },
    {
      key: null,
      icon: 'boxes',
      iconBg: 'var(--accent-soft)',
      iconColor: 'var(--accent-text)',
      label: 'Resources',
      value: totalResources,
      sub: 'discovered',
      ring: 'ring-accent-soft',
      clickable: false,
    },
  ];

  return (
    <>
      <CloudPageHeader
        title={meta.label || providerKey}
        description={`${providerAccounts.length} account${providerAccounts.length !== 1 ? 's' : ''} · pick one to view its dashboard`}
        backTo="/cloud"
        leading={(
          <div
            className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-xl"
            style={{ background: meta.bg, color: meta.color }}
          >
            {meta.logo}
          </div>
        )}
        actions={(
          <button
            onClick={() => setDrawerOpen(true)}
            className="flex h-control shrink-0 items-center gap-1.5 rounded-control bg-accent px-3.5 text-[13px] font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
          >
            <Plus size={15} /> Add Account
          </button>
        )}
      />

      {/* KPI cards — same click-to-filter card row mysql-servers uses (Total/Online/Warning/Offline), extended with a Resources card since Cloud has no cluster/HA-group concept */}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        {KPI_CARDS.map((card) => {
          const clickable = card.clickable !== false;
          const active = clickable && statusFilter === card.key;
          const Wrapper = clickable ? 'button' : 'div';
          return (
            <Wrapper
              key={card.label}
              type={clickable ? 'button' : undefined}
              onClick={clickable ? () => setStatusFilter((prev) => (prev === card.key ? null : card.key)) : undefined}
              className={`flex items-center gap-3 rounded-2xl border bg-surface px-4 py-3.5 text-left shadow-sm transition-all ${
                clickable ? 'hover:-translate-y-0.5 hover:shadow-md' : ''
              } ${active ? `border-transparent ring-2 ${card.ring}` : 'border-border'}`}
            >
              <div
                className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-lg"
                style={{ background: card.iconBg, color: card.iconColor }}
              >
                {card.logo ? card.logo : <Icon name={card.icon} size={18} />}
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wide text-subtle">{card.label}</p>
                <p className="text-2xl leading-none font-black text-fg">{card.value}</p>
                <p className="mt-0.5 truncate text-[10px] text-subtle">{card.sub}</p>
              </div>
            </Wrapper>
          );
        })}
      </div>

      {statusFilter && (
        <div className="-mt-4 mb-4 flex items-center gap-2">
          <span className="text-xs text-muted">
            Filtered by <b className="capitalize text-fg">{statusFilter}</b>
          </span>
          <button onClick={() => setStatusFilter(null)} className="text-xs font-bold text-accent-text hover:opacity-80">
            Clear
          </button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-1">
          {ENV_FILTERS.map((env) => (
            <button
              key={env}
              type="button"
              onClick={() => setEnvFilter(env)}
              className={`h-7 rounded-lg px-3.5 text-[11px] font-bold transition-all ${
                envFilter === env
                  ? 'bg-accent text-accent-fg shadow'
                  : 'text-subtle hover:bg-sunken hover:text-fg'
              }`}
            >
              {env}
            </button>
          ))}
        </div>

        {/* provider switcher — same role as mysql-servers' tech-switcher pills */}
        <div className="ml-2 flex flex-wrap items-center gap-1 border-l border-border pl-2">
          {Object.keys(PROVIDER_META).map((key) => {
            const pMeta = PROVIDER_META[key];
            const isActive = key === providerKey;
            return (
              <button
                key={key}
                type="button"
                onClick={() => navigate(`/cloud/${KEY_TO_SLUG[key]}-accounts`)}
                className={`flex h-7 items-center gap-1.5 rounded-lg border px-3 text-[11px] font-bold transition-all ${
                  isActive ? 'border-transparent text-white shadow' : 'border-border text-subtle hover:opacity-80'
                }`}
                style={isActive ? { background: pMeta.color } : undefined}
              >
                <span>{pMeta.logo}</span>
                <span className="hidden sm:inline">{key}</span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="min-w-[200px] max-w-xs flex-1">
            <CloudFilterBar
              search={search}
              onSearchChange={setSearch}
              searchPlaceholder={`Search ${providerKey} account name…`}
            />
          </div>
          <div className="flex rounded-xl bg-sunken p-0.5">
            {[['grid', LayoutGrid], ['list', List]].map(([v, Ico]) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                title={`${v} view`}
                className={`flex h-8 w-9 items-center justify-center rounded-lg transition-all ${
                  view === v ? 'bg-surface text-accent-text shadow-sm' : 'text-subtle hover:text-fg'
                }`}
              >
                <Ico size={15} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <CloudSection bodyClassName="p-0">
        <CloudAccountList
          search={search}
          providerFilter={providerKey}
          environmentFilter={envFilter}
          statusFilter={statusFilter}
          view={view}
        />
      </CloudSection>
    </>
  );
}
