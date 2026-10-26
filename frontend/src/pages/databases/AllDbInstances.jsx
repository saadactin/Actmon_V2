import { useMemo, useState } from 'react';
import { ChevronLeft, Search, X, Server, CheckCircle2, AlertTriangle, XCircle, HelpCircle, ExternalLink, Activity } from 'lucide-react';
import PageHeader from '@/components/layout/PageHeader';
import HeaderRefreshButton from '@/components/layout/HeaderRefreshButton';
import { buildDbInstances, tallyInstances, DB_ENGINES } from '@/utils/dbInstances';

/**
 * Database Servers → every technology (/databases?status=all|online|warning|offline|unknown).
 *
 * One row per host + database technology — the same rows the Monitoring Overview's
 * Database Server card counts (utils/dbInstances), so the count clicked there is the
 * number of rows here. A row's status is THAT engine's status (live port check, else
 * the stored instance status), not the host's: an Oracle that is down on a host whose
 * OS is up is an offline database, and is listed as one.
 */
const LEVELS = {
  online: { label: 'Online', sub: 'running now', icon: CheckCircle2, tile: 'bg-emerald-50 text-emerald-500', value: 'text-emerald-600', ring: 'ring-emerald-300', pill: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  warning: { label: 'Warning', sub: 'degraded', icon: AlertTriangle, tile: 'bg-amber-50 text-amber-500', value: 'text-amber-600', ring: 'ring-amber-300', pill: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' },
  offline: { label: 'Offline', sub: 'stopped / unreachable', icon: XCircle, tile: 'bg-red-50 text-red-500', value: 'text-red-600', ring: 'ring-red-300', pill: 'bg-red-50 text-red-700', dot: 'bg-red-500' },
  unknown: { label: 'Unknown', sub: 'no reading yet', icon: HelpCircle, tile: 'bg-slate-100 text-slate-500', value: 'text-slate-600', ring: 'ring-slate-300', pill: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
};
const ENGINE_STYLE = {
  mysql: { emoji: '🐬', cls: 'bg-orange-50 text-orange-700 border-orange-200' },
  postgresql: { emoji: '🐘', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  oracle: { emoji: '🔴', cls: 'bg-red-50 text-red-700 border-red-200' },
  mssql: { emoji: '🖥️', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  mongodb: { emoji: '🍃', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  clickhouse: { emoji: '⚡', cls: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
};
const OS_LEVEL = (s) => {
  const v = String(s || '').toLowerCase();
  if (['connected', 'online', 'up', 'running', 'healthy'].includes(v)) return 'online';
  if (['warning', 'degraded', 'slow'].includes(v)) return 'warning';
  return 'offline';
};
const ENVS = ['All', 'Production', 'UAT', 'Development', 'Testing'];

export default function AllDbInstances({
  hosts, liveRows, allowedEngines, status, onStatus, onOpen, onHost, onBack, countdown, onRefresh, refreshing,
}) {
  const [search, setSearch] = useState('');
  const [env, setEnv] = useState('All');
  const [engine, setEngine] = useState('all');

  const rows = useMemo(() => buildDbInstances(hosts, liveRows, allowedEngines), [hosts, liveRows, allowedEngines]);
  const counts = useMemo(() => tallyInstances(rows), [rows]);
  const engines = DB_ENGINES.filter((e) => rows.some((r) => r.engine === e.id));

  const shown = rows.filter((r) => {
    if (status && r.level !== status) return false;
    if (env !== 'All' && r.environment !== env) return false;
    if (engine !== 'all' && r.engine !== engine) return false;
    if (search) {
      const q = search.toLowerCase();
      if (![r.serverName, r.hostname, r.ip, r.engineLabel].some((v) => String(v || '').toLowerCase().includes(q))) return false;
    }
    return true;
  });

  const title = status ? `Database Servers — ${LEVELS[status].label}` : 'Database Servers — All';

  return (
    <>
      <PageHeader
        title={title}
        icon="database"
        description={`${counts.total} database instance${counts.total !== 1 ? 's' : ''} · one row per server and database technology`}
        actions={(
          <div className="flex items-center gap-2">
            <button onClick={onBack} title="Back to technologies"
              className="flex h-control shrink-0 items-center gap-1.5 rounded-control border border-border px-2.5 text-[12px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg">
              <ChevronLeft size={14} /> Technologies
            </button>
            <HeaderRefreshButton seconds={countdown} onClick={onRefresh} spinning={refreshing} />
          </div>
        )}
      />

      <div className="mx-auto w-full">
        {/* KPI cards — click to filter */}
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Kpi active={!status} onClick={() => onStatus(null)} icon={Server} tile="bg-slate-100 text-slate-500" value={counts.total} valueCls="text-slate-800" label="Total" sub="instances" ring="ring-slate-300" />
          {['online', 'warning', 'offline', 'unknown'].map((k) => {
            const L = LEVELS[k];
            return <Kpi key={k} active={status === k} onClick={() => onStatus(status === k ? null : k)} icon={L.icon} tile={L.tile} value={counts[k]} valueCls={L.value} label={L.label} sub={L.sub} ring={L.ring} />;
          })}
        </div>

        {status && (
          <div className="-mt-2 mb-4 flex items-center gap-2">
            <span className="text-xs text-slate-500">Filtered by <b className="text-slate-700">{LEVELS[status].label}</b> · {shown.length} of {counts.total}</span>
            <button onClick={() => onStatus(null)} className="text-xs font-bold text-blue-600 hover:text-blue-700">Clear</button>
          </div>
        )}

        {/* environment · technology · search */}
        <div className="mb-6 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-1">
            {ENVS.map((e) => (
              <button key={e} onClick={() => setEnv(e)}
                className={`h-7 rounded-lg px-3.5 text-[11px] font-bold transition-all ${env === e ? 'bg-slate-900 text-white shadow' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
                {e}
              </button>
            ))}
          </div>
          <div className="ml-2 flex flex-wrap items-center gap-1 border-l border-slate-200 pl-2">
            <button onClick={() => setEngine('all')}
              className={`h-7 rounded-lg px-3 text-[11px] font-bold ${engine === 'all' ? 'bg-slate-900 text-white shadow' : 'border border-slate-200 text-slate-600 hover:bg-slate-100'}`}>
              All technologies
            </button>
            {engines.map((e) => (
              <button key={e.id} onClick={() => setEngine(engine === e.id ? 'all' : e.id)}
                className={`flex h-7 items-center gap-1.5 rounded-lg border px-3 text-[11px] font-bold ${engine === e.id ? 'border-slate-900 bg-slate-900 text-white shadow' : ENGINE_STYLE[e.id]?.cls}`}>
                <span>{ENGINE_STYLE[e.id]?.emoji}</span>{e.label}
              </button>
            ))}
          </div>
          <div className="relative ml-auto">
            <Search size={12} className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search server, IP or technology…"
              className="h-8 w-60 rounded-xl border border-slate-200 pr-9 pl-8 text-[12px] outline-none transition-all focus:border-indigo-400 focus:ring-2 focus:ring-indigo-50" />
            {search && (
              <button onClick={() => setSearch('')} className="absolute top-1/2 right-2.5 -translate-y-1/2 text-slate-300 hover:text-slate-500"><X size={11} /></button>
            )}
          </div>
        </div>

        {/* list */}
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-left text-[12px] font-bold text-slate-600">
                  <th className="w-12 px-4 py-3">#</th>
                  <th className="px-4 py-3">Database Technology</th>
                  <th className="px-4 py-3">Server</th>
                  <th className="px-4 py-3">Host / OS</th>
                  <th className="px-4 py-3">Port</th>
                  <th className="px-4 py-3">Environment</th>
                  <th className="px-4 py-3">OS Status</th>
                  <th className="px-4 py-3">DB Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr><td colSpan={9} className="px-4 py-14 text-center text-slate-500">
                    {counts.total === 0 ? 'No database instances are registered yet.' : `No ${status ? LEVELS[status].label.toLowerCase() + ' ' : ''}database instances match these filters.`}
                  </td></tr>
                ) : shown.map((r, i) => {
                  const L = LEVELS[r.level];
                  const os = LEVELS[OS_LEVEL(r.osStatus)];
                  const E = ENGINE_STYLE[r.engine] || {};
                  return (
                    <tr key={r.key} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70">
                      <td className="px-4 py-3 text-slate-400 tabular-nums">{i + 1}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-bold ${E.cls || 'border-slate-200 bg-slate-50 text-slate-700'}`}>
                          <span>{E.emoji}</span>{r.engineLabel}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => onHost(r)} className="text-left font-bold text-slate-900 hover:text-blue-600 hover:underline">{r.serverName}</button>
                        {r.hostname && r.hostname !== r.serverName && <p className="text-[11px] text-slate-400">{r.hostname}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-[12.5px] text-slate-700">{r.ip || '—'}</span>
                        {r.os && <span className="ml-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">{r.os}</span>}
                      </td>
                      <td className="px-4 py-3 font-mono text-[12.5px] text-slate-600">{r.port ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{r.environment || '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold ${os.pill}`}><span className={`h-1.5 w-1.5 rounded-full ${os.dot}`} />{os.label}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold ${L.pill}`} title={`Reported status: ${r.status}`}><span className={`h-1.5 w-1.5 rounded-full ${L.dot}`} />{r.status}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1.5">
                          <button onClick={() => onOpen(r)} title={`Open the ${r.engineLabel} dashboard`}
                            className="flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-[12px] font-bold text-white hover:bg-slate-700">
                            <ExternalLink size={13} /> Open
                          </button>
                          <button onClick={() => onHost(r)} title="Host details"
                            className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-100">
                            <Activity size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function Kpi({ active, onClick, icon: IconC, tile, value, valueCls, label, sub, ring }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={`flex items-center gap-3 rounded-2xl border bg-white px-4 py-3.5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${active ? `border-transparent ring-2 ${ring}` : 'border-slate-200'}`}>
      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${tile}`}><IconC size={18} /></div>
      <div className="min-w-0">
        <p className="text-[10px] font-bold tracking-wide text-slate-400 uppercase">{label}</p>
        <p className={`text-2xl leading-none font-black ${valueCls}`}>{value ?? 0}</p>
        <p className="mt-0.5 truncate text-[10px] text-slate-400">{sub}</p>
      </div>
    </button>
  );
}
