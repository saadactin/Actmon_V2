import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2, AlertTriangle, Server, ShieldCheck, Network, Database,
  Loader2, GitBranch, ChevronRight, Terminal, Wifi, Key, Globe, Tag,
  Layers, CheckCheck, X, Eye, EyeOff, Cpu, Copy, Check, Boxes, Zap,
} from 'lucide-react';

import { createOsServer, testSshConnection, listOsServers } from '../../api/servers';
import Stepper from '../agents/setup/components/Stepper';

/* ── static config ────────────────────────────────── */
const OPERATING_SYSTEMS = [
  { name: 'Linux', icon: '🐧' }, { name: 'Ubuntu', icon: '🟠' }, { name: 'Windows', icon: '🪟' },
  { name: 'CentOS', icon: '⚫' }, { name: 'Oracle Linux', icon: '🔴' }, { name: 'RedHat', icon: '🎩' },
];

const DATABASE_SERVICES = [
  { name: 'MySQL', color: 'bg-orange-100 text-orange-700 border-orange-300', active: 'bg-orange-500 text-white border-orange-500' },
  { name: 'MariaDB', color: 'bg-orange-100 text-orange-700 border-orange-300', active: 'bg-orange-500 text-white border-orange-500' },
  { name: 'PostgreSQL', color: 'bg-indigo-100 text-indigo-700 border-indigo-300', active: 'bg-indigo-500 text-white border-indigo-500' },
  { name: 'Oracle', color: 'bg-red-100 text-red-700 border-red-300', active: 'bg-red-500 text-white border-red-500' },
  { name: 'MongoDB', color: 'bg-emerald-100 text-emerald-700 border-emerald-300', active: 'bg-emerald-500 text-white border-emerald-500' },
  { name: 'MSSQL', color: 'bg-sky-100 text-sky-700 border-sky-300', active: 'bg-sky-500 text-white border-sky-500' },
  { name: 'ClickHouse', color: 'bg-yellow-100 text-yellow-700 border-yellow-300', active: 'bg-yellow-500 text-white border-yellow-500' },
];

const NODE_TYPES = [
  { value: 'Standalone', label: 'Standalone', icon: '○', desc: 'Single server, no HA', color: 'border-slate-200 bg-slate-50 text-slate-700', active: 'border-slate-800 bg-slate-900 text-white' },
  { value: 'Primary', label: 'Primary', icon: '★', desc: 'Replication primary / source', color: 'border-emerald-200 bg-emerald-50 text-emerald-800', active: 'border-emerald-600 bg-emerald-600 text-white' },
  { value: 'Secondary', label: 'Secondary', icon: '◎', desc: 'Replication replica', color: 'border-blue-200 bg-blue-50 text-blue-800', active: 'border-blue-600 bg-blue-600 text-white' },
  { value: 'Master', label: 'Master', icon: '▲', desc: 'Legacy master node', color: 'border-emerald-200 bg-emerald-50 text-emerald-800', active: 'border-emerald-600 bg-emerald-600 text-white' },
  { value: 'Slave', label: 'Slave', icon: '▽', desc: 'Legacy replica', color: 'border-blue-200 bg-blue-50 text-blue-800', active: 'border-blue-600 bg-blue-600 text-white' },
  { value: 'Galera Node', label: 'Galera Node', icon: '⬡', desc: 'Galera / PXC multi-primary', color: 'border-purple-200 bg-purple-50 text-purple-800', active: 'border-purple-600 bg-purple-600 text-white' },
  { value: 'Arbiter', label: 'Arbiter', icon: '◇', desc: 'Quorum / tiebreaker, no data', color: 'border-amber-200 bg-amber-50 text-amber-800', active: 'border-amber-500 bg-amber-500 text-white' },
  { value: 'Cluster Node', label: 'Cluster Node', icon: '⬡', desc: 'Generic cluster member', color: 'border-slate-200 bg-slate-50 text-slate-700', active: 'border-slate-700 bg-slate-800 text-white' },
];

const ENVIRONMENTS = ['Production', 'UAT', 'Development', 'Testing'];

// Teal stacked-server illustration (ActMon Agent style).
function ServerArt() {
  const Unit = ({ y, light }) => (
    <g>
      <rect x="30" y={y} width="160" height="56" rx="10" fill={light ? '#BEE3E8' : '#2FB6C4'} />
      <circle cx="120" cy={y + 28} r="9" fill="#fff" /><circle cx="150" cy={y + 28} r="9" fill="#fff" />
    </g>
  );
  return (
    <svg viewBox="0 0 220 210" className="w-full max-w-[210px]" fill="none" xmlns="http://www.w3.org/2000/svg">
      <Unit y={6} /><Unit y={72} light /><Unit y={138} />
    </svg>
  );
}

/* ══════════════════════════════════════════════════════ */
export default function AddOsServerPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [selectedOs, setSelectedOs] = useState('Linux');
  const [selectedDbs, setSelectedDbs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [sshTested, setSshTested] = useState(false);
  const [message, setMessage] = useState(null);
  const [showPass, setShowPass] = useState(false);
  const [collector, setCollector] = useState('ssh');   // 'ssh' | 'agent'
  const [agentInstall, setAgentInstall] = useState(null);

  const { register, getValues, setValue, watch, formState: { errors } } = useForm({
    defaultValues: { ssh_port: 22, environment: 'Production', node_type: 'Standalone', monitoring_enabled: true, auto_discovery: true },
  });

  const nodeType = watch('node_type');
  const watchCluster = watch('cluster_name');
  const wName = watch('server_name');
  const wIp = watch('ip_address');
  const wSsh = watch('ssh_username');

  const { data: serversData } = useQuery({ queryKey: ['osServers'], queryFn: () => listOsServers(), staleTime: 30000 });
  const existingClusters = [...new Set((serversData?.data || serversData || []).map((s) => s.cluster_name).filter(Boolean))];

  const toggleDb = (db) => setSelectedDbs((prev) => prev.includes(db) ? prev.filter((d) => d !== db) : [...prev, db]);

  // Dynamic step list — the SSH path collects credentials and finishes with a review.
  // The Agent path hands off to the agent module (/agents/setup) from the Connection step,
  // so it only shows the first two steps here.
  const steps = collector === 'agent'
    ? ['Connection']
    : ['Connection', 'Operating System', 'Server Identity', 'SSH Access', 'Node Role', 'Services', 'Review'];
  const cur = Math.min(step, steps.length - 1);
  const name = steps[cur];
  const isLast = cur === steps.length - 1;

  const canNext = () => {
    if (name === 'Server Identity') return !!(wName?.trim() && wIp?.trim());
    if (name === 'SSH Access') return !!wSsh?.trim();
    if (name === 'Node Role') return nodeType === 'Standalone' ? true : !!watchCluster?.trim();
    return true;
  };

  const handleTestSsh = async () => {
    const v = getValues();
    if (!v.ip_address || !v.ssh_username) { setMessage({ type: 'error', text: 'Fill in Host IP and SSH Username first.' }); return; }
    setTesting(true); setMessage(null); setSshTested(false);
    try {
      const res = await testSshConnection({ ip_address: v.ip_address, ssh_port: Number(v.ssh_port) || 22, ssh_username: v.ssh_username, ssh_password: v.ssh_password || '' });
      setMessage({ type: 'success', text: `SSH connected — ${res.message}` }); setSshTested(true);
    } catch (err) {
      setMessage({ type: 'error', text: err?.response?.data?.detail || err.message || 'SSH test failed' });
    } finally { setTesting(false); }
  };

  const onSubmit = async () => {
    const data = getValues();
    setLoading(true); setMessage(null);
    try {
      const payload = {
        server_name: data.server_name, hostname: data.hostname || data.ip_address, ip_address: data.ip_address,
        os_type: selectedOs, environment: data.environment, node_type: data.node_type,
        cluster_name: data.cluster_name || null, database_services: selectedDbs,
        monitoring_enabled: data.monitoring_enabled === true || data.monitoring_enabled === 'true',
        auto_discovery: data.auto_discovery === true || data.auto_discovery === 'true', collector,
      };
      if (collector === 'ssh') { payload.ssh_port = Number(data.ssh_port) || 22; payload.ssh_username = data.ssh_username; payload.ssh_password = data.ssh_password; }
      const res = await createOsServer(payload);
      qc.invalidateQueries(['osServers']); qc.invalidateQueries(['serverSummary']);
      if (collector === 'agent') {
        setAgentInstall({ token: res?.data?.agent_token, os: selectedOs, id: res?.data?.id });
      } else {
        setMessage({ type: 'success', text: 'Server registered successfully! Redirecting…' });
        // Open the servers page for the first DB service on this host (e.g. /mysql-servers).
        const TECH_ROUTE = { MySQL: 'mysql', MariaDB: 'mysql', PostgreSQL: 'postgresql', Oracle: 'oracle', MSSQL: 'mssql', MongoDB: 'mongodb', ClickHouse: 'clickhouse' };
        const techSlug = TECH_ROUTE[selectedDbs[0]];
        setTimeout(() => navigate(techSlug ? `/${techSlug}-servers` : '/databases'), 1200);
      }
    } catch (err) {
      setMessage({ type: 'error', text: err?.response?.data?.detail || err.message || 'Failed to save server' });
    } finally { setLoading(false); }
  };

  const agentCommand = (os, token) => {
    const base = `${window.location.origin}/api/v1`;
    if (/win/i.test(os)) {
      const setup = `${base}/agents/install/actmon-setup.ps1?token=${token}&url=${encodeURIComponent(base)}`;
      return `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',"iex ((New-Object Net.WebClient).DownloadString('${setup}'))"`;
    }
    const setup = `${base}/agents/install/actmon-setup.sh?token=${token}&url=${encodeURIComponent(base)}`;
    return `curl -sSL "${setup}" | sudo bash`;
  };

  /* ── step bodies ── */
  const osStep = (
    <div className="max-w-[900px]">
      <h3 className="text-[19px] font-black text-slate-800">Operating System</h3>
      <p className="text-[15px] text-slate-500 mt-1">Select the OS running on this server.</p>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mt-5">
        {OPERATING_SYSTEMS.map((os) => (
          <button key={os.name} type="button" onClick={() => setSelectedOs(os.name)}
            className={`relative h-[104px] rounded-2xl border-2 transition-all flex flex-col items-center justify-center gap-2 ${
              selectedOs === os.name ? 'border-blue-500 bg-blue-50/50 ring-2 ring-blue-100' : 'border-slate-200 hover:border-blue-300 hover:shadow'}`}>
            <span className="text-4xl leading-none">{os.icon}</span>
            <span className={`text-[14px] font-bold ${selectedOs === os.name ? 'text-blue-700' : 'text-slate-600'}`}>{os.name}</span>
            {selectedOs === os.name && <span className="absolute top-2 right-2 w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center"><CheckCheck size={11} className="text-white" /></span>}
          </button>
        ))}
      </div>
    </div>
  );

  const connectionStep = (
    <div className="max-w-[900px]">
      <h3 className="text-[19px] font-black text-slate-800">Connection Method</h3>
      <p className="text-[15px] text-slate-500 mt-1">How ActMon collects data from this server — both give the identical monitoring UI.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
        <button type="button" onClick={() => setCollector('ssh')}
          className={`text-left p-5 rounded-2xl border-2 transition-all flex items-start gap-3 ${collector === 'ssh' ? 'border-blue-500 bg-blue-50/50 ring-2 ring-blue-100' : 'border-slate-200 hover:border-blue-300'}`}>
          <div className="w-12 h-12 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center flex-shrink-0"><Terminal size={24} /></div>
          <div>
            <p className="font-black text-slate-800 text-[16px] flex items-center gap-1.5">Connect via SSH {collector === 'ssh' && <CheckCheck size={15} className="text-blue-600" />}</p>
            <p className="text-[14px] text-slate-500 mt-1 leading-relaxed">ActMon polls the host over SSH. No install — just credentials.</p>
          </div>
        </button>
        <button type="button" onClick={() => setCollector('agent')}
          className={`text-left p-5 rounded-2xl border-2 transition-all flex items-start gap-3 ${collector === 'agent' ? 'border-blue-500 bg-blue-50/50 ring-2 ring-blue-100' : 'border-slate-200 hover:border-blue-300'}`}>
          <div className="w-12 h-12 rounded-xl bg-sky-100 text-sky-600 flex items-center justify-center flex-shrink-0"><Boxes size={24} /></div>
          <div>
            <p className="font-black text-slate-800 text-[16px] flex items-center gap-1.5">Connect via Agent {collector === 'agent' && <CheckCheck size={15} className="text-blue-600" />}</p>
            <p className="text-[14px] text-slate-500 mt-1 leading-relaxed">Install a lightweight agent that pushes the same metrics — ideal when SSH isn't reachable.</p>
          </div>
        </button>
      </div>
    </div>
  );

  const identityStep = (
    <div className="max-w-[900px]">
      <h3 className="text-[19px] font-black text-slate-800">Server Identity</h3>
      <p className="text-[15px] text-slate-500 mt-1">Name and network details.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
        <Field label="Server Name" required error={errors.server_name?.message}>
          <InputWithIcon icon={<Server size={15} className="text-slate-400" />}><input {...register('server_name', { required: 'Server name is required' })} placeholder="DB-OS-PROD-01" className={iCls} /></InputWithIcon>
        </Field>
        <Field label="Host IP Address" required error={errors.ip_address?.message}>
          <InputWithIcon icon={<Globe size={15} className="text-slate-400" />}><input {...register('ip_address', { required: 'IP address is required' })} placeholder="192.168.1.10" className={iCls} /></InputWithIcon>
        </Field>
        <Field label="Hostname (FQDN)">
          <InputWithIcon icon={<Network size={15} className="text-slate-400" />}><input {...register('hostname')} placeholder="db-01.company.local" className={iCls} /></InputWithIcon>
        </Field>
        <Field label="Environment">
          <div className="flex gap-2 flex-wrap">
            {ENVIRONMENTS.map((env) => (
              <button key={env} type="button" onClick={() => setValue('environment', env)}
                className={`h-10 px-4 rounded-xl text-[14px] font-bold border transition-all ${watch('environment') === env ? 'bg-slate-900 text-white border-slate-900 shadow' : 'border-slate-200 text-slate-600 hover:border-slate-400 bg-white'}`}>{env}</button>
            ))}
          </div>
        </Field>
      </div>
    </div>
  );

  const sshStep = (
    <div className="max-w-[900px]">
      <h3 className="text-[19px] font-black text-slate-800">SSH Access</h3>
      <p className="text-[15px] text-slate-500 mt-1">Credentials for live OS metric collection.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
        <Field label="SSH Username" required error={errors.ssh_username?.message}>
          <InputWithIcon icon={<Key size={15} className="text-slate-400" />}><input {...register('ssh_username', { required: 'SSH username is required' })} placeholder="root" className={iCls} /></InputWithIcon>
        </Field>
        <Field label="SSH Port" required>
          <InputWithIcon icon={<Wifi size={15} className="text-slate-400" />}><input type="number" {...register('ssh_port')} className={iCls} /></InputWithIcon>
        </Field>
        <Field label="SSH Password" className="md:col-span-2">
          <div className="relative">
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"><Key size={15} /></div>
            <input type={showPass ? 'text' : 'password'} {...register('ssh_password')} placeholder="••••••••••" className={`${iCls} pl-9 pr-10`} />
            <button type="button" onClick={() => setShowPass((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">{showPass ? <EyeOff size={15} /> : <Eye size={15} />}</button>
          </div>
        </Field>
      </div>
      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <button type="button" onClick={handleTestSsh} disabled={testing}
          className={`h-10 px-5 rounded-xl font-bold text-[14px] flex items-center gap-2 transition-all border ${sshTested ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-white border-slate-300 text-slate-700 hover:border-blue-400 hover:text-blue-700'}`}>
          {testing ? <Loader2 size={15} className="animate-spin" /> : sshTested ? <CheckCircle2 size={15} /> : <Terminal size={15} />}
          {testing ? 'Connecting…' : sshTested ? 'SSH Connected' : 'Test SSH Connection'}
        </button>
        <p className="text-[14px] text-slate-400">Verify credentials before continuing.</p>
      </div>
    </div>
  );

  const nodeStep = (
    <div className="max-w-[900px]">
      <h3 className="text-[19px] font-black text-slate-800">Node Role</h3>
      <p className="text-[15px] text-slate-500 mt-1">Define this server's role in your topology.</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
        {NODE_TYPES.map((nt) => (
          <button key={nt.value} type="button" onClick={() => setValue('node_type', nt.value)}
            className={`relative p-3.5 rounded-xl border-2 text-left transition-all ${nodeType === nt.value ? nt.active + ' shadow-md' : nt.color + ' hover:shadow'}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-lg leading-none">{nt.icon}</span>
              <span className="text-[12px] font-black uppercase tracking-wide">{nt.label}</span>
              {nodeType === nt.value && <CheckCheck size={12} className="ml-auto" />}
            </div>
            <p className={`text-[12px] leading-tight ${nodeType === nt.value ? 'opacity-80' : 'text-slate-400'}`}>{nt.desc}</p>
          </button>
        ))}
      </div>
      {nodeType !== 'Standalone' && (
        <div className="mt-4 p-4 bg-purple-50/50 border border-purple-100 rounded-xl max-w-xl">
          <Field label="Cluster Name" required error={errors.cluster_name?.message}>
            {existingClusters.length > 0 && (
              <div className="mb-2.5">
                <p className="text-[12px] text-slate-400 font-bold uppercase tracking-wide mb-1.5 flex items-center gap-1"><GitBranch size={11} /> Join existing cluster</p>
                <div className="flex flex-wrap gap-2">
                  {existingClusters.map((cl) => (
                    <button key={cl} type="button" onClick={() => setValue('cluster_name', cl)}
                      className={`px-3 h-8 rounded-lg text-[12px] font-bold border transition-all ${watchCluster === cl ? 'bg-purple-600 border-purple-600 text-white' : 'border-purple-200 bg-white text-purple-700 hover:border-purple-400'}`}>{cl}</button>
                  ))}
                </div>
              </div>
            )}
            <InputWithIcon icon={<Layers size={15} className="text-slate-400" />}>
              <input {...register('cluster_name')} list="cluster-datalist" placeholder={existingClusters.length ? 'Or enter a new cluster name…' : 'PROD-MYSQL-CLUSTER-01'} className={iCls} />
            </InputWithIcon>
            <datalist id="cluster-datalist">{existingClusters.map((cl) => <option key={cl} value={cl} />)}</datalist>
          </Field>
        </div>
      )}
    </div>
  );

  const servicesStep = (
    <div className="max-w-[900px]">
      <h3 className="text-[19px] font-black text-slate-800">Database Services</h3>
      <p className="text-[15px] text-slate-500 mt-1">Which databases are running on this server?</p>
      <div className="flex flex-wrap gap-2.5 mt-5">
        {DATABASE_SERVICES.map((db) => {
          const on = selectedDbs.includes(db.name);
          return (
            <button key={db.name} type="button" onClick={() => toggleDb(db.name)}
              className={`h-10 px-4 rounded-xl text-[14px] font-bold border transition-all flex items-center gap-1.5 ${on ? db.active : db.color + ' hover:shadow-sm'}`}>
              {on && <CheckCheck size={12} />}{db.name}
            </button>
          );
        })}
      </div>
      {selectedDbs.length === 0 && <p className="text-[13px] text-slate-400 mt-2">Select at least one database service for auto-discovery.</p>}

      <h3 className="text-[19px] font-black text-slate-800 mt-8">Monitoring Options</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <ToggleField label="Live Monitoring" description="Collect CPU, RAM, Disk metrics" name="monitoring_enabled" register={register} watch={watch} setValue={setValue} />
        <ToggleField label="Auto Discovery" description="Detect installed DB services automatically" name="auto_discovery" register={register} watch={watch} setValue={setValue} />
      </div>
    </div>
  );

  const SummaryRow = ({ label, value }) => (
    <div className="flex gap-4 py-2.5 border-b border-slate-100">
      <span className="w-44 flex-shrink-0 text-[14px] font-bold text-slate-500">{label}</span>
      <span className="text-[15px] text-slate-800 break-all">{value || <span className="text-slate-400">—</span>}</span>
    </div>
  );
  const reviewStep = (
    <div className="max-w-[760px]">
      <h3 className="text-[19px] font-black text-slate-800">Review</h3>
      <p className="text-[15px] text-slate-500 mt-1">Confirm the server details, then register it.</p>
      <div className="rounded-xl border border-slate-200 p-5 mt-5">
        <SummaryRow label="Operating System" value={selectedOs} />
        <SummaryRow label="Connection" value={collector === 'ssh' ? 'SSH' : 'Agent'} />
        <SummaryRow label="Server Name" value={wName} />
        <SummaryRow label="Host IP" value={wIp} />
        {collector === 'ssh' && <SummaryRow label="SSH User" value={wSsh} />}
        <SummaryRow label="Node Role" value={nodeType} />
        {nodeType !== 'Standalone' && <SummaryRow label="Cluster" value={watchCluster} />}
        <SummaryRow label="Databases" value={selectedDbs.join(', ')} />
        <SummaryRow label="Environment" value={watch('environment')} />
      </div>
      {message && <MessageBox message={message} />}
    </div>
  );

  const installStep = agentInstall ? (
    <AgentInstallPanel os={agentInstall.os} command={agentCommand(agentInstall.os, agentInstall.token)} onDone={() => navigate('/databases')} />
  ) : (
    <div className="max-w-[760px]">
      <h3 className="text-[19px] font-black text-slate-800">Install the Agent</h3>
      <p className="text-[15px] text-slate-500 mt-1">Create the host, then run the generated install command on it. The host appears once the agent reports — same metrics as SSH.</p>
      <div className="rounded-xl border border-slate-200 p-5 mt-5">
        <SummaryRow label="Operating System" value={selectedOs} />
        <SummaryRow label="Server Name" value={wName} />
        <SummaryRow label="Host IP" value={wIp} />
        <SummaryRow label="Node Role" value={nodeType} />
        <SummaryRow label="Databases" value={selectedDbs.join(', ')} />
      </div>
      {message && <MessageBox message={message} />}
    </div>
  );

  const body = {
    'Operating System': osStep, 'Connection': connectionStep, 'Server Identity': identityStep,
    'SSH Access': sshStep, 'Node Role': nodeStep, 'Services': servicesStep, 'Review': reviewStep, 'Install': installStep,
  }[name];

  return (
    <div className="-mx-6 md:-mx-8 -mb-6 md:-mb-8 min-h-full bg-white flex flex-col pb-16">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3.5 border-b border-slate-200 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-500 to-sky-400 flex items-center justify-center"><Zap size={16} className="text-white" /></div>
          <span className="text-lg font-black text-slate-800">Add OS Server</span>
        </div>
        <button onClick={() => navigate('/databases')} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left panel */}
        <aside className="hidden lg:flex flex-col w-[340px] flex-shrink-0 border-r border-slate-100 px-8 py-10">
          <div className="flex justify-center pt-4"><ServerArt /></div>
          <h2 className="text-[26px] leading-tight font-black text-slate-800 mt-10">OS Server</h2>
          <p className="text-slate-500 mt-3 leading-relaxed">Register a server for OS-level monitoring. Connect over SSH or install a lightweight agent — both give the identical monitoring UI.</p>
        </aside>

        {/* Right */}
        <section className="flex-1 min-w-0 flex flex-col">
          <div className="px-10 pt-8"><Stepper steps={steps} current={cur} /></div>
          <div className="flex-1 overflow-y-auto px-10 py-7 border-t border-slate-100 mt-6">{body}</div>

          {/* Footer */}
          {!(name === 'Install' && agentInstall) && (
            <div className="flex items-center justify-between pl-10 pr-28 py-4 border-t border-slate-200 flex-shrink-0">
              <a href="#" onClick={(e) => e.preventDefault()} className="text-sm font-bold text-blue-600 hover:text-blue-800">Help &amp; User Guide</a>
              <div className="flex items-center gap-2">
                <button onClick={() => navigate('/databases')} className="h-9 px-4 rounded-lg text-slate-600 text-sm font-bold hover:bg-slate-100">Cancel</button>
                {cur > 0 && <button onClick={() => setStep(cur - 1)} className="h-9 px-5 rounded-lg border border-slate-300 text-slate-700 text-sm font-bold hover:bg-slate-50">Previous</button>}
                {name === 'SSH Access' && (
                  <button onClick={handleTestSsh} disabled={testing} className="h-9 px-5 rounded-lg border border-slate-300 text-slate-700 text-sm font-bold hover:bg-slate-50 disabled:opacity-40">{testing ? 'Testing…' : 'Test SSH'}</button>
                )}
                {name === 'Connection' && collector === 'agent' ? (
                  <button onClick={() => navigate('/databases/add-data')}
                    className="h-9 px-6 rounded-lg bg-blue-700 text-white text-sm font-bold hover:bg-blue-800">Next</button>
                ) : !isLast ? (
                  <button onClick={() => canNext() && setStep(cur + 1)} disabled={!canNext()}
                    className="h-9 px-6 rounded-lg bg-blue-700 text-white text-sm font-bold hover:bg-blue-800 disabled:opacity-40">Next</button>
                ) : (
                  <button onClick={onSubmit} disabled={loading}
                    className="h-9 px-6 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2">
                    {loading ? <Loader2 size={15} className="animate-spin" /> : collector === 'agent' ? <Boxes size={15} /> : <ShieldCheck size={15} />}
                    {loading ? 'Saving…' : collector === 'agent' ? 'Create & Show Install' : 'Register Server'}
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/* ── helpers ── */
function MessageBox({ message }) {
  return (
    <div className={`mt-5 rounded-xl px-4 py-3 border flex items-start gap-3 ${message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
      {message.type === 'success' ? <CheckCircle2 size={18} className="flex-shrink-0 mt-0.5" /> : <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />}
      <p className="text-[15px] font-semibold">{message.text}</p>
    </div>
  );
}

function Field({ label, required, error, children, className = '' }) {
  return (
    <div className={className}>
      <label className="block text-[13px] font-bold text-slate-600 mb-1.5 uppercase tracking-wide">{label}{required && <span className="text-red-500 ml-0.5">*</span>}</label>
      {children}
      {error && <p className="text-red-500 text-[13px] mt-1 flex items-center gap-1"><AlertTriangle size={11} />{error}</p>}
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
        <p className="text-[15px] font-black text-slate-800">{label}</p>
        <p className="text-[13px] text-slate-400 mt-0.5">{description}</p>
      </div>
      <button type="button" onClick={() => setValue(name, !isOn)} className={`w-11 h-6 rounded-full transition-all flex-shrink-0 relative ${isOn ? 'bg-indigo-500' : 'bg-slate-200'}`}>
        <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${isOn ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
      <input type="hidden" {...register(name)} />
    </div>
  );
}

function AgentInstallPanel({ os, command, onDone }) {
  const [copied, setCopied] = useState(false);
  const isWin = /win/i.test(os);
  const copy = () => { navigator.clipboard?.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1600); };
  return (
    <div className="max-w-[760px]">
      <div className="flex items-center gap-2.5 mb-1">
        <CheckCircle2 size={18} className="text-emerald-600" />
        <h3 className="text-[19px] font-black text-slate-800">Host created — install the agent</h3>
      </div>
      <p className="text-[15px] text-slate-600 mb-5">Run this on the target host ({isWin ? 'Windows — Administrator' : 'Linux — root'}). It reports the same metrics an SSH host would.</p>
      <div className="relative rounded-xl border border-slate-200 bg-slate-50">
        <button onClick={copy} className="absolute top-2.5 right-2.5 text-slate-500 hover:text-blue-600" title="Copy">{copied ? <Check size={17} className="text-emerald-600" /> : <Copy size={17} />}</button>
        <pre className="p-4 pr-12 text-[14px] leading-relaxed font-mono text-slate-800 whitespace-pre-wrap break-all">{command}</pre>
      </div>
      <div className="mt-4 flex items-center gap-2.5 text-[15px] text-slate-500">
        <Loader2 size={15} className="animate-spin text-blue-500" />
        The host will appear in Infrastructure and start showing metrics once the agent reports.
      </div>
      <button onClick={onDone} className="mt-6 h-10 px-6 rounded-lg bg-blue-700 text-white text-[15px] font-bold hover:bg-blue-800 flex items-center gap-2">Go to Infrastructure <ChevronRight size={16} /></button>
    </div>
  );
}

const iCls = 'w-full h-11 rounded-xl border border-slate-200 bg-white px-3.5 text-[15px] text-slate-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-50 transition-all placeholder:text-slate-300';
