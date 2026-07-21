import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Loader2 } from 'lucide-react';
import { useCreateCloudAccount } from '../hooks/useCloudAccounts';
import { CloudAccountCreatePayload } from '../types/cloud';
import { useToast } from '../../../components/ui/ToastProvider';
import { useCloudStore } from '../state/cloudStore';
import { useNavigate } from 'react-router-dom';

type Provider = 'AWS' | 'Azure' | 'OCI';

const PROVIDERS: { id: Provider; label: string; hint: string; color: string; bg: string }[] = [
  { id: 'AWS', label: 'AWS', hint: 'Amazon Web Services', color: '#b45309', bg: '#fff7ed' },
  { id: 'Azure', label: 'Azure', hint: 'Microsoft Azure', color: '#1d4ed8', bg: '#eff6ff' },
  { id: 'OCI', label: 'OCI', hint: 'Oracle Cloud', color: '#b91c1c', bg: '#fef2f2' },
];

const LBL = 'block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5';
const INP = 'w-full h-10 px-3 rounded-xl border border-slate-200 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 bg-white transition-all';

export const AddCloudAccountForm = ({ onSuccess }: { onSuccess?: () => void }) => {
  const [provider, setProvider] = useState<Provider>('AWS');
  const { register, handleSubmit, reset } = useForm<CloudAccountCreatePayload>();
  const { mutateAsync: createAccount, isPending } = useCreateCloudAccount();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const setSelectedAccountId = useCloudStore((state) => state.setSelectedAccountId);

  const onSubmit = async (data: CloudAccountCreatePayload) => {
    try {
      const payload = {
        ...data,
        provider,
        tenant_or_region: provider === 'AWS' ? 'us-east-1' : data.tenant_or_region,
      };
      const newAccount = await createAccount(payload);
      addToast('Cloud account added successfully.', 'success');
      reset();
      if (onSuccess) onSuccess();
      if (newAccount && newAccount.id) {
        setSelectedAccountId(newAccount.id);
        navigate('/cloud/resources');
      }
    } catch (error: any) {
      addToast(error?.response?.data?.detail || 'Failed to add cloud account', 'error');
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      {/* Provider selector */}
      <div>
        <label className={LBL}>Cloud Provider</label>
        <div className="grid grid-cols-3 gap-2">
          {PROVIDERS.map((p) => {
            const active = provider === p.id;
            return (
              <button key={p.id} type="button" onClick={() => setProvider(p.id)}
                className={`rounded-xl border-2 px-3 py-3 text-left transition-all ${active ? 'border-blue-500 shadow-sm' : 'border-slate-200 hover:border-slate-300'}`}
                style={active ? { background: p.bg } : { background: '#ffffff' }}>
                <span className="block text-sm font-black" style={{ color: active ? p.color : '#334155' }}>{p.label}</span>
                <span className="block text-[10px] text-slate-400 mt-0.5 leading-tight">{p.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className={LBL}>Profile Name (Alias)</label>
        <input className={INP} {...register('account_name', { required: true })} placeholder="e.g. Prod AWS" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LBL}>Environment</label>
          <select className={INP} {...register('environment')}>
            <option value="Production">Production</option>
            <option value="Staging">Staging</option>
            <option value="Development">Development</option>
          </select>
        </div>
        {provider !== 'AWS' && (
          <div>
            <label className={LBL}>{provider === 'OCI' ? 'Primary Region' : 'Tenant / Region'}</label>
            <input className={INP} {...register('tenant_or_region', { required: provider !== 'AWS' })}
              placeholder={provider === 'OCI' ? 'e.g. ap-mumbai-1' : 'e.g. us-east-1'} />
          </div>
        )}
      </div>

      {/* Credentials — per provider */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-4">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Credentials</p>

        {provider === 'AWS' && (
          <>
            <div><label className={LBL}>Access Key ID</label><input className={INP} {...register('access_key_id', { required: provider === 'AWS' })} placeholder="AKIA…" /></div>
            <div><label className={LBL}>Secret Access Key</label><input className={INP} type="password" {...register('secret_access_key', { required: provider === 'AWS' })} placeholder="••••••••" /></div>
          </>
        )}

        {provider === 'Azure' && (
          <>
            <div><label className={LBL}>Tenant ID</label><input className={INP} {...register('tenant_id', { required: provider === 'Azure' })} /></div>
            <div><label className={LBL}>Client ID</label><input className={INP} {...register('client_id', { required: provider === 'Azure' })} /></div>
            <div><label className={LBL}>Client Secret</label><input className={INP} type="password" {...register('client_secret', { required: provider === 'Azure' })} placeholder="••••••••" /></div>
            <div><label className={LBL}>Subscription ID</label><input className={INP} {...register('subscription_id', { required: provider === 'Azure' })} /></div>
          </>
        )}

        {provider === 'OCI' && (
          <>
            <div><label className={LBL}>Tenancy OCID</label><input className={INP} {...register('oci_tenancy_ocid', { required: provider === 'OCI' })} /></div>
            <div><label className={LBL}>User OCID</label><input className={INP} {...register('oci_user_ocid', { required: provider === 'OCI' })} /></div>
            <div><label className={LBL}>Fingerprint</label><input className={INP} {...register('oci_fingerprint', { required: provider === 'OCI' })} /></div>
            <div><label className={LBL}>Private Key Content</label><textarea className={`${INP} h-24 py-2 resize-none font-mono text-xs`} {...register('oci_private_key_content', { required: provider === 'OCI' })} placeholder="-----BEGIN PRIVATE KEY-----" /></div>
            <div><label className={LBL}>Passphrase <span className="text-slate-300 font-normal normal-case">(optional)</span></label><input className={INP} type="password" {...register('oci_passphrase')} /></div>
          </>
        )}
      </div>

      <label className="flex items-center gap-2.5 cursor-pointer select-none">
        <input type="checkbox" className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" {...register('auto_discovery')} />
        <span className="text-sm text-slate-600 font-medium">Enable Auto-Discovery after connecting</span>
      </label>

      <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
        <button type="submit" disabled={isPending}
          className="inline-flex items-center gap-2 h-10 px-6 rounded-xl text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-all shadow-sm">
          {isPending ? <><Loader2 size={15} className="animate-spin" /> Connecting…</> : 'Add Account'}
        </button>
      </div>
    </form>
  );
};
