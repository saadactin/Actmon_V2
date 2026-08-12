import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Check } from 'lucide-react';
import { listRules } from '@/api/alerts';

// Suggested alert templates — each maps onto the existing data-driven AlertRule
// engine (metric + operator + threshold). Selected templates are created as real
// rules when the wizard finishes, scoped to the new agent.
export const ALERT_TEMPLATES = [
  { id: 'agent-stopped', name: 'Agent stopped sending data', severity: 'critical',
    desc: 'This alert is triggered when no heartbeat data has been received from the agent during last 5 minutes.',
    rule: { metric: 'status', operator: 'eq', threshold: 0, duration_seconds: 300 } },
  { id: 'agent-stop-event', name: 'Agent stopped by the user or system', severity: 'warning',
    desc: 'This alert is triggered when an ActMon agent stop event occurs.',
    rule: { metric: 'status', operator: 'eq', threshold: 0, duration_seconds: 60 } },
  { id: 'cpu-90', name: 'Host CPU utilization over 90%', severity: 'critical',
    desc: 'This alert is triggered when the CPU utilization on a host exceeds 90% for more than 5 minutes.',
    rule: { metric: 'cpu', operator: 'gt', threshold: 90, duration_seconds: 300 } },
  { id: 'disk-80', name: 'Host disk utilization over 80%', severity: 'warning',
    desc: 'This alert is triggered when the disk utilization on a host exceeds 80% for more than 5 minutes.',
    rule: { metric: 'disk', operator: 'gt', threshold: 80, duration_seconds: 300 } },
  { id: 'mem-90', name: 'Host memory utilization over 90%', severity: 'critical',
    desc: 'This alert is triggered when the host memory utilization exceeds 90% for more than 5 minutes.',
    rule: { metric: 'memory', operator: 'gt', threshold: 90, duration_seconds: 300 } },
  { id: 'proc-cpu-90', name: 'Process CPU utilization over 90%', severity: 'warning',
    desc: 'This alert is triggered when a process on the host has been utilizing more than 90% of the CPU for more than 11 minutes.',
    rule: { metric: 'cpu', operator: 'gt', threshold: 90, duration_seconds: 660 } },
  { id: 'host-down', name: 'Host is down', severity: 'critical',
    desc: 'This alert is triggered when no data has been received from the host during last 5 minutes.',
    rule: { metric: 'status', operator: 'eq', threshold: 0, duration_seconds: 300 } },
  { id: 'disk-95', name: 'Less than 5 GB free on host volume', severity: 'warning',
    desc: 'This alert is triggered when the free space on a volume is less than 5 GB for more than 5 minutes.',
    rule: { metric: 'disk', operator: 'gt', threshold: 95, duration_seconds: 300 } },
  // ── additional ActMon templates ──
  { id: 'cpu-75', name: 'Host CPU utilization over 75%', severity: 'warning',
    desc: 'This alert is triggered when the CPU utilization on a host exceeds 75% for more than 10 minutes — early warning before saturation.',
    rule: { metric: 'cpu', operator: 'gt', threshold: 75, duration_seconds: 600 } },
  { id: 'mem-80', name: 'Host memory utilization over 80%', severity: 'warning',
    desc: 'This alert is triggered when the host memory utilization exceeds 80% for more than 10 minutes.',
    rule: { metric: 'memory', operator: 'gt', threshold: 80, duration_seconds: 600 } },
  { id: 'conn-80', name: 'Database connections over 80% of limit', severity: 'warning',
    desc: 'This alert is triggered when the number of database connections exceeds 80% of the configured maximum for more than 5 minutes.',
    rule: { metric: 'connections', operator: 'gt', threshold: 80, duration_seconds: 300 } },
  { id: 'repl-lag-30', name: 'Replication lag over 30 seconds', severity: 'critical',
    desc: 'This alert is triggered when database replication lag exceeds 30 seconds — replicas are falling behind the primary.',
    rule: { metric: 'replication_lag', operator: 'gt', threshold: 30, duration_seconds: 60 } },
];

function CheckBox({ on, indeterminate, disabled, onClick }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className={`w-[18px] h-[18px] rounded border flex items-center justify-center transition-colors flex-shrink-0 ${
        disabled ? 'bg-slate-100 border-slate-200 cursor-not-allowed'
          : on || indeterminate ? 'bg-blue-600 border-blue-600' : 'bg-white border-slate-300 hover:border-blue-400'}`}>
      {on && <Check size={13} className="text-white" strokeWidth={3} />}
      {!on && indeterminate && <span className="w-2.5 h-[2.5px] bg-white rounded" />}
    </button>
  );
}

// Step (both flows) — pick alert templates to create for the new agent.
export default function StepAlerts({ data, setData }) {
  const [search, setSearch] = useState('');
  const selected = data.alerts || [];

  // Templates whose rule NAME already exists are shown as "Already created".
  const { data: existingRules = [] } = useQuery({ queryKey: ['alertRules'], queryFn: listRules });
  const existingNames = useMemo(() => new Set(existingRules.map((r) => (r.name || '').toLowerCase())), [existingRules]);

  const visible = ALERT_TEMPLATES.filter((t) =>
    !search.trim() || `${t.name} ${t.desc}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selectable = visible.filter((t) => !existingNames.has(t.name.toLowerCase()));
  const allOn = selectable.length > 0 && selectable.every((t) => selected.includes(t.id));
  const someOn = selectable.some((t) => selected.includes(t.id));

  const toggle = (id) => setData({ alerts: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id] });
  const toggleAll = () => setData({
    alerts: allOn
      ? selected.filter((id) => !selectable.some((t) => t.id === id))
      : [...new Set([...selected, ...selectable.map((t) => t.id)])],
  });

  return (
    <div className="max-w-5xl">
      <h3 className="text-[19px] font-black text-slate-800">Suggested Alerts</h3>
      <p className="text-[15px] text-slate-600 mt-2 leading-relaxed">
        You can create alerts from the suggested alert templates below if you haven't already created
        them in the past. Select the templates for your alerts, and click Next to proceed with the wizard.
        To view all available templates, navigate to the <a href="/alerts" className="text-blue-600 font-semibold hover:underline">Alert Templates</a> page.
      </p>

      {/* Search */}
      <div className="relative mt-5 max-w-3xl">
        <Search size={17} className="text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates"
          className="w-full h-11 pl-10 pr-3.5 rounded-lg border border-slate-300 text-[15px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-50" />
      </div>

      <h4 className="text-[16px] font-black text-slate-800 mt-6 mb-3">Alert Templates ({visible.length})</h4>

      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="w-12 px-4 py-3"><CheckBox on={allOn} indeterminate={someOn && !allOn} onClick={toggleAll} /></th>
              <th className="px-2 py-3 text-left text-[15px] font-black text-slate-800 w-[320px]">Name</th>
              <th className="px-4 py-3 text-left text-[15px] font-black text-slate-800">Description</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((t, i) => {
              const created = existingNames.has(t.name.toLowerCase());
              const on = selected.includes(t.id);
              return (
                <tr key={t.id} onClick={() => !created && toggle(t.id)}
                  className={`${i % 2 ? 'bg-white' : 'bg-slate-50/60'} ${created ? 'opacity-55' : 'cursor-pointer hover:bg-blue-50/40'}`}>
                  <td className="px-4 py-3.5 align-top"><CheckBox on={on} disabled={created} onClick={(e) => { e.stopPropagation(); toggle(t.id); }} /></td>
                  <td className="px-2 py-3.5 align-top">
                    <span className="text-[15px] text-slate-800">{t.name}</span>
                    {created && <span className="block text-[12px] font-bold text-emerald-600 mt-0.5">Already created</span>}
                  </td>
                  <td className="px-4 py-3.5 text-[15px] text-slate-600 leading-relaxed">{t.desc}</td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan={3} className="px-4 py-8 text-center text-[15px] text-slate-400">No templates match "{search}".</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
