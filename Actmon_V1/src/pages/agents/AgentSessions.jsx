import React, { useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Users, RefreshCw, Search, Loader2 } from 'lucide-react';
import { getAgentSessions } from '../../api/agents';

const fmtDur = (ms) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
// A session is "active" if it's running a query — MySQL Command=Query, PostgreSQL state=active.
// Idle / sleeping connections are just open, not doing work.
const isActive = (r) => {
  const s = `${r.state || ''} ${r.command || ''}`.toLowerCase();
  if (/sleep|idle/.test(s)) return false;
  return /active|running|query|execut/.test(s);
};

export function AgentSessions() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const activeView = params.get('filter') === 'active';   // opened from the Active Sessions card
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [onlyActive, setOnlyActive] = useState(activeView);

  const { data: rows = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['agentSessions', id],
    queryFn: () => getAgentSessions(id),
    refetchInterval: 15000,
  });

  const filtered = rows
    .filter((r) => !onlyActive || isActive(r))
    .filter((r) => {
      if (!q) return true;
      const s = q.toLowerCase();
      return [r.session_id, r.username, r.db_name, r.client_host, r.state, r.query]
        .some((v) => String(v || '').toLowerCase().includes(s));
    });

  const activeCount = rows.filter((r) => isActive(r)).length;

  return (
    <div>
      {/* Full-bleed header */}
      <div className="-mx-6 md:-mx-8 bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 md:px-8 pt-3 pb-4 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
        <button onClick={() => navigate(`/agents/${encodeURIComponent(id)}`)} className="relative flex items-center gap-2 text-xs text-slate-300/70 hover:text-white mb-2.5">
          <ArrowLeft size={13} /> <span>ActMon</span><span>›</span><span>Agents</span><span>›</span><span className="text-white font-semibold">{id}</span><span>›</span><span className="text-white font-semibold">Connections</span>
        </button>
        <div className="relative flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-orange-400/20 border border-orange-400/40 flex items-center justify-center flex-shrink-0">
              <Users className="h-[18px] w-[18px] text-orange-200" />
            </div>
            <div>
              <h1 className="text-lg font-black text-white tracking-tight leading-none">{activeView ? 'Active Sessions' : 'All Connections'}</h1>
              <p className="text-sky-200/70 text-[11px] mt-0.5">{id} · {rows.length} total · {activeCount} active</p>
            </div>
          </div>
          <button onClick={() => refetch()} className="h-9 px-4 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 text-white text-sm font-semibold flex items-center gap-1.5">
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mt-5 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search PID, user, db, query…"
            className="w-full h-9 pl-9 pr-3 rounded-lg border border-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-50" />
        </div>
        <button onClick={() => setOnlyActive((v) => !v)}
          className={`h-9 px-4 rounded-lg text-sm font-bold border ${onlyActive ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
          {onlyActive ? 'Showing active only' : 'Active only'}
        </button>
        <span className="text-sm text-slate-400">{filtered.length} shown</span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="py-16 text-center text-slate-400"><Loader2 size={20} className="animate-spin inline mr-2" />Loading connections…</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-slate-400">
            {onlyActive
              ? 'No sessions are actively running a query right now — all connections are idle.'
              : 'No connections match.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase text-slate-400 font-black">
              <tr>
                <th className="px-4 py-2.5 text-left">PID</th><th className="px-4 py-2.5 text-left">User</th>
                <th className="px-4 py-2.5 text-left">Database</th><th className="px-4 py-2.5 text-left">Client</th>
                <th className="px-4 py-2.5 text-left">State</th><th className="px-4 py-2.5 text-right">Duration</th>
                <th className="px-4 py-2.5 text-left">Query</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <React.Fragment key={`${r.session_id}-${i}`}>
                  <tr onClick={() => setExpanded(expanded === i ? null : i)}
                    className={`border-t border-slate-100 cursor-pointer ${expanded === i ? 'bg-blue-50' : 'hover:bg-slate-50'}`}>
                    <td className="px-4 py-2.5 font-mono text-slate-700">{r.session_id}</td>
                    <td className="px-4 py-2.5 font-bold text-slate-800">{r.username || '—'}</td>
                    <td className="px-4 py-2.5 text-slate-600">{r.db_name || '—'}</td>
                    <td className="px-4 py-2.5 text-slate-500 font-mono text-xs">{r.client_host || '—'}</td>
                    <td className="px-4 py-2.5"><span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${isActive(r) ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{r.state || r.command || 'idle'}</span></td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{fmtDur(r.duration_ms)}</td>
                    <td className="px-4 py-2.5 text-slate-500 font-mono text-xs max-w-[280px] truncate">{r.query || '—'}</td>
                  </tr>
                  {expanded === i && (
                    <tr className="bg-slate-50"><td colSpan={7} className="px-4 py-3">
                      <p className="text-[10px] font-black uppercase text-slate-400 mb-1">Full query · PID {r.session_id}</p>
                      <pre className="text-[12.5px] font-mono text-slate-800 whitespace-pre-wrap break-all bg-white border border-slate-200 rounded-lg p-3">{r.query || '(no active query — connection is idle)'}</pre>
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default AgentSessions;
