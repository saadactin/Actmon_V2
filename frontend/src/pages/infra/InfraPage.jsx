import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import cn from '@/lib/cn';
import PageHeader from '@/components/layout/PageHeader';
import HeaderRefreshButton from '@/components/layout/HeaderRefreshButton';
import Icon from '@/components/ui/Icon';
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
import { usePermissions } from '@/hooks/usePermissions';
import InfraHostCard, { hostLevel, hostStatus, osLabel, pctOf } from './InfraHostCard';

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
  const [overviewServer, setOverviewServer] = useState('all');
  const [statCard, setStatCard] = useState('all');
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
    queryKey: ['osServers', 'infra'], queryFn: () => listOsServers(), refetchInterval: 60000,
  });
  const { data: liveData } = useQuery({
    queryKey: ['liveStatus'], queryFn: getLiveStatus, refetchInterval: 15000, staleTime: 10000,
  });
  useQuery({ queryKey: ['serverSummary'], queryFn: getServerSummary, refetchInterval: 30000 });

  const refreshMutation = useMutation({
    mutationFn: refreshServerStatus, onSuccess: () => qc.invalidateQueries(['osServers']),
  });
  const refreshAll = () => {
    qc.invalidateQueries(['osServers']);
    qc.invalidateQueries(['liveStatus']);
    setCountdown(REFRESH_SECONDS);
  };

  /* ── merge live status onto the last full snapshot ─────────────────────── */
  const liveMap = {};
  for (const r of (liveData?.data || [])) liveMap[r.id] = r;
  const hosts = (serversData?.data || []).map((s) => (liveMap[s.id] ? { ...s, status: liveMap[s.id].os_status } : s));

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
    setStatCard(next);
    setTab('hosts');
  };

  const openHost = (h) => navigate(`/infra/${h.id}`);

  /* ── Hosts tab: filter + sort ────────────────────────────────────────────── */
  const filtered = hosts
    .filter((h) => statCard === 'all' || hostLevel(h) === statCard)
    .filter((h) => envFilter === 'all' || h.environment === envFilter)
    .filter((h) => osFilter === 'all' || h.os_type === osFilter)
    .filter((h) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (h.server_name || '').toLowerCase().includes(q)
        || (h.hostname || '').toLowerCase().includes(q)
        || (h.ip_address || '').includes(search);
    });

  const hasFilters = search || envFilter !== 'all' || osFilter !== 'all' || statCard !== 'all';
  const clearFilters = () => { setSearch(''); setEnvFilter('all'); setOsFilter('all'); setStatCard('all'); };

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
        <div className="grid place-items-center py-24">
          <Icon name="spinner" size={26} className="animate-spin text-subtle" />
        </div>
      ) : tab === 'overview' ? (
        <InfraOverview
          hosts={overviewHosts}
          counts={overviewServer === 'all' ? counts : {
            total: overviewHosts.length,
            online: overviewHosts.filter((h) => hostLevel(h) === 'online').length,
            warning: overviewHosts.filter((h) => hostLevel(h) === 'warning').length,
            offline: overviewHosts.filter((h) => hostLevel(h) === 'offline').length,
          }}
          onOpen={openHost}
          onDrill={onStatClick}
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
                    <span className="block text-[22px] leading-none font-bold text-fg">{counts[card.key]}</span>
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
              options={[{ id: 'all', label: 'All environments' }, ...environments.map((e) => ({ id: e, label: e }))]}
            />
            <Select
              width="auto" value={osFilter} onChange={setOsFilter}
              options={[{ id: 'all', label: 'All OS' }, ...osTypes.map((o) => ({ id: o, label: o }))]}
            />
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
 * Same colour per metric as Dashboard's "Average Resource Usage" card — one
 * host's CPU should read the same hue whether you're looking at the module
 * overview or this fleet-wide one.
 */
const RESOURCE_COLORS = { cpu: 'var(--chart-2)', ram: 'var(--chart-5)', disk: 'var(--chart-1)' };

/** Grey section band ("Health & Availability", "Resource Utilization", …) — same
    token-based pattern InfraHostDetail.jsx uses for its own overview groups, so
    the fleet-wide page reads as the same document family as the per-host one. */
function InfraOverview({ hosts, counts, onOpen, onDrill, loading }) {
  const avg = (key) => (hosts.length ? Math.round(hosts.reduce((s, h) => s + pctOf(h[key]), 0) / hosts.length) : 0);
  const avgCpu = avg('cpu_usage'), avgRam = avg('ram_usage'), avgDisk = avg('disk_usage');
  const availability = counts.total ? (counts.online / counts.total) * 100 : 0;
  const availabilityColor = availability >= 99 ? STATUS.good.color : availability >= 90 ? STATUS.warning.color : STATUS.critical.color;

  const statusItems = [
    { key: 'online', label: 'Online', value: counts.online, status: STATUS.good },
    { key: 'warning', label: 'Warning', value: counts.warning, status: STATUS.warning },
    { key: 'offline', label: 'Offline', value: counts.offline, status: STATUS.critical },
  ];

  const osGroups = hosts.reduce((m, h) => { const k = osLabel(h.os_type); m[k] = (m[k] || 0) + 1; return m; }, {});
  const winCount = osGroups.Windows || 0, linCount = osGroups.Linux || 0;

  const agentCount = hosts.filter((h) => h.collector === 'agent').length;
  const collectorItems = [
    { key: 'agent', label: 'ActMon Agent', value: agentCount },
    { key: 'ssh', label: 'SSH (poll)', value: counts.total - agentCount },
  ];

  const envGroups = hosts.reduce((m, h) => { const k = h.environment || 'Unassigned'; m[k] = (m[k] || 0) + 1; return m; }, {});
  const envItems = Object.entries(envGroups).map(([key, value]) => ({ key, label: key, value }));

  const svcCounts = {};
  hosts.forEach((h) => (Array.isArray(h.database_services) ? h.database_services : [])
    .forEach((s) => { svcCounts[s] = (svcCounts[s] || 0) + 1; }));
  const svcItems = Object.entries(svcCounts)
    .map(([label, value]) => ({ key: label, label, value, color: engineColor(label) }))
    .sort((a, b) => b.value - a.value);

  const resourceItems = [
    { key: 'cpu', label: 'CPU', value: avgCpu, color: RESOURCE_COLORS.cpu },
    { key: 'ram', label: 'Memory', value: avgRam, color: RESOURCE_COLORS.ram },
    { key: 'disk', label: 'Disk', value: avgDisk, color: RESOURCE_COLORS.disk },
  ];

  // Clickable rows: BarList already renders any item carrying onClick as a
  // real <button> (see BarList.jsx) — wiring this through is all a "Top Hosts"
  // bar needs to become a link to that host's own page.
  //
  // Offline hosts are excluded, not just dimmed: their cpu/ram/disk fields are
  // whatever was last reported before the host stopped reporting — frozen, not
  // live — so ranking them against currently-reporting hosts would compare a
  // real-time reading against a stale one that happens to still be a number.
  // "Warning" hosts stay in — a warning still means it's live and reporting,
  // just past a threshold.
  const rank = (key) => hosts
    .filter((h) => hostLevel(h) !== 'offline')
    .map((h) => ({ key: h.id, label: h.server_name || h.hostname || `Host #${h.id}`, value: pctOf(h[key]), onClick: () => onOpen(h) }))
    .sort((a, b) => b.value - a.value).slice(0, TOP_N)
    .map((h) => ({ ...h, status: bandFor(h.value) }));
  const topCpu = rank('cpu_usage'), topRam = rank('ram_usage'), topDisk = rank('disk_usage');

  // Same shape RecentAlertsPanel already renders — so "Needs Attention" reads
  // as literally the same component/format as Dashboard's alert feed, not a
  // lookalike copy that could drift out of sync with it.
  const attention = hosts.filter((h) => hostLevel(h) !== 'online');
  const attentionAlerts = attention.map((h) => ({
    id: h.id,
    source: h.server_name || h.hostname || `Host #${h.id}`,
    severity: hostLevel(h) === 'offline' ? 'critical' : 'warning',
    rule_name: h.ip_address || h.hostname,
    message: `${hostStatus(h).label} — ${h.ip_address || h.hostname || ''}`,
  }));
  const attentionCounts = {
    total: attention.length,
    critical: attention.filter((h) => hostLevel(h) === 'offline').length,
    warning: attention.filter((h) => hostLevel(h) === 'warning').length,
    info: 0,
  };

  // CPU vs memory across the fleet — bubble size is disk usage. Colour follows
  // the same STATUS scale as everywhere else, not a fourth chart-slot hue,
  // since what a reader needs from this dot is the SAME "online/warning/
  // offline" read as the rest of the page, not a new colour to learn.
  const scatterPoints = hosts.map((h) => ({
    x: pctOf(h.cpu_usage), y: pctOf(h.ram_usage), z: pctOf(h.disk_usage),
    label: h.server_name || h.hostname || `Host #${h.id}`,
    color: hostStatus(h).color,
    onClick: () => onOpen(h),
  }));

  // Same two heights Dashboard.jsx's own donut row / rank-and-gauge row use — an
  // explicit cap, not a stretch guess, so a card's size stays the SAME whichever
  // page it's read from rather than ballooning to match its tallest grid sibling.
  const DONUT_MIN_H = 'lg:min-h-[260px]';
  const RANK_MIN_H = 'lg:min-h-[316px]';

  const rankCard = (id, title, items, empty) => (
    <ChartCard
      cardId={id} family="flat" defaultKind="bar" items={items}
      chartProps={{ max: 100, unit: '%', format: (v) => Math.round(v), emptyLabel: empty }}
      title={title} titleNote={`(Top ${TOP_N})`}
      className={RANK_MIN_H}
      loading={loading}
      tableColumns={[
        { key: 'host', label: 'Host' },
        { key: 'value', label: 'Usage', align: 'right' },
        { key: 'band', label: 'Band', align: 'right' },
      ]}
      tableRows={items.map((h) => ({
        key: h.key,
        cells: {
          host: <button type="button" onClick={h.onClick} className="font-semibold text-accent-text hover:underline">{h.label}</button>,
          value: `${h.value}%`, band: h.status.label,
        },
      }))}
    />
  );

  const healthPct = counts.total ? Math.round((counts.online / counts.total) * 100) : 0;
  const healthTone = !counts.total ? 'neutral' : healthPct >= 90 ? 'good' : healthPct >= 60 ? 'warning' : 'danger';
  const osItems = [
    { key: 'windows', label: 'Windows', value: winCount },
    { key: 'linux', label: 'Linux', value: linCount },
  ];

  return (
    <div className="flex flex-col gap-gutter-lg">
      {/* headline counts — same shape/sizing as Dashboard.jsx's own KPI row */}
      <div className="grid grid-cols-2 gap-gutter-lg sm:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="Total Hosts" value={counts.total} icon="server" tone="neutral"
          sub={<b className="font-semibold text-success-fg">{healthPct}% Healthy</b>}
          onClick={() => onDrill?.({ key: 'all' })}
        />
        <StatTile
          label="Online" value={counts.online} icon="check" tone="good" valueTone="good"
          onClick={() => onDrill?.({ key: 'online' })}
        />
        <StatTile
          label="Warning" value={counts.warning} icon="alert" tone="warning" valueTone="warning"
          onClick={() => onDrill?.({ key: 'warning' })}
        />
        <StatTile
          label="Offline" value={counts.offline} icon="close" tone="danger" valueTone="danger"
          onClick={() => onDrill?.({ key: 'offline' })}
        />
        <StatTile
          label="Avg Resource Usage" value={`${Math.round((avgCpu + avgRam + avgDisk) / 3)}%`}
          icon="gauge" tone={healthTone} valueTone={healthTone}
          sub={`CPU ${avgCpu}% · RAM ${avgRam}% · Disk ${avgDisk}%`}
        />
      </div>

      {/* charts, with the alert feed running down the right — same shape as Dashboard.jsx */}
      <div className="grid gap-gutter-lg xl:grid-cols-4">
        <div className="flex flex-col gap-gutter-lg xl:col-span-3">
          {/* shape of the fleet: health, OS, environment, collector */}
          <div className="grid gap-gutter-lg lg:grid-cols-4">
            <ChartCard
              cardId="infra-host-status" family="flat" defaultKind="donut" items={statusItems}
              chartProps={{
                legend: 'below', size: 146, centerLabel: `${counts.total} Hosts`,
                emptyLabel: 'No hosts registered yet', labelWidth: 64,
              }}
              title="Host Status"
              className={DONUT_MIN_H}
              loading={loading}
              tableColumns={[{ key: 'status', label: 'Status' }, { key: 'hosts', label: 'Hosts', align: 'right' }]}
              tableRows={statusItems.map((s) => ({ key: s.key, cells: { status: s.label, hosts: s.value } }))}
              footer={
                <button type="button" onClick={() => onDrill?.({ key: 'warning' })} className="text-[12px] font-semibold text-accent-text hover:underline">
                  View hosts needing attention
                </button>
              }
            />

            <ChartCard
              cardId="infra-os-platform" family="flat" defaultKind="donut" items={osItems}
              chartProps={{
                legend: 'below', size: 146, centerLabel: `${counts.total} Hosts`,
                emptyLabel: 'No hosts registered yet', labelWidth: 64,
              }}
              title="OS Platform"
              className={DONUT_MIN_H}
              loading={loading}
              tableColumns={[{ key: 'os', label: 'OS' }, { key: 'hosts', label: 'Hosts', align: 'right' }]}
              tableRows={osItems.map((o) => ({ key: o.key, cells: { os: o.label, hosts: o.value } }))}
            />

            <ChartCard
              cardId="infra-environments" family="flat" defaultKind="donut" items={envItems}
              chartProps={{
                legend: 'below', size: 146, centerLabel: `${counts.total} Hosts`,
                emptyLabel: 'No hosts registered yet', labelWidth: 64,
              }}
              title="Environments"
              className={DONUT_MIN_H}
              loading={loading}
              tableColumns={[{ key: 'environment', label: 'Environment' }, { key: 'hosts', label: 'Hosts', align: 'right' }]}
              tableRows={envItems.map((e) => ({ key: e.key, cells: { environment: e.label, hosts: e.value } }))}
            />

            <ChartCard
              cardId="infra-collector" family="flat" defaultKind="donut" items={collectorItems}
              chartProps={{
                legend: 'below', size: 146, centerLabel: `${counts.total} Hosts`,
                emptyLabel: 'No hosts registered yet', labelWidth: 64,
              }}
              title="Collector"
              className={DONUT_MIN_H}
              loading={loading}
              tableColumns={[{ key: 'collector', label: 'Collector' }, { key: 'hosts', label: 'Hosts', align: 'right' }]}
              tableRows={collectorItems.map((c) => ({ key: c.key, cells: { collector: c.label, hosts: c.value } }))}
            />
          </div>

          {/* how hard it is working */}
          <div className="grid gap-gutter-lg lg:grid-cols-2">
            {rankCard('infra-top-cpu', 'Top Hosts By CPU', topCpu, 'No host is reporting CPU yet')}
            <ChartCard
              cardId="infra-resource-usage" family="ratio" defaultKind="gauge" items={resourceItems}
              title="Average Resource Usage"
              className={RANK_MIN_H}
              loading={loading}
              tableColumns={[{ key: 'resource', label: 'Resource' }, { key: 'used', label: 'Avg used', align: 'right' }, { key: 'band', label: 'Band', align: 'right' }]}
              tableRows={resourceItems.map((r) => ({ key: r.key, cells: { resource: r.label, used: `${r.value}%`, band: bandFor(r.value).label } }))}
            />
          </div>

          <div className="grid gap-gutter-lg lg:grid-cols-2">
            {rankCard('infra-top-ram', 'Top Hosts By Memory', topRam, 'No host is reporting memory yet')}
            {rankCard('infra-top-disk', 'Top Hosts By Disk', topDisk, 'No host is reporting disk yet')}
          </div>

          {/* availability and what's actually running */}
          <div className="grid gap-gutter-lg lg:grid-cols-2">
            <ChartCard
              cardId="infra-availability" family="ratio" defaultKind="gauge"
              items={[{ key: 'availability', label: 'Availability', value: availability, color: availabilityColor }]}
              chartProps={{ hint: `${counts.online} of ${counts.total} online` }}
              title="Availability"
              className={DONUT_MIN_H}
              loading={loading}
              tableColumns={[{ key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value', align: 'right' }]}
              tableRows={[{ key: 'availability', cells: { metric: 'Availability', value: `${availability.toFixed(1)}%` } }]}
            />
            <ChartCard
              cardId="infra-db-services" family="flat" defaultKind="bar" items={svcItems}
              chartProps={{ unit: '', format: (v) => v, emptyLabel: 'No database services on any host' }}
              title="Database Services"
              className={DONUT_MIN_H}
              loading={loading}
              tableColumns={[{ key: 'engine', label: 'Engine' }, { key: 'hosts', label: 'Hosts', align: 'right' }]}
              tableRows={svcItems.map((s) => ({ key: s.key, cells: { engine: s.label, hosts: s.value } }))}
            />
          </div>

          <section className="card flex flex-col">
            <header className="px-card pt-card pb-3">
              <h2 className="text-[17px] font-bold text-fg">CPU vs Memory — all hosts</h2>
              <p className="mt-0.5 text-[11px] text-subtle">Bubble size = disk usage</p>
            </header>
            <div className="px-card pb-card">
              <ScatterChart
                points={scatterPoints}
                xLabel="CPU" yLabel="Memory" height={220}
                emptyLabel="No hosts to plot yet"
              />
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {[STATUS.good, STATUS.warning, STATUS.critical].map((s) => (
                  <span key={s.id} className="inline-flex items-center gap-1.5 text-[10px] font-medium text-subtle">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden="true" />
                    {s.label}
                  </span>
                ))}
              </div>
            </div>
          </section>
        </div>

        <RecentAlertsPanel
          title="Needs Attention"
          actionLabel="View Hosts"
          alerts={attentionAlerts}
          counts={attentionCounts}
          onOpenAll={() => onDrill?.({ key: 'warning' })}
        />
      </div>
    </div>
  );
}

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
