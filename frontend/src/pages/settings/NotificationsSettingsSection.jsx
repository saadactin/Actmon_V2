import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Tabs from '@/components/ui/Tabs';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Badge from '@/components/ui/Badge';
import { Field, Select } from '@/components/ui/Field';
import SmtpSettingsSection from './SmtpSettingsSection';
import NotificationChannelPanel from './NotificationChannelPanel';
import NotificationTemplatesPanel from './NotificationTemplatesPanel';
import { CHANNEL_DEFS, CHANNEL_ORDER, SEVERITIES } from '@/config/notificationChannels';
import {
  getNotificationSettings, getSeverityRouting, saveNotificationSettings, setSeverityRouting,
} from '@/api/notifications';

const TABS = [
  { id: 'general', label: 'General', icon: 'globe' },
  { id: 'email', label: 'Email', icon: 'mail' },
  { id: 'teams', label: 'Teams', icon: 'bot' },
  { id: 'slack', label: 'Slack', icon: 'send' },
  { id: 'telegram', label: 'Telegram', icon: 'send' },
  { id: 'whatsapp', label: 'WhatsApp', icon: 'phone' },
  { id: 'webhook', label: 'Webhook', icon: 'link' },
  { id: 'pagerduty', label: 'PagerDuty', icon: 'alert' },
  { id: 'jira', label: 'Jira', icon: 'route' },
  { id: 'servicenow', label: 'ServiceNow', icon: 'settings2' },
  { id: 'templates', label: 'Templates', icon: 'type' },
  { id: 'routing', label: 'Severity Routing', icon: 'shield' },
];

/**
 * All 9 notification channels + severity routing, one sub-tab strip inside
 * the Settings page's "Notifications" tab. Email is the only channel with a
 * transport of its own (SMTP, above) — every other provider is a single
 * NotificationChannelPanel instance driven by config/notificationChannels.js.
 */
export default function NotificationsSettingsSection() {
  const [tab, setTab] = useState('general');

  return (
    <div className="space-y-gutter">
      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'general' && <GeneralSettingsPanel />}

      {tab === 'email' && (
        <div className="space-y-gutter">
          <SmtpSettingsSection />
          <NotificationChannelPanel channelType="email" def={CHANNEL_DEFS.email} />
        </div>
      )}

      {tab === 'routing' && <SeverityRoutingPanel />}

      {tab === 'templates' && <NotificationTemplatesPanel />}

      {tab !== 'general' && tab !== 'email' && tab !== 'routing' && tab !== 'templates' && CHANNEL_DEFS[tab] && (
        <NotificationChannelPanel channelType={tab} def={CHANNEL_DEFS[tab]} />
      )}
    </div>
  );
}

// Common zones a monitoring team is likely to actually need — not the full
// ~600-entry IANA list, which would make the dropdown unusable. The backend
// still accepts (and validates against) any real IANA zone name.
const TIMEZONE_OPTIONS = [
  { id: 'Asia/Kolkata', label: 'India Standard Time — IST (UTC+5:30)' },
  { id: 'UTC', label: 'Coordinated Universal Time — UTC' },
  { id: 'Asia/Dubai', label: 'Gulf Standard Time — Dubai (UTC+4)' },
  { id: 'Asia/Singapore', label: 'Singapore Time (UTC+8)' },
  { id: 'Asia/Tokyo', label: 'Japan Standard Time (UTC+9)' },
  { id: 'Europe/London', label: 'UK Time — London' },
  { id: 'Europe/Berlin', label: 'Central European Time — Berlin' },
  { id: 'America/New_York', label: 'US Eastern Time — New York' },
  { id: 'America/Chicago', label: 'US Central Time — Chicago' },
  { id: 'America/Los_Angeles', label: 'US Pacific Time — Los Angeles' },
  { id: 'Australia/Sydney', label: 'Australian Eastern Time — Sydney' },
];

function GeneralSettingsPanel() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(null);

  const { data, isLoading } = useQuery({ queryKey: ['notification-settings'], queryFn: getNotificationSettings });

  useEffect(() => {
    if (data) setDraft(data.timezone);
  }, [data]);

  const saveMut = useMutation({
    mutationFn: () => saveNotificationSettings({ timezone: draft }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-settings'] }),
  });

  if (isLoading || !draft) {
    return (
      <section className="card p-card">
        <p className="text-[12px] text-subtle">Loading…</p>
      </section>
    );
  }

  const dirty = draft !== data?.timezone;
  const known = TIMEZONE_OPTIONS.some((o) => o.id === draft);

  return (
    <section className="card p-card">
      <div className="flex items-center gap-2">
        <Icon name="globe" size={16} className="text-subtle" />
        <div>
          <h2 className="text-[13px] font-bold text-fg">General</h2>
          <p className="text-[12px] text-muted">Settings shared by every notification channel.</p>
        </div>
      </div>

      <div className="mt-gutter max-w-sm">
        <Field
          label="Alert time zone"
          hint="The {{Timestamp}} in every alert renders in this zone — everything is still evaluated in UTC internally."
        >
          <Select
            value={known ? draft : ''}
            onChange={setDraft}
            options={TIMEZONE_OPTIONS}
            placeholder={known ? undefined : `Other: ${draft}`}
          />
        </Field>

        <div className="mt-3">
          <Button variant="primary" size="sm" icon="save" loading={saveMut.isPending} disabled={!dirty} onClick={() => saveMut.mutate()}>
            Save
          </Button>
        </div>
      </div>
    </section>
  );
}

function SeverityRoutingPanel() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(null);
  const [savingSeverity, setSavingSeverity] = useState(null);

  const { data, isLoading } = useQuery({ queryKey: ['severity-routing'], queryFn: getSeverityRouting });

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const saveMut = useMutation({
    mutationFn: (severity) => setSeverityRouting(severity, draft[severity] || []),
    onMutate: (severity) => setSavingSeverity(severity),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['severity-routing'] }),
    onSettled: () => setSavingSeverity(null),
  });

  const toggle = (severity, channelType) => {
    setDraft((d) => {
      const current = d[severity] || [];
      const next = current.includes(channelType)
        ? current.filter((c) => c !== channelType)
        : [...current, channelType];
      return { ...d, [severity]: next };
    });
  };

  if (isLoading || !draft) {
    return (
      <section className="card p-card">
        <p className="text-[12px] text-subtle">Loading…</p>
      </section>
    );
  }

  return (
    <section className="card p-card">
      <div className="flex items-center gap-2">
        <Icon name="shield" size={16} className="text-subtle" />
        <div>
          <h2 className="text-[13px] font-bold text-fg">Severity-Based Routing</h2>
          <p className="text-[12px] text-muted">
            Default channels for a rule that hasn't picked its own — an alert rule's own "Notify via" selection always takes priority over this.
          </p>
        </div>
      </div>

      <div className="mt-gutter space-y-5">
        {SEVERITIES.map((sev) => (
          <div key={sev.id}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <Badge tone={sev.tone} size="sm">{sev.label}</Badge>
              <Button
                variant="secondary"
                size="sm"
                icon="save"
                loading={savingSeverity === sev.id}
                onClick={() => saveMut.mutate(sev.id)}
              >
                Save
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {CHANNEL_ORDER.map((ct) => {
                const active = (draft[sev.id] || []).includes(ct);
                return (
                  <button
                    key={ct}
                    type="button"
                    onClick={() => toggle(sev.id, ct)}
                    className={
                      active
                        ? 'rounded-control border border-accent-border bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent-text transition-colors'
                        : 'rounded-control border border-border px-2.5 py-1 text-[11px] font-semibold text-muted transition-colors hover:border-strong hover:text-fg'
                    }
                  >
                    {CHANNEL_DEFS[ct].label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
