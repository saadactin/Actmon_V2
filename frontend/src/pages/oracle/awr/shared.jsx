import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import cn from '@/lib/cn';
import client, { errorText } from '@/api/client';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Textarea from '@/components/ui/Textarea';
import { Panel } from '@/pages/_shared/enginePanels';

/* ── API ──────────────────────────────────────────────────────────────────── */
export const API = '/oracle/awr';
const enc = (k) => encodeURIComponent(k);

export function useDbQuery(databaseKey, part, opts = {}) {
  return useQuery({
    queryKey: ['awrDb', databaseKey, part],
    queryFn: () => client.get(`${API}/databases/${enc(databaseKey)}/${part}`).then((r) => r.data),
    enabled: Boolean(databaseKey),
    retry: false,
    ...opts,
  });
}

export function useFindingUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }) => client.patch(`${API}/findings/${id}`, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ predicate: (q) => ['awrDb', 'oracleAwrReportDetail'].includes(q.queryKey[0]) }),
  });
}

/* ── formatting ───────────────────────────────────────────────────────────── */
export const num = (v, d = 1) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));
/** Compact axis label: "27 Mar 08:30" (24 h, no year) — keeps x-axis ticks from colliding. */
export const shortLabel = (iso) => {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')} ${d.toLocaleString('en', { month: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
export const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtSec = (s) => {
  if (s == null) return '—';
  if (s >= 3600) return `${(s / 3600).toFixed(1)} h`;
  if (s >= 60) return `${(s / 60).toFixed(1)} min`;
  return `${s.toFixed(s < 1 ? 3 : 1)} s`;
};

/* ── badges ───────────────────────────────────────────────────────────────── */
export const SEVERITY = {
  HIGH: { tone: 'danger', bar: 'var(--status-critical)', label: 'High', icon: 'alert' },
  MEDIUM: { tone: 'warning', bar: 'var(--status-warning)', label: 'Medium', icon: 'alert' },
  LOW: { tone: 'info', bar: 'var(--chart-1)', label: 'Low', icon: 'info' },
  INFO: { tone: 'neutral', bar: 'var(--status-unknown)', label: 'Info', icon: 'info' },
};
export const SEV_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };

const TYPE = {
  diagnosis: { label: 'Diagnosis', tone: 'accent', hint: 'Evidence from one analysed report' },
  trend: { label: 'Trend', tone: 'info', hint: 'Change across historical reports' },
  forecast: { label: 'Forecast', tone: 'outline', hint: 'Model-estimated future value' },
  risk: { label: 'Risk', tone: 'warning', hint: 'Rule/model-based warning' },
  recommendation: { label: 'Recommendation', tone: 'success', hint: 'Proposed action' },
};
const SOURCE = {
  rule: { label: 'Rule', hint: 'Deterministic threshold check on measured metrics' },
  statistics: { label: 'Statistics', hint: 'Statistical test or model over the report history' },
  llm: { label: 'AI', hint: 'Groq narrative — explains and ranks; does not measure' },
};

export function SeverityBadge({ severity }) {
  const s = SEVERITY[severity] || SEVERITY.INFO;
  return <Badge tone={s.tone}><Icon name={s.icon} size={10} strokeWidth={3} /> {s.label}</Badge>;
}
export function TypeBadge({ type }) {
  const t = TYPE[type] || TYPE.diagnosis;
  return <Badge tone={t.tone} title={t.hint}>{t.label}</Badge>;
}
export function SourceBadge({ source }) {
  const s = SOURCE[source] || SOURCE.rule;
  return (
    <span title={s.hint} className="inline-flex items-center gap-1 text-micro font-bold tracking-wide text-subtle uppercase">
      <Icon name={source === 'llm' ? 'sparkles' : source === 'statistics' ? 'trend' : 'check'} size={10} />{s.label}
    </span>
  );
}

/* ── states ───────────────────────────────────────────────────────────────── */
export function Insufficient({ title = 'Insufficient historical data', detail, className }) {
  return (
    <div className={cn('rounded-xl border border-dashed border-border bg-sunken px-4 py-5 text-center', className)}>
      <span className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-surface text-subtle"><Icon name="clock" size={16} /></span>
      <p className="mt-2 text-[13px] font-semibold text-fg">{title}</p>
      {detail && <p className="mx-auto mt-1 max-w-xl text-meta text-muted">{detail}</p>}
    </div>
  );
}

export function QueryState({ q, children }) {
  if (q.isLoading) return <Panel><p className="py-8 text-center text-meta text-muted">Loading…</p></Panel>;
  if (q.error) return <Notice tone="danger">{errorText(q.error)}</Notice>;
  if (q.data?.status === 'error') return <Notice tone="warning">{q.data.error}</Notice>;
  return children(q.data);
}

export function StaleBanner({ freshness }) {
  if (!freshness?.latest_report_end) return null;
  return (
    <Notice tone={freshness.stale ? 'warning' : 'info'} title={freshness.stale ? 'Historical data.' : 'Uploaded data.'}>
      Latest report ends {fmtDay(freshness.latest_report_end)}
      {freshness.age_days != null && ` (${num(freshness.age_days, 0)} days ago)`}. {freshness.note}
    </Notice>
  );
}

/* ── findings ─────────────────────────────────────────────────────────────── */
function ObservedTable({ observed }) {
  const rows = Object.entries(observed || {}).filter(([, v]) => v && typeof v === 'object' && 'value' in v);
  if (!rows.length) return null;
  return (
    <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-2 border-b border-border py-1 text-meta">
          <dt className="truncate text-muted" title={`${v.label} — from ${v.source}`}>{v.label || k}</dt>
          <dd className="shrink-0 font-semibold text-fg tabular-nums">{num(v.value, 2)} <span className="text-subtle">{v.unit}</span></dd>
        </div>
      ))}
    </dl>
  );
}

function refLabel(r) {
  return [r.section, r.metric_key, r.sql_id && `SQL ${r.sql_id}`, r.event, r.evidence_id, r.rule_id, r.module]
    .filter(Boolean).join(' · ') || (r.report_id ? `report #${r.report_id}` : 'evidence');
}

export function FindingCard({ f, showStatus = true }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(f.outcome_note || '');
  const update = useFindingUpdate();
  const s = SEVERITY[f.severity] || SEVERITY.INFO;
  const actions = f.recommended_actions || [];
  return (
    <article className="relative overflow-hidden rounded-xl border border-border bg-surface py-3 pr-4 pl-5">
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1.5" style={{ background: s.bar }} />
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={f.severity} />
        <TypeBadge type={f.finding_type} />
        <span className="text-micro font-bold tracking-wide text-subtle uppercase">{f.category}</span>
        <SourceBadge source={f.source} />
        {f.status && f.status !== 'open' && <Badge tone={f.status === 'resolved' ? 'success' : 'neutral'}>{f.status}</Badge>}
        <button type="button" onClick={() => setOpen((o) => !o)} className="ml-auto text-meta font-semibold text-accent-text hover:underline" aria-expanded={open}>
          {open ? 'Hide details' : 'Evidence & actions'}
        </button>
      </div>
      <p className="mt-1.5 text-[14px] font-semibold text-fg">{f.title}</p>
      <p className="mt-0.5 text-meta text-muted">{f.evidence}</p>
      {f.predicted_value != null && f.prediction_interval && (
        <p className="mt-1 text-meta text-fg">
          Predicted <b>{num(f.predicted_value, 1)}</b> ({Math.round((f.prediction_interval.level || 0.8) * 100)}% interval {num(f.prediction_interval.low, 1)}–{num(f.prediction_interval.high, 1)}) · horizon {f.forecast_horizon}
        </p>
      )}
      {!open && actions[0] && (
        <p className="mt-2 flex gap-2 rounded-lg bg-sunken px-3 py-2 text-meta text-fg">
          <Icon name="check" size={13} className="mt-0.5 shrink-0 text-success-fg" /><span>{actions[0].action}</span>
        </p>
      )}
      {open && (
        <div className="mt-2 space-y-3">
          <ObservedTable observed={f.observed_metrics} />
          {f.probable_causes?.length > 0 && (
            <div>
              <p className="text-micro font-bold tracking-wide text-subtle uppercase">Probable causes (hypotheses)</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-meta text-fg">{f.probable_causes.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </div>
          )}
          {actions.map((a, i) => (
            <div key={i} className="rounded-lg border border-border p-3">
              <p className="text-[13px] font-semibold text-fg">{i + 1}. {a.action}</p>
              {a.rationale && <p className="mt-0.5 text-meta text-muted">{a.rationale}</p>}
              {a.benefit && <p className="mt-1 text-meta text-fg"><b>Benefit ceiling:</b> {a.benefit}</p>}
              {a.validation && (
                <div className="mt-2">
                  <span className="text-micro font-bold tracking-wide text-subtle uppercase">Validate</span>
                  <div className="mt-0.5 flex items-start gap-2">
                    <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-sunken px-2.5 py-1.5 font-mono text-[12px] whitespace-pre-wrap text-fg">{a.validation}</pre>
                    {/select|from/i.test(a.validation) && <CopyButton text={a.validation} label="Copy" variant="ghost" />}
                  </div>
                </div>
              )}
              <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-meta">
                {a.rollback && <span><b className="text-fg">Rollback:</b> <span className="text-muted">{a.rollback}</span></span>}
                {a.risk && <span><b className="text-fg">Risk:</b> <span className="text-muted">{a.risk}</span></span>}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-micro text-subtle">
            {f.confidence_method && <span><b>Method:</b> {f.confidence_method}</span>}
            {f.model_version && <span><b>Version:</b> {f.model_version}</span>}
            {f.data_quality && <span><b>Data quality:</b> {f.data_quality}</span>}
            {f.snapshot_start && <span><b>Window:</b> {fmtWhen(f.snapshot_start)} – {fmtWhen(f.snapshot_end)}</span>}
          </div>
          {f.evidence_refs?.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <span className="text-micro font-bold tracking-wide text-subtle uppercase">Source evidence:</span>
              {f.evidence_refs.slice(0, 12).map((r, i) => <Badge key={i} tone="outline" size="xs">{refLabel(r)}</Badge>)}
              {f.evidence_refs.length > 12 && <Badge tone="outline" size="xs">+{f.evidence_refs.length - 12} more</Badge>}
            </div>
          )}
          {showStatus && (
            <div className="rounded-lg bg-sunken p-3">
              <p className="text-micro font-bold tracking-wide text-subtle uppercase">Remediation outcome</p>
              <Textarea className="mt-1" rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                        placeholder="What was done and what changed (kept with this finding)" />
              <div className="mt-2 flex flex-wrap gap-2">
                {['acknowledged', 'resolved', 'open'].filter((st) => st !== (f.status || 'open')).map((st) => (
                  <Button key={st} size="sm" variant={st === 'resolved' ? 'primary' : 'secondary'} loading={update.isPending}
                          onClick={() => update.mutate({ id: f.id, status: st, outcome_note: note })}>
                    {st === 'open' ? 'Reopen' : st === 'acknowledged' ? 'Acknowledge' : 'Mark resolved'}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" disabled={note === (f.outcome_note || '')} loading={update.isPending}
                        onClick={() => update.mutate({ id: f.id, outcome_note: note })}>Save note</Button>
              </div>
              {update.data?.status === 'error' && <p className="mt-1 text-meta text-danger-fg">{update.data.error}</p>}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function FindingList({ findings, empty = 'No findings.' }) {
  const sorted = useMemo(() => [...(findings || [])].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9)), [findings]);
  if (!sorted.length) return <p className="py-4 text-center text-meta text-muted">{empty}</p>;
  return <div className="flex flex-col gap-2.5">{sorted.map((f) => <FindingCard key={f.id} f={f} />)}</div>;
}

/* ── forecast chart: observed line + forecast markers with interval whiskers ─ */
export function ForecastChart({ history = [], predictions = [], unit = '', height = 220 }) {
  const [hover, setHover] = useState(null);
  const W = 640; const H = height; const P = { t: 14, r: 16, b: 26, l: 44 };
  const pts = useMemo(() => {
    const all = [...history.map((h) => ({ ...h, kind: 'observed', t: +new Date(h.time) })),
                 ...predictions.map((p) => ({ ...p, kind: 'forecast', t: +new Date(p.target_time) }))].sort((a, b) => a.t - b.t);
    if (!all.length) return null;
    const vals = all.flatMap((p) => [p.value, p.low, p.high]).filter((v) => Number.isFinite(v));
    const lo = Math.min(0, ...vals); const hi = Math.max(...vals) * 1.08 || 1;
    const t0 = all[0].t; const t1 = all[all.length - 1].t || t0 + 1;
    const x = (t) => P.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - P.l - P.r);
    const y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
    return { all, x, y, lo, hi };
  }, [history, predictions, H]);
  if (!pts) return <p className="py-6 text-center text-meta text-muted">No data</p>;
  const obs = pts.all.filter((p) => p.kind === 'observed');
  const fc = pts.all.filter((p) => p.kind === 'forecast');
  const ticks = [pts.lo, (pts.lo + pts.hi) / 2, pts.hi];
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-meta text-muted" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: 'var(--chart-1)' }} /> Observed (per report)</span>
        {fc.length > 0 && <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: 'var(--chart-2)' }} /> Forecast with 80% interval</span>}
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Observed history and forecast"
             onMouseLeave={() => setHover(null)}>
          {ticks.map((v, i) => (
            <g key={i}>
              <line x1={P.l} x2={W - P.r} y1={pts.y(v)} y2={pts.y(v)} stroke="var(--chart-grid)" strokeWidth="1" />
              <text x={P.l - 6} y={pts.y(v) + 4} textAnchor="end" fontSize="11" fill="var(--chart-axis)">{num(v, 1)}</text>
            </g>
          ))}
          {(pts.all.length > 1 ? [pts.all[0], pts.all[pts.all.length - 1]] : [pts.all[0]]).map((p, i) => (
            <text key={`x${i}`} x={pts.x(p.t)} y={H - 6} textAnchor={i ? 'end' : 'start'} fontSize="11" fill="var(--chart-axis)">
              {shortLabel(p.t)}
            </text>
          ))}
          <polyline fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
                    points={obs.map((p) => `${pts.x(p.t)},${pts.y(p.value)}`).join(' ')} />
          {fc.map((p, i) => (
            <g key={`f${i}`}>
              <line x1={pts.x(p.t)} x2={pts.x(p.t)} y1={pts.y(p.low)} y2={pts.y(p.high)} stroke="var(--chart-2)" strokeWidth="2" />
              {[p.low, p.high].map((v, k) => <line key={k} x1={pts.x(p.t) - 5} x2={pts.x(p.t) + 5} y1={pts.y(v)} y2={pts.y(v)} stroke="var(--chart-2)" strokeWidth="2" />)}
            </g>
          ))}
          {pts.all.map((p, i) => (
            <g key={i} onMouseEnter={() => setHover(p)}>
              <circle cx={pts.x(p.t)} cy={pts.y(p.value)} r="12" fill="transparent" />
              <circle cx={pts.x(p.t)} cy={pts.y(p.value)} r="4.5" strokeWidth="2"
                      fill={p.kind === 'forecast' ? 'var(--surface)' : 'var(--chart-1)'}
                      stroke={p.kind === 'forecast' ? 'var(--chart-2)' : 'var(--surface)'} />
            </g>
          ))}
        </svg>
        {hover && (
          <div className="pointer-events-none absolute top-1 right-1 rounded-lg border border-border bg-surface px-3 py-2 text-meta shadow-md">
            <b className="text-[13px] text-fg">{num(hover.value, 2)}{unit}</b>
            <span className="ml-1 text-muted">{hover.kind === 'forecast' ? 'forecast' : 'observed'}</span>
            {hover.kind === 'forecast' && <div className="text-muted">80% interval {num(hover.low, 1)}–{num(hover.high, 1)}</div>}
            <div className="text-subtle">{hover.horizon || fmtWhen(hover.time)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── tiny fact tile ───────────────────────────────────────────────────────── */
export function Fact({ icon, label, value, sub, tone }) {
  return (
    <div className="rounded-xl bg-sunken px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-micro font-bold tracking-wide text-subtle uppercase">{icon && <Icon name={icon} size={12} />} {label}</span>
      <span className={cn('mt-1 block text-[20px] leading-tight font-bold', tone === 'danger' ? 'text-danger-fg' : tone === 'warning' ? 'text-warning-fg' : 'text-fg')}>{value}</span>
      {sub && <span className="mt-0.5 block text-micro text-subtle">{sub}</span>}
    </div>
  );
}

/* ── metric tile: StatTile's look, but shows the value exactly as given
   (StatTile zero-pads single digits, which suits counts, not "7.0 %") ───── */
const DISC = { accent: 'bg-accent-soft text-accent-text', info: 'bg-info-soft text-info-fg', danger: 'bg-danger-soft text-danger-fg',
               warning: 'bg-warning-soft text-warning-fg', good: 'bg-success-soft text-success-fg' };
const INK = { danger: 'text-danger-fg', warning: 'text-warning-fg', info: 'text-info-fg' };
export function MetricTile({ label, value, unit, sub, icon, tone = 'accent', valueTone }) {
  return (
    <div className="card flex flex-col gap-3.5 px-card py-card">
      <span className="flex items-center gap-3">
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full', DISC[tone] || DISC.accent)}><Icon name={icon} size={18} /></span>
        <span className="truncate-safe min-w-0 flex-1 text-[15px] font-medium text-fg">{label}</span>
      </span>
      <span className="min-w-0">
        <span className={cn('block text-[30px] leading-none font-bold', INK[valueTone] || 'text-fg')}>
          {value ?? '—'}{value != null && unit && <span className="ml-1 text-[15px] font-semibold text-muted">{unit}</span>}
        </span>
        {sub && <span className="truncate-safe mt-2 block text-[12px] text-subtle">{sub}</span>}
      </span>
    </div>
  );
}
