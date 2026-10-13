import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import Tabs from '@/components/ui/Tabs';
import { InlineLoading } from '@/components/ui/Loading';
import {
  DecisionBadge, ExternalBadge, LastUsed, MfaBadge, PrivilegeBadge, ProviderBadge,
  UsageBadge, WindowNote,
} from './IdentityPrimitives';
import {
  useIdentityBlastRadius, useIdentityEvents, useIdentityPermissions,
  useIdentityPrincipal, useIdentityRecommendations, useIdentityTrust, useIdentityUsage,
  useProposeRightsizing,
} from '../../hooks/useIdentity';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'usage', label: 'Usage' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'blast', label: 'Blast radius' },
  { id: 'trust', label: 'Trust' },
  { id: 'events', label: 'Events' },
  { id: 'recommendations', label: 'Recommendations' },
];

/**
 * The §41 identity detail experience.
 *
 * Every tab here answers one of the acceptance questions, and each is built so
 * that an absent answer reads as absent. The Permissions tab shows the
 * decision AND whether every link of the provider's chain was checked; the
 * Usage tab never shows a count without its window; the Blast radius tab shows
 * "withheld" rather than a small number when the inventory was incomplete.
 */
export default function IdentityDetailDrawer({ accountId, identityId, onClose }) {
  const [tab, setTab] = useState('overview');
  const detail = useIdentityPrincipal(identityId);
  const data = detail.data;
  const identity = data?.identity;

  return (
    <Drawer
      open
      onClose={onClose}
      width={720}
      icon="id-card"
      title={identity?.name || identity?.principal_name || 'Identity'}
      subtitle={identity
        ? `${(identity.identity_type || '').replace(/_/g, ' ').toLowerCase()} · `
          + `${identity.provider}`
        : undefined}
    >
      {detail.isLoading && <InlineLoading label="Loading identity…" />}
      {!detail.isLoading && !identity && (
        <p className="text-[12px] text-muted">This identity could not be loaded.</p>
      )}

      {identity && (
        <div className="space-y-3">
          <Header identity={identity} assessed={data.assessed} />
          <Tabs tabs={TABS} value={tab} onChange={setTab} />

          {tab === 'overview' && <OverviewTab data={data} />}
          {tab === 'permissions' && <PermissionsTab identityId={identityId} />}
          {tab === 'usage' && <UsageTab identityId={identityId} />}
          {tab === 'credentials' && <CredentialsTab credentials={data.credentials} />}
          {tab === 'blast' && <BlastTab identityId={identityId} />}
          {tab === 'trust' && <TrustTab identityId={identityId} />}
          {tab === 'events' && <EventsTab identityId={identityId} />}
          {tab === 'recommendations' && (
            <RecommendationsTab accountId={accountId} identityId={identityId} />
          )}
        </div>
      )}
    </Drawer>
  );
}

function Header({ identity, assessed }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-control border border-border
      bg-sunken px-3 py-2"
    >
      <ProviderBadge provider={identity.provider} />
      <PrivilegeBadge level={identity.privilege_level} />
      <MfaBadge state={identity.mfa_state} />
      <ExternalBadge state={identity.external} />
      {identity.standing_admin && (
        <Badge tone="danger" size="xs">Standing admin</Badge>
      )}
      {identity.potential_break_glass && (
        <Badge
          tone="warning" size="xs"
          title="Its shape matches an emergency-access account. This platform cannot
            confirm it is designated as one."
        >
          Potential break-glass
        </Badge>
      )}
      {!assessed && (
        <Badge
          tone="outline" size="xs"
          title="This identity's policies could not be read, so nothing below states
            what it can do."
        >
          Not assessed
        </Badge>
      )}
      <span className="ml-auto text-meta text-muted">
        Last used:
        {' '}
        <LastUsed at={identity.last_used_at} source={identity.last_used_source} />
      </span>
    </div>
  );
}

function Rows({ rows }) {
  return (
    <dl className="divide-y divide-border overflow-hidden rounded-control border border-border">
      {rows.filter(Boolean).map(([label, value, hint]) => (
        <div key={label} className="flex gap-3 px-2.5 py-1.5">
          <dt className="w-44 shrink-0 text-meta text-muted">{label}</dt>
          <dd className="min-w-0 flex-1 break-words text-[12px] text-fg">
            {value === null || value === undefined || value === ''
              ? <span className="text-subtle">Not reported</span>
              : value}
            {hint && <span className="mt-0.5 block text-meta text-subtle">{hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function OverviewTab({ data }) {
  const i = data.identity;
  return (
    <div className="space-y-3">
      <Rows rows={[
        ['Provider id', <code className="break-all text-[11px]">{i.provider_id}</code>],
        ['Principal name', i.principal_name],
        ['Type', (i.identity_type || '').replace(/_/g, ' ').toLowerCase()],
        ['Classified as', (i.actor_class || '').toLowerCase(),
          i.actor_class === 'WORKLOAD'
            ? 'A workload has no interactive sign-in, so MFA does not apply to it.'
            : null],
        ['Status', i.status],
        ['Created', i.created_at_provider ? String(i.created_at_provider).slice(0, 10) : null],
        ['Scope', i.scope],
        ['Groups / roles', `${i.group_count ?? 0}`],
        ['Policies attached', `${i.policy_count ?? 0}`],
        ['Credentials', `${i.active_credential_count ?? 0} active of ${i.credential_count ?? 0}`],
      ]}
      />

      {data.capabilities?.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-meta font-bold tracking-wider text-muted uppercase">
            High-impact capabilities
          </h4>
          {data.high_impact?.length === 0 ? (
            <p className="text-[12px] text-muted">
              None of the dangerous capabilities are held.
            </p>
          ) : (
            <ul className="space-y-1">
              {data.high_impact.map((c) => (
                <li
                  key={c.capability}
                  className="rounded-control border border-border px-2.5 py-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold text-fg">
                      {c.capability.replace(/_/g, ' ').toLowerCase()}
                    </span>
                    <span className="shrink-0 text-meta text-muted">
                      {c.scope_level || 'scope unknown'}
                    </span>
                  </div>
                  {c.evidence_actions?.length > 0 && (
                    <p className="mt-0.5 text-meta text-subtle">
                      {'Granted by '}
                      <code className="break-all">{c.evidence_actions.slice(0, 4).join(', ')}</code>
                    </p>
                  )}
                  {!c.certain && (
                    <p className="mt-0.5 text-meta text-warning-fg">
                      Derived while part of the provider&apos;s decision chain was
                      unreadable.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {data.groups?.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-meta font-bold tracking-wider text-muted uppercase">
            Inherits from
          </h4>
          <ul className="space-y-1">
            {data.groups.map((g) => (
              <li key={g.container.id} className="flex items-center gap-2 text-[12px]">
                <Icon name="users" size={12} className="text-muted" />
                <span className="truncate-safe">{g.container.name}</span>
                <PrivilegeBadge level={g.container.privilege_level} />
                {g.match_rule && (
                  <span className="truncate-safe text-meta text-subtle" title={g.match_rule}>
                    {g.match_rule}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function PermissionsTab({ identityId }) {
  const [decision, setDecision] = useState('');
  const q = useIdentityPermissions(identityId, {
    decision: decision || undefined,
    page_size: 50,
  });
  const data = q.data || {};

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
          className="rounded-control border border-border bg-surface px-2 py-1 text-[12px]"
        >
          <option value="">All decisions</option>
          <option value="ALLOWED">Allowed</option>
          <option value="ALLOWED_UNVERIFIED">Allowed (unverified)</option>
          <option value="DENIED">Denied</option>
          <option value="IMPLICIT_DENY">Implicit deny</option>
          <option value="NOT_DETERMINED">Could not determine</option>
        </select>
        <span className="text-meta text-muted">
          {`${data.total ?? 0} evaluated grants`}
        </span>
      </div>

      {data.verification_note && (
        <p className="rounded-control border border-warning bg-surface px-2.5 py-1.5
          text-meta text-fg"
        >
          {data.verification_note}
        </p>
      )}
      {data.raw_withheld && (
        <p className="text-meta text-subtle">{data.raw_withheld_note}</p>
      )}

      {q.isLoading && <InlineLoading label="Evaluating…" />}
      {!q.isLoading && (data.items || []).length === 0 && (
        <p className="text-[12px] text-muted">
          No evaluated permissions. Either the analysis has not run, or this
          identity&apos;s policies could not be read.
        </p>
      )}

      <ul className="space-y-1">
        {(data.items || []).map((p) => (
          <li key={p.id} className="rounded-control border border-border px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 break-all text-[12px] font-semibold text-fg">
                {p.action_pattern}
              </code>
              <DecisionBadge decision={p.decision} certain={p.certain} />
              {p.conditional && (
                <Badge
                  tone="outline" size="xs"
                  title="The grant carries provider conditions this platform does not
                    evaluate, so the access may not hold at runtime."
                >
                  Conditional
                </Badge>
              )}
            </div>
            <dl className="mt-1 space-y-0.5 text-meta text-subtle">
              {p.resource_pattern && (
                <div>
                  {'on '}
                  <code className="break-all text-muted">{p.resource_pattern}</code>
                </div>
              )}
              {p.source_name && (
                <div>
                  {'from '}
                  <span className="text-muted">{p.source_name}</span>
                  {p.inherited && p.inherited_from && ` (inherited from ${p.inherited_from})`}
                </div>
              )}
              {p.capability && (
                <div>{p.capability.replace(/_/g, ' ').toLowerCase()}</div>
              )}
            </dl>
            {Array.isArray(p.unevaluated) && p.unevaluated.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {p.unevaluated.map((u, idx) => (
                  <li key={`${u.stage}-${idx}`} className="text-meta text-warning-fg">
                    <Icon name="info" size={11} className="mr-1 inline" />
                    {`${u.stage_label || u.stage} not evaluated`}
                    {u.missing_permission && ` — grant ${u.missing_permission}`}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function UsageTab({ identityId }) {
  const q = useIdentityUsage(identityId);
  const data = q.data || {};
  if (q.isLoading) return <InlineLoading label="Loading usage…" />;
  if (!data.window) {
    return (
      <div className="text-[12px] text-muted">
        <p>{data.note || 'No permission-usage analysis exists for this identity.'}</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <WindowNote window={data.window} />
      <div className="grid grid-cols-4 gap-2">
        {[
          ['Observed', data.observed_count, 'text-success-fg'],
          ['Not observed', data.not_observed_high, 'text-warning-fg'],
          ['Low confidence', data.not_observed_low, 'text-muted'],
          ['No data', data.unknown, 'text-muted'],
        ].map(([label, value, tone]) => (
          <div key={label} className="rounded-control border border-border px-2 py-1.5">
            <div className="text-micro uppercase tracking-wider text-muted">{label}</div>
            <div className={`text-[15px] font-bold tabular-nums ${tone}`}>{value ?? 0}</div>
          </div>
        ))}
      </div>
      <p className="text-meta text-subtle">{data.note}</p>
      <ul className="space-y-1">
        {(data.items || []).slice(0, 100).map((u) => (
          <li
            key={u.id}
            className="flex flex-wrap items-center gap-2 rounded-control border
              border-border px-2.5 py-1.5"
          >
            <code className="min-w-0 flex-1 break-all text-[12px]">{u.action}</code>
            <UsageBadge state={u.usage_state} reason={u.confidence_reason} />
            {u.event_count > 0 && (
              <span className="shrink-0 text-meta tabular-nums text-muted">
                {`${u.event_count} events`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CredentialsTab({ credentials }) {
  if (!credentials?.length) {
    return <p className="text-[12px] text-muted">This identity holds no credentials.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {credentials.map((c) => (
        <li key={c.id} className="rounded-control border border-border px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all text-[12px] font-semibold">
              {c.credential_ref}
            </code>
            <Badge tone={c.status === 'ACTIVE' ? 'success' : 'neutral'} size="xs">
              {c.status}
            </Badge>
            {c.recommendation && c.recommendation !== 'NONE' && (
              <Badge
                tone={c.recommendation === 'DELETE' ? 'danger' : 'warning'}
                size="xs"
              >
                {c.recommendation}
              </Badge>
            )}
          </div>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 text-meta text-subtle">
            <div>
              {'Kind: '}
              {c.credential_kind.replace(/_/g, ' ').toLowerCase()}
            </div>
            <div>
              {'Created: '}
              {c.created_at_provider ? String(c.created_at_provider).slice(0, 10)
                : 'not reported'}
            </div>
            <div>
              {'Last used: '}
              {c.never_used === true ? 'never (provider-reported)'
                : c.last_used_at ? String(c.last_used_at).slice(0, 10)
                  : 'not reported'}
            </div>
            {c.expires_at && (
              <div>
                {'Expires: '}
                {String(c.expires_at).slice(0, 10)}
              </div>
            )}
          </dl>
          {c.recommendation_reason && (
            <p className="mt-1 text-meta text-muted">{c.recommendation_reason}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function BlastTab({ identityId }) {
  const q = useIdentityBlastRadius(identityId);
  const data = q.data || {};
  if (q.isLoading) return <InlineLoading label="Loading blast radius…" />;
  if (data.available === false) {
    return <p className="text-[12px] text-muted">{data.reason}</p>;
  }
  const caps = data.capabilities || {};
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3">
        <span className="text-[28px] font-bold tabular-nums text-fg">
          {data.score ?? '—'}
        </span>
        <span className="text-[12px] text-muted">
          {data.score_band || 'Score withheld'}
        </span>
      </div>
      {data.coverage_note && (
        <p className="rounded-control border border-warning bg-surface px-2.5 py-1.5
          text-meta text-fg"
        >
          {data.coverage_note}
        </p>
      )}
      <div className="grid grid-cols-3 gap-2">
        {[
          ['Direct', data.direct_resources],
          ['Indirect', data.indirect_resources],
          ['Sensitive', data.sensitive_resources],
          ['Accounts', data.accounts_reachable],
          ['Regions', data.regions_reachable],
          ['Assumable roles', data.privileged_roles_assumable],
        ].map(([label, value]) => (
          <div key={label} className="rounded-control border border-border px-2 py-1.5">
            <div className="text-micro uppercase tracking-wider text-muted">{label}</div>
            <div className="text-[15px] font-bold tabular-nums">{value ?? 0}</div>
          </div>
        ))}
      </div>
      <ul className="space-y-1">
        {Object.entries({
          'Modify IAM': caps.modify_iam,
          'Create credentials': caps.create_credentials,
          'Modify logging': caps.modify_logging,
          'Manage keys': caps.manage_keys,
          'Delete data': caps.delete_data,
          'Modify network': caps.modify_network,
        }).map(([label, on]) => (
          <li key={label} className="flex items-center gap-2 text-[12px]">
            <Icon
              name={on ? 'alert' : 'check'}
              size={12}
              className={on ? 'text-danger-fg' : 'text-success-fg'}
            />
            <span className={on ? 'text-fg' : 'text-muted'}>{label}</span>
            <span className="ml-auto text-meta text-muted">{on ? 'YES' : 'no'}</span>
          </li>
        ))}
      </ul>
      {data.explanation?.length > 0 && (
        <ul className="space-y-1">
          {data.explanation.map((e) => (
            <li key={e.claim} className="rounded-control border border-border px-2.5 py-1.5">
              <p className="text-[12px] font-semibold text-fg">{e.claim}</p>
              <p className="text-meta text-subtle">{e.why}</p>
            </li>
          ))}
        </ul>
      )}
      {data.topology_note && (
        <p className="text-meta text-subtle">{data.topology_note}</p>
      )}
    </div>
  );
}

function TrustTab({ identityId }) {
  const q = useIdentityTrust(identityId);
  const rows = q.data || [];
  if (q.isLoading) return <InlineLoading label="Loading trust…" />;
  if (!rows.length) {
    return (
      <p className="text-[12px] text-muted">
        No trust relationship points at this identity.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {rows.map((t) => (
        <li key={t.id} className="rounded-control border border-border px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all text-[12px]">
              {t.source_principal}
            </code>
            <ExternalBadge state={t.external} />
            <Badge tone="outline" size="xs">{t.trust_kind_label || t.trust_kind}</Badge>
          </div>
          {Array.isArray(t.risk_factors) && t.risk_factors.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {t.risk_factors.map((f) => (
                <li key={f.factor} className="text-meta text-warning-fg">
                  {f.detail}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function EventsTab({ identityId }) {
  const q = useIdentityEvents(identityId);
  const rows = q.data || [];
  if (q.isLoading) return <InlineLoading label="Loading events…" />;
  if (!rows.length) {
    return (
      <p className="text-[12px] text-muted">
        No events in the Event Log are attributed to this identity. That is not
        evidence it is unused — the audit trail may not cover it.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {rows.map((e) => (
        <li key={e.id} className="flex flex-wrap items-center gap-2 py-1.5">
          <span className="w-28 shrink-0 text-meta tabular-nums text-muted">
            {String(e.timestamp).slice(0, 16).replace('T', ' ')}
          </span>
          <span className="min-w-0 flex-1 truncate-safe text-[12px]">{e.event_name}</span>
          <Badge tone={e.status === 'SUCCESS' ? 'neutral' : 'danger'} size="xs">
            {e.status}
          </Badge>
          {e.region && <span className="text-meta text-subtle">{e.region}</span>}
        </li>
      ))}
    </ul>
  );
}

function RecommendationsTab({ accountId, identityId }) {
  const q = useIdentityRecommendations(identityId);
  const propose = useProposeRightsizing(accountId);
  const [proposal, setProposal] = useState(null);
  const data = q.data || {};

  if (q.isLoading) return <InlineLoading label="Loading recommendations…" />;

  return (
    <div className="space-y-2">
      {data.write_mode && !data.write_mode.enabled && (
        <p className="rounded-control border border-border bg-sunken px-2.5 py-1.5
          text-meta text-muted"
        >
          {data.write_mode.note}
        </p>
      )}
      {(data.recommendations || []).length === 0 && (
        <p className="text-[12px] text-muted">
          No recommendations for this identity.
        </p>
      )}
      <ul className="space-y-1.5">
        {(data.recommendations || []).map((r) => (
          <li key={r.id} className="rounded-control border border-border px-2.5 py-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12px] font-semibold text-fg">{r.title}</p>
              {r.action?.kind === 'PERMISSION_RIGHTSIZE' && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={propose.isPending}
                  onClick={() => propose.mutate({ identityId }, {
                    onSuccess: setProposal,
                  })}
                >
                  Generate proposal
                </Button>
              )}
            </div>
            <dl className="mt-1 space-y-0.5 text-meta">
              <div><span className="text-muted">Why: </span>{r.why}</div>
              <div><span className="text-muted">Current: </span>{r.current_state}</div>
              <div><span className="text-muted">Proposed: </span>{r.proposed_state}</div>
              <div><span className="text-muted">Effect: </span>{r.expected_effect}</div>
              <div className="text-warning-fg">
                <span className="text-muted">Risks: </span>
                {r.risks}
              </div>
            </dl>
          </li>
        ))}
      </ul>

      {proposal && <ProposalDiff proposal={proposal} onClose={() => setProposal(null)} />}
    </div>
  );
}

/** §6's diff: every grant, with KEEP / REMOVE / NARROW / RETAIN and why. */
function ProposalDiff({ proposal, onClose }) {
  if (proposal.available === false) {
    return (
      <div className="rounded-control border border-border px-2.5 py-2">
        <p className="text-[12px] text-muted">{proposal.reason}</p>
      </div>
    );
  }
  const TONE = {
    KEEP: 'text-success-fg',
    REMOVE: 'text-danger-fg',
    NARROW: 'text-warning-fg',
    RETAIN_INSUFFICIENT_EVIDENCE: 'text-muted',
  };
  return (
    <div className="rounded-control border border-accent bg-surface px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-semibold text-fg">
          Proposed least-privilege policy
          <Badge tone="warning" size="xs" className="ml-2">PROPOSED — NOT APPLIED</Badge>
        </p>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      <p className="mt-1 text-meta text-subtle">
        {`${proposal.summary?.keep ?? 0} keep · ${proposal.summary?.remove ?? 0} remove `
          + `· ${proposal.summary?.narrow ?? 0} narrow `
          + `· ${proposal.summary?.retain_insufficient ?? 0} retained (insufficient evidence)`}
      </p>
      <WindowNote window={proposal.evidence?.window} className="mt-1" />

      <ul className="mt-2 max-h-64 space-y-0.5 overflow-auto">
        {(proposal.diff || []).map((d) => (
          <li key={d.pattern} className="flex items-start gap-2 text-meta">
            <span className={`w-16 shrink-0 font-bold ${TONE[d.verdict] || 'text-muted'}`}>
              {d.verdict === 'RETAIN_INSUFFICIENT_EVIDENCE' ? 'RETAIN' : d.verdict}
            </span>
            <span className="min-w-0 flex-1">
              <code className="break-all text-fg">{d.pattern}</code>
              {d.reason && <span className="block text-subtle">{d.reason}</span>}
            </span>
          </li>
        ))}
      </ul>

      {proposal.caveats?.length > 0 && (
        <ul className="mt-2 space-y-0.5 border-t border-border pt-2">
          {proposal.caveats.map((c) => (
            <li key={c} className="text-meta text-warning-fg">{c}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
