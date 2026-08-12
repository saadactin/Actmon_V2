import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import cn from '@/lib/cn';
import Dialog from '@/components/ui/Dialog';
import Stepper from '@/components/ui/Stepper';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';
import Icon from '@/components/ui/Icon';
import Badge from '@/components/ui/Badge';
import { Field, Section } from '@/components/ui/Field';
import { severityOf, StatusKey } from '@/components/charts/status';
import {
  EVALUATION, NUMERIC_OPERATORS, SCOPE_LABELS, SECTIONS, SEVERITY_CHOICES, TECHNOLOGIES,
  defaultsForMetric, describeCondition, describeScope, firstMetricOfSection, metricOf,
  scopesForSection, sectionMeta, sectionOf,
} from '@/config/alertCatalog';
import { CHANNEL_DEFS, CHANNEL_ORDER } from '@/config/notificationChannels';
import { duration } from '@/lib/format';
import { useScopeTargets } from '@/hooks/useAlerts';
import { listChannels } from '@/api/notifications';
import MetricPicker from './MetricPicker';

const BLANK = {
  name: '',
  description: '',
  metric: 'cpu',
  operator: 'gt',
  threshold: 80,
  scope_type: 'all',
  scope_value: '',
  severity: 'warning',
  duration_seconds: 60,
  cooldown_seconds: 600,
  enabled: true,
  org_id: 1,
  notification_channel_types: [],
  notification_recipients: [],
  notification_cc: [],
  notification_bcc: [],
};

const STEPS = [
  { n: 1, label: 'Category' },
  { n: 2, label: 'Details' },
  { n: 3, label: 'Condition & scope' },
  { n: 4, label: 'Timing' },
  { n: 5, label: 'Notify' },
  { n: 6, label: 'Review & save' },
];

/** Where a configured channel actually sends to, read from its saved
    (org-wide) settings — so the rule wizard can show "→ #alerts" instead of
    making the user guess what a channel selection means. Null when the
    channel has nothing destination-shaped worth surfacing (e.g. PagerDuty,
    which is keyed by an integration key, not a human-readable address). */
function channelDestination(channelType, channel) {
  const c = channel?.config || {};
  switch (channelType) {
    case 'teams': return c.default_channel || null;
    case 'slack': return c.channel || null;
    case 'telegram': return Array.isArray(c.chat_ids) ? c.chat_ids.join(', ') : (c.chat_ids || null);
    case 'whatsapp': return c.default_recipient || null;
    case 'webhook': return c.url || null;
    case 'jira': return c.project ? `${c.base_url || ''} · ${c.project}`.replace(/^ · /, '') : (c.base_url || null);
    case 'servicenow': return c.instance_url || null;
    default: return null;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Chip-style multi-email entry: type an address then Enter/comma/space/blur
    commits it as a removable pill; malformed entries render in a warning
    tone instead of silently accepting typos. Paste of a comma/space/newline
    separated list splits into multiple chips at once. */
function EmailListInput({ value, onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const emails = value || [];

  const commit = (raw) => {
    const parts = raw.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...emails];
    parts.forEach((p) => { if (!next.includes(p)) next.push(p); });
    onChange(next);
    setDraft('');
  };

  const remove = (email) => onChange(emails.filter((e) => e !== email));

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 rounded-control border border-border bg-surface px-2 py-1.5',
        'transition-colors focus-within:border-accent-border focus-within:ring-1 focus-within:ring-[var(--accent)]',
      )}
    >
      {emails.map((email) => (
        <span
          key={email}
          className={cn(
            'flex items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-[11px] font-medium',
            EMAIL_RE.test(email) ? 'bg-accent-soft text-accent-text' : 'bg-danger-soft text-danger-fg',
          )}
          title={EMAIL_RE.test(email) ? undefined : 'Doesn’t look like a valid email address'}
        >
          {email}
          <button
            type="button"
            onClick={() => remove(email)}
            aria-label={`Remove ${email}`}
            className="grid h-3.5 w-3.5 place-items-center rounded-full hover:bg-black/10"
          >
            <Icon name="close" size={9} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === ' ' || e.key === ';') {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Backspace' && !draft && emails.length) {
            remove(emails[emails.length - 1]);
          }
        }}
        onBlur={() => draft.trim() && commit(draft)}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (/[,\s;]/.test(text)) {
            e.preventDefault();
            commit(text);
          }
        }}
        placeholder={emails.length ? 'Add another…' : placeholder}
        className="min-w-[140px] flex-1 bg-transparent px-1 py-0.5 text-[12px] text-fg outline-none placeholder:text-subtle"
      />
    </div>
  );
}

/**
 * Create / edit an alert rule — a 6-step wizard rather than one long
 * scrolling form, so each decision (what to watch, how to detect it, who
 * hears about it) gets its own screen instead of competing for attention.
 * Notify gets its own step (rather than sharing one with Timing) because
 * picking channels and, for Email, entering recipients is its own decision
 * with its own failure mode (an alert nobody actually receives).
 *
 * The section (step 1) decides which metrics and which scopes are offered
 * later (cloud rules scope to accounts, everything else to servers/
 * technologies/agents). Picking a metric resets the operator and threshold to
 * that metric's own defaults, so a "cache hit ratio" rule opens as `< 90%`
 * rather than inheriting `> 80` from whatever was selected before.
 */
export default function RuleEditor({ open, rule, defaultSection, onClose, onSave, saving }) {
  const [form, setForm] = useState(BLANK);
  const [section, setSection] = useState(defaultSection || 'infrastructure');
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');

  const targets = useScopeTargets(open);
  const { data: channels = [] } = useQuery({
    queryKey: ['notification-channels', 1],
    queryFn: () => listChannels(1),
    enabled: open,
  });
  const channelByType = Object.fromEntries(channels.map((c) => [c.channel_type, c]));

  useEffect(() => {
    if (!open) return;
    setError('');
    setStep(1);
    if (rule?.id) {
      setForm({ ...BLANK, ...rule, scope_value: rule.scope_value || '' });
      setSection(sectionOf(rule.metric));
    } else {
      const sec = defaultSection || 'infrastructure';
      const metric = firstMetricOfSection(sec);
      setSection(sec);
      setForm({ ...BLANK, metric, ...defaultsForMetric(metric), scope_type: 'all', scope_value: '' });
    }
  }, [open, rule, defaultSection]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const metric = metricOf(form.metric);
  const isEvent = metric.kind === 'event';
  const meta = sectionMeta(section);
  const evaluation = EVALUATION[metric.evaluation] || EVALUATION.reserved;

  /** Switching section moves to that section's first metric and resets the scope. */
  const onSectionChange = (id) => {
    const nextMetric = firstMetricOfSection(id);
    setSection(id);
    set({ metric: nextMetric, ...defaultsForMetric(nextMetric), scope_type: 'all', scope_value: '' });
  };

  const onMetricChange = (id) => set({ metric: id, ...defaultsForMetric(id) });

  const scopeTypes = scopesForSection(section);
  const scopeValues = form.scope_type === 'technology'
    ? TECHNOLOGIES
    : (targets[form.scope_type] || []).map((v) => ({ id: v, label: v }));

  /** Per-step validation — checked on Next so a mistake is caught on the step
      that caused it, not silently deferred to the final Save click. */
  const stepError = (n) => {
    if (n === 2 && !form.name.trim()) return 'Give the rule a name.';
    if (n === 3) {
      if (!isEvent && !Number.isFinite(Number(form.threshold))) return 'Threshold must be a number.';
      if (form.scope_type !== 'all' && !form.scope_value) {
        return `Select a ${(SCOPE_LABELS[form.scope_type] || 'target').toLowerCase()}.`;
      }
    }
    if (n === 4) {
      if (Number(form.duration_seconds) < 0 || Number(form.cooldown_seconds) < 0) {
        return 'Durations cannot be negative.';
      }
    }
    if (n === 5) {
      if ((form.notification_channel_types || []).includes('email') && !(form.notification_recipients || []).length) {
        return 'Add at least one email recipient, or remove Email from Notify — there is no shared default inbox.';
      }
    }
    return '';
  };

  const goNext = () => {
    const err = stepError(step);
    if (err) return setError(err);
    setError('');
    setStep((s) => Math.min(s + 1, STEPS.length));
  };
  const goBack = () => { setError(''); setStep((s) => Math.max(s - 1, 1)); };

  const submit = async () => {
    for (let n = 1; n < STEPS.length; n += 1) {
      const err = stepError(n);
      if (err) { setStep(n); setError(err); return; }
    }
    try {
      await onSave({
        ...(rule?.id ? { id: rule.id } : {}),
        name: form.name.trim(),
        description: form.description?.trim() || '',
        metric: form.metric,
        // Events are stored as `eq 1` — that's what the backend evaluates for them.
        operator: isEvent ? 'eq' : form.operator,
        threshold: isEvent ? 1 : Number(form.threshold),
        scope_type: form.scope_type,
        scope_value: form.scope_type === 'all' ? null : form.scope_value,
        severity: form.severity,
        duration_seconds: Number(form.duration_seconds),
        cooldown_seconds: Number(form.cooldown_seconds),
        enabled: !!form.enabled,
        org_id: form.org_id ?? 1,
        notification_channel_types: form.notification_channel_types || [],
        notification_recipients: form.notification_recipients || [],
        notification_cc: form.notification_cc || [],
        notification_bcc: form.notification_bcc || [],
      });
      onClose();
    } catch (e) {
      setError(e?.message || 'Could not save the rule.');
    }
  };

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${rule?.id ? 'Edit' : 'New'} ${meta.label.toLowerCase()} rule`}
      subtitle={rule?.id ? rule.name : meta.desc}
      icon={meta.icon}
      size="full"
      width="min(1180px, 96vw)"
      footer={
        <div className="flex items-center justify-between gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <div className="flex items-center gap-2">
            {step > 1 && <Button variant="secondary" onClick={goBack}>Back</Button>}
            {step < STEPS.length && (
              <Button variant="primary" iconRight="chevron-right" onClick={goNext}>Next</Button>
            )}
            {step === STEPS.length && (
              <Button variant="primary" icon="save" loading={saving} onClick={submit}>
                {rule?.id ? 'Save changes' : 'Create rule'}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <Stepper steps={STEPS} step={step} />

      {error && (
        <p className="mb-4 flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2 text-[12px] font-medium text-danger-fg">
          <Icon name="alert" size={14} className="mt-px shrink-0" />
          {error}
        </p>
      )}

      {step < STEPS.length && (
        <div className="mb-5 rounded-control border border-accent-border bg-accent-softer px-3 py-2.5">
          <p className="text-[10px] font-bold tracking-wide text-subtle uppercase">This rule fires when</p>
          <p className="mt-1 text-[13px] font-semibold text-fg">{describeCondition(form)}</p>
          <p className="mt-0.5 text-[11px] text-muted">
            on {describeScope(form)}
            {Number(form.duration_seconds) > 0
              ? ` · sustained for ${duration(form.duration_seconds)}`
              : ' · immediately'}
          </p>
        </div>
      )}

      <div className="space-y-6">
        {step === 1 && (
          <Section title="Category" icon="layers">
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-5">
              {SECTIONS.map((s) => {
                const active = s.id === section;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onSectionChange(s.id)}
                    aria-pressed={active}
                    disabled={Boolean(rule?.id)}
                    title={rule?.id ? "A rule's section follows its metric" : s.desc}
                    className={cn(
                      'flex items-center gap-2 rounded-control border px-2.5 py-2.5 text-left transition-colors',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                      active ? 'border-accent-border bg-accent-soft' : 'border-border hover:border-strong',
                    )}
                  >
                    <Icon name={s.icon} size={16} style={{ color: s.color }} className="shrink-0" />
                    <span className="min-w-0">
                      <span className="truncate-safe block text-[12px] font-semibold text-fg">{s.label}</span>
                      <span className="truncate-safe block text-[11px] text-subtle">{s.desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {rule?.id && (
              <p className="text-[11px] text-subtle">
                Editing an existing rule keeps its section — change the metric on the next step to move it.
              </p>
            )}
          </Section>
        )}

        {step === 2 && (
          <Section title="Details" icon="type">
            <Field label="Rule name">
              <Input
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="e.g. Production CPU critical"
              />
            </Field>
            <Field label="Description" hint="What this rule watches for">
              <Input
                value={form.description || ''}
                onChange={(e) => set({ description: e.target.value })}
                placeholder="Optional"
              />
            </Field>
            <Field label="Severity">
              <div className="flex gap-1.5">
                {SEVERITY_CHOICES.map((s) => {
                  const active = form.severity === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => set({ severity: s.id })}
                      aria-pressed={active}
                      className={cn(
                        'flex flex-1 items-center justify-center rounded-control border py-1.5 transition-colors',
                        active ? 'border-accent-border bg-accent-soft' : 'border-border hover:border-strong',
                      )}
                    >
                      <StatusKey status={severityOf(s.id)} />
                    </button>
                  );
                })}
              </div>
            </Field>
          </Section>
        )}

        {step === 3 && (
          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Condition" icon="trend">
              <Field label="Metric">
                <MetricPicker section={section} value={form.metric} onChange={onMetricChange} />
              </Field>

              {/* Whether the backend can actually raise this metric — otherwise a rule
                  that never fires looks like a broken rule. */}
              {metric.evaluation !== 'live' && (
                <div className={cn(
                  'flex items-start gap-2 rounded-control px-3 py-2 text-[11px] leading-relaxed',
                  metric.evaluation === 'reserved'
                    ? 'bg-warning-soft text-warning-fg'
                    : 'bg-info-soft text-info-fg',
                )}>
                  <Icon name={metric.evaluation === 'reserved' ? 'alert' : 'info'} size={13} className="mt-px shrink-0" />
                  <span>
                    <b>{evaluation.label}.</b> {evaluation.hint}.
                    {metric.evaluation === 'reserved'
                      && ' The rule will be saved and kept, but nothing will raise it yet.'}
                  </span>
                </div>
              )}

              {isEvent ? (
                <p className="flex items-start gap-2 rounded-control bg-sunken px-3 py-2 text-[12px] text-muted">
                  <Icon name="alert" size={13} className="mt-0.5 shrink-0 text-subtle" />
                  <span>Fires when <b className="text-fg">{metric.desc}</b> — there is no threshold to set.</span>
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Operator">
                    <Select
                      size="md"
                      value={form.operator}
                      onChange={(operator) => set({ operator })}
                      options={NUMERIC_OPERATORS.map((o) => ({ id: o.id, label: o.symbol }))}
                    />
                  </Field>
                  <Field label={`Threshold${metric.unit ? ` (${metric.unit})` : ''}`} className="col-span-2">
                    <Input
                      type="number"
                      step="any"
                      value={form.threshold}
                      onChange={(e) => set({ threshold: e.target.value })}
                    />
                  </Field>
                </div>
              )}
            </Section>

            <Section title="Scope" icon="server">
              <Field label="Applies to">
                <Select
                  size="md"
                  value={form.scope_type}
                  onChange={(scope_type) => set({ scope_type, scope_value: '' })}
                  options={scopeTypes}
                />
              </Field>

              {form.scope_type !== 'all' && (
                <Field label={SCOPE_LABELS[form.scope_type] || 'Target'}>
                  {scopeValues.length ? (
                    <Select
                      size="md"
                      value={form.scope_value || ''}
                      onChange={(scope_value) => set({ scope_value })}
                      options={scopeValues}
                      placeholder="Select…"
                    />
                  ) : (
                    <p className="rounded-control bg-warning-soft px-3 py-2 text-[11px] text-warning-fg">
                      {targets.isLoading
                        ? 'Loading…'
                        : `No ${(SCOPE_LABELS[form.scope_type] || 'target').toLowerCase()}s are registered yet.
                           Add one first, or leave this rule on ${scopeTypes[0].label.toLowerCase()}.`}
                    </p>
                  )}
                </Field>
              )}

              {/* Honest about a real backend limitation rather than letting the user
                  build a rule that quietly does nothing. */}
              {(form.scope_type === 'agent' || form.scope_type === 'account') && (
                <p className="flex items-start gap-2 rounded-control bg-warning-soft px-3 py-2 text-[11px] leading-relaxed text-warning-fg">
                  <Icon name="alert" size={13} className="mt-px shrink-0" />
                  <span>
                    Host checks don't evaluate {form.scope_type} scopes — a rule scoped this way
                    won't be raised by the poller. It still gates agent-reported alerts for
                    this metric.
                  </span>
                </p>
              )}
            </Section>
          </div>
        )}

        {step === 4 && (
          <Section title="Timing" icon="history">
            <div className="grid gap-3 sm:grid-cols-2 sm:max-w-md">
              <Field label="Sustained for (s)" hint={duration(form.duration_seconds)}>
                <Input
                  type="number"
                  min="0"
                  value={form.duration_seconds}
                  onChange={(e) => set({ duration_seconds: e.target.value })}
                />
              </Field>
              <Field label="Re-notify after (s)" hint={form.cooldown_seconds ? duration(form.cooldown_seconds) : 'every time'}>
                <Input
                  type="number"
                  min="0"
                  value={form.cooldown_seconds}
                  onChange={(e) => set({ cooldown_seconds: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Enabled" hint="A disabled rule stops firing immediately" inline>
              <Switch checked={form.enabled} onChange={(enabled) => set({ enabled })} label="Enabled" />
            </Field>
          </Section>
        )}

        {step === 5 && (
          <Section title="Notify" icon="bell">
            <p className="text-[11px] text-muted">
              Pick every channel this rule should notify when it fires. Leave all of them off to
              fall back to the org's severity-based routing (Settings → Notifications → Severity
              Routing) instead.
            </p>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
              {CHANNEL_ORDER.map((ct) => {
                const active = (form.notification_channel_types || []).includes(ct);
                const channel = channelByType[ct];
                const configured = !!channel?.enabled;
                const destination = channelDestination(ct, channel);
                return (
                  <button
                    key={ct}
                    type="button"
                    onClick={() => set({
                      notification_channel_types: active
                        ? form.notification_channel_types.filter((c) => c !== ct)
                        : [...(form.notification_channel_types || []), ct],
                    })}
                    aria-pressed={active}
                    className={cn(
                      'flex flex-col gap-1.5 rounded-control border p-2.5 text-left transition-colors',
                      active ? 'border-accent-border bg-accent-soft' : 'border-border hover:border-strong',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Icon
                          name={CHANNEL_DEFS[ct].icon}
                          size={14}
                          className={cn('shrink-0', active ? 'text-accent-text' : 'text-subtle')}
                        />
                        <span className="truncate-safe text-[12px] font-semibold text-fg">{CHANNEL_DEFS[ct].label}</span>
                      </span>
                      <span
                        className={cn(
                          'grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-colors',
                          active ? 'border-accent bg-accent text-accent-fg' : 'border-border',
                        )}
                      >
                        {active && <Icon name="check" size={10} />}
                      </span>
                    </span>
                    {configured ? (
                      destination ? (
                        <span className="truncate-safe text-[10.5px] text-muted" title={destination}>→ {destination}</span>
                      ) : (
                        <Badge tone="success" size="xs" className="w-fit">Configured</Badge>
                      )
                    ) : (
                      <Badge tone="warning" size="xs" className="w-fit">Not set up yet</Badge>
                    )}
                  </button>
                );
              })}
            </div>

            {(form.notification_channel_types || []).some((ct) => channelByType[ct] && !channelByType[ct].enabled) && (
              <p className="flex items-start gap-2 rounded-control bg-warning-soft px-3 py-2 text-[11px] leading-relaxed text-warning-fg">
                <Icon name="alert" size={13} className="mt-px shrink-0" />
                A selected channel isn't enabled yet in Settings → Notifications — it'll be
                skipped when this rule fires until it's configured there.
              </p>
            )}

            {(form.notification_channel_types || []).includes('email') && (
              <div className="grid gap-3 rounded-control border border-border bg-sunken p-3 sm:grid-cols-2">
                <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-subtle sm:col-span-2">
                  <Icon name="mail" size={12} />
                  Email recipients
                </span>
                <Field
                  label="To"
                  hint="Required — there's no shared default inbox. Type an address, then Enter/comma/space to add it."
                  className="sm:col-span-2"
                >
                  <EmailListInput
                    value={form.notification_recipients}
                    onChange={(notification_recipients) => set({ notification_recipients })}
                    placeholder="dba-team@company.com"
                  />
                </Field>

                <Field label="CC" hint="Optional">
                  <EmailListInput
                    value={form.notification_cc}
                    onChange={(notification_cc) => set({ notification_cc })}
                    placeholder="manager@company.com"
                  />
                </Field>

                <Field label="BCC" hint="Optional">
                  <EmailListInput
                    value={form.notification_bcc}
                    onChange={(notification_bcc) => set({ notification_bcc })}
                    placeholder="audit@company.com"
                  />
                </Field>
              </div>
            )}
          </Section>
        )}

        {step === 6 && (
          <ReviewStep form={form} section={section} isEvent={isEvent} metric={metric} />
        )}
      </div>
    </Dialog>
  );
}

function ReviewList({ rows }) {
  return (
    <dl className="divide-y divide-border overflow-hidden rounded-control border border-border">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-start justify-between gap-4 px-3 py-2 text-[12px]">
          <dt className="shrink-0 font-semibold text-subtle">{label}</dt>
          <dd className="min-w-0 text-right text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReviewStep({ form, section, isEvent, metric }) {
  const meta = sectionMeta(section);

  const identityRows = [
    ['Category', meta.label],
    ['Name', form.name || '—'],
    ['Description', form.description || '—'],
    ['Severity', <StatusKey key="sev" status={severityOf(form.severity)} />],
    ['Metric', metric.label],
    ['Condition', isEvent ? metric.desc : describeCondition(form)],
    ['Scope', describeScope(form)],
  ];

  const notifyRows = [
    ['Sustained for', Number(form.duration_seconds) > 0 ? duration(form.duration_seconds) : 'Immediately'],
    ['Re-notify after', form.cooldown_seconds ? duration(form.cooldown_seconds) : 'Every time'],
    ['Enabled', form.enabled ? 'Yes' : 'No'],
    [
      'Notify via',
      (form.notification_channel_types || []).length
        ? form.notification_channel_types.map((ct) => CHANNEL_DEFS[ct]?.label || ct).join(', ')
        : "Org's severity routing (no channel selected on this rule)",
    ],
  ];
  if ((form.notification_recipients || []).length) {
    notifyRows.push(['Email recipients (To)', form.notification_recipients.join(', ')]);
  }
  if ((form.notification_cc || []).length) {
    notifyRows.push(['Email CC', form.notification_cc.join(', ')]);
  }
  if ((form.notification_bcc || []).length) {
    notifyRows.push(['Email BCC', form.notification_bcc.join(', ')]);
  }

  return (
    <Section title="Review & save" icon="check">
      <div className="rounded-control border border-accent-border bg-accent-softer px-3 py-2.5">
        <p className="text-[10px] font-bold tracking-wide text-subtle uppercase">This rule fires when</p>
        <p className="mt-1 text-[13px] font-semibold text-fg">{describeCondition(form)}</p>
        <p className="mt-0.5 text-[11px] text-muted">
          on {describeScope(form)}
          {Number(form.duration_seconds) > 0 ? ` · sustained for ${duration(form.duration_seconds)}` : ' · immediately'}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ReviewList rows={identityRows} />
        <ReviewList rows={notifyRows} />
      </div>
    </Section>
  );
}
