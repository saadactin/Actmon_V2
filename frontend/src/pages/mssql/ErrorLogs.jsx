import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client from '@/api/client';
import EngineDashboardHeader from '@/components/layout/EngineDashboardHeader';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Table, { EmptyState } from '@/components/ui/Table';
import { InlineLoading, PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import { MetricTile, Panel, SqlBlock, TablePanel } from '@/pages/_shared/enginePanels';
import { fmtNumber } from '@/config/dbCatalog';
import { MSSQL_DASHBOARD_TABS, mssqlTabRoute } from '@/config/mssqlDashboardNav';

/**
 * SQL Server error log.
 *
 * The list is only the entry point: selecting a row opens the deep analysis —
 * what the error is, whether it is still happening, and the diagnostic and
 * remediation commands for it. Those commands are click-to-run and every write or
 * DDL step is gated on what the connected login can actually do, which the
 * backend reports rather than the UI guessing.
 */

const fetchErrorLogs = (id) =>
  client.get(`/connections/mssql/${id}/mssql-error-logs`).then((r) => r.data);

/* These two live under /mssql, not /connections/mssql — a different router. */
const deepAnalyze = (id, body) =>
  client.post(`/mssql/${id}/error-deep-analysis`, body).then((r) => r.data);
const runCommand = (id, body) =>
  client.post(`/mssql/${id}/run-command`, body).then((r) => r.data);
const sspiDiagnose = (id) =>
  client.post(`/mssql/${id}/sspi-diagnostics`).then((r) => r.data);

/**
 * SQL Server severity is a number, and the bands are the documented ones:
 * 24+ is media/hardware failure, 16–23 needs an administrator, 11–15 is a user
 * error, below that is informational.
 */
export const SEVERITY_BANDS = [
  { id: 'FATAL', min: 24, label: 'Fatal', tone: 'danger', icon: 'close', hint: '24+ — media or hardware failure' },
  { id: 'ERROR', min: 16, label: 'Error', tone: 'danger', icon: 'alert', hint: '16–23 — needs an administrator' },
  { id: 'WARNING', min: 11, label: 'Warning', tone: 'warning', icon: 'alert', hint: '11–15 — the statement failed for the user' },
  { id: 'INFO', min: 0, label: 'Info', tone: 'neutral', icon: 'info', hint: 'Below 11 — informational' },
];

export function bandOf(log) {
  const sev = Number(log.severity ?? log.error_severity ?? 0);
  return SEVERITY_BANDS.find((b) => sev >= b.min) || SEVERITY_BANDS[SEVERITY_BANDS.length - 1];
}

const RISK = {
  safe: { label: 'Read-only', tone: 'success', icon: 'shield' },
  caution: { label: 'Changes state', tone: 'warning', icon: 'alert' },
  dangerous: { label: 'Write / DDL', tone: 'danger', icon: 'alert' },
};

export default function MSSQLErrorLogs() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [band, setBand] = useState('ALL');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['mssqlErrorLogs', id],
    queryFn: () => fetchErrorLogs(id),
    retry: false,
    refetchInterval: 30000,
  });

  const logs = useMemo(() => {
    const raw = Array.isArray(data) ? data : (data?.logs || []);
    return raw.map((l, i) => ({ ...l, _band: bandOf(l), _i: i }));
  }, [data]);

  const counts = useMemo(() => {
    const acc = {};
    SEVERITY_BANDS.forEach((b) => { acc[b.id] = 0; });
    logs.forEach((l) => { acc[l._band.id] += 1; });
    return acc;
  }, [logs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.filter((l) => (
      (band === 'ALL' || l._band.id === band)
      && (!q || String(l.message || '').toLowerCase().includes(q))
    ));
  }, [logs, band, search]);

  const critical = counts.FATAL + counts.ERROR;

  const header = (
    <>
      <EngineDashboardHeader
        tech="mssql"
        connectionId={id}
        tabs={MSSQL_DASHBOARD_TABS}
        activeTab="error-logs"
        onTabChange={(t) => navigate(mssqlTabRoute(id, t))}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-black text-fg">SQL Server Error Log</h1>
          <p className="text-xs text-subtle">
            Select an entry to see what it means, whether it is still happening, and how to fix it
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.source && <Badge tone="outline">{data.source}</Badge>}
          <Button variant="secondary" icon="refresh" loading={isFetching} onClick={() => refetch()}>
            Refresh
          </Button>
        </div>
      </div>
    </>
  );

  if (isLoading) return <>{header}<PageLoading title="Reading the error log…" /></>;

  if (error) {
    return (
      <>
        {header}
        <Notice tone="danger" title="Could not read the error log.">{error.message}</Notice>
        <Button variant="primary" icon="refresh" onClick={() => refetch()}>Retry</Button>
      </>
    );
  }

  return (
    <>
      {header}

      {/* The collector tries xp_readerrorlog first and falls back to sys.messages.
          The fallback is a CATALOGUE of possible messages, not this server's
          history — saying so prevents reading it as live incidents. */}
      {data?.source === 'sys.messages' && (
        <Notice tone="warning" title="Showing the message catalogue, not this server's log.">
          <code className="font-mono">xp_readerrorlog</code> could not be read
          {data.xp_readerrorlog_error ? ` (${data.xp_readerrorlog_error})` : ''}, so these are
          the definitions of severity-16-and-above messages rather than events that happened
          here. Grant the login <b>VIEW SERVER STATE</b> and <code className="font-mono">EXECUTE</code>{' '}
          on <code className="font-mono">xp_readerrorlog</code> for the real log.
        </Notice>
      )}

      <div className="space-y-gutter">
        <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
          {SEVERITY_BANDS.map((b) => (
            <MetricTile
              key={b.id}
              label={b.label}
              value={counts[b.id]}
              icon={b.icon}
              hint={b.hint}
              tone={counts[b.id] === 0 ? 'neutral' : b.tone === 'danger' ? 'bad' : b.tone === 'warning' ? 'warn' : 'neutral'}
              onClick={() => setBand(band === b.id ? 'ALL' : b.id)}
            />
          ))}
        </div>

        {critical > 0 && band !== 'FATAL' && band !== 'ERROR' && (
          <Notice tone="danger" title={`${critical} fatal or error entr${critical === 1 ? 'y' : 'ies'}.`}>
            <button type="button" onClick={() => setBand('ERROR')} className="font-semibold underline">
              Show them
            </button>
          </Notice>
        )}

        <TablePanel
          title="Log entries"
          icon="logs"
          subtitle="Newest first, as the server returned them"
          actions={(
            <>
              <span className="flex items-center gap-0.5 rounded-control border border-border p-0.5">
                {['ALL', ...SEVERITY_BANDS.map((b) => b.id)].map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setBand(k)}
                    aria-pressed={band === k}
                    className={cn(
                      'h-7 rounded-control px-2 text-[11px] font-bold transition-colors',
                      band === k ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg',
                    )}
                  >
                    {k === 'ALL' ? `All ${logs.length}` : `${k.charAt(0)}${k.slice(1).toLowerCase()} ${counts[k]}`}
                  </button>
                ))}
              </span>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onClear={() => setSearch('')}
                placeholder="Search messages…"
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
                    { key: 'ts', label: 'Logged' },
                    { key: 'sev', label: 'Severity' },
                    { key: 'source', label: 'Source' },
                    { key: 'msg', label: 'Message' },
                  ]}
                  rows={page.map((l) => ({
                    key: `log-${l._i}`,
                    onClick: () => setSelected(l),
                    cells: {
                      ts: (
                        <span className="font-mono text-[11px] whitespace-nowrap text-muted">
                          {l.logged ? String(l.logged).slice(0, 19) : null}
                        </span>
                      ),
                      sev: (
                        <Badge tone={l._band.tone} size="xs">
                          <Icon name={l._band.icon} size={9} />
                          {l._band.label} {l.severity}
                        </Badge>
                      ),
                      source: (
                        <span className="truncate-safe block max-w-[120px] text-[11px] text-muted">
                          {l.process_info}
                        </span>
                      ),
                      msg: (
                        <span className="flex items-start gap-2">
                          <span className="min-w-0 flex-1 text-[12px] break-words text-fg">{l.message}</span>
                          <span className="flex shrink-0 items-center gap-1 text-[10px] font-bold whitespace-nowrap text-accent-text opacity-0 transition-opacity group-hover:opacity-100">
                            Analyse <Icon name="chevron-right" size={11} />
                          </span>
                        </span>
                      ),
                    },
                  }))}
                  empty={logs.length ? (
                    <EmptyState icon="filter" title="No matches"
                      body="No entry matches the current severity filter and search." />
                  ) : (
                    <EmptyState icon="check" title="The error log is empty"
                      body="Nothing was returned. On a healthy server that is normal; if you expected entries, check that the login holds VIEW SERVER STATE." />
                  )}
                />
                {pager}
              </>
            )}
          </Paged>
        </TablePanel>
      </div>

      {selected && (
        <ErrorAnalysisDrawer connId={id} row={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

/* ── deep analysis + self-heal ─────────────────────────────────────────────── */

function ErrorAnalysisDrawer({ connId, row, onClose }) {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sspi, setSspi] = useState(null);
  const [sspiLoading, setSspiLoading] = useState(false);
  const [sspiErr, setSspiErr] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    deepAnalyze(connId, {
      message: row.message || '',
      error_number: row.error_number ?? null,
      state: row.state ?? null,
    })
      .then((d) => { if (alive) { setAnalysis(d); setLoading(false); } })
      .catch((e) => { if (alive) { setErr(e?.message || String(e)); setLoading(false); } });
    return () => { alive = false; };
  }, [connId, row]);

  const perms = analysis?.permissions || {};
  const canHeal = Boolean(perms.can_self_heal);

  const run = async (step) => {
    setBusy(true);
    setEntries((t) => [...t, { kind: 'cmd', sql: step.sql, at: new Date().toLocaleTimeString() }]);
    try {
      const res = await runCommand(connId, { sql: step.sql, database: step.database || null });
      setEntries((t) => [...t, { kind: 'out', res, at: new Date().toLocaleTimeString() }]);
    } catch (e) {
      setEntries((t) => [...t, {
        kind: 'out',
        res: { status: 'error', error: e?.message || String(e) },
        at: new Date().toLocaleTimeString(),
      }]);
    } finally {
      setBusy(false);
    }
  };

  const runSspiDiagnostics = async () => {
    setSspiLoading(true);
    setSspiErr(null);
    try {
      const d = await sspiDiagnose(connId);
      setSspi(d);
    } catch (e) {
      setSspiErr(e?.message || String(e));
    } finally {
      setSspiLoading(false);
    }
  };

  const SEV_TONE = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warning' };

  return (
    <Drawer
      open
      onClose={onClose}
      title={loading ? 'Analysing…' : (analysis?.title || 'Error analysis')}
      subtitle={row.message}
      width={880}
    >
      {loading ? (
        <PageLoading title="Analysing this error…" subtitle="Decoding it, then re-reading the log to see if it is still happening" />
      ) : err ? (
        <Notice tone="danger" title="Analysis failed.">{err}</Notice>
      ) : (
        <div className="space-y-gutter">
          <div className="flex flex-wrap items-center gap-2">
            {analysis.severity_label && (
              <Badge tone={SEV_TONE[analysis.severity_label] || 'neutral'}>{analysis.severity_label}</Badge>
            )}
            {analysis.error_number != null && (
              <Badge tone="outline">
                Error {analysis.error_number}
                {analysis.state != null ? ` · state ${analysis.state}` : ''}
              </Badge>
            )}
            {analysis.category && <Badge tone="neutral">{analysis.category}</Badge>}
          </div>

          {/* Whether it is STILL happening decides whether this is an incident or
              a historical entry, so it leads. */}
          <Notice
            tone={analysis.is_still_occurring ? 'danger' : analysis.is_still_occurring === false ? 'success' : 'info'}
            className="mb-0"
            title={analysis.is_still_occurring
              ? 'Still occurring.'
              : analysis.is_still_occurring === false ? 'Not occurring recently.' : 'Live status unknown.'}
          >
            {analysis.is_still_occurring
              ? 'A matching entry appeared in the last 15 minutes.'
              : analysis.is_still_occurring === false
                ? 'No matching entry in the last 15 minutes — this looks resolved.'
                : 'The log could not be re-read to check.'}
            {analysis.occurrences != null && ` ${fmtNumber(analysis.occurrences)} matching entr${analysis.occurrences === 1 ? 'y' : 'ies'} in the log.`}
          </Notice>

          <div className="grid gap-gutter xl:grid-cols-[1fr_340px]">
            <div className="space-y-gutter">
              <Panel title="What this is" icon="info">
                <p className="text-[13px] text-fg">{analysis.what}</p>
              </Panel>

              <Panel title="Why it is happening" icon="alert">
                <p className="text-[13px] text-fg">{analysis.why}</p>
                {(analysis.login || analysis.database) && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {analysis.login && <Badge tone="accent" size="xs">login: {analysis.login}</Badge>}
                    {analysis.database && <Badge tone="info" size="xs">database: {analysis.database}</Badge>}
                  </div>
                )}
              </Panel>

              {analysis.impact && (
                <Panel title="Impact" icon="alert">
                  <p className="text-[13px] text-fg">{analysis.impact}</p>
                </Panel>
              )}

              {analysis.error_number === 17806 && (
                <Panel title="SSPI / Kerberos diagnostics" icon="shield"
                  subtitle="Read-only — auth scheme, SPN, DNS, ports, time sync, domain context">
                  {!sspi && !sspiLoading && (
                    <>
                      <p className="mb-2 text-[12px] text-muted">
                        Runs a dedicated set of read-only checks on the SQL Server's own host
                        (via its agent) to narrow down the SSPI/Kerberos failure. Nothing is
                        changed automatically.
                      </p>
                      <Button size="sm" icon="diagnose" onClick={runSspiDiagnostics}>
                        Run Full SSPI Diagnostics
                      </Button>
                    </>
                  )}
                  {sspiLoading && <InlineLoading label="Running SSPI diagnostics…" />}
                  {sspiErr && <Notice tone="danger" title="Diagnostics failed.">{sspiErr}</Notice>}
                  {sspi && sspi.status === 'disabled' && (
                    <Notice tone="info" title="Disabled.">{sspi.message}</Notice>
                  )}
                  {sspi && sspi.status === 'success' && <SspiReport report={sspi} />}
                  {sspi && (
                    <Button size="sm" variant="ghost" icon="refresh" className="mt-2" onClick={runSspiDiagnostics}>
                      Re-run
                    </Button>
                  )}
                </Panel>
              )}

              {(analysis.recent_hits || []).length > 0 && (
                <TablePanel title={`Recent occurrences (${analysis.recent_hits.length})`} icon="clock">
                  <Table
                    columns={[
                      { key: 'ts', label: 'Logged' },
                      { key: 'msg', label: 'Message' },
                    ]}
                    rows={analysis.recent_hits.map((h, i) => ({
                      key: `hit-${i}`,
                      cells: {
                        ts: (
                          <span className="font-mono text-[11px] whitespace-nowrap text-muted">
                            {String(h.logged || '').slice(0, 19)}
                          </span>
                        ),
                        msg: <span className="text-[12px] break-words text-fg">{h.message}</span>,
                      },
                    }))}
                    empty={<EmptyState icon="clock" title="No recent occurrences" />}
                  />
                </TablePanel>
              )}

              <CommandOutput entries={entries} onClear={() => setEntries([])} />
            </div>

            <div className="space-y-gutter">
              <Notice
                tone={canHeal ? 'success' : 'warning'}
                className="mb-0"
                title={canHeal ? 'Self-heal available.' : 'Self-heal limited.'}
              >
                Login <b className="font-mono">{perms.login_name || '—'}</b>{' '}
                {canHeal
                  ? 'holds the server role needed to run the write and DDL steps below.'
                  : 'is not a sysadmin or securityadmin and lacks ALTER ANY LOGIN, so only the read-only diagnostics will run.'}
              </Notice>

              {(analysis.diagnostics || []).length > 0 && (
                <Panel title="Diagnostics" icon="diagnose" subtitle="Read-only — safe to run">
                  <div className="space-y-gutter-sm">
                    {analysis.diagnostics.map((s, i) => (
                      <CommandStep key={i} step={s} onRun={run} busy={busy} canHeal={canHeal} />
                    ))}
                  </div>
                </Panel>
              )}

              {(analysis.remediations || []).length > 0 && (
                <Panel title="Remediation" icon="wrench" subtitle="Changes the server — read each one first">
                  <div className="space-y-gutter-sm">
                    {analysis.remediations.map((s, i) => (
                      <CommandStep key={i} step={s} onRun={run} busy={busy} canHeal={canHeal} />
                    ))}
                  </div>
                </Panel>
              )}

              <Panel title="Also relevant" icon="info">
                <RelevanceRow ok={analysis.backup_relevant} icon="archive" label="Backups"
                  note={analysis.backup_relevant
                    ? 'A backup or log-backup step is part of the fix above.'
                    : 'Not related to this error.'} />
                <RelevanceRow ok={analysis.exec_plan_relevant} icon="activity" label="Execution plan"
                  note={analysis.exec_plan_relevant
                    ? 'Plan tuning is relevant — capture the plan of the offending statement.'
                    : 'Not a query-plan problem.'} />
              </Panel>
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}

const SSPI_STATUS = {
  PASS: { label: 'PASS', tone: 'success' },
  INFO: { label: 'INFO', tone: 'neutral' },
  WARNING: { label: 'WARNING', tone: 'warning' },
  CRITICAL: { label: 'CRITICAL', tone: 'danger' },
  UNKNOWN: { label: 'UNKNOWN', tone: 'outline' },
};

const SSPI_CHECK_LABELS = {
  auth_scheme: 'Authentication scheme', service_info: 'SQL Server service info',
  spn: 'SPN', dns_forward: 'DNS forward lookup', dns_reverse: 'DNS reverse lookup',
  sql_port: 'SQL port', kerberos_port: 'Kerberos port (88)', rpc_port: 'RPC port (135)',
  time_sync: 'Time synchronization', domain_context: 'Domain / Kerberos context',
};

/** Renders an already-computed error-17806 report: one status-badged row per
 * check, the deterministic root-cause summary, and an explicit confirmation
 * that nothing was changed automatically — nothing here is click-to-run. */
function SspiReport({ report }) {
  const checks = report.checks || {};
  const rc = report.root_cause || {};
  return (
    <div className="space-y-gutter-sm">
      <div className="space-y-1">
        {Object.entries(checks).map(([key, c]) => {
          const s = SSPI_STATUS[c?.status] || SSPI_STATUS.UNKNOWN;
          return (
            <div key={key} className="flex items-start justify-between gap-2 rounded-card border border-border bg-sunken p-2">
              <div className="min-w-0">
                <p className="text-[12px] font-semibold text-fg">{SSPI_CHECK_LABELS[key] || key}</p>
                {c?.detail != null && <p className="mt-0.5 truncate text-[11px] text-muted">{String(c.detail)}</p>}
              </div>
              <Badge tone={s.tone} size="xs">{s.label}</Badge>
            </div>
          );
        })}
      </div>

      {rc.likely_cause && (
        <Notice tone={rc.confidence === 'high' ? 'danger' : rc.confidence === 'medium' ? 'warning' : 'info'}
          className="mb-0" title={rc.likely_cause}>
          {rc.recommended_action}
          {(rc.findings || []).length > 1 && (
            <ul className="mt-1.5 list-disc pl-4 text-[11px]">
              {rc.findings.map((f, i) => (
                <li key={i}>
                  <b>{SSPI_CHECK_LABELS[f.check] || f.check}</b> — {f.status}: {f.detail}
                </li>
              ))}
            </ul>
          )}
        </Notice>
      )}

      <p className="text-[11px] font-semibold text-muted">
        Automatic remediation: {report.automatic_remediation || 'NOT EXECUTED'}
      </p>
    </div>
  );
}

function RelevanceRow({ ok, icon, label, note }) {
  return (
    <div className={cn(
      'mb-2 rounded-card border p-2.5 last:mb-0',
      ok ? 'border-accent-border bg-accent-soft' : 'border-border bg-sunken',
    )}>
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-fg">
        <Icon name={icon} size={12} />
        {label}
      </p>
      <p className="mt-0.5 text-[11px] text-muted">{note}</p>
    </div>
  );
}

/**
 * One runnable step.
 *
 * Two things stop a click that could only fail: a step needing permission the
 * login does not have, and a template still containing a `<placeholder>` — the
 * backend rejects both, so the button says why instead of firing.
 */
function CommandStep({ step, onRun, busy, canHeal }) {
  const risk = RISK[step.risk] || RISK.safe;
  const needsPermission = step.risk !== 'safe';
  const blocked = needsPermission && !canHeal;
  const hasPlaceholder = step.sql.includes('<') && step.sql.includes('>');

  return (
    <div className="rounded-card border border-border p-3">
      <div className="flex items-start gap-2">
        <Badge tone={risk.tone} size="xs">
          <Icon name={risk.icon} size={9} />
          {risk.label}
        </Badge>
        <p className="min-w-0 flex-1 text-[12px] font-bold text-fg">{step.title}</p>
      </div>
      <p className="mt-1 text-[11px] text-muted">{step.why}</p>
      <SqlBlock sql={step.sql} className="mt-2" />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={step.risk === 'dangerous' ? 'danger' : 'primary'}
          icon="play"
          disabled={busy || blocked || hasPlaceholder}
          onClick={() => onRun(step)}
        >
          Run
        </Button>
        <CopyButton text={step.sql} variant="ghost" />
        {blocked && (
          <span className="text-[11px] font-semibold text-warning-fg">
            needs a higher server role
          </span>
        )}
        {hasPlaceholder && !blocked && (
          <span className="text-[11px] text-subtle">fill in the &lt;placeholder&gt; first</span>
        )}
      </div>
    </div>
  );
}

/** What the commands printed. Kept in order, newest scrolled into view. */
function CommandOutput({ entries, onClear }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [entries]);

  return (
    <Panel
      title="Command output"
      icon="terminal"
      subtitle="Runs against this server, in order"
      actions={entries.length > 0 && (
        <Button size="sm" variant="ghost" icon="trash" onClick={onClear}>Clear</Button>
      )}
    >
      {entries.length === 0 ? (
        <p className="text-[12px] text-subtle">
          Nothing run yet. Use the diagnostics on the right — their output appears here.
        </p>
      ) : (
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {entries.map((e, i) => (
            <div key={i}>
              {e.kind === 'cmd' ? (
                <p className="flex items-baseline gap-2 font-mono text-[11px]">
                  <span className="shrink-0 text-subtle">{e.at}</span>
                  <span className="text-accent-text">&gt;</span>
                  <span className="min-w-0 break-all text-fg">{e.sql}</span>
                </p>
              ) : (
                <CommandResult res={e.res} />
              )}
            </div>
          ))}
          <span ref={endRef} />
        </div>
      )}
    </Panel>
  );
}

function CommandResult({ res }) {
  if (res.status === 'error' || res.status === 'denied') {
    return (
      <Notice tone={res.status === 'denied' ? 'warning' : 'danger'} className="mb-0"
        title={res.status === 'denied' ? 'Refused.' : 'Failed.'}>
        {res.error}
      </Notice>
    );
  }

  const rows = res.rows || [];
  const columns = res.columns || [];

  return (
    <div className="rounded-card border border-border bg-sunken p-2.5">
      <p className="flex flex-wrap items-center gap-2 text-[11px]">
        <Badge tone="success" size="xs"><Icon name="check" size={9} />OK</Badge>
        <span className="text-muted">{res.message}</span>
        {res.duration_ms != null && (
          <span className="ml-auto font-mono text-subtle">{res.duration_ms} ms</span>
        )}
      </p>
      {rows.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-border">
                {columns.map((c) => (
                  <th key={c} className="px-1.5 py-1 text-left font-bold text-subtle uppercase">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((r, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  {columns.map((c) => (
                    <td key={c} className="px-1.5 py-1 font-mono text-fg">
                      {r[c] === null || r[c] === undefined ? <span className="text-subtle">NULL</span> : String(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 50 && (
            <p className="mt-1 text-[10px] text-subtle">
              Showing the first 50 of {rows.length} returned rows.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
