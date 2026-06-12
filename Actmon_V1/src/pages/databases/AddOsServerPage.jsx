import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, CheckCircle2, AlertTriangle, Server, ShieldCheck,
  Monitor, Network, Database, Save, Loader2, GitBranch,
  ChevronRight, Terminal, Wifi, Key, Globe, Tag,
  Layers, CheckCheck, X, Eye, EyeOff, Cpu,
} from 'lucide-react';

import { createOsServer, testSshConnection, listOsServers } from '../../api/servers';

/* ── static config ────────────────────────────────── */
const OPERATING_SYSTEMS = [
  { name:'Linux',        icon:'🐧', color:'from-slate-800 to-slate-700' },
  { name:'Ubuntu',       icon:'🟠', color:'from-orange-700 to-orange-600' },
  { name:'Windows',      icon:'🪟', color:'from-blue-800 to-blue-700' },
  { name:'CentOS',       icon:'⚫', color:'from-slate-700 to-slate-600' },
  { name:'Oracle Linux', icon:'🔴', color:'from-red-800 to-red-700' },
  { name:'RedHat',       icon:'🎩', color:'from-red-700 to-rose-700' },
];

const DATABASE_SERVICES = [
  { name:'MySQL',      color:'bg-orange-100 text-orange-700 border-orange-300',  active:'bg-orange-500 text-white border-orange-500' },
  { name:'MariaDB',    color:'bg-orange-100 text-orange-700 border-orange-300',  active:'bg-orange-500 text-white border-orange-500' },
  { name:'PostgreSQL', color:'bg-indigo-100 text-indigo-700 border-indigo-300',  active:'bg-indigo-500 text-white border-indigo-500' },
  { name:'Oracle',     color:'bg-red-100 text-red-700 border-red-300',            active:'bg-red-500 text-white border-red-500' },
  { name:'MongoDB',    color:'bg-emerald-100 text-emerald-700 border-emerald-300',active:'bg-emerald-500 text-white border-emerald-500' },
  { name:'MSSQL',      color:'bg-sky-100 text-sky-700 border-sky-300',            active:'bg-sky-500 text-white border-sky-500' },
  { name:'ClickHouse', color:'bg-yellow-100 text-yellow-700 border-yellow-300',   active:'bg-yellow-500 text-white border-yellow-500' },
];

const NODE_TYPES = [
  { value:'Standalone',   label:'Standalone',   icon:'○', desc:'Single server, no HA',                color:'border-slate-200  bg-slate-50   text-slate-700',   active:'border-slate-800 bg-slate-900 text-white' },
  { value:'Primary',      label:'Primary',      icon:'★', desc:'Replication primary / source',        color:'border-emerald-200 bg-emerald-50 text-emerald-800', active:'border-emerald-600 bg-emerald-600 text-white' },
  { value:'Secondary',    label:'Secondary',    icon:'◎', desc:'Replication replica',                 color:'border-blue-200   bg-blue-50    text-blue-800',     active:'border-blue-600 bg-blue-600 text-white' },
  { value:'Master',       label:'Master',       icon:'▲', desc:'Legacy master node',                  color:'border-emerald-200 bg-emerald-50 text-emerald-800', active:'border-emerald-600 bg-emerald-600 text-white' },
  { value:'Slave',        label:'Slave',        icon:'▽', desc:'Legacy replica',                      color:'border-blue-200   bg-blue-50    text-blue-800',     active:'border-blue-600 bg-blue-600 text-white' },
  { value:'Galera Node',  label:'Galera Node',  icon:'⬡', desc:'Galera / PXC multi-primary',         color:'border-purple-200 bg-purple-50  text-purple-800',   active:'border-purple-600 bg-purple-600 text-white' },
  { value:'Arbiter',      label:'Arbiter',      icon:'◇', desc:'Quorum / tiebreaker, no data',       color:'border-amber-200  bg-amber-50   text-amber-800',    active:'border-amber-500 bg-amber-500 text-white' },
  { value:'Cluster Node', label:'Cluster Node', icon:'⬡', desc:'Generic cluster member',             color:'border-slate-200  bg-slate-50   text-slate-700',    active:'border-slate-700 bg-slate-800 text-white' },
];

const ENVIRONMENTS = ['Production', 'UAT', 'Development', 'Testing'];

/* ══════════════════════════════════════════════════════
   PAGE
══════════════════════════════════════════════════════ */
export default function AddOsServerPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [selectedOs, setSelectedOs]       = useState('Linux');
  const [selectedDbs, setSelectedDbs]     = useState([]);
  const [loading, setLoading]             = useState(false);
  const [testing, setTesting]             = useState(false);
  const [sshTested, setSshTested]         = useState(false);
  const [message, setMessage]             = useState(null);
  const [showPass, setShowPass]           = useState(false);

  const { register, handleSubmit, getValues, setValue, watch, formState: { errors } } = useForm({
    defaultValues: { ssh_port:22, environment:'Production', node_type:'Standalone', monitoring_enabled:true, auto_discovery:true },
  });

  const nodeType = watch('node_type');
  const watchCluster = watch('cluster_name');

  const { data: serversData } = useQuery({
    queryKey: ['osServers'],
    queryFn: () => listOsServers(),
    staleTime: 30000,
  });
  const existingClusters = [...new Set(
    (serversData?.data || serversData || []).map((s) => s.cluster_name).filter(Boolean)
  )];

  const toggleDb = (db) =>
    setSelectedDbs((prev) => prev.includes(db) ? prev.filter((d) => d !== db) : [...prev, db]);

  const handleTestSsh = async () => {
    const v = getValues();
    if (!v.ip_address || !v.ssh_username) {
      setMessage({ type:'error', text:'Fill in Host IP and SSH Username first.' });
      return;
    }
    setTesting(true); setMessage(null); setSshTested(false);
    try {
      const res = await testSshConnection({
        ip_address: v.ip_address,
        ssh_port: Number(v.ssh_port)||22,
        ssh_username: v.ssh_username,
        ssh_password: v.ssh_password||'',
      });
      setMessage({ type:'success', text:`SSH connected — ${res.message}` });
      setSshTested(true);
    } catch (err) {
      setMessage({ type:'error', text: err?.response?.data?.detail || err.message || 'SSH test failed' });
    } finally { setTesting(false); }
  };

  const onSubmit = async (data) => {
    setLoading(true); setMessage(null);
    try {
      await createOsServer({
        server_name: data.server_name,
        hostname: data.hostname || data.ip_address,
        ip_address: data.ip_address,
        os_type: selectedOs,
        environment: data.environment,
        node_type: data.node_type,
        cluster_name: data.cluster_name || null,
        ssh_port: Number(data.ssh_port)||22,
        ssh_username: data.ssh_username,
        ssh_password: data.ssh_password,
        database_services: selectedDbs,
        monitoring_enabled: data.monitoring_enabled===true || data.monitoring_enabled==='true',
        auto_discovery: data.auto_discovery===true || data.auto_discovery==='true',
      });
      qc.invalidateQueries(['osServers']);
      qc.invalidateQueries(['serverSummary']);
      setMessage({ type:'success', text:'Server registered successfully! Redirecting…' });
      setTimeout(() => navigate('/databases'), 1200);
    } catch (err) {
      setMessage({ type:'error', text: err?.response?.data?.detail || err.message || 'Failed to save server' });
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-[#f1f4f9]">

      {/* ══ HERO HEADER ══ */}
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 px-6 py-6 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.03]"
          style={{ backgroundImage:'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize:'32px 32px' }}/>

        {/* breadcrumb */}
        <div className="relative flex items-center gap-2 text-xs text-slate-500 mb-5">
          <button onClick={()=>navigate('/databases')} className="hover:text-slate-300 transition-colors">Infrastructure</button>
          <ChevronRight size={11}/>
          <span className="text-slate-300 font-semibold">Add OS Server</span>
        </div>

        <div className="relative flex items-center gap-4">
          <button
            onClick={() => navigate('/databases')}
            className="w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 border border-white/10 flex items-center justify-center text-white transition-all flex-shrink-0"
          >
            <ArrowLeft size={18}/>
          </button>
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center flex-shrink-0">
              <Server size={22} className="text-indigo-300"/>
            </div>
            <div>
              <h1 className="text-2xl font-black text-white tracking-tight leading-none">Add OS Server</h1>
              <p className="text-slate-400 text-xs mt-0.5">Register a new server for OS-level monitoring and SSH access</p>
            </div>
          </div>

          {/* step pills */}
          <div className="ml-auto hidden md:flex items-center gap-2">
            {['OS Type','SSH Access','Node Role','Services','Save'].map((s,i) => (
              <div key={s} className="flex items-center gap-1.5">
                <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 border border-white/10">
                  <span className="w-4 h-4 rounded-full bg-indigo-500/50 text-white text-[9px] font-black flex items-center justify-center">{i+1}</span>
                  <span className="text-[10px] font-semibold text-slate-300">{s}</span>
                </div>
                {i < 4 && <ChevronRight size={10} className="text-slate-600"/>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ══ CONTENT ══ */}
      <div className="max-w-5xl mx-auto px-6 py-6">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">

          {/* ── SECTION 1: OS ── */}
          <Section icon={<Monitor size={16} className="text-indigo-400"/>} title="Operating System" subtitle="Select the OS running on this server">
            <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
              {OPERATING_SYSTEMS.map((os) => (
                <button key={os.name} type="button" onClick={() => setSelectedOs(os.name)}
                  className={`relative h-[88px] rounded-2xl border-2 transition-all overflow-hidden group
                    ${selectedOs===os.name
                      ? 'border-indigo-500 shadow-lg shadow-indigo-100 ring-2 ring-indigo-200'
                      : 'border-slate-200 hover:border-indigo-300 hover:shadow-md'}`}>
                  {selectedOs===os.name && (
                    <div className="absolute inset-0 bg-gradient-to-br from-indigo-50 to-white"/>
                  )}
                  <div className="relative flex flex-col items-center justify-center h-full gap-1.5">
                    <span className="text-3xl leading-none">{os.icon}</span>
                    <span className={`text-[11px] font-bold ${selectedOs===os.name?'text-indigo-700':'text-slate-600'}`}>{os.name}</span>
                    {selectedOs===os.name && (
                      <span className="absolute top-2 right-2 w-4 h-4 rounded-full bg-indigo-500 flex items-center justify-center">
                        <CheckCheck size={9} className="text-white"/>
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </Section>

          {/* ── SECTION 2: Identity ── */}
          <Section icon={<Tag size={16} className="text-slate-400"/>} title="Server Identity" subtitle="Name and network details">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Server Name" required error={errors.server_name?.message}>
                <InputWithIcon icon={<Server size={14} className="text-slate-400"/>}>
                  <input {...register('server_name',{required:'Server name is required'})}
                    placeholder="DB-OS-PROD-01" className={iCls}/>
                </InputWithIcon>
              </Field>

              <Field label="Host IP Address" required error={errors.ip_address?.message}>
                <InputWithIcon icon={<Globe size={14} className="text-slate-400"/>}>
                  <input {...register('ip_address',{required:'IP address is required'})}
                    placeholder="192.168.1.10" className={iCls}/>
                </InputWithIcon>
              </Field>

              <Field label="Hostname (FQDN)">
                <InputWithIcon icon={<Network size={14} className="text-slate-400"/>}>
                  <input {...register('hostname')} placeholder="db-01.company.local" className={iCls}/>
                </InputWithIcon>
              </Field>

              <Field label="Environment">
                <div className="flex gap-2 flex-wrap">
                  {ENVIRONMENTS.map((env) => (
                    <button key={env} type="button"
                      onClick={() => setValue('environment', env)}
                      className={`h-9 px-4 rounded-xl text-[12px] font-bold border transition-all ${
                        watch('environment')===env
                          ? 'bg-slate-900 text-white border-slate-900 shadow'
                          : 'border-slate-200 text-slate-600 hover:border-slate-400 bg-white'}`}>
                      {env}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          </Section>

          {/* ── SECTION 3: SSH ── */}
          <Section icon={<Terminal size={16} className="text-emerald-400"/>} title="SSH Access" subtitle="Credentials for live OS metric collection">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="SSH Username" required error={errors.ssh_username?.message}>
                <InputWithIcon icon={<Key size={14} className="text-slate-400"/>}>
                  <input {...register('ssh_username',{required:'SSH username is required'})}
                    placeholder="root" className={iCls}/>
                </InputWithIcon>
              </Field>

              <Field label="SSH Port" required>
                <InputWithIcon icon={<Wifi size={14} className="text-slate-400"/>}>
                  <input type="number" {...register('ssh_port')} className={iCls}/>
                </InputWithIcon>
              </Field>

              <Field label="SSH Password" className="md:col-span-2">
                <div className="relative">
                  <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"><Key size={14}/></div>
                  <input type={showPass?'text':'password'} {...register('ssh_password')}
                    placeholder="••••••••••" className={`${iCls} pl-9 pr-10`}/>
                  <button type="button" onClick={()=>setShowPass(v=>!v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                    {showPass ? <EyeOff size={14}/> : <Eye size={14}/>}
                  </button>
                </div>
              </Field>
            </div>

            {/* test SSH */}
            <div className="mt-4 flex items-center gap-3 flex-wrap">
              <button type="button" onClick={handleTestSsh} disabled={testing}
                className={`h-9 px-5 rounded-xl font-bold text-[12px] flex items-center gap-2 transition-all border ${
                  sshTested
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                    : 'bg-white border-slate-300 text-slate-700 hover:border-indigo-400 hover:text-indigo-700'}`}>
                {testing ? <Loader2 size={13} className="animate-spin"/> : sshTested ? <CheckCircle2 size={13}/> : <Terminal size={13}/>}
                {testing ? 'Connecting…' : sshTested ? 'SSH Connected' : 'Test SSH Connection'}
              </button>
              <p className="text-[11px] text-slate-400">Verify credentials before saving</p>
            </div>
          </Section>

          {/* ── SECTION 4: Node role ── */}
          <Section icon={<GitBranch size={16} className="text-purple-400"/>} title="Node Role" subtitle="Define this server's role in your topology">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {NODE_TYPES.map((nt) => (
                <button key={nt.value} type="button" onClick={() => setValue('node_type', nt.value)}
                  className={`relative p-3 rounded-xl border-2 text-left transition-all ${
                    nodeType===nt.value ? nt.active+' shadow-md' : nt.color+' hover:shadow'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg leading-none">{nt.icon}</span>
                    <span className="text-[11px] font-black uppercase tracking-wide">{nt.label}</span>
                    {nodeType===nt.value && <CheckCheck size={11} className="ml-auto"/>}
                  </div>
                  <p className={`text-[10px] leading-tight ${nodeType===nt.value?'opacity-80':'text-slate-400'}`}>{nt.desc}</p>
                </button>
              ))}
            </div>

            {/* cluster name */}
            {nodeType !== 'Standalone' && (
              <div className="mt-4 p-4 bg-purple-50/50 border border-purple-100 rounded-xl">
                <Field label="Cluster Name" required error={errors.cluster_name?.message}>
                  {existingClusters.length > 0 && (
                    <div className="mb-2.5">
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wide mb-1.5 flex items-center gap-1">
                        <GitBranch size={10}/> Join existing cluster
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {existingClusters.map((cl) => (
                          <button key={cl} type="button" onClick={() => setValue('cluster_name', cl)}
                            className={`px-3 h-7 rounded-lg text-[11px] font-bold border transition-all ${
                              watchCluster===cl
                                ? 'bg-purple-600 border-purple-600 text-white'
                                : 'border-purple-200 bg-white text-purple-700 hover:border-purple-400'}`}>
                            {cl}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <InputWithIcon icon={<Layers size={14} className="text-slate-400"/>}>
                    <input
                      {...register('cluster_name',{ required: nodeType!=='Standalone'?'Cluster name is required':false })}
                      list="cluster-datalist"
                      placeholder={existingClusters.length ? 'Or enter a new cluster name…' : 'PROD-MYSQL-CLUSTER-01'}
                      className={iCls}/>
                  </InputWithIcon>
                  <datalist id="cluster-datalist">{existingClusters.map((cl) => <option key={cl} value={cl}/>)}</datalist>
                </Field>
              </div>
            )}
          </Section>

          {/* ── SECTION 5: DB services ── */}
          <Section icon={<Database size={16} className="text-orange-400"/>} title="Database Services" subtitle="Which databases are running on this server?">
            <div className="flex flex-wrap gap-2.5">
              {DATABASE_SERVICES.map((db) => {
                const on = selectedDbs.includes(db.name);
                return (
                  <button key={db.name} type="button" onClick={() => toggleDb(db.name)}
                    className={`h-9 px-4 rounded-xl text-[12px] font-bold border transition-all flex items-center gap-1.5 ${
                      on ? db.active : db.color+' hover:shadow-sm'}`}>
                    {on && <CheckCheck size={11}/>}
                    {db.name}
                  </button>
                );
              })}
            </div>
            {selectedDbs.length === 0 && (
              <p className="text-[11px] text-slate-400 mt-2">Select at least one database service for auto-discovery.</p>
            )}
          </Section>

          {/* ── SECTION 6: Options ── */}
          <Section icon={<Cpu size={16} className="text-blue-400"/>} title="Monitoring Options" subtitle="Control what gets collected">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <ToggleField
                label="Live Monitoring"
                description="Collect CPU, RAM, Disk metrics via SSH"
                name="monitoring_enabled"
                register={register}
                watch={watch}
                setValue={setValue}
              />
              <ToggleField
                label="Auto Discovery"
                description="Detect installed DB services automatically"
                name="auto_discovery"
                register={register}
                watch={watch}
                setValue={setValue}
              />
            </div>
          </Section>

          {/* ── FEATURE INFO STRIP ── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { icon:<ShieldCheck size={18} className="text-emerald-500"/>, title:'SSH Encrypted',  desc:'All connections use SSH tunnels — no credentials stored in plain text.' },
              { icon:<Monitor size={18} className="text-blue-500"/>,       title:'Real-time Metrics', desc:'CPU, RAM, and disk usage collected live over SSH every 60 seconds.' },
              { icon:<Network size={18} className="text-purple-500"/>,     title:'Auto-Discovery',  desc:'Detects installed databases and suggests connection configs automatically.' },
            ].map(({ icon, title, desc }) => (
              <div key={title} className="bg-white rounded-2xl border border-slate-200 p-4 flex gap-3">
                <div className="w-9 h-9 rounded-xl bg-slate-50 flex items-center justify-center flex-shrink-0">{icon}</div>
                <div>
                  <p className="text-[12px] font-black text-slate-800">{title}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* ── MESSAGE ── */}
          {message && (
            <div className={`rounded-2xl px-5 py-4 border flex items-start gap-3 ${
              message.type==='success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                : 'bg-red-50 border-red-200 text-red-700'}`}>
              {message.type==='success' ? <CheckCircle2 size={18} className="flex-shrink-0 mt-0.5"/> : <AlertTriangle size={18} className="flex-shrink-0 mt-0.5"/>}
              <p className="text-sm font-semibold">{message.text}</p>
            </div>
          )}

          {/* ── ACTIONS ── */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
            <button type="button" onClick={() => navigate('/databases')}
              className="h-10 px-5 rounded-xl border border-slate-200 text-slate-600 font-semibold text-sm hover:bg-slate-50 flex items-center gap-2 transition-all">
              <X size={14}/> Cancel
            </button>

            <div className="flex items-center gap-3">
              <button type="button" onClick={handleTestSsh} disabled={testing}
                className="h-10 px-5 rounded-xl border border-slate-300 font-semibold text-sm hover:bg-slate-50 flex items-center gap-2 transition-all text-slate-700">
                {testing ? <Loader2 size={14} className="animate-spin"/> : <Terminal size={14}/>}
                {testing ? 'Testing…' : 'Test SSH'}
              </button>

              <button type="submit" disabled={loading}
                className="h-10 px-6 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm flex items-center gap-2 shadow-lg shadow-indigo-200 transition-all">
                {loading ? <Loader2 size={14} className="animate-spin"/> : <Save size={14}/>}
                {loading ? 'Saving…' : 'Register Server'}
              </button>
            </div>
          </div>

        </form>
      </div>
    </div>
  );
}

/* ── helper components ───────────────────────────── */
function Section({ icon, title, subtitle, children }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 bg-slate-50/50">
        <div className="w-7 h-7 rounded-lg bg-white border border-slate-200 flex items-center justify-center shadow-sm">
          {icon}
        </div>
        <div>
          <h2 className="text-[13px] font-black text-slate-800">{title}</h2>
          {subtitle && <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function Field({ label, required, error, children, className='' }) {
  return (
    <div className={className}>
      <label className="block text-[12px] font-bold text-slate-600 mb-1.5 uppercase tracking-wide">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {error && <p className="text-red-500 text-[11px] mt-1 flex items-center gap-1"><AlertTriangle size={10}/>{error}</p>}
    </div>
  );
}

function InputWithIcon({ icon, children }) {
  return (
    <div className="relative">
      <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">{icon}</div>
      {React.cloneElement(children, { className: iCls + ' pl-9' })}
    </div>
  );
}

function ToggleField({ label, description, name, register, watch, setValue }) {
  const val = watch(name);
  const isOn = val === true || val === 'true';
  return (
    <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors">
      <div>
        <p className="text-[12px] font-black text-slate-800">{label}</p>
        <p className="text-[11px] text-slate-400 mt-0.5">{description}</p>
      </div>
      <button type="button" onClick={() => setValue(name, !isOn)}
        className={`w-11 h-6 rounded-full transition-all flex-shrink-0 relative ${isOn?'bg-indigo-500':'bg-slate-200'}`}>
        <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${isOn?'left-[22px]':'left-0.5'}`}/>
      </button>
      <input type="hidden" {...register(name)}/>
    </div>
  );
}

const iCls = 'w-full h-10 rounded-xl border border-slate-200 bg-white px-3 text-[13px] text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-50 transition-all placeholder:text-slate-300';
