import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import { InlineLoading } from '@/components/ui/Loading';
import CloudSection from '../CloudSection';
import { PrivilegeBadge, Tile } from './IdentityPrimitives';
import {
  useAccessRequests, useApplyRequest, useApproveRequest, useCreateRequest,
  useIdentityPrincipals, useJitSessions, useRejectRequest, useRevokeSession,
} from '../../hooks/useIdentity';

const STATUS_TONE = {
  APPROVAL_REQUIRED: 'warning',
  APPROVED: 'info',
  APPLIED: 'success',
  REJECTED: 'neutral',
  FAILED: 'danger',
  ROLLED_BACK: 'neutral',
  CANCELLED: 'neutral',
  ACTIVE: 'success',
  EXPIRED: 'neutral',
  REVOKED: 'neutral',
};

/**
 * §15/§16: request elevated access, review it, approve it, watch it expire.
 *
 * Three things on this panel are load-bearing and visible by design:
 *
 * **The write mode banner.** Execution is off by default, and the panel says
 * so at the top rather than letting someone approve a request and assume it
 * took effect.
 *
 * **Overdue sessions.** A session past its expiry whose revocation was never
 * confirmed is standing admin access nobody is tracking — the exact state JIT
 * exists to prevent — so it gets its own counter and its own warning rather
 * than sitting as one row in a list.
 *
 * **The risk snapshot.** What the approver is shown is recorded with the
 * decision, so the audit trail reflects what the decision was actually made on
 * rather than what the estate looks like now.
 */
export default function AccessRequestsPanel({ accountId }) {
  const [showForm, setShowForm] = useState(false);
  const requests = useAccessRequests(accountId, { limit: 50 });
  const sessions = useJitSessions(accountId, { limit: 50 });

  const writeMode = requests.data?.write_mode || sessions.data?.write_mode;
  const items = requests.data?.items || [];
  const live = sessions.data?.items || [];
  const overdue = sessions.data?.overdue || 0;
  const pending = items.filter((r) => r.status === 'APPROVAL_REQUIRED');

  return (
    <div className="space-y-4">
      {writeMode && !writeMode.enabled && (
        <div className="rounded-control border border-border bg-sunken px-3 py-2">
          <div className="flex items-start gap-2">
            <Icon name="info" size={14} className="mt-0.5 shrink-0 text-muted" />
            <p className="text-[12px] leading-relaxed text-fg">
              {writeMode.note}
            </p>
          </div>
        </div>
      )}

      {overdue > 0 && (
        <div className="rounded-control border border-danger bg-surface px-3 py-2">
          <div className="flex items-start gap-2">
            <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-danger-fg" />
            <p className="text-[12px] leading-relaxed text-fg">
              {sessions.data.overdue_note}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Awaiting approval" value={pending.length} icon="clock"
          tone={pending.length ? 'text-warning-fg' : undefined}
        />
        <Tile label="Active sessions" value={live.filter((s) => s.status === 'ACTIVE').length}
          icon="key"
        />
        <Tile label="Overdue" value={overdue} icon="alert"
          tone={overdue ? 'text-danger-fg' : undefined}
          detail={overdue ? 'expired, not confirmed revoked' : 'none'}
        />
        <Tile label="Requests" value={items.length} icon="list" />
      </div>

      <CloudSection
        title="Access requests"
        description="Every request, who approved it, and what happened next."
        action={(
          <Button size="sm" variant="primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : 'Request access'}
          </Button>
        )}
      >
        {showForm && (
          <RequestForm
            accountId={accountId}
            onDone={() => setShowForm(false)}
          />
        )}

        {requests.isLoading && <InlineLoading label="Loading requests…" />}
        {!requests.isLoading && items.length === 0 && !showForm && (
          <p className="text-[12px] text-muted">No access requests yet.</p>
        )}

        <ul className="mt-2 space-y-1.5">
          {items.map((r) => (
            <RequestRow key={r.id} accountId={accountId} request={r} />
          ))}
        </ul>
      </CloudSection>

      {live.length > 0 && (
        <CloudSection
          title="Elevated sessions"
          description="Time-boxed grants that are live on the provider right now."
        >
          <ul className="space-y-1.5">
            {live.map((s) => (
              <SessionRow key={s.id} accountId={accountId} session={s} />
            ))}
          </ul>
        </CloudSection>
      )}
    </div>
  );
}

function RequestForm({ accountId, onDone }) {
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({
    request_kind: 'JIT_ELEVATION',
    identity_id: '',
    requested_role: '',
    target_scope: '',
    duration_minutes: 60,
    reason: '',
    ticket_ref: '',
  });
  const create = useCreateRequest(accountId);
  const candidates = useIdentityPrincipals(accountId, { q: search || undefined, page_size: 20 });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = () => {
    create.mutate({
      ...form,
      identity_id: form.identity_id || undefined,
      duration_minutes: Number(form.duration_minutes) || undefined,
      ticket_ref: form.ticket_ref || undefined,
    }, { onSuccess: onDone });
  };

  return (
    <div className="mb-3 rounded-control border border-accent px-3 py-2.5">
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-meta font-semibold text-muted">Identity</span>
          <input
            type="search" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="w-full rounded-control border border-border bg-surface px-2 py-1 text-[12px]"
          />
          <select
            value={form.identity_id}
            onChange={(e) => set('identity_id', e.target.value)}
            className="mt-1 w-full rounded-control border border-border bg-surface px-2 py-1 text-[12px]"
          >
            <option value="">Select…</option>
            {(candidates.data?.items || []).map((i) => (
              <option key={i.id} value={i.id}>{i.name || i.provider_id}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-meta font-semibold text-muted">
            Role to grant
          </span>
          <input
            value={form.requested_role}
            onChange={(e) => set('requested_role', e.target.value)}
            placeholder="Azure role name, AWS policy ARN, or OCI group OCID"
            className="w-full rounded-control border border-border bg-surface px-2 py-1 text-[12px]"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-meta font-semibold text-muted">Scope</span>
          <input
            value={form.target_scope}
            onChange={(e) => set('target_scope', e.target.value)}
            placeholder="/subscriptions/…/resourceGroups/prod"
            className="w-full rounded-control border border-border bg-surface px-2 py-1 text-[12px]"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-meta font-semibold text-muted">
            Duration (minutes, max 480)
          </span>
          <input
            type="number" min={1} max={480}
            value={form.duration_minutes}
            onChange={(e) => set('duration_minutes', e.target.value)}
            className="w-full rounded-control border border-border bg-surface px-2 py-1 text-[12px]"
          />
        </label>

        <label className="block lg:col-span-2">
          <span className="mb-1 block text-meta font-semibold text-muted">
            Reason
            <span className="ml-1 font-normal text-subtle">(required — it is kept)</span>
          </span>
          <textarea
            rows={2}
            value={form.reason}
            onChange={(e) => set('reason', e.target.value)}
            placeholder="Production incident INC-1234: need to restart the payments service."
            className="w-full rounded-control border border-border bg-surface px-2 py-1 text-[12px]"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-meta font-semibold text-muted">
            Ticket reference
          </span>
          <input
            value={form.ticket_ref}
            onChange={(e) => set('ticket_ref', e.target.value)}
            className="w-full rounded-control border border-border bg-surface px-2 py-1 text-[12px]"
          />
        </label>
      </div>

      {create.isError && (
        <p className="mt-2 text-[12px] text-danger-fg">
          {create.error?.response?.data?.detail || 'The request could not be raised.'}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <Button
          size="sm" variant="primary"
          disabled={!form.reason.trim()}
          loading={create.isPending}
          onClick={submit}
        >
          Raise request
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

function RequestRow({ accountId, request: r }) {
  const [open, setOpen] = useState(false);
  const approve = useApproveRequest(accountId);
  const reject = useRejectRequest(accountId);
  const apply = useApplyRequest(accountId);
  const risk = r.risk_snapshot || {};

  return (
    <li className="rounded-control border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[r.status] || 'neutral'} size="xs">{r.status}</Badge>
        <span className="min-w-0 flex-1 truncate-safe text-[12px] font-semibold text-fg">
          {r.identity_name || r.identity_key || 'No identity named'}
        </span>
        {r.requested_role && (
          <code className="truncate-safe text-meta text-muted">{r.requested_role}</code>
        )}
        {r.duration_minutes && (
          <span className="text-meta text-subtle">{`${r.duration_minutes} min`}</span>
        )}
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? 'Less' : 'Details'}
        </Button>
      </div>

      <p className="mt-0.5 text-meta text-muted">
        {`${r.request_kind.replace(/_/g, ' ').toLowerCase()} · requested by `}
        {r.requested_by || 'unknown'}
        {r.ticket_ref && ` · ${r.ticket_ref}`}
      </p>
      <p className="mt-0.5 text-[12px] text-fg">{r.reason}</p>

      {open && (
        <div className="mt-2 space-y-1.5 border-t border-border pt-2">
          <div className="flex flex-wrap items-center gap-2 text-meta">
            <span className="text-muted">Current privilege:</span>
            <PrivilegeBadge level={risk.current_privilege || r.current_privilege} />
            {risk.blast_radius?.score != null && (
              <>
                <span className="text-muted">Blast radius:</span>
                <span className="font-semibold tabular-nums">{risk.blast_radius.score}</span>
              </>
            )}
            {risk.high_impact_capabilities?.length > 0 && (
              <span className="text-warning-fg">
                {`${risk.high_impact_capabilities.length} high-impact capabilities`}
              </span>
            )}
          </div>
          {r.refusal_reason && (
            <p className="text-meta text-warning-fg">{r.refusal_reason}</p>
          )}
          {r.error && <p className="text-meta text-danger-fg">{r.error}</p>}
        </div>
      )}

      {r.status === 'APPROVAL_REQUIRED' && (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm" variant="primary" loading={approve.isPending}
            onClick={() => approve.mutate({ requestId: r.id })}
          >
            Approve
          </Button>
          <Button
            size="sm" variant="secondary" loading={reject.isPending}
            onClick={() => reject.mutate({ requestId: r.id })}
          >
            Reject
          </Button>
        </div>
      )}

      {r.status === 'APPROVED' && (
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm" variant="danger" loading={apply.isPending}
            onClick={() => apply.mutate({ requestId: r.id })}
          >
            Apply to provider
          </Button>
          <span className="text-meta text-subtle">
            Applying is deliberate and audited. Review the details first.
          </span>
        </div>
      )}
    </li>
  );
}

function SessionRow({ accountId, session: s }) {
  const revoke = useRevokeSession(accountId);
  const expires = s.expires_at ? new Date(s.expires_at) : null;
  const remaining = expires ? Math.round((expires.getTime() - Date.now()) / 60000) : null;

  return (
    <li className="rounded-control border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={s.overdue ? 'danger' : STATUS_TONE[s.status] || 'neutral'} size="xs">
          {s.overdue ? 'OVERDUE' : s.status}
        </Badge>
        <span className="min-w-0 flex-1 truncate-safe text-[12px] font-semibold text-fg">
          {s.granted_role || 'Elevation'}
        </span>
        {remaining !== null && (
          <span className="text-meta tabular-nums text-muted">
            {remaining > 0 ? `${remaining} min left` : `${Math.abs(remaining)} min overdue`}
          </span>
        )}
        <Button
          size="sm" variant="secondary" loading={revoke.isPending}
          onClick={() => revoke.mutate({ sessionId: s.id })}
        >
          Revoke now
        </Button>
      </div>
      {s.granted_scope && (
        <code className="mt-0.5 block break-all text-meta text-subtle">{s.granted_scope}</code>
      )}
      {s.revoke_error && (
        <p className="mt-0.5 text-meta text-danger-fg">{s.revoke_error}</p>
      )}
      {s.observed_event_count > 0 && (
        <p className="mt-0.5 text-meta text-muted">
          {`${s.observed_event_count} action(s) observed during this session.`}
        </p>
      )}
    </li>
  );
}
