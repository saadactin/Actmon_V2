import React, { useState, useEffect } from 'react';
import { listAccounts, addAccount, getInventory, deleteAccount, getAccount } from '../../api/cloud';
import { useToast } from '../../components/ui/ToastProvider';
import { DataTable } from '../../components/ui/DataTable';
import { DrawerPanel } from '../../components/ui/DrawerPanel';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import ResourceDetailDrawer from './ResourceDetailDrawer';
import CostAnalyticsSummary from '../../components/cloud/CostAnalyticsSummary';
import { useForm } from 'react-hook-form';
import {
  Button,
  Spinner,
  Field,
  Input,
  Select,
  Checkbox,
  Card,
  Textarea,
} from '@fluentui/react-components';
import { Cloud, Plus, CloudLightning, Server, Trash2, Edit, DollarSign, Package } from 'lucide-react';

export const CloudPage = () => {
  const { addToast } = useToast();
  const [accounts, setAccounts] = useState([]);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [inventory, setInventory] = useState([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingInventory, setLoadingInventory] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Resource detail drill-down state
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  const [selectedResource, setSelectedResource] = useState(null);

  // New account form provider
  const [formProvider, setFormProvider] = useState('Oracle');

  // Delete confirmation state
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [accountToDelete, setAccountToDelete] = useState(null);

  // Edit mode state
  const [editMode, setEditMode] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);

  // Provider filter state
  const [providerFilter, setProviderFilter] = useState('all');

  // Tab state for Inventory vs Cost Analytics
  const [activeTab, setActiveTab] = useState('inventory');

  const { register, handleSubmit, reset } = useForm();

  // Fetch accounts list with optional provider filter
  const fetchAccounts = async () => {
    setLoadingAccounts(true);
    try {
      const provider = providerFilter === 'all' ? null : providerFilter;
      const data = await listAccounts(provider);
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
  }, [providerFilter]);

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
    setEditMode(false);
    setEditingAccount(null);
    setFormProvider('Oracle');
    reset({
      provider: 'Oracle',
      environment: 'Production',
      auth_mode: 'API Key',
      auto_discovery_enabled: true,
      oci_passphrase: '',
      aws_session_token: '',
      notes: '',
    });
    setDrawerOpen(true);
  };

  const handleEditClick = (account) => {
    setEditMode(true);
    setEditingAccount(account);
    setFormProvider(account.provider);

    // Populate form with existing account data
    reset({
      account_name: account.account_name,
      tenant_identifier: account.tenant_identifier || '',
      region: account.region || '',
      environment: account.environment,
      auth_mode: account.auth_mode,
      auto_discovery_enabled: account.auto_discovery_enabled,
      notes: account.notes || '',
      // Note: Sensitive fields (keys, secrets) won't be populated for security
    });

    setDrawerOpen(true);
  };

  const handleDeleteClick = (account) => {
    setAccountToDelete(account);
    setConfirmDeleteOpen(true);
  };

  const handleDeleteConfirm = async () => {
    try {
      await deleteAccount(accountToDelete.id);
      addToast(`Cloud account "${accountToDelete.account_name}" deleted.`, 'success');
      setConfirmDeleteOpen(false);
      setAccountToDelete(null);

      // If deleting the selected account, clear selection
      if (selectedAccount?.id === accountToDelete.id) {
        setSelectedAccount(null);
        setInventory([]);
      }

      fetchAccounts();
    } catch (err) {
      addToast(err.message || 'Failed to delete cloud account.', 'error');
    }
  };

  const handleSaveAccount = async (data) => {
    try {
      const payload = {
        ...data,
        provider: formProvider,
        auto_discovery_enabled: !!data.auto_discovery_enabled,
      };

      if (editMode && editingAccount) {
        // Backend doesn't support UPDATE endpoint, show warning
        addToast('Account editing is not supported. Please delete and create a new account with updated details.', 'warning');
        setDrawerOpen(false);
        setEditMode(false);
        setEditingAccount(null);
        return;
      } else {
        const res = await addAccount(payload);
        addToast(`Cloud discovery profile "${res.account_name}" created.`, 'success');
      }

      setDrawerOpen(false);
      setEditMode(false);
      setEditingAccount(null);
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

            {/* Provider Filter */}
            <Field label="Filter by Provider" className="px-2">
              <Select value={providerFilter} onChange={(_, d) => setProviderFilter(d.value)}>
                <option value="all">All Providers</option>
                <option value="aws">AWS</option>
                <option value="Oracle">Oracle Cloud</option>
                <option value="Azure">Microsoft Azure</option>
              </Select>
            </Field>
            <div className="space-y-1">
              {accounts.map((acc) => (
                <div
                  key={acc.id}
                  onClick={() => setSelectedAccount(acc)}
                  className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-all flex items-center justify-between border cursor-pointer ${
                    selectedAccount?.id === acc.id
                      ? 'bg-brand-primary-light/10 text-brand-primary border-brand-primary/20 font-semibold'
                      : 'hover:bg-gray-50 border-transparent text-brand-text-primary'
                  }`}
                >
                  <div className="flex items-center gap-2 flex-1">
                    <CloudLightning className="h-4 w-4" />
                    <span className="truncate">{acc.account_name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase font-bold text-gray-400">{acc.provider}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEditClick(acc);
                      }}
                      className="text-gray-400 hover:text-blue-500 transition-colors"
                      title="Edit account"
                    >
                      <Edit className="h-3 w-3" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteClick(acc);
                      }}
                      className="text-gray-400 hover:text-red-500 transition-colors"
                      title="Delete account"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Account inventory grid */}
          <div className="lg:col-span-3 space-y-4">
            {selectedAccount && (
              <>
                <div className="bg-white p-4 border border-brand-border rounded-card shadow-card">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h2 className="text-base font-bold text-brand-text-primary">
                        {selectedAccount.account_name} ({selectedAccount.provider})
                      </h2>
                      <p className="text-xs text-brand-text-secondary">
                        Region: <span className="font-semibold">{selectedAccount.tenant_or_region}</span> | Env:{' '}
                        <span className="font-semibold">{selectedAccount.environment}</span>
                      </p>
                    </div>
                    {selectedAccount.last_discovery && (
                      <span className="text-xs text-brand-text-secondary">
                        Last Discovery: {new Date(selectedAccount.last_discovery).toLocaleString()}
                      </span>
                    )}
                  </div>

                  {/* Tabs */}
                  <div className="flex gap-2 border-t border-brand-border pt-3">
                    <button
                      onClick={() => setActiveTab('inventory')}
                      className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
                        activeTab === 'inventory'
                          ? 'bg-brand-primary text-white'
                          : 'bg-gray-100 text-brand-text-secondary hover:bg-gray-200'
                      }`}
                    >
                      <Package className="h-4 w-4" />
                      Resource Inventory
                    </button>
                    <button
                      onClick={() => setActiveTab('cost')}
                      className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
                        activeTab === 'cost'
                          ? 'bg-brand-primary text-white'
                          : 'bg-gray-100 text-brand-text-secondary hover:bg-gray-200'
                      }`}
                    >
                      <DollarSign className="h-4 w-4" />
                      Cost Analytics
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* Inventory Tab */}
            {activeTab === 'inventory' && (
              loadingInventory ? (
                <div className="flex justify-center items-center py-20 bg-white border border-brand-border rounded-card shadow-card">
                  <Spinner size="medium" label="Syncing provider catalogs..." />
                </div>
              ) : (
                <DataTable
                  columns={columns}
                  data={inventory}
                  rowKeyField="id"
                  onRowClick={(resource) => {
                    setSelectedResource(resource);
                    setDetailDrawerOpen(true);
                  }}
                  emptyState={
                    <div className="text-center py-12 text-brand-text-secondary">
                      No resources discovered under this cloud directory target. Check scan schedules.
                    </div>
                  }
                />
              )
            )}

            {/* Cost Analytics Tab */}
            {activeTab === 'cost' && selectedAccount && (
              <CostAnalyticsSummary
                accountId={selectedAccount.id}
                accountName={selectedAccount.account_name}
              />
            )}
          </div>
        </div>
      )}

      {/* Connection drawer */}
      <DrawerPanel
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setEditMode(false);
          setEditingAccount(null);
        }}
        title={editMode ? "Edit Cloud Account" : "Connect Cloud Account"}
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

            <Field label="Region" required>
              <Input {...register('region', { required: true })} placeholder="e.g. us-east-1" />
            </Field>
          </div>

          <Field label="Tenant Identifier">
            <Input {...register('tenant_identifier')} placeholder="e.g. ocid1.tenancy..." />
          </Field>

          <Field label="Authentication Mechanism" required>
            <Select {...register('auth_mode')}>
              <option value="API Key">API Key</option>
              <option value="IAM Role">IAM Role</option>
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
              <Field label="AWS Account ID">
                <Input {...register('aws_account_id')} placeholder="123456789012" />
              </Field>
              <Field label="AWS Access Key ID" required>
                <Input {...register('aws_access_key_id', { required: formProvider === 'AWS' })} placeholder="AKIA..." />
              </Field>
              <Field label="AWS Secret Access Key" required>
                <Input {...register('aws_secret_access_key', { required: formProvider === 'AWS' })} type="password" placeholder="wJalrX..." />
              </Field>
              <Field label="AWS Session Token (Optional)">
                <Input {...register('aws_session_token')} placeholder="Token strings" type="password" />
              </Field>
            </div>
          )}

          {/* Azure form */}
          {formProvider === 'Azure' && (
            <div className="space-y-4">
              <Field label="Directory (Tenant) ID" required>
                <Input {...register('azure_tenant_id', { required: formProvider === 'Azure' })} placeholder="00000000-0000..." />
              </Field>
              <Field label="Application (Client) ID" required>
                <Input {...register('azure_client_id', { required: formProvider === 'Azure' })} placeholder="00000000-0000..." />
              </Field>
              <Field label="Client Secret" required>
                <Input {...register('azure_client_secret', { required: formProvider === 'Azure' })} type="password" />
              </Field>
              <Field label="Subscription ID" required>
                <Input {...register('azure_subscription_id', { required: formProvider === 'Azure' })} placeholder="00000000-0000..." />
              </Field>
            </div>
          )}

          <div className="py-2">
            <Checkbox {...register('auto_discovery_enabled')} label="Enable Nightly Resource Auto-Discovery Scans" />
          </div>

          <Field label="Notes (Optional)">
            <Textarea {...register('notes')} placeholder="Add any notes or comments about this cloud account..." rows={3} />
          </Field>

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

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        onConfirm={handleDeleteConfirm}
        title="Delete Cloud Account"
        message={`Are you sure you want to delete "${accountToDelete?.account_name}"? This will remove all associated resource inventory data.`}
        confirmLabel="Delete"
        isDanger={true}
      />

      {/* Resource Detail Drill-Down Drawer */}
      <ResourceDetailDrawer
        open={detailDrawerOpen}
        onClose={() => {
          setDetailDrawerOpen(false);
          setSelectedResource(null);
        }}
        resource={selectedResource}
        accountId={selectedAccount?.id}
        provider={selectedAccount?.provider}
      />
    </div>
  );
};
