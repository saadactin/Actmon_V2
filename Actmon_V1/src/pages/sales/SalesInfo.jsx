import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronRight, Info, Sparkles, Database, Server, Cloud, HardDrive, Brain, Bell, ShieldCheck,
  Gauge, Clock, TrendingDown, Lock, Zap,
} from 'lucide-react';

function Shell({ title, subtitle, icon: Icon, children }) {
  const navigate = useNavigate();
  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f4f9]">
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 md:px-8 pt-3 pb-6 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
        <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5">
          <span>ActMon</span><ChevronRight size={11} />
          <button onClick={() => navigate('/sales')} className="hover:text-slate-200">Sales</button>
          <ChevronRight size={11} /><span className="text-white font-semibold">{title}</span>
        </div>
        <div className="relative flex items-center gap-3">
          <button onClick={() => navigate('/sales')} className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 flex items-center justify-center text-white flex-shrink-0"><ChevronRight size={16} className="rotate-180" /></button>
          <div className="w-9 h-9 rounded-lg bg-sky-400/20 border border-sky-400/40 flex items-center justify-center flex-shrink-0"><Icon size={18} className="text-sky-200" /></div>
          <div>
            <h1 className="text-lg font-black text-white tracking-tight leading-none">{title}</h1>
            <p className="text-sky-200/70 text-[11px] mt-0.5">{subtitle}</p>
          </div>
        </div>
      </div>
      <div className="px-6 md:px-8 py-6 max-w-[1100px] mx-auto space-y-5">{children}</div>
      <div className="px-6 md:px-8 pb-8 max-w-[1100px] mx-auto">
        <button onClick={() => navigate('/sales/register')} className="h-11 px-6 rounded-xl bg-blue-600 text-white font-bold text-sm hover:bg-blue-700 shadow flex items-center gap-2">
          Register an Organization <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

const Card = ({ icon: Icon, title, desc, accent }) => (
  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex items-start gap-3.5">
    <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${accent} flex items-center justify-center text-white shadow flex-shrink-0`}><Icon size={20} /></div>
    <div><h3 className="font-black text-slate-800 text-[15px]">{title}</h3><p className="text-[13px] text-slate-500 mt-0.5 leading-relaxed">{desc}</p></div>
  </div>
);

export function SalesAbout() {
  return (
    <Shell title="ActMon Information" subtitle="Enterprise database, cloud & infrastructure observability" icon={Info}>
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <h2 className="text-xl font-black text-slate-800">ActMon — one platform for your entire data estate</h2>
        <p className="text-[14px] text-slate-600 mt-2 leading-relaxed">
          ActMon by Actin Technologies is a unified monitoring platform for databases, servers, and cloud. A lightweight agent
          (or agentless SSH) collects live metrics, slow queries, errors and host telemetry — surfaced through real-time dashboards,
          historical logs, alerts, and an AI assistant. Deploy on-prem or in the cloud; monitor everything from a single pane.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card icon={Database} accent="from-blue-500 to-sky-600" title="Every major database" desc="MySQL / MariaDB, PostgreSQL, Oracle, SQL Server, MongoDB & ClickHouse — dashboards, slow SQL, index & error analysis." />
        <Card icon={Server} accent="from-violet-500 to-purple-600" title="Lightweight agents" desc="Push-mode agents collect DB internals & host metrics every few seconds; auto-enroll, self-update, self-heal." />
        <Card icon={HardDrive} accent="from-emerald-500 to-teal-600" title="Infrastructure" desc="Host CPU / memory / disk / uptime, service control, file explorer & terminal — over agent or SSH." />
        <Card icon={Cloud} accent="from-cyan-500 to-blue-600" title="Cloud discovery" desc="Accounts, resources, cost, security, topology & compliance across your cloud providers." />
        <Card icon={Brain} accent="from-indigo-500 to-violet-600" title="ActMon AI" desc="Natural-language assistant: ask questions, generate SQL, and navigate to any screen instantly." />
        <Card icon={Bell} accent="from-amber-500 to-orange-600" title="Alerts & logs" desc="Threshold alerts, forensic logs, spikes, and per-category log reports with PDF / CSV export." />
      </div>
    </Shell>
  );
}

export function SalesBenefits() {
  return (
    <Shell title="Benefits of ActMon" subtitle="Why teams choose ActMon" icon={Sparkles}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card icon={Gauge} accent="from-blue-500 to-sky-600" title="Proactive, not reactive" desc="Catch slow queries, lock waits, low cache-hit and capacity risks before they become outages." />
        <Card icon={Clock} accent="from-emerald-500 to-teal-600" title="Faster incident resolution" desc="Live metrics + historical spikes + the exact heavy SQL, side by side — cut MTTR dramatically." />
        <Card icon={TrendingDown} accent="from-violet-500 to-purple-600" title="Lower cost of ownership" desc="One platform across all engines & clouds replaces several point tools; agents are lightweight." />
        <Card icon={Lock} accent="from-amber-500 to-orange-600" title="Security & compliance" desc="Full RBAC, audit trail, login & session history, and per-role page permissions out of the box." />
        <Card icon={Zap} accent="from-rose-500 to-pink-600" title="Fast to deploy" desc="Tailor modules & pages per client and generate a ready-to-run installer in minutes." />
        <Card icon={ShieldCheck} accent="from-cyan-500 to-blue-600" title="Enterprise-ready" desc="Multi-tenant (per-organization), self-healing agents, and a clear upgrade path." />
      </div>
    </Shell>
  );
}
