import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { MetricTile, SqlCell, StateChip, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtNumber } from '@/config/dbCatalog';
import { WAIT_CLASS_TONES, explainWait } from '@/config/oracleWaits';

/**
 * The Oracle alert log, plus the sessions that look stuck.
 *
 * Two things are worth knowing about the data:
 *
 *  · The collector reads `v$diag_alert_ext`. If the login cannot, it falls back to
 *    `v$log` — which is redo log metadata, NOT alert messages. That fallback is
 *    labelled rather than presented as if it were the alert log, because reading
 *    redo sequence numbers as though they were errors would be actively misleading.
 *  · An ORA- number in the message text is the thing an operator searches for, so
 *    it is pulled out into its own column and made searchable.
 */

const num = (v) => Number(v) || 0;

/**
 * v$diag_alert_ext.message_level follows Oracle's ADR convention: 1 is the most
 * severe, 16 the least. Not a scale anyone remembers, so it is named here.
 */
export const ALERT_LEVELS = [
  { id: 'CRITICAL', max: 1, label: 'Critical', tone: 'danger', icon: 'close', hint: 'Level 1 — the instance itself is affected' },
  { id: 'SEVERE', max: 2, label: 'Severe', tone: 'danger', icon: 'alert', hint: 'Level 2 — a component failed' },
  { id: 'IMPORTANT', max: 8, label: 'Important', tone: 'warning', icon: 'alert', hint: 'Levels 3–8 — worth reading' },
  { id: 'INFO', max: Infinity, label: 'Informational', tone: 'neutral', icon: 'info', hint: 'Levels 9+ — routine messages' },
];

export function levelOf(entry) {
  const lvl = num(entry.message_level);
  if (!lvl) return ALERT_LEVELS[ALERT_LEVELS.length - 1];
  return ALERT_LEVELS.find((l) => lvl <= l.max) || ALERT_LEVELS[ALERT_LEVELS.length - 1];
}

/** The ORA-/TNS- code in a message, which is what someone actually looks up. */
export function errorCode(text) {
  const m = String(text || '').match(/\b(ORA|TNS|PLS|RMAN|IMP|EXP)-\d{3,6}\b/);
  return m ? m[0] : null;
}

export default function OracleErrorLogs() {
  const { id } = useParams();
  const [level, setLevel] = useState('ALL');
  const [search, setSearch] = useState('');

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['oracleErrorLogs', id],
    queryFn: () => client.get(`/connections/oracle/${id}/oracle-error-logs`).then((r) => r.data),
    retry: false,
    refetchInterval: 30000,
  });

  const isFallback = data?.source === 'v$log';
  const noSource = data?.source === 'none';

  const entries = useMemo(() => {
    if (isFallback || noSource) return [];
    return (data?.alert_logs || []).map((e, i) => ({
      ...e,
      _i: i,
      _level: levelOf(e),
      _code: errorCode(e.message_text),
    }));
  }, [data, isFallback, noSource]);

  const counts = useMemo(() => {
    const acc = {};
    ALERT_LEVELS.forEach((l) => { acc[l.id] = 0; });
    entries.forEach((e) => { acc[e._level.id] += 1; });
    return acc;
  }, [entries]);

  const codes = useMemo(() => {
    const acc = {};
    entries.forEach((e) => { if (e._code) acc[e._code] = (acc[e._code] || 0) + 1; });
    return Object.entries(acc).sort((a, b) => b[1] - a[1]);
  }, [entries]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return entries.filter((e) => (
      (level === 'ALL' || e._level.id === level)
      && (!term || `${e.message_text} ${e._code || ''} ${e.component_id || ''}`.toLowerCase().includes(term))
    ));
  }, [entries, level, search]);

  const stuck = data?.blocking_sessions || [];
  const critical = counts.CRITICAL + counts.SEVERE;

  const header = (
    <PageHeader
      title="Oracle Alert Log"
      description="v$diag_alert_ext, newest first, with the sessions that look stuck"
      icon="logs"
      backTo={`/oracle-dashboard/${id}`}
      actions={(
        <>
          {data?.source && <Badge tone={isFallback ? 'warning' : 'outline'}>{data.source}</Badge>}
          <Button variant="secondary" icon="refresh" loading={isFetching} onClick={() => refetch()}>
            Refresh
          </Button>
        </>
      )}
    />
  );

  if (isLoading) return <>{header}<PageLoading title="Reading the alert log…" /></>;

  if (error) {
    return (
      <>
        {header}
        <Notice tone="danger" title="Could not read the alert log.">{error.message}</Notice>
        <Button variant="primary" icon="refresh" onClick={() => refetch()}>Retry</Button>
      </>
    );
  }

  return (
    <>
      {header}

      {/* The fallback is redo log metadata, not alert messages. Saying so is the
          difference between "no errors" and "we could not look". */}
      {isFallback && (
        <Notice tone="warning" title="The alert log could not be read.">
          <code className="font-mono">v$diag_alert_ext</code> was not accessible, so the collector
          fell back to <code className="font-mono">v$log</code> — that is redo log metadata, not
          alert messages, so it is not shown here as if it were.
          {data?.note ? <span className="mt-1 block text-[11px]">{data.note}</span> : null}
          <span className="mt-1 block">
            Grant the login <b>SELECT</b> on <code className="font-mono">v$diag_alert_ext</code>
            {' '}(or read the alert log from the ADR trace directory) to see real alerts.
          </span>
        </Notice>
      )}

      {noSource && (
        <Notice tone="danger" title="No alert source could be read.">
          {data?.note || 'Both v$diag_alert_ext and v$log failed.'}
        </Notice>
      )}

      <div className="space-y-gutter">
        {!isFallback && !noSource && (
          <>
            <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
              {ALERT_LEVELS.map((l) => (
                <MetricTile
                  key={l.id}
                  label={l.label}
                  value={counts[l.id]}
                  icon={l.icon}
                  hint={l.hint}
                  tone={counts[l.id] === 0 ? 'neutral' : l.tone === 'danger' ? 'bad' : l.tone === 'warning' ? 'warn' : 'neutral'}
                  onClick={() => setLevel(level === l.id ? 'ALL' : l.id)}
                />
              ))}
            </div>

            {critical > 0 && level === 'ALL' && (
              <Notice tone="danger"
                title={`${critical} critical or severe message${critical === 1 ? '' : 's'}.`}>
                <button type="button" onClick={() => setLevel('CRITICAL')} className="font-semibold underline">
                  Show them
                </button>
              </Notice>
            )}

            {codes.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-bold tracking-wide text-subtle uppercase">
                  Codes in this window
                </span>
                {codes.slice(0, 12).map(([code, n]) => (
                  <button key={code} type="button" onClick={() => setSearch(code)}
                    className="transition-opacity hover:opacity-80">
                    <Badge tone={code.startsWith('ORA-0') ? 'neutral' : 'danger'} size="xs">
                      {code}
                      <span className="opacity-70">×{n}</span>
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {!isFallback && !noSource && (
          <TablePanel
            title="Alert log"
            icon="logs"
            subtitle={`${data?.total ?? 0} most recent entries`}
            actions={(
              <>
                <span className="flex items-center gap-0.5 rounded-control border border-border p-0.5">
                  {['ALL', ...ALERT_LEVELS.map((l) => l.id)].map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setLevel(k)}
                      aria-pressed={level === k}
                      className={cn(
                        'h-7 rounded-control px-2 text-[11px] font-bold transition-colors',
                        level === k ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg',
                      )}
                    >
                      {k === 'ALL' ? `All ${entries.length}` : `${ALERT_LEVELS.find((l) => l.id === k).label} ${counts[k]}`}
                    </button>
                  ))}
                </span>
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onClear={() => setSearch('')}
                  placeholder="ORA- code or text…"
                  icon="search"
                  size="sm"
                  wrapperClassName="w-44"
                />
              </>
            )}
          >
            <Paged rows={filtered} unit="entries">
              {(page, pager) => (
                <>
                  <Table
                    columns={[
                      { key: 'when', label: 'Logged' },
                      { key: 'level', label: 'Level' },
                      { key: 'code', label: 'Code' },
                      { key: 'component', label: 'Component' },
                      { key: 'msg', label: 'Message' },
                    ]}
                    rows={page.map((e) => ({
                      key: `alert-${e._i}`,
                      cells: {
                        when: (
                          <span className="font-mono text-[11px] whitespace-nowrap text-muted">
                            {String(e.originating_timestamp || '').slice(0, 19) || null}
                          </span>
                        ),
                        level: (
                          <Badge tone={e._level.tone} size="xs">
                            <Icon name={e._level.icon} size={9} />
                            {e._level.label}
                            {e.message_level ? <span className="opacity-70">{e.message_level}</span> : null}
                          </Badge>
                        ),
                        code: e._code
                          ? <Badge tone="danger" size="xs" className="font-mono">{e._code}</Badge>
                          : null,
                        component: (
                          <span className="truncate-safe block max-w-[110px] font-mono text-[11px] text-muted">
                            {e.component_id}
                          </span>
                        ),
                        msg: (
                          <span className="block max-w-[620px] text-[12px] break-words text-fg">
                            {e.message_text}
                          </span>
                        ),
                      },
                    }))}
                    empty={entries.length ? (
                      <EmptyState icon="filter" title="No matches"
                        body="No entry matches the current level and search." />
                    ) : (
                      <EmptyState icon="check" title="No alert entries"
                        body="v$diag_alert_ext returned nothing with a message type — on a healthy instance that is normal." />
                    )}
                  />
                  {pager}
                </>
              )}
            </Paged>
          </TablePanel>
        )}

        {/* Not the alert log, but the same question: what is wrong right now. */}
        <TablePanel
          title={`Sessions that look stuck (${stuck.length})`}
          icon="alert"
          subtitle="Waiting on Application or Concurrency, or active and waiting for over a minute"
        >
          <Paged rows={stuck} unit="sessions">
            {(page, pager) => (
              <>
                <Table
                  columns={[
                    { key: 'sid', label: 'SID' },
                    { key: 'user', label: 'User' },
                    { key: 'status', label: 'Status' },
                    { key: 'machine', label: 'Client' },
                    { key: 'event', label: 'Waiting on' },
                    { key: 'class', label: 'Class' },
                    { key: 'secs', label: 'For', align: 'right' },
                    { key: 'action', label: 'What it means' },
                  ]}
                  rows={page.map((s, i) => {
                    const k = explainWait(s.event, s.wait_class);
                    return {
                      key: `stuck-${s.sid}-${i}`,
                      cells: {
                        sid: (
                          <span className="font-mono text-[12px] font-semibold">
                            {s.sid}<span className="text-subtle">,{s.serial}</span>
                          </span>
                        ),
                        user: <span className="truncate-safe block max-w-[110px] font-semibold text-accent-text">{s.username}</span>,
                        status: <StateChip value={s.status} tones={{ ACTIVE: 'success', INACTIVE: 'neutral' }} />,
                        machine: <span className="truncate-safe block max-w-[130px] font-mono text-[11px] text-muted">{s.machine}</span>,
                        event: <SqlCell sql={s.event} max={60} />,
                        class: s.wait_class
                          ? <Badge tone={WAIT_CLASS_TONES[s.wait_class] || 'neutral'} size="xs">{s.wait_class}</Badge>
                          : null,
                        secs: (
                          <span className={num(s.seconds_in_wait) > 300 ? 'font-mono font-bold text-danger-fg' : 'font-mono'}>
                            {fmtNumber(s.seconds_in_wait)}s
                          </span>
                        ),
                        action: (
                          <span className="block max-w-[280px] text-[11px] leading-snug text-muted">
                            {k.why || k.action}
                          </span>
                        ),
                      },
                    };
                  })}
                  empty={<EmptyState icon="check" title="Nothing looks stuck"
                    body="No session is waiting on an application or concurrency event, and none has been waiting over a minute." />}
                />
                {pager}
              </>
            )}
          </Paged>
        </TablePanel>
      </div>
    </>
  );
}
