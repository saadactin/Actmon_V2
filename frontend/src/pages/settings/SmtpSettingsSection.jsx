import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@/components/ui/Button';
import IconButton from '@/components/ui/IconButton';
import Icon from '@/components/ui/Icon';
import Badge from '@/components/ui/Badge';
import Dialog from '@/components/ui/Dialog';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Input from '@/components/ui/Input';
import { Field, Switch } from '@/components/ui/Field';
import { smtpApi } from '@/api/notifications';

const PRESETS = [
  { label: 'Gmail', smtp_host: 'smtp.gmail.com', smtp_port: 587, smtp_tls: true },
  { label: 'Outlook / Office 365', smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_tls: true },
  { label: 'Yahoo Mail', smtp_host: 'smtp.mail.yahoo.com', smtp_port: 587, smtp_tls: true },
  { label: 'Zoho Mail', smtp_host: 'smtp.zoho.com', smtp_port: 587, smtp_tls: true },
  { label: 'SendGrid', smtp_host: 'smtp.sendgrid.net', smtp_port: 587, smtp_tls: true },
  { label: 'AWS SES (US East)', smtp_host: 'email-smtp.us-east-1.amazonaws.com', smtp_port: 587, smtp_tls: true },
];

const EMPTY_FORM = {
  name: 'Default SMTP', smtp_host: '', smtp_port: 587, smtp_user: '', smtp_password: '',
  smtp_tls: true, sender_email: '', sender_name: 'ActMon Monitor', is_default: true,
};

function errMsg(e, fallback = 'Something went wrong.') {
  const detail = e?.response?.data?.detail;
  if (Array.isArray(detail)) return detail[0]?.msg || fallback;
  if (typeof detail === 'string') return detail;
  return e?.message || fallback;
}

/**
 * SMTP Email — ported from the production reference app (which has the only
 * working copy of this page today; the new frontend had none). Same fields,
 * same quick presets, same backend endpoints (/api/v1/settings/smtp/*) —
 * only the styling changed, to this app's token components. The "Email"
 * notification channel (see NotificationsSettingsSection) reads whichever
 * config here is marked default; there is deliberately no second place to
 * configure SMTP.
 */
export default function SmtpSettingsSection() {
  const qc = useQueryClient();
  const [form, setForm] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [testingId, setTestingId] = useState(null);
  const [testResults, setTestResults] = useState({});

  const { data, isLoading } = useQuery({ queryKey: ['smtp-configs'], queryFn: smtpApi.list });
  const configs = data?.configs || [];

  const invalidate = () => qc.invalidateQueries({ queryKey: ['smtp-configs'] });
  const createMut = useMutation({ mutationFn: smtpApi.create, onSuccess: () => { invalidate(); setForm(null); } });
  const updateMut = useMutation({ mutationFn: ({ id, d }) => smtpApi.update(id, d), onSuccess: () => { invalidate(); setForm(null); } });
  const deleteMut = useMutation({ mutationFn: smtpApi.remove, onSuccess: () => { invalidate(); setDeleteTarget(null); } });

  const handleTest = async (id) => {
    setTestingId(id);
    try {
      const res = await smtpApi.test(id);
      setTestResults((p) => ({ ...p, [id]: { ok: res.ok, msg: res.msg } }));
      invalidate();
    } catch (e) {
      setTestResults((p) => ({ ...p, [id]: { ok: false, msg: errMsg(e) } }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <section className="card p-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon name="mail" size={16} className="text-subtle" />
          <div>
            <h2 className="text-[13px] font-bold text-fg">SMTP Email Configuration</h2>
            <p className="text-[12px] text-muted">The mail server alert emails and scheduled reports send through.</p>
          </div>
        </div>
        <Button variant="primary" icon="plus" onClick={() => setForm({ ...EMPTY_FORM })}>Add SMTP Config</Button>
      </div>

      <div className="mt-gutter space-y-3">
        {isLoading ? (
          <p className="text-[12px] text-subtle">Loading…</p>
        ) : configs.length === 0 ? (
          <div className="rounded-control border border-dashed border-border p-8 text-center">
            <Icon name="mail" size={28} className="mx-auto mb-2 text-subtle" />
            <p className="text-[13px] font-semibold text-fg">No SMTP configuration saved</p>
            <p className="mt-1 text-[12px] text-muted">Add your mail server to enable alert emails and scheduled reports.</p>
          </div>
        ) : configs.map((cfg) => {
          const tr = testResults[cfg.id];
          return (
            <div key={cfg.id} className={`overflow-hidden rounded-control border ${cfg.is_default ? 'border-accent-border' : 'border-border'}`}>
              <div className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${cfg.is_default ? 'bg-accent-softer' : 'bg-sunken'}`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate-safe font-bold text-fg">{cfg.name}</p>
                    {cfg.is_default && <Badge tone="accent" size="xs">Default</Badge>}
                  </div>
                  <p className="mt-0.5 text-[12px] text-muted">
                    <span className="font-mono">{cfg.smtp_host}:{cfg.smtp_port}</span>
                    {cfg.smtp_tls && <span className="ml-2 font-semibold text-success-fg">TLS</span>}
                    {cfg.smtp_user && <span className="ml-2">· {cfg.smtp_user}</span>}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {cfg.last_test_at && (
                    <Badge tone={cfg.last_test_ok ? 'success' : 'danger'} size="xs">{cfg.last_test_ok ? 'OK' : 'Failed'}</Badge>
                  )}
                  <Button variant="secondary" size="sm" icon="wifi" loading={testingId === cfg.id} onClick={() => handleTest(cfg.id)}>Test</Button>
                  <IconButton icon="file-edit" label="Edit" size="sm" onClick={() => setForm({ ...cfg, smtp_password: '' })} />
                  <IconButton icon="trash" label="Delete" size="sm" tone="danger" onClick={() => setDeleteTarget(cfg)} />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-[12px] text-muted">
                <span>{cfg.sender_email}</span>
                <span>· Sender: <b className="text-fg">{cfg.sender_name}</b></span>
                {cfg.last_test_at && <span className="ml-auto">Last tested: {new Date(cfg.last_test_at).toLocaleString()}</span>}
              </div>
              {(tr || cfg.last_test_msg) && (
                <p className={`px-4 py-2 text-[12px] font-semibold ${(tr?.ok ?? cfg.last_test_ok) ? 'bg-success-soft text-success-fg' : 'bg-danger-soft text-danger-fg'}`}>
                  {tr?.msg || cfg.last_test_msg}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-gutter border-t border-border pt-gutter">
        <p className="mb-2 text-[10px] font-bold tracking-wide text-subtle uppercase">Quick presets</p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setForm({ ...EMPTY_FORM, smtp_host: p.smtp_host, smtp_port: p.smtp_port, smtp_tls: p.smtp_tls })}
              title={`${p.smtp_host}:${p.smtp_port}`}
              className="rounded-control border border-border bg-sunken px-3 py-1.5 text-[11px] font-semibold text-muted transition-colors hover:bg-surface hover:text-fg"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {form && (
        <SmtpFormDialog
          form={form}
          onChange={setForm}
          onClose={() => setForm(null)}
          onSave={() => (form.id ? updateMut.mutate({ id: form.id, d: form }) : createMut.mutate(form))}
          saving={createMut.isPending || updateMut.isPending}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete this SMTP configuration?"
        message={deleteTarget ? `"${deleteTarget.name}" will no longer be usable for alert emails or reports.` : ''}
        confirmLabel="Delete"
        tone="danger"
        icon="trash"
        loading={deleteMut.isPending}
        onConfirm={() => deleteMut.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}

function SmtpFormDialog({ form, onChange, onClose, onSave, saving }) {
  const [showPw, setShowPw] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const set = (k, v) => onChange({ ...form, [k]: v });

  const runTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await smtpApi.testInline(form);
      setTestResult({ ok: res.ok, msg: res.msg });
    } catch (e) {
      setTestResult({ ok: false, msg: errMsg(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      icon="mail"
      title={form.id ? 'Edit SMTP Configuration' : 'New SMTP Configuration'}
      width={560}
      footer={(
        <div className="flex items-center justify-between gap-2">
          <Button variant="secondary" icon="wifi" loading={testing} disabled={!form.smtp_host} onClick={runTest}>Test Connection</Button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon="save" loading={saving} disabled={!form.smtp_host || !form.sender_email} onClick={onSave}>
              Save Configuration
            </Button>
          </div>
        </div>
      )}
    >
      <div className="space-y-4">
        <Field label="Configuration Name">
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Company Gmail" />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Field label="SMTP Host"><Input value={form.smtp_host} onChange={(e) => set('smtp_host', e.target.value)} placeholder="smtp.gmail.com" /></Field>
          </div>
          <Field label="Port"><Input type="number" value={form.smtp_port} onChange={(e) => set('smtp_port', Number(e.target.value))} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="SMTP Username"><Input value={form.smtp_user} onChange={(e) => set('smtp_user', e.target.value)} placeholder="your@gmail.com" /></Field>
          <Field label="SMTP Password / App Password">
            <div className="relative">
              <Input
                type={showPw ? 'text' : 'password'}
                value={form.smtp_password}
                onChange={(e) => set('smtp_password', e.target.value)}
                placeholder="Gmail: use an App Password"
                className="pr-8"
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-subtle hover:text-fg"
              >
                <Icon name={showPw ? 'eye-off' : 'eye'} size={14} />
              </button>
            </div>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Sender Email"><Input value={form.sender_email} onChange={(e) => set('sender_email', e.target.value)} placeholder="noreply@company.com" /></Field>
          <Field label="Sender Name"><Input value={form.sender_name} onChange={(e) => set('sender_name', e.target.value)} /></Field>
        </div>
        <div className="flex items-center gap-6">
          <Field label="Use TLS / STARTTLS" inline><Switch checked={form.smtp_tls} onChange={(v) => set('smtp_tls', v)} /></Field>
          <Field label="Set as default" inline><Switch checked={form.is_default} onChange={(v) => set('is_default', v)} /></Field>
        </div>

        <div className="rounded-control border border-warning-soft bg-warning-soft p-3 text-[12px] text-warning-fg">
          <p className="font-bold">Gmail setup tip:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>Enable 2-Step Verification on the Google account</li>
            <li>Google Account → Security → App Passwords → generate one for "Mail"</li>
            <li>Host <b>smtp.gmail.com</b> · Port <b>587</b> · TLS on</li>
          </ul>
        </div>

        {testResult && (
          <p className={`rounded-control p-3 text-[12px] font-semibold ${testResult.ok ? 'bg-success-soft text-success-fg' : 'bg-danger-soft text-danger-fg'}`}>
            {testResult.msg}
          </p>
        )}
      </div>
    </Dialog>
  );
}
