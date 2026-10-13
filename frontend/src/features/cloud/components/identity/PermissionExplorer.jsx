import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import CloudSection from '../CloudSection';
import {
  DecisionBadge, ExternalBadge, LastUsed, MfaBadge, PrivilegeBadge,
} from './IdentityPrimitives';
import {
  useIdentityMeta, useIdentityPrincipals, usePermissionQuery, useWhoCanAccess,
} from '../../hooks/useIdentity';

/**
 * §4's permission explorer, in both directions.
 *
 * **Forward** — "can this identity do this?" — evaluates live and renders the
 * full decision chain: which statement matched, in which policy, at which
 * stage, and crucially which links of the provider's chain could NOT be
 * checked. A decision shown without its gaps is the thing this feature exists
 * to avoid, so `unevaluated` is rendered in the same block as the verdict
 * rather than behind a disclosure.
 *
 * **Reverse** — "who can do this?" — reads the materialised grants and matches
 * the concrete action against each stored pattern. The answer always carries
 * the coverage caveat: it is who we can SHOW has access, which is a lower
 * bound on who does.
 */
export default function PermissionExplorer({ accountId }) {
  const [mode, setMode] = useState('forward');
  return (
    <div className="space-y-4">
      <div className="flex gap-1">
        <Button
          size="sm"
          variant={mode === 'forward' ? 'primary' : 'secondary'}
          onClick={() => setMode('forward')}
        >
          Can this identity…?
        </Button>
        <Button
          size="sm"
          variant={mode === 'reverse' ? 'primary' : 'secondary'}
          onClick={() => setMode('reverse')}
        >
          Who can…?
        </Button>
      </div>
      {mode === 'forward'
        ? <ForwardQuery accountId={accountId} />
        : <ReverseQuery accountId={accountId} />}
    </div>
  );
}

function ForwardQuery({ accountId }) {
  const [identityId, setIdentityId] = useState('');
  const [action, setAction] = useState('');
  const [resource, setResource] = useState('');
  const [search, setSearch] = useState('');
  const run = usePermissionQuery(accountId);

  const candidates = useIdentityPrincipals(accountId, {
    q: search || undefined, page_size: 20,
  });
  const result = run.data;

  return (
    <CloudSection
      title="Can this identity do this?"
      description="Evaluated against the provider's own decision order, with every
        statement that participated — and every link that could not be checked."
    >
      <div className="grid gap-3 lg:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-meta font-semibold text-muted">Identity</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name"
            className="w-full rounded-control border border-border bg-surface px-2 py-1
              text-[12px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
          />
          <select
            value={identityId}
            onChange={(e) => setIdentityId(e.target.value)}
            className="mt-1 w-full rounded-control border border-border bg-surface px-2 py-1
              text-[12px]"
          >
            <option value="">Select an identity…</option>
            {(candidates.data?.items || []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.name || i.provider_id}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-meta font-semibold text-muted">Action</span>
          <input
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="s3:DeleteObject"
            className="w-full rounded-control border border-border bg-surface px-2 py-1
              text-[12px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
          />
          <span className="mt-0.5 block text-micro text-subtle">
            Provider-native. Azure:
            {' Microsoft.Storage/.../delete'}
            {'. OCI: manage:object-family'}
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-meta font-semibold text-muted">
            Resource
            <span className="ml-1 font-normal text-subtle">(optional)</span>
          </span>
          <input
            value={resource}
            onChange={(e) => setResource(e.target.value)}
            placeholder="arn:aws:s3:::production-data/*"
            className="w-full rounded-control border border-border bg-surface px-2 py-1
              text-[12px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
          />
        </label>
      </div>

      <div className="mt-3">
        <Button
          size="sm"
          variant="primary"
          disabled={!identityId || !action}
          loading={run.isPending}
          onClick={() => run.mutate({ identityId, action, resource: resource || undefined })}
        >
          Evaluate
        </Button>
      </div>

      {run.isError && (
        <p className="mt-3 text-[12px] text-danger-fg">
          {run.error?.response?.data?.detail || 'The query could not be run.'}
        </p>
      )}

      {result && (
        <div className="mt-3 rounded-control border border-border px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <DecisionBadge decision={result.decision} certain={result.certain} size="sm" />
            <code className="text-[12px] font-semibold text-fg">{result.question?.action}</code>
            {result.question?.resource && (
              <code className="break-all text-meta text-muted">
                {`on ${result.question.resource}`}
              </code>
            )}
            {result.conditional && (
              <Badge tone="outline" size="xs">Conditional</Badge>
            )}
          </div>

          {!result.evaluable && (
            <p className="mt-2 text-[12px] text-warning-fg">
              This identity&apos;s policies were not collected, so nothing here states
              what it can do.
            </p>
          )}

          {Array.isArray(result.steps) && result.steps.length > 0 && (
            <ol className="mt-2 space-y-1">
              {result.steps.map((s, i) => (
                <li
                  key={`${s.stage}-${i}`}
                  className="flex items-start gap-2 rounded-control border border-border
                    px-2 py-1.5"
                >
                  <Icon
                    name={s.effect === 'Deny' ? 'ban' : s.effect === 'Allow' ? 'check' : 'dot'}
                    size={13}
                    className={s.effect === 'Deny' ? 'mt-0.5 text-danger-fg'
                      : s.effect === 'Allow' ? 'mt-0.5 text-success-fg' : 'mt-0.5 text-muted'}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] text-fg">
                      <span className="font-semibold">{s.stage_label || s.stage}</span>
                      {` — ${s.effect}`}
                      {s.source_name && ` in ${s.source_name}`}
                    </p>
                    {s.matched_action && (
                      <p className="text-meta text-subtle">
                        {'matched '}
                        <code className="break-all">{s.matched_action}</code>
                        {s.matched_resource && (
                          <>
                            {' on '}
                            <code className="break-all">{s.matched_resource}</code>
                          </>
                        )}
                      </p>
                    )}
                    {s.inherited_from && (
                      <p className="text-meta text-subtle">{`inherited from ${s.inherited_from}`}</p>
                    )}
                    {s.note && <p className="text-meta text-muted">{s.note}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}

          {Array.isArray(result.unevaluated) && result.unevaluated.length > 0 && (
            <div className="mt-2 rounded-control border border-warning px-2 py-1.5">
              <p className="text-meta font-semibold text-fg">
                Not every link of the provider&apos;s decision chain could be checked:
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {result.unevaluated.map((u, i) => (
                  <li key={`${u.stage}-${i}`} className="text-meta text-muted">
                    <span className="font-semibold">{u.stage_label || u.stage}</span>
                    {u.detail && ` — ${u.detail}`}
                    {u.missing_permission && (
                      <>
                        {' Grant '}
                        <code className="rounded bg-neutral-soft px-1">
                          {u.missing_permission}
                        </code>
                        {' to close this gap.'}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.raw_withheld && (
            <p className="mt-2 text-meta text-subtle">
              The statement-level trace is withheld — it quotes provider policy and needs
              identity:view_raw.
            </p>
          )}
        </div>
      )}
    </CloudSection>
  );
}

function ReverseQuery({ accountId }) {
  const meta = useIdentityMeta();
  const [action, setAction] = useState('');
  const [resource, setResource] = useState('');
  const [capability, setCapability] = useState('');
  const run = useWhoCanAccess(accountId);
  const result = run.data;

  const capabilities = (meta.data?.capabilities || []).filter((c) => c.high_impact);

  return (
    <CloudSection
      title="Who can do this?"
      description="Matched against every evaluated grant in the account. The answer is
        who we can SHOW has access — a lower bound on who does."
    >
      <div className="grid gap-3 lg:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-meta font-semibold text-muted">Capability</span>
          <select
            value={capability}
            onChange={(e) => { setCapability(e.target.value); setAction(''); }}
            className="w-full rounded-control border border-border bg-surface px-2 py-1
              text-[12px]"
          >
            <option value="">Any — use an action instead</option>
            {capabilities.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-meta font-semibold text-muted">
            or Action
          </span>
          <input
            value={action}
            onChange={(e) => { setAction(e.target.value); setCapability(''); }}
            placeholder="s3:DeleteObject"
            className="w-full rounded-control border border-border bg-surface px-2 py-1
              text-[12px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-meta font-semibold text-muted">
            Resource
            <span className="ml-1 font-normal text-subtle">(optional)</span>
          </span>
          <input
            value={resource}
            onChange={(e) => setResource(e.target.value)}
            placeholder="arn:aws:s3:::production-data"
            className="w-full rounded-control border border-border bg-surface px-2 py-1
              text-[12px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
          />
        </label>
      </div>

      <div className="mt-3">
        <Button
          size="sm"
          variant="primary"
          disabled={!action && !capability}
          loading={run.isPending}
          onClick={() => run.mutate({
            action: action || undefined,
            resource: resource || undefined,
            capability: capability || undefined,
            limit: 100,
          })}
        >
          Find principals
        </Button>
      </div>

      {result && (
        <div className="mt-3">
          <p className="text-[12px] text-muted">
            {`${result.matched} principal${result.matched === 1 ? '' : 's'} found.`}
          </p>
          {result.coverage?.note && (
            <p className="mt-0.5 text-meta text-warning-fg">{result.coverage.note}</p>
          )}
          <ul className="mt-2 space-y-1">
            {(result.principals || []).map((p) => (
              <li
                key={`${p.identity_id}-${p.granted_by || ''}`}
                className="rounded-control border border-border px-2.5 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate-safe text-[12px] font-semibold text-fg">
                    {p.name || p.identity_id}
                  </span>
                  <PrivilegeBadge level={p.privilege_level} />
                  <MfaBadge state={p.mfa_state} />
                  <ExternalBadge state={p.external} />
                </div>
                <dl className="mt-0.5 text-meta text-subtle">
                  {p.granted_by && (
                    <div>
                      {'via '}
                      <code className="break-all text-muted">{p.granted_by}</code>
                      {p.source && ` in ${p.source}`}
                      {p.inherited && ' (inherited)'}
                    </div>
                  )}
                  {p.evidence_actions?.length > 0 && (
                    <div>
                      {'granted by '}
                      <code className="break-all text-muted">
                        {p.evidence_actions.slice(0, 3).join(', ')}
                      </code>
                    </div>
                  )}
                  <div>
                    {'last used: '}
                    <LastUsed at={p.last_used_at} />
                  </div>
                  {p.certain === false && (
                    <div className="text-warning-fg">
                      Part of the provider&apos;s decision chain was unreadable for this
                      grant.
                    </div>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        </div>
      )}
    </CloudSection>
  );
}
