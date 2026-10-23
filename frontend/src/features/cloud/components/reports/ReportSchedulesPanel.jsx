import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Dialog from '@/components/ui/Dialog';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Switch from '@/components/ui/Switch';
import { Field, Section, Segmented, Select } from '@/components/ui/Field';
import {
  useDeleteReportSchedule, useReportSchedules, useReportTemplates, useRunReportSchedule,
  useSaveReportSchedule,
} from '../../hooks/useReports';
import { deliveryMeta, parseEmailList, scheduleRunMeta } from '../../utils/clientModel';
import {
  WEEKDAYS, browserTimeZone, configFromDraft, describeSchedule, errorMessage, saveProblem,
} from '../../utils/reportModel';

const CURRENT = '__current__';

const blank = () => ({
  name: '', enabled: false, frequency: 'monthly', day_of_week: 0, day_of_month: 3,
  send_time: '09:00', timezone: browserTimeZone(), to: '', cc: '', source: CURRENT,
});

function fromSchedule(s) {
  return {
    name: s.name, enabled: s.enabled, frequency: s.frequency, day_of_week: s.day_of_week ?? 0,
    day_of_month: s.day_of_month ?? 3, send_time: s.send_time, timezone: s.timezone,
    to: (s.recipients?.to || []).join(', '), cc: (s.recipients?.cc || []).join(', '),
    source: '__keep__', config: s.config, template_name: s.template_name,
  };
}

function ScheduleEditor({ open, onClose, initial, scheduleId, accountId, draft, templates }) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState(null);
  const save = useSaveReportSchedule(accountId);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const sources = [
    ...(form.source === '__keep__' ? [{ id: '__keep__', label: `Keep its current settings${form.template_name ? ` (${form.template_name})` : ''}` }] : []),
    { id: CURRENT, label: 'The report currently set up in Build' },
    ...templates.map((t) => ({ id: t.id, label: t.name, group: t.builtin ? 'Built-in templates' : 'Saved templates' })),
  ];
  const draftProblem = form.source === CURRENT ? saveProblem(draft) : null;

  const submit = async () => {
    setError(null);
    let config = form.config;
    let templateName = form.template_name || null;
    if (form.source === CURRENT) {
      config = configFromDraft(draft);
      templateName = draft.template_name || null;
    } else if (form.source !== '__keep__') {
      const t = templates.find((x) => x.id === form.source);
      config = t?.config;
      templateName = t?.name || null;
    }
    try {
      await save.mutateAsync({
        id: scheduleId,
        schedule: {
          name: form.name, enabled: form.enabled, frequency: form.frequency,
          day_of_week: Number(form.day_of_week), day_of_month: Number(form.day_of_month),
          send_time: form.send_time, timezone: form.timezone, config, template_name: templateName,
          recipients: { to: parseEmailList(form.to), cc: parseEmailList(form.cc), bcc: [] },
        },
      });
      onClose();
    } catch (err) {
      setError(await errorMessage(err));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={save.isPending ? undefined : onClose}
      title={scheduleId ? 'Edit schedule' : 'New schedule'}
      icon="calendar"
      width={560}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" disabled={save.isPending} onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!!draftProblem || !form.name.trim()} onClick={submit}>
            Save schedule
          </Button>
        </div>
      )}
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Monthly security pack" />
        </Field>
        <Field label="Report" hint="Frozen when saved — editing a template later does not change what this schedule sends.">
          <Select options={sources} value={form.source} onChange={(v) => set('source', v)} />
        </Field>
        {draftProblem && <Notice tone="warning">{draftProblem}</Notice>}
        <Field label="Frequency">
          <Segmented
            options={[{ id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' }]}
            value={form.frequency}
            onChange={(v) => set('frequency', v)}
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {form.frequency === 'weekly' ? (
            <Field label="Day">
              <Select options={WEEKDAYS.map((d, i) => ({ id: String(i), label: d }))}
                value={String(form.day_of_week)} onChange={(v) => set('day_of_week', Number(v))} />
            </Field>
          ) : (
            <Field label="Day of month" hint="1–28: every month has one">
              <Select options={Array.from({ length: 28 }, (_, i) => ({ id: String(i + 1), label: String(i + 1) }))}
                value={String(form.day_of_month)} onChange={(v) => set('day_of_month', Number(v))} />
            </Field>
          )}
          <Field label="Time">
            <Input type="time" value={form.send_time} onChange={(e) => set('send_time', e.target.value)} />
          </Field>
          <Field label="Time zone">
            <Input value={form.timezone} onChange={(e) => set('timezone', e.target.value)} />
          </Field>
        </div>
        <Field label="To" hint="Comma-separated addresses">
          <Input value={form.to} onChange={(e) => set('to', e.target.value)} placeholder="ops@example.com" />
        </Field>
        <Field label="Cc">
          <Input value={form.cc} onChange={(e) => set('cc', e.target.value)} />
        </Field>
        <Field label="Enabled" inline hint="Off until you turn it on. While off, nothing is produced or e-mailed.">
          <Switch label="Enabled" checked={form.enabled} onChange={() => set('enabled', !form.enabled)} />
        </Field>
        {error && <Notice tone="danger" title="Could not save">{error}</Notice>}
      </div>
    </Dialog>
  );
}

/**
 * Reports that produce themselves. Created disabled; the scheduler acts only
 * on enabled ones. One report per schedule per run is enforced by the
 * database, and after downtime only the latest missed run is produced.
 */
export default function ReportSchedulesPanel({ accountId, draft }) {
  const schedules = useReportSchedules(accountId);
  const templates = useReportTemplates();
  const remove = useDeleteReportSchedule(accountId);
  const run = useRunReportSchedule(accountId);
  const [editing, setEditing] = useState(null);      // {initial, id}
  const [confirm, setConfirm] = useState(null);      // {kind: 'delete'|'send', schedule}
  const [message, setMessage] = useState(null);

  if (schedules.isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
        <Icon name="spinner" size={16} className="animate-spin" />
        Loading schedules...
      </div>
    );
  }
  if (schedules.isError) {
    return <Notice tone="danger" title="Could not load schedules">{schedules.error?.message}</Notice>;
  }

  const list = schedules.data?.schedules || [];
  const delivery = schedules.data?.delivery || {};

  const runNow = async (s, send) => {
    setMessage(null);
    try {
      const r = await run.mutateAsync({ id: s.id, send });
      const d = deliveryMeta(r.delivery_status);
      setMessage({ tone: 'success', text: `${s.name}: report produced into history${send ? ` — e-mail: ${d.label}` : ''}.` });
    } catch (err) {
      setMessage({ tone: 'danger', text: await errorMessage(err) });
    }
  };

  return (
    <Section title="Scheduled Reports">
      {!delivery.ready && (
        <Notice tone="warning" title="E-mail delivery is not set up">
          {(delivery.blockers || []).map((b) => b.message).join(' ') || 'Scheduled reports will be produced into history but not e-mailed.'}
        </Notice>
      )}
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <div className="flex justify-end">
        <Button variant="primary" icon="plus" onClick={() => setEditing({ initial: blank(), id: null })}>New schedule</Button>
      </div>
      {list.length === 0 ? (
        <Notice tone="info">No schedules for this account.</Notice>
      ) : (
        <div className="space-y-2">
          {list.map((s) => {
            const last = scheduleRunMeta(s.last_status);
            return (
              <div key={s.id} className="rounded-control border border-border px-3 py-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-fg">{s.name}</span>
                      <Badge tone={s.enabled ? 'success' : 'neutral'} size="xs">{s.enabled ? 'On' : 'Off'}</Badge>
                    </div>
                    <p className="text-meta text-subtle">
                      {describeSchedule(s)} · {s.template_name || 'custom settings'} · to {(s.recipients?.to || []).join(', ') || 'nobody yet'}
                    </p>
                    <p className="text-meta text-subtle">
                      Next: {s.next_run_at ? new Date(s.next_run_at).toLocaleString() : 'not scheduled (off)'}
                      {' · '}Last: <span title={s.last_message || last.hint}>{last.label}</span>
                      {s.last_run_at && ` (${new Date(s.last_run_at).toLocaleString()})`}
                    </p>
                    {s.last_message && <p className="text-meta text-subtle">{s.last_message}</p>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => setEditing({ initial: fromSchedule(s), id: s.id })}>Edit</Button>
                    <Button size="sm" variant="secondary" loading={run.isPending && run.variables?.id === s.id && !run.variables?.send}
                      onClick={() => runNow(s, false)}>Run now</Button>
                    <Button size="sm" variant="secondary" disabled={!(s.recipients?.to || []).length}
                      onClick={() => setConfirm({ kind: 'send', schedule: s })}>Send now</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'delete', schedule: s })}>Delete</Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <ScheduleEditor
          open
          onClose={() => setEditing(null)}
          initial={editing.initial}
          scheduleId={editing.id}
          accountId={accountId}
          draft={draft}
          templates={templates.data?.templates || []}
        />
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === 'send' ? 'E-mail this report now?' : 'Delete this schedule?'}
        message={confirm?.kind === 'send'
          ? `A report is produced now and e-mailed to ${(confirm?.schedule.recipients?.to || []).join(', ')}. The schedule's next run is not affected.`
          : 'Nothing more is produced or e-mailed by it. Reports it already produced stay in history.'}
        confirmLabel={confirm?.kind === 'send' ? 'Produce and e-mail' : 'Delete'}
        cancelLabel="Cancel"
        tone={confirm?.kind === 'send' ? 'warning' : 'danger'}
        loading={remove.isPending || run.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const c = confirm;
          if (c.kind === 'send') {
            await runNow(c.schedule, true);
          } else {
            try {
              await remove.mutateAsync(c.schedule.id);
            } catch (err) {
              setMessage({ tone: 'danger', text: await errorMessage(err) });
            }
          }
          setConfirm(null);
        }}
      />
    </Section>
  );
}
