import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Database, Server, Activity, HardDrive, RefreshCw, Clock,
  Layers, Network, AlertTriangle, Cpu, FileText, Zap,
  CheckCircle2, XCircle, ChevronRight, Heart,
  TrendingUp, ArrowUp, ArrowDown,
  Search, ChevronDown, ChevronUp, GitMerge, Copy,
  Loader2, Archive, Clipboard, ClipboardCheck,
} from 'lucide-react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, AreaChart, Area,
} from 'recharts';
import client from '../../api/client';
import HostResources from '../postgresql/PgHostResources';

/* ─── palette ─── */
const C = {
  yellow: '#FFCC00', chRed: '#CC0000', amber: '#F59E0B',
  orange: '#F97316', green: '#22C55E', red: '#EF4444',
  blue: '#3B82F6', purple: '#8B5CF6', slate: '#64748B',
  teal: '#14B8A6', cyan: '#06B6D4',
};
const CC = [C.yellow,C.amber,C.orange,C.blue,C.teal,C.purple,C.green,C.cyan,C.chRed,C.slate];

/* ─── fetchers ─── */
const api = (path, id) => client.get(`/connections/clickhouse/${id}/${path}`).then(r => r.data);
const fetchDashboard   = id => api('ch-dashboard', id);
const fetchQueries     = id => api('ch-queries', id);
const fetchQueryLog    = id => api('ch-query-log', id);
const fetchSlowQueries = id => api('ch-slow-queries', id);
const fetchTables      = id => api('ch-tables', id);
const fetchPartitions  = id => api('ch-partitions', id);
const fetchMerges      = id => api('ch-merges', id);
const fetchReplicas    = id => api('ch-replicas', id);
const fetchClusters    = id => api('ch-clusters', id);
const fetchDatabases   = id => api('ch-databases', id);
const fetchSysMetrics  = id => api('ch-system-metrics', id);
const fetchSettings    = id => api('ch-settings', id);

const TABS = [
  { id:'overview',    label:'Overview',       icon:Activity },
  { id:'queries',     label:'Queries',        icon:Zap },
  { id:'querylog',    label:'Query Log',      icon:FileText },
  { id:'tables',      label:'Tables',         icon:Database },
  { id:'partitions',  label:'Partitions',     icon:Layers },
  { id:'merges',      label:'Merges',         icon:GitMerge },
  { id:'replicas',    label:'Replicas',       icon:Copy },
  { id:'clusters',    label:'Clusters',       icon:Network },
  { id:'databases',   label:'Databases',      icon:Server },
  { id:'settings',    label:'Settings',       icon:Clipboard },
  { id:'sysmetrics',  label:'System Metrics', icon:ClipboardCheck },
  { id:'slowqueries', label:'Slow Queries',   icon:TrendingUp },
];

const RI = 15;

export default function ClickHouseDashboard() {
  const { id, tab: tabParam } = useParams();
  const navigate = useNavigate();
  // Tab is URL-driven: /clickhouse-dashboard/:id/:tab → every tab has its own route.
  const tab = tabParam || 'overview';
  const setTab = (t) =>
    navigate(`/clickhouse-dashboard/${id}${t && t !== 'overview' ? `/${t}` : ''}`);
  const [countdown, setCountdown] = useState(RI);
  const [sparklines, setSpark]  = useState({ mem:[], qps:[], parts:[] });
  const [tblSearch, setTblSearch] = useState('');
  const [tblDb, setTblDb]       = useState('');
  const [tblSortKey, setTblSortKey] = useState('bytes');
  const [tblSortAsc, setTblSortAsc] = useState(false);
  const [qlUser, setQlUser]     = useState('');
  const [qlKind, setQlKind]     = useState('');
  const [qlSearch, setQlSearch] = useState('');
  const [qlPage, setQlPage]     = useState(0);
  const [sqUser, setSqUser]     = useState('');
  const [sqThresh, setSqThresh] = useState(500);
  const [expandedRows, setExpandedRows] = useState({});
  const [copied, setCopied]     = useState('');
  const [partTblFilter, setPartTblFilter] = useState('');
  const countRef = useRef(null);

  const toggleRow = key => setExpandedRows(p => ({ ...p, [key]: !p[key] }));
  const copyText  = (text, key) => {
    navigator.clipboard.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(''), 2000); });
  };

  /* ── queries ── */
  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey:['chDash',id], queryFn:()=>fetchDashboard(id), retry:false, refetchInterval:RI*1000,
  });
  const { data:qData,   isLoading:qLoad   } = useQuery({ queryKey:['chQ',id],   queryFn:()=>fetchQueries(id),     retry:false, refetchInterval:5000,  enabled:tab==='queries'     });
  const { data:qlData,  isLoading:qlLoad  } = useQuery({ queryKey:['chQL',id],  queryFn:()=>fetchQueryLog(id),    retry:false, refetchInterval:15000, enabled:tab==='querylog'    });
  const { data:sqData,  isLoading:sqLoad  } = useQuery({ queryKey:['chSQ',id],  queryFn:()=>fetchSlowQueries(id), retry:false, refetchInterval:30000, enabled:tab==='slowqueries' });
  const { data:tData,   isLoading:tLoad   } = useQuery({ queryKey:['chT',id],   queryFn:()=>fetchTables(id),      retry:false, refetchInterval:30000, enabled:tab==='tables'      });
  const { data:pData,   isLoading:pLoad   } = useQuery({ queryKey:['chP',id],   queryFn:()=>fetchPartitions(id),  retry:false, refetchInterval:30000, enabled:tab==='partitions'  });
  const { data:mData,   isLoading:mLoad   } = useQuery({ queryKey:['chM',id],   queryFn:()=>fetchMerges(id),      retry:false, refetchInterval:5000,  enabled:tab==='merges'      });
  const { data:rData,   isLoading:rLoad   } = useQuery({ queryKey:['chR',id],   queryFn:()=>fetchReplicas(id),    retry:false, refetchInterval:10000, enabled:tab==='replicas'    });
  const { data:clData,  isLoading:clLoad  } = useQuery({ queryKey:['chCL',id],  queryFn:()=>fetchClusters(id),    retry:false, refetchInterval:30000, enabled:tab==='clusters'    });
  const { data:dbData,  isLoading:dbLoad  } = useQuery({ queryKey:['chDB',id],  queryFn:()=>fetchDatabases(id),   retry:false, refetchInterval:30000, enabled:tab==='databases'   });
  const { data:smData,   isLoading:smLoad   } = useQuery({ queryKey:['chSM',id],  queryFn:()=>fetchSysMetrics(id),  retry:false, refetchInterval:30000, enabled:tab==='overview'||tab==='sysmetrics' });
  const { data:stData,   isLoading:stLoad,  refetch:refetchSettings } = useQuery({ queryKey:['chST',id], queryFn:()=>fetchSettings(id),    retry:false, refetchInterval:60000, enabled:tab==='settings'    });

  /* ── countdown ── */
  useEffect(() => {
    setCountdown(RI);
    if (countRef.current) clearInterval(countRef.current);
    countRef.current = setInterval(() => setCountdown(c => c<=1?RI:c-1), 1000);
    return () => clearInterval(countRef.current);
  }, [dataUpdatedAt]);

  /* ── sparklines ── */
  useEffect(() => {
    if (!data) return;
    const hs = data.health_summary || {};
    setSpark(p => ({
      mem:   [...p.mem.slice(-20),   { t:new Date().toLocaleTimeString(), v:Number(hs.memory_usage_pct)||0 }],
      qps:   [...p.qps.slice(-20),   { t:new Date().toLocaleTimeString(), v:Number(hs.queries_per_second)||0 }],
      parts: [...p.parts.slice(-20), { t:new Date().toLocaleTimeString(), v:Number(hs.total_parts)||0 }],
    }));
  }, [data]);

  if (isLoading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-yellow-200 border-t-yellow-500 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-slate-600 font-semibold">Connecting to ClickHouse…</p>
      </div>
    </div>
  );

  if (error) return (
    <div className="p-8">
      <div className="bg-red-50 border border-red-200 text-red-700 p-6 rounded-2xl max-w-2xl">
        <AlertTriangle className="mb-2" size={24} />
        <p className="font-bold text-lg">Connection Error</p>
        <p className="text-sm mt-2">{error?.message}</p>
        <button onClick={()=>refetch()} className="mt-4 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700">Retry</button>
      </div>
    </div>
  );

  const {
    connection={}, health_summary:hs={}, tables=[], top_databases=[],
    merges=[], replicas=[], processes=[], recent_errors=[], settings=[],
    query_stats={}, disk_usage={}, databases=[],
    metrics:sysMetrics=[], async_metrics:asyncMet=[], events:sysEvents=[],
  } = data || {};

  const memPct  = Number(hs.memory_usage_pct)  || 0;
  const diskPct = Number(disk_usage?.used_pct) || 0;
  const qRate   = Number(hs.queries_per_second) || 0;
  const hScore  = Math.max(0, 100
    - (memPct>90?30:memPct>75?15:0)
    - (diskPct>90?25:diskPct>75?10:0)
    - (merges.length>30?15:merges.length>10?5:0)
    - (recent_errors.length>10?15:recent_errors.length>0?5:0)
    - ((hs.total_parts||0)>5000?10:(hs.total_parts||0)>2000?5:0)
  );

  const alerts = {
    queries:     processes.length,
    merges:      merges.length>20 ? merges.length : 0,
    replicas:    replicas.filter(r=>r.last_queue_exception).length,
    slowqueries: 0,
  };

  /* ── helper for events ── */
  const evVal = (rows, key) => {
    for (const r of rows) {
      const k = r.metric || r.event;
      if (k===key) return Number(r.value||0);
    }
    return 0;
  };

  return (
    <div className="min-h-full bg-slate-50 flex flex-col">

      {/* ─── HEADER ─── */}
      <div style={{background:'linear-gradient(to right,#0f172a,#78350f,#7c1d12)'}} className="text-white shadow-xl">
        <div className="px-6 py-4 flex flex-wrap justify-between items-center gap-3">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl"
              style={{background:'rgba(255,204,0,0.15)',border:'1px solid rgba(255,204,0,0.4)'}}>⚡</div>
            <div>
              <h1 className="text-2xl font-black tracking-tight">ClickHouse Dashboard</h1>
              <p className="text-sm mt-0.5" style={{color:'#FFCC00'}}>
                {connection.name||'ClickHouse'} — {connection.host}:{connection.port}
                {connection.database ? ` / ${connection.database}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-black shadow ${hScore>=80?'bg-green-500':hScore>=60?'bg-yellow-400':'bg-red-500'} text-white`}>
              <Heart size={12} className="animate-pulse" /> Health {hScore}
            </div>
            <button onClick={()=>refetch()}
              className="flex items-center gap-2 px-4 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-sm font-semibold">
              <RefreshCw size={13} className={isFetching?'animate-spin':''} />
              Refresh
              <span className="ml-1 w-5 h-5 rounded-full text-[10px] font-black flex items-center justify-center"
                style={{background:'rgba(255,204,0,0.3)',color:'#FFCC00'}}>{countdown}</span>
            </button>
          </div>
        </div>

        {/* ── TAB BAR ── */}
        <div className="px-4 pt-2 flex gap-0.5 overflow-x-auto border-t border-white/10">
          {TABS.map(t => {
            const Icon = t.icon;
            const alert = alerts[t.id]||0;
            return (
              <button key={t.id} onClick={()=>setTab(t.id)}
                className={`relative flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-lg whitespace-nowrap transition-all ${
                  tab===t.id ? 'bg-slate-50 text-amber-700' : 'text-white/60 hover:text-white hover:bg-white/10'
                }`}>
                <Icon size={13} />{t.label}
                {alert>0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[9px] font-black rounded-full flex items-center justify-center">{alert}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── TAB CONTENT ─── */}
      <div className="flex-1 p-5 overflow-auto">

        {/* ══ OVERVIEW ══ */}
        {tab==='overview' && (()=>{
          const topTables = [...tables].sort((a,b)=>(b.total_bytes||b.bytes||0)-(a.total_bytes||a.bytes||0)).slice(0,10);
          const topDbs    = (top_databases.length?top_databases:databases).slice(0,8);
          const partPct   = Math.min(100, Math.round(((hs.total_parts||0)/Math.max(hs.max_parts_threshold||3000,1))*100));
          const smSummary = smData?.summary || {};

          return (
            <div className="space-y-4">
              {/* KPIs */}
              <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
                <KpiCard icon={Server}   title="Version"       value={(hs.version||'—').split('.').slice(0,2).join('.')} accent="yellow" />
                <KpiCard icon={Clock}    title="Uptime"        value={hs.uptime_str||'—'} accent="amber" />
                <KpiCard icon={Database} title="Databases"     value={hs.total_databases??'—'} accent="blue" />
                <KpiCard icon={Layers}   title="Tables"        value={hs.total_tables??'—'} accent="teal" />
                <KpiCard icon={Activity} title="Active"        value={hs.active_queries??0} accent={hs.active_queries>10?'red':'green'} />
                <KpiCard icon={Cpu}      title="Memory"        value={hs.memory_usage_human||`${memPct}%`} accent={memPct>80?'red':'orange'} />
                <KpiCard icon={Archive}  title="Parts"         value={fmtNum(hs.total_parts)} accent={hs.total_parts>2000?'red':'slate'} />
                <KpiCard icon={GitMerge} title="Merges"        value={merges.length} accent={merges.length>20?'red':merges.length>5?'orange':'green'} />
              </div>

              {/* Host Resources drill-down */}
              <HostResources connId={id} tech="clickhouse" />

              {/* Status badges */}
              <div className="flex flex-wrap gap-2">
                <SBadge ok={memPct<80}              label={`Memory ${memPct}%`} />
                <SBadge ok={diskPct<85}             label={`Disk ${diskPct}%`} />
                <SBadge ok={merges.length<20}       label={`Merges: ${merges.length}`} />
                <SBadge ok={recent_errors.length===0} label={`Errors: ${recent_errors.length}`} />
                {hs.replication_enabled && <SBadge ok label="Replication ON" />}
                {qRate>0 && <SBadge ok label={`${qRate.toFixed(1)} q/s`} />}
              </div>

              {/* Gauges */}
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
                <Gauge title="Memory Usage" pct={memPct}
                  sub={hs.memory_usage_human?`${hs.memory_usage_human} / ${hs.total_memory_human||'?'}`:`${memPct}%`}
                  colorFn={v=>v>85?C.red:v>70?C.orange:C.yellow} />
                <Gauge title="Disk Usage" pct={diskPct}
                  sub={disk_usage?.used_human?`${disk_usage.used_human} / ${disk_usage.total_human}`:`${diskPct}%`}
                  colorFn={v=>v>90?C.red:v>75?C.orange:C.teal} />
                <Gauge title="Query Rate" pct={Math.min(100,Math.round(qRate))}
                  center={qRate.toFixed(1)} unit=" q/s"
                  sub={`Active: ${hs.active_queries||0}`}
                  colorFn={v=>v>90?C.red:v>70?C.orange:C.green} />
                <Gauge title="Parts Health" pct={partPct}
                  center={fmtNum(hs.total_parts)} unit=" parts"
                  sub={`Threshold: ${fmtNum(hs.max_parts_threshold||3000)}`}
                  colorFn={v=>v>80?C.red:v>60?C.orange:C.green} />
              </div>

              {/* Sparklines */}
              {sparklines.mem.length>2 ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Trend title="Memory %" data={sparklines.mem}   color={C.yellow} unit="%" />
                  <Trend title="Query Rate" data={sparklines.qps} color={C.amber}  fmtVal={v=>`${Number(v).toFixed(1)} q/s`} />
                  <Trend title="Total Parts" data={sparklines.parts} color={C.orange} fmtVal={fmtNum} />
                </div>
              ) : (
                <div className="bg-white rounded-2xl border border-slate-200 p-4 text-center text-slate-400 text-xs">
                  Live trend charts appear after first 15s auto-refresh
                </div>
              )}

              {/* Charts */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ChartCard title="Top 10 Tables by Size">
                  {topTables.length>0 ? (
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart layout="vertical" data={topTables.map(t=>({
                        name:`${t.database||''}.${t.name||''}`.slice(0,28),
                        bytes:t.total_bytes||t.bytes||0,
                      }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                        <XAxis type="number" tick={{fontSize:9}} tickFormatter={fmtBytes} axisLine={false} tickLine={false} />
                        <YAxis width={148} type="category" dataKey="name" tick={{fontSize:9}} axisLine={false} tickLine={false} />
                        <Tooltip formatter={v=>fmtBytes(v)} cursor={{fill:'#fefce8'}} />
                        <Bar dataKey="bytes" radius={[0,5,5,0]}>
                          {topTables.map((_,i)=><Cell key={i} fill={CC[i%CC.length]} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : <p className="text-center text-slate-400 text-xs py-16">No table data</p>}
                </ChartCard>

                <ChartCard title="Top Databases by Size">
                  {topDbs.length>0 ? (
                    <>
                      <ResponsiveContainer width="100%" height={200}>
                        <PieChart>
                          <Pie data={topDbs.map(d=>({ name:d.name||d.database||'?', value:d.total_bytes||0 }))}
                            cx="50%" cy="50%" outerRadius={75} dataKey="value"
                            label={({name,percent})=>`${name} ${(percent*100).toFixed(0)}%`} labelLine={false}>
                            {topDbs.map((_,i)=><Cell key={i} fill={CC[i%CC.length]} />)}
                          </Pie>
                          <Tooltip formatter={v=>fmtBytes(v)} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="grid grid-cols-2 gap-x-4 mt-2">
                        {topDbs.slice(0,6).map((d,i)=>(
                          <div key={i} className="flex items-center gap-2 py-0.5">
                            <div className="w-2.5 h-2.5 rounded-full" style={{background:CC[i%CC.length]}} />
                            <span className="text-[10px] text-slate-600 truncate">{d.name||d.database}</span>
                            <span className="text-[10px] text-slate-400 ml-auto">{fmtBytes(d.total_bytes)}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : <p className="text-center text-slate-400 text-xs py-16">No database data</p>}
                </ChartCard>
              </div>

              {/* System Events metrics */}
              {smData && (
                <Panel title="System Events & I/O">
                  <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
                    {[
                      { label:'Total Queries',    v:fmtNum(smData.summary?.total_queries||evVal(sysEvents,'Query'))   },
                      { label:'SELECT Queries',   v:fmtNum(smData.summary?.select_queries||evVal(sysEvents,'SelectQuery')) },
                      { label:'INSERT Queries',   v:fmtNum(smData.summary?.insert_queries||evVal(sysEvents,'InsertQuery')) },
                      { label:'Failed Queries',   v:fmtNum(smData.summary?.failed_queries||evVal(sysEvents,'FailedQuery')) },
                      { label:'Merged Rows',      v:fmtNum(smData.summary?.merged_rows||evVal(sysEvents,'MergedRows')) },
                      { label:'Network IN',       v:fmtBytes(smData.summary?.network_receive_bytes||evVal(sysEvents,'NetworkReceiveBytes')) },
                      { label:'Network OUT',      v:fmtBytes(smData.summary?.network_send_bytes||evVal(sysEvents,'NetworkSendBytes')) },
                      { label:'Read Compressed',  v:fmtBytes(smData.summary?.read_compressed_bytes||evVal(sysEvents,'ReadCompressedBytes')) },
                      { label:'Write Compressed', v:fmtBytes(smData.summary?.write_compressed_bytes||evVal(sysEvents,'WriteCompressedBytes')) },
                      { label:'Query Threads',    v:fmtNum(smData.summary?.query_threads||evVal(sysMetrics,'QueryThread')) },
                      { label:'Repl Queue Max',   v:smData.summary?.replicas_max_queue||evVal(asyncMet,'ReplicasMaxQueueSize') },
                      { label:'Repl Delay Max',   v:`${smData.summary?.replicas_max_delay||evVal(asyncMet,'ReplicasMaxAbsoluteDelay')}s` },
                    ].map(({label,v},i)=>(
                      <div key={i} className="bg-slate-50 rounded-xl border border-slate-200 p-3">
                        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{label}</p>
                        <p className="text-sm font-black text-slate-800 mt-1 truncate">{v??'—'}</p>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}

              {/* Server info + Disk */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <Panel title="Server Information">
                  <Row label="Version"       value={hs.version||'—'} mono />
                  <Row label="Uptime"        value={hs.uptime_str||'—'} />
                  <Row label="Host"          value={connection.host||'—'} mono />
                  <Row label="Port (native)" value={connection.port||9000} />
                  <Row label="Database"      value={connection.database||'default'} />
                  <Row label="Memory Used"   value={hs.memory_usage_human||'—'} />
                  <Row label="Total Memory"  value={hs.total_memory_human||'—'} />
                  <Row label="Databases"     value={hs.total_databases??'—'} />
                  <Row label="Tables"        value={hs.total_tables??'—'} />
                </Panel>
                <Panel title="Disk & Parts">
                  {disk_usage?.used_pct!==undefined ? (
                    <>
                      <div className="mb-4">
                        <div className="flex justify-between text-xs text-slate-500 mb-1">
                          <span>Disk Used</span><span className="font-black">{diskPct}%</span>
                        </div>
                        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{width:`${diskPct}%`,background:diskPct>=90?C.red:diskPct>=75?C.orange:C.yellow}} />
                        </div>
                      </div>
                      <Row label="Total"  value={disk_usage.total_human||fmtBytes(disk_usage.total_space)||'—'} />
                      <Row label="Used"   value={disk_usage.used_human ||fmtBytes(disk_usage.used_space) ||'—'} />
                      <Row label="Free"   value={disk_usage.free_human ||fmtBytes(disk_usage.free_space) ||'—'} />
                    </>
                  ) : <p className="text-slate-400 text-xs py-4">No disk usage data</p>}
                  <div className="mt-3 pt-3 border-t border-slate-100">
                    <Row label="Total Parts"    value={fmtNum(hs.total_parts)||'—'} />
                    <Row label="Max Parts / Partition" value={hs.max_part_count_for_partition||'—'} />
                    <Row label="Active Merges"  value={merges.length} />
                    <Row label="Repl. Tables"   value={replicas.length||'—'} />
                  </div>
                </Panel>
              </div>

              {/* Recent errors */}
              {recent_errors.length>0 && (
                <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertTriangle className="text-red-500" size={16} />
                    <span className="font-bold text-red-700 text-sm">{recent_errors.length} Recent Error{recent_errors.length!==1?'s':''}</span>
                    <button onClick={()=>setTab('querylog')} className="ml-auto text-xs text-red-600 hover:underline font-semibold">View Log</button>
                  </div>
                  <div className="space-y-2">
                    {recent_errors.slice(0,5).map((e,i)=>(
                      <div key={i} className="bg-white rounded-xl border border-red-100 px-3 py-2 text-xs">
                        <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-[10px] font-bold mr-2">{e.type}</span>
                        <span className="text-slate-400">{String(e.event_time||'').slice(0,19)}</span>
                        {e.user && <span className="ml-2 text-amber-700 font-semibold">{e.user}</span>}
                        <div className="mt-1 font-mono text-slate-500 truncate">{String(e.message||e.exception||'').slice(0,150)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Quick actions */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <ActionCard icon={<Zap style={{color:C.yellow}} size={22}/>} title="Active Queries" desc="Running processes" onClick={()=>setTab('queries')} />
                <ActionCard icon={<TrendingUp style={{color:C.chRed}} size={22}/>} title="Slow Queries" desc="Expensive SQL" onClick={()=>setTab('slowqueries')} />
                <ActionCard icon={<GitMerge style={{color:C.amber}} size={22}/>} title="Merge Status" desc="Active merges" onClick={()=>setTab('merges')} />
                <ActionCard icon={<Copy style={{color:C.blue}} size={22}/>} title="Replicas" desc="Replication health" onClick={()=>setTab('replicas')} />
              </div>
            </div>
          );
        })()}

        {/* ══ QUERIES ══ */}
        {tab==='queries' && (
          <div className="space-y-5">
            {qLoad ? <TabLoader/> : (()=>{
              const qs    = qData?.queries   || processes;
              const stats = qData?.stats     || {};
              return (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <MKpi title="Active Queries" value={qs.length}       accent={qs.length>0?'orange':'green'} />
                    <MKpi title="Queries / sec"  value={(stats.queries_per_second||qRate).toFixed(2)} accent="yellow" />
                    <MKpi title="Failed"         value={fmtNum(stats.failed_queries||0)} accent={stats.failed_queries>0?'red':'green'} />
                    <MKpi title="SELECT"         value={fmtNum(stats.select_queries||0)} accent="blue" />
                  </div>

                  <ChartCard title="Query Type Distribution">
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={[
                        {name:'SELECT',v:stats.select_queries||0},
                        {name:'INSERT',v:stats.insert_queries||0},
                        {name:'FAILED',v:stats.failed_queries||0},
                      ]} barCategoryGap="30%">
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                        <XAxis dataKey="name" tick={{fontSize:10,fontWeight:600}} axisLine={false} tickLine={false} />
                        <YAxis tick={{fontSize:9}} tickFormatter={fmtNum} axisLine={false} tickLine={false} />
                        <Tooltip formatter={fmtNum} cursor={{fill:'#fefce8'}} />
                        <Bar dataKey="v" radius={[5,5,0,0]}>
                          {[C.yellow,C.amber,C.red].map((fill,i)=><Cell key={i} fill={fill}/>)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartCard>

                  <Panel title={`Running Processes (${qs.length})`}>
                    {qs.length===0 ? (
                      <div className="text-center py-12">
                        <CheckCircle2 className="mx-auto text-green-400 mb-3" size={40}/>
                        <p className="text-slate-500 font-semibold">No active queries</p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50">
                            <tr>
                              {['','Query ID','User','DB','Elapsed (s)','Read Rows','Read Bytes','Memory','Query'].map(h=>(
                                <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {qs.map((p,i)=>{
                              const rKey = p.query_id||`q${i}`;
                              const isExp = expandedRows[rKey];
                              return (
                                <React.Fragment key={i}>
                                  <tr className={`border-t border-slate-100 hover:bg-yellow-50 ${Number(p.elapsed)>5?'bg-amber-50':''}`}>
                                    <td className="px-2 py-2">
                                      <button onClick={()=>toggleRow(rKey)} className="text-slate-300 hover:text-amber-500">
                                        {isExp?<ChevronUp size={14}/>:<ChevronDown size={14}/>}
                                      </button>
                                    </td>
                                    <td className="px-3 py-2.5 font-mono text-[10px] text-slate-500 max-w-[120px] truncate">{p.query_id||'—'}</td>
                                    <td className="px-3 py-2.5 font-semibold text-amber-700 text-xs">{p.user||'—'}</td>
                                    <td className="px-3 py-2.5 text-xs text-slate-500">{p.current_database||'—'}</td>
                                    <td className={`px-3 py-2.5 font-bold text-xs ${Number(p.elapsed)>5?'text-red-600':Number(p.elapsed)>1?'text-orange-500':'text-slate-700'}`}>
                                      {Number(p.elapsed||0).toFixed(2)}
                                    </td>
                                    <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(p.read_rows||0)}</td>
                                    <td className="px-3 py-2.5 font-mono text-xs">{fmtBytes(p.read_bytes||0)}</td>
                                    <td className="px-3 py-2.5 font-mono text-xs">{fmtBytes(p.memory_usage||0)}</td>
                                    <td className="px-3 py-2.5 font-mono text-[10px] text-slate-500 max-w-[220px] truncate">{String(p.query||'—').slice(0,100)}</td>
                                  </tr>
                                  {isExp && (
                                    <tr className="bg-amber-50 border-t border-amber-100">
                                      <td colSpan={9} className="px-4 py-3">
                                        <div className="flex items-start justify-between gap-3">
                                          <pre className="font-mono text-xs text-slate-700 whitespace-pre-wrap break-all flex-1 bg-white border border-slate-200 rounded-xl p-3 max-h-40 overflow-y-auto">
                                            {p.query||'(no query text)'}
                                          </pre>
                                          <button onClick={()=>copyText(p.query||'',`q-${rKey}`)}
                                            className="flex items-center gap-1 px-2 py-1 bg-amber-100 text-amber-700 rounded-lg text-[10px] font-bold hover:bg-amber-200 whitespace-nowrap mt-1 flex-shrink-0">
                                            {copied===`q-${rKey}` ? <><ClipboardCheck size={12}/> Copied</> : <><Clipboard size={12}/> Copy SQL</>}
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </React.Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Panel>
                </>
              );
            })()}
          </div>
        )}

        {/* ══ QUERY LOG ══ */}
        {tab==='querylog' && (
          <div className="space-y-5">
            {qlLoad ? <TabLoader/> : (()=>{
              const allLogs = qlData?.logs || [];
              const users   = [...new Set(allLogs.map(l=>l.user).filter(Boolean))];
              const kinds   = [...new Set(allLogs.map(l=>l.query_kind||l.type).filter(Boolean))];
              const filtered = allLogs.filter(l =>
                (!qlUser   || l.user===qlUser) &&
                (!qlKind   || (l.query_kind||l.type)===qlKind) &&
                (!qlSearch || String(l.query||'').toLowerCase().includes(qlSearch.toLowerCase()) ||
                              String(l.query_id||'').toLowerCase().includes(qlSearch.toLowerCase()))
              );
              const PAGE=20;
              const pages = Math.max(1, Math.ceil(filtered.length/PAGE));
              const safePage = Math.min(qlPage, pages-1);
              const page = filtered.slice(safePage*PAGE, (safePage+1)*PAGE);
              return (
                <>
                  {/* Filters */}
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="relative">
                      <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
                      <input value={qlSearch} onChange={e=>{setQlSearch(e.target.value);setQlPage(0);}}
                        placeholder="Search query text or ID…"
                        className="h-9 w-64 pl-8 pr-4 rounded-xl border border-slate-200 text-sm outline-none focus:border-amber-400" />
                    </div>
                    <select value={qlUser} onChange={e=>{setQlUser(e.target.value);setQlPage(0);}}
                      className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white focus:border-amber-400">
                      <option value="">All Users</option>
                      {users.map(u=><option key={u} value={u}>{u}</option>)}
                    </select>
                    <select value={qlKind} onChange={e=>{setQlKind(e.target.value);setQlPage(0);}}
                      className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white focus:border-amber-400">
                      <option value="">All Kinds</option>
                      {kinds.map(k=><option key={k} value={k}>{k}</option>)}
                    </select>
                    <span className="text-xs text-slate-400">{filtered.length} entries</span>
                    <div className="ml-auto flex items-center gap-2">
                      <button disabled={safePage===0} onClick={()=>setQlPage(p=>Math.max(0,p-1))}
                        className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs disabled:opacity-40 hover:bg-slate-50">← Prev</button>
                      <span className="text-xs text-slate-500">Page {safePage+1}/{pages}</span>
                      <button disabled={safePage>=pages-1} onClick={()=>setQlPage(p=>Math.min(pages-1,p+1))}
                        className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs disabled:opacity-40 hover:bg-slate-50">Next →</button>
                    </div>
                  </div>

                  <Panel title={`Query Log (${filtered.length} entries)`}>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50">
                          <tr>
                            {['','Time','User','Kind','Duration ms','Read Rows','Read Bytes','Memory','Status','Query Preview'].map(h=>(
                              <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {page.map((l,i)=>{
                            const rKey = l.query_id||`ql${i}`;
                            const isExp = expandedRows[`ql-${rKey}`];
                            const hasErr = !!l.exception;
                            return (
                              <React.Fragment key={i}>
                                <tr className={`border-t border-slate-100 hover:bg-yellow-50 ${hasErr?'bg-red-50':''}`}>
                                  <td className="px-2 py-2">
                                    <button onClick={()=>toggleRow(`ql-${rKey}`)} className="text-slate-300 hover:text-amber-500">
                                      {isExp?<ChevronUp size={14}/>:<ChevronDown size={14}/>}
                                    </button>
                                  </td>
                                  <td className="px-3 py-2 text-[10px] text-slate-400 whitespace-nowrap">{String(l.event_time||'').slice(0,19)}</td>
                                  <td className="px-3 py-2 font-semibold text-amber-700 text-xs">{l.user||'—'}</td>
                                  <td className="px-3 py-2">
                                    <span className="px-1.5 py-0.5 bg-yellow-100 text-yellow-800 text-[10px] font-bold rounded-full">
                                      {l.query_kind||l.type||'—'}
                                    </span>
                                  </td>
                                  <td className={`px-3 py-2 font-mono text-xs font-bold ${Number(l.elapsed_ms)>1000?'text-red-600':Number(l.elapsed_ms)>200?'text-orange-500':'text-slate-700'}`}>
                                    {fmtNum(l.elapsed_ms||0)}
                                  </td>
                                  <td className="px-3 py-2 font-mono text-xs">{fmtNum(l.read_rows||0)}</td>
                                  <td className="px-3 py-2 font-mono text-xs">{fmtBytes(l.read_bytes||0)}</td>
                                  <td className="px-3 py-2 font-mono text-xs">{fmtBytes(l.memory_usage||0)}</td>
                                  <td className="px-3 py-2 text-center">
                                    {hasErr ? <XCircle size={13} className="text-red-500 mx-auto"/> : <CheckCircle2 size={13} className="text-green-500 mx-auto"/>}
                                  </td>
                                  <td className="px-3 py-2 font-mono text-[10px] text-slate-500 max-w-[240px] truncate">
                                    {String(l.query||'—').slice(0,100)}
                                  </td>
                                </tr>
                                {isExp && (
                                  <tr className="bg-amber-50 border-t border-amber-100">
                                    <td colSpan={10} className="px-4 py-3">
                                      <div className="flex items-start gap-3">
                                        <div className="flex-1 space-y-2">
                                          <pre className="font-mono text-xs text-slate-700 whitespace-pre-wrap break-all bg-white border border-slate-200 rounded-xl p-3 max-h-44 overflow-y-auto">
                                            {l.query||'(no query text)'}
                                          </pre>
                                          {hasErr && (
                                            <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                                              <p className="text-[10px] font-bold text-red-700 uppercase mb-1">Exception</p>
                                              <p className="font-mono text-xs text-red-600">{l.exception}</p>
                                            </div>
                                          )}
                                        </div>
                                        <button onClick={()=>copyText(l.query||'',`ql-${rKey}`)}
                                          className="flex items-center gap-1 px-2 py-1 bg-amber-100 text-amber-700 rounded-lg text-[10px] font-bold hover:bg-amber-200 flex-shrink-0 mt-1">
                                          {copied===`ql-${rKey}` ? <><ClipboardCheck size={12}/> Copied</> : <><Clipboard size={12}/> Copy SQL</>}
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                          {page.length===0 && (
                            <tr><td colSpan={10} className="text-center py-10 text-slate-400">No entries found</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                </>
              );
            })()}
          </div>
        )}

        {/* ══ TABLES ══ */}
        {tab==='tables' && (
          <div className="space-y-4">
            {tLoad ? <TabLoader/> : (()=>{
              const all     = tData?.tables || tables;
              const dbOpts  = [...new Set(all.map(t=>t.database).filter(Boolean))].sort();
              const maxBytes = Math.max(...all.map(t=>t.bytes||t.total_bytes||0),1);
              let filt = all.filter(t=>
                (!tblDb     || t.database===tblDb) &&
                (!tblSearch || (t.name||'').toLowerCase().includes(tblSearch.toLowerCase()) ||
                               (t.database||'').toLowerCase().includes(tblSearch.toLowerCase()))
              );
              filt = [...filt].sort((a,b)=>{
                let av=a[tblSortKey]??0, bv=b[tblSortKey]??0;
                if (typeof av==='string') av=av.toLowerCase();
                if (typeof bv==='string') bv=bv.toLowerCase();
                return tblSortAsc ? (av<bv?-1:av>bv?1:0) : (av>bv?-1:av<bv?1:0);
              });
              const SH = ({label,field})=>(
                <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap cursor-pointer hover:text-amber-600 select-none"
                  onClick={()=>{ tblSortKey===field?setTblSortAsc(v=>!v):(setTblSortKey(field),setTblSortAsc(false)); }}>
                  <span className="flex items-center gap-1">{label}
                    {tblSortKey===field?(tblSortAsc?<ArrowUp size={10}/>:<ArrowDown size={10}/>):null}
                  </span>
                </th>
              );
              return (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="relative max-w-xs">
                      <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
                      <input value={tblSearch} onChange={e=>setTblSearch(e.target.value)} placeholder="Search tables…"
                        className="h-9 w-full pl-8 pr-4 rounded-xl border border-slate-200 text-sm outline-none focus:border-amber-400" />
                    </div>
                    <select value={tblDb} onChange={e=>setTblDb(e.target.value)}
                      className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white focus:border-amber-400">
                      <option value="">All Databases</option>
                      {dbOpts.map(d=><option key={d} value={d}>{d}</option>)}
                    </select>
                    <span className="text-xs text-slate-400">{filt.length} tables</span>
                  </div>
                  <Panel title="Tables">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50">
                          <tr>
                            <th className="px-2 py-2.5 w-6"></th>
                            <SH label="Database"  field="database"/>
                            <SH label="Table"     field="name"/>
                            <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">Engine</th>
                            <SH label="Rows"      field="rows"/>
                            <SH label="Size"      field="bytes"/>
                            <SH label="Compress"  field="compression_ratio"/>
                            <SH label="Parts"     field="parts_count"/>
                            <SH label="Partitions" field="partitions_count"/>
                            <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase">Modified</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filt.slice(0,200).map((t,i)=>{
                            const rKey=`${t.database}.${t.name}`;
                            const isExp=expandedRows[`tbl-${rKey}`];
                            const bv=t.bytes||t.total_bytes||0;
                            return (
                              <React.Fragment key={i}>
                                <tr className={`border-t border-slate-100 hover:bg-yellow-50 ${(t.parts_count||0)>300?'bg-orange-50':''}`}>
                                  <td className="px-2 py-2">
                                    <button onClick={()=>toggleRow(`tbl-${rKey}`)} className="text-slate-300 hover:text-amber-500">
                                      {isExp?<ChevronUp size={13}/>:<ChevronDown size={13}/>}
                                    </button>
                                  </td>
                                  <td className="px-3 py-2.5 text-xs text-slate-400">{t.database}</td>
                                  <td className="px-3 py-2.5 font-semibold text-amber-700">{t.name}</td>
                                  <td className="px-3 py-2.5">
                                    <span className="px-2 py-0.5 bg-yellow-100 text-yellow-800 text-[10px] font-bold rounded-full">
                                      {(t.engine||'—').replace('MergeTree','MT').slice(0,18)}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(t.rows||t.total_rows||0)}</td>
                                  <td className="px-3 py-2.5">
                                    <div className="flex items-center gap-2">
                                      <span className="font-mono text-xs">{fmtBytes(bv)}</span>
                                      <div className="flex-1 h-1.5 bg-slate-100 rounded-full max-w-[50px]">
                                        <div className="h-full rounded-full" style={{width:`${(bv/maxBytes)*100}%`,background:C.amber}}/>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-3 py-2.5">
                                    {t.compression_ratio ? (
                                      <span className={`font-mono text-xs font-bold ${t.compression_ratio>5?'text-green-600':t.compression_ratio>2?'text-amber-600':'text-slate-500'}`}>
                                        {t.compression_ratio}x
                                      </span>
                                    ):'—'}
                                  </td>
                                  <td className="px-3 py-2.5">
                                    <span className={`font-mono text-xs font-bold ${(t.parts_count||0)>300?'text-red-600':(t.parts_count||0)>100?'text-orange-500':'text-slate-700'}`}>
                                      {fmtNum(t.parts_count||0)}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(t.partitions_count||0)}</td>
                                  <td className="px-3 py-2.5 text-[10px] text-slate-400 whitespace-nowrap">
                                    {t.last_modified?String(t.last_modified).slice(0,16):'—'}
                                  </td>
                                </tr>
                                {isExp && (
                                  <tr className="bg-amber-50 border-t border-amber-100">
                                    <td colSpan={10} className="px-4 py-3">
                                      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
                                        <div><p className="text-[10px] text-slate-400 font-bold uppercase mb-1">Compressed</p><p className="font-mono font-semibold">{fmtBytes(t.compressed_bytes||0)}</p></div>
                                        <div><p className="text-[10px] text-slate-400 font-bold uppercase mb-1">Uncompressed</p><p className="font-mono font-semibold">{fmtBytes(t.uncompressed_bytes||0)}</p></div>
                                        <div><p className="text-[10px] text-slate-400 font-bold uppercase mb-1">Space Savings</p><p className={`font-mono font-bold ${(t.compression_ratio_pct||0)>50?'text-green-600':'text-slate-700'}`}>{t.compression_ratio_pct||0}%</p></div>
                                        <div><p className="text-[10px] text-slate-400 font-bold uppercase mb-1">Engine</p><p className="font-mono font-semibold">{t.engine||'—'}</p></div>
                                        <div><p className="text-[10px] text-slate-400 font-bold uppercase mb-1">Size on Disk</p><p className="font-mono font-semibold">{t.size_pretty||fmtBytes(bv)}</p></div>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                          {filt.length===0 && <tr><td colSpan={10} className="text-center py-10 text-slate-400">No tables found</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                </>
              );
            })()}
          </div>
        )}

        {/* ══ PARTITIONS ══ */}
        {tab==='partitions' && (
          <div className="space-y-5">
            {pLoad ? <TabLoader/> : (()=>{
              const parts = pData?.partitions || [];
              const byTable = {};
              parts.forEach(p=>{
                const k=`${p.database}.${p.table}`;
                if (!byTable[k]) byTable[k]={key:k,parts:[],bytes:0,partCount:0};
                byTable[k].parts.push(p);
                byTable[k].bytes += Number(p.bytes)||0;
                byTable[k].partCount += Number(p.part_count)||0;
              });
              const tblList = Object.values(byTable).sort((a,b)=>b.bytes-a.bytes);
              const tblOpts = tblList.map(t=>t.key);
              const shown   = partTblFilter ? tblList.filter(t=>t.key===partTblFilter) : tblList.slice(0,20);
              return (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <MKpi title="Total Parts"       value={fmtNum(parts.reduce((s,p)=>s+Number(p.part_count||0),0))} accent={parts.length>300?'red':'yellow'} />
                    <MKpi title="Total Partitions"  value={fmtNum(parts.length)} accent="amber" />
                    <MKpi title="Tables with Parts" value={tblList.length} accent="blue" />
                  </div>
                  <div className="flex items-center gap-3">
                    <select value={partTblFilter} onChange={e=>setPartTblFilter(e.target.value)}
                      className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white focus:border-amber-400">
                      <option value="">All Tables</option>
                      {tblOpts.map(k=><option key={k} value={k}>{k}</option>)}
                    </select>
                  </div>
                  {shown.map((tbl,ti)=>(
                    <Panel key={ti} title={`${tbl.key} — ${fmtNum(tbl.partCount)} parts, ${fmtBytes(tbl.bytes)}`}>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="bg-slate-50">
                            <tr>{['Partition','Partition ID','Active','Parts','Rows','Size','Marks'].map(h=>(
                              <th key={h} className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                            ))}</tr>
                          </thead>
                          <tbody>
                            {tbl.parts.slice(0,50).map((p,i)=>(
                              <tr key={i} className="border-t border-slate-100 hover:bg-yellow-50">
                                <td className="px-3 py-2 font-mono font-semibold text-amber-700">{String(p.partition||'').slice(0,24)}</td>
                                <td className="px-3 py-2 font-mono text-slate-400">{String(p.partition_id||'').slice(0,20)}</td>
                                <td className="px-3 py-2 text-center">
                                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${p.active?'bg-green-100 text-green-700':'bg-slate-100 text-slate-400'}`}>
                                    {p.active?'YES':'NO'}
                                  </span>
                                </td>
                                <td className={`px-3 py-2 font-mono font-bold ${Number(p.part_count)>100?'text-red-600':Number(p.part_count)>30?'text-orange-500':'text-slate-700'}`}>{p.part_count}</td>
                                <td className="px-3 py-2 font-mono">{fmtNum(p.rows||0)}</td>
                                <td className="px-3 py-2 font-mono">{p.size_pretty||fmtBytes(p.bytes||0)}</td>
                                <td className="px-3 py-2 font-mono">{fmtNum(p.marks||0)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Panel>
                  ))}
                  {tblList.length===0 && (
                    <Panel><div className="text-center py-12"><Layers size={40} className="mx-auto text-slate-200 mb-3"/><p className="text-slate-500 font-semibold">No partition data available</p></div></Panel>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* ══ MERGES ══ */}
        {tab==='merges' && (
          <div className="space-y-5">
            {mLoad ? <TabLoader/> : (()=>{
              const activeM = mData?.merges || merges;
              return (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <MKpi title="Active Merges"    value={activeM.length} accent={activeM.length>20?'red':activeM.length>5?'orange':'green'} />
                    <MKpi title="Total Parts"      value={fmtNum(hs.total_parts||0)} accent={hs.total_parts>2000?'red':'yellow'} />
                    <MKpi title="Merged Rows Total" value={fmtNum(mData?.merge_rate_total_rows||0)} accent="blue" />
                    <MKpi title="Max Parts / Part" value={hs.max_part_count_for_partition||'—'} accent="slate" />
                  </div>
                  <Panel title={`Active Merges (${activeM.length})`}>
                    {activeM.length===0 ? (
                      <div className="text-center py-12">
                        <CheckCircle2 className="mx-auto text-green-400 mb-3" size={40}/>
                        <p className="text-slate-500 font-semibold">No active merges</p>
                        <p className="text-xs text-slate-400 mt-1">All merge operations are idle</p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50">
                            <tr>{['Database','Table','Parts','Elapsed (s)','Progress','Result Part','Rows Read','Bytes Read','Memory'].map(h=>(
                              <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                            ))}</tr>
                          </thead>
                          <tbody>
                            {activeM.map((m,i)=>{
                              const prog = Number(m.progress||0)*100;
                              return (
                                <tr key={i} className="border-t border-slate-100 hover:bg-yellow-50">
                                  <td className="px-3 py-2.5 text-xs text-slate-400">{m.database}</td>
                                  <td className="px-3 py-2.5 font-semibold text-amber-700">{m.table}</td>
                                  <td className="px-3 py-2.5 font-mono text-xs">{m.num_parts||'—'}</td>
                                  <td className="px-3 py-2.5 font-bold text-slate-700">{Number(m.elapsed||0).toFixed(1)}</td>
                                  <td className="px-3 py-2.5 min-w-[140px]">
                                    <div className="flex items-center gap-2">
                                      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden w-20">
                                        <div className="h-full rounded-full transition-all" style={{width:`${prog}%`,background:prog>80?C.green:C.amber}}/>
                                      </div>
                                      <span className="text-xs font-bold text-slate-600">{prog.toFixed(0)}%</span>
                                    </div>
                                  </td>
                                  <td className="px-3 py-2.5 font-mono text-[10px] text-slate-400 max-w-[120px] truncate">{m.result_part_name||'—'}</td>
                                  <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(m.rows_read||0)}</td>
                                  <td className="px-3 py-2.5 font-mono text-xs">{fmtBytes(m.bytes_read_uncompressed||0)}</td>
                                  <td className="px-3 py-2.5 font-mono text-xs">{fmtBytes(m.memory_usage||0)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Panel>
                  {activeM.length>10 && (
                    <div className="bg-orange-50 border border-orange-200 rounded-2xl p-4">
                      <div className="flex items-center gap-2 text-orange-700 font-bold mb-2"><AlertTriangle size={16}/>High Merge Queue ({activeM.length} active)</div>
                      <p className="text-sm text-orange-600">Consider reducing insert frequency or increasing background merge threads.</p>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* ══ REPLICAS ══ */}
        {tab==='replicas' && (
          <div className="space-y-5">
            {rLoad ? <TabLoader/> : (()=>{
              const repls   = rData?.replicas || replicas;
              const summary = rData?.summary  || {};
              if (repls.length===0) return (
                <Panel>
                  <div className="text-center py-16">
                    <Copy size={48} className="mx-auto mb-4 text-slate-200"/>
                    <p className="font-semibold text-slate-500">No replicated tables found</p>
                    <p className="text-sm text-slate-400 mt-1">Use ReplicatedMergeTree + ZooKeeper to enable replication.</p>
                  </div>
                </Panel>
              );
              return (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <MKpi title="Replicated Tables" value={summary.total_replicated_tables||repls.length} accent="blue" />
                    <MKpi title="Leaders"           value={summary.leaders||0} accent="yellow" />
                    <MKpi title="With Delay"        value={summary.with_delay||0} accent={summary.with_delay>0?'orange':'green'} />
                    <MKpi title="With Errors"       value={summary.with_errors||0} accent={summary.with_errors>0?'red':'green'} />
                  </div>
                  {summary.with_errors>0 && (
                    <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
                      <div className="flex items-center gap-2 text-red-700 font-bold mb-2"><XCircle size={16}/>{summary.with_errors} Replication Error{summary.with_errors!==1?'s':''}</div>
                      {repls.filter(r=>r.last_queue_exception).slice(0,4).map((r,i)=>(
                        <div key={i} className="bg-white rounded-xl border border-red-100 px-3 py-2 text-xs mb-2">
                          <span className="font-bold text-amber-700">{r.database}.{r.table}</span>
                          <div className="mt-1 font-mono text-slate-500 truncate">{r.last_queue_exception}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  <Panel title={`Replica Status (${repls.length} tables)`}>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50">
                          <tr>{['Database','Table','Leader','ReadOnly','Queue','Inserts Q','Merges Q','Delay (s)','Log Ptr','Log Max','ZooKeeper Path','Last Error'].map(h=>(
                            <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}</tr>
                        </thead>
                        <tbody>
                          {repls.map((r,i)=>(
                            <tr key={i} className={`border-t border-slate-100 hover:bg-yellow-50 ${r.last_queue_exception?'bg-red-50':''}`}>
                              <td className="px-3 py-2.5 text-xs text-slate-400">{r.database}</td>
                              <td className="px-3 py-2.5 font-semibold text-amber-700">{r.table}</td>
                              <td className="px-3 py-2.5 text-center">
                                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${r.is_leader?'bg-yellow-100 text-yellow-700':'bg-slate-100 text-slate-500'}`}>
                                  {r.is_leader?'YES':'NO'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-center">
                                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${r.is_readonly?'bg-red-100 text-red-700':'bg-green-100 text-green-700'}`}>
                                  {r.is_readonly?'YES':'NO'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 font-mono text-xs">{r.queue_size??'—'}</td>
                              <td className="px-3 py-2.5 font-mono text-xs">{r.inserts_in_queue??'—'}</td>
                              <td className="px-3 py-2.5 font-mono text-xs">{r.merges_in_queue??'—'}</td>
                              <td className={`px-3 py-2.5 font-bold text-xs ${Number(r.absolute_delay)>30?'text-red-600':Number(r.absolute_delay)>0?'text-orange-500':'text-green-600'}`}>
                                {r.absolute_delay??'0'}
                              </td>
                              <td className="px-3 py-2.5 font-mono text-xs">{r.log_pointer??'—'}</td>
                              <td className="px-3 py-2.5 font-mono text-xs">{r.log_max_index??'—'}</td>
                              <td className="px-3 py-2.5 font-mono text-[10px] text-slate-400 max-w-[140px] truncate">{r.zookeeper_path||'—'}</td>
                              <td className="px-3 py-2.5 font-mono text-[10px] text-red-500 max-w-[160px] truncate">{r.last_queue_exception||'—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                </>
              );
            })()}
          </div>
        )}

        {/* ══ CLUSTERS ══ */}
        {tab==='clusters' && (
          <div className="space-y-5">
            {clLoad ? <TabLoader/> : (()=>{
              const summary = clData?.cluster_summary || [];
              const allHosts= clData?.clusters        || [];
              if (allHosts.length===0) return (
                <Panel>
                  <div className="text-center py-16">
                    <Network size={48} className="mx-auto mb-4 text-slate-200"/>
                    <p className="font-semibold text-slate-500">No cluster configuration found</p>
                    <p className="text-sm text-slate-400 mt-1">This instance is running as a standalone node.</p>
                  </div>
                </Panel>
              );
              const totalErrors = summary.reduce((s,c)=>s+c.errors,0);
              return (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <MKpi title="Clusters"    value={summary.length} accent="blue" />
                    <MKpi title="Total Hosts" value={allHosts.length} accent="yellow" />
                    <MKpi title="Total Errors" value={totalErrors} accent={totalErrors>0?'red':'green'} />
                  </div>
                  {summary.map((cl,ci)=>(
                    <Panel key={ci} title={`Cluster: ${cl.name}  —  ${cl.shards} shard${cl.shards!==1?'s':''}, ${cl.replicas} host${cl.replicas!==1?'s':''}`}>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50">
                            <tr>{['Shard','Replica','Host Name','Host Address','Port','Local','User','Default DB','Errors','Recovery ETA'].map(h=>(
                              <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                            ))}</tr>
                          </thead>
                          <tbody>
                            {cl.hosts.map((h,hi)=>(
                              <tr key={hi} className={`border-t border-slate-100 hover:bg-yellow-50 ${Number(h.errors_count)>0?'bg-red-50':''}`}>
                                <td className="px-3 py-2.5 font-mono text-xs font-bold text-slate-700">{h.shard_num}</td>
                                <td className="px-3 py-2.5 font-mono text-xs">{h.replica_num}</td>
                                <td className="px-3 py-2.5 font-semibold text-amber-700 text-xs">{h.host_name}</td>
                                <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{h.host_address}</td>
                                <td className="px-3 py-2.5 font-mono text-xs">{h.port}</td>
                                <td className="px-3 py-2.5 text-center">
                                  {h.is_local ? <span className="px-1.5 py-0.5 bg-green-100 text-green-700 text-[10px] font-bold rounded-full">LOCAL</span>
                                              : <span className="text-slate-300 text-[10px]">—</span>}
                                </td>
                                <td className="px-3 py-2.5 text-xs text-slate-500">{h.user||'—'}</td>
                                <td className="px-3 py-2.5 text-xs text-slate-500">{h.default_database||'—'}</td>
                                <td className={`px-3 py-2.5 font-mono text-xs font-bold ${Number(h.errors_count)>0?'text-red-600':'text-green-600'}`}>{h.errors_count??0}</td>
                                <td className="px-3 py-2.5 font-mono text-xs text-slate-400">{Number(h.estimated_recovery_time)>0?`${h.estimated_recovery_time}s`:'—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Panel>
                  ))}
                </>
              );
            })()}
          </div>
        )}

        {/* ══ DATABASES ══ */}
        {tab==='databases' && (
          <div className="space-y-5">
            {dbLoad ? <TabLoader/> : (()=>{
              const dbs = dbData?.databases || databases;
              const SYS_DBS = new Set(['system','INFORMATION_SCHEMA','information_schema','_temporary_and_external_tables']);
              const userDbs = dbs.filter(d => !SYS_DBS.has(d.name));
              const sysDbs  = dbs.filter(d =>  SYS_DBS.has(d.name));
              const totalBytes = dbs.reduce((s,d)=>s+(Number(d.total_bytes)||0),0);
              const totalTables = dbs.reduce((s,d)=>s+(Number(d.table_count)||0),0);
              const totalRows   = dbs.reduce((s,d)=>s+(Number(d.total_rows)||0),0);
              const chartData   = [...dbs].sort((a,b)=>(b.total_bytes||0)-(a.total_bytes||0)).filter(d=>d.total_bytes>0).slice(0,8);

              const DbTable = ({rows, title}) => (
                <Panel title={`${title} (${rows.length})`}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50">
                        <tr>{['Name','Engine','Tables','Total Rows','Total Size','Data Path'].map(h=>(
                          <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {rows.map((d,i)=>{
                          const isEmpty = !d.table_count;
                          return (
                            <tr key={i} className={`border-t border-slate-100 hover:bg-yellow-50 ${isEmpty?'opacity-60':''}`}>
                              <td className="px-3 py-2.5">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-amber-700">{d.name||d.database}</span>
                                  {isEmpty && <span className="px-1.5 py-0.5 bg-slate-100 text-slate-400 text-[9px] font-bold rounded-full">EMPTY</span>}
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
                                <span className="px-2 py-0.5 bg-yellow-100 text-yellow-800 text-[10px] font-bold rounded-full">{d.engine||'Atomic'}</span>
                              </td>
                              <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(d.table_count||0)}</td>
                              <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(d.total_rows||0)}</td>
                              <td className="px-3 py-2.5 font-mono text-xs font-semibold">{d.size_pretty||fmtBytes(d.total_bytes||0)}</td>
                              <td className="px-3 py-2.5 font-mono text-[10px] text-slate-400 max-w-[220px] truncate">{d.data_path||'—'}</td>
                            </tr>
                          );
                        })}
                        {rows.length===0 && (
                          <tr><td colSpan={6} className="text-center py-8 text-slate-400 text-xs">No databases found</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              );

              return (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <MKpi title="Total Databases" value={dbs.length}          accent="blue" />
                    <MKpi title="Total Size"      value={fmtBytes(totalBytes)} accent="yellow" />
                    <MKpi title="Total Tables"    value={fmtNum(totalTables)}  accent="teal" />
                    <MKpi title="Total Rows"      value={fmtNum(totalRows)}    accent="amber" />
                  </div>

                  {chartData.length>0 ? (
                    <ChartCard title="Database Size Comparison (non-empty)">
                      <ResponsiveContainer width="100%" height={Math.max(180, chartData.length*36)}>
                        <BarChart layout="vertical" data={chartData.map(d=>({
                          name:d.name||'—', bytes:d.total_bytes||0, tables:d.table_count||0,
                        }))}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                          <XAxis type="number" tick={{fontSize:9}} tickFormatter={fmtBytes} axisLine={false} tickLine={false} />
                          <YAxis width={110} type="category" dataKey="name" tick={{fontSize:10}} axisLine={false} tickLine={false} />
                          <Tooltip formatter={(v,n)=>n==='bytes'?fmtBytes(v):fmtNum(v)} cursor={{fill:'#fefce8'}} />
                          <Bar dataKey="bytes" radius={[0,5,5,0]}>
                            {chartData.map((_,i)=><Cell key={i} fill={CC[i%CC.length]}/>)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </ChartCard>
                  ) : (
                    <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 text-sm text-blue-700">
                      <p className="font-bold mb-1">No user tables found in this ClickHouse instance.</p>
                      <p className="text-xs text-blue-600">
                        The connected user may only have access to the auth database (<strong>{userDbs.map(d=>d.name).join(', ')||'actmon'}</strong>) which has no tables yet.
                        Check the <strong>system</strong> databases below for internal ClickHouse tables.
                      </p>
                    </div>
                  )}

                  <DbTable rows={userDbs} title="User Databases" />
                  {sysDbs.length>0 && <DbTable rows={sysDbs} title="System Databases" />}
                </>
              );
            })()}
          </div>
        )}

        {/* ══ SETTINGS ══ */}
        {tab==='settings' && (
          <div className="space-y-4">
            {stLoad && !stData ? <TabLoader /> : (() => {
              const settings = stData?.settings || [];
              const changedCount = stData?.changed_count || 0;
              const changed = settings.filter(s => s.changed);
              const key     = settings.filter(s => !s.changed);
              const typeColor = t => {
                if (t === 'Bool')   return 'bg-blue-100 text-blue-700';
                if (t === 'UInt64') return 'bg-purple-100 text-purple-700';
                if (t === 'String') return 'bg-green-100 text-green-700';
                if (t === 'Float')  return 'bg-orange-100 text-orange-700';
                return 'bg-slate-100 text-slate-500';
              };
              const SettingsTable = ({ rows, title }) => (
                <Panel title={title} action={
                  <span className="text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full">{rows.length} setting{rows.length!==1?'s':''}</span>
                }>
                  {rows.length === 0 ? (
                    <p className="text-slate-400 text-sm text-center py-6">No settings to show</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50">
                          <tr>{['Name','Value','Type','Read-only','Description'].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                          ))}</tr>
                        </thead>
                        <tbody>
                          {rows.map((s, i) => (
                            <tr key={i} className={`border-t border-slate-100 hover:bg-slate-50 ${s.changed ? 'bg-amber-50/40' : ''}`}>
                              <td className="px-3 py-2 font-mono text-slate-700 font-semibold max-w-[260px] truncate" title={s.name}>{s.name}</td>
                              <td className="px-3 py-2 font-mono text-slate-900 font-bold">{String(s.value)}</td>
                              <td className="px-3 py-2">
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${typeColor(s.type)}`}>{s.type || '—'}</span>
                              </td>
                              <td className="px-3 py-2 text-center">
                                {s.readonly ? <span className="text-amber-500 font-bold text-[10px]">R/O</span> : <span className="text-slate-300 text-[10px]">—</span>}
                              </td>
                              <td className="px-3 py-2 text-slate-400 max-w-[300px] truncate text-[10px]" title={s.description}>{s.description || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>
              );
              return (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <KpiCard icon={Clipboard} title="Modified Settings" value={changedCount} accent={changedCount > 5 ? 'orange' : 'yellow'} />
                    <KpiCard icon={ClipboardCheck} title="Key Settings" value={key.length} accent="teal" />
                    <KpiCard icon={Activity} title="Total Shown" value={settings.length} accent="slate" />
                  </div>
                  {changed.length > 0 && <SettingsTable rows={changed} title="⚡ Modified Settings (changed=1)" />}
                  <SettingsTable rows={key} title="Key Settings (defaults)" />
                  <div className="flex justify-end">
                    <button onClick={() => refetchSettings()}
                      className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-all">
                      <RefreshCw size={12} className={stLoad ? 'animate-spin' : ''} /> Refresh
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {/* ══ SYSTEM METRICS ══ */}
        {tab==='sysmetrics' && (
          <div className="space-y-4">
            {smLoad && !smData ? <TabLoader /> : (() => {
              const metrics    = smData?.metrics    || [];
              const asyncMet   = smData?.async_metrics || [];
              const events     = smData?.events     || [];

              const MetricTable = ({ rows, title, keyCol, valCol, descCol }) => (
                <Panel title={title} action={
                  <span className="text-[10px] font-bold bg-yellow-50 text-yellow-700 border border-yellow-200 px-2 py-0.5 rounded-full">{rows.length} entries</span>
                }>
                  {rows.length === 0 ? (
                    <p className="text-slate-400 text-sm text-center py-6">No data</p>
                  ) : (
                    <div className="overflow-x-auto max-h-80 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 sticky top-0">
                          <tr>
                            <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase">Metric</th>
                            <th className="px-3 py-2 text-right text-[10px] font-bold text-slate-400 uppercase">Value</th>
                            {descCol && <th className="px-3 py-2 text-left text-[10px] font-bold text-slate-400 uppercase hidden md:table-cell">Description</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr key={i} className="border-t border-slate-100 hover:bg-yellow-50/30">
                              <td className="px-3 py-1.5 font-mono text-slate-700 text-[11px]">{r[keyCol] || r.metric || r.event}</td>
                              <td className="px-3 py-1.5 font-mono font-bold text-slate-900 text-right">{fmtNum(r[valCol] ?? r.value)}</td>
                              {descCol && <td className="px-3 py-1.5 text-slate-400 text-[10px] hidden md:table-cell max-w-[280px] truncate">{r[descCol] || '—'}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>
              );
              return (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {[
                      { label:'Metrics (live)',      val: metrics.length,  accent:'yellow' },
                      { label:'Async Metrics',        val: asyncMet.length, accent:'amber'  },
                      { label:'Cumulative Events',    val: events.length,   accent:'orange' },
                    ].map(k => <KpiCard key={k.label} icon={Activity} title={k.label} value={k.val} accent={k.accent} />)}
                  </div>
                  <MetricTable rows={metrics}  title="system.metrics (current state)" keyCol="metric" valCol="value" descCol="description" />
                  <MetricTable rows={asyncMet} title="system.asynchronous_metrics (memory, disk, CPU)" keyCol="metric" valCol="value" descCol={null} />
                  <MetricTable rows={events}   title="system.events (cumulative counts)" keyCol="event" valCol="value" descCol="description" />
                </>
              );
            })()}
          </div>
        )}

        {/* ══ SLOW QUERIES ══ */}
        {tab==='slowqueries' && (
          <div className="space-y-5">
            {sqLoad ? <TabLoader/> : (()=>{
              const all = sqData?.queries || [];
              const users  = [...new Set(all.map(q=>q.user).filter(Boolean))];
              const filt   = all.filter(q=>
                Number(q.query_duration_ms)>=sqThresh &&
                (!sqUser || q.user===sqUser)
              );
              const maxMs   = Math.max(...filt.map(q=>Number(q.query_duration_ms)||0), 1);
              const avgMs   = filt.length ? Math.round(filt.reduce((s,q)=>s+Number(q.query_duration_ms||0),0)/filt.length) : 0;
              return (
                <>
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="flex items-center gap-2">
                      <label className="text-xs font-semibold text-slate-500">Min elapsed (ms):</label>
                      <input type="number" value={sqThresh} onChange={e=>setSqThresh(Number(e.target.value)||500)}
                        className="h-9 w-28 px-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-amber-400" min={0} />
                    </div>
                    <select value={sqUser} onChange={e=>setSqUser(e.target.value)}
                      className="h-9 px-3 rounded-xl border border-slate-200 text-sm outline-none bg-white focus:border-amber-400">
                      <option value="">All Users</option>
                      {users.map(u=><option key={u} value={u}>{u}</option>)}
                    </select>
                    <span className="text-xs text-slate-400">{filt.length} queries (last 24h)</span>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <MKpi title="Slow Queries"  value={filt.length} accent={filt.length>10?'red':filt.length>0?'orange':'green'} />
                    <MKpi title="Avg Elapsed"   value={filt.length?`${avgMs}ms`:'—'} accent="yellow" />
                    <MKpi title="Max Elapsed"   value={filt.length?`${Math.round(maxMs)}ms`:'—'} accent="orange" />
                    <MKpi title="Threshold"     value={`≥${sqThresh}ms`} accent="slate" />
                  </div>

                  {filt.length>0 && (
                    <ChartCard title="Elapsed Distribution (top 20)">
                      <ResponsiveContainer width="100%" height={160}>
                        <BarChart data={filt.slice(0,20).map((q,i)=>({name:`#${i+1}`,ms:Number(q.query_duration_ms)||0}))}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                          <XAxis dataKey="name" tick={{fontSize:9}} axisLine={false} tickLine={false} />
                          <YAxis tick={{fontSize:9}} tickFormatter={v=>`${v}ms`} axisLine={false} tickLine={false} />
                          <Tooltip formatter={v=>`${v}ms`} cursor={{fill:'#fefce8'}} />
                          <Bar dataKey="ms" radius={[5,5,0,0]}>
                            {filt.slice(0,20).map((q,i)=>(
                              <Cell key={i} fill={Number(q.query_duration_ms)>5000?C.chRed:Number(q.query_duration_ms)>1000?C.orange:C.amber} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </ChartCard>
                  )}

                  <Panel title={`Slow Queries (${filt.length})`}>
                    {filt.length===0 ? (
                      <div className="text-center py-12">
                        <CheckCircle2 className="mx-auto text-green-400 mb-3" size={40}/>
                        <p className="text-slate-500 font-semibold">No slow queries above threshold</p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50">
                            <tr>
                              {['','Time','User','Elapsed ms','Read Rows','Read Bytes','Memory','Query Preview'].map(h=>(
                                <th key={h} className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase whitespace-nowrap">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {filt.map((q,i)=>{
                              const rKey=q.query_id||`sq${i}`;
                              const isExp=expandedRows[`sq-${rKey}`];
                              const elMs=Number(q.query_duration_ms);
                              return (
                                <React.Fragment key={i}>
                                  <tr className={`border-t border-slate-100 hover:bg-yellow-50 ${q.exception?'bg-red-50':''}`}>
                                    <td className="px-2 py-2">
                                      <button onClick={()=>toggleRow(`sq-${rKey}`)} className="text-slate-300 hover:text-amber-500">
                                        {isExp?<ChevronUp size={14}/>:<ChevronDown size={14}/>}
                                      </button>
                                    </td>
                                    <td className="px-3 py-2.5 text-[10px] text-slate-400 whitespace-nowrap">{String(q.event_time||'').slice(0,19)}</td>
                                    <td className="px-3 py-2.5 font-semibold text-amber-700 text-xs">{q.user||'—'}</td>
                                    <td className={`px-3 py-2.5 font-mono font-bold text-xs ${elMs>5000?'text-red-600':elMs>1000?'text-orange-500':'text-amber-600'}`}>
                                      {fmtNum(q.query_duration_ms)}
                                    </td>
                                    <td className="px-3 py-2.5 font-mono text-xs">{fmtNum(q.read_rows||0)}</td>
                                    <td className="px-3 py-2.5 font-mono text-xs">{fmtBytes(q.read_bytes||0)}</td>
                                    <td className="px-3 py-2.5 font-mono text-xs">{fmtBytes(q.memory_usage||0)}</td>
                                    <td className="px-3 py-2.5 font-mono text-[10px] text-slate-500 max-w-[260px] truncate">{String(q.query||'—').slice(0,110)}</td>
                                  </tr>
                                  {isExp && (
                                    <tr className="bg-amber-50 border-t border-amber-100">
                                      <td colSpan={8} className="px-4 py-3">
                                        <div className="flex items-start gap-3">
                                          <div className="flex-1 space-y-2">
                                            <pre className="font-mono text-xs text-slate-700 whitespace-pre-wrap break-all bg-white border border-slate-200 rounded-xl p-3 max-h-44 overflow-y-auto">
                                              {q.query||'(no query text)'}
                                            </pre>
                                            {q.exception && (
                                              <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                                                <p className="text-[10px] font-bold text-red-700 uppercase mb-1">Exception</p>
                                                <p className="font-mono text-xs text-red-600 whitespace-pre-wrap">{q.exception}</p>
                                              </div>
                                            )}
                                            <div className="grid grid-cols-3 gap-3 text-xs">
                                              {q.databases && <div><p className="text-[10px] text-slate-400 font-bold uppercase">Databases</p><p className="font-mono">{String(q.databases)}</p></div>}
                                              {q.tables    && <div><p className="text-[10px] text-slate-400 font-bold uppercase">Tables</p><p className="font-mono">{String(q.tables)}</p></div>}
                                              <div><p className="text-[10px] text-slate-400 font-bold uppercase">Result Rows</p><p className="font-mono">{fmtNum(q.result_rows||0)}</p></div>
                                            </div>
                                          </div>
                                          <button onClick={()=>copyText(q.query||'',`sq-${rKey}`)}
                                            className="flex items-center gap-1 px-2 py-1 bg-amber-100 text-amber-700 rounded-lg text-[10px] font-bold hover:bg-amber-200 flex-shrink-0 mt-1">
                                            {copied===`sq-${rKey}` ? <><ClipboardCheck size={12}/> Copied</> : <><Clipboard size={12}/> Copy SQL</>}
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </React.Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Panel>
                </>
              );
            })()}
          </div>
        )}

      </div>
    </div>
  );
}

/* ─── Helpers ─── */
function fmtBytes(b) {
  const n=Number(b)||0;
  if (n>=1<<30) return `${(n/(1<<30)).toFixed(2)} GB`;
  if (n>=1<<20) return `${(n/(1<<20)).toFixed(2)} MB`;
  if (n>=1<<10) return `${(n/(1<<10)).toFixed(2)} KB`;
  return `${n} B`;
}
function fmtNum(n) {
  const v=Number(n)||0;
  if (v>=1e9) return `${(v/1e9).toFixed(1)}B`;
  if (v>=1e6) return `${(v/1e6).toFixed(1)}M`;
  if (v>=1e3) return `${(v/1e3).toFixed(1)}K`;
  return String(v);
}

/* ─── Components ─── */
function KpiCard({icon:Icon,title,value,accent}) {
  const bdr={yellow:'border-l-yellow-400',amber:'border-l-amber-500',green:'border-l-green-500',blue:'border-l-blue-500',teal:'border-l-teal-500',orange:'border-l-orange-500',red:'border-l-red-500',slate:'border-l-slate-400'};
  return (
    <div className={`bg-white rounded-xl border border-slate-200 border-l-4 ${bdr[accent]||bdr.slate} p-4 hover:shadow-md transition-all`}>
      <div className="flex justify-between items-start">
        <div><p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">{title}</p><p className="text-lg font-black text-slate-800 mt-1">{value??'N/A'}</p></div>
        <Icon size={20} className="text-slate-300 mt-0.5"/>
      </div>
    </div>
  );
}
function MKpi({title,value,accent}) {
  const cls={yellow:'bg-yellow-50 border-yellow-200 text-yellow-800',amber:'bg-amber-50 border-amber-200 text-amber-800',green:'bg-green-50 border-green-200 text-green-700',red:'bg-red-50 border-red-200 text-red-700',orange:'bg-orange-50 border-orange-200 text-orange-700',blue:'bg-blue-50 border-blue-200 text-blue-700',teal:'bg-teal-50 border-teal-200 text-teal-700',slate:'bg-slate-50 border-slate-200 text-slate-700'};
  return (
    <div className={`rounded-xl border p-4 ${cls[accent]||cls.slate}`}>
      <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">{title}</p>
      <p className="text-2xl font-black mt-1">{value??'—'}</p>
    </div>
  );
}
function SBadge({ok,label}) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${ok?'bg-green-100 text-green-700':'bg-red-100 text-red-700'}`}>
      {ok?<CheckCircle2 size={11}/>:<AlertTriangle size={11}/>}{label}
    </span>
  );
}
function Panel({title,children}) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      {title && <h3 className="font-bold text-slate-800 text-sm mb-4">{title}</h3>}
      {children}
    </div>
  );
}
function ChartCard({title,children}) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <h3 className="font-bold text-slate-700 text-sm mb-4">{title}</h3>
      {children}
    </div>
  );
}
function Row({label,value,mono}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-slate-500 text-xs flex-shrink-0">{label}</span>
      <span className={`text-right font-semibold text-slate-800 text-xs break-all ${mono?'font-mono':''}`}>{value}</span>
    </div>
  );
}
function ActionCard({icon,title,desc,onClick}) {
  return (
    <button onClick={onClick} className="bg-white rounded-2xl border border-slate-200 p-5 text-left hover:shadow-md hover:border-amber-200 transition-all group">
      <div className="mb-3">{icon}</div>
      <p className="font-bold text-slate-900 text-sm">{title}</p>
      <p className="text-xs text-slate-400 mt-1">{desc}</p>
      <ChevronRight size={14} className="text-slate-200 group-hover:text-amber-400 mt-3 transition-colors"/>
    </button>
  );
}
function Gauge({title,pct,sub,center,unit='%',colorFn}) {
  const safe=Math.max(0,Math.min(100,pct||0));
  const fill=colorFn?colorFn(safe):(safe>80?C.red:safe>60?C.orange:C.yellow);
  const disp=center!==undefined?center:safe;
  const u=center!==undefined?unit:'%';
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col items-center">
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 text-center">{title}</p>
      <div className="relative flex flex-col items-center">
        <PieChart width={150} height={90}>
          <Pie data={[{v:safe},{v:100-safe}]} cx={75} cy={86} startAngle={180} endAngle={0} innerRadius={50} outerRadius={68} dataKey="v" stroke="none">
            <Cell fill={fill}/><Cell fill="#e2e8f0"/>
          </Pie>
        </PieChart>
        <div style={{marginTop:'-38px'}} className="text-center pointer-events-none">
          <p className="text-xl font-black text-slate-900 leading-none">{disp}</p>
          <p className="text-[10px] text-slate-400 mt-0.5">{u}</p>
        </div>
      </div>
      <p className="text-[10px] text-slate-400 mt-2 text-center leading-tight">{sub}</p>
    </div>
  );
}
function Trend({title,data,color,unit='',fmtVal}) {
  const fmt=fmtVal||(v=>`${v}${unit}`);
  const latest=data[data.length-1]?.v;
  const gid=`tg-${title.replace(/\s+/g,'-')}`;
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex justify-between items-center mb-2">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{title}</p>
        <span className="text-base font-black" style={{color}}>{fmt(latest)}</span>
      </div>
      <ResponsiveContainer width="100%" height={68}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.25}/>
              <stop offset="95%" stopColor={color} stopOpacity={0}/>
            </linearGradient>
          </defs>
          <XAxis dataKey="t" hide/>
          <YAxis hide domain={['auto','auto']}/>
          <Tooltip contentStyle={{fontSize:9,padding:'2px 8px'}} formatter={v=>fmt(v)} labelFormatter={()=>''}/>
          <Area type="monotone" dataKey="v" stroke={color} fill={`url(#${gid})`} strokeWidth={2} dot={false}/>
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex justify-between text-[9px] text-slate-300 mt-1">
        <span>{fmt(data[0]?.v)}</span>
        <span className="text-slate-400">{data.length} samples · 15s</span>
      </div>
    </div>
  );
}
function TabLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="animate-spin text-amber-500" size={32}/>
    </div>
  );
}
