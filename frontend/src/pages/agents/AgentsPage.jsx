import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import cn from '@/lib/cn';
import PageHeader from '@/components/layout/PageHeader';
import HeaderRefreshButton from '@/components/layout/HeaderRefreshButton';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Badge from '@/components/ui/Badge';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import Pagination, { pageCountOf, paginate } from '@/components/ui/Pagination';
import { useThemeStore } from '@/theme/themeStore';
import { bandFor } from '@/components/charts/status';
import useAgents, { computeAgentCounts, computeAgentOptions, filterAgents } from '@/hooks/useAgents';
import {
  AGENT_LEVEL_COLORS, LEVEL_COLORS, SORT_OPTIONS, STATUS_FILTERS, STAT_CARDS, TIMING, VIEW_MODES,
  VIEW_STORAGE_KEY, agentEngineColor, agentState, clusterBadge, engineOf, statusLevel,
} from '@/config/agents';
import { ago, fullTime, num } from '@/lib/format';
import { APP } from '@/config/app.config';
import AgentCard from './AgentCard';

/** KPI card accents — reference-matched, same --agent-* tokens as the pill
    filters below, so a colour means the same thing in both places on this
    page (e.g. green = online, wherever it appears). */
const STAT_CARD_COLORS = {
  all: 'var(--agent-blue)',
  online: 'var(--agent-green)',
  issues: 'var(--agent-orange)',
  offline: 'var(--agent-gray)',
};

/** Status pill fill/text, keyed by `agentState().tone` — fixed hexes (Figma:
    #DCFCE7/#15803D for "Online"), not the theme-adaptive Badge tones, so the
    pill reads the same regardless of the viewer's theme, matching every
    other colour on this page. */
const STATUS_BADGE_COLORS = {
  success: { bg: 'var(--agent-green-soft)', fg: 'var(--agent-green-fg)' },
  danger: { bg: 'var(--agent-red-soft)', fg: 'var(--agent-red-fg)' },
  warning: { bg: 'var(--agent-yellow-soft)', fg: 'var(--agent-yellow-fg)' },
};

/** The list view's shared 16px/18px-lh cell size (Figma "Cell"). Font-weight
    and colour are layered on top separately per column rather than folded
    in here — same-specificity Tailwind weight classes (font-medium vs
    font-semibold) aren't guaranteed to override one another by JSX order,
    so a column that needs its own weight (Utilisation's font-semibold) adds
    it alongside this rather than fighting a baked-in one. */
const CELL_SIZE = 'whitespace-nowrap text-[1rem] leading-[1.125rem]';
/** Default cell text — 16px/500/#6B7280 — for columns with no more specific
    typography of their own (the bold Agent/Host name, the coloured Status
    pill, and the banded CPU/Memory percentages each carry their own). */
const CELL_TEXT = cn(CELL_SIZE, 'font-medium');
/** `var(--agent-gray)` is the same #6B7280 pinned for the Environment
    column, so one token drives both. */
const CELL_TEXT_STYLE = { color: 'var(--agent-gray)' };

/**
 * Monitored systems.
 *
 * Same capabilities as the existing module — KPI cards that double as status
 * filters, search across name/host/IP/description, engine + status + environment
 * filters, grid and list views with the same sort choices, sync-from-connections,
 * and a 10s auto-refresh with a visible countdown.
 *
 * Everything visual is centralised in config/agents.js, so engine colours, state
 * tones, thresholds and the poll interval are configuration rather than literals
 * scattered through this file.
 */
export default function AgentsPage() {
  const navigate = useNavigate();
  const api = useAgents();

  /* This page shows only the physical host agent that's actually installed on
     a server. A single host agent can feed many database connections, and the
     backend auto-creates one row per connection (`has_connection: true`) to
     track that mapping — those rows are real and still power each database's
     own agent detail page (DatabaseAgentPage), but they are not separate
     installed agents, so they don't get their own row here. */
  const agents = useMemo(() => api.agents.filter((a) => !a.has_connection), [api.agents]);
  const counts = useMemo(() => computeAgentCounts(agents), [agents]);
  const options = useMemo(() => computeAgentOptions(agents), [agents]);

  const [view, setView] = useState(() => {
    try { return localStorage.getItem(VIEW_STORAGE_KEY) || 'grid'; } catch { return 'grid'; }
  });
  const setViewMode = (v) => {
    setView(v);
    try { localStorage.setItem(VIEW_STORAGE_KEY, v); } catch { /* non-fatal */ }
  };

  const [search, setSearch] = useState('');
  const [dbType, setDbType] = useState('all');
  const [status, setStatus] = useState('all');
  const [environment, setEnvironment] = useState('all');
  const [statCard, setStatCard] = useState('all');
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [showRegister, setShowRegister] = useState(false);

  // Paging — same pattern as ObjectTable.jsx: the app-wide `rowsPerPage`
  // appearance setting is the default, overridable per-session by the pager's
  // own page-size control. Shared across grid and list views so switching
  // between them doesn't lose your place.
  const [page, setPage] = useState(1);
  const appPageSize = useThemeStore((s) => s.rowsPerPage);
  const [ownPageSize, setOwnPageSize] = useState(null);
  const pageSize = ownPageSize ?? appPageSize;

  /* ── auto-refresh countdown (the query itself polls; this is the read-out) ── */
  const [countdown, setCountdown] = useState(TIMING.refreshSeconds);
  useEffect(() => {
    const t = setInterval(() => {
      setCountdown((c) => (c <= 1 ? TIMING.refreshSeconds : c - 1));
    }, 1000);
    return () => clearInterval(t);
  }, []);
  const refreshNow = () => { api.refresh(); setCountdown(TIMING.refreshSeconds); };

  const filtered = useMemo(
    () => filterAgents(agents, { search, dbType, status, environment, sortKey, sortDir }),
    [agents, search, dbType, status, environment, sortKey, sortDir],
  );

  const hasFilters = search || dbType !== 'all' || status !== 'all' || environment !== 'all';
  const clearFilters = () => {
    setSearch(''); setDbType('all'); setStatus('all'); setEnvironment('all'); setStatCard('all');
  };

  /** KPI card click sets the status filter, as in the existing list. */
  const onStatClick = (card) => {
    const next = statCard === card.key && card.key !== 'all' ? 'all' : card.key;
    setStatCard(next);
    setStatus(next === 'all' ? 'all' : (STAT_CARDS.find((c) => c.key === next)?.filter || 'all'));
  };

  const openAgent = (agent) => navigate(`/agents/${encodeURIComponent(agent.name)}`);

  /* ── list-view table ─────────────────────────────────────────────────────── */
  const columns = [
    { key: 'srNo', label: 'Sr. No.', align: 'center', width: 64 },
    { key: 'agent', label: 'Agent/Host', sortable: true, sortKey: 'name', width: 322 },
    { key: 'engine', label: 'Engine', align: 'center', sortable: true, width: 116 },
    { key: 'environment', label: 'Environment', align: 'center', sortable: true, width: 232 },
    { key: 'status', label: 'Status', align: 'center', sortable: true, width: 194 },
    { key: 'cpu', label: 'Agent CPU', align: 'center', sortable: true, width: 130 },
    { key: 'memory', label: 'Agent Host Memory', align: 'center', sortable: true, width: 150 },
    { key: 'sessions', label: 'Sessions', align: 'center', sortable: true, width: 90 },
    { key: 'seen', label: 'Last Seen', align: 'center', sortable: true, width: 104 },
  ];

  const rows = filtered.map((a) => {
    const state = agentState(a);
    const engine = engineOf(a.db_type);
    const level = statusLevel(a.status);
    const cpu = Number(a.agent_host_cpu) || 0;
    const memory = Number(a.agent_host_memory) || 0;

    return {
      key: a.name,
      onClick: () => openAgent(a),
      sort: {
        name: a.name || '',
        engine: engine.label,
        environment: a.environment || '',
        status: state.label,
        cpu,
        memory,
        sessions: Number(a.active_sessions) || 0,
        seen: a.last_heartbeat ? new Date(a.last_heartbeat).getTime() : 0,
      },
      cells: {
        srNo: null, // filled in after sorting — see `numberedRows` below
        agent: (
          <div className="flex min-w-0 items-center gap-2">
            {/* level accent, mirroring the grid card's left rule */}
            <span
              className="h-7 w-[3px] shrink-0 rounded-full"
              style={{ background: LEVEL_COLORS[level] }}
              aria-hidden="true"
            />
            {/* Single line — "Name - Host", bold name / regular host suffix —
                matching the reference's "Row 1 Hostname" text style exactly
                (one run, not the two stacked lines a generic list would use). */}
            <span
              className="truncate-safe min-w-0 text-[1rem] leading-[1.125rem]"
              title={a.hostname || a.ip_address ? `${a.name} - ${a.hostname || a.ip_address}` : a.name}
            >
              <span className="font-bold text-fg">{a.name}</span>
              {(a.hostname || a.ip_address) && (
                <span className="font-normal text-subtle"> - {a.hostname || a.ip_address}</span>
              )}
            </span>
          </div>
        ),
        engine: <span className={CELL_TEXT} style={CELL_TEXT_STYLE}>{engine.label}</span>,
        environment: (
          <span className={CELL_TEXT} style={CELL_TEXT_STYLE}>
            {a.environment || '—'}
          </span>
        ),
        status: (
          <span title={state.tip} className="inline-flex cursor-help justify-center">
            {/* Fixed 178×48 pill (Figma: "Row N Status container" — 60px
                radius, 4px/8px padding, 16px/500/18px-lh text). Every metric
                here is set inline rather than via Badge's own xs classes:
                same-specificity Tailwind utilities aren't guaranteed to
                override by JSX order, and the fixed fg/bg must win over
                Badge's theme-adaptive tone classes too. */}
            <Badge
              tone={state.tone}
              size="xs"
              className="w-[11.125rem] justify-center gap-[0.625rem]"
              style={{
                height: '3rem',
                paddingTop: '0.25rem', paddingRight: '0.5rem', paddingBottom: '0.25rem', paddingLeft: '0.5rem',
                fontSize: '1rem', lineHeight: '1.125rem', fontWeight: 500,
                ...(STATUS_BADGE_COLORS[state.tone] && {
                  background: STATUS_BADGE_COLORS[state.tone].bg,
                  color: STATUS_BADGE_COLORS[state.tone].fg,
                }),
              }}
            >
              {state.label}
            </Badge>
          </span>
        ),
        cpu: <Utilisation value={cpu} />,
        memory: <Utilisation value={memory} />,
        sessions: (
          <span className={CELL_TEXT} style={CELL_TEXT_STYLE}>
            {num(a.active_sessions)}
          </span>
        ),
        seen: (
          <span className={CELL_TEXT} style={CELL_TEXT_STYLE} title={fullTime(a.last_heartbeat)}>
            {a.last_heartbeat ? ago(a.last_heartbeat) : 'Never'}
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
  // Numbered in the table's OWN display order, not the pre-sort fetch order —
  // sorting by a column re-numbers 1..N, it doesn't carry each row's original
  // position along with it. Numbering happens BEFORE paging, so page 2 reads
  // 11, 12, … rather than resetting to 1 each page.
  const numberedRows = sortRows(rows, sort).map((r, i) => ({
    ...r, cells: { ...r.cells, srNo: <span className={cn(CELL_TEXT, 'tabular-nums')} style={CELL_TEXT_STYLE}>{i + 1}</span> },
  }));

  const pageCount = pageCountOf(filtered.length, pageSize);
  // Filtering/searching changes which rows exist, so the page the user was on
  // may no longer be there — clamp rather than reset to 1, so a list that
  // merely shrinks a little keeps their position (same as ObjectTable.jsx).
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const safePage = Math.min(page, pageCount);
  const pagedForGrid = paginate(filtered, safePage, pageSize);
  const pagedForList = paginate(numberedRows, safePage, pageSize);
  const pager = filtered.length > 0 && (
    <Pagination
      page={safePage} pageCount={pageCount} total={filtered.length} pageSize={pageSize}
      onPage={setPage} onPageSize={setOwnPageSize} unit="agents"
    />
  );

  return (
    <>
      <PageHeader
        title="Monitored Systems"
        hideBreadcrumbs
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {api.syncMessage && (
              <Badge tone={api.syncMessage.tone === 'success' ? 'success' : 'danger'}>
                {api.syncMessage.text}
              </Badge>
            )}
            {/* Registration always goes to the catalogue at /agents/setup — the
                empty state's button leads to the same place, so there is one
                answer to "how do I add an agent". Reference-matched: dark/black,
                not the app's blue accent, and first in the row. */}
            <Button
              variant="primary"
              icon="plus"
              onClick={() => navigate('/agents/setup')}
              className="hover:opacity-90"
              style={{ background: 'var(--agent-slate-900)', color: '#fff' }}
            >
              Register Agent
            </Button>
            <Button
              variant="secondary"
              icon="refresh"
              loading={api.isSyncing}
              onClick={() => api.sync()}
              title="Create agents from saved DB connections"
            >
              Sync
            </Button>
            <Button variant="secondary" icon="download" onClick={() => navigate('/agents/deploy')}>
              Deploy
            </Button>
            <HeaderRefreshButton seconds={countdown} onClick={refreshNow} spinning={api.isFetching} />
          </div>
        }
      />

      {api.error && (
        <div className="card mb-gutter flex items-start gap-3 px-card py-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-danger-soft text-danger-fg">
            <Icon name="alert" size={16} />
          </span>
          <div className="min-w-0">
            <p className="text-[0.8125rem] font-bold text-fg">Unable to reach the monitoring API</p>
            <p className="mt-0.5 text-[0.75rem] text-muted">
              {api.error.offline ? `No response from ${APP.apiBase}. Check the backend.` : api.error.message}
            </p>
          </div>
        </div>
      )}

      {/* ── KPI cards, which are also the status filter ──
          Figma-measured: 20px radius, 1px border (both exactly this app's own
          --radius-card / --border defaults, hence the plain `card` class),
          16px padding all round, 80px tall, 12px gap between the icon and the
          text. Circular icon badge, label, and the count on the SAME line,
          count pushed to the far right — not stacked under the label. */}
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        {STAT_CARDS.map((card) => {
          const active = statCard === card.key;
          const color = STAT_CARD_COLORS[card.key] || 'var(--agent-gray)';
          return (
            <button
              key={card.key}
              type="button"
              onClick={() => onStatClick(card)}
              aria-pressed={active}
              className="card flex h-20 items-center gap-3 p-4 text-left transition-colors"
              style={{ borderColor: active ? color : undefined, boxShadow: active ? `0 0 0 2px color-mix(in srgb, ${color} 20%, transparent)` : undefined }}
            >
              <span
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full"
                style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}
              >
                <Icon name={card.icon} size={18} />
              </span>
              <span className="truncate-safe min-w-0 flex-1 text-[0.8125rem] font-semibold text-fg">{card.label}</span>
              <span className="shrink-0 text-[1.625rem] leading-none font-black" style={{ color: active ? color : 'var(--fg)' }}>
                {counts[card.key]}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── controls: search + sort + view toggle, then the pill filters —
          one card, two internal rows, matching the reference's single
          continuous control panel. Figma-measured: 124px height, 15px radius
          (the app's other cards are 20px — this one panel is deliberately
          called out at 15px), 0.5px border in the exact grey the design
          specifies (not the theme's --border), 16px padding, 16px gap
          between the two internal rows, and the exact drop shadow rather
          than the app's own --shadow-xs. Background is --agent-row-bg (the
          same token the table rows use) so it stays pixel-white in light
          theme but still adapts everywhere else, per the earlier decision
          to make this page's fixed Figma colours theme-aware. */}
      <div
        className="mt-6 flex h-[7.75rem] flex-col gap-4 border bg-[var(--agent-row-bg)] p-4 shadow-[0_2px_4px_rgba(0,0,0,0.08)]"
        style={{ borderRadius: '15px', borderWidth: '0.5px', borderColor: 'var(--agent-border)' }}
      >
        <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
          <Input
            icon="search"
            placeholder="Search by name, hostname, IP…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClear={() => setSearch('')}
            wrapperClassName="w-full min-w-0 sm:w-auto sm:max-w-72 sm:flex-1"
            style={{ height: '2.75rem', borderRadius: '0.5rem', background: 'var(--agent-input-bg)' }}
          />
          {view === 'grid' && (
            <Select
              width="auto"
              value={`${sortKey}:${sortDir}`}
              onChange={(v) => { const [k, d] = v.split(':'); setSortKey(k); setSortDir(d); }}
              options={SORT_OPTIONS}
            />
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* view toggle — two separate pills, not a shared-border segmented
                control; the active one is the same dark slate the rest of this
                page's active states use, not the app's blue accent. */}
            {VIEW_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setViewMode(m.id)}
                aria-pressed={view === m.id}
                title={`${m.label} view`}
                className="flex h-control items-center gap-1.5 rounded-control border px-3 text-[0.75rem] font-semibold transition-colors"
                style={view === m.id
                  ? { background: 'var(--agent-slate-900)', color: '#fff', borderColor: 'var(--agent-slate-900)' }
                  : { background: 'var(--surface)', color: 'var(--fg-muted)', borderColor: 'var(--border)' }}
              >
                  <Icon name={m.icon} size={13} />
                  <span className="hidden sm:inline">{m.label}</span>
                </button>
              ))}
            </div>
          </div>
        <div className="flex flex-wrap items-center gap-2.5">
        <PillGroup
          label="Engine"
          options={options.dbTypes.map((t) => ({ id: t, label: t === 'all' ? 'All' : t, color: agentEngineColor(t) }))}
          value={dbType}
          onChange={setDbType}
        />
        <div className="h-4 w-px bg-border" aria-hidden="true" />
        <PillGroup
          label="Status"
          options={STATUS_FILTERS.map((s) => ({ id: s.id, label: s.label, color: AGENT_LEVEL_COLORS[s.id] || 'var(--agent-gray)' }))}
          value={status}
          onChange={(v) => { setStatus(v); setStatCard(v === 'all' ? 'all' : statCard); }}
        />
        <div className="h-4 w-px bg-border" aria-hidden="true" />
        <PillGroup
          label="Env"
          options={options.environments.map((e) => ({
            id: e, label: e === 'all' ? 'All' : e,
            color: e.toLowerCase() === 'production' ? 'var(--agent-amber)' : 'var(--agent-gray)',
          }))}
          value={environment}
          onChange={setEnvironment}
        />

        {hasFilters && (
          <Button variant="ghost" size="sm" icon="close" onClick={clearFilters}>Clear</Button>
        )}
        <span className="ml-auto text-[0.75rem] whitespace-nowrap text-subtle">
          {filtered.length} of {agents.length} agents
        </span>
        </div>
      </div>

      {/* ── the agents ── */}
      <div className="mt-6">
        {filtered.length === 0 ? (
          <div className="card px-card py-14">
            <EmptyState
              icon="agent"
              title={agents.length === 0 ? 'No agents registered' : 'No agents match filters'}
              body={agents.length === 0
                ? 'Register a database agent to start monitoring.'
                : 'Try adjusting your search or filter criteria.'}
              action={agents.length === 0 ? (
                <Button variant="primary" icon="plus" onClick={() => navigate('/agents/setup')}>
                  Register Your First Agent
                </Button>
              ) : (
                <Button size="sm" icon="close" onClick={clearFilters}>Clear filters</Button>
              )}
            />
          </div>
        ) : view === 'grid' ? (
          <>
            <div className="grid grid-cols-1 gap-gutter sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {pagedForGrid.map((agent) => (
                <AgentCard key={agent.name} agent={agent} onOpen={openAgent} />
              ))}
            </div>
            {pager && <div className="card mt-4">{pager}</div>}
          </>
        ) : (
          <>
            {/* No outer .card wrapper — the reference renders each row as its own
                floating rounded card on a plain backdrop, which Table's darkHeader
                mode already provides, rather than one bordered card holding a flat
                table. */}
            <Table
              columns={columns}
              rows={pagedForList}
              sort={sort}
              onSort={onSort}
              rowHeight={64}
              loading={api.isFetching && !api.isLoading}
              empty={<EmptyState icon="agent" title="No agents match your filters." />}
              darkHeader
            />
            {pager && <div className="card mt-4">{pager}</div>}
          </>
        )}
      </div>
    </>
  );
}

/**
 * One row of pill filter buttons — "Engine", "Status", "Env" in the reference
 * design. The group label is its own solid dark pill (not plain text), "All"
 * is always the accent blue regardless of which group it's in (it means
 * "everything", not a category), and every other option is coloured by its
 * own `color` — filled when active, a tinted outline otherwise.
 */
function PillGroup({ label, options, value, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        className="rounded-full px-2.5 py-1 text-[0.6875rem] font-bold whitespace-nowrap text-white"
        style={{ background: 'var(--agent-slate-900)' }}
      >
        {label}
      </span>
      {options.map((o) => {
        const active = value === o.id;
        const color = o.id === 'all' ? 'var(--agent-blue)' : (o.color || 'var(--agent-gray)');
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            aria-pressed={active}
            className="rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold capitalize transition-colors"
            style={active
              ? { background: color, color: '#fff', border: `1px solid ${color}` }
              : { background: 'var(--surface)', color: `color-mix(in srgb, ${color} 75%, var(--fg-muted))`, border: `1px solid color-mix(in srgb, ${color} 45%, transparent)` }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Utilisation read-out: plain colour-banded percentage, matching the
 * reference's list view exactly — no bar/track, just the number tinted by
 * the SHARED `bandFor` (not a local copy, so a reading means the same thing
 * here as it does everywhere else in the app).
 *
 * A host that reports nothing gets the dash alone. That's a different claim
 * from "measured, and it's zero".
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
