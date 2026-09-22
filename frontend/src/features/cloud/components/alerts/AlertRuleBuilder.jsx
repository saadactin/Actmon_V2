import { useEffect, useMemo, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Steps from '@/components/ui/Steps';
import Switch from '@/components/ui/Switch';
import Textarea from '@/components/ui/Textarea';
import cn from '@/lib/cn';
import { SeverityBadge, categoryMeta, humanDuration } from './AlertPrimitives';
import RulePreviewPanel from './RulePreviewPanel';

/**
 * The rule builder.
 *
 * Driven entirely by the capabilities payload the backend returns: the
 * categories, the conditions in each, the fields on each condition, their
 * choices and their support state all come from `catalog.py`. Nothing about a
 * condition is duplicated here, so adding one server-side makes it appear in
 * this form with no frontend change — and, more importantly, this form cannot
 * offer a condition the engine has no evaluator for.
 *
 * Two behaviours worth naming:
 *
 *   An UNSUPPORTED condition is shown, disabled, WITH ITS REASON. Hiding it
 *   would leave the user wondering whether Actmon can do cost baselines at all;
 *   showing it greyed out with "2 days of billed history are stored, and a
 *   baseline needs two full windows" tells them exactly what to fix.
 *
 *   The review step shows the generated English sentence, not the JSON. It is
 *   the same sentence the rule list, the alert and the email will show, because
 *   all four come from the same server-side `describe()`.
 */

const STEPS = ['Type', 'Condition', 'Severity', 'Notification', 'Schedule', 'Review'];

// Steps where the live preview is worth the round trip. On step 0 there is
// nothing to preview yet, and on the notification step the condition has not
// changed — so it is shown from the condition step onward, where every edit
// changes what would actually fire.
const PREVIEW_FROM_STEP = 1;

const HOLD_CHOICES = [
  { id: '0', label: 'Alert on the first breach' },
  { id: '300', label: 'Only if it lasts 5 minutes' },
  { id: '900', label: 'Only if it lasts 15 minutes' },
  { id: '1800', label: 'Only if it lasts 30 minutes' },
  { id: '3600', label: 'Only if it lasts 1 hour' },
];

const MODE_CHOICES = [
  { id: 'immediate', label: 'Send immediately' },
  { id: 'hourly_digest', label: 'Batch into an hourly digest' },
  { id: 'daily_digest', label: 'Batch into a daily digest' },
];

const ESCALATION_CHOICES = [
  { id: '0', label: 'Never escalate' },
  { id: '1800', label: 'After 30 minutes unacknowledged' },
  { id: '3600', label: 'After 1 hour unacknowledged' },
  { id: '14400', label: 'After 4 hours unacknowledged' },
  { id: '86400', label: 'After 24 hours unacknowledged' },
];

const CONSECUTIVE_CHOICES = [
  { id: '1', label: 'A single evaluation is enough' },
  { id: '2', label: 'Seen on 2 consecutive evaluations' },
  { id: '3', label: 'Seen on 3 consecutive evaluations' },
  { id: '5', label: 'Seen on 5 consecutive evaluations' },
];

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

const INTERVALS = [
  { id: '300', label: 'Every 5 minutes' },
  { id: '600', label: 'Every 10 minutes' },
  { id: '900', label: 'Every 15 minutes' },
  { id: '1800', label: 'Every 30 minutes' },
  { id: '3600', label: 'Every hour' },
  { id: '21600', label: 'Every 6 hours' },
  { id: '86400', label: 'Every 24 hours' },
];

const COOLDOWNS = [
  { id: '0', label: 'No cooldown' },
  { id: '900', label: '15 minutes' },
  { id: '1800', label: '30 minutes' },
  { id: '3600', label: '1 hour' },
  { id: '21600', label: '6 hours' },
  { id: '86400', label: '24 hours' },
];

const REPEATS = [
  { id: '0', label: 'Notify once' },
  { id: '3600', label: 'Every hour while unresolved' },
  { id: '21600', label: 'Every 6 hours while unresolved' },
  { id: '86400', label: 'Every 24 hours while unresolved' },
];

const emptyDraft = () => ({
  name: '',
  description: '',
  condition_type: '',
  condition_config: {},
  scope_config: {},
  severity: 'MEDIUM',
  enabled: true,
  notification_config: {
    channels: ['email'], use_account_defaults: true, recipients: [], cc: [], bcc: [],
  },
  evaluation_interval_seconds: 300,
  cooldown_seconds: 3600,
  repeat_interval_seconds: 0,
  notify_on_resolution: false,
  min_duration_seconds: 0,
  consecutive_breaches_required: 1,
  notification_mode: 'immediate',
  escalate_after_seconds: 0,
  respect_quiet_hours: true,
});

export default function AlertRuleBuilder({
  open, onClose, capabilities, capabilitiesLoading, existing, template,
  accountRecipients = [], onSubmit, submitting, serverErrors,
  preview, previewLoading, onDraftChange, onBrowseTemplates,
}) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(emptyDraft);
  const [category, setCategory] = useState(null);
  const [touched, setTouched] = useState(false);
  const [recipientInput, setRecipientInput] = useState('');
  const [escalationInput, setEscalationInput] = useState('');

  const isEdit = !!existing;

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setTouched(false);
    setRecipientInput('');
    if (existing) {
      setDraft({
        name: existing.name || '',
        description: existing.description || '',
        condition_type: existing.condition_type,
        condition_config: { ...(existing.condition_config || {}) },
        scope_config: { ...(existing.scope_config || {}) },
        severity: existing.severity || 'MEDIUM',
        enabled: existing.enabled !== false,
        notification_config: {
          channels: ['email'],
          use_account_defaults:
            existing.notification_config?.use_account_defaults !== false,
          recipients: existing.notification_config?.recipients || [],
          cc: existing.notification_config?.cc || [],
          bcc: existing.notification_config?.bcc || [],
          // Carried through explicitly. Anything omitted here is silently
          // reset when the form saves, so editing a threshold would drop the
          // rule's escalation list without saying so.
          escalation_recipients:
            existing.notification_config?.escalation_recipients || [],
        },
        evaluation_interval_seconds: existing.evaluation_interval_seconds || 300,
        cooldown_seconds: existing.cooldown_seconds ?? 3600,
        repeat_interval_seconds: existing.repeat_interval_seconds ?? 0,
        notify_on_resolution: !!existing.notify_on_resolution,
        min_duration_seconds: existing.min_duration_seconds ?? 0,
        consecutive_breaches_required: existing.consecutive_breaches_required ?? 1,
        notification_mode: existing.notification_mode || 'immediate',
        escalate_after_seconds: existing.escalate_after_seconds ?? 0,
        respect_quiet_hours: existing.respect_quiet_hours !== false,
      });
      setCategory(existing.category);
    } else if (template) {
      // Seeded from a template. Opens on the CONDITION step rather than step
      // one, because the template has already answered "what kind of thing" —
      // and lands on the field the template could not fill in for the user.
      setDraft({
        ...emptyDraft(),
        name: template.suggested_name || template.label,
        description: template.rationale || '',
        condition_type: template.condition_type,
        condition_config: { ...(template.condition_config || {}) },
        scope_config: { ...(template.scope_config || {}) },
        severity: template.severity || 'MEDIUM',
        evaluation_interval_seconds: template.evaluation_interval_seconds || 300,
        cooldown_seconds: template.cooldown_seconds ?? 3600,
        repeat_interval_seconds: template.repeat_interval_seconds ?? 0,
        notify_on_resolution: !!template.notify_on_resolution,
        min_duration_seconds: template.min_duration_seconds ?? 0,
        consecutive_breaches_required: template.consecutive_breaches_required ?? 1,
      });
      setCategory(template.category);
      setStep(1);
    } else {
      setDraft(emptyDraft());
      setCategory(null);
    }
  }, [open, existing, template]);

  // The draft is lifted so the page can run the live preview against it. Only
  // the fields that change what would fire are sent — renaming a rule must not
  // cost a re-evaluation.
  useEffect(() => {
    if (!open) return;
    onDraftChange?.(draft);
  }, [open, onDraftChange,
    draft.condition_type, draft.condition_config, draft.scope_config,
    draft.severity, draft.cooldown_seconds, draft.min_duration_seconds,
    draft.consecutive_breaches_required, draft.notify_on_resolution,
    draft.notification_config]);

  const categories = capabilities?.categories || [];
  const allConditions = useMemo(
    () => categories.flatMap((c) => c.conditions.map((x) => ({ ...x, category: c.key }))),
    [categories],
  );
  const condition = allConditions.find((c) => c.key === draft.condition_type) || null;
  const support = condition?.support || {};

  const set = (patch) => { setDraft((d) => ({ ...d, ...patch })); setTouched(true); };
  const setConfig = (key, value) => set({
    condition_config: { ...draft.condition_config, [key]: value },
  });
  const setScope = (key, value) => set({
    scope_config: { ...draft.scope_config, [key]: value || undefined },
  });

  const pickCondition = (cond) => {
    // Seeding from the field defaults means a user who accepts every default
    // still gets a complete, valid config — rather than a rule that fails
    // validation on a field they were never shown.
    const seeded = {};
    (cond.fields || []).forEach((f) => {
      if (f.default !== null && f.default !== undefined) seeded[f.key] = f.default;
    });
    set({
      condition_type: cond.key,
      condition_config: seeded,
      scope_config: {},
      name: draft.name || `${cond.label} — ${capabilities?.account?.name || ''}`.trim(),
    });
  };

  const scopeKeys = capabilities?.scope_support?.[draft.condition_type] || [];

  // Local validation mirrors what the server will check, so the Next button is
  // honest. The server remains the authority and its field errors are shown
  // verbatim on the review step.
  const stepValid = (() => {
    if (step === 0) return !!draft.condition_type && support.supported !== false;
    if (step === 1) {
      return (condition?.fields || []).every((f) => {
        if (!f.required) return true;
        const v = draft.condition_config[f.key];
        return v !== undefined && v !== null && v !== '';
      });
    }
    if (step === 2) return !!draft.name.trim() && SEVERITIES.includes(draft.severity);
    return true;
  })();

  const effectiveRecipients = draft.notification_config.use_account_defaults
    ? [...new Set([...(draft.notification_config.recipients || []),
      ...accountRecipients.filter((r) => r.enabled && r.kind === 'to').map((r) => r.email)])]
    : (draft.notification_config.recipients || []);

  const addRecipient = () => {
    const value = recipientInput.trim();
    if (!value) return;
    set({
      notification_config: {
        ...draft.notification_config,
        recipients: [...new Set([...(draft.notification_config.recipients || []), value])],
      },
    });
    setRecipientInput('');
  };

  const removeRecipient = (email) => set({
    notification_config: {
      ...draft.notification_config,
      recipients: (draft.notification_config.recipients || []).filter((e) => e !== email),
    },
  });

  const addEscalation = () => {
    const value = escalationInput.trim();
    if (!value) return;
    set({
      notification_config: {
        ...draft.notification_config,
        escalation_recipients: [...new Set([
          ...(draft.notification_config.escalation_recipients || []), value,
        ])],
      },
    });
    setEscalationInput('');
  };

  const removeEscalation = (email) => set({
    notification_config: {
      ...draft.notification_config,
      escalation_recipients: (draft.notification_config.escalation_recipients || [])
        .filter((e) => e !== email),
    },
  });

  const submit = () => onSubmit?.({
    ...draft,
    scope_config: Object.fromEntries(
      Object.entries(draft.scope_config).filter(([, v]) => v),
    ),
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      icon="bell"
      title={isEdit ? 'Edit alert rule' : 'Create alert'}
      subtitle={capabilities?.account?.name}
      width={620}
      footer={(
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            icon="arrow-left"
            disabled={step === 0 || submitting}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            Back
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            {step < STEPS.length - 1 ? (
              <Button
                variant="primary"
                iconRight="arrow-right"
                disabled={!stepValid}
                onClick={() => setStep((s) => s + 1)}
              >
                Next
              </Button>
            ) : (
              <Button variant="primary" icon="check" loading={submitting} onClick={submit}>
                {isEdit ? 'Save changes' : 'Create rule'}
              </Button>
            )}
          </div>
        </div>
      )}
    >
      <div className="space-y-4">
        <Steps steps={STEPS} current={step} className="pb-1" />

        {/* The live answer to "what exactly will cause this email to arrive?",
            shown from the moment there is a condition to evaluate rather than
            only on the review step — by the review step the decisions have
            already been made. */}
        {step >= PREVIEW_FROM_STEP && draft.condition_type && (
          <RulePreviewPanel data={preview} loading={previewLoading} />
        )}

        {/* ── Step 1: what kind of thing ─────────────────────────────── */}
        {step === 0 && (
          <div className="space-y-3">
            {capabilitiesLoading && (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-16 animate-pulse rounded-control bg-sunken" />
                ))}
              </div>
            )}
            {!capabilitiesLoading && (
              <>
                {onBrowseTemplates && !isEdit && (
                  <button
                    type="button"
                    onClick={onBrowseTemplates}
                    className="flex w-full items-center gap-2 rounded-control border border-dashed border-border px-3 py-2.5 text-left transition-colors hover:bg-sunken"
                  >
                    <Icon name="bookmark" size={15} className="shrink-0 text-accent-text" />
                    <span className="min-w-0">
                      <span className="block text-[12px] font-semibold text-fg">
                        Start from a template
                      </span>
                      <span className="block text-[11px] leading-snug text-muted">
                        Sensible defaults for the conditions most people want,
                        already filled in.
                      </span>
                    </span>
                    <Icon name="arrow-right" size={13} className="ml-auto shrink-0 text-subtle" />
                  </button>
                )}

                <div className="flex flex-wrap gap-1.5">
                  {categories.map((c) => {
                    const meta = categoryMeta(c.key);
                    const active = category === c.key;
                    return (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => setCategory(active ? null : c.key)}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-control border px-2.5 py-1.5 text-[12px] font-semibold transition-colors',
                          active
                            ? 'border-accent bg-accent-soft text-accent-text'
                            : 'border-border bg-surface text-muted hover:bg-sunken',
                        )}
                      >
                        <Icon name={meta.icon} size={13} />
                        {c.label}
                      </button>
                    );
                  })}
                </div>

                <div className="space-y-2">
                  {categories
                    .filter((c) => !category || c.key === category)
                    .flatMap((c) => c.conditions.map((x) => ({ ...x, categoryLabel: c.label })))
                    .map((cond) => {
                      const unsupported = cond.support?.supported === false;
                      const selected = draft.condition_type === cond.key;
                      return (
                        <button
                          key={cond.key}
                          type="button"
                          disabled={unsupported}
                          onClick={() => pickCondition(cond)}
                          className={cn(
                            'w-full rounded-control border p-3 text-left transition-colors',
                            selected ? 'border-accent bg-accent-soft'
                              : 'border-border bg-surface hover:bg-sunken',
                            unsupported && 'cursor-not-allowed opacity-70 hover:bg-surface',
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-[13px] font-semibold text-fg">
                              {cond.label}
                            </span>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <Badge tone="neutral" size="sm">{cond.categoryLabel}</Badge>
                              {unsupported && (
                                <Badge tone="warning" size="sm">Unavailable</Badge>
                              )}
                            </div>
                          </div>
                          <p className="mt-1 text-[12px] leading-snug text-muted">
                            {cond.summary}
                          </p>
                          {/* The reason, not just the fact. An unavailable
                              condition with no explanation looks like a
                              missing feature rather than a fixable gap. */}
                          {unsupported && cond.support?.reason && (
                            <p className="mt-2 flex gap-1.5 rounded border border-warning bg-warning-soft px-2 py-1.5 text-[11px] leading-snug text-fg">
                              <Icon name="info" size={12} className="mt-0.5 shrink-0 text-warning-fg" />
                              {cond.support.reason}
                            </p>
                          )}
                          {!unsupported && cond.support?.warning && (
                            <p className="mt-2 flex gap-1.5 text-[11px] leading-snug text-muted">
                              <Icon name="info" size={12} className="mt-0.5 shrink-0 text-subtle" />
                              {cond.support.warning}
                            </p>
                          )}
                          <p className="mt-1.5 text-[10px] uppercase tracking-wider text-subtle">
                            Reads: {cond.source.replace(/_/g, ' ')}
                          </p>
                        </button>
                      );
                    })}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Step 2: the condition itself ───────────────────────────── */}
        {step === 1 && condition && (
          <div className="space-y-3">
            <p className="text-[12px] leading-snug text-muted">{condition.summary}</p>

            {(condition.fields || []).map((f) => (
              <label key={f.key} className="block">
                <span className="mb-1 block text-[12px] font-semibold text-fg">
                  {f.label}
                  {!f.required && <span className="ml-1 font-normal text-subtle">(optional)</span>}
                </span>
                {f.kind === 'choice' || f.kind === 'operator' ? (
                  <Select
                    value={String(draft.condition_config[f.key] ?? f.default ?? '')}
                    onChange={(v) => setConfig(f.key, v)}
                    options={(f.choices || []).map((c) => ({ id: c.value, label: c.label }))}
                  />
                ) : f.kind === 'number' ? (
                  <Input
                    type="number"
                    min={f.minimum ?? undefined}
                    max={f.maximum ?? undefined}
                    value={draft.condition_config[f.key] ?? ''}
                    onChange={(e) => setConfig(
                      f.key, e.target.value === '' ? '' : Number(e.target.value),
                    )}
                  />
                ) : f.kind === 'money' ? (
                  <Input
                    placeholder="INR"
                    value={draft.condition_config[f.key] ?? ''}
                    onChange={(e) => setConfig(f.key, e.target.value.toUpperCase())}
                  />
                ) : (
                  <Input
                    value={draft.condition_config[f.key] ?? ''}
                    onChange={(e) => setConfig(f.key, e.target.value)}
                  />
                )}
                {f.help && (
                  <span className="mt-1 block text-[11px] leading-snug text-subtle">
                    {f.help}
                  </span>
                )}
              </label>
            ))}

            {/* Scope only appears where the evaluator genuinely honours it.
                Offering a region filter on a condition that ignores it would
                produce an alert that silently watches more than it claims. */}
            {scopeKeys.length > 0 && (
              <div className="rounded-control border border-border p-3">
                <p className="mb-2 text-[12px] font-semibold text-fg">
                  Narrow the scope <span className="font-normal text-subtle">(optional)</span>
                </p>
                <div className="space-y-2">
                  {scopeKeys.map((key) => (
                    <label key={key} className="block">
                      <span className="mb-1 block text-[11px] capitalize text-muted">
                        {key.replace(/_/g, ' ')}
                      </span>
                      <Input
                        size="sm"
                        placeholder="Whole account"
                        value={draft.scope_config[key] || ''}
                        onChange={(e) => setScope(key, e.target.value)}
                      />
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-[11px] leading-snug text-subtle">
                  A scope always narrows within this account. Nothing here can
                  widen a rule beyond it.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Step 3: identity and severity ──────────────────────────── */}
        {step === 2 && (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-fg">Rule name</span>
              <Input
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="Critical security findings"
              />
              {touched && !draft.name.trim() && (
                <span className="mt-1 block text-[11px] text-danger">
                  A rule name is required.
                </span>
              )}
            </label>

            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-fg">
                Description <span className="font-normal text-subtle">(optional)</span>
              </span>
              <Textarea
                rows={2}
                value={draft.description}
                onChange={(e) => set({ description: e.target.value })}
                placeholder="What should someone do when this fires?"
              />
            </label>

            <div>
              <span className="mb-1.5 block text-[12px] font-semibold text-fg">Severity</span>
              <div className="flex flex-wrap gap-1.5">
                {SEVERITIES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => set({ severity: s })}
                    className={cn(
                      'rounded-control border px-2 py-1 transition-colors',
                      draft.severity === s
                        ? 'border-accent bg-accent-soft'
                        : 'border-border bg-surface hover:bg-sunken',
                    )}
                  >
                    <SeverityBadge severity={s} />
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-subtle">
                Severity sets the email subject prefix and how the alert is
                ranked in the list. It does not change how the condition is
                evaluated.
              </p>
            </div>
          </div>
        )}

        {/* ── Step 4: who hears about it ─────────────────────────────── */}
        {step === 3 && (
          <div className="space-y-3">
            <div className="rounded-control border border-border p-3">
              <Switch
                checked={draft.notification_config.use_account_defaults}
                onChange={(v) => set({
                  notification_config: {
                    ...draft.notification_config, use_account_defaults: v,
                  },
                })}
                label="Also send to this account's default recipients"
              />
              <p className="mt-1.5 text-[11px] leading-snug text-subtle">
                Resolved when the alert fires, so adding a default recipient
                later reaches rules that already exist.
              </p>
              {draft.notification_config.use_account_defaults && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {accountRecipients.filter((r) => r.enabled).length === 0 ? (
                    <span className="text-[11px] text-warning-fg">
                      This account has no default recipients configured yet.
                    </span>
                  ) : accountRecipients.filter((r) => r.enabled).map((r) => (
                    <Badge key={r.id} tone="neutral" size="sm">{r.email}</Badge>
                  ))}
                </div>
              )}
            </div>

            <div>
              <span className="mb-1 block text-[12px] font-semibold text-fg">
                Recipients for this rule only
              </span>
              <div className="flex gap-2">
                <Input
                  value={recipientInput}
                  placeholder="security@company.com"
                  onChange={(e) => setRecipientInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); addRecipient(); }
                  }}
                />
                <Button icon="plus" onClick={addRecipient}>Add</Button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {(draft.notification_config.recipients || []).map((email) => (
                  <button
                    key={email}
                    type="button"
                    onClick={() => removeRecipient(email)}
                    className="inline-flex items-center gap-1 rounded-control border border-border bg-surface px-2 py-0.5 text-[11px] text-fg hover:bg-sunken"
                  >
                    {email}
                    <Icon name="close" size={11} className="text-subtle" />
                  </button>
                ))}
              </div>
            </div>

            <Switch
              checked={draft.notify_on_resolution}
              onChange={(v) => set({ notify_on_resolution: v })}
              label="Also email when the condition clears"
            />

            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-fg">
                Pacing
              </span>
              <Select
                value={draft.notification_mode || 'immediate'}
                onChange={(v) => set({ notification_mode: v })}
                options={MODE_CHOICES}
                // A CRITICAL rule is always sent immediately, so offering a
                // digest would be offering a setting with no effect.
                disabled={draft.severity === 'CRITICAL'}
              />
              <span className="mt-1 block text-[11px] leading-snug text-subtle">
                {draft.severity === 'CRITICAL'
                  ? 'Critical alerts are always sent immediately and are never '
                    + 'batched into a digest, so this cannot be changed.'
                  : 'A digest batches this rule’s alerts into one periodic '
                    + 'summary. Critical alerts are never batched, whatever '
                    + 'this says.'}
              </span>
            </label>

            <Switch
              checked={draft.respect_quiet_hours !== false}
              onChange={(v) => set({ respect_quiet_hours: v })}
              label="Honour the installation's quiet hours"
            />

            <div className="rounded-control border border-border p-3">
              <label className="block">
                <span className="mb-1 block text-[12px] font-semibold text-fg">
                  Escalate if nobody acknowledges
                </span>
                <Select
                  value={String(draft.escalate_after_seconds || 0)}
                  onChange={(v) => set({ escalate_after_seconds: Number(v) })}
                  options={ESCALATION_CHOICES}
                />
              </label>

              {draft.escalate_after_seconds > 0 && (
                <div className="mt-2">
                  <span className="mb-1 block text-[11px] font-semibold text-fg">
                    Escalate to
                  </span>
                  <div className="flex gap-2">
                    <Input
                      size="sm"
                      value={escalationInput}
                      placeholder="oncall-lead@company.com"
                      onChange={(e) => setEscalationInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addEscalation(); }
                      }}
                    />
                    <Button size="sm" icon="plus" onClick={addEscalation}>Add</Button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(draft.notification_config.escalation_recipients || []).map((email) => (
                      <button
                        key={email}
                        type="button"
                        onClick={() => removeEscalation(email)}
                        className="inline-flex items-center gap-1 rounded-control border border-border bg-surface px-2 py-0.5 text-[11px] text-fg hover:bg-sunken"
                      >
                        {email}
                        <Icon name="close" size={11} className="text-subtle" />
                      </button>
                    ))}
                  </div>
                  {!(draft.notification_config.escalation_recipients || []).length && (
                    <p className="mt-1.5 flex gap-1.5 text-[11px] leading-snug text-warning-fg">
                      <Icon name="alert" size={11} className="mt-0.5 shrink-0" />
                      Escalation is on but nobody is listed, so there would be
                      nobody to escalate to. This rule cannot be saved until you
                      add someone or turn escalation off.
                    </p>
                  )}
                </div>
              )}

              <p className="mt-2 text-[11px] leading-snug text-subtle">
                Escalation fires once, and stops as soon as anyone acknowledges
                the alert — being picked up is what it is trying to achieve.
              </p>
            </div>

            {/* Said plainly, because a rule that records but never notifies is
                a legitimate choice and a common accident. */}
            {effectiveRecipients.length === 0 && (
              <p className="flex gap-1.5 rounded-control border border-warning bg-warning-soft px-2.5 py-2 text-[11px] leading-snug text-fg">
                <Icon name="alert" size={12} className="mt-0.5 shrink-0 text-warning-fg" />
                Nobody will be emailed. The rule will still record alerts in this
                tab — add a recipient if you want to be told.
              </p>
            )}

            <p className="text-[11px] leading-snug text-subtle">
              Email is the only delivery channel connected in this build. Teams,
              Slack, webhook and the rest are stored by the shared notification
              settings but no adapter sends them yet, so they are not offered
              here.
            </p>
          </div>
        )}

        {/* ── Step 5: cadence and noise control ──────────────────────── */}
        {step === 4 && (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-fg">
                Evaluate this rule
              </span>
              <Select
                value={String(draft.evaluation_interval_seconds)}
                onChange={(v) => set({ evaluation_interval_seconds: Number(v) })}
                options={INTERVALS}
              />
              <span className="mt-1 block text-[11px] leading-snug text-subtle">
                Five minutes is the floor. Every source this reads is refreshed
                by discovery rather than continuously, so a shorter interval
                would re-read identical numbers.
              </span>
            </label>

            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-fg">
                After notifying, stay quiet for
              </span>
              <Select
                value={String(draft.cooldown_seconds)}
                onChange={(v) => set({ cooldown_seconds: Number(v) })}
                options={COOLDOWNS}
              />
              <span className="mt-1 block text-[11px] leading-snug text-subtle">
                Cooldown suppresses repeated email for the same condition. The
                alert itself stays open throughout — this only affects the
                mail.
              </span>
            </label>

            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-fg">
                While the problem persists
              </span>
              <Select
                value={String(draft.repeat_interval_seconds)}
                onChange={(v) => set({ repeat_interval_seconds: Number(v) })}
                options={REPEATS}
              />
            </label>

            {/* False-positive protection. Two separate bars because they answer
                different questions, and a rule usually wants one or the other
                rather than both. */}
            <div className="rounded-control border border-border p-3">
              <p className="mb-2 text-[12px] font-semibold text-fg">
                Ignore momentary spikes
              </p>

              <label className="block">
                <span className="mb-1 block text-[11px] text-muted">
                  How long the condition must hold
                </span>
                <Select
                  size="sm"
                  value={String(draft.min_duration_seconds)}
                  onChange={(v) => set({ min_duration_seconds: Number(v) })}
                  options={HOLD_CHOICES}
                />
              </label>

              <label className="mt-2 block">
                <span className="mb-1 block text-[11px] text-muted">
                  How many evaluations must agree
                </span>
                <Select
                  size="sm"
                  value={String(draft.consecutive_breaches_required)}
                  onChange={(v) => set({ consecutive_breaches_required: Number(v) })}
                  options={CONSECUTIVE_CHOICES}
                />
              </label>

              <p className="mt-2 text-[11px] leading-snug text-subtle">
                A breach that has not cleared these bars is held back: no alert,
                no email, nothing in the feed. If the condition clears first the
                held breach is discarded entirely, so a spike that never became
                an incident leaves no history claiming it did.
              </p>

              {draft.consecutive_breaches_required > 1 && (
                <p className="mt-1.5 text-[11px] leading-snug text-muted">
                  At one evaluation every{' '}
                  {humanDuration(draft.evaluation_interval_seconds)}, that is up
                  to{' '}
                  <strong className="text-fg">
                    {humanDuration(
                      draft.consecutive_breaches_required
                      * draft.evaluation_interval_seconds,
                    )}
                  </strong>{' '}
                  before anything alerts.
                </p>
              )}
            </div>

            <Switch
              checked={draft.enabled}
              onChange={(v) => set({ enabled: v })}
              label="Enabled"
            />
            {!draft.enabled && (
              <p className="text-[11px] leading-snug text-muted">
                A disabled rule is stored but never evaluated. Nothing it has
                already raised is affected.
              </p>
            )}
          </div>
        )}

        {/* ── Step 6: review ─────────────────────────────────────────── */}
        {step === 5 && (
          <div className="space-y-3">
            {/* Server field errors, verbatim and against the right label. */}
            {serverErrors && Object.keys(serverErrors).length > 0 && (
              <div className="rounded-control border border-danger bg-danger-soft p-3">
                <p className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-fg">
                  <Icon name="alert" size={13} className="text-danger" />
                  This rule could not be saved
                </p>
                <ul className="space-y-0.5">
                  {Object.entries(serverErrors).map(([field, message]) => (
                    <li key={field} className="text-[11px] leading-snug text-fg">
                      <span className="font-semibold">{field.replace(/[._]/g, ' ')}:</span>{' '}
                      {message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rounded-control border border-border bg-sunken p-3">
              <p className="text-[13px] font-bold text-fg">{draft.name || 'Untitled rule'}</p>
              {draft.description && (
                <p className="mt-0.5 text-[12px] text-muted">{draft.description}</p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <SeverityBadge severity={draft.severity} />
                <Badge tone="neutral" size="sm">
                  {categoryMeta(condition?.category).label}
                </Badge>
                {!draft.enabled && <Badge tone="warning" size="sm">Disabled</Badge>}
              </div>
            </div>

            <dl className="space-y-2">
              {[
                ['Trigger', condition?.label],
                ['Reads', condition?.source?.replace(/_/g, ' ')],
                ['Scope', Object.entries(draft.scope_config).filter(([, v]) => v)
                  .map(([k, v]) => `${k}: ${v}`).join(', ') || 'Whole account'],
                ['Evaluated', `Every ${humanDuration(draft.evaluation_interval_seconds)}`],
                ['Cooldown', humanDuration(draft.cooldown_seconds, { zero: 'None' })],
                ['Repeats', draft.repeat_interval_seconds
                  ? `Every ${humanDuration(draft.repeat_interval_seconds)}` : 'Notify once'],
                ['On resolve', draft.notify_on_resolution ? 'Sends an email' : 'No email'],
                ['Pacing', draft.severity === 'CRITICAL'
                  ? 'Immediate (critical alerts are never batched)'
                  : MODE_CHOICES.find((m) => m.id === draft.notification_mode)?.label],
                ['Quiet hours', draft.respect_quiet_hours !== false
                  ? 'Honoured' : 'Ignored — this rule always sends'],
                ['Escalation', draft.escalate_after_seconds
                  ? `After ${humanDuration(draft.escalate_after_seconds)} unacknowledged, to `
                    + `${(draft.notification_config.escalation_recipients || []).join(', ') || 'nobody'}`
                  : 'Off'],
                ['Hold-off', (draft.min_duration_seconds || draft.consecutive_breaches_required > 1)
                  ? [
                    draft.consecutive_breaches_required > 1
                      && `${draft.consecutive_breaches_required} consecutive evaluations`,
                    draft.min_duration_seconds
                      && `sustained for ${humanDuration(draft.min_duration_seconds)}`,
                  ].filter(Boolean).join(', ')
                  : 'Alerts on the first breach'],
                ['Recipients', effectiveRecipients.length
                  ? effectiveRecipients.join(', ')
                  : 'Nobody — alerts are recorded but not emailed'],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-3 text-[12px]">
                  <dt className="w-24 shrink-0 text-muted">{k}</dt>
                  <dd className="min-w-0 break-words font-medium text-fg">{v || '—'}</dd>
                </div>
              ))}
            </dl>

            <p className="rounded-control border border-border px-3 py-2 text-[11px] leading-snug text-muted">
              The exact sentence this rule will show in the list, in the alert
              and in the email is generated on the server from this
              configuration, so it can never describe a different comparison
              than the one that runs.
            </p>
          </div>
        )}
      </div>
    </Drawer>
  );
}
