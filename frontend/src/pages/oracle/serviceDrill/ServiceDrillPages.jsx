/**
 * Oracle service drill-down, one page per level:
 *
 *   Service → Instances → Instance → Sessions → Session → SQL
 *
 * Each page reads its own record from an id-addressed endpoint
 * (oracle_service_drill_service.py), so a refresh or a shared link lands on
 * the same record. Nothing here is computed into existence: a value the
 * backend did not return renders "N/A", and a section it could not read is
 * listed under the page.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import client from '@/api/client';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Table2, { EmptyState } from '@/components/ui/Table';
import CopyButton from '@/components/ui/CopyButton';
import { fmtMB } from '@/config/dbCatalog';

import DrillShell, {
  useDrillNav, DrillCard, Facts, StatusBadge, fmtNum, fmtSecs, fmtTime, na, useDrillParams,
} from './DrillShell';
import { drillPath } from './drillPaths';

/* ── card style shared by every drill level (same props as enginePanels) ── */
function Panel({ title, icon, subtitle, actions, children }) {
  return (
    <section className="min-w-0 rounded-2xl border border-border bg-surface shadow-sm">
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        {icon && <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-text"><Icon name={icon} size={18} /></span>}
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-bold text-fg">{title}</h2>
          {subtitle && <p className="text-[12px] text-muted">{subtitle}</p>}
        </div>
        {actions}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}
const TablePanel = Panel;

function MetricTile({ label, value, sub, icon, tone = 'neutral', hint }) {
  const toneCls = { good: 'text-success-fg', warn: 'text-warning-fg', bad: 'text-danger-fg' }[tone] || 'text-fg';
  return (
    <div title={hint} className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
      {icon && <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-text"><Icon name={icon} size={20} /></span>}
      <div className="min-w-0">
        <p className="truncate text-[12px] font-semibold text-muted">{label}</p>
        <div className={`truncate text-[22px] font-bold leading-tight ${toneCls}`}>{value ?? '—'}</div>
        {sub && <p className="truncate text-[11px] text-subtle">{sub}</p>}
      </div>
    </div>
  );
}

const api = (id, path, params) => client.get(`/connections/oracle/${id}/${path}`, { params, timeout: 60000 }).then((r) => r.data);

// Live reads on a production database: refreshed on request and every 60 s,
// never faster.
const LIVE = { refetchInterval: 60000, retry: false, staleTime: 15000 };

function useServiceDetail(id, service) {
  return useQuery({ queryKey: ['oracleServiceDetail', id, service], queryFn: () => api(id, 'oracle-service-detail', { service }), ...LIVE });
}
function useServiceInstance(id, service, inst) {
  return useQuery({ queryKey: ['oracleServiceInstance', id, service, inst], queryFn: () => api(id, 'oracle-service-instance', { service, inst_id: inst }), ...LIVE });
}

/* ═══ Level 2 — the service ═══════════════════════════════════════════ */

/* Card tints for the KPI row. The tone follows the value's meaning (a
   status, a count of alerts), never decoration. */
const KPI_TONES = {
  accent: { card: 'bg-accent-softer border-accent/30', disc: 'bg-accent-soft text-accent-text', label: 'text-accent-text' },
  violet: { card: 'bg-[color-mix(in_oklab,#8b5cf6_7%,var(--surface))] border-[#8b5cf6]/25', disc: 'bg-[#8b5cf6]/15 text-[#7c3aed]', label: 'text-[#7c3aed]' },
  success: { card: 'bg-success-soft/50 border-success/25', disc: 'bg-success-soft text-success-fg', label: 'text-success-fg' },
  warning: { card: 'bg-warning-soft/50 border-warning/25', disc: 'bg-warning-soft text-warning-fg', label: 'text-warning-fg' },
  danger: { card: 'bg-danger-soft/50 border-danger/25', disc: 'bg-danger-soft text-danger-fg', label: 'text-danger-fg' },
  neutral: { card: 'bg-surface border-border', disc: 'bg-sunken text-muted', label: 'text-muted' },
};

function Kpi({ icon, label, value, sub, tone = 'accent' }) {
  const t = KPI_TONES[tone] || KPI_TONES.accent;
  return (
    <div className={`flex items-start gap-4 rounded-2xl border p-5 shadow-sm ${t.card}`}>
      <span className={`grid h-14 w-14 shrink-0 place-items-center rounded-full ${t.disc}`}><Icon name={icon} size={26} /></span>
      <div className="min-w-0">
        <p className={`text-[13px] font-semibold ${t.label}`}>{label}</p>
        <div className="mt-1 text-[28px] font-bold leading-tight text-fg">{value}</div>
        {sub && <p className="mt-1 text-[12px] text-muted">{sub}</p>}
      </div>
    </div>
  );
}

/** A section card: icon disc, title, optional subtitle and action. */
function Section({ icon, title, subtitle, action, children, className = '' }) {
  return (
    <section className={`rounded-2xl border border-border bg-surface shadow-sm ${className}`}>
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-text"><Icon name={icon} size={20} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-bold text-fg">{title}</h2>
          {subtitle && <div className="text-[12px] text-muted">{subtitle}</div>}
        </div>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function LinkButton({ children, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-control border border-accent/40 px-3 py-1.5 text-[13px] font-semibold text-accent-text hover:bg-accent-softer">
      {children} <Icon name="arrow-right" size={14} />
    </button>
  );
}

/** Green when the service runs there, red when it does not, grey when unread. */
const Dot = ({ on }) => (
  <span className={`inline-block h-3 w-3 shrink-0 rounded-full ${on == null ? 'bg-subtle' : on ? 'bg-success' : 'bg-danger'}`} />
);

/** The large status pill of the Overall Status card. */
const PILL = {
  online: ['bg-success-soft text-success-fg', 'bg-success', 'Online'],
  partial: ['bg-warning-soft text-warning-fg', 'bg-warning', 'Partial'],
  offline: ['bg-danger-soft text-danger-fg', 'bg-danger', 'Offline'],
  unknown: ['bg-sunken text-muted', 'bg-subtle', 'Unknown'],
};
function StatusPill({ value }) {
  const [cls, dot, label] = PILL[value] || PILL.unknown;
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-4 py-1 text-[17px] font-bold ${cls}`}>
      <span className={`h-3 w-3 rounded-full ${dot}`} />{label}
    </span>
  );
}

const STATUS_SUB = {
  online: 'Running on every instance',
  partial: 'Running on some instances only',
  offline: 'Not running on any instance',
  unknown: 'Availability could not be read',
};
const STATUS_TONE = { online: 'accent', partial: 'warning', offline: 'danger', unknown: 'neutral' };

const cfgLabel = (k) => k.replace(/_/g, ' ')
  .replace(/\b(clb|dtp|aq|ha)\b/gi, (m) => m.toUpperCase())
  .replace(/^\w/, (c) => c.toUpperCase());

export function OracleServiceDetailPage() {
  const { id, service } = useDrillParams();
  const navigate = useDrillNav();
  const q = useServiceDetail(id, service);
  const d = q.data;
  const insts = d?.instances || [];
  const crit = (d?.alerts || []).filter((a) => (a.message_type || '').toLowerCase() === 'error' || a.message_level === 1).length;
  const metricFor = (instId) => (d?.metrics || []).find((m) => m.inst_id === instId);
  const maxSessions = Math.max(1, ...insts.map((i) => i.sessions?.total || 0));
  const cfg = d?.service?.config;
  const role = d?.database?.database_role;

  return (
    <DrillShell ctx={{ service }} query={q} icon="database"
      loadingLabel="Connecting to Oracle…" loadingDetail="Reading the service, its instances and sessions." title={d?.service?.service_name || service}
      subtitle={d?.status === 'success'
        ? ['Oracle service', d.database?.name, d.service.network_name !== d.service.service_name ? d.service.network_name : null].filter(Boolean).join('  |  ')
        : 'Oracle service'}
      badge={d?.status === 'success' ? <StatusBadge value={d.overall} size="sm" /> : null}>
      {d?.status === 'success' && (
        <div className="space-y-5">
          {/* ── KPI row ── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Kpi icon="activity" label="Overall Status" tone={STATUS_TONE[d.overall] || 'neutral'}
              value={<StatusPill value={d.overall} />} sub={STATUS_SUB[d.overall]} />
            <Kpi icon="database" label="Active Instances" tone="violet"
              value={d.active_instances == null ? 'N/A' : `${d.active_instances} / ${insts.length || 'N/A'}`}
              sub={d.active_instances == null ? 'Availability could not be read'
                : d.active_instances === insts.length ? 'All instances are active' : `${insts.length - d.active_instances} not running this service`} />
            <Kpi icon="users" label="Total Sessions" tone="success" value={na(d.sessions.total, fmtNum)}
              sub={d.sessions.active != null ? `${fmtNum(d.sessions.active)} active sessions${d.sessions.truncated ? ' (capped)' : ''}` : undefined} />
            <Kpi icon="database" label="Database" tone="warning" value={na(d.database?.name)}
              sub={d.database ? [role ? role.charAt(0) + role.slice(1).toLowerCase() : null, d.database.cdb === 'YES' ? 'CDB' : null].filter(Boolean).join(' - ') : undefined} />
            <Kpi icon="alert" label="Outstanding Alerts" tone={d.alerts == null ? 'neutral' : 'danger'}
              value={d.alerts == null ? 'N/A' : d.alerts.length}
              sub={d.alerts == null ? 'Alerts could not be read' : d.alerts.length ? `${crit} critical` : 'No active alerts'} />
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.15fr_1fr]">
            {/* ── RAC instances ── */}
            <Section icon="server" title="RAC Instances"
              subtitle={(
                <>
                  <span className="text-[13px] font-semibold text-accent-text">
                    {d.active_instances == null ? 'Availability unknown' : `${d.active_instances} of ${insts.length} running this service`}
                  </span>
                  <br />
                  Instance-wise service status, sessions and performance
                </>
              )}
              action={<LinkButton onClick={() => navigate(drillPath(id, { service, level: 'instances' }))}>View RAC Details</LinkButton>}>
              {insts.length === 0 ? <p className="text-[13px] text-muted">No instances reported.</p> : (
                <div className="grid gap-4 md:grid-cols-2">
                  {insts.map((i) => {
                    const m = metricFor(i.inst_id);
                    return (
                      <button key={i.inst_id} type="button" onClick={() => navigate(drillPath(id, { service, inst: i.inst_id }))}
                        className="overflow-hidden rounded-xl border border-border text-left transition hover:border-strong hover:shadow-md">
                        <span className="flex items-center gap-2.5 bg-sunken px-4 py-3">
                          <Dot on={i.service_status == null ? null : i.service_status === 'active'} />
                          <span className="text-[16px] font-bold text-fg">{i.instance_name}</span>
                          <Icon name="chevron-right" size={16} className="ml-auto text-subtle" />
                        </span>
                        <span className="grid grid-cols-3 divide-x divide-border px-1 py-3">
                          <span className="px-3">
                            <span className="flex items-center gap-1 text-[12px] text-muted"><Icon name="users" size={12} />Sessions</span>
                            <span className="mt-1 block text-[18px] font-bold text-accent-text">
                              {i.sessions?.total ?? 'N/A'}
                              {i.sessions && <span className="ml-1.5 text-[12px] font-medium">{i.sessions.active} active</span>}
                            </span>
                          </span>
                          <span className="px-3">
                            <span className="flex items-center gap-1 text-[12px] text-muted"><Icon name="cpu" size={12} />CPU / Call</span>
                            <span className="mt-1 block text-[18px] font-bold text-fg">{na(m?.cpu_ms_per_call, (v) => `${fmtNum(v, 2)} ms`)}</span>
                          </span>
                          <span className="px-3">
                            <span className="flex items-center gap-1 text-[12px] text-muted"><Icon name="zap" size={12} />Calls / s</span>
                            <span className="mt-1 block text-[18px] font-bold text-fg">{na(m?.calls_per_sec, (v) => fmtNum(v, 2))}</span>
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </Section>

            {/* ── sessions by instance ── */}
            <Section icon="users" title="Sessions by Instance"
              action={<LinkButton onClick={() => navigate(drillPath(id, { service, level: 'instances' }))}>View All Sessions</LinkButton>}>
              {insts.length === 0 || insts.every((i) => i.sessions == null) ? (
                <p className="text-[13px] text-muted">Session counts could not be read.</p>
              ) : (
                <ul className="space-y-3">
                  {insts.map((i) => (
                    <li key={i.inst_id}>
                      <button type="button" onClick={() => navigate(drillPath(id, { service, inst: i.inst_id, level: 'sessions' }))}
                        className="flex w-full items-center gap-4 rounded-xl px-2 py-2 text-left hover:bg-sunken">
                        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent-softer text-accent-text"><Icon name="server" size={18} /></span>
                        <span className="w-24 shrink-0 text-[14px] font-bold text-fg">{i.instance_name}</span>
                        <span className="h-3 min-w-[80px] flex-1 overflow-hidden rounded-full bg-sunken">
                          <span className="block h-full rounded-full bg-accent" style={{ width: `${((i.sessions?.total || 0) / maxSessions) * 100}%` }} />
                        </span>
                        <span className="w-12 text-right text-[16px] font-bold text-fg">{i.sessions?.total ?? 'N/A'}</span>
                        <span className="w-20 text-[13px] font-medium text-accent-text">{i.sessions ? `${i.sessions.active} active` : ''}</span>
                        <Icon name="chevron-right" size={16} className="text-subtle" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {/* ── performance ── */}
            <Section icon="trend" title="Performance" subtitle="GV$SERVICEMETRIC — latest interval per instance">
              {d.metrics == null ? <p className="text-[13px] text-muted">Service metrics could not be read.</p>
                : d.metrics.length === 0 ? <p className="text-[13px] text-muted">No metric interval reported for this service yet.</p> : (
                  <div className="overflow-x-auto rounded-xl border border-border">
                    <table className="w-full min-w-[560px] text-[13px]">
                      <thead className="bg-sunken text-left text-[12px] font-semibold text-muted">
                        <tr>{['Instance', 'Elapsed / Call', 'CPU / Call', 'Calls / s', 'Interval End', ''].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {d.metrics.map((m) => {
                          const inst = insts.find((x) => x.inst_id === m.inst_id);
                          return (
                            <tr key={m.inst_id} onClick={() => navigate(drillPath(id, { service, inst: m.inst_id }))}
                              className="cursor-pointer border-t border-border hover:bg-sunken">
                              <td className="px-4 py-3.5">
                                <span className="flex items-center gap-2 font-semibold">
                                  <Dot on={inst ? inst.service_status === 'active' : null} />{inst?.instance_name || `#${m.inst_id}`}
                                </span>
                              </td>
                              <td className="px-4">{na(m.elapsed_ms_per_call, (v) => `${fmtNum(v, 2)} ms`)}</td>
                              <td className="px-4">{na(m.cpu_ms_per_call, (v) => `${fmtNum(v, 2)} ms`)}</td>
                              <td className="px-4">{na(m.calls_per_sec, (v) => fmtNum(v, 2))}</td>
                              <td className="px-4">{fmtTime(m.end_time)}</td>
                              <td className="px-4 text-right"><Icon name="chevron-right" size={16} className="text-subtle" /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
            </Section>

            {/* ── configuration ── */}
            <Section icon="settings" title="Configuration" subtitle="DBA_SERVICES">
              <dl className="divide-y divide-border text-[13px]">
                {[
                  ['user', 'Service name', d.service.service_name],
                  ['globe', 'Network name', d.service.network_name || 'N/A'],
                  ['calendar', 'Created', fmtTime(d.service.creation_date)],
                  ...(cfg ? Object.entries(cfg).map(([k, v]) => ['settings', cfgLabel(k), v ?? 'N/A']) : [['settings', 'Settings', 'N/A']]),
                  ['database', 'Database', d.database ? `${d.database.name} (${d.database.db_unique_name || 'N/A'})` : 'N/A'],
                  ['eye', 'Open mode', d.database?.open_mode || 'N/A'],
                ].map(([ic, k, v]) => (
                  <div key={k} className="grid grid-cols-[minmax(150px,45%)_1fr] items-center gap-3 py-1.5">
                    <dt className="flex items-center gap-2 text-muted"><Icon name={ic} size={14} className="text-subtle" />{k}</dt>
                    <dd className="break-words font-medium text-fg">{v}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          </div>

          {/* ── alerts & events ── */}
          {d.alerts == null ? (
            <Section icon="bell" title="Alerts & Events" subtitle="DBA_OUTSTANDING_ALERTS raised on this service">
              <p className="text-[13px] text-muted">Alerts could not be read.</p>
            </Section>
          ) : d.alerts.length === 0 ? (
            <section className="flex flex-wrap items-center gap-4 rounded-2xl border border-success/25 bg-success-soft/40 px-5 py-4 shadow-sm">
              <span className="grid h-11 w-11 place-items-center rounded-full bg-success-soft text-success-fg"><Icon name="bell" size={20} /></span>
              <div className="min-w-[200px]">
                <h2 className="text-[16px] font-bold text-fg">Alerts &amp; Events</h2>
                <p className="text-[12px] text-muted">DBA_OUTSTANDING_ALERTS raised on this service</p>
              </div>
              <div className="flex flex-1 items-center justify-center gap-3">
                <Icon name="shield-check" size={26} className="text-success-fg" />
                <div>
                  <p className="text-[14px] font-bold text-fg">No outstanding alerts on this service</p>
                  <p className="text-[12px] text-muted">Oracle has raised no server alert on this service object.</p>
                </div>
              </div>
            </section>
          ) : (
            <Section icon="bell" title="Alerts & Events" subtitle="DBA_OUTSTANDING_ALERTS raised on this service">
              <Table2
                columns={[{ key: 'w', label: 'Raised' }, { key: 't', label: 'Type' }, { key: 'r', label: 'Reason' }, { key: 'a', label: 'Suggested action' }]}
                cellText
                rows={d.alerts.map((a, i) => ({ key: i, cells: { w: fmtTime(a.creation_time), t: a.message_type || 'N/A', r: a.reason, a: a.suggested_action || '—' } }))}
              />
            </Section>
          )}
        </div>
      )}
    </DrillShell>
  );
}

/* ═══ Level 3 — the service's instances ═══════════════════════════════ */

export function OracleServiceInstancesPage() {
  const { id, service } = useDrillParams();
  const navigate = useDrillNav();
  const q = useServiceDetail(id, service);
  const d = q.data;

  return (
    <DrillShell ctx={{ service, level: 'instances' }} query={q}
      loadingLabel="Reading RAC instances…" loadingDetail="GV$INSTANCE and the service's registrations." icon="server" title={d?.service?.service_name || service}
      subtitle="RAC instances for this service" badge={d?.status === 'success' ? <StatusBadge value={d.overall} size="sm" /> : null}>
      {d?.status === 'success' && (
        <TablePanel title="Instances" icon="server" subtitle="GV$INSTANCE × GV$ACTIVE_SERVICES × GV$SESSION — click an instance">
          <Table2
            darkHeader
            columns={[
              { key: 'inst', label: 'Instance' }, { key: 'num', label: 'Number' }, { key: 'host', label: 'Host' },
              { key: 'is', label: 'Instance status' }, { key: 'ss', label: 'Service status' },
              { key: 'sess', label: 'Sessions' }, { key: 'ver', label: 'Version' }, { key: 'up', label: 'Started' },
            ]}
            rows={(d.instances || []).map((i) => ({
              key: i.inst_id,
              onClick: () => navigate(drillPath(id, { service, inst: i.inst_id })),
              cells: {
                inst: <span className="font-semibold text-accent-text">{i.instance_name}</span>,
                num: i.instance_number,
                host: i.host_name || 'N/A',
                is: <StatusBadge value={i.instance_status} />,
                ss: <StatusBadge value={i.service_status} />,
                sess: i.sessions == null ? 'N/A' : `${i.sessions.total} (${i.sessions.active} active)`,
                ver: i.version || 'N/A',
                up: fmtTime(i.startup_time),
              },
            }))}
            empty={<EmptyState icon="server" title="No instances reported" body="GV$INSTANCE returned no rows." />}
          />
        </TablePanel>
      )}
    </DrillShell>
  );
}

/* ═══ Level 4 — one instance, as it serves this service ═══════════════ */

const SYSMETRIC = [
  ['Host CPU Utilization (%)', 'Host CPU', (v) => `${fmtNum(v, 1)}%`],
  ['Average Active Sessions', 'Avg active sessions', (v) => fmtNum(v, 2)],
  ['Database CPU Time Ratio', 'DB CPU ratio', (v) => `${fmtNum(v, 1)}%`],
  ['Database Wait Time Ratio', 'DB wait ratio', (v) => `${fmtNum(v, 1)}%`],
  ['Executions Per Sec', 'Executions / s', (v) => fmtNum(v, 1)],
  ['User Transaction Per Sec', 'Transactions / s', (v) => fmtNum(v, 2)],
  ['Logical Reads Per Sec', 'Logical reads / s', (v) => fmtNum(v, 0)],
  ['Physical Reads Per Sec', 'Physical reads / s', (v) => fmtNum(v, 0)],
  ['Buffer Cache Hit Ratio', 'Buffer cache hit', (v) => `${fmtNum(v, 2)}%`],
  ['Current Logons Count', 'Logons (all services)', (v) => fmtNum(v, 0)],
];

export function OracleServiceInstancePage() {
  const { id, service, inst } = useDrillParams();
  const q = useServiceInstance(id, service, inst);
  const d = q.data;
  const i = d?.instance;
  const sm = d?.sysmetrics;
  const m = d?.memory || {};

  return (
    <DrillShell ctx={{ service, inst }} names={{ instance: i?.instance_name }} query={q}
      loadingLabel="Reading instance details…" loadingDetail="Workload, memory and current waits." icon="server"
      title={i?.instance_name || `Instance ${inst}`} subtitle={i?.host_name}
      badge={i ? <StatusBadge value={i.instance_status} size="sm" /> : null}>
      {d?.status === 'success' && (
        <div className="space-y-gutter">
          <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
            <MetricTile label="Host CPU" icon="cpu" value={na(sm?.['Host CPU Utilization (%)']?.value, (v) => `${fmtNum(v, 1)}%`)} />
            <MetricTile label="SGA + PGA" icon="memory"
              value={m.sga_mb == null && m.pga_allocated_mb == null ? 'N/A' : fmtMB((m.sga_mb || 0) + (m.pga_allocated_mb || 0))}
              sub={`SGA ${na(m.sga_mb, fmtMB)} · PGA ${na(m.pga_allocated_mb, fmtMB)}`} />
            <MetricTile label="Service sessions" icon="users" value={na(d.sessions.total, fmtNum)}
              sub={d.sessions.active != null ? `${d.sessions.active} active` : undefined} />
            <MetricTile label="Waiting sessions" icon="clock"
              value={d.waits == null ? 'N/A' : d.waits.reduce((a, w) => a + w.sessions, 0)} sub="Non-idle waits now" />
          </div>

          <div className="grid gap-gutter-sm lg:grid-cols-[1fr_1.4fr]">
            <Panel title="Instance overview" icon="info">
              <Facts rows={[
                ['Instance name', i?.instance_name], ['Instance number', i?.instance_number], ['INST_ID', i?.inst_id],
                ['Host', i?.host_name], ['Version', i?.version], ['Started', fmtTime(i?.startup_time)],
                ['Instance status', <StatusBadge key="s" value={i?.instance_status} />],
                ['Database status', i?.database_status || 'N/A'],
                ['Service on this instance', <StatusBadge key="v" value={d.service_status} />],
                d.role ? ['Database role', d.role] : null,
              ]} />
            </Panel>
            <Panel title="Workload" icon="trend" subtitle="GV$SYSMETRIC — last 60-second interval, whole instance">
              {sm == null ? <p className="text-[12px] text-muted">System metrics could not be read.</p> : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {SYSMETRIC.map(([k, label, f]) => (
                    <div key={k} className="rounded-control bg-sunken px-3 py-2">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-subtle">{label}</p>
                      <p className="text-[15px] font-bold text-fg">{na(sm[k]?.value, f)}</p>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          <div className="grid gap-gutter-sm lg:grid-cols-2">
            <DrillCard icon="users" title="Sessions" to={drillPath(id, { service, inst, level: 'sessions' })}
              value={d.sessions.total == null ? 'Unavailable' : `${d.sessions.total} sessions of this service`}
              body="Every session of this service on this instance — open one for its SQL and waits" />
            <Panel title="Current waits" icon="clock" subtitle="This service's sessions on this instance, idle waits excluded">
              {d.waits == null ? <p className="text-[12px] text-muted">Waits could not be read.</p>
                : d.waits.length === 0 ? <p className="text-[12px] text-muted">No session of this service is waiting on anything right now.</p> : (
                  <Table2 columns={[{ key: 'e', label: 'Event' }, { key: 'c', label: 'Class' }, { key: 'n', label: 'Sessions' }, { key: 's', label: 'Longest' }]}
                    cellText
                    rows={d.waits.map((w) => ({ key: w.event, cells: { e: w.event, c: w.wait_class || 'N/A', n: w.sessions, s: fmtSecs(w.max_seconds) } }))} />
                )}
            </Panel>
          </div>

          {Array.isArray(d.service_metrics) && d.service_metrics.length > 0 && (
            <Panel title="Service performance on this instance" icon="chart-line" subtitle="GV$SERVICEMETRIC">
              <Facts rows={d.service_metrics.flatMap((x) => [
                ['Elapsed / call', na(x.elapsed_ms_per_call, (v) => `${fmtNum(v, 2)} ms`)],
                ['CPU / call', na(x.cpu_ms_per_call, (v) => `${fmtNum(v, 2)} ms`)],
                ['Calls / s', na(x.calls_per_sec, (v) => fmtNum(v, 2))],
                ['Interval', `${fmtTime(x.begin_time)} → ${fmtTime(x.end_time)}`],
              ])} />
            </Panel>
          )}
        </div>
      )}
    </DrillShell>
  );
}

/* ═══ Level 5 — sessions ══════════════════════════════════════════════ */

export function OracleServiceSessionsPage() {
  const { id, service, inst } = useDrillParams();
  const navigate = useDrillNav();
  const instQ = useServiceInstance(id, service, inst);
  const q = useQuery({
    queryKey: ['oracleServiceSessions', id, service, inst],
    queryFn: () => api(id, 'oracle-service-sessions', { service, inst_id: inst }),
    ...LIVE,
  });
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.sessions || []).filter((r) => (status === 'ALL' || (r.status || '').toUpperCase() === status)
      && (!s || [r.sid, r.username, r.machine, r.program, r.sql_id, r.module].some((x) => String(x ?? '').toLowerCase().includes(s))));
  }, [q.data, search, status]);
  const instName = instQ.data?.instance?.instance_name;

  return (
    <DrillShell ctx={{ service, inst, level: 'sessions' }} names={{ instance: instName }} query={q}
      loadingLabel="Fetching sessions…" loadingDetail="GV$SESSION for this service on this instance." icon="users"
      title={`Sessions · ${instName || `Instance ${inst}`}`} subtitle={`${service} — GV$SESSION, user sessions`}>
      {q.data?.status === 'success' && (
        <TablePanel title="Sessions" icon="users"
          subtitle={q.data.truncated ? `First ${q.data.cap} shown` : `${q.data.sessions.length} sessions`}
          actions={(
            <div className="flex items-center gap-2">
              <Input size="sm" icon="search" placeholder="Search sessions…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <Select size="sm" width="auto" value={status} onChange={setStatus}
                options={[{ id: 'ALL', label: 'All status' }, { id: 'ACTIVE', label: 'Active' }, { id: 'INACTIVE', label: 'Inactive' }]} />
            </div>
          )}>
          <Table2
            darkHeader
            columns={[
              { key: 'sid', label: 'SID' }, { key: 'ser', label: 'Serial#' }, { key: 'user', label: 'Username' },
              { key: 'mach', label: 'Machine' }, { key: 'prog', label: 'Program' }, { key: 'st', label: 'Status' },
              { key: 'sql', label: 'SQL ID' }, { key: 'idle', label: 'In state for' }, { key: 'ev', label: 'Wait' },
            ]}
            rows={rows.map((r) => ({
              key: `${r.sid}-${r.serial}`,
              onClick: () => navigate(drillPath(id, { service, inst, sid: r.sid, serial: r.serial })),
              cells: {
                sid: <span className="font-mono font-semibold text-accent-text">{r.sid}</span>,
                ser: <span className="font-mono">{r.serial}</span>,
                user: r.username || 'N/A',
                mach: r.machine || 'N/A',
                prog: <span className="break-all">{r.program || 'N/A'}</span>,
                st: <StatusBadge value={r.status} />,
                sql: r.sql_id ? <span className="font-mono">{r.sql_id}</span> : '—',
                idle: fmtSecs(r.last_call_et),
                ev: r.wait_class === 'Idle' ? <span className="text-muted">idle</span> : (r.event || '—'),
              },
            }))}
            empty={<EmptyState icon="users" title={q.data.sessions.length ? 'No session matches the filter' : 'No sessions of this service on this instance'} />}
          />
        </TablePanel>
      )}
    </DrillShell>
  );
}

/* ═══ Level 6 — one session ═══════════════════════════════════════════ */

function SqlBlock({ title, sqlId, text, to }) {
  const navigate = useDrillNav();
  return (
    <Panel title={title} icon="code-xml" actions={sqlId && (
      <button type="button" className="text-[12px] font-semibold text-accent-text hover:underline" onClick={() => navigate(to)}>
        {sqlId} — SQL details →
      </button>
    )}>
      {!sqlId ? <p className="text-[12px] text-muted">None.</p>
        : text == null ? <p className="text-[12px] text-muted">Text unavailable — the cursor has aged out of GV$SQL or the monitoring user cannot read it.</p> : (
          <div className="relative">
            <CopyButton text={text} className="absolute right-2 top-2" />
            <pre className="max-h-72 overflow-auto whitespace-pre rounded-xl border border-border bg-sunken p-4 pr-24 font-mono text-[12.5px] leading-relaxed">{text}</pre>
          </div>
        )}
    </Panel>
  );
}

const STAT_LABELS = [
  ['CPU used by this session', 'CPU time', (v) => `${fmtNum(v / 100, 2)} s`],
  ['session logical reads', 'Logical reads', fmtNum],
  ['physical reads', 'Physical reads', fmtNum],
  ['execute count', 'Executions', fmtNum],
  ['parse count (total)', 'Parses', fmtNum],
  ['user commits', 'Commits', fmtNum],
  ['user rollbacks', 'Rollbacks', fmtNum],
  ['redo size', 'Redo generated', (v) => fmtMB(v / 1048576)],
  ['bytes sent via SQL*Net to client', 'Sent to client', (v) => fmtMB(v / 1048576)],
  ['sorts (disk)', 'Disk sorts', fmtNum],
];

export function OracleServiceSessionPage() {
  const { id, service, inst, sid, serial } = useDrillParams();
  const instQ = useServiceInstance(id, service, inst);
  const q = useQuery({
    queryKey: ['oracleSessionDetail', id, inst, sid, serial],
    queryFn: () => api(id, 'oracle-session-detail', { inst_id: inst, sid, serial }),
    ...LIVE, refetchInterval: 20000,
  });
  const d = q.data;
  const s = d?.session;

  return (
    <DrillShell ctx={{ service, inst, sid, serial }} names={{ instance: instQ.data?.instance?.instance_name }} query={q}
      loadingLabel="Fetching session details…" loadingDetail="Session state, statistics and SQL."
      icon="user" title={`Session ${sid}`} subtitle={`Serial# ${serial} · ${service}`}
      badge={s ? <StatusBadge value={s.status} size="sm" /> : null}>
      {d?.status === 'success' && (
        <div className="space-y-gutter">
          <div className="grid gap-gutter-sm lg:grid-cols-2">
            <Panel title="Session information" icon="info">
              <Facts rows={[
                ['SID / Serial#', `${s.sid} / ${s.serial}`], ['Username', s.username || 'N/A'], ['OS user', s.osuser || 'N/A'],
                ['Machine', s.machine || 'N/A'], ['Program', s.program || 'N/A'], ['Module', s.module || 'N/A'],
                ['Action', s.action || 'N/A'], ['Service', s.service_name || 'N/A'],
                ['Status', <StatusBadge key="s" value={s.status} />], ['Server', s.server || 'N/A'],
                ['Logon time', fmtTime(s.logon_time)], ['In current state for', fmtSecs(s.last_call_et)],
                ['Client info', s.client_info || 'N/A'],
                s.blocking_session != null ? ['Blocked by', `SID ${s.blocking_session} on instance ${s.blocking_instance ?? 'N/A'}`] : null,
              ]} />
            </Panel>
            <div className="space-y-gutter-sm">
              <Panel title="Wait" icon="clock" subtitle="GV$SESSION — now">
                <Facts rows={[
                  ['Event', s.event || 'N/A'], ['Wait class', s.wait_class || 'N/A'], ['State', s.state || 'N/A'],
                  ['Seconds in wait', na(s.seconds_in_wait, fmtNum)],
                  ['SQL exec start', fmtTime(s.sql_exec_start)],
                ]} />
              </Panel>
              <Panel title="Session metrics" icon="chart-bar" subtitle="GV$SESSTAT — cumulative since logon">
                {d.stats == null ? <p className="text-[12px] text-muted">Session statistics could not be read.</p> : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {STAT_LABELS.map(([k, label, f]) => (
                      <div key={k} className="rounded-control bg-sunken px-3 py-2">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-subtle">{label}</p>
                        <p className="text-[14px] font-bold text-fg">{na(d.stats[k], f)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </div>
          </div>
          <SqlBlock title="Current SQL" sqlId={d.current_sql?.sql_id} text={d.current_sql?.text}
            to={drillPath(id, { service, inst, sid, serial, sqlId: d.current_sql?.sql_id })} />
          <SqlBlock title="Previous SQL" sqlId={d.previous_sql?.sql_id} text={d.previous_sql?.text}
            to={drillPath(id, { service, inst, sid, serial, sqlId: d.previous_sql?.sql_id })} />
        </div>
      )}
    </DrillShell>
  );
}

/* ═══ Level 7 — one SQL statement ═════════════════════════════════════ */

export function OracleServiceSqlPage() {
  const { id, service, inst, sid, serial, sqlId } = useDrillParams();
  const routerNavigate = useNavigate();
  const instQ = useServiceInstance(id, service, inst);
  const q = useQuery({
    queryKey: ['oracleSqlDetail', id, sqlId, inst],
    queryFn: () => api(id, 'oracle-sql-detail', { sql_id: sqlId, inst_id: inst }),
    ...LIVE,
  });
  const d = q.data;
  const s = d?.summary;

  return (
    <DrillShell ctx={{ service, inst, sid, serial, sqlId }} names={{ instance: instQ.data?.instance?.instance_name }} query={q}
      loadingLabel="Reading SQL statistics…" loadingDetail="GV$SQL child cursors and text."
      icon="code-xml" title={`SQL ${sqlId}`} subtitle={`GV$SQL on ${instQ.data?.instance?.instance_name || `instance ${inst}`} — cumulative since load`}>
      {d?.status === 'success' && (
        <div className="space-y-gutter">
          <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-3 xl:grid-cols-6">
            <MetricTile label="Executions" icon="play" value={fmtNum(s.executions)} />
            <MetricTile label="Elapsed / exec" icon="clock" value={na(s.elapsed_ms_per_exec, (v) => `${fmtNum(v, 2)} ms`)} />
            <MetricTile label="Total elapsed" icon="clock" value={`${fmtNum(s.elapsed_s, 2)} s`} />
            <MetricTile label="Total CPU" icon="cpu" value={`${fmtNum(s.cpu_s, 2)} s`} />
            <MetricTile label="Gets / exec" icon="layers" value={na(s.buffer_gets_per_exec, (v) => fmtNum(v, 1))} />
            <MetricTile label="Disk reads" icon="database" value={fmtNum(s.disk_reads)} />
          </div>
          <Panel title="SQL text" icon="code-xml"
            actions={<Badge tone="neutral" size="xs">{s.plan_hash_values.length} plan{s.plan_hash_values.length === 1 ? '' : 's'}</Badge>}>
            {d.text == null
              ? <Notice tone="info" title="SQL text unavailable.">The monitoring user cannot read SQL_FULLTEXT for this cursor, or it has aged out.</Notice>
              : (
                <div className="relative">
                  <CopyButton text={d.text} className="absolute right-2 top-2" />
                  <pre className="max-h-80 overflow-auto whitespace-pre rounded-xl border border-border bg-sunken p-4 pr-24 font-mono text-[12.5px] leading-relaxed">{d.text}</pre>
                </div>
              )}
            <button type="button" className="mt-2 text-[12px] font-semibold text-accent-text hover:underline"
              onClick={() => routerNavigate(`/oracle-dashboard/${id}/slow-queries/plan`, {
                state: { row: { query_id: sqlId, query_text: d.text || '' }, backTo: drillPath(id, { service, inst, sid, serial, sqlId }) },
              })}>
              Open execution plan →
            </button>
          </Panel>
          <TablePanel title="Child cursors" icon="branch" subtitle="One row per child cursor — plan changes show as different plan hash values">
            <Table2 columns={[
              { key: 'c', label: 'Child' }, { key: 'p', label: 'Plan hash' }, { key: 'sch', label: 'Schema' },
              { key: 'x', label: 'Executions' }, { key: 'e', label: 'Elapsed' }, { key: 'b', label: 'Buffer gets' },
              { key: 'r', label: 'Rows' }, { key: 'l', label: 'Last active' },
            ]}
            rows={d.children.map((c) => ({ key: `${c.inst_id}-${c.child_number}`, cells: {
              c: c.child_number, p: <span className="font-mono">{c.plan_hash_value}</span>, sch: c.parsing_schema || 'N/A',
              x: fmtNum(c.executions), e: `${fmtNum(c.elapsed_s, 2)} s`, b: fmtNum(c.buffer_gets), r: fmtNum(c.rows_processed),
              l: fmtTime(c.last_active_time),
            } }))} />
          </TablePanel>
        </div>
      )}
    </DrillShell>
  );
}
