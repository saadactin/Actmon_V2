import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import ChartCard from '@/components/charts/ChartCard';
import { STATUS } from '@/components/charts/status';
import Badge, { LiveBadge } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import TrendChart from '@/components/gauges/TrendChart';
import { InlineLoading, PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { MetricTile, Panel, SqlBlock, SqlCell, StatCell, StateChip, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtNumber } from '@/config/dbCatalog';
import { WAIT_CLASS_TONES, explainWait, isIdleWait } from '@/config/oracleWaits';

/**
 * Live Oracle sessions — what is running right now, what each one is waiting on,
 * and why that matters.
 *
 * Refreshes every 5 seconds rather than the dashboard's 15: this is the view
 * someone opens when the database is misbehaving, and a five-second-old picture of
 * "what is running" is already stale.
 *
 * Selecting a row fetches that statement's execution plan on demand. Plans are
 * cached per sql_id for the life of the page — the plan for a given sql_id does not
 * change, so re-fetching it on every expand would be pure waste.
 *
 * Renders standalone or `embedded` as the dashboard's Live Queries tab.
 */

const REFRESH_MS = 5000;
const num = (v) => Number(v) || 0;

const SESSION_TONES = { ACTIVE: 'success', INACTIVE: 'neutral', KILLED: 'danger', SNIPED: 'warning' };

/** Seconds since the session last did anything, as something readable. */
export function fmtIdle(seconds) {
  const s = num(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** How long a session has been waiting, banded the way a DBA would read it. */
export function waitBand(seconds) {
  const s = num(seconds);
  if (s >= 30) return { label: '30s+', status: STATUS.critical };
  if (s >= 5) return { label: '5–30s', status: STATUS.serious };
  if (s >= 1) return { label: '1–5s', status: STATUS.warning };
  return { label: 'under 1s', status: STATUS.good };
}

export default function OracleLiveQueries({ connId, embedded = false }) {
  const params = useParams();
  const id = connId || params.id;

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [expanded, setExpanded] = useState(null);
  const [plans, setPlans] = useState({});
  const [planBusy, setPlanBusy] = useState({});
  const [countdown, setCountdown] = useState(REFRESH_MS / 1000);
  const [history, setHistory] = useState([]);
  const countRef = useRef(null);

  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['oracleLiveQueries', id],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-live-queries`).then((r) => r.data),
    refetchInterval: REFRESH_MS,
    retry: false,
  });

  useEffect(() => {
    setCountdown(REFRESH_MS / 1000);
    clearInterval(countRef.current);
    countRef.current = setInterval(
      () => setCountdown((c) => (c <= 1 ? REFRESH_MS / 1000 : c - 1)),
      1000,
    );
    return () => clearInterval(countRef.current);
  }, [dataUpdatedAt]);

  /* A short rolling history, so a spike is visible rather than having to be caught
     in the instant it happens. */
  useEffect(() => {
    if (!data) return;
    const rows = data.queries || [];
    const t = new Date().toLocaleTimeString();
    setHistory((prev) => [...prev.slice(-29), {
      t,
      active: rows.filter((r) => r.status === 'ACTIVE').length,
      waiting: rows.filter((r) => !isIdleWait(r.wait_event, r.wait_class)).length,
    }]);
  }, [data]);

  const fetchPlan = useCallback(async (sqlId) => {
    if (!sqlId || plans[sqlId]) return;
    setPlanBusy((b) => ({ ...b, [sqlId]: true }));
    try {
      const res = await client.get(`/connections/oracle/${id}/oracle-sql-plan`, { params: { sql_id: sqlId } });
      setPlans((p) => ({ ...p, [sqlId]: res.data }));
    } catch (e) {
      setPlans((p) => ({ ...p, [sqlId]: { error: e?.message || 'The plan could not be read.' } }));
    } finally {
      setPlanBusy((b) => ({ ...b, [sqlId]: false }));
    }
  }, [id, plans]);

  const toggle = (key, sqlId) => {
    if (expanded === key) { setExpanded(null); return; }
    setExpanded(key);
    if (sqlId) fetchPlan(sqlId);
  };

  const rows = data?.queries || [];

  const stats = useMemo(() => {
    const active = rows.filter((r) => r.status === 'ACTIVE');
    const waiting = active.filter((r) => !isIdleWait(r.wait_event, r.wait_class));
    return {
      total: rows.length,
      active: active.length,
      inactive: rows.filter((r) => r.status === 'INACTIVE').length,
      blocked: rows.filter((r) => r.blocking_session).length,
      waiting: waiting.length,
      longestWait: rows.length ? Math.max(0, ...rows.map((r) => num(r.seconds_in_wait))) : 0,
      byClass: Object.entries(active.reduce((acc, r) => {
        const k = r.wait_class || (r.wait_event ? 'Other' : 'CPU');
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {})).map(([label, value]) => ({ key: label, label, value })),
      byBand: (() => {
        const bands = [
          { key: 'under 1s', label: 'under 1s', status: STATUS.good, value: 0 },
          { key: '1–5s', label: '1–5s', status: STATUS.warning, value: 0 },
          { key: '5–30s', label: '5–30s', status: STATUS.serious, value: 0 },
          { key: '30s+', label: '30s+', status: STATUS.critical, value: 0 },
        ];
        active.forEach((r) => {
          const b = waitBand(r.seconds_in_wait);
          const hit = bands.find((x) => x.key === b.label);
          if (hit) hit.value += 1;
        });
        return bands;
      })(),
    };
  }, [rows]);

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== 'ALL' && r.status !== statusFilter) return false;
      if (!term) return true;
      return [r.username, r.machine, r.program, r.module, r.sql_id, r.sql_text]
        .some((v) => String(v || '').toLowerCase().includes(term));
    });
  }, [rows, search, statusFilter]);

  const header = embedded ? null : (
    <PageHeader
      title="Oracle Live Queries"
      description="Every user session right now, what it is waiting on, and its execution plan"
      icon="activity"
      backTo={`/oracle-dashboard/${id}`}
      actions={(
        <>
          <LiveBadge label={`refresh in ${countdown}s`} tone="success" />
          <Button variant="secondary" icon="refresh" loading={isFetching} onClick={() => refetch()}>
            Refresh
          </Button>
        </>
      )}
    />
  );

  if (isLoading) return <>{header}<PageLoading title="Reading live sessions…" /></>;

  if (error || data?.status === 'error') {
    return (
      <>
        {header}
        <Notice tone="danger" title="Could not read live sessions.">
          {data?.error || error?.message}
        </Notice>
        <Button variant="primary" icon="refresh" onClick={() => refetch()}>Retry</Button>
      </>
    );
  }

  return (
    <>
      {header}

      <div className="space-y-gutter">
        <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-3 xl:grid-cols-6">
          <MetricTile label="Sessions" value={stats.total} icon="users" />
          <MetricTile label="Active" value={stats.active} icon="activity" tone="good"
            onClick={() => setStatusFilter(statusFilter === 'ACTIVE' ? 'ALL' : 'ACTIVE')} />
          <MetricTile label="Idle" value={stats.inactive} icon="clock"
            onClick={() => setStatusFilter(statusFilter === 'INACTIVE' ? 'ALL' : 'INACTIVE')} />
          <MetricTile label="Waiting" value={stats.waiting} icon="clock"
            tone={stats.waiting ? 'warn' : 'good'}
            hint="Active sessions on a non-idle wait event" />
          <MetricTile label="Blocked" value={stats.blocked} icon="lock"
            tone={stats.blocked ? 'bad' : 'good'}
            hint="Waiting for a lock another session holds — these cannot proceed on their own" />
          <MetricTile label="Longest wait" value={`${fmtNumber(stats.longestWait)}s`} icon="trend"
            tone={stats.longestWait >= 30 ? 'bad' : stats.longestWait >= 5 ? 'warn' : 'neutral'} />
        </div>

        {stats.blocked > 0 && (
          <Notice tone="danger" title={`${stats.blocked} session${stats.blocked === 1 ? ' is' : 's are'} blocked.`}>
            {rows.filter((r) => r.blocking_session).slice(0, 3).map((r) => (
              `SID ${r.sid} is waiting on SID ${r.blocking_session}`
            )).join(' · ')}. The holder has to commit or roll back — nothing about the blocked
            statement can be tuned to fix this.
          </Notice>
        )}

        <div className="grid gap-gutter xl:grid-cols-3">
          <ChartCard
            cardId="oracle-live-waitclass"
            family="flat"
            items={stats.byClass}
            chartProps={{ labelWidth: 120, emptyLabel: 'Nothing is active right now' }}
            title="Active sessions by wait class"
            icon="chart-pie"
            subtitle="What the busy sessions are doing"
            loading={isFetching}
            tableColumns={[
              { key: 'class', label: 'Wait class' },
              { key: 'count', label: 'Sessions', align: 'right' },
            ]}
            tableRows={stats.byClass.map((c) => ({
              key: c.key, cells: { class: c.label, count: c.value },
            }))}
          />

          <ChartCard
            cardId="oracle-live-bands"
            family="flat"
            items={stats.byBand}
            chartProps={{ labelWidth: 80, emptyLabel: 'Nothing is active right now' }}
            title="How long they have been waiting"
            icon="clock"
            subtitle="Active sessions by wait duration"
            loading={isFetching}
            tableColumns={[
              { key: 'band', label: 'Waiting for' },
              { key: 'count', label: 'Sessions', align: 'right' },
            ]}
            tableRows={stats.byBand.map((b) => ({
              key: b.key, cells: { band: b.label, count: b.value },
            }))}
          />

          <Panel title="Recent activity" icon="trend"
            subtitle={history.length > 2 ? 'Since this page opened' : undefined}>
            {history.length > 2 ? (
              <TrendChart
                data={history}
                series={[{ key: 'active', label: 'active' }, { key: 'waiting', label: 'waiting' }]}
                height={160}
                yDomain={['auto', 'auto']}
              />
            ) : (
              <p className="py-6 text-center text-[12px] text-subtle">
                Building up — the first points appear after the next {REFRESH_MS / 1000}-second refresh.
              </p>
            )}
          </Panel>
        </div>

        <TablePanel
          title={`Sessions (${shown.length}${shown.length === rows.length ? '' : ` of ${rows.length}`})`}
          icon="users"
          subtitle="Active first, then by how long they have been waiting. Select a row for its execution plan."
          actions={(
            <>
              {embedded && <LiveBadge label={`${countdown}s`} tone="success" />}
              <span className="flex items-center gap-0.5 rounded-control border border-border p-0.5">
                {[['ALL', `All ${rows.length}`], ['ACTIVE', `Active ${stats.active}`], ['INACTIVE', `Idle ${stats.inactive}`]].map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setStatusFilter(k)}
                    aria-pressed={statusFilter === k}
                    className={cn(
                      'h-7 rounded-control px-2.5 text-[11px] font-bold transition-colors',
                      statusFilter === k ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </span>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onClear={() => setSearch('')}
                placeholder="User, host, SQL…"
                icon="search"
                size="sm"
                wrapperClassName="w-44"
              />
            </>
          )}
        >
          <Paged rows={shown} unit="sessions">
            {(page, pager) => (
              <>
                <Table
                  columns={[
                    { key: 'sid', label: 'SID' },
                    { key: 'user', label: 'User' },
                    { key: 'status', label: 'Status' },
                    { key: 'client', label: 'Client' },
                    { key: 'wait', label: 'Waiting on' },
                    { key: 'secs', label: 'For', align: 'right' },
                    { key: 'idle', label: 'Last call', align: 'right' },
                    { key: 'sql', label: 'Statement' },
                  ]}
                  rows={page.map((r, i) => {
                    const key = `${r.sid}-${r.serial_number}-${i}`;
                    const band = waitBand(r.seconds_in_wait);
                    return {
                      key,
                      onClick: () => toggle(key, r.sql_id),
                      cells: {
                        sid: (
                          <span className="flex items-center gap-1.5">
                            <Icon name={expanded === key ? 'chevron-down' : 'chevron-right'} size={12} className="text-subtle" />
                            <span className="font-mono text-[12px] font-semibold">
                              {r.sid}<span className="text-subtle">,{r.serial_number}</span>
                            </span>
                          </span>
                        ),
                        user: (
                          <span className="block text-[11px] leading-tight">
                            <span className="truncate-safe block max-w-[110px] text-[12px] font-semibold text-accent-text">
                              {r.username}
                            </span>
                            {r.osuser && <span className="truncate-safe block max-w-[110px] text-subtle">{r.osuser}</span>}
                          </span>
                        ),
                        status: <StateChip value={r.status} tones={SESSION_TONES} />,
                        client: (
                          <span className="block text-[11px] leading-tight">
                            <span className="truncate-safe block max-w-[130px] font-mono text-muted">{r.machine || '—'}</span>
                            <span className="truncate-safe block max-w-[130px] text-subtle">{r.module || r.program || ''}</span>
                          </span>
                        ),
                        wait: (
                          <span className="block">
                            <span className="flex items-center gap-1.5">
                              {r.wait_event
                                ? <span className="truncate-safe max-w-[180px] font-mono text-[11px] text-fg">{r.wait_event}</span>
                                : <span className="text-[11px] text-success-fg">On CPU</span>}
                              {r.wait_class && (
                                <Badge tone={WAIT_CLASS_TONES[r.wait_class] || 'neutral'} size="xs">{r.wait_class}</Badge>
                              )}
                            </span>
                            {r.blocking_session && (
                              <Badge tone="danger" size="xs" className="mt-0.5">
                                blocked by SID {r.blocking_session}
                              </Badge>
                            )}
                          </span>
                        ),
                        secs: (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="font-mono">{fmtNumber(r.seconds_in_wait)}s</span>
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{ background: band.status.color }} title={`Waiting ${band.label}`} />
                          </span>
                        ),
                        idle: <span className="font-mono text-[11px] text-muted">{fmtIdle(r.last_call_et)}</span>,
                        sql: (
                          <span className="block">
                            <SqlCell sql={r.sql_text} max={90} />
                            {r.sql_id && <span className="mt-0.5 block font-mono text-[10px] text-subtle">{r.sql_id}</span>}
                          </span>
                        ),
                      },
                    };
                  })}
                  empty={rows.length ? (
                    <EmptyState icon="filter" title="No matches"
                      body="No session matches the current filter." />
                  ) : (
                    <EmptyState icon="users" title="No user sessions"
                      body="Nothing is connected to this instance apart from background processes." />
                  )}
                />

                {page.map((r, i) => {
                  const key = `${r.sid}-${r.serial_number}-${i}`;
                  if (expanded !== key) return null;
                  return (
                    <div key={key} className="border-t border-border bg-sunken px-card py-3">
                      <SessionDetail
                        session={r}
                        plan={plans[r.sql_id]}
                        planBusy={planBusy[r.sql_id]}
                      />
                    </div>
                  );
                })}
                {pager}
              </>
            )}
          </Paged>
        </TablePanel>
      </div>
    </>
  );
}

/* ── one session, expanded ─────────────────────────────────────────────────── */

function SessionDetail({ session: s, plan, planBusy }) {
  const k = explainWait(s.wait_event, s.wait_class);
  const sql = s.sql_fulltext || s.sql_text || '';

  return (
    <div className="space-y-gutter">
      <div className="grid gap-gutter-sm sm:grid-cols-3 xl:grid-cols-6">
        <StatCell label="Executions" value={fmtNumber(s.executions)} />
        <StatCell label="Avg elapsed" value={`${fmtNumber(s.avg_elapsed_ms)} ms`} />
        <StatCell label="Avg CPU" value={`${fmtNumber(s.avg_cpu_ms)} ms`} />
        <StatCell label="Buffer gets" value={fmtNumber(s.buffer_gets)} />
        <StatCell label="Disk reads" value={fmtNumber(s.disk_reads)}
          tone={num(s.disk_reads) > num(s.buffer_gets) * 0.1 ? 'warn' : 'neutral'}
          hint="High against buffer gets means it is reading from disk, not cache" />
        <StatCell label="Connected since" value={s.logon_time || '—'} />
      </div>

      {/* The wait explanation is the point of this view: a session's event name
          without its meaning tells an operator nothing actionable. */}
      <Notice
        tone={k.tone === 'danger' ? 'danger' : k.tone === 'warning' ? 'warning' : 'info'}
        className="mb-0"
        title={`${k.label}${s.wait_event ? ` — ${s.wait_event}` : ''}.`}
      >
        {k.why} <b className="block pt-1">What to do: {k.action}</b>
      </Notice>

      {sql ? (
        <Panel title="Statement" icon="terminal"
          subtitle={s.sql_id ? `sql_id ${s.sql_id}` : undefined}
          actions={<CopyButton text={sql} />}
        >
          <SqlBlock sql={sql} className="max-h-64 overflow-auto" />
        </Panel>
      ) : (
        <p className="text-[12px] text-subtle">
          This session has no current statement — it is connected but idle.
        </p>
      )}

      {s.sql_id && (
        <TablePanel title="Execution plan" icon="layers"
          subtitle={plan?.sql_stats?.optimizer_mode
            ? `Optimiser mode ${plan.sql_stats.optimizer_mode}, cost ${fmtNumber(plan.sql_stats.optimizer_cost)}`
            : 'v$sql_plan for this sql_id'}>
          {planBusy ? (
            <div className="px-card"><InlineLoading label="Reading the plan…" /></div>
          ) : plan?.error ? (
            <p className="px-card py-4 text-[12px] text-muted">{plan.error}</p>
          ) : (
            <>
              <Table
                columns={[
                  { key: 'op', label: 'Operation' },
                  { key: 'object', label: 'Object' },
                  { key: 'cost', label: 'Cost', align: 'right' },
                  { key: 'rows', label: 'Est. rows', align: 'right' },
                  { key: 'bytes', label: 'Est. bytes', align: 'right' },
                  { key: 'pred', label: 'Predicates' },
                ]}
                rows={(plan?.plan || []).map((p) => ({
                  key: String(p.id),
                  cells: {
                    op: (
                      /* Indentation carries the plan tree — an operation's depth is
                         what tells you which step feeds which. */
                      <span className="font-mono text-[11px] whitespace-pre text-fg"
                        style={{ paddingLeft: `${num(p.depth) * 12}px` }}>
                        {p.operation}{p.options ? ` ${p.options}` : ''}
                      </span>
                    ),
                    object: p.object_name ? (
                      <span className="block text-[11px] leading-tight">
                        <span className="block font-mono text-fg">{p.object_name}</span>
                        <span className="block text-subtle">{p.object_owner} · {p.object_type}</span>
                      </span>
                    ) : null,
                    cost: <span className="font-mono">{fmtNumber(p.cost)}</span>,
                    rows: <span className="font-mono">{fmtNumber(p.cardinality)}</span>,
                    bytes: <span className="font-mono text-[11px] text-muted">{fmtNumber(p.bytes)}</span>,
                    pred: (
                      <span className="block max-w-[260px] font-mono text-[10px] leading-snug break-words text-subtle">
                        {p.access_predicates || p.filter_predicates || ''}
                      </span>
                    ),
                  },
                }))}
                empty={<EmptyState icon="layers" title="No plan available"
                  body="The statement has aged out of the shared pool, or v$sql_plan is not readable by this login." />}
              />

              {(plan?.indexes_used || []).length > 0 && (
                <div className="border-t border-border px-card py-2.5">
                  <p className="mb-1.5 text-[11px] font-bold tracking-wide text-subtle uppercase">
                    Indexes this plan uses
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {plan.indexes_used.map((ix, i) => (
                      <Badge key={`${ix.index_name}-${i}`} tone="accent" size="xs">
                        <Icon name="key" size={9} />
                        {ix.index_name || ix.operation}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </TablePanel>
      )}
    </div>
  );
}
