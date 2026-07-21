import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import {
  Activity,
  ArrowRight,
  Bell,
  Check,
  ChevronRight,
  Cloud,
  Cpu,
  Database,
  Download,
  FileSearch,
  FolderOpen,
  Gauge,
  Globe2,
  HardDrive,
  Layers,
  Lock,
  Menu,
  Network,
  Search,
  Server,
  Settings,
  Shield,
  Sparkles,
  Terminal,
} from 'lucide-react';
import heroArt from '../assets/hero.png';

const YEAR = 2026;

const FEATURES = [
  { icon: Database, color: '#2563eb', title: 'Database monitoring', desc: 'MySQL, PostgreSQL, Oracle, SQL Server, MongoDB and ClickHouse with engine-specific dashboards.' },
  { icon: Server, color: '#0891b2', title: 'Infrastructure visibility', desc: 'CPU, memory, disk, network, processes and services through SSH or the in-app agent workflow.' },
  { icon: Cloud, color: '#0f766e', title: 'Cloud discovery', desc: 'Accounts, resources, topology, cost, security posture and compliance in the same console.' },
  { icon: Bell, color: '#d97706', title: 'Smart alerts', desc: 'Rules and anomaly signals for database, host and cloud events before they become incidents.' },
  { icon: Sparkles, color: '#7c3aed', title: 'AI analysis', desc: 'Slow query explanation, index suggestions and incident summaries that turn telemetry into action.' },
  { icon: Lock, color: '#dc2626', title: 'Secure access', desc: 'Organizations, roles, page permissions, audit trails and OTP sign-in for controlled operations.' },
];

const STATS = [
  { value: '6+', label: 'Database engines' },
  { value: '24/7', label: 'Live collection' },
  { value: 'Cloud', label: 'Discovery ready' },
  { value: '1', label: 'Unified console' },
];

const MODULES = [
  {
    icon: Database,
    color: '#2563eb',
    title: 'Database Monitoring',
    desc: 'MySQL, PostgreSQL, Oracle, SQL Server, MongoDB and ClickHouse dashboards with slow queries, locks, waits and backups.',
  },
  {
    icon: Server,
    color: '#0891b2',
    title: 'Infrastructure Monitoring',
    desc: 'Host health, CPU, memory, disk, network, services, processes and file explorer for Windows and Linux environments.',
  },
  {
    icon: Globe2,
    color: '#059669',
    title: 'Webpage Monitoring',
    desc: 'Track URL uptime, response time, SSL status and endpoint health from the same ActMon command center.',
  },
  {
    icon: FileSearch,
    color: '#7c3aed',
    title: 'Configuration Finder',
    desc: 'Find nginx, Apache, database, service and application configuration files quickly across monitored hosts.',
  },
  {
    icon: Cloud,
    color: '#0f766e',
    title: 'Cloud Discovery',
    desc: 'Discover accounts, resources, topology, cost, security posture, compliance and cloud alerts in one workspace.',
  },
  {
    icon: Lock,
    color: '#dc2626',
    title: 'Administration & Access',
    desc: 'Organizations, users, roles, permissions, OTP sign-in and audit trails for controlled operations.',
  },
];

const NAV_ITEMS = [
  { href: '#features', label: 'Features', icon: Sparkles },
  { href: '#views', label: 'Live views', icon: Activity },
  { href: '#download', label: 'Download', icon: Download },
];

const SHOWCASES = [
  {
    title: 'Infrastructure monitoring',
    desc: 'Watch host health, CPU, memory, disk, network and services with live status movement.',
    icon: Server,
    tone: 'cyan',
    visual: 'infra',
  },
  {
    title: 'Database monitoring',
    desc: 'See query load, wait events, slow SQL and engine health for all supported databases.',
    icon: Database,
    tone: 'blue',
    visual: 'database',
  },
  {
    title: 'Webpage monitoring',
    desc: 'Track uptime, response time, SSL status and endpoint checks from one simple view.',
    icon: Globe2,
    tone: 'emerald',
    visual: 'web',
  },
  {
    title: 'Configuration file finder',
    desc: 'Quickly locate nginx, Apache, database, service and application config files on hosts.',
    icon: FileSearch,
    tone: 'violet',
    visual: 'config',
  },
];

export default function LandingPage() {
  const navigate = useNavigate();
  const { token } = useAuthStore();
  const [dl, setDl] = useState({ loading: true, version: '2026.1', builds: {} });

  useEffect(() => {
    let alive = true;
    fetch('/api/v1/download/actmon/status')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Download status unavailable'))))
      .then((data) => {
        if (!alive) return;
        setDl({ loading: false, version: data.version || '2026.1', builds: data.builds || {} });
      })
      .catch(() => { if (alive) setDl((s) => ({ ...s, loading: false })); });
    return () => { alive = false; };
  }, []);

  // Already signed in? The public site is not for authenticated users - send them
  // straight to the app.
  useEffect(() => {
    if (token) navigate('/dashboard', { replace: true });
  }, [token, navigate]);
  if (token) return null;

  return (
    <div className="min-h-screen bg-white text-slate-800 landing-page">
      <header className="sticky top-0 z-50 landing-header">
        <div className="w-full px-8 lg:px-12 xl:px-16 h-[76px] flex items-center justify-between">
          <button onClick={() => navigate('/')} className="landing-brand group" aria-label="ActMon home">
            <span className="landing-logo-mark">
              <Shield size={19} className="relative z-10 text-white" />
              <span className="landing-logo-pulse" />
            </span>
            <span className="leading-tight">
              <span className="block font-black text-slate-950 text-[20px] tracking-tight">ActMon</span>
              <span className="block text-[10px] text-slate-500 font-black uppercase tracking-[0.14em]">Actin Technologies</span>
            </span>
          </button>
          <nav className="hidden lg:flex items-center gap-1 landing-nav" aria-label="Primary navigation">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <a key={item.href} href={item.href} className="landing-nav-link">
                  <Icon size={15} />
                  <span>{item.label}</span>
                </a>
              );
            })}
          </nav>
          <div className="flex items-center gap-2.5">
            <button className="lg:hidden landing-icon-menu" aria-label="Open menu">
              <Menu size={18} />
            </button>
            <button
  onClick={() => navigate('/login')}
  className="hidden sm:inline-flex items-center justify-center h-10 px-4 rounded-lg text-[14px] font-black text-slate-700 hover:bg-slate-100 transition-colors"
>
  Log in
</button>
            <button onClick={() => navigate('/login')} className="landing-header-cta">
              Open console
            </button>
          </div>
        </div>
      </header>

      <section className="landing-hero-premium text-white">
        <div className="landing-hero-grid" />
        <div className="landing-hero-beam landing-hero-beam-one" />
        <div className="landing-hero-beam landing-hero-beam-two" />
        <div className="w-full px-8 lg:px-12 xl:px-16 py-16 lg:py-24 grid lg:grid-cols-[0.9fr_1.1fr] gap-12 items-center relative z-10">
          <div className="landing-hero-copy">
            <p className="landing-hero-badge">
              <Sparkles size={14} />
              Animated monitoring workspace
            </p>
            <h1 className="mt-5 text-5xl sm:text-6xl font-black leading-[1.02] tracking-tight">
              ActMon Monitoring center
            </h1>
            <p className="mt-4 text-xl sm:text-2xl font-bold text-slate-200 max-w-xl">
              Database, infrastructure, webpages and configuration files in one cinematic console.
            </p>
            <p className="mt-5 text-slate-300 text-[16px] leading-relaxed max-w-xl">
              Give clients a polished product experience first, then let operators drill into live hosts, query health, URL checks and file discovery after login.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="#download" className="landing-primary-action">
                <Download size={17} /> Download application
              </a>
              <button onClick={() => navigate('/login')} className="landing-secondary-action">
                Open console <ArrowRight size={17} />
              </button>
            </div>
            <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-4">
              {STATS.map((stat) => (
                <div key={stat.label}>
                  <p className="text-2xl font-black text-white">{stat.value}</p>
                  <p className="text-[12px] text-slate-400 mt-1">{stat.label}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="relative min-h-[560px]">
            <img src={heroArt} alt="" className="absolute -top-6 right-2 w-28 opacity-70 hidden sm:block" />
            <ProductStage />
          </div>
        </div>
      </section>

      <section id="features" className="w-full px-8 lg:px-12 xl:px-16 py-18 sm:py-20 landing-anchor-section">
        <div className="max-w-2xl">
          <p className="text-indigo-600 font-black text-[13px] uppercase tracking-wider">Platform</p>
          <h2 className="mt-2 text-3xl font-black text-slate-900 tracking-tight">Simple outside, serious inside</h2>
          <p className="mt-3 text-slate-500 text-[15px]">ActMon keeps the public experience direct, then gives operators the depth they need after login.</p>
        </div>
        <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="bg-white rounded-lg border border-slate-200 p-6 hover:shadow-lg transition-shadow">
              <div className="w-11 h-11 rounded-lg flex items-center justify-center mb-4" style={{ background: `${feature.color}14`, color: feature.color }}>
                <feature.icon size={23} />
              </div>
              <h3 className="font-black text-slate-900 text-[16px]">{feature.title}</h3>
              <p className="mt-2 text-slate-500 text-[14px] leading-relaxed">{feature.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="views" className="bg-slate-950 text-white landing-anchor-section">
        <div className="w-full px-8 lg:px-12 xl:px-16 py-18 sm:py-20">
          <div className="max-w-2xl">
            <p className="text-cyan-300 font-black text-[13px] uppercase tracking-wider">Animated product views</p>
            <h2 className="mt-2 text-3xl font-black tracking-tight">See what clients get before they log in</h2>
            <p className="mt-3 text-slate-300 text-[15px] leading-relaxed">
              Lightweight motion panels show the core ActMon workflows: monitor hosts, inspect databases, check webpages and find configuration files fast.
            </p>
          </div>
          <div className="mt-10 grid lg:grid-cols-2 gap-5">
            {SHOWCASES.map((item) => (
              <AnimatedShowcase key={item.title} item={item} />
            ))}
          </div>
        </div>
      </section>

      <section id="download" className="w-full px-8 lg:px-12 xl:px-16 py-18 sm:py-20 landing-anchor-section">
        <div className="text-center max-w-2xl mx-auto">
          <p className="text-indigo-600 font-black text-[13px] uppercase tracking-wider">Download</p>
          <h2 className="mt-2 text-3xl font-black text-slate-900 tracking-tight">Download the ActMon application</h2>
          <p className="mt-3 text-slate-500 text-[15px]">The full ActMon product build (not the host agent) — pick your operating system.</p>
        </div>

        {/* per-OS build cards */}
        <div className="mt-12 max-w-5xl mx-auto grid md:grid-cols-2 gap-5">
          <BuildCard
            b={dl.builds.windows} loading={dl.loading} version={dl.version} glyph={<WindowsGlyph />}
            title="ActMon for Windows"
            features={['Full product build (one zip)', 'Backend + prebuilt UI', 'Install scripts + setup guide']}
          />
          <BuildCard
            b={dl.builds.linux} loading={dl.loading} version={dl.version} glyph={<Terminal size={26} className="text-slate-800" />}
            title="ActMon for Linux / Ubuntu"
            features={['Prebuilt UI + backend source', 'install.sh + nginx + systemd', 'No node_modules — deps installed on setup']}
          />
        </div>

        <p className="mt-4 text-center text-[13px] text-slate-500">
          Supported: <b className="text-slate-700">Windows 10 / 11 &amp; Server (x64)</b> and <b className="text-slate-700">Ubuntu 22.04 / 24.04 LTS (x86_64)</b>. macOS is planned.
        </p>

        {/* every build includes + console */}
        <div className="mt-8 max-w-5xl mx-auto bg-slate-950 rounded-lg p-7 sm:p-8 text-white grid sm:grid-cols-[1fr_auto] gap-6 items-center">
          <div>
            <p className="text-[12px] font-black uppercase tracking-wider text-cyan-300">Every build includes</p>
            <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3">
              {[
                ['Database monitoring', 'Six database engines'],
                ['Infrastructure', 'Hosts, services & files'],
                ['Cloud', 'Cost, topology & posture'],
                ['Access control', 'Roles, permissions & audit'],
              ].map(([title, sub]) => (
                <div key={title}>
                  <p className="font-black text-[14px]">{title}</p>
                  <p className="text-[12px] text-slate-400">{sub}</p>
                </div>
              ))}
            </div>
          </div>
          <button onClick={() => navigate('/login')} className="h-11 px-5 rounded-lg bg-white text-slate-950 font-black hover:bg-slate-100 transition-colors flex items-center justify-center gap-2 whitespace-nowrap">
            Open console <ChevronRight size={17} />
          </button>
        </div>

        <div className="mt-6 max-w-5xl mx-auto">
          <DownloadSoon os="macOS application" note="Package target planned" icon={HardDrive} />
        </div>

        <p className="mt-8 text-center text-[13px] text-slate-400">
          Need host telemetry? Agent downloads are available after login in the server setup workflow.
        </p>
      </section>

      <section className="bg-indigo-600">
        <div className="w-full px-8 lg:px-12 xl:px-16 py-12 flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="text-white">
            <h2 className="text-2xl font-black">Ready to monitor everything?</h2>
            <p className="text-indigo-100 mt-1 text-[15px]">Sign in to the ActMon console and start configuring your environment.</p>
          </div>
          <button onClick={() => navigate('/login')} className="h-12 px-7 rounded-lg bg-white text-indigo-700 font-black hover:bg-slate-100 transition-colors flex items-center gap-2 shadow-lg flex-shrink-0">
            Log in <ChevronRight size={18} />
          </button>
        </div>
      </section>

      <footer className="bg-slate-950 text-slate-400">
        <div className="w-full px-8 lg:px-12 xl:px-16 py-10 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center">
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

function BuildCard({ b, loading, version, glyph, title, features }) {
  const available = !!b?.available;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-xl p-7 flex flex-col">
      <div className="flex items-start justify-between gap-4">
        <div className="w-12 h-12 rounded-lg bg-blue-50 flex items-center justify-center">{glyph}</div>
        <span className={`px-2.5 py-1 rounded-lg text-[11px] font-black uppercase ${available ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
          {loading ? 'Checking' : available ? 'Available' : 'Publish build'}
        </span>
      </div>
      <h3 className="mt-5 font-black text-slate-900 text-[20px]">{title}</h3>
      <p className="text-[12px] font-bold text-indigo-600 mt-1">{b?.os || 'Supported OS'}</p>
      <ul className="mt-4 space-y-2 text-[13px] text-slate-600 flex-1">
        {features.map((f) => <li key={f} className="flex items-center gap-2"><Check size={14} className="text-emerald-500 flex-shrink-0" /> {f}</li>)}
      </ul>
      <a
        href={available ? b.url : undefined}
        aria-disabled={!available}
        className={`mt-6 h-12 px-6 rounded-lg font-bold inline-flex items-center justify-center gap-2 shadow-sm transition-colors ${available ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-slate-100 text-slate-400 pointer-events-none'}`}
      >
        <Download size={17} /> Download{b?.label ? ` for ${b.label}` : ''}
      </a>
      <p className="mt-3 text-[12px] text-slate-400">
        {available
          ? `v${version}${b.size_mb ? ` · ${b.size_mb} MB` : ''} · ${b.filename}`
          : 'Not published on this server yet.'}
      </p>
    </div>
  );
}

function DownloadSoon({ os, note, icon: Icon }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-6 opacity-80">
      <span className="float-right px-2 py-0.5 rounded-lg bg-slate-100 text-slate-500 text-[11px] font-black uppercase">Soon</span>
      <div className="w-12 h-12 rounded-lg bg-slate-50 flex items-center justify-center mb-4 text-slate-400"><Icon size={24} /></div>
      <h3 className="font-black text-slate-900 text-[17px]">{os}</h3>
      <p className="text-slate-500 text-[13px] mt-1">{note}</p>
      <button disabled className="mt-6 h-11 w-full rounded-lg bg-slate-100 text-slate-400 font-bold flex items-center justify-center gap-2 cursor-not-allowed">
        Coming soon
      </button>
    </div>
  );
}

function WindowsGlyph() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      {[[3, 3], [13, 3], [3, 13], [13, 13]].map(([x, y], i) => (
        <rect key={i} x={x} y={y} width="8" height="8" rx="1" fill="#2563eb" />
      ))}
    </svg>
  );
}

function ProductStage() {
  return (
    <div className="landing-product-stage" aria-hidden="true">
      <div className="landing-orbit-ring landing-orbit-ring-one" />
      <div className="landing-orbit-ring landing-orbit-ring-two" />

      <div className="landing-orbit-node landing-orbit-node-db">
        <Database size={17} />
        <span>DB</span>
      </div>
      <div className="landing-orbit-node landing-orbit-node-infra">
        <Server size={17} />
        <span>Infra</span>
      </div>
      <div className="landing-orbit-node landing-orbit-node-web">
        <Globe2 size={17} />
        <span>Web</span>
      </div>
      <div className="landing-orbit-node landing-orbit-node-files">
        <FileSearch size={17} />
        <span>Files</span>
      </div>

      <div className="landing-stage-console">
        <div className="landing-stage-topbar">
          <span />
          <span />
          <span />
          <b>ActMon Live Command Center</b>
          <i>streaming</i>
        </div>
        <div className="landing-stage-body">
          <div className="landing-stage-sidebar">
            {[
              [Database, 'Databases'],
              [Server, 'Hosts'],
              [Globe2, 'Webpages'],
              [FileSearch, 'Config files'],
            ].map(([Icon, label], index) => (
              <div key={label} className={index === 1 ? 'active' : ''}>
                <Icon size={14} />
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="landing-stage-main">
            <div className="landing-health-strip">
              {[
                ['CPU', '68'],
                ['RAM', '74'],
                ['SQL', '92'],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <b>{value}%</b>
                </div>
              ))}
            </div>
            <div className="landing-topology-scene">
              <span className="landing-topology-core">ActMon</span>
              <span className="landing-topology-dot landing-topology-dot-1" />
              <span className="landing-topology-dot landing-topology-dot-2" />
              <span className="landing-topology-dot landing-topology-dot-3" />
              <span className="landing-topology-line landing-topology-line-1" />
              <span className="landing-topology-line landing-topology-line-2" />
              <span className="landing-topology-line landing-topology-line-3" />
            </div>
            <div className="landing-stage-events">
              <div><Check size={13} /> mysql-prod-01 healthy</div>
              <div><Search size={13} /> nginx.conf found</div>
              <div><Globe2 size={13} /> checkout page 214ms</div>
            </div>
          </div>
        </div>
      </div>

      <div className="landing-float-card landing-float-card-left">
        <div className="flex items-center gap-2">
          <FileSearch size={15} />
          <b>Config finder</b>
        </div>
        <p>/etc/nginx/nginx.conf</p>
        <p>/opt/app/.env</p>
      </div>

      <div className="landing-float-card landing-float-card-right">
        <div className="flex items-center gap-2">
          <Globe2 size={15} />
          <b>Webpage checks</b>
        </div>
        <p>SSL valid</p>
        <p>99.98% uptime</p>
      </div>

      <div className="landing-float-card landing-float-card-bottom">
        <div className="flex items-center gap-2">
          <Sparkles size={15} />
          <b>AI insight</b>
        </div>
        <p>Slow SQL matched to missing index</p>
      </div>
    </div>
  );
}

function AnimatedShowcase({ item }) {
  const Icon = item.icon;

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.04] overflow-hidden">
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className={`landing-view-icon landing-view-icon-${item.tone}`}>
            <Icon size={22} />
          </div>
          <div>
            <h3 className="font-black text-white text-[18px]">{item.title}</h3>
            <p className="mt-1 text-[14px] leading-relaxed text-slate-400">{item.desc}</p>
          </div>
        </div>
      </div>
      <div className="border-t border-white/10 bg-slate-900/70 p-4 sm:p-5">
        {item.visual === 'infra' && <InfraVideo />}
        {item.visual === 'database' && <DatabaseVideo />}
        {item.visual === 'web' && <WebpageVideo />}
        {item.visual === 'config' && <ConfigFinderVideo />}
      </div>
    </div>
  );
}

function InfraVideo() {
  return (
    <div className="landing-video">
      <div className="landing-video-top">
        <span className="landing-dot bg-emerald-400" />
        <span>Live host map</span>
        <span className="ml-auto text-emerald-300">online</span>
      </div>
      <div className="grid grid-cols-[0.9fr_1.1fr] gap-4">
        <div className="landing-radar">
          {['DB', 'APP', 'WEB', 'CACHE'].map((label, index) => (
            <span key={label} className={`landing-node landing-node-${index + 1}`}>{label}</span>
          ))}
        </div>
        <div className="space-y-3">
          {[
            ['CPU', '68%', 'landing-meter-cyan'],
            ['Memory', '74%', 'landing-meter-blue'],
            ['Disk', '41%', 'landing-meter-emerald'],
            ['Network', '89%', 'landing-meter-amber'],
          ].map(([label, value, cls]) => (
            <div key={label}>
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>{label}</span>
                <span>{value}</span>
              </div>
              <div className="landing-meter"><span className={cls} /></div>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {[Cpu, Network, Settings].map((Icon, index) => (
          <div key={index} className="landing-mini-stat">
            <Icon size={14} />
            <span>{['Processes', 'Traffic', 'Services'][index]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DatabaseVideo() {
  const bars = [64, 42, 78, 55, 88, 61, 72, 49, 83, 67];

  return (
    <div className="landing-video">
      <div className="landing-video-top">
        <Database size={14} className="text-blue-300" />
        <span>Query performance</span>
        <span className="ml-auto text-blue-300">1.2k QPS</span>
      </div>
      <div className="landing-db-bars">
        {bars.map((height, index) => (
          <span key={index} style={{ '--bar-height': `${height}%`, '--bar-delay': `${index * 90}ms` }} />
        ))}
      </div>
      <div className="mt-4 space-y-2">
        {[
          ['Slow SQL detected', 'SELECT orders where status = pending', '00:02.8'],
          ['Index suggestion', 'idx_orders_status_created_at', '+32%'],
          ['Wait event', 'buffer_io', 'normal'],
        ].map(([title, detail, value]) => (
          <div key={title} className="landing-db-row">
            <div>
              <p className="text-[12px] font-black text-white">{title}</p>
              <p className="text-[11px] text-slate-500">{detail}</p>
            </div>
            <span>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WebpageVideo() {
  return (
    <div className="landing-video">
      <div className="landing-video-top">
        <Globe2 size={14} className="text-emerald-300" />
        <span>Web checks</span>
        <span className="ml-auto text-emerald-300">99.98%</span>
      </div>
      <div className="landing-browser">
        <div className="landing-browser-bar">
          <span />
          <span />
          <span />
          <div>https://app.actmon.local/health</div>
        </div>
        <div className="landing-waterfall">
          {[
            ['DNS', '36ms', 'w-1/4'],
            ['TLS', '88ms', 'w-1/3'],
            ['API', '142ms', 'w-2/3'],
            ['Page', '214ms', 'w-5/6'],
          ].map(([label, value, width]) => (
            <div key={label} className="landing-waterfall-row">
              <span>{label}</span>
              <div><i className={width} /></div>
              <b>{value}</b>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {['SSL valid', '200 OK', 'No outage'].map((item) => (
          <div key={item} className="landing-mini-stat text-emerald-200">
            <Check size={14} />
            <span>{item}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfigFinderVideo() {
  const files = [
    '/etc/nginx/nginx.conf',
    '/etc/mysql/my.cnf',
    '/opt/app/.env',
    'C:\\inetpub\\config\\web.config',
  ];

  return (
    <div className="landing-video">
      <div className="landing-video-top">
        <FolderOpen size={14} className="text-violet-300" />
        <span>Configuration finder</span>
        <span className="ml-auto text-violet-300">scan</span>
      </div>
      <div className="landing-search-box">
        <Search size={14} />
        <span>nginx, mysql, env, service files</span>
        <i />
      </div>
      <div className="mt-4 space-y-2">
        {files.map((file, index) => (
          <div key={file} className="landing-file-row" style={{ '--row-delay': `${index * 140}ms` }}>
            <FileSearch size={15} />
            <span>{file}</span>
            <b>{index === 0 ? 'open' : 'found'}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function HeroMockup() {
  const bars = [42, 68, 55, 80, 61, 73, 90, 66, 78];
  const rows = [
    ['mysql-prod-01', 'Healthy', '99.2%'],
    ['pg-ledger-02', 'Warning', '87.4%'],
    ['aws-core', 'Secure', '94.8%'],
  ];

  return (
    <div className="relative rounded-lg bg-white shadow-2xl border border-white/20 overflow-hidden">
      <div className="h-10 bg-slate-100 flex items-center gap-1.5 px-4 border-b border-slate-200">
        <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
        <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
        <span className="ml-3 text-[11px] font-semibold text-slate-500">ActMon Console</span>
      </div>
      <div className="p-4 sm:p-5 bg-white text-slate-900">
        <div className="grid grid-cols-3 gap-3 mb-4">
          {[
            ['Health', '95', 'text-emerald-600', Gauge],
            ['Queries', '1.2k', 'text-blue-600', Activity],
            ['Alerts', '08', 'text-amber-600', Bell],
          ].map(([label, value, color, Icon]) => (
            <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-bold uppercase text-slate-400">{label}</p>
                <Icon size={14} className="text-slate-400" />
              </div>
              <p className={`text-[20px] font-black ${color}`}>{value}</p>
            </div>
          ))}
        </div>
        <div className="rounded-lg border border-slate-200 p-4">
          <p className="text-[11px] font-bold uppercase text-slate-400 mb-3">Live throughput</p>
          <div className="flex items-end gap-1.5 h-24">
            {bars.map((height, i) => (
              <div key={i} className="flex-1 rounded-t bg-gradient-to-t from-indigo-500 to-cyan-400" style={{ height: `${height}%` }} />
            ))}
          </div>
        </div>
        <div className="mt-4 rounded-lg border border-slate-200 overflow-hidden">
          {rows.map(([name, status, score]) => (
            <div key={name} className="h-12 px-4 flex items-center justify-between border-b border-slate-100 last:border-b-0">
              <span className="text-[13px] font-bold text-slate-700">{name}</span>
              <span className="text-[12px] text-slate-500">{status} - {score}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
