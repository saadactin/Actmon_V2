import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Loader2 } from 'lucide-react';
import { useCreateCloudAccount } from '../hooks/useCloudAccounts';
import { CloudAccountCreatePayload } from '../types/cloud';
import { useToast } from '../../../components/ui/ToastProvider';
import { useCloudStore } from '../state/cloudStore';
import { useNavigate } from 'react-router-dom';

type Provider = 'AWS' | 'Azure' | 'OCI';

const PROVIDERS: { id: Provider; label: string; hint: string; activeText: string; activeBg: string }[] = [
  { id: 'AWS', label: 'AWS', hint: 'Amazon Web Services', activeText: 'text-orange-700', activeBg: 'bg-orange-50' },
  { id: 'Azure', label: 'Azure', hint: 'Microsoft Azure', activeText: 'text-sky-700', activeBg: 'bg-sky-50' },
  { id: 'OCI', label: 'OCI', hint: 'Oracle Cloud', activeText: 'text-red-700', activeBg: 'bg-red-50' },
];

const LBL = 'block text-sm font-medium text-gray-700 mb-1';
const INP = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500';

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
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Provider selector */}
      <div>
        <label className={LBL}>Cloud Provider</label>
        <div className="grid grid-cols-3 gap-2">
          {PROVIDERS.map((p) => {
            const active = provider === p.id;
            return (
              <button key={p.id} type="button" onClick={() => setProvider(p.id)}
                className={`rounded-lg border-2 px-3 py-3 text-left transition-colors ${
                  active ? `border-blue-500 shadow-sm ${p.activeBg}` : 'border-gray-200 bg-white hover:border-gray-300'
                }`}>
                <span className={`block text-sm font-bold ${active ? p.activeText : 'text-gray-700'}`}>{p.label}</span>
                <span className="block text-[11px] text-gray-500 mt-0.5 leading-tight">{p.hint}</span>
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
        <div>
          <label className={LBL}>
            {provider === 'AWS' ? 'Default Region' : provider === 'OCI' ? 'Primary Region' : 'Tenant / Region'}
          </label>
          <input className={INP} {...register('tenant_or_region', { required: true })}
            placeholder={provider === 'AWS' ? 'e.g. ap-south-1' : provider === 'OCI' ? 'e.g. ap-mumbai-1' : 'e.g. us-east-1'} />
          {provider === 'AWS' && (
            <p className="mt-1 text-[11px] text-gray-500">
              Used as the default API endpoint; discovery scans all enabled regions.
            </p>
          )}
        </div>
      </div>

      {/* Credentials — per provider */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Credentials</p>

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
            <div><label className={LBL}>Passphrase <span className="text-gray-400 font-normal">(optional)</span></label><input className={INP} type="password" {...register('oci_passphrase')} /></div>
          </>
        )}
      </div>

      <label className="flex items-center gap-2.5 cursor-pointer select-none">
        <input type="checkbox" className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" {...register('auto_discovery')} />
        <span className="text-sm font-medium text-gray-700">Enable Auto-Discovery after connecting</span>
      </label>

      <div className="flex justify-end gap-2 pt-4 border-t border-gray-100">
        <button type="submit" disabled={isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
          {isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Connecting…</> : 'Add Account'}
        </button>
      </div>
    </form>
  );
};
