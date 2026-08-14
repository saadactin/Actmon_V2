import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { useCreateCloudAccount } from '../hooks/useCloudAccounts';
import { useCloudStore } from '../state/cloudStore';
import { slugForProvider } from '../utils/providerScope';
import Input from '@/components/ui/Input';
import Textarea from '@/components/ui/Textarea';
import Button from '@/components/ui/Button';

// Brand colours are pinned (not theme tokens) — same provider identity used by
// CloudProviderSelector / CloudProviderChooser.
const PROVIDERS = [
  { id: 'AWS', label: 'AWS', hint: 'Amazon Web Services', activeText: 'text-orange-700', activeBg: 'bg-orange-50' },
  { id: 'Azure', label: 'Azure', hint: 'Microsoft Azure', activeText: 'text-sky-700', activeBg: 'bg-sky-50' },
  { id: 'OCI', label: 'OCI', hint: 'Oracle Cloud', activeText: 'text-red-700', activeBg: 'bg-red-50' },
];

const LBL = 'block text-[12px] font-semibold text-fg mb-1';

/** `push` is the toast emitter passed down from CloudShell (its own useToasts()). */
export const AddCloudAccountForm = ({ onSuccess, push }) => {
  // Defaults to whichever provider's page the drawer was opened from (e.g.
  // /cloud/azure-accounts → Azure pre-selected), same as /mysql-servers'
  // "Add Server" defaulting to MySQL — falls back to AWS from the cross-
  // provider /cloud/accounts page or the chooser, where nothing is scoped.
  const scopeProviderKey = useCloudStore((state) => state.scopeProviderKey);
  const [provider, setProvider] = useState(scopeProviderKey || 'AWS');
  const { register, handleSubmit, reset } = useForm();
  const { mutateAsync: createAccount, isPending } = useCreateCloudAccount();
  const navigate = useNavigate();
  const setSelectedAccountId = useCloudStore((state) => state.setSelectedAccountId);

  const onSubmit = async (data) => {
    try {
      const payload = {
        ...data,
        provider,
      };
      const newAccount = await createAccount(payload);
      push?.('Cloud account added successfully.', 'success');
      reset();
      if (onSuccess) onSuccess();
      if (newAccount && newAccount.id) {
        setSelectedAccountId(newAccount.id);
        navigate(`/cloud/${slugForProvider(provider)}-accounts/${newAccount.id}`);
      }
    } catch (error) {
      push?.(error?.response?.data?.detail || 'Failed to add cloud account', 'error');
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
                className={`rounded-control border-2 px-3 py-3 text-left transition-colors ${
                  active ? `border-accent shadow-sm ${p.activeBg}` : 'border-border bg-surface hover:border-strong'
                }`}>
                <span className={`block text-sm font-bold ${active ? p.activeText : 'text-fg'}`}>{p.label}</span>
                <span className="block text-[11px] text-muted mt-0.5 leading-tight">{p.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className={LBL}>Profile Name (Alias)</label>
        <Input {...register('account_name', { required: true })} placeholder="e.g. Prod AWS" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LBL}>Environment</label>
          <select
            className="h-control w-full rounded-control border border-border bg-surface px-2.5 text-[13px] text-fg transition-colors hover:border-strong focus:outline-none focus:ring-2 focus:ring-accent"
            {...register('environment')}
          >
            <option value="Production">Production</option>
            <option value="Staging">Staging</option>
            <option value="Development">Development</option>
          </select>
        </div>
        <div>
          <label className={LBL}>
            {provider === 'AWS' ? 'Default Region' : provider === 'OCI' ? 'Primary Region' : 'Tenant / Region'}
          </label>
          <Input {...register('tenant_or_region', { required: true })}
            placeholder={provider === 'AWS' ? 'e.g. ap-south-1' : provider === 'OCI' ? 'e.g. ap-mumbai-1' : 'e.g. us-east-1'} />
          {provider === 'AWS' && (
            <p className="mt-1 text-[11px] text-subtle">
              Used as the default API endpoint; discovery scans all enabled regions.
            </p>
          )}
        </div>
      </div>

      {/* Credentials — per provider */}
      <div className="rounded-card border border-border bg-sunken p-card space-y-4">
        <p className="text-xs font-semibold text-subtle uppercase tracking-wider">Credentials</p>

        {provider === 'AWS' && (
          <>
            <div><label className={LBL}>Access Key ID</label><Input {...register('access_key_id', { required: provider === 'AWS' })} placeholder="AKIA…" /></div>
            <div><label className={LBL}>Secret Access Key</label><Input type="password" {...register('secret_access_key', { required: provider === 'AWS' })} placeholder="••••••••" /></div>
          </>
        )}

        {provider === 'Azure' && (
          <>
            <div><label className={LBL}>Tenant ID</label><Input {...register('tenant_id', { required: provider === 'Azure' })} /></div>
            <div><label className={LBL}>Client ID</label><Input {...register('client_id', { required: provider === 'Azure' })} /></div>
            <div><label className={LBL}>Client Secret</label><Input type="password" {...register('client_secret', { required: provider === 'Azure' })} placeholder="••••••••" /></div>
            <div><label className={LBL}>Subscription ID</label><Input {...register('subscription_id', { required: provider === 'Azure' })} /></div>
          </>
        )}

        {provider === 'OCI' && (
          <>
            <div><label className={LBL}>Tenancy OCID</label><Input {...register('oci_tenancy_ocid', { required: provider === 'OCI' })} /></div>
            <div><label className={LBL}>User OCID</label><Input {...register('oci_user_ocid', { required: provider === 'OCI' })} /></div>
            <div><label className={LBL}>Fingerprint</label><Input {...register('oci_fingerprint', { required: provider === 'OCI' })} /></div>
            <div>
              <label className={LBL}>Private Key Content</label>
              <Textarea
                rows={4}
                className="resize-none font-mono text-xs"
                {...register('oci_private_key_content', { required: provider === 'OCI' })}
                placeholder="-----BEGIN PRIVATE KEY-----"
              />
            </div>
            <div><label className={LBL}>Passphrase <span className="text-subtle font-normal">(optional)</span></label><Input type="password" {...register('oci_passphrase')} /></div>
          </>
        )}
      </div>

      <label className="flex items-center gap-2.5 cursor-pointer select-none">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-border accent-[var(--accent)] focus:ring-2 focus:ring-accent"
          {...register('auto_discovery')}
        />
        <span className="text-sm font-medium text-fg">Enable Auto-Discovery after connecting</span>
      </label>

      <div className="flex justify-end gap-2 pt-4 border-t border-border">
        <Button type="submit" variant="primary" loading={isPending}>
          {isPending ? 'Connecting…' : 'Add Account'}
        </Button>
      </div>
    </form>
  );
};
