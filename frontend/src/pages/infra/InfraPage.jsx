import { useEffect, useState } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import cn from '@/lib/cn';
import PageHeader from '@/components/layout/PageHeader';
import HeaderRefreshButton from '@/components/layout/HeaderRefreshButton';
import Icon from '@/components/ui/Icon';
import { PageLoading } from '@/components/ui/Loading';
import IconButton from '@/components/ui/IconButton';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Tabs from '@/components/ui/Tabs';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import Pagination, { pageCountOf, paginate } from '@/components/ui/Pagination';
import { useThemeStore } from '@/theme/themeStore';
import ChartCard from '@/components/charts/ChartCard';
import StatTile from '@/components/charts/StatTile';
import ScatterChart from '@/components/charts/ScatterChart';
import RecentAlertsPanel from '@/components/dashboard/RecentAlertsPanel';
import { STATUS, bandFor } from '@/components/charts/status';
import { engineColor } from '@/config/agents';
import { listOsServers, getServerSummary, getLiveStatus, refreshServerStatus } from '@/api/servers';
import { QK } from '@/api/queryKeys';
import { usePermissions } from '@/hooks/usePermissions';
import InfraHostCard, { hostLevel, hostStatus, osLabel, pctOf } from './InfraHostCard';
import InfraFleetOverview from './InfraFleetOverview';

const XTerminal = lazy(() => import('@/components/terminal/XTerminal'));

// Same list-view cell system as AgentsPage.jsx's own darkHeader table — kept
// identical (font size/weight/colour, not just the header band) so the two
// list views read as one consistent pattern rather than two different tables
// that merely share a header colour.
const CELL_SIZE = 'whitespace-nowrap text-[1rem] leading-[1.125rem]';
const CELL_TEXT = cn(CELL_SIZE, 'font-medium');
const CELL_TEXT_STYLE = { color: 'var(--agent-gray)' };
const STATUS_BADGE_COLORS = {
  success: { bg: 'var(--agent-green-soft)', fg: 'var(--agent-green-fg)' },
  danger: { bg: 'var(--agent-red-soft)', fg: 'var(--agent-red-fg)' },
  warning: { bg: 'var(--agent-yellow-soft)', fg: 'var(--agent-yellow-fg)' },
};

const REFRESH_SECONDS = 30;
const VIEW_STORAGE_KEY = 'actmon_infra_view';
const TOP_N = 6;

/** The four KPI cards, which double as the status filter — same idiom as Agents. */
const STAT_CARDS = [
  { key: 'all', label: 'Total Hosts', icon: 'server', tone: 'accent' },
  { key: 'online', label: 'Online', icon: 'check', tone: 'good' },
  { key: 'warning', label: 'Warning', icon: 'alert', tone: 'warning' },
  { key: 'offline', label: 'Offline', icon: 'close', tone: 'danger' },
];

/**
 * Infrastructure — every OS host ActMon watches, agent-collected or SSH-polled.
 *
 * Two tabs share one dataset: Overview reads the fleet as a whole (health,
 * utilisation, composition), Hosts is the filterable inventory the KPI cards,
 * search and engine/OS pills narrow down — the same split Dashboard and Agents
 * each use for their own module, applied here.
 */
export default function InfraPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { canHere } = usePermissions();

  // Tab is URL-driven: /infra = Overview, /infra/hosts = Hosts.
  const tab = location.pathname === '/infra/hosts' ? 'hosts' : 'overview';
  const setTab = (t) => navigate(t !== 'overview' ? `/infra/${t}` : '/infra');
  const [view, setView] = useState(() => {
    try { return localStorage.getItem(VIEW_STORAGE_KEY) || 'grid'; } catch { return 'grid'; }
  });
  const setViewMode = (v) => {
    setView(v);
    try { localStorage.setItem(VIEW_STORAGE_KEY, v); } catch { /* non-fatal */ }
  };

  const [search, setSearch] = useState('');
  const [envFilter, setEnvFilter] = useState('all');
  const [osFilter, setOsFilter] = useState('all');
  const [collectorFilter, setCollectorFilter] = useState('all');
  const [overviewServer, setOverviewServer] = useState('all');
  // ?status=online|warning|offline — the Monitoring Overview's Infra Hosts card
  // links here with it, and the KPI cards below keep it in the URL so a reload
  // or a shared link shows the same filtered list.
  const [searchParams, setSearchParams] = useSearchParams();
  const statusParam = ['online', 'warning', 'offline'].includes(searchParams.get('status')) ? searchParams.get('status') : 'all';
  const [statCard, setStatCardState] = useState(statusParam);
  const setStatCard = (next) => {
    setStatCardState(next);
    const params = new URLSearchParams(searchParams);
    if (next === 'all') params.delete('status'); else params.set('status', next);
    setSearchParams(params, { replace: true });
  };
  useEffect(() => { setStatCardState(statusParam); }, [statusParam]);
  // ?env= / ?os= (an OS label, e.g. Windows) / ?collector=agent|ssh|rac-peer — the Overview donuts link here with them
  const envParam = searchParams.get('env'); const osParam = searchParams.get('os'); const colParam = searchParams.get('collector');
  useEffect(() => { setEnvFilter(envParam || 'all'); }, [envParam]);
  useEffect(() => { setOsFilter(osParam ? `label:${osParam}` : 'all'); }, [osParam]);
  useEffect(() => { setCollectorFilter(colParam || 'all'); }, [colParam]);
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [terminalServer, setTerminalServer] = useState(null);

  // Paging — same pattern as ObjectTable.jsx / AgentsPage.jsx: the app-wide
  // `rowsPerPage` appearance setting is the default, overridable per-session
  // by the pager's own page-size control. Shared across grid and list views
  // so switching between them doesn't lose your place.
  const [page, setPage] = useState(1);
  const appPageSize = useThemeStore((s) => s.rowsPerPage);
  const [ownPageSize, setOwnPageSize] = useState(null);
  const pageSize = ownPageSize ?? appPageSize;

  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => (c <= 1 ? REFRESH_SECONDS : c - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const { data: serversData, isLoading, isFetching } = useQuery({
    queryKey: QK.osServers(), queryFn: () => listOsServers(), refetchInterval: 60000,
  });
  const { data: liveData } = useQuery({
    queryKey: ['liveStatus'], queryFn: getLiveStatus, refetchInterval: 15000, staleTime: 10000,
  });
  useQuery({ queryKey: QK.osServersSummary, queryFn: getServerSummary, refetchInterval: 30000 });

  const refreshMutation = useMutation({
    mutationFn: refreshServerStatus, onSuccess: () => qc.invalidateQueries({ queryKey: QK.osServers() }),
  });
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: QK.osServers() });
    qc.invalidateQueries({ queryKey: ['liveStatus'] });
    setCountdown(REFRESH_SECONDS);
  };

  /* ── merge live status onto the last full snapshot ─────────────────────── */
  const liveMap = {};
  for (const r of (liveData?.data || [])) liveMap[r.id] = r;
  // A 'rac-peer' is read by the agent on a sibling node; the live poller has no
  // route to it, so its "offline" is an absent opinion, not a reading — its own
  // collector's status stands (the same rule DatabaseServersPage and the
  // dashboard apply, so all three count the same hosts as online).
  const hosts = (serversData || []).map((s) => (liveMap[s.id] && s.collector !== 'rac-peer' ? { ...s, status: liveMap[s.id].os_status } : s));

  const counts = {
    total: hosts.length,
    online: hosts.filter((h) => hostLevel(h) === 'online').length,
    warning: hosts.filter((h) => hostLevel(h) === 'warning').length,
    offline: hosts.filter((h) => hostLevel(h) === 'offline').length,
  };
  const healthPct = counts.total ? Math.round((counts.online / counts.total) * 100) : 0;

  const environments = Array.from(new Set(hosts.map((h) => h.environment).filter(Boolean)));
  const osTypes = Array.from(new Set(hosts.map((h) => h.os_type).filter(Boolean)));

  /* Overview defaults to the whole fleet; picking one server here narrows
     every chart on the tab down to just that host, without touching the
     separate Hosts-tab filters above. */
  const serverOptions = [
    { id: 'all', label: 'All Servers' },
    ...hosts.map((h) => ({ id: String(h.id), label: h.server_name || h.hostname || `Host #${h.id}` })),
  ];
  const overviewHosts = overviewServer === 'all' ? hosts : hosts.filter((h) => String(h.id) === overviewServer);

  const onStatClick = (card) => {
    const next = statCard === card.key && card.key !== 'all' ? 'all' : card.key;
    setStatCardState(next);
    // One navigation carrying the filter (switching tab separately would drop ?status).
    navigate(`/infra/hosts${next !== 'all' ? `?status=${next}` : ''}`, { replace: tab === 'hosts' });
  };

  const openHost = (h) => navigate(`/infra/${h.id}`);

  /* ── Hosts tab: filter + sort ────────────────────────────────────────────── */
  const filtered = hosts
    .filter((h) => statCard === 'all' || hostLevel(h) === statCard)
    .filter((h) => envFilter === 'all' || h.environment === envFilter || (envFilter === 'Unassigned' && !h.environment))
    .filter((h) => osFilter === 'all' || (osFilter.startsWith('label:') ? (osLabel(h.os_type) === osFilter.slice(6) || h.os_type === osFilter.slice(6)) : h.os_type === osFilter))
    .filter((h) => collectorFilter === 'all' || (collectorFilter === 'agent' ? h.collector === 'agent' : collectorFilter === 'rac-peer' ? h.collector === 'rac-peer' : !['agent', 'rac-peer'].includes(h.collector)))
    .filter((h) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (h.server_name || '').toLowerCase().includes(q)
        || (h.hostname || '').toLowerCase().includes(q)
        || (h.ip_address || '').includes(search);
    });

  const hasFilters = search || envFilter !== 'all' || osFilter !== 'all' || collectorFilter !== 'all' || statCard !== 'all';
  const clearFilters = () => {
    setSearch(''); setEnvFilter('all'); setOsFilter('all'); setCollectorFilter('all'); setStatCardState('all');
    const params = new URLSearchParams(searchParams); ['status', 'env', 'os', 'collector'].forEach((k) => params.delete(k)); setSearchParams(params, { replace: true });
  };

  const columns = [
    { key: 'host', label: 'Host', sortable: true, sortKey: 'name', width: 280 },
    { key: 'os', label: 'OS', align: 'center', sortable: true, width: 110 },
    { key: 'environment', label: 'Environment', align: 'center', sortable: true, width: 140 },
    { key: 'collector', label: 'Collector', align: 'center', sortable: true, width: 110 },
    { key: 'cpu', label: 'CPU', align: 'center', sortable: true, width: 110 },
    { key: 'memory', label: 'Memory', align: 'center', sortable: true, width: 110 },
    { key: 'disk', label: 'Disk', align: 'center', sortable: true, width: 110 },
    { key: 'status', label: 'Status', align: 'center', sortable: true, width: 150 },
  ];

  const rows = filtered.map((h) => {
    const status = hostStatus(h);
    const cpu = pctOf(h.cpu_usage), ram = pctOf(h.ram_usage), disk = pctOf(h.disk_usage);
    return {
      key: h.id,
      onClick: () => openHost(h),
      sort: {
        name: h.server_name || h.hostname || '',
        os: osLabel(h.os_type),
        environment: h.environment || '',
        collector: h.collector || '',
        cpu, memory: ram, disk,
        status: status.label,
      },
      cells: {
        // Single line — "Name - Host", bold name / regular host suffix —
        // exactly AgentsPage.jsx's Agent/Host column, not a two-line stack.
        host: (
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-7 w-[3px] shrink-0 rounded-full" style={{ background: status.color }} aria-hidden="true" />
            <span
              className="truncate-safe min-w-0 text-[1rem] leading-[1.125rem]"
              title={h.hostname || h.ip_address ? `${h.server_name} - ${h.hostname || h.ip_address}` : h.server_name}
            >
              <span className="font-bold text-fg">{h.server_name}</span>
              {(h.hostname || h.ip_address) && (
                <span className="font-normal text-subtle"> - {h.hostname || h.ip_address}</span>
              )}
            </span>
          </div>
        ),
        os: <span className={CELL_TEXT} style={CELL_TEXT_STYLE}>{osLabel(h.os_type)}</span>,
        environment: <span className={CELL_TEXT} style={CELL_TEXT_STYLE}>{h.environment || '—'}</span>,
        collector: <span className={CELL_TEXT} style={CELL_TEXT_STYLE}>{h.collector === 'agent' ? 'Agent' : 'SSH'}</span>,
        cpu: <Utilisation value={cpu} />,
        memory: <Utilisation value={ram} />,
        disk: <Utilisation value={disk} />,
        // Fixed 178×48 pill, same dimensions/typography as AgentsPage.jsx's
        // Status column (Figma spec), just wearing this host's own tone.
        status: (
          <span className="inline-flex justify-center">
            <Badge
              tone={status.tone}
              size="xs"
              className="w-[11.125rem] justify-center gap-[0.625rem]"
              style={{
                height: '3rem',
                paddingTop: '0.25rem', paddingRight: '0.5rem', paddingBottom: '0.25rem', paddingLeft: '0.5rem',
                fontSize: '1rem', lineHeight: '1.125rem', fontWeight: 500,
                ...(STATUS_BADGE_COLORS[status.tone] && {
                  background: STATUS_BADGE_COLORS[status.tone].bg,
                  color: STATUS_BADGE_COLORS[status.tone].fg,
                }),
              }}
            >
              <Icon name={status.icon} size={9} strokeWidth={3} />
              {status.label}
            </Badge>
          </span>
        ),
      },
    };
  });

  const sort = { key: sortKey, dir: sortDir };
  const onSort = (key) => {
    const next = nextSort(sort, key);
    setSortKey(next.key);
    setSortDir(next.dir);
  };

  const pageCount = pageCountOf(filtered.length, pageSize);
  // Filtering/searching changes which rows exist, so the page the user was on
  // may no longer be there — clamp rather than reset to 1, so a list that
  // merely shrinks a little keeps their position (same as ObjectTable.jsx).
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const safePage = Math.min(page, pageCount);
  const pagedForGrid = paginate(filtered, safePage, pageSize);
  const pagedForList = paginate(sortRows(rows, sort), safePage, pageSize);
  const pager = filtered.length > 0 && (
    <Pagination
      page={safePage} pageCount={pageCount} total={filtered.length} pageSize={pageSize}
      onPage={setPage} onPageSize={setOwnPageSize} unit="hosts"
    />
  );

  return (
    <>
      <PageHeader
        title="Infrastructure"
        icon="server"
        hideBreadcrumbs
        description={`${counts.total} host${counts.total !== 1 ? 's' : ''} · ${healthPct}% online · live OS monitoring`}
        actions={<HeaderRefreshButton seconds={countdown} onClick={refreshAll} spinning={isFetching} />}
      />

      {/* Outside the header — one line shared by both tabs: the Overview-only
          Server filter on the left, the Overview/Hosts switch on the right. */}
      <div className="mb-gutter flex items-center gap-2">
        {tab === 'overview' && (
          <>
            <span className="text-[12px] font-semibold text-subtle">Server</span>
            <Select width="auto" value={overviewServer} onChange={setOverviewServer} options={serverOptions} />
            {overviewServer !== 'all' && (
              <Button variant="ghost" size="sm" icon="close" onClick={() => setOverviewServer('all')}>
                Clear
              </Button>
            )}
          </>
        )}
        <Tabs
          value={tab}
          onChange={setTab}
          className="ml-auto"
          tabs={[
            { id: 'overview', label: 'Overview', icon: 'activity' },
            { id: 'hosts', label: 'Hosts', icon: 'list', count: counts.total },
          ]}
        />
      </div>

      {isLoading ? (
        <PageLoading illustration />
      ) : tab === 'overview' ? (
        <InfraFleetOverview
          hosts={overviewHosts}
          counts={overviewServer === 'all' ? counts : {
            total: overviewHosts.length,
            online: overviewHosts.filter((h) => hostLevel(h) === 'online').length,
            warning: overviewHosts.filter((h) => hostLevel(h) === 'warning').length,
            offline: overviewHosts.filter((h) => hostLevel(h) === 'offline').length,
          }}
          serverId={overviewServer === 'all' ? null : Number(overviewServer)}
          loading={isFetching && !isLoading}
        />
      ) : (
        <>
          {/* ── KPI / filter cards ── */}
          <div className="grid grid-cols-2 gap-gutter sm:grid-cols-4">
            {STAT_CARDS.map((card) => {
              const active = statCard === card.key;
              const TONES = {
                accent: 'bg-accent-soft text-accent-text',
                good: 'bg-success-soft text-success-fg',
                warning: 'bg-warning-soft text-warning-fg',
                danger: 'bg-danger-soft text-danger-fg',
              };
              return (
                <button
                  key={card.key}
                  type="button"
                  onClick={() => onStatClick(card)}
                  aria-pressed={active}
                  className={cn(
                    'card flex items-center gap-3 px-card py-3 text-left transition-colors',
                    active ? 'border-accent-border bg-accent-softer' : 'hover:border-strong hover:bg-raised',
                  )}
                >
                  <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-md', TONES[card.tone])}>
                    <Icon name={card.icon} size={17} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[22px] leading-none font-bold text-fg">{card.key === 'all' ? counts.total : counts[card.key]}</span>
                    <span className="truncate-safe mt-1 block text-[11px] font-semibold text-muted">{card.label}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* ── controls ── */}
          <div className="mt-gutter flex flex-wrap items-center gap-2 lg:flex-nowrap">
            <Input
              icon="search"
              placeholder="Search host or IP…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClear={() => setSearch('')}
              wrapperClassName="w-full min-w-0 sm:w-auto sm:max-w-72 sm:flex-1"
            />
            <Select
              width="auto" value={envFilter} onChange={setEnvFilter}
              options={[{ id: 'all', label: 'All environments' }, ...environments.map((e) => ({ id: e, label: e })), ...(hosts.some((h) => !h.environment) ? [{ id: 'Unassigned', label: 'Unassigned' }] : [])]}
            />
            <Select
              width="auto" value={osFilter} onChange={setOsFilter}
              options={[{ id: 'all', label: 'All OS' }, ...osTypes.map((o) => ({ id: o, label: o })),
                ...Array.from(new Set(hosts.map((h) => osLabel(h.os_type)).filter(Boolean))).map((l) => ({ id: `label:${l}`, label: `${l} (all versions)` }))]}
            />
            <Select
              width="auto" value={collectorFilter} onChange={setCollectorFilter} aria-label="Collector"
              options={[{ id: 'all', label: 'All collectors' }, { id: 'agent', label: 'ActMon Agent' }, { id: 'ssh', label: 'SSH (poll)' }, { id: 'rac-peer', label: 'RAC peer' }]}
            />
            {statCard !== 'all' && (
              <Badge tone={statCard === 'online' ? 'success' : statCard === 'offline' ? 'danger' : 'warning'}>
                Status: {statCard === 'online' ? 'Online' : statCard === 'offline' ? 'Offline' : 'Warning'} · {filtered.length} of {hosts.length}
              </Badge>
            )}
            {hasFilters && <Button variant="ghost" size="sm" icon="close" onClick={clearFilters}>Clear</Button>}

            <div className="ml-auto flex shrink-0 items-center gap-2">
              <span className="hidden text-[12px] whitespace-nowrap text-subtle sm:block">
                {filtered.length} of {hosts.length}
              </span>
              <div className="flex overflow-hidden rounded-control border border-border">
                {[['grid', 'boxes', 'Grid'], ['list', 'rows', 'List']].map(([id, icon, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setViewMode(id)}
                    aria-pressed={view === id}
                    title={`${label} view`}
                    className={cn(
                      'flex h-control items-center gap-1.5 px-2.5 text-[12px] font-semibold transition-colors',
                      view === id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg',
                    )}
                  >
                    <Icon name={icon} size={13} />
                    <span className="hidden sm:inline">{label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── hosts ── */}
          <div className="mt-gutter">
            {filtered.length === 0 ? (
              <div className="card px-card py-14">
                <EmptyState
                  icon="server"
                  title={hosts.length === 0 ? 'No hosts registered' : 'No hosts match filters'}
                  body={hosts.length === 0
                    ? 'Add a host from the Databases hub or install the ActMon agent.'
                    : 'Try adjusting your search or filter criteria.'}
                  action={hosts.length > 0 && (
                    <Button size="sm" icon="close" onClick={clearFilters}>Clear filters</Button>
                  )}
                />
              </div>
            ) : view === 'grid' ? (
              <>
                <div className="grid grid-cols-1 gap-gutter sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {pagedForGrid.map((h) => (
                    <InfraHostCard
                      key={h.id}
                      host={h}
                      onOpen={openHost}
                      onTerminal={setTerminalServer}
                      onRefresh={refreshMutation.mutate}
                      refreshing={refreshMutation.isPending && refreshMutation.variables === h.id}
                      canExecute={canHere('execute')}
                    />
                  ))}
                </div>
                {pager && <div className="card mt-4">{pager}</div>}
              </>
            ) : (
              <>
                {/* No outer .card wrapper — same reason as the Agents list table:
                    darkHeader mode already renders each row as its own floating
                    rounded card on a plain backdrop. */}
                <Table
                  columns={columns}
                  rows={pagedForList}
                  sort={sort}
                  onSort={onSort}
                  rowHeight={64}
                  loading={isFetching && !isLoading}
                  empty={<EmptyState icon="server" title="No hosts match your filters." />}
                  darkHeader
                />
                {pager && <div className="card mt-4">{pager}</div>}
              </>
            )}
          </div>
        </>
      )}

      {/* ── SSH terminal ── */}
      {terminalServer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setTerminalServer(null)}>
          <div onClick={(e) => e.stopPropagation()} className="relative flex h-[70vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-[#0b1220] shadow-2xl">
            <div className="flex flex-shrink-0 items-center justify-between border-b border-white/10 px-4 py-2.5">
              <p className="flex items-center gap-2 text-sm font-bold text-white">
                <Icon name="terminal" size={14} className="text-emerald-400" /> {terminalServer.server_name} — SSH
              </p>
              <IconButton icon="close" label="Close" tone="chrome" size="sm" className="text-white" onClick={() => setTerminalServer(null)} />
            </div>
            <div className="min-h-0 flex-1">
              <Suspense fallback={<div className="grid h-full place-items-center"><Icon name="spinner" size={24} className="animate-spin text-emerald-400" /></div>}>
                <XTerminal serverId={terminalServer.id} serverName={terminalServer.server_name} height="100%" />
              </Suspense>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Overview
──────────────────────────────────────────────────────────────────────────── */

/**
 * Utilisation read-out for a table cell — identical to AgentsPage.jsx's own
 * Utilisation: banded colour, no bar, same size/weight as every other cell.
 */
function Utilisation({ value }) {
  const raw = Number(value);
  const reported = Number.isFinite(raw) && raw > 0;
  if (!reported) return <span className={CELL_TEXT}>—</span>;

  const pct = Math.min(Math.max(raw, 0), 100);
  const band = bandFor(pct);

  return (
    <span
      className={cn(CELL_SIZE, 'font-semibold')}
      style={{ color: band.color }}
      title={`${Math.round(pct)}% — ${band.label}`}
    >
      {Math.round(pct)}%
    </span>
  );
}
