import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { X, Zap, CheckCircle2, AlertTriangle } from 'lucide-react';

import { createConnection, testConnection } from '../../api/connections';
import { useConnectionsList } from '../../hooks/useConnections';
import Stepper from '../agents/setup/components/Stepper';
import { TechLogo } from '../agents/setup/logos';

const DATABASES = [
  { name: 'MySQL', id: 'mysql', icon: '🐬', port: 3306 },
  { name: 'PostgreSQL', id: 'postgresql', icon: '🐘', port: 5432 },
  { name: 'Oracle', id: 'oracle', icon: '🟥', port: 1521 },
  { name: 'MSSQL', id: 'mssql', icon: '💠', port: 1433 },
  { name: 'MongoDB', id: 'mongodb', icon: '🍃', port: 27017 },
  { name: 'ClickHouse', id: 'clickhouse', icon: '📊', port: 8123 },
  { name: 'CosmosDB', id: 'cosmosdb', icon: '🌌', port: 443, cloud: true },
];

const COSMOS_API_TYPES = [
  { value: 'sql', label: 'SQL (Core) API' },
  { value: 'mongodb', label: 'MongoDB API — coming soon', disabled: true },
  { value: 'cassandra', label: 'Cassandra API — coming soon', disabled: true },
  { value: 'gremlin', label: 'Gremlin API — coming soon', disabled: true },
  { value: 'table', label: 'Table API — coming soon', disabled: true },
];

const STEPS = ['Database', 'Configuration', 'Summary'];

// Stacked-cylinders "Database" illustration (matches the ActMon Agent left panel style).
function DatabaseArt() {
  const Disc = ({ y, fill }) => (
    <g>
      <path d={`M30 ${y} a80 22 0 0 0 160 0 v34 a80 22 0 0 1 -160 0 Z`} fill={fill} />
      <ellipse cx="110" cy={y} rx="80" ry="22" fill="#BEE3E8" />
    </g>
  );
  return (
    <svg viewBox="0 0 220 190" className="w-full max-w-[210px]" fill="none" xmlns="http://www.w3.org/2000/svg">
      <Disc y={120} fill="#2FB6C4" />
      <Disc y={72} fill="#2FB6C4" />
      <Disc y={26} fill="#2FB6C4" />
    </svg>
  );
}

export default function AddConnectionPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const goBack = () => navigate(-1);

  // Pre-fill from query params when arriving from "Connect / Setup Connection" on a server page.
  const preType = searchParams.get('type');
  const preHost = searchParams.get('host');
  const prePort = searchParams.get('port');
  const preName = searchParams.get('name');

  const initialDb = preType
    ? DATABASES.find((d) => d.name.toLowerCase() === preType.toLowerCase())?.name || 'MySQL'
    : 'PostgreSQL';
  // When arriving with a preselected engine (?type=), lock the engine choice.
  const lockedTech = !!preType && !!DATABASES.find((d) => d.name.toLowerCase() === preType.toLowerCase());

  const [step, setStep] = useState(0);
  const [selectedDatabase, setSelectedDatabase] = useState(initialDb);
  const [selectedServerId, setSelectedServerId] = useState('');
  const [newClusterName, setNewClusterName] = useState('');
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState(null);

  const {
    register, handleSubmit, setValue, getValues, trigger,
    formState: { errors },
  } = useForm({
    defaultValues: {
      port: DATABASES.find((d) => d.name === initialDb)?.port || 5432,
      sslMode: 'prefer',
      cosmosApiType: 'sql',
      cosmosConnectionTimeout: 30,
      cosmosSslEnabled: 'true',
    },
  });

  const isCosmos = selectedDatabase === 'CosmosDB';

  useEffect(() => {
    if (preHost) setValue('host', preHost);
    if (prePort) setValue('port', Number(prePort));
    if (preName) setValue('connectionName', preName);
  }, [preHost, prePort, preName, setValue]);

  const { data: connectionsList = [] } = useConnectionsList(selectedDatabase);

  const serversById = connectionsList.reduce((acc, c) => {
    const id = String(c.server_id || 'unknown');
    if (!acc[id]) acc[id] = { server_id: c.server_id, cluster_name: c.cluster_name || null };
    return acc;
  }, {});
  const serverOptions = Object.values(serversById);
  const selectedMeta = DATABASES.find((d) => d.name === selectedDatabase);

  const handleDatabaseChange = (database) => {
    setSelectedDatabase(database);
    const db = DATABASES.find((d) => d.name === database);
    setValue('port', db.port);
    setMessage(null);
  };

  const buildPayload = (data) => {
    if (isCosmos) {
      return {
        connection_name: data.connectionName,
        account_name: data.cosmosAccountName || undefined,
        endpoint: data.cosmosEndpoint,
        primary_key: data.cosmosPrimaryKey,
        secondary_key: data.cosmosSecondaryKey || undefined,
        database_name: data.cosmosDatabaseName,
        container_name: data.cosmosContainerName,
        partition_key: data.cosmosPartitionKey || undefined,
        api_type: data.cosmosApiType || 'sql',
        preferred_region: data.cosmosPreferredRegion || undefined,
        consistency_level: data.cosmosConsistencyLevel || undefined,
        connection_timeout_sec: data.cosmosConnectionTimeout ? Number(data.cosmosConnectionTimeout) : undefined,
        ssl_enabled: data.cosmosSslEnabled !== 'false',
        proxy: data.cosmosProxy || undefined,
        custom_headers: data.cosmosCustomHeaders || undefined,
        description: data.cosmosDescription || undefined,
        resource_group: data.cosmosResourceGroup || undefined,
        subscription_id: data.cosmosSubscriptionId || undefined,
      };
    }
    return {
      connection_name: data.connectionName,
      host: data.host,
      port: Number(data.port),
      username: data.username,
      password: data.password,
      database_name: data.databaseName,
      ssl_mode: data.sslMode,
      service_name: data.serviceName,
      sid: data.sid,
      auth_source: data.authSource,
      replica_set: data.replicaSet,
      server_id: selectedServerId && selectedServerId !== 'new' ? Number(selectedServerId) : undefined,
      cluster_name: selectedServerId === 'new' ? (newClusterName || undefined) : undefined,
    };
  };

  const handleTestConnection = async (data) => {
    try {
      setTesting(true); setMessage(null);
      await testConnection(selectedDatabase, buildPayload(data));
      setMessage({ type: 'success', text: 'Connection successful' });
    } catch (error) {
      setMessage({ type: 'error', text: error?.message || error?.response?.data?.detail || 'Connection failed' });
    } finally { setTesting(false); }
  };

  const handleSaveConnection = async (data) => {
    try {
      setLoading(true); setMessage(null);
      await createConnection(selectedDatabase, buildPayload(data));
      setMessage({ type: 'success', text: 'Connection created successfully' });
      const dest = selectedMeta?.id ? `/${selectedMeta.id}-servers` : '/connections';
      setTimeout(() => navigate(dest), 1000);
    } catch (error) {
      setMessage({ type: 'error', text: error?.message || error?.response?.data?.detail || 'Failed to create connection' });
    } finally { setLoading(false); }
  };

  const goNext = async () => {
    setMessage(null);
    if (step === 1) {
      const ok = await trigger(isCosmos
        ? ['connectionName', 'cosmosEndpoint', 'cosmosPrimaryKey', 'cosmosDatabaseName', 'cosmosContainerName']
        : ['connectionName', 'host', 'port', 'username']);
      if (!ok) return;
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };
  const goPrev = () => { setMessage(null); setStep((s) => Math.max(0, s - 1)); };

  const messageBlock = message && (
    <div className={`mt-6 rounded-xl px-4 py-3 border flex items-center gap-3 ${
      message.type === 'success' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
      {message.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
      {message.text}
    </div>
  );

  // ── Step 0: engine selection (locked to preselected tech when arriving via ?type=) ──
  const engines = lockedTech ? DATABASES.filter((d) => d.name === selectedDatabase) : DATABASES;
  const databaseStep = (
    <div className="max-w-[900px]">
      <p className="text-sm font-semibold text-slate-700 mb-3">Database Engine</p>
      <div className={`grid gap-3 ${lockedTech ? 'grid-cols-1 max-w-[220px]' : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6'}`}>
        {engines.map((database) => (
          <button key={database.name} type="button" disabled={lockedTech}
            onClick={() => handleDatabaseChange(database.name)}
            className={`h-28 rounded-2xl border transition-all flex flex-col items-center justify-center gap-2 ${
              selectedDatabase === database.name ? 'border-blue-600 ring-2 ring-blue-100 bg-blue-50/40' : 'border-slate-200 bg-white hover:border-slate-300'} ${lockedTech ? 'cursor-default' : ''}`}>
            <TechLogo id={database.id} size={40} />
            <div className="text-sm font-semibold text-slate-700">{database.name}</div>
          </button>
        ))}
      </div>
      {messageBlock}
    </div>
  );

  // ── Step 1: configuration ──
  const configStep = (
    <div className="max-w-[900px]">
      <div className="flex items-center gap-3 mb-5">
        <TechLogo id={selectedMeta?.id} size={34} />
        <h2 className="text-xl font-bold text-slate-900">{selectedDatabase} Configuration</h2>
      </div>

      {isCosmos ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <InputField label="Connection Name" required error={errors.connectionName?.message}>
              <input {...register('connectionName', { required: 'Connection name required' })}
                placeholder="CosmosDB Production" className={inputClass} />
            </InputField>
            <InputField label="Account Name (optional if Endpoint is provided)">
              <input {...register('cosmosAccountName')} placeholder="my-cosmos-account" className={inputClass} />
            </InputField>
            <InputField label="Endpoint URL" required error={errors.cosmosEndpoint?.message}>
              <input {...register('cosmosEndpoint', { required: 'Endpoint URL required' })}
                placeholder="https://my-account.documents.azure.com:443/" className={inputClass} />
            </InputField>
            <InputField label="API Type">
              <select {...register('cosmosApiType')} className={inputClass}>
                {COSMOS_API_TYPES.map((t) => (
                  <option key={t.value} value={t.value} disabled={t.disabled}>{t.label}</option>
                ))}
              </select>
            </InputField>
            <InputField label="Primary Key" required error={errors.cosmosPrimaryKey?.message}>
              <input type="password" {...register('cosmosPrimaryKey', { required: 'Primary key required' })}
                placeholder="••••••••••••••••" className={inputClass} />
            </InputField>
            <InputField label="Secondary Key (optional)">
              <input type="password" {...register('cosmosSecondaryKey')} placeholder="••••••••••••••••" className={inputClass} />
            </InputField>
            <InputField label="Database Name" required error={errors.cosmosDatabaseName?.message}>
              <input {...register('cosmosDatabaseName', { required: 'Database name required' })} placeholder="mydb" className={inputClass} />
            </InputField>
            <InputField label="Container Name" required error={errors.cosmosContainerName?.message}>
              <input {...register('cosmosContainerName', { required: 'Container name required' })} placeholder="mycontainer" className={inputClass} />
            </InputField>
            <InputField label="Partition Key (optional, recommended)">
              <input {...register('cosmosPartitionKey')} placeholder="/id" className={inputClass} />
            </InputField>
            <InputField label="Preferred Region (optional)">
              <input {...register('cosmosPreferredRegion')} placeholder="East US" className={inputClass} />
            </InputField>
            <InputField label="Consistency Level (optional)">
              <select {...register('cosmosConsistencyLevel')} className={inputClass} defaultValue="">
                <option value="">Account default</option>
                <option value="Strong">Strong</option>
                <option value="BoundedStaleness">Bounded Staleness</option>
                <option value="Session">Session</option>
                <option value="ConsistentPrefix">Consistent Prefix</option>
                <option value="Eventual">Eventual</option>
              </select>
            </InputField>
            <InputField label="Connection Timeout (seconds)">
              <input type="number" {...register('cosmosConnectionTimeout')} placeholder="30" className={inputClass} />
            </InputField>
            <InputField label="Resource Group (optional)">
              <input {...register('cosmosResourceGroup')} placeholder="my-resource-group" className={inputClass} />
            </InputField>
            <InputField label="Subscription ID (optional)">
              <input {...register('cosmosSubscriptionId')} placeholder="00000000-0000-0000-0000-000000000000" className={inputClass} />
            </InputField>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">
            <InputField label="SSL / TLS">
              <select {...register('cosmosSslEnabled')} className={inputClass}>
                <option value="true">Enabled (recommended)</option>
                <option value="false">Disabled</option>
              </select>
            </InputField>
            <InputField label="Proxy Settings (optional)">
              <input {...register('cosmosProxy')} placeholder="http://proxy.internal:8080" className={inputClass} />
            </InputField>
          </div>

          <div className="grid grid-cols-1 gap-5 mt-5">
            <InputField label="Custom Headers (optional, JSON)">
              <textarea {...register('cosmosCustomHeaders')} rows={2} placeholder='{"x-ms-custom": "value"}'
                className={`${inputClass} h-auto py-2.5 font-mono text-sm`} />
            </InputField>
            <InputField label="Description (optional)">
              <textarea {...register('cosmosDescription')} rows={2} placeholder="What this connection is used for"
                className={`${inputClass} h-auto py-2.5`} />
            </InputField>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <InputField label="Connection Name" required error={errors.connectionName?.message}>
              <input {...register('connectionName', { required: 'Connection name required' })}
                placeholder={`${selectedDatabase} Production`} className={inputClass} />
            </InputField>
            <InputField label="Host Address" required error={errors.host?.message}>
              <input {...register('host', { required: 'Host required' })} placeholder="127.0.0.1" className={inputClass} />
            </InputField>
            <InputField label="Port" required error={errors.port?.message}>
              <input type="number" {...register('port', { required: 'Port required' })} className={inputClass} />
            </InputField>
            <InputField label="Database Name (optional — leave blank to test connectivity only)">
              <input {...register('databaseName')} placeholder="Leave blank, or enter e.g. mydb" className={inputClass} autoComplete="off" />
            </InputField>
            <InputField label="Username" required error={errors.username?.message}>
              <input {...register('username', { required: 'Username required' })} placeholder="postgres" className={inputClass} />
            </InputField>
            <InputField label="Password">
              <input type="password" {...register('password')} placeholder="••••••••" className={inputClass} />
            </InputField>
          </div>

          {selectedDatabase === 'PostgreSQL' && (
            <div className="mt-5">
              <InputField label="SSL Mode">
                <select {...register('sslMode')} className={inputClass}>
                  <option value="prefer">prefer</option><option value="disable">disable</option><option value="require">require</option>
                </select>
              </InputField>
            </div>
          )}
          {selectedDatabase === 'Oracle' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">
              <InputField label="Service Name"><input {...register('serviceName')} placeholder="ORCLPDB1" className={inputClass} /></InputField>
              <InputField label="SID"><input {...register('sid')} placeholder="ORCL" className={inputClass} /></InputField>
            </div>
          )}
          {selectedDatabase === 'MongoDB' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">
              <InputField label="Auth Source"><input {...register('authSource')} placeholder="admin" className={inputClass} /></InputField>
              <InputField label="Replica Set"><input {...register('replicaSet')} placeholder="ClusterReplicaSet" className={inputClass} /></InputField>
            </div>
          )}
        </>
      )}
      {messageBlock}
    </div>
  );

  // ── Step 2: summary ──
  const v = getValues();
  const SummaryRow = ({ label, value }) => (
    <div className="flex gap-4 py-2.5 border-b border-slate-100">
      <span className="w-48 flex-shrink-0 text-[14px] font-bold text-slate-500">{label}</span>
      <span className="text-[15px] text-slate-800 break-all">{value || <span className="text-slate-400">—</span>}</span>
    </div>
  );
  const summaryStep = (
    <div className="max-w-[760px]">
      <div className="flex items-center gap-3 mb-4">
        <TechLogo id={selectedMeta?.id} size={34} />
        <h3 className="text-[17px] font-black text-slate-800">Review your connection</h3>
      </div>
      <p className="text-[15px] text-slate-500 mb-5">Confirm the settings below, then save the connection.</p>
      <div className="rounded-xl border border-slate-200 p-5">
        <SummaryRow label="Engine" value={selectedDatabase} />
        <SummaryRow label="Connection Name" value={v.connectionName} />
        {isCosmos ? (
          <>
            <SummaryRow label="API Type" value={COSMOS_API_TYPES.find((t) => t.value === v.cosmosApiType)?.label} />
            <SummaryRow label="Account Name" value={v.cosmosAccountName} />
            <SummaryRow label="Endpoint" value={v.cosmosEndpoint} />
            <SummaryRow label="Database" value={v.cosmosDatabaseName} />
            <SummaryRow label="Container" value={v.cosmosContainerName} />
            <SummaryRow label="Partition Key" value={v.cosmosPartitionKey} />
            <SummaryRow label="Preferred Region" value={v.cosmosPreferredRegion} />
            <SummaryRow label="Consistency Level" value={v.cosmosConsistencyLevel} />
          </>
        ) : (
          <>
            <SummaryRow label="Host" value={v.host} />
            <SummaryRow label="Port" value={String(v.port || '')} />
            <SummaryRow label="Database" value={v.databaseName} />
            <SummaryRow label="Username" value={v.username} />
          </>
        )}
      </div>
      {messageBlock}
    </div>
  );

  return (
    <div className="-mx-6 md:-mx-8 -mb-6 md:-mb-8 min-h-full bg-white flex flex-col pb-16">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3.5 border-b border-slate-200 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-500 to-sky-400 flex items-center justify-center"><Zap size={16} className="text-white" /></div>
          <span className="text-lg font-black text-slate-800">Add Connection</span>
        </div>
        <button onClick={goBack} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left panel */}
        <aside className="hidden lg:flex flex-col w-[340px] flex-shrink-0 border-r border-slate-100 px-8 py-10">
          <div className="flex justify-center pt-4"><DatabaseArt /></div>
          <h2 className="text-[26px] leading-tight font-black text-slate-800 mt-10">Database Connection</h2>
          <p className="text-slate-500 mt-3 leading-relaxed">Connect a database to monitor its reliability, availability, and performance — including query execution and host resources.</p>
        </aside>

        {/* Right */}
        <section className="flex-1 min-w-0 flex flex-col">
          <div className="px-10 pt-8"><Stepper steps={STEPS} current={step} /></div>
          <div className="flex-1 overflow-y-auto px-10 py-7 border-t border-slate-100 mt-6">
            {step === 0 && databaseStep}
            {step === 1 && configStep}
            {step === 2 && summaryStep}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between pl-10 pr-28 py-4 border-t border-slate-200 flex-shrink-0">
            <a href="#" onClick={(e) => e.preventDefault()} className="text-sm font-bold text-blue-600 hover:text-blue-800">Help &amp; User Guide</a>
            <div className="flex items-center gap-2">
              <button onClick={goBack} className="h-9 px-4 rounded-lg text-slate-600 text-sm font-bold hover:bg-slate-100">Cancel</button>
              {step > 0 && (
                <button onClick={goPrev} className="h-9 px-5 rounded-lg border border-slate-300 text-slate-700 text-sm font-bold hover:bg-slate-50">Previous</button>
              )}
              {step === 1 && (
                <button onClick={handleSubmit(handleTestConnection)} disabled={testing}
                  className="h-9 px-5 rounded-lg border border-slate-300 text-slate-700 text-sm font-bold hover:bg-slate-50 disabled:opacity-40">
                  {testing ? 'Testing…' : 'Test Connection'}
                </button>
              )}
              {step < STEPS.length - 1 ? (
                <button onClick={goNext} className="h-9 px-6 rounded-lg bg-blue-700 text-white text-sm font-bold hover:bg-blue-800">Next</button>
              ) : (
                <button onClick={handleSubmit(handleSaveConnection)} disabled={loading}
                  className="h-9 px-6 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-40">
                  {loading ? 'Saving…' : 'Save Connection'}
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function InputField({ label, required, error, children }) {
  return (
    <div>
      <label className="block text-sm font-semibold text-slate-700 mb-2">
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      {children}
      {error && <p className="text-red-500 text-sm mt-1">{error}</p>}
    </div>
  );
}

const inputClass =
  'w-full h-11 rounded-xl border border-slate-300 px-4 bg-white outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200 transition-all';
