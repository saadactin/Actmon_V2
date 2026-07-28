import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Globe, Plug, Radio, Network, ArrowLeft, RefreshCw, Trash2, Plus,
  CheckCircle2, XCircle, HelpCircle, Zap, Clock, Loader2,
} from 'lucide-react';
import {
  listExternalChecks, getExternalCheckResults, deleteExternalCheck, testExternalCheck,
} from '../../api/digitalExperience';
import TrendChart from '../../components/gauges/TrendChart';

const TYPE_META = {
  website:  { label: 'Website Availability', icon: Globe,   color: 'text-indigo-600', bg: 'bg-indigo-100' },
  ping:     { label: 'Ping',                 icon: Radio,   color: 'text-blue-600',   bg: 'bg-blue-100' },
  dns:      { label: 'DNS',                  icon: Network, color: 'text-blue-600',   bg: 'bg-blue-100' },
  tcp_port: { label: 'TCP Port',             icon: Plug,    color: 'text-amber-600',  bg: 'bg-amber-100' },
  udp_port: { label: 'UDP Port',             icon: Plug,    color: 'text-teal-600',   bg: 'bg-teal-100' },
};

function StatusBadge({ status }) {
  if (status === 'up') return <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1"><CheckCircle2 size={13} /> Up</span>;
  if (status === 'down') return <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-full px-2.5 py-1"><XCircle size={13} /> Down</span>;
  return <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-slate-500 bg-slate-100 border border-slate-200 rounded-full px-2.5 py-1"><HelpCircle size={13} /> Unknown</span>;
}

function CheckDetail({ check, onBack }) {
  const [hours, setHours] = useState(24);
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['externalCheckResults', check.id, hours],
    queryFn: () => getExternalCheckResults(check.id, hours),
    refetchInterval: 30000,
  });
  const meta = TYPE_META[check.check_type] || TYPE_META.website;
  const Icon = meta.icon;
  const chartData = (data?.results || []).map((r, i) => ({
    t: i, ms: r.response_time_ms ?? 0, up: r.status === 'up' ? 1 : 0,
  }));

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-[13px] font-bold text-slate-500 hover:text-slate-800">
        <ArrowLeft size={15} /> Back to Digital Experience
      </button>
      <div className="bg-white rounded-2xl border border-slate-200 p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${meta.bg}`}><Icon size={22} className={meta.color} /></div>
            <div>
              <h2 className="text-lg font-black text-slate-800">{check.name}</h2>
              <p className="text-[13px] text-slate-500">{meta.label} · <span className="font-mono">{check.target}{check.port ? `:${check.port}` : ''}</span></p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={check.last_status} />
            <button onClick={() => refetch()} className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              <RefreshCw size={16} className={isFetching ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5">
          <div className="bg-slate-50 rounded-xl border border-slate-100 p-3.5">
            <p className="text-[10px] font-bold text-slate-400 uppercase">Uptime ({hours}h)</p>
            <p className="text-xl font-black text-slate-800 mt-1">{data?.uptime_pct != null ? `${data.uptime_pct}%` : '—'}</p>
          </div>
          <div className="bg-slate-50 rounded-xl border border-slate-100 p-3.5">
            <p className="text-[10px] font-bold text-slate-400 uppercase">Last response</p>
            <p className="text-xl font-black text-slate-800 mt-1">{check.last_response_time_ms != null ? `${Math.round(check.last_response_time_ms)} ms` : '—'}</p>
          </div>
          <div className="bg-slate-50 rounded-xl border border-slate-100 p-3.5">
            <p className="text-[10px] font-bold text-slate-400 uppercase">Interval</p>
            <p className="text-xl font-black text-slate-800 mt-1">{Math.round(check.interval_seconds / 60) || 1}m</p>
          </div>
          <div className="bg-slate-50 rounded-xl border border-slate-100 p-3.5">
            <p className="text-[10px] font-bold text-slate-400 uppercase">Last checked</p>
            <p className="text-[13px] font-bold text-slate-700 mt-2">{check.last_checked_at ? new Date(check.last_checked_at).toLocaleString() : 'Not yet'}</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-black text-slate-700">Response time</p>
          <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
            {[6, 24, 168].map((h) => (
              <button key={h} onClick={() => setHours(h)}
                className={`px-3 py-1 rounded-md text-[11px] font-bold ${hours === h ? 'bg-white shadow text-slate-800' : 'text-slate-500'}`}>
                {h < 24 ? `${h}h` : `${h / 24}d`}
              </button>
            ))}
          </div>
        </div>
        {isLoading ? (
          <div className="h-52 flex items-center justify-center text-slate-400"><Loader2 size={20} className="animate-spin" /></div>
        ) : chartData.length === 0 ? (
          <p className="text-center text-slate-400 text-sm py-16">No results yet — the scheduler checks every {Math.round(check.interval_seconds / 60) || 1} minute(s).</p>
        ) : (
          <TrendChart data={chartData} series={[{ key: 'ms', label: 'Response time', color: '#3f6fd6' }]}
            xKey="t" height={220} yDomain={['auto', 'auto']} yLabel="ms" showLegend={false} />
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <p className="text-sm font-black text-slate-700 px-6 pt-5">Recent results</p>
        <table className="w-full text-sm mt-3">
          <thead className="bg-slate-50 text-[11px] uppercase text-slate-400 font-black">
            <tr>
              <th className="px-6 py-2.5 text-left">Time</th><th className="px-4 py-2.5 text-left">Status</th>
              <th className="px-4 py-2.5 text-right">Response</th><th className="px-4 py-2.5 text-left">Detail</th>
            </tr>
          </thead>
          <tbody>
            {(data?.results || []).slice().reverse().slice(0, 20).map((r, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="px-6 py-2.5 text-slate-600">{r.checked_at ? new Date(r.checked_at).toLocaleString() : '—'}</td>
                <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
                <td className="px-4 py-2.5 text-right font-bold text-slate-700">{r.response_time_ms != null ? `${Math.round(r.response_time_ms)} ms` : '—'}</td>
                <td className="px-4 py-2.5 text-slate-500">{r.error_message || (r.status_code ? `HTTP ${r.status_code}` : '—')}</td>
              </tr>
            ))}
            {(!data?.results || data.results.length === 0) && (
              <tr><td colSpan={4} className="px-6 py-8 text-center text-slate-400">No results yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function DigitalExperiencePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(null);

  const { data: checks, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['externalChecks'],
    queryFn: listExternalChecks,
    refetchInterval: 30000,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteExternalCheck,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['externalChecks'] }),
  });
  const testMutation = useMutation({
    mutationFn: testExternalCheck,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['externalChecks'] }),
  });

  const selectedCheck = selected ? (checks || []).find((c) => c.id === selected) : null;
  if (selectedCheck) {
    return <div className="p-6 md:p-8">{<CheckDetail check={selectedCheck} onBack={() => setSelected(null)} />}</div>;
  }

  return (
    <div className="p-6 md:p-8 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-black text-slate-800">Digital Experience</h1>
          <p className="text-[13px] text-slate-500 mt-0.5">Website, ping, DNS and port monitors — status and response-time history.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <RefreshCw size={16} className={isFetching ? 'animate-spin' : ''} />
          </button>
          <button onClick={() => navigate('/agents/setup?tab=Digital%20Experience')}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-bold">
            <Plus size={15} /> Add Monitor
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="py-24 flex items-center justify-center text-slate-400"><Loader2 size={22} className="animate-spin" /></div>
      ) : !checks || checks.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 py-16 text-center">
          <Globe size={32} className="text-slate-300 mx-auto mb-3" />
          <p className="font-bold text-slate-600">No monitors yet</p>
          <p className="text-slate-400 text-sm mt-1">Add a website, ping, DNS, or port check to start tracking availability.</p>
          <button onClick={() => navigate('/agents/setup?tab=Digital%20Experience')}
            className="mt-4 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-bold">
            <Plus size={15} /> Add Monitor
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {checks.map((c) => {
            const meta = TYPE_META[c.check_type] || TYPE_META.website;
            const Icon = meta.icon;
            return (
              <div key={c.id} onClick={() => setSelected(c.id)}
                className="text-left bg-white rounded-2xl border border-slate-200 p-5 cursor-pointer hover:border-blue-300 hover:shadow-lg transition-all">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${meta.bg}`}><Icon size={17} className={meta.color} /></div>
                    <div className="min-w-0">
                      <p className="font-bold text-slate-800 truncate">{c.name}</p>
                      <p className="text-[11px] text-slate-400 truncate font-mono">{c.target}{c.port ? `:${c.port}` : ''}</p>
                    </div>
                  </div>
                  <StatusBadge status={c.last_status} />
                </div>
                <div className="flex items-center justify-between mt-4 pt-3 border-t border-slate-100">
                  <span className="text-[11px] text-slate-400 flex items-center gap-1"><Clock size={12} /> every {Math.round(c.interval_seconds / 60) || 1}m</span>
                  <span className="text-[12px] font-bold text-slate-600">{c.last_response_time_ms != null ? `${Math.round(c.last_response_time_ms)} ms` : '—'}</span>
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => testMutation.mutate(c.id)} title="Test now"
                      className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-blue-600">
                      <Zap size={13} />
                    </button>
                    <button onClick={() => { if (window.confirm(`Delete "${c.name}"?`)) deleteMutation.mutate(c.id); }} title="Delete"
                      className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
