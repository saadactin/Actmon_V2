import { useEffect, useState } from 'react';
import Button from '@/components/ui/Button';
import Dialog from '@/components/ui/Dialog';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';
import { Field } from '@/components/ui/Field';
import { useCreateBudget, useUpdateBudget } from '../../hooks/useCost';

const PERIODS = [
  { id: 'MONTHLY', label: 'Monthly' },
  { id: 'QUARTERLY', label: 'Quarterly' },
  { id: 'ANNUAL', label: 'Annual' },
];

// Only the two currencies this product actually bills in today (OCI and Azure
// in INR, AWS in USD) — see cost_money.py. A budget's currency is NOT
// converted against anything, so offering a currency nothing bills in would
// only ever show "0 of X spent".
const CURRENCIES = [
  { id: 'INR', label: 'INR (₹)' },
  { id: 'USD', label: 'USD ($)' },
];

const SCOPES = [
  { id: 'account', label: 'This account only' },
  { id: 'all', label: 'Organisation-wide (every account)' },
];

const EMPTY = {
  name: '', amount: '', currency: 'INR', period: 'MONTHLY',
  thresholds: '50, 75, 90, 100', cooldownHours: '6',
  alertOnForecast: false, enabled: true, scope: 'account',
};

const fromBudget = (b, defaultScope) => (b ? {
  name: b.name || '',
  amount: b.amount != null ? String(b.amount) : '',
  currency: b.currency || 'INR',
  period: b.period || 'MONTHLY',
  thresholds: (b.thresholds || []).join(', '),
  cooldownHours: b.cooldown_hours != null ? String(b.cooldown_hours) : '6',
  alertOnForecast: !!b.alert_on_forecast,
  enabled: b.enabled !== false,
  scope: b.account_id ? 'account' : 'all',
} : { ...EMPTY, scope: defaultScope });

/** Parses "50, 75, 90, 100" into [50, 75, 90, 100], dropping anything that
 *  is not a whole number 1-1000 -- the same range the backend enforces
 *  (_validate_budget: thresholds outside 1..1000 are refused). */
function parseThresholds(text) {
  return [...new Set(
    text.split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 1000),
  )].sort((a, b) => a - b);
}

/**
 * Create or edit a budget. The backend is the authority on every rule (valid
 * period, threshold range, currency presence); the checks here only save a
 * round trip for an obvious typo, and a server refusal is shown verbatim.
 *
 * Scope is deliberately limited to "this account" or "every account" —
 * narrowing by provider/service/region/cost_component is a backend
 * capability this dialog does not yet expose, consistent with keeping a
 * budget's scope visible rather than hiding a filter nobody set.
 */
export default function BudgetFormDialog({
  open, onClose, budget = null, accountId, onSaved,
}) {
  const editing = !!budget;
  const [form, setForm] = useState(() => fromBudget(budget, 'account'));
  const create = useCreateBudget(accountId);
  const update = useUpdateBudget(accountId);
  const mutation = editing ? update : create;

  useEffect(() => {
    if (open) {
      setForm(fromBudget(budget, 'account'));
      create.reset();
      update.reset();
    }
    // Reset only when the dialog opens or switches budget, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, budget?.id]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target?.value ?? e }));

  const amountNum = Number.parseFloat(form.amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;
  const thresholds = parseThresholds(form.thresholds);
  const cooldownNum = Number.parseInt(form.cooldownHours, 10);
  const cooldownValid = Number.isFinite(cooldownNum) && cooldownNum >= 0 && cooldownNum <= 720;
  const canSave = form.name.trim() && amountValid && thresholds.length > 0
    && cooldownValid && !mutation.isPending;

  const save = async () => {
    const payload = {
      name: form.name.trim(),
      amount: amountNum,
      currency: form.currency,
      period: form.period,
      account_id: form.scope === 'account' ? accountId : null,
      thresholds,
      cooldown_hours: cooldownNum,
      alert_on_forecast: form.alertOnForecast,
      enabled: form.enabled,
    };
    try {
      const saved = editing
        ? await update.mutateAsync({ id: budget.id, payload })
        : await create.mutateAsync(payload);
      onSaved?.(saved);
      onClose?.();
    } catch {
      /* shown from mutation.error below */
    }
  };

  const serverError = mutation.error?.response?.data?.detail || mutation.error?.message;

  return (
    <Dialog
      open={open}
      onClose={mutation.isPending ? undefined : onClose}
      title={editing ? `Edit ${budget.name}` : 'New budget'}
      subtitle="Alerts as spend crosses each threshold. Nothing here blocks a cloud resource -- this platform is advisory."
      icon="gauge"
      width={560}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" disabled={mutation.isPending} onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mutation.isPending} disabled={!canSave} onClick={save}>
            {editing ? 'Save changes' : 'Create budget'}
          </Button>
        </div>
      )}
    >
      {serverError && <Notice tone="danger">{String(serverError)}</Notice>}
      <div className="space-y-4">
        <Field label="Name">
          <Input value={form.name} onChange={set('name')} placeholder="e.g. Production compute, October" autoFocus />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <Input
              type="number" min="0" step="any" value={form.amount}
              onChange={set('amount')} placeholder="e.g. 50000"
            />
          </Field>
          <Field label="Currency" hint="Never converted -- spend in another currency is disclosed, not counted.">
            <Select value={form.currency} onChange={(v) => setForm((f) => ({ ...f, currency: v }))} options={CURRENCIES} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Period">
            <Select value={form.period} onChange={(v) => setForm((f) => ({ ...f, period: v }))} options={PERIODS} />
          </Field>
          <Field
            label="Scope"
            hint={editing ? 'Scope cannot be changed after creation.' : undefined}
          >
            <Select
              value={form.scope}
              onChange={(v) => setForm((f) => ({ ...f, scope: v }))}
              options={SCOPES}
              disabled={editing}
            />
          </Field>
        </div>

        <Field
          label="Alert thresholds (% of the budget)"
          hint="Comma-separated whole numbers, 1-1000. Crossing a higher one always alerts, even inside the cooldown below."
        >
          <Input value={form.thresholds} onChange={set('thresholds')} placeholder="50, 75, 90, 100" />
          {form.thresholds.trim() && thresholds.length === 0 && (
            <p className="mt-1 text-meta text-danger-fg">No valid thresholds in that list.</p>
          )}
        </Field>

        <Field label="Cooldown between repeat alerts (hours)">
          <Input type="number" min="0" max="720" value={form.cooldownHours} onChange={set('cooldownHours')} />
        </Field>

        <Field
          label="Alert on forecast"
          hint="Also alert when the run-rate PROJECTION for the period crosses a threshold, ahead of actual spend getting there. Off by default -- a projection is not a fact."
        >
          <Switch checked={form.alertOnForecast} onChange={(v) => setForm((f) => ({ ...f, alertOnForecast: v }))} />
        </Field>

        <Field label="Enabled">
          <Switch checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
        </Field>
      </div>
    </Dialog>
  );
}
