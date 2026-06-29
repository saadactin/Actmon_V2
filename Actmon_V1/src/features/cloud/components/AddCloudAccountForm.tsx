import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button, Field, Input, Select, Checkbox, Spinner } from '@fluentui/react-components';
import { useCreateCloudAccount } from '../hooks/useCloudAccounts';
import { CloudAccountCreatePayload } from '../types/cloud';
import { useToast } from '../../../components/ui/ToastProvider';
import { useCloudStore } from '../state/cloudStore';
import { useNavigate } from 'react-router-dom';

export const AddCloudAccountForm = ({ onSuccess }: { onSuccess?: () => void }) => {
  const [provider, setProvider] = useState<'AWS' | 'Azure' | 'OCI'>('AWS');
  const { register, handleSubmit, reset } = useForm<CloudAccountCreatePayload>();
  const { mutateAsync: createAccount, isPending } = useCreateCloudAccount();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const setSelectedAccountId = useCloudStore(state => state.setSelectedAccountId);

  const onSubmit = async (data: CloudAccountCreatePayload) => {
    try {
      const payload = { 
        ...data, 
        provider,
        tenant_or_region: provider === 'AWS' ? 'us-east-1' : data.tenant_or_region 
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
      <Field label="Cloud Provider" required>
        <Select value={provider} onChange={(e) => setProvider(e.target.value as any)}>
          <option value="AWS">Amazon Web Services (AWS)</option>
          <option value="Azure">Microsoft Azure</option>
          <option value="OCI">Oracle Cloud (OCI)</option>
        </Select>
      </Field>

      <Field label="Profile Name (Alias)" required>
        <Input {...register('account_name', { required: true })} placeholder="e.g. Prod AWS" />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Environment">
          <Select {...register('environment')}>
            <option value="Production">Production</option>
            <option value="Staging">Staging</option>
            <option value="Development">Development</option>
          </Select>
        </Field>
        {provider !== 'AWS' && (
          <Field label={provider === 'OCI' ? 'Primary Region' : 'Tenant / Region'} required>
            <Input {...register('tenant_or_region', { required: provider !== 'AWS' })} placeholder={provider === 'OCI' ? 'e.g. ap-mumbai-1' : 'e.g. us-east-1'} />
          </Field>
        )}
      </div>

      {provider === 'AWS' && (
        <div className="space-y-4">
          <Field label="Access Key ID" required>
            <Input {...register('access_key_id', { required: provider === 'AWS' })} />
          </Field>
          <Field label="Secret Access Key" required>
            <Input {...register('secret_access_key', { required: provider === 'AWS' })} type="password" />
          </Field>
        </div>
      )}

      {provider === 'Azure' && (
        <div className="space-y-4">
          <Field label="Tenant ID" required>
            <Input {...register('tenant_id', { required: provider === 'Azure' })} />
          </Field>
          <Field label="Client ID" required>
            <Input {...register('client_id', { required: provider === 'Azure' })} />
          </Field>
          <Field label="Client Secret" required>
            <Input {...register('client_secret', { required: provider === 'Azure' })} type="password" />
          </Field>
          <Field label="Subscription ID" required>
            <Input {...register('subscription_id', { required: provider === 'Azure' })} />
          </Field>
        </div>
      )}

      {provider === 'OCI' && (
        <div className="space-y-4">
          <Field label="Tenancy OCID" required>
            <Input {...register('oci_tenancy_ocid', { required: provider === 'OCI' })} />
          </Field>
          <Field label="User OCID" required>
            <Input {...register('oci_user_ocid', { required: provider === 'OCI' })} />
          </Field>
          <Field label="Fingerprint" required>
            <Input {...register('oci_fingerprint', { required: provider === 'OCI' })} />
          </Field>
          <Field label="Private Key Content" required>
            <Input {...register('oci_private_key_content', { required: provider === 'OCI' })} />
          </Field>
          <Field label="Passphrase">
            <Input {...register('oci_passphrase')} type="password" />
          </Field>
        </div>
      )}

      <div className="py-2">
        <Checkbox {...register('auto_discovery')} label="Enable Auto-Discovery" />
      </div>

      <div className="flex justify-end mt-6">
        <Button type="submit" appearance="primary" disabled={isPending}>
          {isPending ? <Spinner size="tiny" /> : 'Add Account'}
        </Button>
      </div>
    </form>
  );
};
