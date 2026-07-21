import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import {
  listUsers,
  createUser,
  deleteUser,
  updateRole,
  setInstanceAccess,
  setCloudAccess,
  setFeatureAccess,
} from '../../api/users';
import { useAgentsList } from '../../hooks/useAgents';
import { listAccounts } from '../../api/cloud';
import { useToast } from '../../components/ui/ToastProvider';
import { DataTable } from '../../components/ui/DataTable';
import { DrawerPanel } from '../../components/ui/DrawerPanel';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import {
  Button,
  Spinner,
  Field,
  Input,
  Select,
  Checkbox,
} from '@fluentui/react-components';
import { Users, UserPlus, Key, Trash2 } from 'lucide-react';

export const UsersPage = () => {
  const { addToast } = useToast();
  
  // Users list query
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);

  // Discovery lists to populate access matrix check boxes
  const { data: agents = [] } = useAgentsList();
  const [cloudAccounts, setCloudAccounts] = useState([]);

  // Create User state
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [savingUser, setSavingUser] = useState(false);

  // Manage permissions drawer state
  const [permDrawerOpen, setPermDrawerOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  
  // Permissions selection states
  const [checkedAgents, setCheckedAgents] = useState([]);
  const [checkedClouds, setCheckedClouds] = useState([]);
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [mlEnabled, setMlEnabled] = useState(true);
  const [infraEnabled, setInfraEnabled] = useState(true);
  const [savingPerms, setSavingPerms] = useState(false);

  // Delete User Dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState(null);
  const [deletingUser, setDeletingUser] = useState(false);

  // Forms
  const { register, handleSubmit, reset: resetUserForm } = useForm();

  const fetchUsers = async () => {
    setLoadingUsers(true);
    try {
      const data = await listUsers();
      setUsers(data);
    } catch (err) {
      addToast('Failed to fetch user directory.', 'error');
    } finally {
      setLoadingUsers(false);
    }
  };

  const fetchClouds = async () => {
    try {
      const data = await listAccounts();
      setCloudAccounts(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchUsers();
    fetchClouds();
  }, []);

  // Save new user profile
  const handleCreateUser = async (data) => {
    setSavingUser(true);
    try {
      await createUser({
        username: data.username,
        email: data.email,
        role: data.role,
        password: data.password || 'TemporaryPassword123!',
      });
      addToast(`User profile "${data.username}" created successfully.`, 'success');
      setCreateDrawerOpen(false);
      resetUserForm();
      fetchUsers();
    } catch (err) {
      addToast(err.response?.data?.message || err.message || 'Failed to create user account.', 'error');
    } finally {
      setSavingUser(false);
    }
  };

  // Toggle user permissions drawer
  const handleOpenPerms = (user) => {
    setSelectedUser(user);
    // In a real application, we would query the current user permissions mapping
    // But since the API endpoints are set only (PUT), we start with all checked as placeholder
    setCheckedAgents(agents.map(a => a.name));
    setCheckedClouds(cloudAccounts.map(c => c.id));
    setAlertsEnabled(true);
    setMlEnabled(true);
    setInfraEnabled(true);
    setPermDrawerOpen(true);
  };

  // Save User Permissions Matrix
  const handleSavePermissions = async () => {
    if (!selectedUser) return;
    setSavingPerms(true);
    try {
      // 1. Instance limits
      await setInstanceAccess(selectedUser.id, checkedAgents);
      // 2. Cloud account limits
      await setCloudAccess(selectedUser.id, checkedClouds);
      // 3. Feature toggles
      await setFeatureAccess(selectedUser.id, {
        alerts_enabled: alertsEnabled,
        ml_enabled: mlEnabled,
        infra_enabled: infraEnabled,
      });
      addToast(`Access matrix updated for user: ${selectedUser.username}`, 'success');
      setPermDrawerOpen(false);
    } catch (err) {
      addToast('Failed to apply permission scopes.', 'error');
    } finally {
      setSavingPerms(false);
    }
  };

  const handleRoleToggle = async (user) => {
    const nextRole = user.role === 'Admin' ? 'Viewer' : 'Admin';
    try {
      await updateRole(user.id, nextRole);
      addToast(`User role updated to ${nextRole} for ${user.username}`, 'success');
      fetchUsers();
    } catch (err) {
      addToast('Failed to toggle user roles.', 'error');
    }
  };

  const handleConfirmDelete = (user) => {
    setUserToDelete(user);
    setDeleteDialogOpen(true);
  };

  const executeDelete = async () => {
    if (!userToDelete) return;
    setDeletingUser(true);
    try {
      await deleteUser(userToDelete.id);
      addToast(`Deleted user account: ${userToDelete.username}`, 'success');
      fetchUsers();
    } catch (err) {
      addToast('Failed to delete user account.', 'error');
    } finally {
      setDeletingUser(false);
      setUserToDelete(null);
    }
  };

  const toggleAgentChecked = (name) => {
    setCheckedAgents(prev =>
      prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name]
    );
  };

  const toggleCloudChecked = (id) => {
    setCheckedClouds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const columns = [
    {
      key: 'username',
      label: 'Account Username',
      sortable: true,
      render: (u) => <span className="font-semibold text-brand-text-primary">{u.username}</span>,
    },
    {
      key: 'email',
      label: 'Email',
      sortable: true,
    },
    {
      key: 'role',
      label: 'User Role',
      sortable: true,
      render: (u) => (
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs font-semibold border ${
            u.role === 'Admin'
              ? 'bg-purple-50 border-purple-200 text-purple-700'
              : 'bg-gray-50 border-gray-200 text-gray-700'
          }`}
        >
          {u.role}
        </span>
      ),
    },
    {
      key: 'joined_at',
      label: 'Date Joined',
      sortable: true,
      render: (u) => u.joined_at ? new Date(u.joined_at).toLocaleDateString() : 'Active',
    },
    {
      key: 'actions',
      label: 'Access Matrix Options',
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      render: (u) => (
        <div className="flex justify-end gap-2">
          <Button
            icon={<Key className="h-4 w-4" />}
            size="small"
            onClick={() => handleOpenPerms(u)}
            title="Manage Permissions"
          >
            Scopes
          </Button>
          <Button
            size="small"
            onClick={() => handleRoleToggle(u)}
            title="Toggle Role Admin / Viewer"
          >
            Toggle Role
          </Button>
          <Button
            icon={<Trash2 className="h-4 w-4" />}
            size="small"
            appearance="subtle"
            onClick={() => handleConfirmDelete(u)}
            className="text-brand-error hover:bg-red-50"
            title="Delete User"
            disabled={u.username === 'admin'} // Protect primary admin account
          />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Title block */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-brand-text-primary flex items-center gap-2">
            <Users className="h-6 w-6 text-brand-primary" />
            <span>User Accounts & Permissions Matrix</span>
          </h1>
          <p className="text-sm text-brand-text-secondary">
            Admin console to manage client user profiles, toggle admin access, and limit database scoping rules.
          </p>
        </div>
        <div>
          <Button
            appearance="primary"
            icon={<UserPlus className="h-4 w-4" />}
            onClick={() => {
              resetUserForm({ role: 'Viewer' });
              setCreateDrawerOpen(true);
            }}
          >
            Create User
          </Button>
        </div>
      </div>

      {/* User listings */}
      {loadingUsers ? (
        <div className="flex justify-center items-center py-20 bg-white border border-brand-border rounded-card">
          <Spinner size="large" label="Querying user directory..." />
        </div>
      ) : (
        <DataTable columns={columns} data={users} rowKeyField="id" />
      )}

      {/* Add User Drawer */}
      <DrawerPanel
        open={createDrawerOpen}
        onClose={() => setCreateDrawerOpen(false)}
        title="Create Client User"
      >
        <form onSubmit={handleSubmit(handleCreateUser)} className="space-y-4">
          <Field label="Username" required>
            <Input {...register('username', { required: true })} placeholder="Username" />
          </Field>
          
          <Field label="Email Address" required>
            <Input {...register('email', { required: true })} type="email" placeholder="user@actmon.com" />
          </Field>

          <Field label="Security Role" required>
            <Select {...register('role')}>
              <option value="Viewer">Viewer (Read-Only access)</option>
              <option value="Admin">Administrator (Full control)</option>
            </Select>
          </Field>

          <Field label="Temporary Password" required>
            <Input {...register('password', { required: true })} type="password" placeholder="••••••••" />
          </Field>

          <div className="flex gap-2 pt-6 justify-end border-t border-brand-border mt-6">
            <Button type="button" appearance="secondary" onClick={() => setCreateDrawerOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" appearance="primary" disabled={savingUser}>
              {savingUser ? <Spinner size="tiny" label="Creating..." /> : 'Save Profile'}
            </Button>
          </div>
        </form>
      </DrawerPanel>

      {/* Manage Permissions Drawer */}
      <DrawerPanel
        open={permDrawerOpen}
        onClose={() => setPermDrawerOpen(false)}
        title={`Access Scopes for ${selectedUser?.username}`}
      >
        <div className="space-y-6">
          {/* Agent scoping check boxes */}
          <div className="space-y-3">
            <h4 className="font-bold text-sm text-brand-text-primary border-b border-brand-border pb-1">
              Database Instances Access limits
            </h4>
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {agents.map((agent) => (
                <Checkbox
                  key={agent.name}
                  checked={checkedAgents.includes(agent.name)}
                  onChange={() => toggleAgentChecked(agent.name)}
                  label={`${agent.name} (${agent.db_type})`}
                />
              ))}
              {agents.length === 0 && (
                <p className="text-xs text-brand-text-disabled">No database agents registered.</p>
              )}
            </div>
          </div>

          {/* Cloud scoping check boxes */}
          <div className="space-y-3">
            <h4 className="font-bold text-sm text-brand-text-primary border-b border-brand-border pb-1">
              Cloud Accounts Access limits
            </h4>
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {cloudAccounts.map((account) => (
                <Checkbox
                  key={account.id}
                  checked={checkedClouds.includes(account.id)}
                  onChange={() => toggleCloudChecked(account.id)}
                  label={`${account.account_name} (${account.provider})`}
                />
              ))}
              {cloudAccounts.length === 0 && (
                <p className="text-xs text-brand-text-disabled">No cloud discovery targets registered.</p>
              )}
            </div>
          </div>

          {/* Feature toggles */}
          <div className="space-y-3">
            <h4 className="font-bold text-sm text-brand-text-primary border-b border-brand-border pb-1">
              Feature Visibility Controls
            </h4>
            <div className="space-y-2 flex flex-col">
              <Checkbox
                checked={alertsEnabled}
                onChange={(_, d) => setAlertsEnabled(!!d.checked)}
                label="Alert Configuration Portal access"
              />
              <Checkbox
                checked={mlEnabled}
                onChange={(_, d) => setMlEnabled(!!d.checked)}
                label="AI Forecasting & Predictions access"
              />
              <Checkbox
                checked={infraEnabled}
                onChange={(_, d) => setInfraEnabled(!!d.checked)}
                label="Infrastructure resource details access"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-6 justify-end border-t border-brand-border mt-6">
            <Button type="button" appearance="secondary" onClick={() => setPermDrawerOpen(false)}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              onClick={handleSavePermissions}
              disabled={savingPerms}
            >
              {savingPerms ? <Spinner size="tiny" label="Applying..." /> : 'Apply Scopes'}
            </Button>
          </div>
        </div>
      </DrawerPanel>

      {/* Delete User confirm Dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete User Profile"
        message={`Are you sure you want to permanently delete user account "${userToDelete?.username}"? This user will immediately lose access to the ActMon platform.`}
        confirmLabel={deletingUser ? 'Deleting...' : 'Delete'}
        onConfirm={executeDelete}
        isDanger={true}
      />
    </div>
  );
};
