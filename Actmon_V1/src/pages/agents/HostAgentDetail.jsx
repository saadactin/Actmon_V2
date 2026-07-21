import React from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Server, RefreshCw, Radio, Activity, Database, ArrowUpDown, Gauge, Wifi,
  Clock, Send, CheckCircle2, AlertTriangle, Link2, Timer, Package,
} from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import client from '../../api/client';
import PageHeader from '../../components/layout/PageHeader';

const fetchOverview = (name) =>
  client.get(`/agents/${encodeURIComponent(name)}/host-overview`).then((r) => r.data);

const ago = (secs) => {
  if (secs === null || secs === undefined) return '—';
  if (secs < 90) return `${Math.round(secs)}s`;
  return `${Math.round(secs / 60)}m`;
};

const tipStyle = { backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 };

function Kpi({ icon: Icon, label, value, sub, tone = 'slate' }) {
  const tones = { green: 'text-emerald-600', red: 'text-red-600', amber: 'text-amber-600', slate: 'text-slate-800', blue: 'text-blue-600' };
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{label}</p>
        <Icon size={15} className="text-slate-300" />
      </div>
      <p className={`text-2xl font-black mt-1 ${tones[tone]}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function LiveChart({ title, data, dataKey, color, unit = '%', domain }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-2">{title}</p>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id={`g-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
          <XAxis dataKey="time" tick={{ fontSize: 10, fill: '#94a3b8' }} interval="preserveStartEnd" minTickGap={40} />
          <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} domain={domain || [0, 'auto']} unit={unit} width={52} />
          <Tooltip contentStyle={tipStyle} formatter={(v) => [`${Number(v).toFixed(1)}${unit}`, title]} />
          <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2}
            fill={`url(#g-${dataKey})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Dedicated AGENT-MONITORING page ─────────────────────────────────────────
// Focuses entirely on the AGENT: telemetry flow, delivery, latency, throughput,
// endpoints, health. (Host OS details live under Infrastructure.)
export default function HostAgentDetail() {
  const { id: agentName = '' } = useParams();
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['hostOverview', agentName],
    queryFn: () => fetchOverview(agentName),
    refetchInterval: 15000,          // live — matches the agent cadence
  });

  const a = data?.agent || {};
  const t = data?.telemetry || {};
  const comm = t.comm || {};
  const events = data?.events || [];
  const online = a.status === 'online';

  // Chart series from the full Redis ring (newest-first → chronological)
  const series = (t.ring || []).slice().reverse().map((s) => ({
    time: new Date((s.ts || 0) * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }),
    cpu: Number(s.host_cpu || 0),
    mem: Number(s.host_memory || 0),
    qps: Number(s.qps || 0),
    sessions: Number(s.active_sessions || 0),
  }));

  const delivery = comm.delivery_pct ?? 100;
  const deliveryTone = delivery >= 95 ? 'green' : delivery >= 80 ? 'amber' : 'red';

  return (
    <div className="min-h-full bg-brand-bg">
      <PageHeader
        icon={Server}
        title={`${agentName} — Agent Monitoring`}
        subtitle={`${a.os_type || ''} agent · ${a.ip || ''} · collection interval ${a.collection_interval_sec || 15}s`}
        crumbs={[{ label: 'Agents', to: '/agents' }, { label: agentName }]}
        backTo="/agents"
        accent="blue"
        actions={(
          <div className="flex items-center gap-2">
            <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full border ${online ? 'bg-emerald-500/20 text-emerald-200 border-emerald-400/40' : 'bg-red-500/20 text-red-200 border-red-400/40'}`}>
              ● {a.status || '…'}
            </span>
            <button onClick={() => refetch()}
              className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold text-white">
              <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        )}
      />

      {isLoading ? (
        <div className="py-24 text-center text-slate-400">Loading agent telemetry…</div>
      ) : (
        <div className="py-5 space-y-4">

          {/* ── Agent health & communication KPIs ── */}
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
            <Kpi icon={Radio} label="Heartbeat" value={ago(comm.last_sample_age_s)} sub="since last sample" tone={online ? 'green' : 'red'} />
            <Kpi icon={CheckCircle2} label="Packet Delivery" value={`${delivery}%`}
              sub={`${t.live_samples_1h ?? 0}/${comm.expected_samples ?? '—'} received (1h)`} tone={deliveryTone} />
            <Kpi icon={Timer} label="Avg Interval" value={comm.avg_interval_s ? `${comm.avg_interval_s}s` : '—'}
              sub={`target ${a.collection_interval_sec}s`} />
            <Kpi icon={Gauge} label="Jitter" value={comm.jitter_s !== null && comm.jitter_s !== undefined ? `${comm.jitter_s}s` : '—'}
              sub="interval variance" tone={(comm.jitter_s || 0) > (a.collection_interval_sec || 15) ? 'amber' : 'slate'} />
            <Kpi icon={Package} label="Incoming Rate" value={comm.incoming_rate_per_min ? `${comm.incoming_rate_per_min}/min` : '—'}
              sub="telemetry packets" tone="blue" />
            <Kpi icon={Send} label="Throughput" value={comm.throughput_bytes_per_min ? `${(comm.throughput_bytes_per_min / 1024).toFixed(1)} KB/m` : '—'}
              sub={`~${comm.sample_size_bytes || 0} B/packet`} />
            <Kpi icon={Database} label="Stored (24h)" value={t.clickhouse?.rows_24h ?? '—'}
              sub={t.clickhouse ? 'ClickHouse rows' : 'CH offline'} />
            <Kpi icon={ArrowUpDown} label="Transfer Queue" value={t.pending_ch_queue ?? 0}
              sub="pending → ClickHouse" tone={(t.pending_ch_queue || 0) > 1000 ? 'amber' : 'green'} />
          </div>

          {/* ── LARGE live telemetry charts (full Redis hour, 15s resolution) ── */}
          <div className="grid lg:grid-cols-2 gap-4">
            <LiveChart title="Agent Host CPU — live" data={series} dataKey="cpu" color="#2563eb" domain={[0, 100]} />
            <LiveChart title="Agent Host Memory — live" data={series} dataKey="mem" color="#7c3aed" domain={[0, 100]} />
            <LiveChart title="Telemetry QPS — live" data={series} dataKey="qps" color="#059669" unit="" />
            <LiveChart title="Active Sessions — live" data={series} dataKey="sessions" color="#d97706" unit="" />
          </div>

          {/* ── Communication / endpoints ── */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-3 flex items-center gap-1.5">
                <Link2 size={13} /> Telemetry Endpoints (agent → server)
              </p>
              <div className="space-y-2">
                {(comm.endpoints || []).map((e, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
                    <code className="font-mono text-slate-700">{e}</code>
                  </div>
                ))}
              </div>
              <div className="mt-4 pt-3 border-t border-slate-100 grid grid-cols-3 gap-2 text-center">
                <div><p className="text-[10px] font-bold text-slate-400 uppercase">Redis Hot Tier</p>
                  <p className={`text-sm font-black ${t.transport?.redis ? 'text-emerald-600' : 'text-red-600'}`}>{t.transport?.redis ? 'CONNECTED' : 'DOWN'}</p></div>
                <div><p className="text-[10px] font-bold text-slate-400 uppercase">API Reachable</p>
                  <p className="text-sm font-black text-emerald-600">YES</p></div>
                <div><p className="text-[10px] font-bold text-slate-400 uppercase">Last CH Write</p>
                  <p className="text-sm font-black text-slate-700">{t.clickhouse?.last_ts ? t.clickhouse.last_ts.slice(11, 19) : '—'}</p></div>
              </div>
            </div>

            {/* ── Agent events ── */}
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <Clock size={13} /> Agent Events
              </p>
              {events.length === 0 ? (
                <p className="text-xs text-slate-400 flex items-center gap-1.5">
                  <CheckCircle2 size={13} className="text-emerald-400" /> No recent events — agent healthy.
                </p>
              ) : (
                <div className="space-y-1.5 max-h-56 overflow-y-auto">
                  {events.map((e, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <AlertTriangle size={12} className={`mt-0.5 flex-shrink-0 ${e.severity === 'critical' ? 'text-red-500' : 'text-amber-400'}`} />
                      <span className="text-slate-400 font-mono whitespace-nowrap">{e.ts?.slice(0, 19)}</span>
                      <span className="text-slate-600">{e.message}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-4 text-[11px] text-slate-500">
                <span className="flex items-center gap-1"><Wifi size={12} /> registered {a.created_at ? a.created_at.slice(0, 10) : '—'}</span>
                <span className="flex items-center gap-1"><Activity size={12} /> env: {a.environment || '—'}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
