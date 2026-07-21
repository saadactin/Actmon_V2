import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronRight, ChevronLeft, Building2, Contact, FileCheck2, LayoutGrid, ServerCog, Package,
  Check, Loader2, Download, X, ShieldCheck, KeyRound, RefreshCw, Copy, Upload, FileDown, FileCheck,
} from 'lucide-react';
import { modulesApi, pagesApi } from '../../api/admin';
import { buildInstaller, triggerDownload, registerOrganization } from '../../api/onboarding';

const STEPS = [
  { id: 'company', label: 'Company', icon: Building2 },
  { id: 'contact', label: 'Contact & Address', icon: Contact },
  { id: 'policy', label: 'Policy', icon: FileCheck2 },
  { id: 'modules', label: 'Modules & Pages', icon: LayoutGrid },
  { id: 'deploy', label: 'Deployment', icon: ServerCog },
  { id: 'build', label: 'Build', icon: Package },
];

const genPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const a = new Uint32Array(14);
  (window.crypto || window.msCrypto).getRandomValues(a);
  return 'Am' + Array.from(a, (n) => chars[n % chars.length]).join('') + '#1';
};

const OS_OPTIONS = [['windows', 'Windows'], ['linux', 'Linux'], ['ubuntu', 'Ubuntu']];
const DB_OPTIONS = [['postgresql', 'PostgreSQL'], ['mysql', 'MySQL'], ['oracle', 'Oracle'], ['mssql', 'SQL Server'], ['mongodb', 'MongoDB'], ['clickhouse', 'ClickHouse']];

const Field = ({ label, req, children }) => (
  <div>
    <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-1.5">{label}{req && <span className="text-red-500"> *</span>}</label>
    {children}
  </div>
);
const inputCls = 'w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all';

const policyClauses = (orgName) => [
  ['1. License', `ActMon is licensed to ${orgName} for internal monitoring of its own database, server and cloud estate. Redistribution is prohibited without written consent from Actin Technologies.`],
  ['2. Data handling', "The agent collects performance metrics, slow queries, error events and host telemetry. Query text may be captured; no application row data is read. All data is stored in the organization's own deployment."],
  ['3. Security', 'The customer is responsible for securing the deployment host, database credentials, and admin accounts. Default credentials must be changed on first login.'],
  ['4. Support & updates', 'Agents self-update; platform updates are delivered per the support agreement. Availability targets are defined in the SLA.'],
  ['5. Liability', 'ActMon is provided "as is"; Actin Technologies is not liable for indirect damages arising from monitoring gaps or misconfiguration.'],
  ['6. Termination', "On termination the license ends and the customer must cease use; collected data remains in the customer's deployment."],
];

const EMPTY_ORG = {
  org_code: '', org_name: '', legal_name: '', cin_number: '', gst_number: '', pan_number: '',
  registration_no: '', industry: '', website_url: '',
  contact_person_name: '', contact_person_designation: '', contact_person_email: '', contact_person_no: '',
  contact_no: '', alternate_contact_no: '', email_id: '',
  address_line1: '', address_line2: '', city_name: '', state_name: '', country_name: 'India', pincode: '',
};

export default function RegisterOrgWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [org, setOrg] = useState(EMPTY_ORG);
  const [orgId, setOrgId] = useState(null);
  const [accepted, setAccepted] = useState(false);
  const [policyFile, setPolicyFile] = useState('');   // uploaded signed-policy filename

  const [modules, setModules] = useState([]);
  const [pages, setPages] = useState([]);
  const [selMods, setSelMods] = useState(new Set());
  const [selPages, setSelPages] = useState(new Set());

  const [deploy, setDeploy] = useState({ host: '', os_type: 'windows', app_port: 3000, db_type: 'postgresql', db_host: 'localhost', db_port: 5432 });
  const [cred, setCred] = useState({ username: 'actmon', password: '' });
  const [built, setBuilt] = useState(false);

  useEffect(() => { setCred((c) => ({ ...c, password: c.password || genPassword() })); }, []);
  useEffect(() => {
    Promise.all([modulesApi.list(), pagesApi.list()]).then(([m, p]) => { setModules(m || []); setPages(p || []); }).catch(() => {});
  }, []);
  useEffect(() => {
    const map = { postgresql: 5432, mysql: 3306, oracle: 1521, mssql: 1433, mongodb: 27017, clickhouse: 8123 };
    setDeploy((d) => ({ ...d, db_port: map[d.db_type] || d.db_port }));
  }, [deploy.db_type]);

  const setO = (k, v) => setOrg((o) => ({ ...o, [k]: v }));
  const setD = (k, v) => setDeploy((d) => ({ ...d, [k]: v }));

  const pagesByModule = useMemo(() => {
    const m = {}; pages.forEach((p) => { (m[p.module_id] = m[p.module_id] || []).push(p); }); return m;
  }, [pages]);

  const toggleModule = (mod) => {
    const id = mod.module_id; const mods = new Set(selMods); const pgs = new Set(selPages);
    const childIds = (pagesByModule[id] || []).map((p) => p.page_id);
    if (mods.has(id)) { mods.delete(id); childIds.forEach((c) => pgs.delete(c)); }
    else { mods.add(id); childIds.forEach((c) => pgs.add(c)); }
    setSelMods(mods); setSelPages(pgs);
  };
  const togglePage = (p) => {
    const pgs = new Set(selPages); pgs.has(p.page_id) ? pgs.delete(p.page_id) : pgs.add(p.page_id); setSelPages(pgs);
    const mods = new Set(selMods);
    (pagesByModule[p.module_id] || []).some((c) => pgs.has(c.page_id)) ? mods.add(p.module_id) : mods.delete(p.module_id);
    setSelMods(mods);
  };

  const canNext = () => {
    if (step === 0) return org.org_code.trim() && org.org_name.trim() && org.legal_name.trim();
    if (step === 1) return org.email_id.trim() && org.contact_no.trim() && org.country_name.trim() && org.state_name.trim() && org.city_name.trim();
    if (step === 2) return accepted;
    if (step === 3) return selMods.size > 0;
    if (step === 4) return deploy.host.trim() && cred.username.trim() && cred.password.trim();
    return true;
  };

  const next = async () => {
    setErr('');
    if (!canNext()) { setErr('Please complete the required fields.'); return; }
    // register the org once, after Contact & Address is filled
    if (step === 1 && !orgId) {
      setBusy(true);
      try {
        const res = await registerOrganization(org);
        setOrgId(res?.org_id || null);
      } catch (e) {
        setErr(e?.response?.data?.detail || e.message || 'Could not register the organization.');
        setBusy(false); return;
      }
      setBusy(false);
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const back = () => { setErr(''); setStep((s) => Math.max(0, s - 1)); };

  const downloadPolicy = () => {
    const name = org.org_name || 'the organization';
    const rows = policyClauses(name).map(([h, t]) => `<h3>${h}</h3><p>${t}</p>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ActMon - Service & Data Policy</title>
      <style>body{font-family:'Segoe UI',system-ui,sans-serif;color:#1e293b;max-width:800px;margin:40px auto;padding:0 28px;line-height:1.65}
      h1{font-size:22px;color:#0f172a}h3{font-size:14px;margin-top:16px;color:#1e293b}p{font-size:13px;color:#334155;margin-top:2px}
      .sig{margin-top:44px;border-top:1px solid #e2e8f0;padding-top:22px;font-size:12px;color:#475569}</style></head>
      <body><h1>ActMon - Service &amp; Data Policy</h1><p>Prepared for <b>${name}</b></p>${rows}
      <div class="sig">Accepted by: ____________________________  Date: ______________<br/><br/>Name / Designation: ____________________________</div>
      </body></html>`;
    const w = window.open('', '_blank', 'width=900,height=760');
    if (!w) { setErr('Allow popups to download the policy.'); return; }
    w.document.write(html); w.document.close();
    setTimeout(() => { try { w.print(); } catch (e) {} }, 500);
  };

  const config = () => ({
    organization: { org_id: orgId, ...org },
    policy_accepted: accepted,
    policy_document: policyFile || null,
    modules: modules.filter((m) => selMods.has(m.module_id)).map((m) => m.module_code || m.module_name),
    pages: pages.filter((p) => selPages.has(p.page_id)).map((p) => p.page_url || p.page_name),
    deployment: deploy,
    credentials: cred,
  });

  const doBuild = async () => {
    setBusy(true); setErr('');
    try {
      const blob = await buildInstaller(config());
      const slug = (org.org_code || org.org_name || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      triggerDownload(blob, `ActMon-${slug}-Setup.zip`);
      setBuilt(true);
    } catch (e) { setErr(e?.response?.data?.detail || e.message || 'Build failed.'); }
    finally { setBusy(false); }
  };

  const cur = STEPS[step];
  const CurIcon = cur.icon;
  const SUBTITLE = {
    company: 'Legal identity & statutory information',
    contact: 'Primary contact person and registered address',
    policy: 'Review and accept the terms to continue',
    modules: 'Tailor which modules & pages this client receives',
    deploy: 'Target server, database and admin credentials',
    build: 'Review the configuration and generate the installer',
  };

  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f5f9] flex flex-col pb-16">
      {/* HERO */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 md:px-10 pt-3 pb-4 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
        <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5">
          <span>ActMon</span><ChevronRight size={11} />
          <button onClick={() => navigate('/sales')} className="hover:text-slate-200">Sales</button>
          <ChevronRight size={11} /><span className="text-white font-semibold">Register Organization</span>
        </div>
        <div className="relative flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-sky-400/20 border border-sky-400/40 flex items-center justify-center flex-shrink-0"><Building2 size={18} className="text-sky-200" /></div>
            <div>
              <h1 className="text-lg font-black text-white tracking-tight leading-none">Register Organization</h1>
              <p className="text-sky-200/70 text-[11px] mt-0.5">Onboard a client, tailor the product &amp; generate their installer</p>
            </div>
          </div>
          <button onClick={() => navigate('/sales')} title="Close" className="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 flex items-center justify-center text-white"><X size={18} /></button>
        </div>
      </div>

      {/* stepper card */}
      <div className="px-6 md:px-10 pt-5 max-w-[1400px] mx-auto w-full">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-6 py-5">
          <div className="flex items-center justify-between">
            {STEPS.map((s, i) => {
              const Ico = s.icon; const done = i < step; const active = i === step;
              return (
                <React.Fragment key={s.id}>
                  <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center font-black text-sm transition-all ${done ? 'bg-emerald-500 text-white' : active ? 'bg-blue-600 text-white ring-4 ring-blue-100' : 'bg-slate-100 text-slate-400'}`}>
                      {done ? <Check size={18} /> : <Ico size={17} />}
                    </div>
                    <span className={`text-[11px] font-bold text-center ${active ? 'text-blue-700' : done ? 'text-emerald-600' : 'text-slate-400'}`}>{s.label}</span>
                  </div>
                  {i < STEPS.length - 1 && <div className={`flex-1 h-0.5 mx-1 mb-5 ${i < step ? 'bg-emerald-400' : 'bg-slate-200'}`} />}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* body card */}
      <div className="flex-1 px-6 md:px-10 py-5 max-w-[1400px] mx-auto w-full">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3 bg-slate-50/60">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-sky-600 flex items-center justify-center text-white flex-shrink-0"><CurIcon size={19} /></div>
            <div>
              <h2 className="text-[15px] font-black text-slate-800 leading-none">{cur.label}</h2>
              <p className="text-[12px] text-slate-500 mt-1">{SUBTITLE[cur.id]}</p>
            </div>
            <span className="ml-auto text-[11px] font-bold text-slate-400">Step {step + 1} of {STEPS.length}</span>
          </div>
          <div className="p-6 md:p-8">
        {/* Step 0 — Company */}
        {step === 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <Field label="Org Code" req><input className={inputCls} value={org.org_code} onChange={(e) => setO('org_code', e.target.value)} placeholder="ACME" /></Field>
            <Field label="Organization Name" req><input className={inputCls} value={org.org_name} onChange={(e) => setO('org_name', e.target.value)} placeholder="Acme Corp" /></Field>
            <Field label="Legal Name" req><input className={inputCls} value={org.legal_name} onChange={(e) => setO('legal_name', e.target.value)} placeholder="Acme Corporation Pvt. Ltd." /></Field>
            <Field label="CIN No"><input className={inputCls} value={org.cin_number} onChange={(e) => setO('cin_number', e.target.value)} placeholder="U72900MH2020PTC000000" /></Field>
            <Field label="GST No"><input className={inputCls} value={org.gst_number} onChange={(e) => setO('gst_number', e.target.value)} placeholder="27ABCDE1234F1Z5" /></Field>
            <Field label="PAN No"><input className={inputCls} value={org.pan_number} onChange={(e) => setO('pan_number', e.target.value)} placeholder="ABCDE1234F" /></Field>
            <Field label="Registration No"><input className={inputCls} value={org.registration_no} onChange={(e) => setO('registration_no', e.target.value)} /></Field>
            <Field label="Industry"><input className={inputCls} value={org.industry} onChange={(e) => setO('industry', e.target.value)} placeholder="IT Services / BFSI / Retail…" /></Field>
            <Field label="Website"><input className={inputCls} value={org.website_url} onChange={(e) => setO('website_url', e.target.value)} placeholder="https://acme.com" /></Field>
          </div>
        )}

        {/* Step 1 — Contact & Address */}
        {step === 1 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <Field label="Contact Person Name"><input className={inputCls} value={org.contact_person_name} onChange={(e) => setO('contact_person_name', e.target.value)} placeholder="Full name" /></Field>
            <Field label="Designation"><input className={inputCls} value={org.contact_person_designation} onChange={(e) => setO('contact_person_designation', e.target.value)} placeholder="IT Manager / CTO" /></Field>
            <Field label="Person Contact No"><input className={inputCls} value={org.contact_person_no} onChange={(e) => setO('contact_person_no', e.target.value)} placeholder="+91 …" /></Field>
            <Field label="Person Email"><input type="email" className={inputCls} value={org.contact_person_email} onChange={(e) => setO('contact_person_email', e.target.value)} placeholder="person@acme.com" /></Field>
            <Field label="Company Email" req><input type="email" className={inputCls} value={org.email_id} onChange={(e) => setO('email_id', e.target.value)} placeholder="admin@acme.com" /></Field>
            <Field label="Contact No" req><input className={inputCls} value={org.contact_no} onChange={(e) => setO('contact_no', e.target.value)} placeholder="+91 …" /></Field>
            <Field label="Alternate Contact"><input className={inputCls} value={org.alternate_contact_no} onChange={(e) => setO('alternate_contact_no', e.target.value)} placeholder="+91 …" /></Field>
            <Field label="Address Line 1"><input className={inputCls} value={org.address_line1} onChange={(e) => setO('address_line1', e.target.value)} placeholder="Street / building" /></Field>
            <Field label="Address Line 2"><input className={inputCls} value={org.address_line2} onChange={(e) => setO('address_line2', e.target.value)} placeholder="Area / landmark" /></Field>
            <Field label="City" req><input className={inputCls} value={org.city_name} onChange={(e) => setO('city_name', e.target.value)} placeholder="City" /></Field>
            <Field label="State" req><input className={inputCls} value={org.state_name} onChange={(e) => setO('state_name', e.target.value)} placeholder="State" /></Field>
            <Field label="Country" req><input className={inputCls} value={org.country_name} onChange={(e) => setO('country_name', e.target.value)} placeholder="Country" /></Field>
            <Field label="Pincode"><input className={inputCls} value={org.pincode} onChange={(e) => setO('pincode', e.target.value)} placeholder="Postal code" /></Field>
          </div>
        )}

        {/* Step 2 — Policy */}
        {step === 2 && (
          <div className="max-w-3xl mx-auto">
            {/* toolbar: download / upload */}
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <p className="text-[13px] text-slate-500">Review the policy, download a copy for signature, and optionally upload the signed document.</p>
              <div className="flex items-center gap-2">
                <button onClick={downloadPolicy} className="h-9 px-3.5 rounded-lg border border-slate-200 text-slate-700 text-sm font-bold flex items-center gap-1.5 hover:bg-slate-50">
                  <FileDown size={15} /> Download PDF
                </button>
                <label className="h-9 px-3.5 rounded-lg bg-blue-50 border border-blue-200 text-blue-700 text-sm font-bold flex items-center gap-1.5 hover:bg-blue-100 cursor-pointer">
                  <Upload size={15} /> Upload signed
                  <input type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) setPolicyFile(f.name); }} />
                </label>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 max-h-[42vh] overflow-y-auto text-[13px] text-slate-600 leading-relaxed space-y-3">
              {policyClauses(org.org_name || 'the organization').map(([h, t]) => (
                <p key={h}><b className="text-slate-800">{h}.</b> {t}</p>
              ))}
            </div>

            {policyFile && (
              <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-[13px] font-semibold">
                <FileCheck size={16} /> Signed policy attached: <span className="font-mono truncate max-w-[280px]">{policyFile}</span>
                <button onClick={() => setPolicyFile('')} className="ml-auto text-emerald-600 hover:text-emerald-800"><X size={14} /></button>
              </div>
            )}

            <label className="flex items-center gap-2.5 mt-4 cursor-pointer">
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="w-5 h-5 rounded accent-blue-600" />
              <span className="text-sm font-bold text-slate-700">I have read and accept the policy on behalf of {org.org_name || 'the organization'}.</span>
            </label>
          </div>
        )}

        {/* Step 3 — Modules */}
        {step === 3 && (
          <div>
            <div className="flex items-center justify-between gap-3 mb-4">
              <p className="text-sm text-slate-500">Choose the modules this client's ActMon should include. Every page inside a selected module is included automatically.</p>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button onClick={() => { setSelMods(new Set(modules.filter((m) => (m.module_code || '') !== 'SALES').map((m) => m.module_id))); setSelPages(new Set(pages.map((p) => p.page_id))); }}
                  className="h-8 px-3 rounded-lg border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50">Select all</button>
                <button onClick={() => { setSelMods(new Set()); setSelPages(new Set()); }}
                  className="h-8 px-3 rounded-lg border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50">Clear</button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {modules.filter((m) => (m.module_code || '') !== 'SALES').map((m) => {
                const childPages = pagesByModule[m.module_id] || []; const on = selMods.has(m.module_id);
                return (
                  <button key={m.module_id} type="button" onClick={() => toggleModule(m)}
                    className={`flex items-center gap-3 px-4 py-3.5 rounded-2xl border text-left transition-all ${on ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-100' : 'border-slate-200 hover:border-slate-300'}`}>
                    <span className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 ${on ? 'bg-blue-600 border-blue-600' : 'border-slate-300'}`}>{on && <Check size={13} className="text-white" />}</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-black text-slate-800 text-[14px] truncate">{m.module_name}</p>
                      <p className="text-[11px] text-slate-400">{childPages.length} page{childPages.length !== 1 ? 's' : ''}</p>
                    </div>
                  </button>
                );
              })}
            </div>
            <p className="text-[12px] text-slate-500 mt-3">{selMods.size} module(s) selected · {selPages.size} pages included.</p>
          </div>
        )}

        {/* Step 4 — Deployment */}
        {step === 4 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl">
            <div className="sm:col-span-2 lg:col-span-3"><Field label="Deployment Host / IP" req><input className={inputCls} value={deploy.host} onChange={(e) => setD('host', e.target.value)} placeholder="10.0.0.5 or app.acme.com" /></Field></div>
            <Field label="Operating System" req><select className={inputCls} value={deploy.os_type} onChange={(e) => setD('os_type', e.target.value)}>{OS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="App Port"><input type="number" className={inputCls} value={deploy.app_port} onChange={(e) => setD('app_port', e.target.value)} /></Field>
            <Field label="Database Engine" req><select className={inputCls} value={deploy.db_type} onChange={(e) => setD('db_type', e.target.value)}>{DB_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="DB Host"><input className={inputCls} value={deploy.db_host} onChange={(e) => setD('db_host', e.target.value)} /></Field>
            <Field label="DB Port"><input type="number" className={inputCls} value={deploy.db_port} onChange={(e) => setD('db_port', e.target.value)} /></Field>
            <div className="hidden lg:block" />
            <div className="sm:col-span-2 lg:col-span-3 border-t border-slate-100 pt-4 mt-1">
              <p className="text-[11px] font-black text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-1.5"><KeyRound size={13} /> Super Admin credentials (bundled into the build)</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl">
                <Field label="Username" req><input className={inputCls} value={cred.username} onChange={(e) => setCred((c) => ({ ...c, username: e.target.value }))} /></Field>
                <Field label="Password" req>
                  <div className="flex gap-2">
                    <input className={inputCls} value={cred.password} onChange={(e) => setCred((c) => ({ ...c, password: e.target.value }))} />
                    <button onClick={() => setCred((c) => ({ ...c, password: genPassword() }))} title="Regenerate" className="h-11 w-11 rounded-xl border border-slate-200 flex items-center justify-center text-slate-500 hover:bg-slate-50 flex-shrink-0"><RefreshCw size={15} /></button>
                  </div>
                </Field>
              </div>
            </div>
          </div>
        )}

        {/* Step 5 — Build */}
        {step === 5 && (
          <div className="space-y-4 max-w-3xl mx-auto">
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2"><span className="w-1 h-5 rounded-full bg-gradient-to-b from-blue-500 to-sky-500" /><h3 className="text-sm font-black text-slate-700 uppercase tracking-wider">Build Summary</h3></div>
              <dl className="divide-y divide-slate-100 text-sm">
                {[
                  ['Organization', `${org.org_name} (${org.org_code})${orgId ? ` · #${orgId}` : ''}`],
                  ['CIN / GST', `${org.cin_number || '—'} / ${org.gst_number || '—'}`],
                  ['Contact person', `${org.contact_person_name || '—'}${org.contact_person_no ? ` · ${org.contact_person_no}` : ''}`],
                  ['Modules / Pages', `${selMods.size} modules · ${selPages.size} pages`],
                  ['Deploy target', `${deploy.host || '—'} · ${deploy.os_type} · app:${deploy.app_port}`],
                  ['Database', `${deploy.db_type} @ ${deploy.db_host}:${deploy.db_port}`],
                ].map(([k, v]) => (
                  <div key={k} className="px-5 py-3 grid grid-cols-3 gap-3"><dt className="text-[11px] font-black text-slate-500 uppercase tracking-wider">{k}</dt><dd className="col-span-2 font-semibold text-slate-800">{v}</dd></div>
                ))}
              </dl>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
              <ShieldCheck size={20} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-[13px] text-amber-800">
                <p className="font-bold">Admin credentials (bundled in the installer)</p>
                <p className="mt-1 flex items-center gap-2 font-mono">{cred.username} / {cred.password}
                  <button onClick={() => navigator.clipboard.writeText(`${cred.username} / ${cred.password}`)} className="text-amber-700 hover:text-amber-900"><Copy size={13} /></button>
                </p>
                <p className="text-[11px] mt-1 text-amber-700">Share only over a secure channel. The client must change it on first login.</p>
              </div>
            </div>

            {!built ? (
              <button onClick={doBuild} disabled={busy} className="w-full h-12 rounded-xl bg-gradient-to-r from-blue-600 to-sky-600 text-white font-black text-sm shadow-lg shadow-blue-200 disabled:opacity-60 flex items-center justify-center gap-2">
                {busy ? <><Loader2 size={18} className="animate-spin" /> Building installer…</> : <><Package size={18} /> Build &amp; Download Installer (.zip)</>}
              </button>
            ) : (
              <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 text-center">
                <div className="w-12 h-12 rounded-2xl bg-emerald-500 text-white flex items-center justify-center mx-auto mb-2"><Check size={26} /></div>
                <p className="font-black text-emerald-800">Installer built &amp; downloaded</p>
                <p className="text-[13px] text-emerald-700 mt-1">The .zip contains the app build, deploy.json, install scripts &amp; README.</p>
                <div className="flex items-center justify-center gap-2 mt-3">
                  <button onClick={doBuild} className="h-9 px-4 rounded-lg bg-white border border-emerald-200 text-emerald-700 font-bold text-sm flex items-center gap-1.5"><Download size={14} /> Download again</button>
                  <button onClick={() => navigate('/sales')} className="h-9 px-4 rounded-lg bg-emerald-600 text-white font-bold text-sm">Done</button>
                </div>
              </div>
            )}
          </div>
        )}

            {err && <p className="mt-4 text-sm font-bold text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{err}</p>}
          </div>

          {/* in-card footer nav */}
          {step < 5 && (
            <div className="border-t border-slate-100 px-6 py-4 flex items-center justify-between bg-slate-50/60">
              <button onClick={back} disabled={step === 0} className="h-10 px-4 rounded-lg text-slate-600 text-sm font-bold hover:bg-slate-200/70 disabled:opacity-40 flex items-center gap-1"><ChevronLeft size={16} /> Back</button>
              <button onClick={next} disabled={busy || !canNext()} className="h-10 px-6 rounded-lg bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 disabled:opacity-40 flex items-center gap-1.5 shadow-sm">
                {busy ? <Loader2 size={16} className="animate-spin" /> : null}
                {step === 1 ? 'Register & Continue' : 'Continue'} <ChevronRight size={16} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
