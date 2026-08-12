import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import { dbError } from '@/lib/format';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { MetricTile, SqlBlock, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtNumber } from '@/config/dbCatalog';

/**
 * ClickHouse errors — `system.query_log` exceptions and `system.text_log` merged
 * into one stream, which is what the collector returns.
 *
 * The two sources answer different questions and the page keeps them
 * distinguishable: a query_log row is one client's query failing, a text_log row is
 * the server itself complaining. `system.text_log` is disabled by default, so its
 * absence is normal and is stated rather than looking like "no problems".
 */

const num = (v) => Number(v) || 0;

/** text_log levels, plus the fixed 'Error' the collector stamps on query_log rows. */
export const CH_SEVERITIES = [
  { id: 'Fatal', label: 'Fatal', tone: 'danger', icon: 'close' },
  { id: 'Critical', label: 'Critical', tone: 'danger', icon: 'close' },
  { id: 'Error', label: 'Error', tone: 'danger', icon: 'alert' },
  { id: 'Warning', label: 'Warning', tone: 'warning', icon: 'alert' },
];

const SEV_META = Object.fromEntries(CH_SEVERITIES.map((s) => [s.id, s]));

/**
 * The ClickHouse error code from a message.
 *
 * The collector supplies `error_code` for query_log rows but not for text_log ones,
 * where the code is inside the text — and the code is what someone searches for.
 */
export function errorCode(row) {
  if (row.error_code) return String(row.error_code);
  const m = String(row.message || '').match(/\bCode:\s*(\d+)/i);
  return m ? m[1] : null;
}

/** The exception name, which says more than the number. */
export function errorName(row) {
  const m = String(row.message || '').match(/\b([A-Z][A-Z0-9_]{3,})\b(?=\s*[:(]|\s)/);
  return m && m[1] !== 'DB' ? m[1] : null;
}

export default function ClickHouseErrorLogs() {
  const { id } = useParams();
  const [severity, setSeverity] = useState('ALL');
  const [source, setSource] = useState('ALL');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['chErrorLogs', id],
    queryFn: () => client.get(`/connections/clickhouse/${id}/ch-error-logs`).then((r) => r.data),
    retry: false,
    refetchInterval: 30000,
  });

  const logs = useMemo(
    () => (data?.logs || []).map((l, i) => ({
      ...l,
      _i: i,
      _code: errorCode(l),
      _name: errorName(l),
      _fromQueryLog: l.source === 'query_log',
    })),
    [data],
  );

  const counts = useMemo(() => {
    const acc = { Fatal: 0, Critical: 0, Error: 0, Warning: 0 };
    logs.forEach((l) => { if (acc[l.severity] != null) acc[l.severity] += 1; });
    return acc;
  }, [logs]);

  const codes = useMemo(() => {
    const acc = {};
    logs.forEach((l) => {
      const label = l._name || (l._code ? `Code ${l._code}` : null);
      if (label) acc[label] = (acc[label] || 0) + 1;
    });
    return Object.entries(acc).sort((a, b) => b[1] - a[1]);
  }, [logs]);

  const fromQueryLog = logs.filter((l) => l._fromQueryLog).length;
  const fromTextLog = logs.length - fromQueryLog;
  const sourceErrors = data?.source_errors || {};
  const textLogUnavailable = Boolean(sourceErrors.text_log);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return logs.filter((l) => (
      (severity === 'ALL' || l.severity === severity)
      && (source === 'ALL'
        || (source === 'query_log' ? l._fromQueryLog : !l._fromQueryLog))
      && (!term || `${l.message} ${l.query || ''} ${l._name || ''} ${l._code || ''}`.toLowerCase().includes(term))
    ));
  }, [logs, severity, source, search]);

  const critical = counts.Fatal + counts.Critical + counts.Error;

  const header = (
    <PageHeader
      title="ClickHouse Errors"
      description="Query exceptions and server log messages, newest first"
      icon="logs"
      backTo={`/clickhouse-dashboard/${id}`}
      actions={(
        <>
          {data?.source && <Badge tone="outline">{data.source}</Badge>}
          <Button variant="secondary" icon="refresh" loading={isFetching} onClick={() => refetch()}>
            Refresh
          </Button>
        </>
      )}
    />
  );

  if (isLoading) return <>{header}<PageLoading title="Reading the error logs…" /></>;

  if (error) {
    return (
      <>
        {header}
        <Notice tone="danger" title="Could not read the error logs.">{error.message}</Notice>
        <Button variant="primary" icon="refresh" onClick={() => refetch()}>Retry</Button>
      </>
    );
  }

  return (
    <>
      {header}

      {/* text_log is off by default. Saying so is the difference between "the server
          logged nothing" and "we are only seeing half the picture". */}
      {textLogUnavailable && (
        <Notice tone="info" title="Server log messages are not available.">
          <code className="font-mono">system.text_log</code> could not be read
          {sourceErrors.text_log ? `: ${dbError(sourceErrors.text_log, 160)}` : ''}. It is disabled by default —
          enable the <code className="font-mono">text_log</code> section in the server config to see
          what ClickHouse itself is reporting, not only what client queries hit. Query exceptions
          below are unaffected.
        </Notice>
      )}
      {sourceErrors.query_log && (
        <Notice tone="warning" title="Query exceptions are not available.">
          <code className="font-mono">system.query_log</code>: {sourceErrors.query_log}
        </Notice>
      )}

      <div className="space-y-gutter">
        <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4 xl:grid-cols-6">
          {CH_SEVERITIES.map((s) => (
            <MetricTile
              key={s.id}
              label={s.label}
              value={counts[s.id]}
              icon={s.icon}
              tone={counts[s.id] === 0 ? 'neutral' : s.tone === 'danger' ? 'bad' : 'warn'}
              onClick={() => setSeverity(severity === s.id ? 'ALL' : s.id)}
            />
          ))}
          <MetricTile label="Query failures" value={fromQueryLog} icon="zap"
            hint="From system.query_log — a client query that raised an exception"
            onClick={() => setSource(source === 'query_log' ? 'ALL' : 'query_log')} />
          <MetricTile label="Server messages" value={fromTextLog} icon="server"
            hint="From system.text_log — the server reporting about itself"
            onClick={() => setSource(source === 'text_log' ? 'ALL' : 'text_log')} />
        </div>

        {critical > 0 && severity === 'ALL' && (
          <Notice tone="danger" title={`${critical} error-level or worse entr${critical === 1 ? 'y' : 'ies'}.`}>
            <button type="button" onClick={() => setSeverity('Error')} className="font-semibold underline">
              Show them
            </button>
          </Notice>
        )}

        {codes.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold tracking-wide text-subtle uppercase">
              What is failing
            </span>
            {codes.slice(0, 12).map(([label, n]) => (
              <button key={label} type="button" onClick={() => setSearch(label.replace(/^Code /, ''))}
                className="transition-opacity hover:opacity-80">
                <Badge tone="danger" size="xs">
                  {label}
                  <span className="opacity-70">×{n}</span>
                </Badge>
              </button>
            ))}
          </div>
        )}

        <TablePanel
          title={`Errors (${filtered.length}${filtered.length === logs.length ? '' : ` of ${logs.length}`})`}
          icon="logs"
          subtitle="Select a row for the failing query, where there is one"
          actions={(
            <>
              <span className="flex items-center gap-0.5 rounded-control border border-border p-0.5">
                {['ALL', ...CH_SEVERITIES.map((s) => s.id)].map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setSeverity(k)}
                    aria-pressed={severity === k}
                    className={cn(
                      'h-7 rounded-control px-2 text-[11px] font-bold transition-colors',
                      severity === k ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg',
                    )}
                  >
                    {k === 'ALL' ? `All ${logs.length}` : `${k} ${counts[k]}`}
                  </button>
                ))}
              </span>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onClear={() => setSearch('')}
                placeholder="Code, name or text…"
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
                    { key: 'when', label: 'Time' },
                    { key: 'sev', label: 'Severity' },
                    { key: 'origin', label: 'Source' },
                    { key: 'what', label: 'Error' },
                    { key: 'user', label: 'User' },
                    { key: 'msg', label: 'Message' },
                  ]}
                  rows={page.map((l) => {
                    const key = `log-${l._i}`;
                    const meta = SEV_META[l.severity] || { tone: 'neutral', icon: 'info', label: l.severity };
                    return {
                      key,
                      onClick: l.query ? () => setOpen(open === key ? null : key) : undefined,
                      cells: {
                        when: (
                          <span className="font-mono text-[11px] whitespace-nowrap text-muted">
                            {String(l.logged || '').slice(0, 19) || null}
                          </span>
                        ),
                        sev: (
                          <Badge tone={meta.tone} size="xs">
                            <Icon name={meta.icon} size={9} />
                            {meta.label}
                          </Badge>
                        ),
                        origin: l._fromQueryLog
                          ? <Badge tone="accent" size="xs">query</Badge>
                          : (
                            <span title={l.source}
                              className="truncate-safe block max-w-[120px] font-mono text-[11px] text-muted">
                              {l.source}
                            </span>
                          ),
                        what: (
                          <span className="flex flex-col gap-0.5">
                            {l._name && <Badge tone="danger" size="xs">{l._name}</Badge>}
                            {l._code && <span className="font-mono text-[10px] text-subtle">code {l._code}</span>}
                          </span>
                        ),
                        user: <span className="text-[11px] text-muted">{l.user}</span>,
                        msg: (
                          <span className="flex items-start gap-2">
                            <span className="min-w-0 flex-1 text-[12px] break-words text-fg">{l.message}</span>
                            {l.query && (
                              <span className="flex shrink-0 items-center gap-1 text-[10px] font-bold whitespace-nowrap text-accent-text opacity-0 transition-opacity group-hover:opacity-100">
                                Query <Icon name="chevron-right" size={11} />
                              </span>
                            )}
                          </span>
                        ),
                      },
                    };
                  })}
                  empty={logs.length ? (
                    <EmptyState icon="filter" title="No matches"
                      body="No entry matches the current severity, source and search." />
                  ) : (
                    <EmptyState icon="check" title="No errors"
                      body="No query exception in system.query_log, and nothing at warning level or worse in the server log." />
                  )}
                />
                {page.map((l) => {
                  const key = `log-${l._i}`;
                  if (open !== key || !l.query) return null;
                  return (
                    <div key={key} className="space-y-2 border-t border-border bg-sunken px-card py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[11px] font-bold tracking-wide text-subtle uppercase">
                          The query that failed
                        </p>
                        {l.elapsed_ms != null && (
                          <Badge tone="outline" size="xs">ran for {fmtNumber(l.elapsed_ms)} ms</Badge>
                        )}
                        <span className="ml-auto"><CopyButton text={l.query} /></span>
                      </div>
                      <SqlBlock sql={l.query} className="max-h-48 overflow-auto" />
                      <p className="text-[11px] text-subtle">
                        Truncated to 300 characters by the collector.
                        {num(l.elapsed_ms) === 0
                          ? ' A duration of zero means it failed before it started running — a parse, permission or resource-limit rejection.'
                          : ''}
                      </p>
                    </div>
                  );
                })}
                {pager}
              </>
            )}
          </Paged>
        </TablePanel>

        <p className="flex items-start gap-1.5 text-[11px] text-subtle">
          <Icon name="info" size={12} className="mt-0.5 shrink-0" />
          Both tables are capped at 200 rows by the collector and merged newest-first, so a busy
          server's older entries are not shown here — query <span className="font-mono">system.query_log</span>
          {' '}directly for a longer window.
        </p>
      </div>
    </>
  );
}
