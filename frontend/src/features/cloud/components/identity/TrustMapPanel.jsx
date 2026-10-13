import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import { InlineLoading } from '@/components/ui/Loading';
import CloudSection from '../CloudSection';
import { ExternalBadge, PrivilegeBadge, Tile } from './IdentityPrimitives';
import { useTrustMap } from '../../hooks/useIdentity';

/**
 * §13/§14: who outside this boundary can get in, and to what.
 *
 * Rendered as a list of edges rather than a force-directed graph. A trust map
 * is read to answer "is this one expected, and what does it lead to" — one
 * relationship at a time, with its conditions — and a node-and-link canvas
 * makes that harder, not easier, at the dozen-or-so edges a real account has.
 * The structure is still a graph underneath (the API returns nodes and links),
 * so a canvas can be added without changing the data.
 *
 * External is reported as a FACT with its risk factors stated separately. §14
 * is explicit that an external principal must not be classified as malicious
 * on sight, and most are legitimate — a monitoring vendor, a CI provider, a
 * partner tenant. What is flagged is the configuration: no ExternalId, no MFA
 * condition, a privileged target, a wildcard principal.
 */
export default function TrustMapPanel({ accountId, onOpen }) {
  const [externalOnly, setExternalOnly] = useState(true);
  const q = useTrustMap(accountId, externalOnly);
  const data = q.data || {};
  const summary = data.summary || {};
  const edges = data.edges || [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Trust edges" value={summary.total ?? 0} icon="link" />
        <Tile
          label="External" value={summary.external ?? 0} icon="globe"
          tone="text-warning-fg" detail={`${summary.external_account_count ?? 0} accounts`}
        />
        <Tile
          label="Any principal" value={summary.anonymous ?? 0} icon="alert"
          tone="text-danger-fg" detail="public, not cross-account"
        />
        <Tile
          label="Privileged target" value={summary.privileged_external ?? 0}
          icon="shield" tone="text-danger-fg"
        />
        <Tile
          label="No ExternalId" value={summary.without_external_id ?? 0}
          icon="help" tone="text-warning-fg" detail="confused-deputy shape"
        />
      </div>

      <CloudSection
        title="Trust relationships"
        description="Built from actual provider configuration — AWS role trust policies,
          Azure foreign principals and guests, OCI federation and cross-tenancy policy."
        action={(
          <Button
            size="sm"
            variant={externalOnly ? 'primary' : 'secondary'}
            onClick={() => setExternalOnly((v) => !v)}
          >
            {externalOnly ? 'External only' : 'All relationships'}
          </Button>
        )}
      >
        {q.isLoading && <InlineLoading label="Loading trust map…" />}
        {!q.isLoading && edges.length === 0 && (
          <p className="text-[12px] text-muted">
            No trust relationships were found.
            <span className="mt-0.5 block text-meta text-subtle">
              If the identity analysis has not run, this is not a statement that none
              exist.
            </span>
          </p>
        )}

        <ul className="space-y-1.5">
          {edges.map((e) => (
            <li
              key={`${e.target_key}-${e.source_principal}-${e.trust_kind}`}
              className="rounded-control border border-border px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 break-all text-[12px] text-fg">
                  {e.source_principal}
                </code>
                <Icon name="arrow-right" size={13} className="shrink-0 text-muted" />
                {e.target_identity_id && typeof onOpen === 'function' ? (
                  <button
                    type="button"
                    onClick={() => onOpen(e.target_identity_id)}
                    className="min-w-0 truncate-safe text-[12px] font-semibold
                      text-accent-text hover:underline"
                  >
                    {e.target_name || e.target_key}
                  </button>
                ) : (
                  <span className="min-w-0 truncate-safe text-[12px] font-semibold text-fg">
                    {e.target_name || e.target_key}
                  </span>
                )}
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <ExternalBadge state={e.external} />
                <Badge tone="outline" size="xs">
                  {e.trust_kind_label || e.trust_kind}
                </Badge>
                {e.target_privilege && <PrivilegeBadge level={e.target_privilege} />}
                {e.source_account && (
                  <span className="text-meta text-subtle">
                    {`account ${e.source_account}`}
                  </span>
                )}
                {e.has_external_id === true && (
                  <Badge tone="success" size="xs" title="An ExternalId is required.">
                    ExternalId
                  </Badge>
                )}
                {e.has_mfa_condition === true && (
                  <Badge tone="success" size="xs">MFA required</Badge>
                )}
              </div>

              {Array.isArray(e.risk_factors) && e.risk_factors.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {e.risk_factors.map((f) => (
                    <li key={f.factor} className="flex items-start gap-1.5 text-meta">
                      <Icon
                        name="info" size={11}
                        className="mt-0.5 shrink-0 text-warning-fg"
                      />
                      <span className="text-muted">{f.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </CloudSection>
    </div>
  );
}
