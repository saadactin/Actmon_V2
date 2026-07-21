import React, { useState, useEffect } from 'react';
import { listAccounts, addAccount, getInventory } from '../../api/cloud';
import { useToast } from '../../components/ui/ToastProvider';
import { DataTable } from '../../components/ui/DataTable';
import { DrawerPanel } from '../../components/ui/DrawerPanel';
import { useForm } from 'react-hook-form';
import {
  Button,
  Spinner,
  Field,
  Input,
  Select,
  Checkbox,
  Card,
} from '@fluentui/react-components';
import { Cloud, Plus, CloudLightning, Server } from 'lucide-react';

export const CloudPage = () => {
  const { addToast } = useToast();
  const [accounts, setAccounts] = useState([]);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [inventory, setInventory] = useState([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingInventory, setLoadingInventory] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // New account form provider
  const [formProvider, setFormProvider] = useState('Oracle');

  const { register, handleSubmit, reset } = useForm();

  // Fetch accounts list
  const fetchAccounts = async () => {
    setLoadingAccounts(true);
    try {
      const data = await listAccounts();
      setAccounts(data);
      if (data.length > 0 && !selectedAccount) {
        setSelectedAccount(data[0]);
      }
    } catch (err) {
      addToast('Failed to fetch cloud account registry.', 'error');
    } finally {
      setLoadingAccounts(false);
    }
  };

  useEffect(() => {
    fetchAccounts();
  }, []);

  // Fetch inventory when active account changes
  useEffect(() => {
    const fetchInv = async () => {
      if (!selectedAccount) {
        setInventory([]);
        return;
      }
      setLoadingInventory(true);
      try {
        const data = await getInventory(selectedAccount.provider, selectedAccount.id);
        setInventory(data);
      } catch (err) {
        addToast(`Failed to load asset inventory for ${selectedAccount.account_name}`, 'error');
        setInventory([]);
      } finally {
        setLoadingInventory(false);
      }
    };
    fetchInv();
  }, [selectedAccount]);

  const handleOpenDrawer = () => {
    reset({
      provider: 'Oracle',
      auto_discovery: true,
      oci_passphrase: '',
      session_token: '',
    });
    setDrawerOpen(true);
  };

  const handleSaveAccount = async (data) => {
    try {
      const payload = {
        ...data,
        provider: formProvider,
        auto_discovery: !!data.auto_discovery,
      };
      const res = await addAccount(payload);
      addToast(`Cloud discovery profile "${res.account_name}" created.`, 'success');
      setDrawerOpen(false);
      fetchAccounts();
    } catch (err) {
      addToast(err.response?.data?.message || err.message || 'Failed to save cloud profile.', 'error');
    }
  };

  const columns = [
    {
      key: 'resource_name',
      label: 'Resource Name',
      sortable: true,
      render: (item) => (
        <span className="font-semibold text-brand-text-primary flex items-center gap-2">
          <Server className="h-4 w-4 text-gray-400" />
          <span>{item.resource_name}</span>
        </span>
      ),
    },
    {
      key: 'resource_type',
      label: 'Resource Type',
      sortable: true,
      render: (item) => (
        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-gray-150 text-gray-700">
          {item.resource_type}
        </span>
      ),
    },
    {
      key: 'region_or_zone',
      label: 'Region / Zone',
      sortable: true,
    },
    {
      key: 'ip_address',
      label: 'IP Address',
      render: (item) => item.ip_address || '-',
    },
    {
      key: 'status',
      label: 'Asset Status',
      sortable: true,
      render: (item) => {
        const isHealthy = item.status?.toLowerCase() === 'running' || item.status?.toLowerCase() === 'active' || item.status?.toLowerCase() === 'healthy';
        return (
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
              isHealthy
                ? 'bg-green-50/50 border-green-200 text-[#107C10]'
                : 'bg-red-50/50 border-red-200 text-[#A4262C]'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${isHealthy ? 'bg-[#107C10]' : 'bg-[#A4262C]'}`} />
            {item.status}
          </span>
        );
      },
    },
  ];

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Title block */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-brand-text-primary">Cloud Infrastructure Assets</h1>
          <p className="text-sm text-brand-text-secondary">
            Integrate OCI, AWS, and Azure resource inventories for discovery scanning.
          </p>
        </div>
        <div>
          <Button appearance="primary" icon={<Plus className="h-4 w-4" />} onClick={handleOpenDrawer}>
            Add Cloud Account
          </Button>
        </div>
      </div>

      {/* Cloud accounts overview lists */}
      {loadingAccounts ? (
        <div className="flex justify-center items-center py-10">
          <Spinner size="large" label="Querying cloud configurations..." />
        </div>
      ) : accounts.length === 0 ? (
        <Card className="p-8 text-center flex flex-col items-center justify-center border-dashed border-brand-border">
          <Cloud className="h-12 w-12 text-gray-300 mb-2" />
          <h3 className="font-semibold text-brand-text-primary">No Cloud Profiles Registered</h3>
          <p className="text-xs text-brand-text-secondary max-w-sm mt-1">
            Connect your cloud management provider credentials to trigger background discovery jobs.
          </p>
          <Button appearance="primary" className="mt-4" onClick={handleOpenDrawer}>
            Connect Provider
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">
          {/* Account sidebar panel */}
          <div className="space-y-3 bg-white p-4 border border-brand-border rounded-card shadow-card">
            <h3 className="text-xs font-bold text-brand-text-secondary uppercase tracking-wider px-2">Discovery Targets</h3>
            <div className="space-y-1">
              {accounts.map((acc) => (
                <button
                  key={acc.id}
                  onClick={() => setSelectedAccount(acc)}
                  className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-all flex items-center justify-between border ${
                    selectedAccount?.id === acc.id
                      ? 'bg-brand-primary-light/10 text-brand-primary border-brand-primary/20 font-semibold'
                      : 'hover:bg-gray-50 border-transparent text-brand-text-primary'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <CloudLightning className="h-4 w-4" />
                    <span>{acc.account_name}</span>
                  </div>
                  <span className="text-[10px] uppercase font-bold text-gray-400">{acc.provider}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Account inventory grid */}
          <div className="lg:col-span-3 space-y-4">
            {selectedAccount && (
              <div className="bg-white p-4 border border-brand-border rounded-card shadow-card flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-brand-text-primary">
                    Inventory: {selectedAccount.account_name} ({selectedAccount.provider})
                  </h2>
                  <p className="text-xs text-brand-text-secondary">
                    Region: <span className="font-semibold">{selectedAccount.tenant_or_region}</span> | Env:{' '}
                    <span className="font-semibold">{selectedAccount.environment}</span> | Discovery Mode:{' '}
                    <span className="font-semibold">{selectedAccount.auto_discovery ? 'Auto-Scan' : 'Manual'}</span>
                  </p>
                </div>
                {selectedAccount.last_discovery && (
                  <span className="text-xs text-brand-text-secondary">
                    Last Discovery Scan: {new Date(selectedAccount.last_discovery).toLocaleString()}
                  </span>
                )}
              </div>
            )}

            {loadingInventory ? (
              <div className="flex justify-center items-center py-20 bg-white border border-brand-border rounded-card shadow-card">
                <Spinner size="medium" label="Syncing provider catalogs..." />
              </div>
            ) : (
              <DataTable
                columns={columns}
                data={inventory}
                rowKeyField="id"
                emptyState={
                  <div className="text-center py-12 text-brand-text-secondary">
                    No resources discovered under this cloud directory target. Check scan schedules.
                  </div>
                }
              />
            )}
          </div>
        </div>
      )}

      {/* Connection drawer */}
      <DrawerPanel
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Connect Cloud Account"
      >
        <form onSubmit={handleSubmit(handleSaveAccount)} className="space-y-4">
          <Field label="Cloud Provider" required>
            <Select
              value={formProvider}
              onChange={(_, d) => setFormProvider(d.value)}
            >
              <option value="Oracle">Oracle Cloud (OCI)</option>
              <option value="AWS">Amazon Web Services (AWS)</option>
              <option value="Azure">Microsoft Azure</option>
            </Select>
          </Field>

          <Field label="Account Profile Name" required>
            <Input {...register('account_name', { required: true })} placeholder="e.g. OCI Prod Tenancy" />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Environment Target" required>
              <Select {...register('environment')}>
                <option value="Production">Production</option>
                <option value="Staging">Staging</option>
                <option value="Development">Development</option>
              </Select>
            </Field>

            <Field label="Discovery Region" required>
              <Input {...register('tenant_or_region', { required: true })} placeholder="e.g. us-east-1" />
            </Field>
          </div>

          <Field label="Authentication Mechanism" required>
            <Select {...register('auth_mode')}>
              <option value="API_Keys">API Access Keys</option>
              <option value="IAM_Role">IAM Integration Profile</option>
            </Select>
          </Field>

          {/* OCI form */}
          {formProvider === 'Oracle' && (
            <div className="space-y-4">
              <Field label="User OCID" required>
                <Input {...register('oci_user_ocid', { required: formProvider === 'Oracle' })} placeholder="ocid1.user.oc1..." />
              </Field>
              <Field label="Private Key Fingerprint" required>
                <Input {...register('oci_fingerprint', { required: formProvider === 'Oracle' })} placeholder="20:3b:97..." />
              </Field>
              <Field label="OCI Private Key Content" required>
                <Input {...register('oci_private_key_content', { required: formProvider === 'Oracle' })} placeholder="-----BEGIN RSA PRIVATE KEY-----" />
              </Field>
              <Field label="Passphrase (Optional)">
                <Input {...register('oci_passphrase')} type="password" />
              </Field>
            </div>
          )}

          {/* AWS form */}
          {formProvider === 'AWS' && (
            <div className="space-y-4">
              <Field label="AWS Access Key ID" required>
                <Input {...register('access_key_id', { required: formProvider === 'AWS' })} placeholder="AKIA..." />
              </Field>
              <Field label="AWS Secret Access Key" required>
                <Input {...register('secret_access_key', { required: formProvider === 'AWS' })} type="password" placeholder="wJalrX..." />
              </Field>
              <Field label="AWS Session Token (Optional)">
                <Input {...register('session_token')} placeholder="Token strings" />
              </Field>
            </div>
          )}

          {/* Azure form */}
          {formProvider === 'Azure' && (
            <div className="space-y-4">
              <Field label="Directory (Tenant) ID" required>
                <Input {...register('tenant_id', { required: formProvider === 'Azure' })} placeholder="00000000-0000..." />
              </Field>
              <Field label="Application (Client) ID" required>
                <Input {...register('client_id', { required: formProvider === 'Azure' })} placeholder="00000000-0000..." />
              </Field>
              <Field label="Client Secret" required>
                <Input {...register('client_secret', { required: formProvider === 'Azure' })} type="password" />
              </Field>
              <Field label="Subscription ID" required>
                <Input {...register('subscription_id', { required: formProvider === 'Azure' })} placeholder="00000000-0000..." />
              </Field>
            </div>
          )}

          <div className="py-2">
            <Checkbox {...register('auto_discovery')} label="Enable Nightly Resource Auto-Discovery Scans" />
          </div>

          <div className="flex gap-2 pt-6 justify-end border-t border-brand-border mt-6">
            <Button type="button" appearance="secondary" onClick={() => setDrawerOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" appearance="primary">
              Connect Account
            </Button>
          </div>
        </form>
      </DrawerPanel>
    </div>
  );
};
