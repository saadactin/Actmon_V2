import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { X, CheckCircle2, AlertTriangle } from 'lucide-react';

import { getConnectionDetails, updateConnection } from '../../api/connections';
import { testConnection } from '../../api/connections';
import { TechLogo } from '../agents/setup/logos';

const inputClass =
  'w-full h-11 rounded-xl border border-slate-300 px-4 bg-white outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200 transition-all';

function InputField({ label, required, error, hint, children }) {
  return (
    <div>
      <label className="block text-sm font-semibold text-slate-700 mb-2">
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      {children}
      {hint && !error && <p className="text-slate-400 text-xs mt-1">{hint}</p>}
      {error && <p className="text-red-500 text-sm mt-1">{error}</p>}
    </div>
  );
}

const COSMOS_API_TYPES = [
  { value: 'sql', label: 'SQL (Core) API' },
  { value: 'mongodb', label: 'MongoDB API — coming soon', disabled: true },
  { value: 'cassandra', label: 'Cassandra API — coming soon', disabled: true },
  { value: 'gremlin', label: 'Gremlin API — coming soon', disabled: true },
  { value: 'table', label: 'Table API — coming soon', disabled: true },
];

export default function CosmosDBEditConnectionPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState(null);
  const [hadSecondaryKey, setHadSecondaryKey] = useState(false);

  const { register, handleSubmit, reset, getValues, formState: { errors } } = useForm();

  useEffect(() => {
    getConnectionDetails('cosmosdb', id).then((res) => {
      const c = res.data;
      setHadSecondaryKey(!!c.has_secondary_key);
      reset({
        connectionName: c.connection_name,
        cosmosAccountName: c.account_name,
        cosmosEndpoint: c.endpoint,
        cosmosApiType: c.api_type || 'sql',
        cosmosDatabaseName: c.database_name,
        cosmosContainerName: c.container_name,
        cosmosPartitionKey: c.partition_key,
        cosmosPreferredRegion: c.preferred_region,
        cosmosConsistencyLevel: c.consistency_level || '',
        cosmosConnectionTimeout: c.connection_timeout_sec || 30,
        cosmosSslEnabled: c.ssl_enabled === false ? 'false' : 'true',
        cosmosDescription: c.description,
        cosmosResourceGroup: c.resource_group,
        cosmosSubscriptionId: c.subscription_id,
      });
    }).catch((e) => setMessage({ type: 'error', text: e?.response?.data?.detail || e.message || 'Failed to load connection' }))
      .finally(() => setLoading(false));
  }, [id, reset]);

  const buildPayload = (data) => ({
    connection_name: data.connectionName,
    account_name: data.cosmosAccountName || undefined,
    endpoint: data.cosmosEndpoint,
    primary_key: data.cosmosPrimaryKey || undefined,          // blank = keep existing
    secondary_key: data.cosmosSecondaryKey || undefined,      // blank = keep existing
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
  });

  const handleTest = async () => {
    setTesting(true); setMessage(null);
    try {
      const data = getValues();
      await testConnection('CosmosDB', {
        endpoint: data.cosmosEndpoint,
        primary_key: data.cosmosPrimaryKey,
        database_name: data.cosmosDatabaseName,
        container_name: data.cosmosContainerName,
        connection_timeout_sec: data.cosmosConnectionTimeout,
      });
      setMessage({ type: 'success', text: data.cosmosPrimaryKey ? 'Connection successful' : 'Connection successful (tested with a new Primary Key — leave it blank on save to keep the existing one)' });
    } catch (e) {
      setMessage({ type: 'error', text: e?.response?.data?.detail || e.message || 'Connection failed' });
    } finally { setTesting(false); }
  };

  const onSave = async (data) => {
    setSaving(true); setMessage(null);
    try {
      await updateConnection('cosmosdb', id, buildPayload(data));
      setMessage({ type: 'success', text: 'Connection updated successfully' });
      setTimeout(() => navigate(`/cosmosdb-dashboard/${id}`), 900);
    } catch (e) {
      setMessage({ type: 'error', text: e?.response?.data?.detail || e.message || 'Failed to update connection' });
    } finally { setSaving(false); }
  };

  const messageBlock = message && (
    <div className={`mt-6 rounded-xl px-4 py-3 border flex items-center gap-3 ${
      message.type === 'success' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
      {message.type === 'success' ? <CheckCircle2 className="w-5 h-5 flex-shrink-0" /> : <AlertTriangle className="w-5 h-5 flex-shrink-0" />}
      {message.text}
    </div>
  );

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-slate-400">Loading connection…</div>;
  }

  return (
    <div className="-mx-6 md:-mx-8 -mb-6 md:-mb-8 min-h-full bg-white flex flex-col pb-16">
      <div className="flex items-center justify-between px-6 py-3.5 border-b border-slate-200 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <TechLogo id="cosmosdb" size={28} />
          <span className="text-lg font-black text-slate-800">Edit Azure Cosmos DB Connection</span>
        </div>
        <button onClick={() => navigate(`/cosmosdb-dashboard/${id}`)} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
      </div>

      <div className="flex-1 overflow-y-auto px-10 py-8 max-w-[900px]">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <InputField label="Connection Name" required error={errors.connectionName?.message}>
            <input {...register('connectionName', { required: 'Connection name required' })} className={inputClass} />
          </InputField>
          <InputField label="Account Name (optional if Endpoint is provided)">
            <input {...register('cosmosAccountName')} className={inputClass} />
          </InputField>
          <InputField label="Endpoint URL" required error={errors.cosmosEndpoint?.message}>
            <input {...register('cosmosEndpoint', { required: 'Endpoint URL required' })} className={inputClass} />
          </InputField>
          <InputField label="API Type">
            <select {...register('cosmosApiType')} className={inputClass}>
              {COSMOS_API_TYPES.map((t) => <option key={t.value} value={t.value} disabled={t.disabled}>{t.label}</option>)}
            </select>
          </InputField>
          <InputField label="Primary Key" hint="Leave blank to keep the currently saved key">
            <input type="password" {...register('cosmosPrimaryKey')} placeholder="Leave blank to keep existing" className={inputClass} />
          </InputField>
          <InputField label="Secondary Key (optional)" hint={hadSecondaryKey ? 'A secondary key is already saved — leave blank to keep it' : undefined}>
            <input type="password" {...register('cosmosSecondaryKey')} placeholder="Leave blank to keep existing" className={inputClass} />
          </InputField>
          <InputField label="Database Name" required error={errors.cosmosDatabaseName?.message}>
            <input {...register('cosmosDatabaseName', { required: 'Database name required' })} className={inputClass} />
          </InputField>
          <InputField label="Container Name" required error={errors.cosmosContainerName?.message}>
            <input {...register('cosmosContainerName', { required: 'Container name required' })} className={inputClass} />
          </InputField>
          <InputField label="Partition Key (optional)">
            <input {...register('cosmosPartitionKey')} placeholder="/id" className={inputClass} />
          </InputField>
          <InputField label="Preferred Region (optional)">
            <input {...register('cosmosPreferredRegion')} className={inputClass} />
          </InputField>
          <InputField label="Consistency Level (optional)">
            <select {...register('cosmosConsistencyLevel')} className={inputClass}>
              <option value="">Account default</option>
              <option value="Strong">Strong</option>
              <option value="BoundedStaleness">Bounded Staleness</option>
              <option value="Session">Session</option>
              <option value="ConsistentPrefix">Consistent Prefix</option>
              <option value="Eventual">Eventual</option>
            </select>
          </InputField>
          <InputField label="Connection Timeout (seconds)">
            <input type="number" {...register('cosmosConnectionTimeout')} className={inputClass} />
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
            <input {...register('cosmosProxy')} className={inputClass} />
          </InputField>
        </div>

        <div className="grid grid-cols-1 gap-5 mt-5">
          <InputField label="Custom Headers (optional, JSON)">
            <textarea {...register('cosmosCustomHeaders')} rows={2} className={`${inputClass} h-auto py-2.5 font-mono text-sm`} />
          </InputField>
          <InputField label="Description (optional)">
            <textarea {...register('cosmosDescription')} rows={2} className={`${inputClass} h-auto py-2.5`} />
          </InputField>
        </div>

        {messageBlock}

        <div className="flex items-center gap-2 mt-8">
          <button onClick={handleTest} disabled={testing}
            className="h-10 px-5 rounded-lg border border-slate-300 text-slate-700 text-sm font-bold hover:bg-slate-50 disabled:opacity-40">
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
          <button onClick={handleSubmit(onSave)} disabled={saving}
            className="h-10 px-6 rounded-lg bg-blue-700 text-white text-sm font-bold hover:bg-blue-800 disabled:opacity-40">
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
          <button onClick={() => navigate(`/cosmosdb-dashboard/${id}`)}
            className="h-10 px-4 rounded-lg text-slate-600 text-sm font-bold hover:bg-slate-100">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
