import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client from '@/api/client';
import EngineDashboardHeader from '@/components/layout/EngineDashboardHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import { Panel, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtNumber } from '@/config/dbCatalog';
import { MSSQL_DASHBOARD_TABS, mssqlTabRoute } from '@/config/mssqlDashboardNav';

/**
 * SQL Server Wait Analysis — one evidence-based finding per wait type
 * (ASYNC_NETWORK_IO, CXPACKET/CXCONSUMER), a full ranked wait-stats reference
 * table, and the sp_configure values that drive them. Each wait type has its
 * own evaluator server-side (see mssql_wait_analysis_service.py's own
 * docstring for why this isn't a single generic evaluator).
 *
 * Read-only diagnosis, no approval workflow: every recommended action here
 * (client code, network, query design, server configuration) happens outside
 * this tool's scope, so there is nothing ActMon could safely execute on the
 * user's behalf.
 */

const STATUS_TONES = { healthy: 'success', monitor: 'info', warning: 'warning', critical: 'danger' };
const STATUS_LABELS = { healthy: 'Healthy', monitor: 'Monitor', warning: 'Warning', critical: 'Critical' };
const STATUS_RANK = { critical: 3, warning: 2, monitor: 1, healthy: 0 };

const WAIT_TYPE_META = {
  'ASYNC_NETWORK_IO': {
    icon: 'network',
    subtitle: 'Is a client slow to read result sets right now?',
  },
  'CXPACKET/CXCONSUMER': {
    icon: 'cpu',
    subtitle: 'Parallel query threads waiting on each other — common, not always a problem.',
  },
};

const fetchWaitAnalysis = (id) =>
  client.get(`/connections/mssql/${id}/mssql-wait-analysis`).then((r) => r.data);

export default function MSSQLWaitAnalysis() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [selectedType, setSelectedType] = useState(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['mssqlWaitAnalysis', id],
    queryFn: () => fetchWaitAnalysis(id),
    retry: false,
    refetchInterval: 30000,
  });

  const findings = useMemo(() => data?.findings || [], [data]);
  const allWaitStats = useMemo(() => data?.all_wait_stats || [], [data]);
  const config = useMemo(() => data?.config || [], [data]);
  const partialErrors = (data?.errors || []).filter(Boolean);

  // Default to the wait type most worth looking at (worst status first),
  // not just whichever came first in the list.
  useEffect(() => {
    if (!findings.length) return;
    if (selectedType && findings.some((f) => f.wait_type === selectedType)) return;
    const worst = [...findings].sort(
      (a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0),
    )[0];
    setSelectedType(worst.wait_type);
  }, [findings, selectedType]);

  const selectedFinding = findings.find((f) => f.wait_type === selectedType) || null;

  const header = (
    <>
      <EngineDashboardHeader
        tech="mssql"
        connectionId={id}
        tabs={MSSQL_DASHBOARD_TABS}
        activeTab="wait-analysis"
        onTabChange={(t) => navigate(mssqlTabRoute(id, t))}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-black text-fg">SQL Server Wait Analysis</h1>
          <p className="text-xs text-subtle">Pick a wait type below for the full evidence-based finding</p>
        </div>
        <Button variant="secondary" icon="refresh" loading={isFetching} onClick={() => refetch()}>
          Refresh
        </Button>
      </div>
    </>
  );

  if (isLoading) return <>{header}<PageLoading title="Reading sys.dm_os_wait_stats…" /></>;

  if (error || data?.status === 'error') {
    return (
      <>
        {header}
        <Notice tone="danger" title="Could not run wait analysis.">
          {data?.error || error?.message}
        </Notice>
        <Button variant="primary" icon="refresh" onClick={() => refetch()}>Retry</Button>
      </>
    );
  }

  return (
    <>
      {header}

      {partialErrors.length > 0 && (
        <Notice tone="warning" title="Some checks could not run.">
          {partialErrors.join(' · ')}
        </Notice>
      )}

      <div className="space-y-gutter">
        <div className="grid grid-cols-1 gap-gutter-sm sm:grid-cols-2">
          {findings.map((f) => (
            <WaitTypeCard
              key={f.wait_type}
              finding={f}
              selected={f.wait_type === selectedType}
              onClick={() => setSelectedType(f.wait_type)}
            />
          ))}
        </div>

        {selectedFinding && <WaitTypeDetail finding={selectedFinding} />}

        <AllWaitStatsPanel rows={allWaitStats} analyzedTypes={Object.keys(WAIT_TYPE_META)} />

        {config.length > 0 && <WaitConfigCards config={config} />}
      </div>
    </>
  );
}

/** One clickable card per implemented wait type — click to load its full
 * finding below. The color IS the status, so scanning the row tells you
 * what needs attention before reading a single word. */
function WaitTypeCard({ finding, selected, onClick }) {
  const meta = WAIT_TYPE_META[finding.wait_type] || {};
  const tone = STATUS_TONES[finding.status] || 'neutral';
  const stat = finding.stat || {};

  const TONE_RING = {
    success: 'border-success-border bg-success-soft/40',
    info: 'border-info-border bg-info-soft/40',
    warning: 'border-warning-border bg-warning-soft/40',
    danger: 'border-danger-border bg-danger-soft/40',
    neutral: 'border-border bg-surface',
  };
  const TONE_ICON = {
    success: 'text-success-fg', info: 'text-info-fg',
    warning: 'text-warning-fg', danger: 'text-danger-fg', neutral: 'text-subtle',
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col gap-2 rounded-card border p-card text-left transition-colors',
        TONE_RING[tone] || TONE_RING.neutral,
        selected ? 'ring-2 ring-accent' : 'hover:border-strong',
      )}
    >
      <span className="flex items-center gap-2">
        <Icon name={meta.icon || 'clock'} size={16} className={cn('shrink-0', TONE_ICON[tone])} />
        <span className="truncate text-[13px] font-bold text-fg">{finding.wait_type}</span>
        <Badge tone={tone} size="xs" className="ml-auto shrink-0">
          {STATUS_LABELS[finding.status] || finding.status}
        </Badge>
      </span>
      <span className="text-[11px] text-subtle">{meta.subtitle}</span>
      <span className="mt-1 flex items-center gap-4 text-[11px]">
        <span><b className="font-mono text-[13px] text-fg">{stat.pct_of_total_wait ?? 0}%</b> of wait time</span>
        <span><b className="font-mono text-[13px] text-fg">{finding.sessions_evaluated ?? 0}</b> waiting now</span>
      </span>
    </button>
  );
}

function WaitTypeDetail({ finding }) {
  const sessions = finding.sessions || [];
  const stat = finding.stat || {};
  const showWaitTypeColumn = finding.wait_type === 'CXPACKET/CXCONSUMER';

  return (
    <div className="space-y-gutter">
      <Panel
        title={`${finding.wait_type} — Finding`}
        icon={WAIT_TYPE_META[finding.wait_type]?.icon || 'clock'}
        actions={<Badge tone={STATUS_TONES[finding.status] || 'neutral'} size="sm">{STATUS_LABELS[finding.status] || finding.status}</Badge>}
      >
        <div className="space-y-3">
          <p className="text-[13px] font-semibold text-fg">{finding.problem}</p>

          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="% of total wait" value={`${stat.pct_of_total_wait ?? 0}%`} />
            <Stat label="Rank among waits" value={stat.rank != null ? `#${stat.rank}` : 'Not significant'} />
            <Stat label="Sessions waiting now" value={sessions.length} />
          </div>

          <div>
            <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">Evidence</p>
            <p className="text-[13px] text-muted">{finding.evidence}</p>
          </div>

          {finding.status !== 'healthy' && (
            <>
              <div>
                <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">Recommended action</p>
                <p className="text-[13px] text-muted">{finding.recommended_action}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">Expected benefit</p>
                  <p className="text-[12px] text-muted">{finding.expected_benefit}</p>
                </div>
                <div>
                  <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">Risk</p>
                  <p className="text-[12px] text-muted">{finding.risk}</p>
                </div>
              </div>
              {(stat.max_degree_of_parallelism != null || stat.cost_threshold_for_parallelism != null) && (
                <div className="flex flex-wrap gap-2">
                  {stat.max_degree_of_parallelism != null && (
                    <Badge tone={stat.max_degree_of_parallelism === 0 ? 'warning' : 'neutral'} size="xs">
                      MAXDOP: {stat.max_degree_of_parallelism}
                    </Badge>
                  )}
                  {stat.cost_threshold_for_parallelism != null && (
                    <Badge tone="neutral" size="xs">
                      Cost threshold: {stat.cost_threshold_for_parallelism}
                    </Badge>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Panel>

      <TablePanel
        title="Sessions currently waiting"
        icon="users"
        subtitle="Live — sys.dm_exec_sessions/requests, right now"
      >
        <Table
          columns={[
            { key: 'session', label: 'Session' },
            ...(showWaitTypeColumn ? [{ key: 'waitType', label: 'Wait Type' }] : []),
            { key: 'app', label: 'Client App' },
            { key: 'host', label: 'Host' },
            { key: 'db', label: 'Database' },
            { key: 'wait', label: 'Wait Time', align: 'right' },
            ...(showWaitTypeColumn ? [] : [{ key: 'rows', label: 'Last Rows Returned', align: 'right' }]),
            { key: 'query', label: 'Query' },
          ]}
          rows={sessions.map((s) => ({
            key: s.session_id,
            cells: {
              session: <span className="font-mono text-[12px]">{s.session_id} · {s.login_name}</span>,
              ...(showWaitTypeColumn ? { waitType: <Badge tone="neutral" size="xs">{s.wait_type}</Badge> } : {}),
              app: s.program_name || '—',
              host: s.host_name || '—',
              db: s.database_name || '—',
              wait: <span className="font-mono">{fmtNumber(s.wait_time_ms)} ms</span>,
              ...(showWaitTypeColumn ? {} : {
                rows: s.last_rows != null
                  ? <span className="font-mono">{fmtNumber(s.last_rows)}</span>
                  : <span className="text-subtle">unavailable</span>,
              }),
              query: (
                <span title={s.sql_text} className="truncate-safe block max-w-[280px] font-mono text-[11px]">
                  {s.sql_text || '—'}
                </span>
              ),
            },
          }))}
          empty={(
            <EmptyState
              icon="check"
              title={`No sessions currently waiting on ${finding.wait_type}`}
              body="This is a live, point-in-time check — a session that finishes between refreshes won't be listed here even if it waited moments ago."
            />
          )}
        />
      </TablePanel>

      {!showWaitTypeColumn && (
        <p className="flex items-start gap-1.5 text-[11px] text-subtle">
          <Icon name="info" size={12} className="mt-0.5 shrink-0" />
          &quot;Last rows returned&quot; comes from this query&apos;s own execution-stats cache (its last
          run, not this one) — a plan that has aged out of that cache shows as unavailable, not zero.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">{label}</p>
      <p className="font-mono text-[15px] font-bold text-fg">{value}</p>
    </div>
  );
}

/** pct → tone, same bands as the evaluators (>=30 critical / >=15 warning /
 * >=5 monitor / else healthy) so the reference table and the findings above
 * never disagree on what "significant" means. */
function pctTone(pct) {
  if (pct >= 30) return 'danger';
  if (pct >= 15) return 'warning';
  if (pct >= 5) return 'info';
  return 'neutral';
}

/** The full top-N ranking (not just the two evaluated wait types) — reference
 * data with no recommendation attached, so a DBA can see where the evaluated
 * types actually rank among everything else on this server. */
function AllWaitStatsPanel({ rows, analyzedTypes }) {
  const isAnalyzed = (waitType) => analyzedTypes.some((t) => t.split('/').includes(waitType));

  return (
    <TablePanel
      title="All wait statistics"
      icon="list"
      subtitle="Top wait types by accumulated time — sys.dm_os_wait_stats, idle/housekeeping waits excluded"
    >
      <Table
        columns={[
          { key: 'rank', label: '#' },
          { key: 'type', label: 'Wait Type' },
          { key: 'pct', label: '% of Total', align: 'right' },
          { key: 'tasks', label: 'Waiting Tasks', align: 'right' },
          { key: 'wait', label: 'Wait Time', align: 'right' },
          { key: 'signal', label: 'Signal Wait', align: 'right' },
        ]}
        rows={rows.map((r, i) => ({
          key: r.wait_type,
          cells: {
            rank: <span className="font-mono text-[11px] text-subtle">{i + 1}</span>,
            type: (
              <span className="flex items-center gap-1.5">
                <span className="font-mono text-[12px] text-fg">{r.wait_type}</span>
                {isAnalyzed(r.wait_type) && <Badge tone="accent" size="xs">Analyzed above</Badge>}
              </span>
            ),
            pct: (
              <span className="inline-flex items-center gap-2">
                <span className="h-1.5 w-16 overflow-hidden rounded-full bg-sunken">
                  <span
                    className={cn('block h-full rounded-full', {
                      danger: 'bg-danger', warning: 'bg-warning', info: 'bg-info', neutral: 'bg-subtle',
                    }[pctTone(r.pct)])}
                    style={{ width: `${Math.min(100, r.pct)}%` }}
                  />
                </span>
                <span className="font-mono text-[12px]">{r.pct}%</span>
              </span>
            ),
            tasks: <span className="font-mono">{fmtNumber(r.waiting_tasks_count)}</span>,
            wait: <span className="font-mono">{fmtNumber(r.wait_time_ms)} ms</span>,
            signal: <span className="font-mono">{fmtNumber(r.signal_wait_time_ms)} ms</span>,
          },
        }))}
        empty={<EmptyState icon="list" title="No significant waits" body="Nothing accumulated meaningful wait time since the last stats reset." />}
      />
    </TablePanel>
  );
}

/** sp_configure settings that directly shape which waits show up (and how bad
 * they get) — MAXDOP/cost threshold for CX*, worker/memory for THREADPOOL and
 * memory-pressure waits, blocked-process-threshold for lock-wait visibility.
 * Cards, not a table — this is reference material read one at a time, not
 * scanned/sorted like a data grid. */
function WaitConfigCards({ config }) {
  return (
    <Panel title="Wait Statistics Config" icon="settings" subtitle="sp_configure values that directly influence the wait types above">
      <div className="grid grid-cols-1 gap-gutter-sm sm:grid-cols-2 xl:grid-cols-3">
        {config.map((c) => {
          const flagged = c.name === 'max degree of parallelism' && c.value === 0;
          return (
            <div
              key={c.name}
              className={cn(
                'flex flex-col gap-1 rounded-card border p-card',
                flagged ? 'border-warning-border bg-warning-soft/40' : 'border-border bg-surface',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold tracking-wide text-subtle uppercase">{c.name}</span>
                {c.value != null ? (
                  <Badge tone={flagged ? 'warning' : 'neutral'} size="xs">{c.value}</Badge>
                ) : (
                  <Badge tone="outline" size="xs">unavailable</Badge>
                )}
              </span>
              <p className="text-[12px] text-muted">{c.description}</p>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
