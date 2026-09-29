import { useEffect, useMemo, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';
import Table, { EmptyState } from '@/components/ui/Table';
import Textarea from '@/components/ui/Textarea';
import { Field } from '@/components/ui/Field';
import { InlineLoading } from '@/components/ui/Loading';
import CloudSection from '../CloudSection';
import { downloadReportPdf } from '../../api/clients.api';
import {
  useGenerateReport, useReportPreview, useReports, useReportSchedule, useSaveReportSchedule,
  useSendReport,
} from '../../hooks/useClients';
import {
  deliveryMeta, findingCounts, formatBytes, formatMoneyMap, invalidEmails, moneyTitle,
  parseEmailList, periodLabel, periodOptions, REPORT_SECTIONS, reportStatusMeta, scheduleRunMeta,
} from '../../utils/clientModel';
import { formatCount, formatDateTime } from '../../utils/securityModel';

const DAYS = Array.from({ length: 28 }, (_, i) => ({ id: String(i + 1), label: String(i + 1) }));
const ZONES = ['Asia/Kolkata', 'UTC', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London',
  'America/New_York'];

const toForm = (s) => ({
  enabled: !!s?.enabled,
  day: String(s?.day_of_month || 3),
  time: s?.send_time || '09:00',
  timezone: s?.timezone || 'Asia/Kolkata',
  to: (s?.recipients?.to || []).join(', '),
  cc: (s?.recipients?.cc || []).join(', '),
  bcc: (s?.recipients?.bcc || []).join(', '),
  sections: s?.sections || REPORT_SECTIONS.map((x) => x.id),
});

/**
 * A client's monthly report: when it is produced, who receives it, and every
 * report produced so far.
 *
 * Two facts this panel never blurs. A schedule starts disabled — enabling it
 * is the act that starts e-mail leaving the building. And a report "queued"
 * for e-mail has been handed to the notification queue, not delivered.
 */
export default function ClientReportsPanel({ clientId, clientName, push }) {
  const { data: schedule, isLoading } = useReportSchedule(clientId);
  const { data: reports, isLoading: loadingReports } = useReports(clientId);
  const save = useSaveReportSchedule();
  const generate = useGenerateReport();
  const send = useSendReport();

  const periods = useMemo(() => periodOptions(), []);
  const [period, setPeriod] = useState(periods[0]?.id);
  const [showPreview, setShowPreview] = useState(false);
  const [form, setForm] = useState(() => toForm(null));
  const [confirmSend, setConfirmSend] = useState(null);
  const [downloading, setDownloading] = useState(null);
  const preview = useReportPreview(clientId, period, showPreview);

  useEffect(() => {
    if (schedule) setForm(toForm(schedule));
  }, [schedule]);

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const lists = {
    to: parseEmailList(form.to), cc: parseEmailList(form.cc), bcc: parseEmailList(form.bcc),
  };
  const bad = [...invalidEmails(lists.to), ...invalidEmails(lists.cc), ...invalidEmails(lists.bcc)];
  const needsTo = form.enabled && !lists.to.length;
  const delivery = schedule?.delivery;
  const savedTo = schedule?.saved ? (schedule.recipients?.to || []) : [];
  const canEmail = savedTo.length > 0 && delivery?.ready;

  const saveSchedule = async () => {
    try {
      await save.mutateAsync({
        clientId,
        schedule: {
          enabled: form.enabled,
          day_of_month: Number(form.day),
          send_time: form.time,
          timezone: form.timezone,
          recipients: lists,
          sections: form.sections,
        },
      });
      push?.(form.enabled ? 'Schedule saved and enabled.' : 'Schedule saved (disabled).');
    } catch (e) {
      push?.(e?.response?.data?.detail || 'Saving the schedule failed.', 'error');
    }
  };

  const runGenerate = async (andSend) => {
    try {
      const r = await generate.mutateAsync({ clientId, period, send: andSend });
      if (r.status === 'FAILED') {
        push?.(`The ${periodLabel(r.period)} report could not be built: ${r.error || 'unknown error'}`, 'error');
      } else {
        push?.(`${periodLabel(r.period)} report generated — ${deliveryMeta(r.delivery_status).label.toLowerCase()}.`);
      }
    } catch (e) {
      push?.(e?.response?.data?.detail || 'Generating the report failed.', 'error');
    }
  };

  const download = async (r) => {
    setDownloading(r.id);
    try {
      await downloadReportPdf(clientId, r.id, `report-${r.period}.pdf`);
    } catch (e) {
      push?.(e?.response?.data?.detail || 'The download failed.', 'error');
    } finally {
      setDownloading(null);
    }
  };

  const sendNow = async () => {
    const r = confirmSend;
    try {
      const out = await send.mutateAsync({ clientId, reportId: r.id });
      push?.(`${periodLabel(out.period)}: ${deliveryMeta(out.delivery_status).label}.`,
        out.delivery_status === 'QUEUED' ? 'success' : 'error');
    } catch (e) {
      push?.(e?.response?.data?.detail || 'Sending failed.', 'error');
    } finally {
      setConfirmSend(null);
    }
  };

  if (isLoading) return <InlineLoading label="Loading report settings…" />;

  const run = scheduleRunMeta(schedule?.last_status);
  const toggleSection = (id) => set('sections')(
    form.sections.includes(id) ? form.sections.filter((s) => s !== id) : [...form.sections, id],
  );

  const reportRows = (reports || []).map((r) => {
    const status = reportStatusMeta(r.status);
    const dm = deliveryMeta(r.delivery_status);
    return {
      key: r.id,
      cells: {
        period: <span className="text-[13px] font-semibold text-fg">{periodLabel(r.period)}</span>,
        generated: (
          <div className="text-[12px] text-muted">
            <div>{formatDateTime(r.generated_at)}</div>
            <div className="text-[11px] text-subtle">
              {r.trigger === 'schedule' ? 'Scheduled' : `Manual${r.requested_by ? ` · ${r.requested_by}` : ''}`}
            </div>
          </div>
        ),
        status: (
          <div className="min-w-0">
            <Badge tone={status.tone}>{status.label}</Badge>
            {r.error && <div className="mt-0.5 line-clamp-2 text-[11px] text-danger-fg" title={r.error}>{r.error}</div>}
          </div>
        ),
        size: <span className="text-[12px] text-muted">{formatBytes(r.pdf_bytes)}</span>,
        delivery: (
          <div className="min-w-0">
            <Badge tone={dm.tone} title={dm.hint}>{dm.label}</Badge>
            {r.delivery_message && (
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-subtle" title={r.delivery_message}>
                {r.delivery_message}
              </div>
            )}
          </div>
        ),
        actions: (
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              icon="download"
              disabled={r.status !== 'GENERATED'}
              loading={downloading === r.id}
              onClick={() => download(r)}
            >
              PDF
            </Button>
            <Button
              size="sm"
              icon="send"
              disabled={r.status !== 'GENERATED' || !canEmail}
              title={!canEmail ? 'Needs a saved To address and working e-mail delivery.' : undefined}
              onClick={() => setConfirmSend(r)}
            >
              E-mail
            </Button>
          </div>
        ),
      },
    };
  });

  const p = preview.data;
  const pf = findingCounts(p?.totals?.findings);

  return (
    <div className="space-y-5">
      {delivery && !delivery.ready && (
        <Notice tone="warning" title="E-mail cannot be delivered yet.">
          {(delivery.blockers || []).map((b) => b.message).join(' ')}
          {' '}Reports can still be generated and downloaded.
        </Notice>
      )}

      <CloudSection
        title="Generate a report"
        description="A report covers one complete month, built only from Actmon's stored data — no provider is called."
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Month">
            <Select width="auto" value={period} onChange={(v) => { setPeriod(v); }} options={periods} />
          </Field>
          <Button icon="eye" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? 'Hide preview' : 'Preview numbers'}
          </Button>
          <Button variant="primary" icon="report" loading={generate.isPending && !generate.variables?.send} disabled={generate.isPending} onClick={() => runGenerate(false)}>
            Generate PDF
          </Button>
          <Button
            icon="send"
            loading={generate.isPending && !!generate.variables?.send}
            disabled={generate.isPending || !canEmail}
            title={!canEmail ? 'Needs a saved To address and working e-mail delivery.' : undefined}
            onClick={() => runGenerate(true)}
          >
            Generate and e-mail
          </Button>
        </div>

        {showPreview && (
          <div className="mt-4 rounded-control border border-border p-3">
            {preview.isLoading && <InlineLoading label="Gathering the stored figures…" />}
            {preview.isError && (
              <Notice tone="danger" className="mb-0">
                {preview.error?.response?.data?.detail || preview.error?.message}
              </Notice>
            )}
            {p && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <PreviewStat label="Spend" value={formatMoneyMap(p.totals?.spend, { style: 'exact' })} title={moneyTitle(p.totals?.spend)} />
                  <PreviewStat label="Confirmed findings" value={`${pf.critical} critical · ${pf.high} high`} />
                  <PreviewStat label="Certificates ≤ 60 d" value={formatCount(p.totals?.certificates)} />
                  <PreviewStat label="Accounts with gaps" value={`${formatCount(p.totals?.accounts_with_gaps)} of ${formatCount(p.totals?.accounts)}`} />
                </div>
                {(p.accounts || []).some((a) => a.gaps?.length) && (
                  <div>
                    <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted">Data gaps the report will list</div>
                    <ul className="space-y-1 text-[12px] text-muted">
                      {p.accounts.filter((a) => a.gaps?.length).map((a) => (
                        <li key={a.account_id}>
                          <span className="font-semibold text-fg">{a.account_name}:</span> {a.gaps.join(' ')}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CloudSection>

      <CloudSection
        title="Report history"
        description="The last 24 reports. A PDF is kept with the numbers it was drawn from."
        bodyClassName="p-0"
      >
        <Table
          columns={[
            { key: 'period', label: 'Month', width: 150 },
            { key: 'generated', label: 'Generated', width: 200 },
            { key: 'status', label: 'Status', width: 170 },
            { key: 'size', label: 'Size', width: 80 },
            { key: 'delivery', label: 'E-mail', hint: 'Queued means handed to the notification queue. Delivery is recorded in notification history.' },
            { key: 'actions', label: '', width: 190, align: 'right' },
          ]}
          rows={reportRows}
          loading={loadingReports}
          empty={<EmptyState icon="report" title="No reports yet" body="Generate one above, or enable the schedule." />}
        />
      </CloudSection>

      <CloudSection
        title="Monthly schedule"
        description={schedule?.saved ? `Last changed ${formatDateTime(schedule.updated_at)}${schedule.updated_by ? ` by ${schedule.updated_by}` : ''}.` : 'Not saved yet — defaults shown. A schedule starts disabled.'}
        action={(
          <Button
            variant="primary"
            icon="save"
            loading={save.isPending}
            disabled={bad.length > 0 || needsTo || !form.sections.length}
            onClick={saveSchedule}
          >
            Save schedule
          </Button>
        )}
      >
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="space-y-4">
            <Field
              label="E-mail the report every month"
              hint="Off by default. When on, the report for the previous month is built and queued on the chosen day."
              inline
            >
              <Switch checked={form.enabled} onChange={set('enabled')} label="Enable monthly schedule" />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Day" hint="1–28">
                <Select value={form.day} onChange={set('day')} options={DAYS} />
              </Field>
              <Field label="Time">
                <Input type="time" value={form.time} onChange={(e) => set('time')(e.target.value)} />
              </Field>
              <Field label="Time zone">
                <Select
                  value={form.timezone}
                  onChange={set('timezone')}
                  options={[...new Set([form.timezone, ...ZONES])].map((z) => ({ id: z, label: z }))}
                />
              </Field>
            </div>
            <p className="text-[11px] leading-relaxed text-subtle">
              The 3rd is the default because providers restate billing for a few days after month
              end. If the service was down on the day, only the latest month is produced — never a
              burst of back-dated e-mails.
            </p>
            {schedule?.saved && (
              <div className="rounded-control border border-border p-3 text-[12px] text-muted">
                <div>Next run: <span className="text-fg">{schedule.next_run_at ? formatDateTime(schedule.next_run_at) : 'not scheduled'}</span></div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  Last run: <span className="text-fg">{formatDateTime(schedule.last_run_at)}</span>
                  {schedule.last_status && <Badge tone={run.tone} size="xs">{run.label}</Badge>}
                  {schedule.last_period && <span>({periodLabel(schedule.last_period)})</span>}
                </div>
                {schedule.last_message && <p className="mt-1 text-[11px] leading-snug">{schedule.last_message}</p>}
              </div>
            )}
          </div>

          <div className="space-y-4">
            <Field label="To" hint="Required to enable the schedule. Separate addresses with commas.">
              <Textarea rows={2} value={form.to} onChange={(e) => set('to')(e.target.value)} placeholder={`e.g. it-head@${(clientName || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '')}.com`} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cc"><Textarea rows={2} value={form.cc} onChange={(e) => set('cc')(e.target.value)} /></Field>
              <Field label="Bcc"><Textarea rows={2} value={form.bcc} onChange={(e) => set('bcc')(e.target.value)} /></Field>
            </div>
            {bad.length > 0 && <p className="text-[11px] text-danger-fg">Not e-mail addresses: {bad.join(', ')}</p>}
            {needsTo && <p className="text-[11px] text-danger-fg">A schedule that e-mails needs at least one To address.</p>}
            <div>
              <div className="mb-1.5 text-[12px] font-semibold text-fg">Sections</div>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {REPORT_SECTIONS.map((s) => (
                  <label key={s.id} className="flex cursor-pointer items-start gap-2 text-[12px]" title={s.hint}>
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-border accent-[var(--accent)]"
                      checked={form.sections.includes(s.id)}
                      onChange={() => toggleSection(s.id)}
                    />
                    <span>
                      <span className="font-medium text-fg">{s.label}</span>
                      <span className="block text-[11px] text-subtle">{s.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      </CloudSection>

      <ConfirmDialog
        open={!!confirmSend}
        title={`E-mail the ${periodLabel(confirmSend?.period)} report?`}
        message={`It will be queued to ${savedTo.join(', ') || 'no one'}${
          (schedule?.recipients?.cc || []).length ? `, cc ${schedule.recipients.cc.join(', ')}` : ''}. `
          + 'Queued is not delivered — the database service sends it and records the outcome.'}
        confirmLabel="Queue e-mail"
        cancelLabel="Cancel"
        tone="warning"
        icon="send"
        loading={send.isPending}
        onConfirm={sendNow}
        onCancel={() => setConfirmSend(null)}
      />
    </div>
  );
}

function PreviewStat({ label, value, title }) {
  return (
    <div title={title}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 text-[13px] font-semibold text-fg">{value}</div>
    </div>
  );
}
