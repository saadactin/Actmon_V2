import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Shield, Database, Server, Activity, Bell, Sparkles,
  Download, ChevronRight, Check, Lock, Gauge, Terminal,
  ArrowRight, HardDrive,
} from 'lucide-react';

const YEAR = 2026;
const DBS = ['MySQL', 'PostgreSQL', 'Oracle', 'SQL Server', 'MongoDB', 'ClickHouse'];

const FEATURES = [
  { icon: Database, color: '#2563eb', title: 'Multi-Database Monitoring', desc: 'MySQL, PostgreSQL, Oracle, SQL Server, MongoDB and ClickHouse - one console, live metrics, slow queries, locks, replication.' },
  { icon: Server, color: '#0891b2', title: 'Infrastructure & Hosts', desc: 'CPU, memory, disk, network, processes and services for every Windows and Linux server via a lightweight agent or SSH.' },
  { icon: Activity, color: '#16a34a', title: 'Real-time Dashboards', desc: 'Azure-Monitor-style tiles, trends and topology that refresh continuously - see health at a glance, drill in on demand.' },
  { icon: Bell, color: '#d97706', title: 'Smart Alerts', desc: 'Threshold and anomaly alerts on connections, cache hit ratio, deadlocks, disk and more - before they become incidents.' },
  { icon: Sparkles, color: '#7c3aed', title: 'AI Analysis', desc: 'Built-in AI explains slow queries, suggests indexes and summarizes what changed - turning telemetry into action.' },
  { icon: Lock, color: '#dc2626', title: 'Role-Based Access', desc: 'Fine-grained page-and-action permissions, multi-tenant organizations, audit logging and secure OTP sign-in.' },
];

const STATS = [
  { v: '6+', l: 'Database engines' },
  { v: '24/7', l: 'Live collection' },
  { v: '1', l: 'Unified console' },
  { v: '100%', l: 'Agent or SSH' },
];

export default function LandingPage() {
  const navigate = useNavigate();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const msiUrl = `${origin}/api/v1/agents/download/actmon.msi?url=${encodeURIComponent(origin)}`;

  return (
    <div className="min-h-screen bg-white text-slate-800">
      {/* ── NAV ── */}
      <header className="sticky top-0 z-40 bg-white/90 backdrop-blur border-b border-slate-100">
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-600 to-blue-500 flex items-center justify-center shadow-md">
              <Shield size={19} className="text-white" />
            </div>
            <div className="leading-tight">
              <p className="font-black text-slate-900 text-[17px] tracking-tight">ActMon</p>
              <p className="text-[10px] text-slate-400 font-semibold -mt-0.5">by Actin Technologies</p>
            </div>
          </div>
          <nav className="hidden md:flex items-center gap-7 text-[14px] font-semibold text-slate-600">
            <a href="#features" className="hover:text-indigo-600 transition-colors">Features</a>
            <a href="#databases" className="hover:text-indigo-600 transition-colors">Databases</a>
            <a href="#download" className="hover:text-indigo-600 transition-colors">Download</a>
          </nav>
          <div className="flex items-center gap-2.5">
            <button onClick={() => navigate('/login')}
              className="h-9 px-4 rounded-lg text-[14px] font-bold text-slate-700 hover:bg-slate-100 transition-colors">
              Log in
            </button>
            <button onClick={() => navigate('/login')}
              className="h-9 px-4 rounded-lg text-[14px] font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-sm transition-all">
              Sign up
            </button>
          </div>
        </div>
      </header>

      {/* ── HERO ── */}
      <section className="relative overflow-hidden bg-gradient-to-b from-slate-900 via-slate-900 to-slate-800 text-white">
        <div className="absolute inset-0 opacity-[0.06]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '32px 32px' }} />
        <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-indigo-600/30 blur-3xl" />
        <div className="absolute -bottom-32 -left-24 w-96 h-96 rounded-full bg-cyan-500/20 blur-3xl" />

        <div className="relative max-w-6xl mx-auto px-5 pt-16 pb-20 grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 border border-white/15 text-[12px] font-semibold text-cyan-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Enterprise database & infrastructure monitoring
            </span>
            <h1 className="mt-5 text-4xl sm:text-5xl font-black leading-[1.08] tracking-tight">
              Monitor every database<br />and server, in <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-indigo-300">real time</span>.
            </h1>
            <p className="mt-5 text-slate-300 text-[16px] leading-relaxed max-w-lg">
              ActMon unifies MySQL, PostgreSQL, Oracle, SQL Server, MongoDB, ClickHouse and your servers into one live console - with smart alerts, AI insights and role-based access.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <button onClick={() => navigate('/login')}
                className="h-12 px-6 rounded-xl bg-white text-slate-900 font-bold hover:bg-slate-100 transition-all flex items-center gap-2 shadow-lg">
                Get started <ArrowRight size={17} />
              </button>
              <a href="#download"
                className="h-12 px-6 rounded-xl bg-white/10 border border-white/20 text-white font-bold hover:bg-white/15 transition-all flex items-center gap-2">
                <Download size={17} /> Download for Windows
              </a>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-slate-400">
              {['Agent or SSH', 'One-command install', 'No per-host license'].map((t) => (
                <span key={t} className="flex items-center gap-1.5"><Check size={14} className="text-emerald-400" /> {t}</span>
              ))}
            </div>
          </div>

          {/* dashboard mockup */}
          <HeroMockup />
        </div>
      </section>

      {/* ── STATS ── */}
      <section className="border-b border-slate-100 bg-slate-50">
        <div className="max-w-6xl mx-auto px-5 py-8 grid grid-cols-2 sm:grid-cols-4 gap-6">
          {STATS.map((s) => (
            <div key={s.l} className="text-center">
              <p className="text-3xl font-black text-slate-900">{s.v}</p>
              <p className="text-[13px] text-slate-500 font-medium mt-1">{s.l}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section id="features" className="max-w-6xl mx-auto px-5 py-20">
        <div className="text-center max-w-2xl mx-auto">
          <p className="text-indigo-600 font-black text-[13px] uppercase tracking-wider">Everything in one place</p>
          <h2 className="mt-2 text-3xl font-black text-slate-900 tracking-tight">Built for the whole stack</h2>
          <p className="mt-3 text-slate-500 text-[15px]">From a single slow query to an entire fleet of servers - ActMon watches it all.</p>
        </div>
        <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {FEATURES.map((f) => (
            <div key={f.title} className="group bg-white rounded-2xl border border-slate-200 p-6 hover:shadow-xl hover:-translate-y-1 transition-all">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4" style={{ background: `${f.color}15`, color: f.color }}>
                <f.icon size={24} />
              </div>
              <h3 className="font-black text-slate-900 text-[16px]">{f.title}</h3>
              <p className="mt-2 text-slate-500 text-[14px] leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── DATABASES ── */}
      <section id="databases" className="bg-slate-50 border-y border-slate-100">
        <div className="max-w-6xl mx-auto px-5 py-16 text-center">
          <h2 className="text-2xl font-black text-slate-900">One console for every engine</h2>
          <p className="mt-2 text-slate-500 text-[15px]">Deep, engine-specific dashboards - not a lowest-common-denominator view.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {DBS.map((db) => (
              <span key={db} className="px-5 py-2.5 rounded-xl bg-white border border-slate-200 font-bold text-slate-700 text-[14px] shadow-sm flex items-center gap-2">
                <Database size={16} className="text-indigo-500" /> {db}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── DOWNLOAD ── */}
      <section id="download" className="max-w-6xl mx-auto px-5 py-20">
        <div className="text-center max-w-2xl mx-auto">
          <p className="text-indigo-600 font-black text-[13px] uppercase tracking-wider">Download</p>
          <h2 className="mt-2 text-3xl font-black text-slate-900 tracking-tight">Get the ActMon agent</h2>
          <p className="mt-3 text-slate-500 text-[15px]">Install the agent on each server you want to monitor. It self-registers, then streams live metrics to your ActMon console.</p>
        </div>

        <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-3 gap-5 max-w-4xl mx-auto">
          {/* Windows — available */}
          <div className="relative bg-white rounded-2xl border-2 border-indigo-200 p-6 shadow-lg sm:col-span-2 lg:col-span-1">
            <span className="absolute top-4 right-4 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[11px] font-black uppercase">Available</span>
            <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center mb-4">
              <WindowsGlyph />
            </div>
            <h3 className="font-black text-slate-900 text-[17px]">Windows</h3>
            <p className="text-slate-500 text-[13px] mt-1">Windows 10 / 11 &amp; Server 2016+</p>
            <ul className="mt-4 space-y-1.5 text-[13px] text-slate-600">
              <li className="flex items-center gap-2"><Check size={14} className="text-emerald-500" /> Signed MSI installer</li>
              <li className="flex items-center gap-2"><Check size={14} className="text-emerald-500" /> Runs as a Windows service</li>
              <li className="flex items-center gap-2"><Check size={14} className="text-emerald-500" /> Self-registers &amp; auto-updates</li>
            </ul>
            <a href={msiUrl}
              className="mt-6 h-11 w-full rounded-xl bg-indigo-600 text-white font-bold hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 shadow-sm">
              <Download size={17} /> Download .msi
            </a>
            <p className="mt-2 text-center text-[11px] text-slate-400">64-bit &middot; ~14 MB &middot; v1.0</p>
          </div>

          {/* Linux — coming soon */}
          <DownloadSoon os="Linux" note="Debian, Ubuntu, RHEL" icon={Terminal} />
          {/* macOS — coming soon */}
          <DownloadSoon os="macOS" note="Apple silicon & Intel" icon={HardDrive} />
        </div>

        <p className="mt-8 text-center text-[13px] text-slate-400">
          Prefer agentless? ActMon can also monitor hosts over <span className="font-semibold text-slate-500">SSH</span> - no install required.
        </p>
      </section>

      {/* ── CTA ── */}
      <section className="bg-gradient-to-r from-indigo-600 to-blue-600">
        <div className="max-w-6xl mx-auto px-5 py-14 flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="text-white">
            <h2 className="text-2xl font-black">Ready to see everything?</h2>
            <p className="text-indigo-100 mt-1 text-[15px]">Sign in to your ActMon console and start monitoring in minutes.</p>
          </div>
          <button onClick={() => navigate('/login')}
            className="h-12 px-7 rounded-xl bg-white text-indigo-700 font-black hover:bg-slate-100 transition-all flex items-center gap-2 shadow-lg flex-shrink-0">
            Log in <ChevronRight size={18} />
          </button>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="bg-slate-900 text-slate-400">
        <div className="max-w-6xl mx-auto px-5 py-10 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-600 to-blue-500 flex items-center justify-center">
              <Shield size={16} className="text-white" />
            </div>
            <div className="leading-tight">
              <p className="font-black text-white text-[15px]">ActMon</p>
              <p className="text-[11px] text-slate-500">by Actin Technologies</p>
            </div>
          </div>
          <div className="flex items-center gap-6 text-[13px] font-medium">
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <a href="#download" className="hover:text-white transition-colors">Download</a>
            <button onClick={() => navigate('/login')} className="hover:text-white transition-colors">Log in</button>
          </div>
          <p className="text-[12px] text-slate-500">&copy; {YEAR} Actin Technologies. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}

function DownloadSoon({ os, note, icon: Icon }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6 opacity-80">
      <span className="float-right px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[11px] font-black uppercase">Soon</span>
      <div className="w-12 h-12 rounded-xl bg-slate-50 flex items-center justify-center mb-4 text-slate-400"><Icon size={24} /></div>
      <h3 className="font-black text-slate-900 text-[17px]">{os}</h3>
      <p className="text-slate-500 text-[13px] mt-1">{note}</p>
      <button disabled className="mt-6 h-11 w-full rounded-xl bg-slate-100 text-slate-400 font-bold flex items-center justify-center gap-2 cursor-not-allowed">
        Coming soon
      </button>
    </div>
  );
}

/* Simple 4-pane Windows logo glyph (no external asset). */
function WindowsGlyph() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      {[[3, 3], [13, 3], [3, 13], [13, 13]].map(([x, y], i) => (
        <rect key={i} x={x} y={y} width="8" height="8" rx="1" fill="#2563eb" />
      ))}
    </svg>
  );
}

/* Lightweight, CSS-drawn dashboard mockup for the hero (no image dependency). */
function HeroMockup() {
  const bars = [42, 68, 55, 80, 61, 73, 90, 66, 78];
  return (
    <div className="relative">
      <div className="rounded-2xl bg-white shadow-2xl border border-white/20 overflow-hidden rotate-1 hover:rotate-0 transition-transform">
        <div className="h-9 bg-slate-100 flex items-center gap-1.5 px-3 border-b border-slate-200">
          <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
          <span className="ml-3 text-[11px] font-semibold text-slate-400">ActMon &middot; MySQL Dashboard</span>
        </div>
        <div className="p-4 bg-white">
          <div className="grid grid-cols-3 gap-2.5 mb-3">
            {[['QPS', '1.2k', 'text-blue-600'], ['Buffer Hit', '99.2%', 'text-emerald-600'], ['Conns', '148', 'text-indigo-600']].map(([l, v, c]) => (
              <div key={l} className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                <p className="text-[9px] font-bold uppercase text-slate-400">{l}</p>
                <p className={`text-[16px] font-black ${c}`}>{v}</p>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-slate-100 p-3">
            <p className="text-[10px] font-bold uppercase text-slate-400 mb-2">Throughput</p>
            <div className="flex items-end gap-1.5 h-20">
              {bars.map((h, i) => (
                <div key={i} className="flex-1 rounded-t bg-gradient-to-t from-indigo-500 to-cyan-400" style={{ height: `${h}%` }} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="absolute -bottom-4 -left-4 bg-white rounded-xl shadow-xl border border-slate-100 px-3.5 py-2.5 flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center"><Gauge size={16} className="text-emerald-600" /></div>
        <div>
          <p className="text-[10px] text-slate-400 font-bold uppercase leading-none">Health</p>
          <p className="text-[14px] font-black text-emerald-600 leading-tight">95 / 100</p>
        </div>
      </div>
    </div>
  );
}
