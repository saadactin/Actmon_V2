import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronRight, BookOpen, Rocket, Layers, Server, Database, Cloud,
  ScrollText, ShieldCheck, Package, Brain, HelpCircle, Search, Copy, Check,
  LifeBuoy, Sparkles, Terminal, ChevronDown, Mail, MessageSquare,
  CheckCircle2, AlertTriangle, Gauge, Zap, Activity, Bell, Wrench, Boxes,
} from 'lucide-react';

// Open the floating ActMon AI assistant, optionally with a pre-filled question.
const askAI = (ask) =>
  window.dispatchEvent(new CustomEvent('actmon:open-chat', { detail: { ask } }));

/* ── shared building blocks ─────────────────────────────────────────────── */
function Lead({ children }) {
  return <p className="text-[13.5px] text-slate-500 leading-relaxed max-w-3xl">{children}</p>;
}
function H({ children }) {
  return <h3 className="text-[13px] font-black text-slate-800 uppercase tracking-wide flex items-center gap-2 mb-3">{children}</h3>;
}
function Card({ title, children, accent = 'slate' }) {
  const bar = { slate: 'border-slate-200', blue: 'border-blue-300', rose: 'border-rose-300', emerald: 'border-emerald-300' }[accent];
  return (
    <div className={`bg-white rounded-xl border ${bar} shadow-sm p-4`}>
      {title && <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest mb-1.5">{title}</p>}
      <div className="text-[13px] text-slate-600 leading-relaxed space-y-1">{children}</div>
    </div>
  );
}
function Grid({ cols = 3, children }) {
  const c = { 2: 'md:grid-cols-2', 3: 'md:grid-cols-3', 4: 'md:grid-cols-2 lg:grid-cols-4' }[cols];
  return <div className={`grid grid-cols-1 ${c} gap-3`}>{children}</div>;
}
function Bullets({ items }) {
  return (
    <ul className="space-y-1.5">
      {items.map((t, i) => (
        <li key={i} className="flex items-start gap-2 text-[13px] text-slate-600">
          <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0 mt-0.5" /> <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}
function CommandBlock({ cmd, label }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  return (
    <div className="rounded-lg overflow-hidden border border-slate-800 bg-slate-900">
      {label && <div className="px-3 py-1.5 bg-slate-800/60 text-[10px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-1.5"><Terminal size={11} /> {label}</div>}
      <div className="flex items-start gap-2 px-3 py-2.5">
        <code className="flex-1 text-[12px] font-mono text-emerald-300 whitespace-pre-wrap break-all leading-relaxed">{cmd}</code>
        <button onClick={copy} title="Copy" className="flex-shrink-0 text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700">{copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}</button>
      </div>
    </div>
  );
}
function Flow({ steps }) {
  return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch gap-2">
      {steps.map((s, i) => (
        <React.Fragment key={i}>
          <div className="flex-1 min-w-[130px] rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-center">
            <p className="font-bold text-slate-800 text-[13px] leading-tight">{s.t}</p>
            {s.d && <p className="text-[11px] text-slate-400 mt-0.5">{s.d}</p>}
          </div>
          {i < steps.length - 1 && <div className="hidden sm:flex items-center text-slate-300"><ChevronRight size={16} /></div>}
        </React.Fragment>
      ))}
    </div>
  );
}
function Table({ head, rows }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full text-[13px]">
        <thead><tr className="bg-slate-800 text-white">
          {head.map((h) => <th key={h} className="px-3 py-2.5 text-left font-bold text-[11px] uppercase tracking-wide whitespace-nowrap">{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={i % 2 ? 'bg-slate-50/60' : 'bg-white'}>
              {r.map((c, j) => <td key={j} className={`px-3 py-2.5 align-top ${j === 0 ? 'font-bold text-slate-700 whitespace-nowrap' : 'text-slate-600'}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── content data ───────────────────────────────────────────────────────── */
const ENGINES = ['MySQL / MariaDB', 'PostgreSQL', 'SQL Server', 'Oracle', 'MongoDB', 'ClickHouse'];
const STATS = [
  ['1', 'Unified Console'], ['6+', 'Database Engines'], ['3', 'Cloud Providers'],
  ['15s', 'Live Telemetry'], ['24/7', 'AI-Assisted Ops'],
];
const CORE_MODULES = [
  { icon: Brain, name: 'ActMon AI Copilot', cat: 'Conversational AI', points: ['Streaming chat grounded in live dashboard data — not model memory', 'Per-dialect SQL generation, EXPLAIN & performance analysis, error diagnosis', 'Organization-scoped context and one-click report downloads', 'In-app navigation — ask for a page and it takes you there'] },
  { icon: Activity, name: 'Unified Multi-Engine Monitoring', cat: 'Deep Visibility', points: ['Engine-native deep-dive dashboards for all six technologies', 'Performance, queries, locks, replication, storage, backup & PITR', 'Engine internals: performance_schema, pg_stat_statements, DMVs, V$ views', '~15-second collection classified by technology and connection'] },
  { icon: Bell, name: 'Smart Alerts & AI Triage', cat: 'Incident Intelligence', points: ['Alert rules with live evaluation and an active-alerts board', 'Drill context — every alert resolves to its live connection', 'AI diagnostics agent decides and runs the next diagnostic step', 'One-click AI analysis with explanation and suggested fixes'] },
  { icon: Search, name: 'Slow Query & Index Intelligence', cat: 'Performance Engineering', points: ['Slow-query digests from engine-native sources', 'Query detail drill-downs with EXPLAIN plans', 'Per-engine index analysis — unused, missing, duplicate candidates', 'Error log collection with AI error analysis'] },
  { icon: Wrench, name: 'Self-Heal & Automation', cat: 'Autonomous Operations', points: ['Guided auto-remediation with a persistent action history', 'Scheduled backups with point-in-time recovery (MySQL/PG/MSSQL)', 'Scheduled per-engine email reports, generated automatically', 'Background schedulers: collector, reaper, backup & report jobs'] },
];
const ADDL_MODULES = [
  ['Infrastructure Monitoring', 'Host CPU, memory, disk, network, processes, services & uptime — identical via agent or SSH.'],
  ['Web SSH Terminal', 'Browser-based SSH over websocket for immediate, audited remediation.'],
  ['File Explorer & Config Finder', 'Browse host filesystems and locate nginx, Apache, DB & service configs.'],
  ['Cloud Discovery & Inventory', 'Background resource discovery across AWS, Azure & OCI into one inventory.'],
  ['Cloud Cost', 'Cost and estimate views over discovered cloud resources for FinOps.'],
  ['Cloud Security & Compliance', 'Security posture findings and compliance views with cloud alerts.'],
  ['Cloud Topology', 'Visual topology of discovered cloud resources and relationships.'],
  ['Website / URL Monitoring', 'Uptime, response time and SSL certificate status for public endpoints.'],
  ['Logs Hub', 'Searchable, ClickHouse-backed center for all telemetry and module logs.'],
  ['Backup & PITR Manager', 'Central backup execution, scheduling & point-in-time recovery.'],
  ['Agent Fleet Management', 'Tokens, generated installers, deploy wizard, heartbeat, reaper, CSV export.'],
  ['Administration & RBAC Suite', 'Organizations, departments, users, roles, and a role × page matrix.'],
  ['Audit & Access Trail', 'Audit logs, login history, active sessions and password history.'],
  ['ML Anomaly Detection', 'Metric baselines and anomaly detection over ClickHouse history (roadmap).'],
];
const TECH_STACK = [
  ['Frontend', 'React 18 + Vite, Tailwind CSS, TanStack Query, Zustand, lazy-loaded routes'],
  ['Backend / API', 'FastAPI (Python) — API service (:8000) + cloud discovery (:8001), SQLAlchemy ORM'],
  ['Engine Connectors', 'Native drivers: PyMySQL, psycopg, pyodbc (MSSQL), oracledb, pymongo, ClickHouse client'],
  ['Host Collection', 'Dependency-light Python agent (Windows/Linux) or agentless SSH; long-poll job channel'],
  ['Metadata Store', 'PostgreSQL — connections, agents, RBAC, alert rules, schedules'],
  ['Hot Metrics Tier', 'Redis — latest sample + one-hour ring buffer for live dashboards'],
  ['History & Logs', 'ClickHouse — per-technology time-series history and the searchable logs hub'],
  ['AI / LLM Layer', 'Llama 3.3 70B with SSE streaming, grounded by a live health-data injection layer'],
  ['Alerting & Delivery', 'Rule engine with live evaluation; SMTP for notifications and report email'],
  ['Packaging', 'Windows MSI, Debian DEB, RHEL RPM & shell installers with token baked in'],
  ['Serving & Auth', 'nginx + systemd + uvicorn; JWT with OTP, bcrypt hashing, role-based access'],
];
const SECURITY = [
  ['Authentication', 'JWT session tokens with OTP verification at sign-in; bcrypt password hashing throughout.'],
  ['Authorization & RBAC', 'Role-based access mapped to a page-level permission matrix — each role sees only what it is granted.'],
  ['Multi-Tenant Isolation', 'Every record carries an organization scope, enforced by tenant context on every request.'],
  ['Secrets Handling', 'Installer-generated DB password & JWT secret in a root-owned env file (600); nothing hardcoded.'],
  ['Audit Logs', 'Audit trail, login history, active session tracking and password history for compliance.'],
  ['Agent Enrollment', 'Agents enroll with one-time tokens; DB credentials for agent-side tests never leave the host.'],
  ['Transport Security', 'nginx front end ready for TLS termination; API & websocket proxied on the private interface.'],
  ['Least-Privilege Collection', 'Telemetry reads from native statistics views; remediation is a separate, permissioned path.'],
];
const ROADMAP = [
  ['P1', 'Foundation', 'SHIPPED', 'emerald', 'Six-engine deep-dive monitoring, agent & SSH collection, connections, infrastructure, RBAC, multi-tenant admin, one-command installer.'],
  ['P2', 'Intelligence', 'SHIPPED', 'emerald', 'AI Copilot with live grounding, AI alert triage & analysis, slow-query & index intelligence, self-heal, reports, logs hub, cloud discovery, website monitoring.'],
  ['P3', 'Prediction', 'IN DEVELOPMENT', 'amber', 'ML anomaly detection over ClickHouse history, adaptive baselines, capacity forecasting, forecast-based alerts, expanded self-heal playbooks.'],
  ['P4', 'Ecosystem & Coverage', 'PLANNED', 'slate', 'Slack/Teams/webhook channels, escalation policies, more engines (Redis, Elasticsearch, Cassandra), Kubernetes, SSO, public API, Grafana.'],
  ['P5', 'Scale & Autonomy', 'PLANNED', 'slate', 'High-availability topology, horizontal collector scaling, mobile app, custom dashboards, SLA reporting, supervised autonomous remediation.'],
];
const TROUBLESHOOTING = [
  { q: 'An agent shows "DB Error"', a: 'Hover the status badge on the Agents page — ActMon shows the exact failure reason. Fix the specific cause (credentials, privileges, or old agent version).', ai: 'One of my agents shows DB Error. How do I diagnose and fix it?' },
  { q: 'An agent is "Offline"', a: 'It stopped sending heartbeats. Check the actmon-agent service and network reachability to the ActMon server.', ai: 'My agent is Offline. What should I check?' },
  { q: 'A database says "Waiting for data"', a: 'The agent has not pushed metrics yet, or cannot reach the DB. Use "Test via agent" in the wizard to validate credentials on the host.', ai: 'My database connection is stuck on waiting for data. Why?' },
  { q: 'ClickHouse "Not enough privileges" (Code 497)', a: 'The monitoring user lacks read access to system tables. Grant: GRANT SELECT ON system.* TO <user>; on that instance.', ai: 'ClickHouse monitoring fails with Not enough privileges. What grant is needed?' },
  { q: 'Oracle "[Errno 107] Transport endpoint"', a: 'A Grid listener redirect the thin driver cannot follow. Reinstall the latest agent on the Oracle host to use thick-mode client libraries.', ai: 'Oracle connection fails with Errno 107. How to fix?' },
  { q: 'Export logs for one database or agent', a: 'Logs → All Telemetry → filter → ⬇ CSV. Each Database Logs row also has a per-connection 24h download icon.', ai: 'How do I download telemetry logs for a specific database as CSV?' },
];

const TABS = [
  { id: 'overview', label: 'Overview', icon: Rocket },
  { id: 'architecture', label: 'Architecture', icon: Layers },
  { id: 'core', label: 'Core Modules', icon: Boxes },
  { id: 'modules', label: 'All Modules', icon: Package },
  { id: 'tech', label: 'Technology', icon: Server },
  { id: 'security', label: 'Security', icon: ShieldCheck },
  { id: 'deploy', label: 'Deployment', icon: Cloud },
  { id: 'roadmap', label: 'Roadmap', icon: Gauge },
  { id: 'help', label: 'Help Desk', icon: LifeBuoy },
];

export default function SalesDocs() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [openFaq, setOpenFaq] = useState(0);

  return (
    <div className="-mx-6 md:-mx-8 bg-[#f1f5f9] min-h-full">
      {/* ═══ FROZEN HEADER (title + tabs stay fixed) ═══ */}
      <div className="sticky top-0 z-30 shadow-md">
        <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 md:px-8 pt-3 pb-3 relative overflow-hidden">
          <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '26px 26px' }} />
          <div className="relative flex items-center gap-3">
            <button onClick={() => navigate('/sales')} className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 flex items-center justify-center text-white flex-shrink-0"><ChevronRight size={16} className="rotate-180" /></button>
            <div className="w-9 h-9 rounded-lg bg-sky-400/20 border border-sky-400/40 flex items-center justify-center flex-shrink-0"><BookOpen size={18} className="text-sky-200" /></div>
            <div className="flex-1 min-w-0">
              <h1 className="text-lg font-black text-white tracking-tight leading-none">ActMon Documentation</h1>
              <p className="text-sky-200/70 text-[11px] mt-0.5 truncate">One Console. Every Database. Complete Operational Intelligence.</p>
            </div>
            <button onClick={() => askAI('Give me a quick tour of ActMon.')}
              className="hidden sm:flex h-9 px-4 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 text-white font-bold text-[13px] items-center gap-2 flex-shrink-0">
              <Sparkles size={15} /> Ask ActMon AI
            </button>
          </div>
        </div>
        {/* tab strip — frozen with the header */}
        <div className="bg-white border-b border-slate-200 px-3 md:px-6">
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
            {TABS.map((t) => {
              const Ico = t.icon;
              const on = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className={`flex items-center gap-1.5 px-3.5 py-3 text-[13px] font-bold whitespace-nowrap border-b-2 transition-colors ${on ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
                  <Ico size={15} className={on ? 'text-blue-600' : 'text-slate-400'} /> {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ═══ CONTENT — only the active tab renders (no long scroll) ═══ */}
      <div className="px-6 md:px-8 py-6 max-w-[1400px] mx-auto space-y-5">

        {tab === 'overview' && (
          <>
            <div><h2 className="text-2xl font-black text-slate-800 mb-1">Overview</h2>
              <Lead>ActMon by Actin Technologies is a vendor-neutral, self-hosted AI monitoring platform that unifies deep database observability, infrastructure health and multi-cloud discovery — a single pane of glass with an embedded AI DBA copilot across the entire data estate.</Lead></div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {STATS.map(([n, l]) => (
                <div key={l} className="bg-white rounded-xl border border-slate-200 shadow-sm py-4 text-center">
                  <p className="text-2xl font-black text-blue-700">{n}</p>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">{l}</p>
                </div>
              ))}
            </div>
            <Grid cols={2}>
              <Card title="Vision" accent="blue">To become the default operational-intelligence layer for database-driven organizations — where every database, server and cloud account, regardless of vendor, can be seen, understood and acted on from one console in real time.</Card>
              <Card title="Mission" accent="blue">To eliminate monitoring silos and manual DBA toil with vendor-neutral deep-dive monitoring, intelligent alerting, and AI-assisted diagnosis and remediation teams can trust and act on.</Card>
            </Grid>
            <div><H><Database size={14} className="text-blue-600" /> Supported database engines</H>
              <div className="flex flex-wrap gap-2">
                {ENGINES.map((e) => <span key={e} className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-[13px] font-semibold text-slate-700 shadow-sm">{e}</span>)}
              </div>
            </div>
          </>
        )}

        {tab === 'architecture' && (
          <>
            <div><h2 className="text-2xl font-black text-slate-800 mb-1">Platform Architecture</h2>
              <Lead>A layered platform — the existing data estate feeds vendor-neutral collectors, which power the ActMon core, AI modules and role-scoped outputs, on a continuous 15-second cadence.</Lead></div>
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <H><Layers size={14} className="text-blue-600" /> End-to-end data flow</H>
              <Flow steps={[
                { t: 'Databases & Hosts', d: '6 engines · Linux · Windows' },
                { t: 'Collectors', d: 'Agent or SSH' },
                { t: 'Ingest & Classify', d: 'FastAPI' },
                { t: 'Metrics Pipeline', d: 'PG → Redis → ClickHouse' },
                { t: 'AI Engine', d: 'Copilot · triage · self-heal' },
                { t: 'Dashboards / Alerts / Reports', d: 'Role-scoped' },
              ]} />
            </div>
            <div><H><Boxes size={14} className="text-blue-600" /> Three-tier metrics pipeline</H>
              <Grid cols={3}>
                <Card title="Redis — Hot" accent="rose">Latest sample + one-hour ring buffer per stream, for instant live-dashboard reads at 15s resolution. Degrades gracefully if absent.</Card>
                <Card title="ClickHouse — Warm/History">Per-technology time-series tables for long-range history and the searchable logs hub — optimized for fast scans.</Card>
                <Card title="PostgreSQL — Durable">Connections, agents, RBAC, alert rules and schedules — structured, transactional data. Never bulk telemetry.</Card>
              </Grid>
            </div>
            <div><H><ShieldCheck size={14} className="text-blue-600" /> Architectural principles</H>
              <Grid cols={2}>
                <Card>Agent or agentless by choice — both paths share collector logic and produce identical dashboards.</Card>
                <Card>Read-oriented, non-invasive — telemetry from native statistics views; remediation explicit &amp; audited.</Card>
                <Card>Vendor neutral — native drivers &amp; provider APIs, no proprietary middleware.</Card>
                <Card>Multi-tenant by design — every table carries an organization scope, enforced per request.</Card>
              </Grid>
            </div>
          </>
        )}

        {tab === 'core' && (
          <>
            <div><h2 className="text-2xl font-black text-slate-800 mb-1">Core Modules</h2>
              <Lead>Five core modules form ActMon's primary value — each addressing a distinct, high-frequency pain point in database-driven organizations.</Lead></div>
            <div className="space-y-3">
              {CORE_MODULES.map((m) => {
                const Ico = m.icon;
                return (
                  <div key={m.name} className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center text-white flex-shrink-0"><Ico size={17} /></div>
                      <div className="flex-1 min-w-0">
                        <p className="font-black text-slate-800 text-[15px] leading-tight">{m.name}</p>
                        <p className="text-[11px] font-bold text-blue-600 uppercase tracking-widest">{m.cat}</p>
                      </div>
                      <button onClick={() => askAI(`Tell me more about the ActMon ${m.name} module.`)} title="Ask ActMon AI"
                        className="flex-shrink-0 h-8 px-3 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-600 text-[12px] font-bold hover:bg-indigo-100 flex items-center gap-1.5"><Sparkles size={13} /> Ask AI</button>
                    </div>
                    <Bullets items={m.points} />
                  </div>
                );
              })}
            </div>
          </>
        )}

        {tab === 'modules' && (
          <>
            <div><h2 className="text-2xl font-black text-slate-800 mb-1">All Modules</h2>
              <Lead>Beyond the five core modules, ActMon ships additional modules extending coverage across infrastructure, cloud, security and administration.</Lead></div>
            <Grid cols={3}>
              {ADDL_MODULES.map(([t, d]) => (
                <div key={t} className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
                  <p className="font-black text-slate-800 text-[13.5px] leading-tight">{t}</p>
                  <p className="text-[12.5px] text-slate-500 mt-1 leading-relaxed">{d}</p>
                </div>
              ))}
            </Grid>
          </>
        )}

        {tab === 'tech' && (
          <>
            <div><h2 className="text-2xl font-black text-slate-800 mb-1">Technology Stack</h2>
              <Lead>A modern, self-hostable stack chosen for scalability, vendor neutrality and compatibility with on-premises, air-gapped and cloud deployments.</Lead></div>
            <Table head={['Layer', 'Technology / Approach']} rows={TECH_STACK} />
          </>
        )}

        {tab === 'security' && (
          <>
            <div><h2 className="text-2xl font-black text-slate-800 mb-1">Security Architecture</h2>
              <Lead>A defense-in-depth model appropriate for a platform that holds credentials to production databases — least privilege and integrity throughout.</Lead></div>
            <Grid cols={2}>
              {SECURITY.map(([t, d]) => (
                <div key={t} className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
                  <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest mb-1">{t}</p>
                  <p className="text-[13px] text-slate-600 leading-relaxed">{d}</p>
                </div>
              ))}
            </Grid>
            <Card accent="emerald"><span className="font-bold text-slate-700">Defense-in-depth layering:</span> Perimeter &amp; nginx → Identity &amp; Access (JWT · OTP · RBAC) → Tenant Isolation → Application &amp; API → Audit &amp; Monitoring.</Card>
          </>
        )}

        {tab === 'deploy' && (
          <>
            <div><h2 className="text-2xl font-black text-slate-800 mb-1">Deployment</h2>
              <Lead>ActMon installs in minutes on customer-owned infrastructure — on-premises, private cloud or air-gapped — with no external SaaS dependency for monitoring.</Lead></div>
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <H><Cloud size={14} className="text-blue-600" /> Installation topology</H>
              <Flow steps={[
                { t: 'Release Bundle', d: '.tgz · UI + backend' },
                { t: 'update.sh', d: 'idempotent' },
                { t: 'systemd', d: 'api :8000 · cloud :8001' },
                { t: 'nginx', d: 'UI :80 + API proxy' },
                { t: 'Agents Enroll', d: 'MSI / DEB / RPM / shell' },
              ]} />
            </div>
            <Grid cols={2}>
              <Card title="One-command install">A single idempotent installer provisions Python, PostgreSQL, nginx, the service user, schema, Super Admin role and generated secrets.</Card>
              <Card title="Self-contained bundle">Prebuilt UI + backend in one archive — suitable for restricted networks. ClickHouse is optional and additive.</Card>
              <Card title="Managed services">API &amp; cloud services run under systemd with auto-restart; updates copy new code and re-run schema setup safely.</Card>
              <Card title="Fleet-ready agents">Windows MSI, Debian DEB, RHEL RPM &amp; shell installers generated with token + URL baked in; agents self-register and self-update.</Card>
            </Grid>
            <div><H><Terminal size={14} className="text-blue-600" /> Update an existing deployment</H>
              <CommandBlock label="On the ActMon server, from the extracted bundle" cmd="sudo bash deploy/update.sh" /></div>
          </>
        )}

        {tab === 'roadmap' && (
          <>
            <div><h2 className="text-2xl font-black text-slate-800 mb-1">Product Roadmap</h2>
              <Lead>Standalone value at every stage — foundational visibility first, then AI intelligence, prediction, ecosystem integration and scale.</Lead></div>
            <div className="space-y-3">
              {ROADMAP.map(([p, name, status, color, desc]) => {
                const badge = { emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200', amber: 'bg-amber-50 text-amber-700 border-amber-200', slate: 'bg-slate-100 text-slate-500 border-slate-200' }[color];
                return (
                  <div key={p} className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full bg-slate-900 text-white font-black text-[13px] flex items-center justify-center flex-shrink-0">{p}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-black text-slate-800 text-[15px]">{name}</p>
                        <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border uppercase tracking-wide ${badge}`}>{status}</span>
                      </div>
                      <p className="text-[13px] text-slate-600 mt-1 leading-relaxed">{desc}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {tab === 'help' && (
          <>
            <div className="bg-gradient-to-br from-rose-500 to-pink-600 rounded-xl shadow-sm p-5 text-white relative overflow-hidden">
              <LifeBuoy size={110} className="absolute -right-3 -bottom-5 opacity-10" />
              <div className="relative">
                <div className="flex items-center gap-2 text-rose-100 text-[11px] font-black uppercase tracking-widest"><LifeBuoy size={14} /> Help Desk</div>
                <h2 className="text-xl font-black mt-1">Stuck on something? We've got you.</h2>
                <p className="text-rose-100/90 text-[13px] mt-1 max-w-2xl">Browse common issues, ask the AI assistant for instant help grounded in your live data, or reach the ActMon team.</p>
                <div className="mt-3 flex flex-wrap gap-2.5">
                  <button onClick={() => askAI('I need help troubleshooting an ActMon issue.')} className="h-9 px-4 rounded-lg bg-white text-rose-600 font-bold text-[13px] hover:bg-rose-50 flex items-center gap-2"><Brain size={15} /> Ask ActMon AI</button>
                  <a href="mailto:support@actin.co.in?subject=ActMon%20Support%20Request" className="h-9 px-4 rounded-lg bg-white/15 border border-white/30 text-white font-bold text-[13px] hover:bg-white/25 flex items-center gap-2"><Mail size={15} /> Email support</a>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-2">
              {TROUBLESHOOTING.map((f, i) => {
                const on = openFaq === i;
                return (
                  <div key={i} className="border-b border-slate-100 last:border-0">
                    <button onClick={() => setOpenFaq(on ? -1 : i)} className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left">
                      <span className="font-bold text-slate-700 text-[14px] flex items-center gap-2"><AlertTriangle size={14} className="text-amber-500 flex-shrink-0" /> {f.q}</span>
                      <ChevronDown size={17} className={`text-slate-400 flex-shrink-0 transition-transform ${on ? 'rotate-180' : ''}`} />
                    </button>
                    {on && (
                      <div className="px-3 pb-4 pl-9">
                        <p className="text-[13.5px] text-slate-600 leading-relaxed">{f.a}</p>
                        <button onClick={() => askAI(f.ai)} className="mt-2.5 h-8 px-3 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-600 text-[12px] font-bold hover:bg-indigo-100 flex items-center gap-1.5"><Sparkles size={13} /> Ask AI to walk me through it</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <Grid cols={3}>
              <button onClick={() => askAI('Help me with ActMon.')} className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 text-left hover:border-indigo-300 hover:shadow-md transition-all">
                <div className="w-9 h-9 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center"><Brain size={17} /></div>
                <p className="font-black text-slate-800 mt-2">AI Assistant</p><p className="text-[12px] text-slate-500">Instant answers, grounded in your data.</p></button>
              <a href="mailto:support@actin.co.in?subject=ActMon%20Support" className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 hover:border-blue-300 hover:shadow-md transition-all block">
                <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center"><Mail size={17} /></div>
                <p className="font-black text-slate-800 mt-2">Email Support</p><p className="text-[12px] text-slate-500">support@actin.co.in</p></a>
              <button onClick={() => navigate('/agents')} className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 text-left hover:border-slate-300 hover:shadow-md transition-all">
                <div className="w-9 h-9 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center"><MessageSquare size={17} /></div>
                <p className="font-black text-slate-800 mt-2">Go to Agents</p><p className="text-[12px] text-slate-500">Check fleet status &amp; health.</p></button>
            </Grid>
          </>
        )}

        {/* CTA (shown on every tab, aligned at the bottom) */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="font-black text-slate-800 flex items-center gap-2"><Gauge size={16} className="text-blue-600" /> Ready to onboard a client?</h3>
            <p className="text-[13px] text-slate-500 mt-0.5">Register the organization, tailor modules &amp; pages, and generate their installer.</p></div>
          <button onClick={() => navigate('/sales/register')} className="h-10 px-5 rounded-xl bg-blue-600 text-white font-bold text-sm hover:bg-blue-700 shadow flex items-center gap-2">Register an Organization <ChevronRight size={16} /></button>
        </div>
      </div>
    </div>
  );
}
