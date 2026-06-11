import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as zod from 'zod';
import { useAgentsList } from '../../hooks/useAgents';
import {
  getConfig,
  upsertConfig,
  listRecipients,
  addRecipient,
  deleteRecipient,
  getAgentScope,
  updateAgentScope,
  sendTestEmail,
} from '../../api/alerts';
import { useToast } from '../../components/ui/ToastProvider';
import { DataTable } from '../../components/ui/DataTable';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import {
  Button,
  Spinner,
  Field,
  Input,
  Checkbox,
  Card,
  Select,
} from '@fluentui/react-components';
import { Mail, Plus, Trash2, Settings, Server, Play } from 'lucide-react';

const configSchema = zod.object({
  smtp_host: zod.string().min(1, 'Host is required'),
  smtp_port: zod.coerce.number().min(1, 'Valid port required'),
  username: zod.string().optional(),
  password: zod.string().optional(),
  use_tls: zod.boolean().default(false),
  use_ssl: zod.boolean().default(false),
  from_email: zod.string().email('Valid from email required'),
  timeout_seconds: zod.coerce.number().min(1).default(10),
  cpu_threshold_pct: zod.coerce.number().min(1).max(100).default(80),
  offline_threshold_seconds: zod.coerce.number().min(10).default(300),
  cooldown_seconds: zod.coerce.number().min(0).default(600),
  enabled: zod.boolean().default(true),
});

export const AlertsPage = () => {
  const { addToast } = useToast();
  const { data: agents = [], isLoading: agentsLoading } = useAgentsList();
  
  // States
  const [recipients, setRecipients] = useState([]);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [loadingRecipients, setLoadingRecipients] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [addingEmail, setAddingEmail] = useState(false);
  
  // Agent Scoping States
  const [scopeAgent, setScopeAgent] = useState('');
  const [cpuAlerts, setCpuAlerts] = useState(true);
  const [offlineAlerts, setOfflineAlerts] = useState(true);
  const [loadingScope, setLoadingScope] = useState(false);
  const [savingScope, setSavingScope] = useState(false);

  // Delete recipient dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [recipientToDelete, setRecipientToDelete] = useState(null);

  // Form
  const { register, handleSubmit, reset, formState: { errors } } = useForm({
    resolver: zodResolver(configSchema),
  });

  // Load SMTP config
  const fetchConfig = async () => {
    setLoadingConfig(true);
    try {
      const data = await getConfig();
      reset(data);
    } catch (err) {
      addToast('Failed to fetch SMTP configuration settings.', 'error');
    } finally {
      setLoadingConfig(false);
    }
  };

  // Load recipient list
  const fetchRecipients = async () => {
    setLoadingRecipients(true);
    try {
      const data = await listRecipients();
      setRecipients(data);
    } catch (err) {
      addToast('Failed to fetch recipient directory.', 'error');
    } finally {
      setLoadingRecipients(false);
    }
  };

  useEffect(() => {
    fetchConfig();
    fetchRecipients();
  }, []);

  // Sync default agent for scoping
  useEffect(() => {
    if (agents.length > 0 && !scopeAgent) {
      setScopeAgent(agents[0].name);
    }
  }, [agents]);

  // Load selected agent alert scope
  useEffect(() => {
    const fetchScope = async () => {
      if (!scopeAgent) return;
      setLoadingScope(true);
      try {
        const res = await getAgentScope(scopeAgent);
        setCpuAlerts(res.cpu_alerts_enabled);
        setOfflineAlerts(res.offline_alerts_enabled);
      } catch (err) {
        addToast(`Failed to load alert scope for agent ${scopeAgent}`, 'error');
      } finally {
        setLoadingScope(false);
      }
    };
    fetchScope();
  }, [scopeAgent]);

  // Save config
  const onSubmitConfig = async (data) => {
    setSavingConfig(true);
    try {
      await upsertConfig(data);
      addToast('System SMTP config profile saved.', 'success');
    } catch (err) {
      addToast('Failed to save SMTP configurations.', 'error');
    } finally {
      setSavingConfig(false);
    }
  };

  // Add Recipient Email
  const handleAddRecipient = async () => {
    if (!newEmail || !newEmail.includes('@')) {
      addToast('Please enter a valid email address.', 'warning');
      return;
    }
    setAddingEmail(true);
    try {
      await addRecipient(newEmail);
      addToast(`Added recipient: ${newEmail}`, 'success');
      setNewEmail('');
      fetchRecipients();
    } catch (err) {
      addToast(err.response?.data?.message || err.message || 'Failed to add recipient.', 'error');
    } finally {
      setAddingEmail(false);
    }
  };

  // Trigger Delete confirmation
  const handleConfirmDelete = (rec) => {
    setRecipientToDelete(rec);
    setDeleteDialogOpen(true);
  };

  const executeDelete = async () => {
    if (!recipientToDelete) return;
    try {
      await deleteRecipient(recipientToDelete.id);
      addToast(`Removed recipient: ${recipientToDelete.email}`, 'success');
      fetchRecipients();
    } catch (err) {
      addToast('Failed to delete recipient.', 'error');
    } finally {
      setRecipientToDelete(null);
    }
  };

  // Save Agent Scoping switches
  const handleSaveScope = async () => {
    if (!scopeAgent) return;
    setSavingScope(true);
    try {
      await updateAgentScope(scopeAgent, {
        cpu_alerts_enabled: cpuAlerts,
        offline_alerts_enabled: offlineAlerts,
      });
      addToast(`Updated alerts scope rules for agent ${scopeAgent}`, 'success');
    } catch (err) {
      addToast('Failed to update agent configurations.', 'error');
    } finally {
      setSavingScope(false);
    }
  };

  // Trigger Test email
  const handleTestEmail = async (email) => {
    try {
      await sendTestEmail(email);
      addToast(`Test alert email queued for ${email}. Check mailbox.`, 'success');
    } catch (err) {
      addToast('Error sending test notification.', 'error');
    }
  };

  const recipientColumns = [
    {
      key: 'email',
      label: 'Notification Email',
      sortable: true,
      render: (r) => <span className="font-semibold text-brand-text-primary">{r.email}</span>,
    },
    {
      key: 'status',
      label: 'Verified Status',
      render: (r) => (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${
            r.otp_verified
              ? 'bg-green-50 border-green-200 text-[#107C10]'
              : 'bg-amber-50 border-amber-200 text-[#D83B01]'
          }`}
        >
          {r.otp_verified ? 'Verified' : 'Verification Pending'}
        </span>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right',
      render: (r) => (
        <div className="flex justify-end gap-2">
          <Button
            icon={<Play className="h-4 w-4" />}
            size="small"
            appearance="subtle"
            onClick={() => handleTestEmail(r.email)}
            title="Send Test Alert"
          >
            Test
          </Button>
          <Button
            icon={<Trash2 className="h-4 w-4" />}
            size="small"
            appearance="subtle"
            onClick={() => handleConfirmDelete(r)}
            className="text-brand-error hover:bg-red-50"
            title="Remove Email"
          />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Title block */}
      <div>
        <h1 className="text-2xl font-bold text-brand-text-primary">System Notification Channels</h1>
        <p className="text-sm text-brand-text-secondary">
          Configure global SMTP gateways, verify target recipient directories, and define per-agent scopes.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: SMTP Configuration Form */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="p-6 bg-white border border-brand-border rounded-card shadow-card space-y-4">
            <h2 className="text-base font-bold text-brand-text-primary flex items-center gap-2 border-b border-brand-border pb-3">
              <Settings className="h-5 w-5 text-brand-primary" />
              <span>Global SMTP Gateway Settings</span>
            </h2>

            {loadingConfig ? (
              <div className="flex justify-center items-center py-10"><Spinner label="Loading profile..." /></div>
            ) : (
              <form onSubmit={handleSubmit(onSubmitConfig)} className="space-y-4">
                <div className="py-1">
                  <Checkbox {...register('enabled')} label="Enable Global Email Dispatcher Queue" />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field label="SMTP Host Address" required validationMessage={errors.smtp_host?.message}>
                    <Input {...register('smtp_host')} placeholder="e.g. smtp.office365.com" />
                  </Field>
                  <Field label="SMTP Port" required validationMessage={errors.smtp_port?.message}>
                    <Input {...register('smtp_port')} type="number" placeholder="587" />
                  </Field>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field label="Connect User / Email" validationMessage={errors.username?.message}>
                    <Input {...register('username')} placeholder="e.g. notifications@actmon.com" />
                  </Field>
                  <Field label="Connect Password" validationMessage={errors.password?.message}>
                    <Input {...register('password')} type="password" placeholder="••••••••" />
                  </Field>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field label="Sender (From) Email" required validationMessage={errors.from_email?.message}>
                    <Input {...register('from_email')} placeholder="e.g. alerts@actmon.com" />
                  </Field>
                  <Field label="Connection Timeout (s)">
                    <Input {...register('timeout_seconds')} type="number" />
                  </Field>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <Checkbox {...register('use_tls')} label="Use TLS" />
                  <Checkbox {...register('use_ssl')} label="Use SSL" />
                </div>

                {/* Alarm Thresholds parameters */}
                <h3 className="text-xs font-bold text-brand-text-secondary uppercase border-t border-brand-border pt-4">
                  Default Threshold Triggers
                </h3>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Field label="CPU Alert Limit (%)" required validationMessage={errors.cpu_threshold_pct?.message}>
                    <Input {...register('cpu_threshold_pct')} type="number" />
                  </Field>
                  <Field label="Offline Alert Limit (s)" required validationMessage={errors.offline_threshold_seconds?.message}>
                    <Input {...register('offline_threshold_seconds')} type="number" />
                  </Field>
                  <Field label="Notification Cooldown (s)" required validationMessage={errors.cooldown_seconds?.message}>
                    <Input {...register('cooldown_seconds')} type="number" />
                  </Field>
                </div>

                <div className="pt-4 border-t border-brand-border flex justify-end">
                  <Button type="submit" appearance="primary" disabled={savingConfig}>
                    {savingConfig ? <Spinner size="tiny" label="Saving..." /> : 'Save Configurations'}
                  </Button>
                </div>
              </form>
            )}
          </Card>
        </div>

        {/* Right Column: Recipient Registry & Per-Agent Scope */}
        <div className="space-y-6">
          {/* Recipient directory list */}
          <Card className="p-6 bg-white border border-brand-border rounded-card shadow-card space-y-4">
            <h2 className="text-base font-bold text-brand-text-primary flex items-center gap-2 border-b border-brand-border pb-3">
              <Mail className="h-5 w-5 text-brand-primary" />
              <span>Recipient Directory</span>
            </h2>

            {/* Inline add recipient form */}
            <div className="flex gap-2">
              <Input
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="alert-user@company.com"
                className="flex-1"
                style={{ width: '100%' }}
              />
              <Button
                appearance="primary"
                icon={<Plus className="h-4 w-4" />}
                onClick={handleAddRecipient}
                disabled={addingEmail}
              />
            </div>

            {loadingRecipients ? (
              <div className="flex justify-center items-center py-6"><Spinner label="Syncing email logs..." /></div>
            ) : (
              <DataTable
                columns={recipientColumns}
                data={recipients}
                rowKeyField="id"
                emptyState={<div className="text-center py-6 text-brand-text-secondary text-xs">No email recipients added.</div>}
              />
            )}
          </Card>

          {/* Per-Agent Alert Scope Switcher */}
          <Card className="p-6 bg-white border border-brand-border rounded-card shadow-card space-y-4">
            <h2 className="text-base font-bold text-brand-text-primary flex items-center gap-2 border-b border-brand-border pb-3">
              <Server className="h-5 w-5 text-brand-primary" />
              <span>Agent Alert Scoping</span>
            </h2>

            <div className="space-y-3">
              <Field label="Select Agent">
                {agentsLoading ? (
                  <Spinner size="tiny" />
                ) : (
                  <Select value={scopeAgent} onChange={(_, d) => setScopeAgent(d.value)} className="w-full">
                    {agents.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              {loadingScope ? (
                <div className="flex justify-center items-center py-4"><Spinner size="tiny" /></div>
              ) : (
                <div className="space-y-2 border-t border-brand-border pt-3">
                  <Checkbox
                    checked={cpuAlerts}
                    onChange={(_, d) => setCpuAlerts(!!d.checked)}
                    label="CPU Usage Limit Violations Alerts"
                  />
                  <Checkbox
                    checked={offlineAlerts}
                    onChange={(_, d) => setOfflineAlerts(!!d.checked)}
                    label="Host Disconnections / Offline Alerts"
                  />
                  <div className="pt-2 flex justify-end">
                    <Button
                      appearance="primary"
                      size="small"
                      disabled={savingScope}
                      onClick={handleSaveScope}
                    >
                      {savingScope ? <Spinner size="tiny" /> : 'Apply Scopes'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Delete Recipient Modal */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete Alert Recipient"
        message={`Are you sure you want to remove the email address "${recipientToDelete?.email}" from the alert broadcast list?`}
        confirmLabel="Remove"
        onConfirm={executeDelete}
        isDanger={true}
      />
    </div>
  );
};
