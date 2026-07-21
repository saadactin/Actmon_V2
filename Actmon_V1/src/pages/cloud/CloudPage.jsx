import React, { useState, useEffect } from 'react';
import { listAccounts, addAccount, getInventory } from '../../api/cloud';
import { useToast } from '../../components/ui/ToastProvider';
import { DrawerPanel } from '../../components/ui/DrawerPanel';
import { useForm } from 'react-hook-form';
import {
  Button,
  Spinner,
  Field,
  Input,
  Select,
  Checkbox,
} from '@fluentui/react-components';

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

  const getResourceTypeColor = (type) => {
    const colorMap = {
      'VirtualMachine': 'bg-blue-100 text-blue-800 border-blue-200',
      'StorageAccount': 'bg-purple-100 text-purple-800 border-purple-200',
      'SQLDatabase': 'bg-green-100 text-green-800 border-green-200',
      'AKSCluster': 'bg-orange-100 text-orange-800 border-orange-200',
    };
    return colorMap[type] || 'bg-gray-100 text-gray-800 border-gray-200';
  };

  // Group inventory by type for summary cards
  const inventorySummary = inventory.reduce((acc, item) => {
    acc[item.resource_type] = (acc[item.resource_type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6 p-6">
      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">
            Cloud Infrastructure
          </h1>
          <p className="text-sm text-gray-600 mt-2">
            Monitor and manage your cloud resources across Azure, AWS, and Oracle Cloud
          </p>
        </div>
        <Button
          appearance="primary"
          size="large"
          onClick={handleOpenDrawer}
          className="bg-blue-600 hover:bg-blue-700"
        >
          Add Cloud Account
        </Button>
      </div>

      {/* Loading State */}
      {loadingAccounts ? (
        <div className="flex justify-center items-center py-20">
          <Spinner size="extra-large" label="Loading cloud accounts..." />
        </div>
      ) : accounts.length === 0 ? (
        /* Empty State */
        <div className="bg-white rounded-2xl border-2 border-dashed border-gray-300 p-12 text-center">
          <h3 className="text-xl font-bold text-gray-900 mb-2">No Cloud Accounts Connected</h3>
          <p className="text-sm text-gray-600 max-w-md mx-auto mb-6">
            Connect your cloud provider credentials to start discovering and monitoring your infrastructure resources.
          </p>
          <Button appearance="primary" size="large" onClick={handleOpenDrawer}>
            Connect Your First Account
          </Button>
        </div>
      ) : (
        /* Main Content */
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Account Sidebar */}
          <div className="lg:col-span-1 space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">
                Cloud Accounts
              </h3>
              <div className="space-y-2">
                {accounts.map((acc) => (
                  <button
                    key={acc.id}
                    onClick={() => setSelectedAccount(acc)}
                    className={`w-full text-left px-4 py-3 rounded-lg text-sm transition-all flex items-center gap-3 border-2 ${
                      selectedAccount?.id === acc.id
                        ? 'bg-blue-50 border-blue-500 shadow-sm'
                        : 'border-transparent hover:bg-gray-50 hover:border-gray-200'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className={`font-semibold truncate ${
                        selectedAccount?.id === acc.id ? 'text-blue-900' : 'text-gray-900'
                      }`}>
                        {acc.account_name}
                      </div>
                      <div className="text-xs font-medium text-gray-500 uppercase mt-0.5">
                        {acc.provider}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Resources Panel */}
          <div className="lg:col-span-4 space-y-4">
            {selectedAccount && (
              <>
                {/* Account Info Header */}
                <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl shadow-lg p-6 text-white">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-2xl font-bold mb-2">
                        {selectedAccount.account_name}
                      </h2>
                      <div className="flex flex-wrap gap-4 text-sm">
                        <span className="bg-white/20 px-3 py-1 rounded-full backdrop-blur-sm">
                          <strong>Provider:</strong> {selectedAccount.provider}
                        </span>
                        <span className="bg-white/20 px-3 py-1 rounded-full backdrop-blur-sm">
                          <strong>Region:</strong> {selectedAccount.tenant_or_region}
                        </span>
                        <span className="bg-white/20 px-3 py-1 rounded-full backdrop-blur-sm">
                          <strong>Environment:</strong> {selectedAccount.environment}
                        </span>
                      </div>
                    </div>
                    {selectedAccount.last_discovery && (
                      <div className="text-right text-sm bg-white/10 px-4 py-2 rounded-lg backdrop-blur-sm">
                        <div className="text-white/70">Last Scan</div>
                        <div className="font-semibold">
                          {new Date(selectedAccount.last_discovery).toLocaleString()}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Summary Cards */}
                {inventory.length > 0 && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
                      <div className="text-sm font-medium text-gray-600 mb-1">Total Resources</div>
                      <div className="text-3xl font-bold text-gray-900">{inventory.length}</div>
                    </div>
                    {Object.entries(inventorySummary).map(([type, count]) => (
                      <div key={type} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
                        <div className="text-sm font-medium text-gray-600 mb-1">{type}</div>
                        <div className="text-3xl font-bold text-gray-900">{count}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Resources Table */}
                {loadingInventory ? (
                  <div className="flex justify-center items-center py-20 bg-white rounded-xl border border-gray-200 shadow-sm">
                    <Spinner size="large" label="Loading resources..." />
                  </div>
                ) : inventory.length === 0 ? (
                  <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center">
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">No Resources Found</h3>
                    <p className="text-sm text-gray-600">
                      No resources have been discovered in this account yet. Discovery scans run automatically.
                    </p>
                  </div>
                ) : (
                  <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-6 py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">
                              Resource
                            </th>
                            <th className="px-6 py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">
                              Type
                            </th>
                            <th className="px-6 py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">
                              Region
                            </th>
                            <th className="px-6 py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">
                              IP / Endpoint
                            </th>
                            <th className="px-6 py-4 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">
                              Status
                            </th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {inventory.map((item, idx) => {
                            const isHealthy = item.status?.toLowerCase() === 'succeeded' ||
                                            item.status?.toLowerCase() === 'running' ||
                                            item.status?.toLowerCase() === 'online' ||
                                            item.status?.toLowerCase() === 'active';

                            return (
                              <tr key={idx} className="hover:bg-gray-50 transition-colors">
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <div className="font-semibold text-gray-900">
                                    {item.resource_name}
                                  </div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold border ${getResourceTypeColor(item.resource_type)}`}>
                                    {item.resource_type}
                                  </span>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700 font-medium">
                                  {item.region_or_zone}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600 font-mono">
                                  {item.ip_address || '-'}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold ${
                                    isHealthy
                                      ? 'bg-green-100 text-green-800 border border-green-200'
                                      : 'bg-red-100 text-red-800 border border-red-200'
                                  }`}>
                                    <span className={`h-1.5 w-1.5 rounded-full ${isHealthy ? 'bg-green-600' : 'bg-red-600'}`} />
                                    {item.status}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Connection Drawer */}
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
            <Input {...register('account_name', { required: true })} placeholder="e.g. Azure Production" />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Environment" required>
              <Select {...register('environment')}>
                <option value="Production">Production</option>
                <option value="Staging">Staging</option>
                <option value="Development">Development</option>
              </Select>
            </Field>

            <Field label="Region" required>
              <Input {...register('tenant_or_region', { required: true })} placeholder="e.g. eastus" />
            </Field>
          </div>

          <Field label="Authentication Mode" required>
            <Select {...register('auth_mode')}>
              <option value="API_Keys">API Access Keys</option>
              <option value="IAM_Role">IAM Role</option>
            </Select>
          </Field>

          {/* Azure form */}
          {formProvider === 'Azure' && (
            <div className="space-y-4">
              <Field label="Tenant ID" required>
                <Input {...register('tenant_id', { required: formProvider === 'Azure' })} placeholder="00000000-0000..." />
              </Field>
              <Field label="Client ID" required>
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

          {/* AWS form */}
          {formProvider === 'AWS' && (
            <div className="space-y-4">
              <Field label="Access Key ID" required>
                <Input {...register('access_key_id', { required: formProvider === 'AWS' })} placeholder="AKIA..." />
              </Field>
              <Field label="Secret Access Key" required>
                <Input {...register('secret_access_key', { required: formProvider === 'AWS' })} type="password" />
              </Field>
              <Field label="Session Token (Optional)">
                <Input {...register('session_token')} />
              </Field>
            </div>
          )}

          {/* OCI form */}
          {formProvider === 'Oracle' && (
            <div className="space-y-4">
              <Field label="User OCID" required>
                <Input {...register('oci_user_ocid', { required: formProvider === 'Oracle' })} placeholder="ocid1.user.oc1..." />
              </Field>
              <Field label="Fingerprint" required>
                <Input {...register('oci_fingerprint', { required: formProvider === 'Oracle' })} placeholder="20:3b:97..." />
              </Field>
              <Field label="Private Key" required>
                <Input {...register('oci_private_key_content', { required: formProvider === 'Oracle' })} placeholder="-----BEGIN RSA PRIVATE KEY-----" />
              </Field>
              <Field label="Passphrase (Optional)">
                <Input {...register('oci_passphrase')} type="password" />
              </Field>
            </div>
          )}

          <div className="py-2">
            <Checkbox {...register('auto_discovery')} label="Enable automatic resource discovery" />
          </div>

          <div className="flex gap-3 pt-6 justify-end border-t border-gray-200 mt-6">
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
