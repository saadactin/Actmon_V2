import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';
import Table, { EmptyState } from '@/components/ui/Table';
import { Count, DeliveryBanner, When } from './AlertPrimitives';

/**
 * Email settings: who receives alerts, whether delivery can actually happen,
 * and what really got sent.
 *
 * The distinction this panel exists to hold is between **queued** and
 * **delivered**. Test sends report "queued" and say so; the delivery history
 * below is the only place the word "sent" appears, and it comes from the
 * shared notification ledger the dispatcher writes after it has actually tried
 * an SMTP conversation. A test button that says "sent successfully" the moment
 * a row lands in a queue is the single most misleading thing this feature could
 * do, so it does not.
 *
 * The SMTP block shows host, port, TLS and the sender identity — and never the
 * username or password. The API does not return them.
 */

const KIND_OPTIONS = [
  { id: 'to', label: 'To' },
  { id: 'cc', label: 'Cc' },
  { id: 'bcc', label: 'Bcc' },
];

const STATUS_TONE = { sent: 'success', failed: 'danger', pending: 'info' };

export default function EmailSettingsPanel({
  data, loading, error,
  canManage, canTest,
  onAdd, adding, addError,
  onToggle, onDelete,
  onEnableChannel, enabling,
  onTest, testing, testResult,
}) {
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState('to');
  const [testTo, setTestTo] = useState('');

  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-control bg-sunken" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-control border border-dashed border-border px-4 py-6">
        <p className="flex items-center gap-2 text-[13px] font-semibold text-fg">
          <Icon name="alert" size={15} className="text-warning-fg" />
          Email settings could not be loaded
        </p>
        <p className="mt-1 text-[12px] leading-snug text-muted">
          {error?.response?.data?.detail || error?.message
            || 'The notification configuration could not be read.'}
        </p>
        <p className="mt-2 text-[11px] leading-snug text-subtle">
          Alert rules and history on the other tabs are unaffected — they do not
          depend on this.
        </p>
      </div>
    );
  }

  const delivery = data?.delivery;
  const smtp = delivery?.smtp;
  const recipients = data?.recipients || [];
  const totals = data?.history_totals || {};

  const submitRecipient = () => {
    if (!email.trim()) return;
    onAdd?.({ email: email.trim(), label: label.trim() || null, kind });
    setEmail('');
    setLabel('');
  };

  return (
    <div className="space-y-4">
      <DeliveryBanner
        delivery={delivery}
        onFix={canManage ? onEnableChannel : undefined}
        fixing={enabling}
      />

      {/* ── The server ─────────────────────────────────────────────── */}
      <section className="card p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-[13px] font-bold text-fg">
              <Icon name="mail" size={15} className="text-accent-text" />
              Mail server
            </h3>
            <p className="mt-0.5 text-[11px] leading-snug text-muted">
              Shared with the rest of Actmon&rsquo;s notifications. Configured in
              Settings → Notifications → Email.
            </p>
          </div>
          <Badge tone={delivery?.ready ? 'success' : 'warning'} size="sm">
            {delivery?.ready ? 'Ready' : 'Not ready'}
          </Badge>
        </div>

        {smtp ? (
          <dl className="mt-3 grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
            {[
              ['Server', `${smtp.host}:${smtp.port}`],
              ['Encryption', smtp.tls ? 'STARTTLS' : 'Implicit SSL'],
              ['From', smtp.sender_name
                ? `${smtp.sender_name} <${smtp.sender_email}>`
                : smtp.sender_email],
              ['Config', smtp.name || 'Unnamed'],
              ['Last tested', smtp.last_test_at
                ? <When key="t" iso={smtp.last_test_at} />
                : <span key="tn" className="text-subtle">Never tested</span>],
              ['Last test result', smtp.last_test_at
                ? (
                  <Badge tone={smtp.last_test_ok ? 'success' : 'danger'} size="sm">
                    {smtp.last_test_ok ? 'Succeeded' : 'Failed'}
                  </Badge>
                )
                : <span key="rn" className="text-subtle">NA</span>],
            ].map(([k, v]) => (
              <div key={k} className="flex gap-3 text-[12px]">
                <dt className="w-28 shrink-0 text-muted">{k}</dt>
                <dd className="min-w-0 break-words font-medium text-fg">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-3 rounded-control border border-dashed border-border px-3 py-4 text-[12px] text-muted">
            No SMTP server is configured. Add one in Settings → Notifications →
            Email; nothing can be delivered until then, though alerts will still
            be recorded here.
          </p>
        )}

        {smtp?.last_test_msg && !smtp.last_test_ok && (
          <p className="mt-2 rounded-control border border-danger bg-danger-soft px-2.5 py-2 text-[11px] leading-snug text-fg">
            {smtp.last_test_msg}
          </p>
        )}
      </section>

      {/* ── Recipients ─────────────────────────────────────────────── */}
      <section className="card p-4">
        <h3 className="flex items-center gap-2 text-[13px] font-bold text-fg">
          <Icon name="users" size={15} className="text-accent-text" />
          Default recipients for this account
        </h3>
        <p className="mt-0.5 text-[11px] leading-snug text-muted">
          Every rule that does not set its own recipients emails these addresses.
          Resolved when the alert fires, so adding one now reaches rules that
          already exist.
        </p>

        {canManage && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="min-w-[220px] flex-1">
              <span className="mb-1 block text-[11px] font-semibold text-fg">Email</span>
              <Input
                size="sm"
                placeholder="cloudops@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitRecipient()}
              />
            </label>
            <label className="min-w-[150px] flex-1">
              <span className="mb-1 block text-[11px] font-semibold text-fg">
                Label <span className="font-normal text-subtle">(optional)</span>
              </span>
              <Input
                size="sm" placeholder="Cloud Operations"
                value={label} onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <label className="w-24">
              <span className="mb-1 block text-[11px] font-semibold text-fg">Field</span>
              <Select size="sm" value={kind} onChange={setKind} options={KIND_OPTIONS} />
            </label>
            <Button icon="plus" loading={adding} onClick={submitRecipient}>Add</Button>
          </div>
        )}

        {addError && (
          <p className="mt-2 text-[11px] text-danger">{addError}</p>
        )}

        <div className="mt-3">
          {recipients.length === 0 ? (
            <p className="rounded-control border border-dashed border-border px-3 py-4 text-[12px] text-muted">
              No recipients configured. Alerts will be recorded in this tab and
              emailed to nobody.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-control border border-border">
              {recipients.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[12px] font-medium text-fg">
                        {r.email}
                      </span>
                      <Badge tone="neutral" size="sm">{(r.kind || 'to').toUpperCase()}</Badge>
                      {!r.enabled && <Badge tone="warning" size="sm">Disabled</Badge>}
                    </div>
                    {r.label && (
                      <span className="text-[11px] text-subtle">{r.label}</span>
                    )}
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-2">
                      <Switch
                        size="sm"
                        checked={!!r.enabled}
                        onChange={(v) => onToggle?.({ recipientId: r.id, enabled: v })}
                      />
                      <Button
                        size="sm" variant="danger-ghost" icon="trash"
                        onClick={() => onDelete?.(r.id)}
                        title="Remove recipient"
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ── Test ───────────────────────────────────────────────────── */}
      {canTest && (
        <section className="card p-4">
          <h3 className="flex items-center gap-2 text-[13px] font-bold text-fg">
            <Icon name="send" size={15} className="text-accent-text" />
            Send a test message
          </h3>
          <p className="mt-0.5 text-[11px] leading-snug text-muted">
            Clearly labelled <code className="text-fg">[TEST]</code> in the
            subject, so it can never be mistaken for a real incident.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="min-w-[240px] flex-1">
              <span className="mb-1 block text-[11px] font-semibold text-fg">
                Send to <span className="font-normal text-subtle">
                  (leave empty to use the default recipients)
                </span>
              </span>
              <Input
                size="sm"
                placeholder="you@company.com"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
              />
            </label>
            <Button
              icon="send" loading={testing}
              disabled={!delivery?.ready}
              onClick={() => onTest?.(testTo.trim() ? [testTo.trim()] : [])}
            >
              Send test
            </Button>
          </div>

          {testResult && (
            <div className={`mt-3 rounded-control border px-3 py-2.5 ${
              testResult.queued
                ? 'border-info bg-info-soft'
                : 'border-warning bg-warning-soft'
            }`}
            >
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-fg">
                <Icon name={testResult.queued ? 'clock' : 'alert'} size={13} />
                {testResult.queued
                  ? `Queued for ${(testResult.recipients || []).join(', ')}`
                  : 'Not queued'}
              </p>
              <p className="mt-1 text-[11px] leading-snug text-muted">
                {testResult.note || testResult.reason || testResult.message}
              </p>
            </div>
          )}
        </section>
      )}

      {/* ── The ledger ─────────────────────────────────────────────── */}
      <section className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-[13px] font-bold text-fg">
              <Icon name="history" size={15} className="text-accent-text" />
              Delivery history
            </h3>
            <p className="mt-0.5 text-[11px] leading-snug text-muted">
              What the mail server actually did. This is the only place
              &ldquo;sent&rdquo; is claimed.
            </p>
          </div>
          {totals.available === false ? (
            <Badge tone="warning" size="sm">Ledger unreadable</Badge>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="success" size="sm">Sent <Count value={totals.sent ?? 0} /></Badge>
              <Badge tone={totals.failed ? 'danger' : 'neutral'} size="sm">
                Failed <Count value={totals.failed ?? 0} />
              </Badge>
              <Badge tone="info" size="sm">
                Pending <Count value={totals.pending ?? 0} />
              </Badge>
            </div>
          )}
        </div>

        {totals.available === false ? (
          <p className="mt-3 rounded-control border border-dashed border-border px-3 py-4 text-[12px] leading-snug text-muted">
            The notification ledger could not be read, so delivery results are
            unknown — not zero. {totals.reason}
          </p>
        ) : (
          <div className="mt-3">
            <Table
              columns={[
                { key: 'at', label: 'When', width: 130 },
                { key: 'alert', label: 'Alert', width: '28%' },
                { key: 'recipient', label: 'Recipient', width: '24%' },
                { key: 'status', label: 'Result', width: 110 },
                { key: 'detail', label: 'Detail' },
              ]}
              rows={(data?.history || []).map((h, i) => ({
                key: `${h.at}-${i}`,
                cells: {
                  at: <span className="text-[11px]"><When iso={h.at} /></span>,
                  alert: (
                    <span className="block truncate text-[12px] text-fg">
                      {h.alert || '—'}
                    </span>
                  ),
                  recipient: (
                    <span className="block truncate text-[11px] text-muted">
                      {h.recipient || '—'}
                    </span>
                  ),
                  status: (
                    <Badge tone={STATUS_TONE[h.status] || 'neutral'} size="sm">
                      {h.status}
                    </Badge>
                  ),
                  detail: (
                    <span className="text-[11px] leading-snug text-muted">
                      {h.error || (h.response_time_ms
                        ? `${Math.round(h.response_time_ms)} ms`
                        : '—')}
                      {h.retries > 0 && (
                        <span className="text-subtle"> · {h.retries} retr{h.retries === 1 ? 'y' : 'ies'}</span>
                      )}
                    </span>
                  ),
                },
              }))}
              empty={(
                <EmptyState
                  icon="mail"
                  title="Nothing has been delivered yet"
                  body="No email has been attempted. Send a test above to verify the whole chain end to end."
                />
              )}
            />
          </div>
        )}
      </section>

      {/* ── Other channels, stated honestly ────────────────────────── */}
      {data?.channels?.others && (
        <p className="rounded-control border border-dashed border-border px-3 py-2.5 text-[11px] leading-snug text-muted">
          <strong className="text-fg">Email is the only connected channel.</strong>{' '}
          {data.channels.others.note} ({data.channels.others.label}.)
        </p>
      )}
    </div>
  );
}
