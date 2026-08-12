import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Textarea from '@/components/ui/Textarea';
import { Field, Select, Switch } from '@/components/ui/Field';
import { getChannel, saveChannel, sendTestNotification, testChannel } from '@/api/notifications';

function listToText(arr) {
  return Array.isArray(arr) ? arr.join(', ') : (arr || '');
}
function textToList(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function errMsg(e, fallback = 'Something went wrong.') {
  const detail = e?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  return e?.message || fallback;
}

/**
 * Renders one channel's settings entirely from its field config
 * (config/notificationChannels.js) — the same instance backs all 9 providers.
 * Secrets round-trip via `secrets_set` booleans only; leaving a secret field
 * blank on save keeps whatever is already stored server-side.
 */
export default function NotificationChannelPanel({ channelType, def }) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [config, setConfig] = useState({});
  const [secrets, setSecrets] = useState({});
  const [testResult, setTestResult] = useState(null);
  const [sendResult, setSendResult] = useState(null);
  // Email has no saved default recipient any more — a test send needs an
  // explicit one-off address, entered here and never persisted.
  const [testRecipient, setTestRecipient] = useState('');

  const { data: channel, isLoading } = useQuery({
    queryKey: ['notification-channel', channelType],
    queryFn: () => getChannel(channelType),
  });

  useEffect(() => {
    if (channel) {
      setEnabled(!!channel.enabled);
      setConfig(channel.config || {});
      setSecrets({});
    }
  }, [channel]);

  const saveMut = useMutation({
    mutationFn: () => saveChannel(channelType, { enabled, config, secrets }),
    onSuccess: (updated) => {
      qc.setQueryData(['notification-channel', channelType], updated);
      setSecrets({});
    },
  });

  const testMut = useMutation({
    mutationFn: () => testChannel(channelType),
    onSuccess: (res) => { setTestResult(res); qc.invalidateQueries({ queryKey: ['notification-channel', channelType] }); },
    onError: (e) => setTestResult({ ok: false, msg: errMsg(e) }),
  });

  const sendTestMut = useMutation({
    mutationFn: () => sendTestNotification(channelType, channelType === 'email' ? { recipient: testRecipient.trim() } : {}),
    onSuccess: (res) => { setSendResult(res); qc.invalidateQueries({ queryKey: ['notification-channel', channelType] }); },
    onError: (e) => setSendResult({ status: 'failed', message: errMsg(e) }),
  });

  const reset = () => {
    if (channel) { setEnabled(!!channel.enabled); setConfig(channel.config || {}); setSecrets({}); }
    setTestResult(null);
    setSendResult(null);
  };

  if (isLoading) {
    return (
      <section className="card p-card">
        <p className="text-[12px] text-subtle">Loading…</p>
      </section>
    );
  }

  const visibleConfigFields = def.configFields.filter((f) => !f.showIf || f.showIf(config));
  const visibleSecretFields = def.secretFields.filter((f) => !f.showIf || f.showIf(config));

  return (
    <section className="card p-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon name={def.icon} size={16} className="text-subtle" />
          <div>
            <h2 className="text-[13px] font-bold text-fg">{def.label}</h2>
            {def.note && <p className="text-[12px] text-muted">{def.note}</p>}
          </div>
        </div>
        <Field label={enabled ? 'Enabled' : 'Disabled'} inline>
          <Switch checked={enabled} onChange={setEnabled} />
        </Field>
      </div>

      {(visibleConfigFields.length > 0 || visibleSecretFields.length > 0) && (
        <div className="mt-gutter grid grid-cols-1 gap-4 sm:grid-cols-2">
          {visibleConfigFields.map((f) => (
            <div key={f.key} className={f.type === 'textarea' ? 'sm:col-span-2' : undefined}>
              <Field label={f.label} hint={f.hint}>
                {f.type === 'select' ? (
                  <Select
                    value={config[f.key] ?? ''}
                    onChange={(v) => setConfig((c) => ({ ...c, [f.key]: v }))}
                    options={f.options}
                  />
                ) : f.type === 'textarea' ? (
                  <Textarea
                    rows={3}
                    value={config[f.key] || ''}
                    onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                  />
                ) : f.type === 'list' ? (
                  <Input
                    value={listToText(config[f.key])}
                    onChange={(e) => setConfig((c) => ({ ...c, [f.key]: textToList(e.target.value) }))}
                    placeholder={f.placeholder}
                  />
                ) : (
                  <Input
                    value={config[f.key] || ''}
                    onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                  />
                )}
              </Field>
            </div>
          ))}

          {visibleSecretFields.map((f) => (
            <div key={f.key}>
              <Field
                label={f.label}
                hint={channel?.secrets_set?.[f.key] ? 'Set — leave blank to keep the current value.' : undefined}
              >
                <Input
                  type="password"
                  value={secrets[f.key] || ''}
                  onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder={channel?.secrets_set?.[f.key] ? '•••••••••••• (set)' : (f.placeholder || 'Not set')}
                />
              </Field>
            </div>
          ))}
        </div>
      )}

      <div className="mt-gutter flex flex-wrap items-center gap-2 border-t border-border pt-gutter">
        <Button variant="primary" icon="save" loading={saveMut.isPending} onClick={() => saveMut.mutate()}>Save</Button>
        <Button variant="secondary" icon="refresh" onClick={reset}>Reset</Button>
        <Button variant="secondary" icon="wifi" loading={testMut.isPending} onClick={() => testMut.mutate()}>Test Connection</Button>

        {channelType === 'email' && (
          <Input
            type="email"
            value={testRecipient}
            onChange={(e) => setTestRecipient(e.target.value)}
            placeholder="Send test to…"
            wrapperClassName="w-48"
          />
        )}
        <Button
          variant="secondary"
          icon="send"
          loading={sendTestMut.isPending}
          disabled={!enabled || (channelType === 'email' && !testRecipient.trim())}
          onClick={() => sendTestMut.mutate()}
        >
          Send Test Notification
        </Button>

        <div className="ml-auto flex flex-wrap items-center gap-3 text-[11px] text-subtle">
          {channel?.last_success_at && <span>Last success: {new Date(channel.last_success_at).toLocaleString()}</span>}
          {channel?.last_failure_at && <span className="text-danger-fg">Last failure: {new Date(channel.last_failure_at).toLocaleString()}</span>}
        </div>
      </div>

      {channel?.last_error && (
        <p className="mt-2 rounded-control bg-danger-soft px-3 py-2 text-[12px] text-danger-fg">Last error: {channel.last_error}</p>
      )}
      {testResult && (
        <p className={`mt-2 rounded-control px-3 py-2 text-[12px] font-semibold ${testResult.ok ? 'bg-success-soft text-success-fg' : 'bg-danger-soft text-danger-fg'}`}>
          {testResult.msg}
        </p>
      )}
      {sendResult && (
        <p className={`mt-2 rounded-control px-3 py-2 text-[12px] font-semibold ${sendResult.status === 'success' ? 'bg-success-soft text-success-fg' : 'bg-danger-soft text-danger-fg'}`}>
          {sendResult.message}
        </p>
      )}
    </section>
  );
}
