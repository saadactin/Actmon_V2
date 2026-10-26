/**
 * Query Analysis — screen 1: the statement, what it costs, and what to do next.
 *
 * Used by the engines whose detail page has no dedicated workspace (Oracle,
 * SQL Server, ClickHouse, MongoDB). Everything shown comes from the row the
 * slow-query list handed over (or re-fetched by id), the engine's slow-query
 * list (Recent Queries), and — for Oracle — the statement's own plan from
 * V$SQL_PLAN (read-only, executes nothing). A figure the backend does not
 * supply says "Not available".
 *
 * The editor is editable. Analyse sends the edited text to the existing AI
 * analysis; the execution plan belongs to the cursor that was captured, so
 * "View execution plan" is offered only while the text is unchanged.
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import client from '@/api/client';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import { fmtNumber, fmtDateTime } from '@/config/dbCatalog';
import { fmtMs } from '@/config/slowQueryCatalog';
import { cn } from '@/lib/cn';

import { planObjects } from './queryInsights';

/* ── SQL helpers ─────────────────────────────────────────────────────── */

const KEYWORDS = new Set(('select from where and or not in is null like between exists as on join inner left right full outer cross '
  + 'group by order having union all distinct insert into values update set delete merge using when then else end case '
  + 'with create table index view asc desc limit offset fetch first rows only top over partition count sum avg min max '
  + 'nvl coalesce decode cast').split(' '));

/** Tokenise for highlighting. Order matters: comments and strings first. */
export function highlight(sql) {
  const re = /(\/\*[\s\S]*?\*\/|--[^\n]*)|('(?:[^']|'')*')|("(?:[^"])*")|(:\w+|\?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w$#]*)|([\s\S])/g;
  const out = [];
  let m; let i = 0;
  while ((m = re.exec(sql)) !== null) {
    const [tok, comment, str, quoted, bind, num, word] = m;
    let cls = null;
    if (comment) cls = 'text-[#16a34a] italic';
    else if (str) cls = 'text-[#b45309]';
    else if (quoted) cls = 'text-fg';
    else if (bind) cls = 'text-[#db2777]';
    else if (num) cls = 'text-[#7c3aed]';
    else if (word && KEYWORDS.has(word.toLowerCase())) cls = 'text-[#2563eb] font-semibold';
    out.push(cls ? <span key={i} className={cls}>{tok}</span> : tok);
    i += 1;
  }
  return out;
}

/** A light formatter: one clause per line, keywords upper-cased. Strings and
 *  comments are left exactly as written. */
export function formatSql(sql) {
  const parts = sql.split(/('(?:[^']|'')*'|\/\*[\s\S]*?\*\/|--[^\n]*)/);
  const clause = /\s*\b(select|from|where|group\s+by|order\s+by|having|union(?:\s+all)?|(?:left|right|full|inner|cross)?\s*(?:outer\s+)?join|and|or|fetch\s+first)\b\s*/gi;
  return parts.map((p, idx) => {
    if (idx % 2 === 1) return p;
    let s = p.replace(/\s+/g, ' ');
    s = s.replace(clause, (_, kw) => {
      const k = kw.toUpperCase().replace(/\s+/g, ' ').trim();
      if (k === 'AND' || k === 'OR') return `\n  ${k} `;
      return `\n${k} `;
    });
    return s.replace(/\b([a-z_]+)\b/gi, (w) => (KEYWORDS.has(w.toLowerCase()) ? w.toUpperCase() : w));
  }).join('').replace(/^\s*\n/, '').trim();
}

/* ── pieces ───────────────────────────────────────────────────────────── */

function StepBadge({ n }) {
  return <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-[15px] font-bold text-accent-fg">{n}</span>;
}

function SectionTitle({ n, title, subtitle, right }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <StepBadge n={n} />
      <div className="min-w-0 flex-1">
        <h2 className="text-[18px] font-bold text-fg">{title}</h2>
        <p className="text-[13px] text-muted">{subtitle}</p>
      </div>
      {right}
    </div>
  );
}

const TONES = {
  green: 'bg-success-soft text-success-fg',
  blue: 'bg-accent-soft text-accent-text',
  amber: 'bg-warning-soft text-warning-fg',
  purple: 'bg-[#8b5cf6]/15 text-[#7c3aed]',
  red: 'bg-danger-soft text-danger-fg',
};

const NA = <span className="text-[15px] font-semibold text-subtle">Not available</span>;

function StatCard({ icon, tone = 'blue', label, value, sub, title }) {
  return (
    <div className="flex min-h-[104px] items-start gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm" title={title}>
      <span className={cn('grid h-12 w-12 shrink-0 place-items-center rounded-xl', TONES[tone])}><Icon name={icon} size={22} /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</p>
        <div className="mt-1 truncate text-[22px] font-bold leading-tight text-fg">{value ?? NA}</div>
        {sub && <p className="mt-1 truncate text-[12px] text-muted">{sub}</p>}
      </div>
    </div>
  );
}

function ActionTile({ tone, icon, title, body, onClick, disabled, busy, hint }) {
  const styles = {
    primary: 'border-accent bg-accent text-accent-fg hover:brightness-110',
    success: 'border-success/30 bg-success-soft/50 text-fg hover:bg-success-soft',
    accent: 'border-accent/30 bg-accent-softer text-fg hover:bg-accent-soft',
  }[tone];
  return (
    <button type="button" onClick={onClick} disabled={disabled || busy} title={hint}
      className={cn('group flex w-full items-center gap-4 rounded-xl border p-5 text-left shadow-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50', styles)}>
      <span className={cn('grid h-12 w-12 shrink-0 place-items-center rounded-xl',
        tone === 'primary' ? 'bg-white/15' : tone === 'success' ? 'bg-surface text-success-fg' : 'bg-surface text-accent-text')}>
        <Icon name={busy ? 'spinner' : icon} size={24} className={busy ? 'animate-spin' : ''} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[17px] font-bold', tone === 'success' ? 'text-success-fg' : tone === 'accent' ? 'text-accent-text' : '')}>{title}</span>
        <span className={cn('mt-0.5 block text-[13px]', tone === 'primary' ? 'text-white/85' : 'text-muted')}>{body}</span>
      </span>
      <Icon name="chevron-right" size={20} className="shrink-0 transition-transform group-hover:translate-x-1" />
    </button>
  );
}

function SqlEditor({ value, onChange, expanded }) {
  const pre = useRef(null);
  const nums = useRef(null);
  const lines = Math.max(6, value.split('\n').length);
  const sync = (e) => {
    if (pre.current) { pre.current.scrollTop = e.target.scrollTop; pre.current.scrollLeft = e.target.scrollLeft; }
    if (nums.current) nums.current.scrollTop = e.target.scrollTop;
  };
  const h = expanded ? 'h-[460px]' : 'h-[220px]';
  return (
    <div className={cn('flex overflow-hidden rounded-lg border border-border bg-surface font-mono text-[14px] leading-[22px]', h)}>
      <div ref={nums} className="select-none overflow-hidden border-r border-border bg-sunken/50 px-3 py-3 text-right text-subtle">
        {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <div className="relative min-w-0 flex-1">
        <pre ref={pre} aria-hidden="true" className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre px-5 py-3 text-fg">
          {highlight(value)}{'\n'}
        </pre>
        <textarea value={value} onChange={(e) => onChange(e.target.value)} onScroll={sync} spellCheck={false}
          aria-label="SQL text"
          className="absolute inset-0 h-full w-full resize-none overflow-auto whitespace-pre bg-transparent px-5 py-3 text-transparent caret-[var(--fg)] outline-none"
          style={{ fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit' }} wrap="off" />
      </div>
    </div>
  );
}

const RANGES = [{ id: 1, label: 'Last 1 Hour' }, { id: 6, label: 'Last 6 Hours' }, { id: 24, label: 'Last 24 Hours' }, { id: 168, label: 'Last 7 Days' }];

function fmtWhen(d, tz) {
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', ...(tz === 'utc' ? { timeZone: 'UTC' } : {}) });
}

/* ── the screen ───────────────────────────────────────────────────────── */

export default function QueryAnalysisScreen1({
  engine, id, row, backTo, ai, onAnalyze, onRefresh, refreshing, onPlan, planState,
  initialSql, onSqlChange, analyzing, analyzeError, onRetry, onAi,
}) {
  const navigate = useNavigate();
  const original = row.query_text || '';
  const [sql, setSqlState] = useState(initialSql ?? original);
  const setSql = (v) => { setSqlState(v); onSqlChange?.(v); };
  const [tab, setTab] = useState('sql');
  const [hours, setHours] = useState(1);
  const [tz, setTz] = useState('local');
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState(null);
  const edited = sql.trim() !== original.trim();
  const raw = row._raw || {};

  const range = useMemo(() => {
    const to = new Date(); const from = new Date(to.getTime() - hours * 3600e3);
    return { from, to };
  }, [hours, refreshing]); // eslint-disable-line react-hooks/exhaustive-deps

  const recent = useQuery({
    queryKey: ['qaRecent', engine.key, id, hours],
    queryFn: () => client.get(engine.api.list(id), {
      params: { date_from: range.from.toISOString(), date_to: range.to.toISOString(), sort_by: 'last_seen', sort_dir: 'desc', page: 1, page_size: 20 },
    }).then((r) => r.data),
    enabled: tab === 'recent',
    retry: false,
  });

  const objects = planObjects(planState?.rows || []);
  const schema = row.schema_name || row.database_name || null;
  const bufferGets = raw.buffer_gets ?? (raw.avg_buffer_gets != null && row.execution_count != null ? raw.avg_buffer_gets * row.execution_count : null);
  const sev = row.severity || null;

  const analyze = () => {
    if (!sql.trim()) { setErr('Enter a SQL statement to analyse.'); return; }
    if (!schema) { setErr('No schema is known for this statement.'); return; }
    setErr(null);
    onAnalyze(sql, edited);
  };
  // "Analyse this query" — the AI reading of the text (edited or not).
  const aiAnalyze = () => {
    if (!sql.trim()) { setErr('Enter a SQL statement to analyse.'); return; }
    setErr(null);
    (onAi || ((t, e) => onAnalyze(t, e)))(sql, edited);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(sql); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  return (
    <div className="space-y-5">
      {/* ── header row ── */}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => navigate(backTo)}
          className="flex h-11 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-[14px] font-semibold text-fg shadow-sm hover:bg-sunken">
          <Icon name="arrow-left" size={16} /> Back
        </button>
        <Icon name="zap" size={26} className="text-accent-text" />
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold text-fg">Query Analysis</h1>
          <p className="text-[13px] text-muted">Cost, then the execution plan, then how to make it faster</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <label className="flex h-12 flex-col justify-center rounded-lg border border-border bg-surface px-3 shadow-sm">
            <span className="text-[11px] text-muted">Time Range</span>
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="bg-transparent text-[13px] font-medium text-fg outline-none">
              {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
          <span className="flex h-12 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-[13px] text-fg shadow-sm"
            title="Window used for Recent Queries">
            <Icon name="calendar" size={16} className="text-muted" />
            {fmtWhen(range.from, tz)} – {fmtWhen(range.to, tz).split(', ').slice(-1)[0]}
          </span>
          <label className="flex h-12 flex-col justify-center rounded-lg border border-border bg-surface px-3 shadow-sm">
            <span className="text-[11px] text-muted">Time Zone</span>
            <select value={tz} onChange={(e) => setTz(e.target.value)} className="bg-transparent text-[13px] font-medium text-fg outline-none">
              <option value="local">Local</option>
              <option value="utc">UTC</option>
            </select>
          </label>
          <button type="button" onClick={() => { onRefresh(); recent.refetch(); }}
            className="flex h-12 items-center gap-2 rounded-lg bg-accent px-6 text-[15px] font-semibold text-accent-fg shadow-sm hover:brightness-110">
            <Icon name="refresh" size={17} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* ── 1. SQL query ── */}
      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <SectionTitle n={1} title="SQL Query"
          subtitle="Enter the SQL statement to analyze its cost, execution plan and performance metrics."
          right={(
            <div className="flex items-center gap-3">
              <label className="flex h-14 min-w-[200px] items-center gap-3 rounded-lg border border-border bg-surface px-3 shadow-sm"
                title="The schema this statement was captured in">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent-soft text-accent-text"><Icon name="database" size={18} /></span>
                <span className="flex flex-col">
                  <span className="text-[11px] text-muted">Schema</span>
                  <select value={schema || ''} onChange={() => {}} className="bg-transparent text-[15px] font-bold text-fg outline-none" disabled={!schema}>
                    <option value={schema || ''}>{schema || 'Not available'}</option>
                  </select>
                </span>
              </label>
              <button type="button" onClick={analyze} disabled={ai?.loading || analyzing}
                className="flex h-14 items-center gap-2 rounded-lg bg-accent px-8 text-[16px] font-semibold text-accent-fg shadow-sm hover:brightness-110 disabled:opacity-60">
                <Icon name={ai?.loading || analyzing ? 'spinner' : 'play'} size={18} className={ai?.loading || analyzing ? 'animate-spin' : ''} /> {analyzing ? 'Analyzing…' : 'Analyze'}
              </button>
            </div>
          )} />

        <div className="mt-4 flex gap-6 border-b border-border text-[14px]">
          {[['sql', 'SQL Text'], ['recent', 'Recent Queries']].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={cn('-mb-px border-b-2 px-6 pb-2.5 font-semibold', tab === k ? 'border-accent text-accent-text' : 'border-transparent text-muted hover:text-fg')}>
              {l}
            </button>
          ))}
        </div>

        {tab === 'sql' ? (
          <div className="relative mt-3">
            <SqlEditor value={sql} onChange={setSql} expanded={expanded} />
            <button type="button" onClick={() => setExpanded((v) => !v)} title={expanded ? 'Collapse editor' : 'Expand editor'}
              className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-lg border border-border bg-surface text-muted shadow-sm hover:bg-sunken">
              <Icon name={expanded ? 'collapse' : 'expand'} size={16} />
            </button>
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              {edited && <span className="mr-auto text-[12px] text-warning-fg">Edited — Analyze reads this text; the execution plan stays the captured statement's.</span>}
              {err && <span className="mr-auto text-[12px] text-danger-fg">{err}</span>}
              {[['Format', 'list', () => setSql(formatSql(sql))], ['Clear', 'trash', () => setSql('')], [copied ? 'Copied' : 'Copy', copied ? 'check' : 'copy', copy]].map(([l, ic, fn]) => (
                <button key={l} type="button" onClick={fn}
                  className="flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-[14px] font-semibold text-fg shadow-sm hover:bg-sunken">
                  <Icon name={ic} size={16} /> {l}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mt-3 max-h-[300px] overflow-auto rounded-lg border border-border">
            {recent.isLoading ? <p className="p-4 text-[13px] text-muted">Reading recent statements…</p>
              : recent.error ? <p className="p-4 text-[13px] text-danger-fg">{String(recent.error.message || recent.error)}</p>
                : !(recent.data?.normalized || []).length ? <p className="p-4 text-[13px] text-muted">No statements captured in this time range.</p> : (
                  <table className="w-full text-[13px]">
                    <thead className="sticky top-0 bg-sunken text-left text-[12px] font-semibold text-muted">
                      <tr>{['SQL ID', 'Statement', 'Executions', 'Avg time', 'Last seen'].map((hd) => <th key={hd} className="px-3 py-2">{hd}</th>)}</tr>
                    </thead>
                    <tbody>
                      {recent.data.normalized.map((r) => (
                        <tr key={r.query_id || r.query_text} className="cursor-pointer border-t border-border hover:bg-sunken"
                          onClick={() => navigate(`${engine.dashboardPath(id)}/slow-queries/detail`, { state: { row: r } })}>
                          <td className="px-3 py-2 font-mono text-accent-text">{r.query_id || '—'}</td>
                          <td className="max-w-[520px] truncate px-3 font-mono text-[12px]" title={r.query_text}>{r.query_text}</td>
                          <td className="px-3">{r.execution_count == null ? '—' : fmtNumber(r.execution_count)}</td>
                          <td className="px-3">{fmtMs(r.average_execution_time)}</td>
                          <td className="px-3">{r.last_seen ? (fmtDateTime(r.last_seen) || r.last_seen) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
          </div>
        )}
      </section>

      {analyzing && (
        <div className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent-softer px-5 py-4 text-[14px] text-fg" role="status">
          <Icon name="spinner" size={18} className="animate-spin text-accent-text" />
          Reading the execution plan, plan statistics, execution details and history…
        </div>
      )}
      {analyzeError && (
        <Notice tone="danger" title="Analysis could not be completed.">
          <p className="text-[12.5px]">{analyzeError}</p>
          {onRetry && (
            <button type="button" onClick={onRetry} className="mt-2 flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px] font-semibold text-fg hover:bg-sunken">
              <Icon name="refresh" size={14} /> Retry
            </button>
          )}
        </Notice>
      )}

      {/* ── 2. execution statistics ── */}
      <section className="rounded-2xl bg-sunken/40 p-5">
        <SectionTitle n={2} title="Execution Statistics" subtitle="Key execution metrics for this query." />
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <StatCard icon="alert" tone={sev === 'critical' ? 'red' : sev === 'high' ? 'amber' : 'green'} label="Severity"
            value={sev ? <span className={cn('inline-block rounded-md px-3 py-0.5 text-[15px]', TONES[sev === 'critical' ? 'red' : sev === 'high' ? 'amber' : 'green'])}>{sev.charAt(0).toUpperCase() + sev.slice(1)}</span> : null}
            sub={sev === 'critical' ? 'Needs attention now' : sev === 'high' ? 'Worth tuning' : sev ? 'No critical issues detected' : undefined} />
          <StatCard icon="clock" label="Avg Time" value={row.average_execution_time == null ? null : fmtMs(row.average_execution_time)} sub="Per execution" />
          <StatCard icon="activity" label="Executions" value={row.execution_count == null ? null : fmtNumber(row.execution_count)} sub="Captured for this statement" />
          <StatCard icon="trend" label="Rows Sent" value={row.rows_returned == null ? null : fmtNumber(row.rows_returned)} sub="Rows returned by query" />
          <StatCard icon="database" tone="amber" label="Buffer Gets" value={bufferGets == null ? null : fmtNumber(Math.round(bufferGets))}
            sub={raw.buffer_gets != null ? 'Logical read requests' : raw.avg_buffer_gets != null ? 'Avg per execution × executions' : undefined} />

          <StatCard icon="user" tone="red" label="User" value={row.user_name || null} sub={row.user_name ? 'Session user' : undefined} />
          <StatCard icon="database" tone="purple" label="Schema" value={schema} sub={schema ? 'Database schema' : undefined} />
          <StatCard icon="layers" tone="green" label="Object Types"
            value={objects?.types?.length ? <span className="text-[14px]">{objects.types.join(', ')}</span> : planState?.loading ? <span className="text-[14px] text-muted">Reading plan…</span> : null}
            title={objects?.types?.join(', ')} sub={objects?.types?.length ? 'Types accessed in this query' : engine.key !== 'oracle' ? 'From the execution plan (Oracle only)' : undefined} />
          <StatCard icon="table" label="Tables" value={objects ? objects.tables.length : planState?.loading ? <span className="text-[14px] text-muted">Reading plan…</span> : null}
            title={objects?.tables?.map((t) => `${t.owner ? `${t.owner}.` : ''}${t.name}`).join(', ')}
            sub={objects ? 'Total tables accessed' : undefined} />
          <StatCard icon="link" tone="purple" label="SQL ID" value={row.query_id ? <span className="font-mono">{row.query_id}</span> : null}
            title={row.query_id} sub={row.query_id ? 'Statement identifier' : undefined} />
        </div>
        {planState?.error && <p className="mt-3 text-[12px] text-muted">The execution plan could not be read, so Object Types and Tables are unavailable: {planState.error}</p>}
      </section>

      {/* ── 3. analysis & optimisation ── */}
      <section className="px-1">
        <SectionTitle n={3} title="Analysis & Optimization" subtitle="View execution plan, analyse performance and get recommendations." />
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          {engine.hasExplain && (
            <ActionTile tone="primary" icon="branch" title="View execution plan"
              body="See the complete execution plan, as a diagram and as a table."
              disabled={(engine.key === 'oracle' && !row.query_id) || edited || analyzing}
              hint={edited ? 'The plan is the captured statement\'s — undo your edits to open it' : undefined}
              onClick={onPlan} />
          )}
          <ActionTile tone="success" icon="brain" title="Analyse this query"
            body="Read the statement together with its cost figures and suggest improvements."
            busy={ai?.loading} onClick={aiAnalyze} />
          {engine.key === 'oracle' && (
            <ActionTile tone="accent" icon="layers" title="Compare & tune"
              body="Open Top SQL where this statement sits beside its plan history."
              onClick={() => navigate(`${engine.dashboardPath(id)}/sql`)} />
          )}
        </div>
      </section>

      {!engine.hasExplain && engine.key !== 'oracle' && (
        <Notice tone="info" title="Execution plan not available for this engine yet.">Plan retrieval for {engine.label} is not implemented, so only the statement and its figures are shown.</Notice>
      )}
    </div>
  );
}
