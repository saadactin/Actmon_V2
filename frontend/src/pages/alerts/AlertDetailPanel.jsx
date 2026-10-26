import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import { severityOf } from '@/components/charts/status';
import {
  acknowledgeOneAlert, addAlertComment, getAlertDetail, getAlertStorage, getOracleDatafiles, isAckable, listAlertComments,
} from '@/api/alerts';

/**
 * Alerts → click an alert → this panel (route state: ?alert=<id>, so Back/Close keep the list's filters and the
 * link can be shared). Every value is real:
 *   GET /alerts/detail?id=              the alert, its connection + host, thresholds, history, events, related alerts
 *   GET /alerts/detail/storage          Oracle tablespace trend + largest objects (collector-recorded, ClickHouse)
 *   GET /connections/oracle/{id}/oracle-datafile-mounts   live datafile location / autoextend (existing endpoint)
 *   GET/POST /alerts/detail/comments    comments on this alert's subject
 *   POST /alerts/active/ack {ids:[one]} acknowledge (existing endpoint, this alert only)
 * Actions shown are only the ones the app really supports: navigation into the database's own pages. Nothing here
 * changes a monitored system (no cleanup, no resize) — "Suggested Actions" explains, it does not execute.
 */
const RED = '#ef4444';
const TABS = [
  ['overview', 'Overview'], ['metrics', 'Metrics & Graphs'], ['objects', 'Affected Objects'], ['events', 'Recent Events'],
  ['related', 'Related Alerts'], ['suggested', 'Suggested Actions'], ['history', 'History'], ['comments', 'Comments'],
];
const RANGES = [[24, 'Last 24 hours'], [24 * 7, 'Last 7 days'], [24 * 30, 'Last 30 days']];
const fmtMB = (v) => (v == null ? 'N/A' : `${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MB`);
const fmtT = (v) => (v ? new Date(v).toLocaleString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'N/A');
const tShort = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function ago(v) {
  const s = Math.max(0, (Date.now() - Date.parse(v)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 172800) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}
function uptimeFrom(startup) {
  const t = Date.parse(String(startup || '').replace(' ', 'T'));
  if (!Number.isFinite(t)) return null;
  const d = (Date.now() - t) / 86400000;
  return d >= 1 ? `${Math.floor(d)} days, ${Math.floor((d % 1) * 24)} hours` : `${Math.floor(d * 24)} hours`;
}
const alertCode = (a) => {
  const d = a.created_at ? new Date(a.created_at) : new Date();
  return `#ALRT-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(a.id).replace(/\D/g, '').padStart(4, '0').slice(-6)}`;
};

function Card({ title, right, children, className }) {
  return (
    <section className={cn('card flex min-w-0 flex-col p-4', className)}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-[15.5px] font-bold text-fg">{title}</h3>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}
function Empty({ title, children, icon = 'info' }) {
  return (
    <div className="grid place-items-center gap-1.5 py-8 text-center">
      <Icon name={icon} size={20} className="text-subtle" />
      <div className="text-[13px] font-semibold text-fg">{title}</div>
      {children && <div className="max-w-md text-[12px] text-muted">{children}</div>}
    </div>
  );
}
function KV({ rows }) {
  return (
    <dl className="divide-y divide-border text-[13.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[150px_1fr] gap-3 py-1.5">
          <dt className="text-muted">{k}</dt>
          <dd className={cn('min-w-0 break-words', v == null || v === '' ? 'text-subtle' : 'text-fg')}>{v == null || v === '' ? 'N/A' : v}</dd>
        </div>
      ))}
    </dl>
  );
}
const SEV_BADGE = { critical: 'bg-danger-soft text-danger-fg', warning: 'bg-warning-soft text-warning-fg', info: 'bg-accent-soft text-accent' };

export default function AlertDetailPanel({ alertId, onClose, onSelect }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState('overview');
  const [hours, setHours] = useState(24);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState('');
  useEffect(() => { setTab('overview'); setMenu(false); }, [alertId]);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const dq = useQuery({ queryKey: ['alertDetail', alertId], queryFn: () => getAlertDetail(alertId), retry: false, refetchInterval: 60_000 });
  const d = dq.data;
  const a = d?.alert;
  const sub = d?.subject || {};
  const tgt = d?.target || {};
  const isTs = sub.kind === 'tablespace';
  const connId = tgt.conn_id;
  const sq = useQuery({
    queryKey: ['alertStorage', connId, sub.name, hours],
    queryFn: () => getAlertStorage({ connId, tablespace: sub.name, hours }),
    enabled: Boolean(isTs && connId && sub.name),
  });
  const fq = useQuery({ queryKey: ['alertDatafiles', connId], queryFn: () => getOracleDatafiles(connId), enabled: Boolean(isTs && connId), retry: false, staleTime: 300_000 });
  const cq = useQuery({ queryKey: ['alertComments', d?.alert_key], queryFn: () => listAlertComments(d.alert_key), enabled: Boolean(d?.alert_key) });
  const ack = useMutation({
    mutationFn: () => acknowledgeOneAlert(a),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alerts'] }); qc.invalidateQueries({ queryKey: ['alertDetail', alertId] }); },
  });
  const comment = useMutation({
    mutationFn: () => addAlertComment(d.alert_key, draft.trim()),
    onSuccess: () => { setDraft(''); cq.refetch(); },
  });

  const sev = a ? severityOf(a.severity) : null;
  const files = useMemo(() => (fq.data?.datafiles || []).filter((f) => f.tablespace === sub.name), [fq.data, sub.name]);
  const trend = sq.data?.trend || [];
  const objects = sq.data?.objects || [];
  const lastTrend = trend[trend.length - 1];
  const used = lastTrend?.used_mb ?? sub.used_mb;
  const total = lastTrend?.total_mb ?? sub.total_mb;
  const pct = lastTrend?.used_pct ?? sub.used_pct;
  const free = used != null && total != null ? Math.max(0, total - used) : sub.free_mb;
  const tags = [tgt.tech ? 'Database' : null, tgt.tech ? (tgt.tech === 'oracle' ? 'Oracle' : tgt.tech) : null,
    isTs ? 'Disk Usage' : a?.rule_name, isTs ? 'Tablespace' : null, tgt.environment, sub.name].filter(Boolean);
  const actions = [
    connId && tgt.tech === 'oracle' && { icon: 'database', label: 'Open in DB Console', to: `/oracle-dashboard/${connId}` },
    connId && tgt.tech === 'oracle' && isTs && { icon: 'folder', label: 'View Tablespace', to: `/oracle-dashboard/${connId}/storage-health` },
    connId && tgt.tech === 'oracle' && { icon: 'logs', label: 'Check Logs', to: `/oracle-dashboard/${connId}/error-logs` },
    tgt.host && { icon: 'server', label: 'Open Host', to: `/infra/${tgt.host.server_id}` },
    tgt.host && { icon: 'archive', label: 'Host Disk Usage', to: `/disk/${tgt.host.server_id}` },
  ].filter(Boolean);
  const share = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
  };

  const body = () => {
    if (dq.isLoading) return <div className="space-y-3 p-6">{[0, 1, 2].map((i) => <div key={i} className="h-40 animate-pulse rounded-lg bg-sunken" />)}</div>;
    if (dq.isError) {
      const msg = dq.error?.message || '';
      return <Empty icon="alert" title={/no longer active|not found/i.test(msg) ? 'This alert is no longer active' : /401|403/.test(msg) ? 'Not allowed' : 'Could not load this alert'}>{msg}</Empty>;
    }
    return null;
  };

  const trendCard = (h = 180) => (
    <Card title={`Usage Trend (${RANGES.find((r) => r[0] === hours)?.[1].replace('Last ', 'Last ') || ''})`}
      right={(
        <label className="inline-flex h-9 items-center gap-2 rounded-control border border-border bg-surface px-2.5 text-[13px] font-semibold text-fg">
          <Icon name="calendar" size={15} className="text-accent" />
          <select aria-label="Trend range" value={hours} onChange={(e) => setHours(Number(e.target.value))} className="bg-transparent outline-none">
            {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      )}>
      {sq.isLoading ? <div className="h-44 animate-pulse rounded bg-sunken" />
        : sq.isError ? <Empty icon="alert" title="Trend unavailable">{sq.error?.message}</Empty>
          : trend.length < 2 ? <Empty title="No stored history for this range">The collector records tablespace usage on each Oracle cycle.</Empty> : (
            <div style={{ height: h }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
                  <defs><linearGradient id="adTrend" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={RED} stopOpacity={0.35} /><stop offset="100%" stopColor={RED} stopOpacity={0.04} /></linearGradient></defs>
                  <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(t) => (hours > 24 ? new Date(t).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) : tShort(t))} tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} stroke="var(--border)" minTickGap={36} />
                  <YAxis domain={[0, 100]} ticks={[0, 20, 40, 60, 80, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} stroke="var(--border)" />
                  <Tooltip labelFormatter={(t) => fmtT(t)} formatter={(v, n) => [n === 'used_pct' ? `${v}%` : fmtMB(v), n === 'used_pct' ? 'Used' : n]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  {d?.thresholds?.critical != null && <ReferenceLine y={d.thresholds.critical} stroke={RED} strokeDasharray="5 4" />}
                  {d?.thresholds?.warning != null && <ReferenceLine y={d.thresholds.warning} stroke="#f59e0b" strokeDasharray="5 4" />}
                  <Area type="monotone" dataKey="used_pct" stroke={RED} strokeWidth={2} fill="url(#adTrend)" isAnimationActive={false}
                    dot={trend.length <= 40 ? { r: 2.5, fill: RED, strokeWidth: 0 } : false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
    </Card>
  );

  const objectsTable = (limit) => (
    !objects.length ? <Empty title="No object sizes recorded for this tablespace">The collector stores the database's largest segments; none of them are in this tablespace right now.</Empty> : (
      <table className="w-full text-[13px]">
        <thead><tr className="bg-sunken/60 text-left text-[12px] text-fg">{['Sr. No.', 'Schema', 'Object Name', 'Type', 'Size (MB)', 'Usage %'].map((h) => <th key={h} className="px-2 py-1.5 font-semibold">{h}</th>)}</tr></thead>
        <tbody>
          {objects.slice(0, limit).map((o, i) => (
            <tr key={`${o.owner}.${o.name}`} className="border-b border-border last:border-0">
              <td className="px-2 py-1.5 text-muted">{i + 1}</td><td className="px-2 py-1.5">{o.owner || 'N/A'}</td>
              <td className="px-2 py-1.5 font-medium text-fg">{o.name}</td><td className="px-2 py-1.5 text-muted">{o.type || 'N/A'}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{Number(o.size_mb).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td className="px-2 py-1.5">
                <span className="flex items-center gap-2"><span className="h-2 w-28 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full bg-[#ef4444]" style={{ width: `${Math.min(100, o.pct_of_tablespace || 0)}%` }} /></span>
                  <span className="w-12 text-right tabular-nums">{o.pct_of_tablespace != null ? `${o.pct_of_tablespace}%` : 'N/A'}</span></span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  );

  const hostRows = [
    ['Host Name', tgt.host?.server_name || tgt.db_host],
    // some agent-enrolled hosts store their NAME in ip_address — then the DB connection's address is the real IP
    ['IP Address', [tgt.host?.ip_address, tgt.db_host].find((x) => /^\d{1,3}(\.\d{1,3}){3}$|:/.test(String(x || ''))) || tgt.host?.ip_address || tgt.db_host],
    ['Database Type', tgt.tech ? `${tgt.tech === 'oracle' ? 'Oracle' : tgt.tech}${tgt.oracle?.version ? ` ${tgt.oracle.version}` : ''}` : null],
    ['Environment', tgt.environment ? <span className="rounded bg-accent-soft px-2 py-0.5 text-[12px] font-semibold text-accent">{tgt.environment}</span> : null],
    ['Database', tgt.database_name || tgt.connection_name], ['Instance', tgt.oracle?.instance_name],
    ['Uptime', uptimeFrom(tgt.oracle?.startup_time) || (tgt.host?.uptime ? String(tgt.host.uptime).replace(/^up\s+/, '') : null)],
    ['Last Restart', tgt.oracle?.startup_time ? fmtT(String(tgt.oracle.startup_time).replace(' ', 'T')) : null],
    ['Status', tgt.oracle ? [tgt.oracle.status, tgt.oracle.open_mode, tgt.oracle.instance_role].filter(Boolean).join(' · ') : tgt.host?.status],
  ];

  const quickActions = (
    <Card title="Quick Actions">
      {!actions.length ? <p className="text-[13px] text-muted">No linked database or host for this alert.</p> : (
        <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-3">
          {actions.map((x) => (
            <button key={x.label} type="button" onClick={() => navigate(x.to)} className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5 text-left text-[13.5px] font-semibold text-fg hover:border-accent hover:bg-accent-soft/40">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"><Icon name={x.icon} size={16} /></span>{x.label}
            </button>
          ))}
        </div>
      )}
      <p className="mt-2 text-[11px] text-subtle">Changes such as adding a datafile are made by your DBA in the database — see Suggested Actions. ActMon does not run them from here.</p>
    </Card>
  );

  const content = () => {
    if (tab === 'overview') {
      if (!isTs) {
        return (
          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Alert Summary">
              <KV rows={[['Alert', a.rule_name], ['Message', a.message], ['Metric', a.metric], ['Current Value', a.value != null ? `${a.value}` : null],
                ['Threshold', d.thresholds ? Object.entries(d.thresholds).filter(([k]) => ['warning', 'critical'].includes(k)).map(([k, v]) => `${k} ${v}`).join(' · ') : (a.threshold != null ? `${a.threshold}` : null)],
                ['First Seen', fmtT(d.first_seen)], ['Occurrences', d.occurrences], ['Object', sub.name]]} />
            </Card>
            <Card title="Host & Database Information"><KV rows={hostRows} /></Card>
            <div className="xl:col-span-2">{quickActions}</div>
          </div>
        );
      }
      const pieData = [{ name: 'Used', v: used || 0, c: RED }, { name: 'Free', v: free || 0, c: '#e5e7eb' }];
      const loc = files.length ? files.map((f) => f.file_name).filter(Boolean) : null;
      return (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 xl:grid-cols-[1fr_1.15fr]">
            <Card title="Disk Usage Overview">
              <div className="flex flex-wrap items-center gap-6">
                <div className="relative h-44 w-44 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart><Pie data={pieData} dataKey="v" innerRadius="68%" outerRadius="100%" startAngle={90} endAngle={-270} stroke="none" isAnimationActive={false}>
                      {pieData.map((p) => <Cell key={p.name} fill={p.c} />)}</Pie></PieChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-0 grid place-items-center text-center"><div><div className="text-[26px] font-bold text-fg">{pct != null ? `${pct}%` : 'N/A'}</div><div className="text-[12.5px] text-muted">Used</div></div></div>
                </div>
                <dl className="min-w-[220px] flex-1 space-y-3 text-[14px]">
                  {[[RED, 'Used Space', fmtMB(used)], ['#cbd5e1', 'Free Space', fmtMB(free)], [null, 'Total Space', fmtMB(total)], [null, 'Usage Percentage', pct != null ? `${pct}%` : 'N/A']].map(([c, k, v]) => (
                    <div key={k} className="flex items-center gap-3">
                      {c ? <span className="h-3 w-3 rounded-full" style={{ background: c }} /> : <Icon name={k === 'Total Space' ? 'database' : 'gauge'} size={14} className="text-accent" />}
                      <dt className="w-32 text-muted">{k}</dt><dd className="font-semibold tabular-nums text-fg">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </Card>
            {trendCard()}
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Tablespace Details">
              <KV rows={[['Tablespace Name', sub.name], ['Database', tgt.connection_name], ['Used Space', used != null ? `${fmtMB(used)} (${pct}%)` : null],
                ['Free Space', free != null ? `${fmtMB(free)} (${total ? (100 * free / total).toFixed(1) : '?'}%)` : null], ['Total Space', fmtMB(total)],
                ['Location', fq.isLoading ? 'Loading…' : loc ? (loc.length > 2 ? `${loc[0]} (+${loc.length - 1} more files)` : loc.join(', ')) : (fq.isError ? 'Unavailable' : null)],
                ['Autoextend', files.length ? `${files.filter((f) => /yes/i.test(String(f.autoextend))).length} of ${files.length} files${files.some((f) => f.max_gb) ? ` · max ${files.reduce((s, f) => s + (Number(f.max_gb) || 0), 0).toFixed(1)} GB` : ''}` : null],
                ['Last Checked', fmtT(lastTrend?.t || a.created_at)],
                ['Threshold', d.thresholds ? `Warning: ${d.thresholds.warning}%  |  Critical: ${d.thresholds.critical}%` : null]]} />
            </Card>
            <Card title="Host & Database Information"><KV rows={hostRows} /></Card>
          </div>
          <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
            <Card title="Top Objects Using Space" right={objects.length > 5 && <button type="button" onClick={() => setTab('objects')} className="text-[13px] font-semibold text-accent hover:underline">View all {objects.length}</button>}>
              {sq.isLoading ? <div className="h-32 animate-pulse rounded bg-sunken" /> : objectsTable(5)}
              {sq.data?.objects_captured_at && <p className="mt-1.5 text-[11px] text-subtle">Sizes recorded {fmtT(sq.data.objects_captured_at)} · % of tablespace total.</p>}
            </Card>
            {quickActions}
          </div>
        </div>
      );
    }
    if (tab === 'metrics') {
      const occ = (d.history || []).filter((h) => h.value != null).slice().reverse().map((h) => ({ t: Date.parse(h.at), v: h.value }));
      return (
        <div className="flex flex-col gap-4">
          {isTs ? trendCard(300) : <Card title="Usage Trend"><Empty title="No stored metric series for this alert type">The alert carries its value in each notification; see the occurrence chart below.</Empty></Card>}
          <Card title="Value at Each Notification">
            {occ.length < 2 ? <Empty title="Not enough notifications to chart" /> : (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={occ} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
                    <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                    <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tShort} tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} stroke="var(--border)" />
                    <YAxis tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} stroke="var(--border)" />
                    <Tooltip labelFormatter={fmtT} formatter={(v) => [`${v}%`, 'Value']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Area type="stepAfter" dataKey="v" stroke="#f97316" fill="#f97316" fillOpacity={0.15} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
        </div>
      );
    }
    if (tab === 'objects') {
      return (
        <Card title={isTs ? `Objects in ${sub.name}` : 'Affected Objects'}>
          {isTs ? objectsTable(25) : sub.name ? <KV rows={[['Object', sub.name], ['Type', sub.kind === 'oracle_service' ? 'Oracle service' : 'N/A'], ['Source', a.source]]} />
            : <Empty title="This alert is about the source as a whole">{a.source}</Empty>}
        </Card>
      );
    }
    if (tab === 'events' || tab === 'history') {
      const rows = tab === 'events' ? d.recent_events : d.history;
      return (
        <Card title={tab === 'events' ? `Recent Events on ${a.source} (24 h)` : `History of this alert (${d.occurrences} notifications)`}>
          {!rows?.length ? <Empty title="Nothing recorded" /> : (
            <table className="w-full text-[13px]">
              <thead><tr className="border-b border-border text-left text-[12px] text-muted"><th className="py-1.5">Time</th><th>Level</th><th>Message</th><th>State</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={cn('border-b border-border last:border-0', r.id === a.id && 'bg-accent-soft/50')}>
                    <td className="whitespace-nowrap py-1.5 pr-3 text-fg">{fmtT(r.at)}</td>
                    <td className="pr-3"><span className={cn('rounded px-1.5 text-[11.5px] font-semibold capitalize', SEV_BADGE[r.severity] || SEV_BADGE.info)}>{r.severity}</span></td>
                    <td className="pr-3 text-fg">{r.message}</td>
                    <td className="whitespace-nowrap text-muted">{r.acknowledged ? 'Acknowledged' : 'Active'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      );
    }
    if (tab === 'related') {
      return (
        <Card title={`Other Active Alerts on ${a.source}`}>
          {!d.related?.length ? <Empty icon="check" title="No other active alerts on this source" /> : (
            <ul className="divide-y divide-border">
              {d.related.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => onSelect(String(r.id))} className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-raised">
                    <span className={cn('rounded px-1.5 text-[11.5px] font-semibold capitalize', SEV_BADGE[severityOf(r.severity).id] || SEV_BADGE.info)}>{severityOf(r.severity).label}</span>
                    <span className="min-w-0 flex-1"><span className="block font-semibold text-fg">{r.rule_name}</span><span className="block truncate text-[12.5px] text-muted">{r.message}</span></span>
                    <Icon name="chevron-right" size={15} className="text-muted" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      );
    }
    if (tab === 'suggested') {
      const tips = isTs ? [
        ['Confirm the growth', 'Check the Usage Trend and the objects table: is one segment growing, or is it general growth?'],
        ['Add space (DBA)', `Add or resize a datafile, e.g. ALTER TABLESPACE ${sub.name} ADD DATAFILE … SIZE …; or enable AUTOEXTEND with a MAXSIZE on an existing file.`],
        ['Reclaim space (DBA)', 'Purge recycle-bin objects, archive or partition-drop old data in the largest segments, or shrink segments with ALTER TABLE … SHRINK SPACE where row movement is enabled.'],
        ['Review the threshold', `This alert fires above ${d.thresholds?.critical}% used. Large, slowly-growing tablespaces may warrant a capacity plan rather than a fixed percentage.`],
      ] : sub.kind === 'oracle_service' ? [
        ['Check the service', `Verify with: SELECT name, network_name FROM v$active_services; and lsnrctl services. Start it with srvctl start service (RAC) or DBMS_SERVICE.START_SERVICE('${sub.name}').`],
        ['Check the listener', 'Run lsnrctl status on the database host to confirm the service is registered.'],
      ] : [['Review the source', `Open ${a.source} and the rule that raised this alert to confirm the condition is still present.`]];
      return (
        <Card title="Suggested Actions">
          <ol className="space-y-3">
            {tips.map(([t, x], i) => (
              <li key={t} className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-[12px] font-bold text-accent">{i + 1}</span>
                <div><div className="font-semibold text-fg">{t}</div><div className="text-[13px] text-muted">{x}</div></div></li>
            ))}
          </ol>
          <p className="mt-3 text-[11px] text-subtle">Guidance only — run changes through your normal change process. ActMon does not execute these.</p>
        </Card>
      );
    }
    if (tab === 'comments') {
      return (
        <Card title="Comments">
          {cq.isLoading ? <div className="h-20 animate-pulse rounded bg-sunken" /> : !cq.data?.length ? <p className="mb-3 text-[13px] text-muted">No comments yet.</p> : (
            <ul className="mb-3 space-y-2.5">
              {cq.data.map((c) => (
                <li key={c.id} className="rounded-lg border border-border bg-raised px-3 py-2">
                  <div className="text-[12px] text-muted"><b className="text-fg">{c.username}</b> · {fmtT(c.at)}</div>
                  <div className="mt-0.5 whitespace-pre-wrap text-[13.5px] text-fg">{c.body}</div>
                </li>
              ))}
            </ul>
          )}
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} maxLength={4000} aria-label="New comment" placeholder="Add a note for the team…"
            className="w-full rounded-control border border-border bg-surface px-3 py-2 text-[13.5px] text-fg outline-none focus:border-accent" />
          <div className="mt-2 flex items-center justify-end gap-2">
            {comment.isError && <span className="text-[12px] text-danger-fg">{comment.error?.message}</span>}
            <button type="button" disabled={!draft.trim() || comment.isPending} onClick={() => comment.mutate()} className="rounded-control bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50">Add Comment</button>
          </div>
        </Card>
      );
    }
    return null;
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-40" style={{ top: 'var(--topnav-h, 88px)' }} role="dialog" aria-modal="true" aria-label="Alert details">
      <button type="button" aria-label="Close alert details" className="absolute inset-0 h-full w-full cursor-default bg-black/10" onClick={onClose} />
      <aside className="absolute bottom-0 right-0 top-0 flex w-full flex-col overflow-hidden border-l border-border bg-canvas shadow-2xl lg:w-[74%]" style={{ background: 'var(--surface-canvas, #f7f5f0)' }}>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-5">
          {/* top row */}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onClose} className="inline-flex items-center gap-2 text-[14.5px] font-semibold text-accent hover:underline"><Icon name="arrow-left" size={16} />Back to Alerts</button>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button type="button" onClick={share} className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-[13.5px] font-semibold text-fg hover:bg-raised"><Icon name="link" size={15} className="text-accent" />{copied ? 'Link copied' : 'Share'}</button>
              {a && isAckable(a) && (
                <button type="button" onClick={() => ack.mutate()} disabled={ack.isPending || ack.isSuccess} className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-[13.5px] font-semibold text-fg hover:bg-raised disabled:opacity-60">
                  <Icon name="check" size={15} className="text-accent" />{ack.isSuccess ? 'Acknowledged' : ack.isPending ? 'Acknowledging…' : 'Acknowledge'}
                </button>
              )}
              <button type="button" onClick={() => navigate('/alerts?tab=rules')} className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-[13.5px] font-semibold text-fg hover:bg-raised"><Icon name="settings" size={15} className="text-accent" />Create Rule</button>
              <div className="relative">
                <button type="button" aria-expanded={menu} onClick={() => setMenu(!menu)} disabled={!actions.length} className="inline-flex h-10 items-center gap-2 rounded-lg bg-accent px-4 text-[13.5px] font-semibold text-white disabled:opacity-50"><Icon name="zap" size={15} />Actions<Icon name="chevron-down" size={14} /></button>
                {menu && (
                  <div className="absolute right-0 z-10 mt-1 w-56 rounded-lg border border-border bg-surface py-1 shadow-lg" onMouseLeave={() => setMenu(false)}>
                    {actions.map((x) => <button key={x.label} type="button" onClick={() => navigate(x.to)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-fg hover:bg-raised"><Icon name={x.icon} size={14} className="text-accent" />{x.label}</button>)}
                  </div>
                )}
              </div>
              <button type="button" aria-label="Close" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-lg text-muted hover:bg-raised"><Icon name="close" size={18} /></button>
            </div>
          </div>
          {ack.isError && <p className="mt-2 text-[12.5px] text-danger-fg">{ack.error?.message}</p>}

          {body() || (
            <>
              {/* identity */}
              <div className="mt-5 flex flex-wrap items-start gap-4">
                <span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl border border-border bg-surface text-accent"><Icon name="database" size={28} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-[26px] font-bold text-fg">{isTs ? 'Disk usage' : a.rule_name}</h2>
                    <span className={cn('inline-flex items-center gap-1 rounded-md px-2.5 py-0.5 text-[13px] font-semibold', SEV_BADGE[sev.id] || SEV_BADGE.info)}><Icon name="alert" size={13} />{sev.label}</span>
                  </div>
                  <p className="mt-1 text-[15px] text-fg">{a.message}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {tags.map((t) => <span key={t} className="rounded-full border border-border bg-accent-soft/50 px-3 py-0.5 text-[12.5px] font-medium text-fg">{t}</span>)}
                  </div>
                </div>
                <dl className="grid grid-cols-[auto_auto_auto] gap-x-8 gap-y-3 text-[13px]">
                  <div><dt className="text-muted">Alert ID</dt><dd className="font-semibold text-fg">{alertCode(a)}</dd></div>
                  <div><dt className="text-muted">Created</dt><dd className="text-fg">{fmtT(d.first_seen)}<span className="block text-[11.5px] text-muted">({ago(d.first_seen)}{d.occurrences > 1 ? ` · ${d.occurrences} notifications` : ''})</span></dd></div>
                  <div><dt className="text-muted">Status</dt><dd><span className={cn('inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[12.5px] font-semibold', ack.isSuccess ? 'bg-success-soft text-success-fg' : 'bg-danger-soft text-danger-fg')}>{ack.isSuccess ? 'Acknowledged' : 'Active'}</span></dd></div>
                  <div><dt className="text-muted">Source</dt><dd className="flex items-center gap-1.5 font-semibold text-fg"><Icon name="database" size={14} className="text-accent" />{a.source}{tgt.tech ? ` (${tgt.tech === 'oracle' ? 'Oracle' : tgt.tech})` : ''}</dd></div>
                  <div><dt className="text-muted">Host</dt><dd className="flex items-center gap-1.5 font-semibold text-fg"><Icon name="server" size={14} className="text-muted" />{tgt.host?.server_name || tgt.db_host || 'N/A'}</dd></div>
                </dl>
              </div>

              {/* tabs */}
              <nav className="mt-5 flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Alert detail sections">
                {TABS.map(([k, l]) => (
                  <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                    className={cn('whitespace-nowrap border-b-2 px-4 py-2.5 text-[14px]', tab === k ? 'border-accent font-semibold text-accent' : 'border-transparent text-fg hover:bg-raised')}>
                    {k === 'related' ? `${l} (${d.related?.length || 0})` : l}
                  </button>
                ))}
              </nav>
              <div className="mt-4">{content()}</div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
