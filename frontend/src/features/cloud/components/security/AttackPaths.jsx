import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import CloudSection from '../CloudSection';
import { Stat } from './SecurityPanels';
import { useAttackPaths } from '../../hooks/useSecurityCenter';
import { formatCount, severityTone } from '../../utils/securityModel';

/**
 * Attack paths — routes from a confirmed internet entry point to something
 * worth reaching.
 *
 * Two decisions in here are about honesty rather than layout, and both exist
 * because the first live run was misleading without them.
 *
 * **Paths are grouped by class, strongest first.** On the live OCI account 12
 * of 67 paths are an exposed VM reaching its own boot volume — true, but it is
 * what compromising that VM already means, not a second move. Listed flat and
 * sorted by score those crowd out the routes that cross an identity. Grouping
 * puts the question "what can an attacker reach that isn't already lost?"
 * above the arithmetic.
 *
 * **What could not be looked for is stated as loudly as what was found.** An
 * account whose graph holds no `role` or `permission` edges cannot produce an
 * identity pivot, and on live data neither OCI nor Azure has any. Rendering
 * "no identity paths" without that context would be read as "no identity risk",
 * which is the inverse of the truth. The coverage callouts below say which
 * question the engine was unable to ask.
 */

/**
 * Groups are ordered by their own worst path, not by a preference written here.
 *
 * The first version ranked the classes by hand — identity pivots, then direct
 * routes, then network lateral, then entry storage — on the theory that a
 * pivot is the more interesting finding. On live OCI that put 55 LOW-confidence
 * 60-point paths above 11 HIGH-confidence 87-point ones, which is the opposite
 * of triage: the operator's first screen was the part of the list the engine
 * is least sure about. Severity is the only defensible order, so the class a
 * path belongs to groups it and nothing more.
 */
const groupRank = (rows) => Math.max(...rows.map((p) => p.risk?.points ?? 0));

/** How many rows a group shows before asking. Groups here run to dozens. */
const COLLAPSE_AT = 8;

const CLASS_ICON = {
  IDENTITY_PIVOT: 'key',
  DIRECT_ROUTE: 'route',
  NETWORK_LATERAL: 'network',
  ENTRY_STORAGE: 'database',
};

const CONFIDENCE_TONE = { HIGH: 'success', MEDIUM: 'warning', LOW: 'danger' };

const STAGE_ICON = {
  ENTRY_POINT: 'globe',
  INITIAL_ACCESS: 'route',
  PRIVILEGE_ESCALATION: 'key',
  LATERAL_MOVEMENT: 'network',
  DATA_ACCESS: 'database',
  IMPACT: 'alert',
};

const nodeIcon = (category) => ({
  Storage: 'database', Database: 'database', Identity: 'key',
  Compute: 'server', Network: 'network', Security: 'shield',
}[category] || 'box');

/** A signed point contribution, rendered so the sign is unmissable. */
function Delta({ points }) {
  const positive = points > 0;
  return (
    <span className={`font-mono text-micro tabular-nums ${positive ? 'text-danger-fg' : 'text-success-fg'}`}>
      {positive ? '+' : ''}{points}
    </span>
  );
}

/** The chain, as the thing an operator reads first. */
function Chain({ path, onNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="inline-flex items-center gap-1 rounded-control border border-danger-soft bg-danger-soft px-1.5 py-0.5 text-micro font-semibold text-danger-fg">
        <Icon name="globe" size={11} />
        Internet
      </span>
      {path.nodes.map((n, i) => (
        <span key={n.id || i} className="inline-flex items-center gap-1">
          <Icon name="chevron-right" size={11} className="text-subtle" />
          <button
            type="button"
            onClick={() => onNode(n)}
            title={`${n.type || 'Resource'} — open resource`}
            className="inline-flex max-w-[16rem] items-center gap-1 truncate rounded-control border border-border bg-surface px-1.5 py-0.5 text-micro text-fg transition-colors hover:border-accent hover:text-accent"
          >
            <Icon name={nodeIcon(n.category)} size={11} className="shrink-0" />
            <span className="truncate">{n.name || n.id}</span>
          </button>
        </span>
      ))}
    </div>
  );
}

/** Stage-by-stage, with the edge evidence that justifies each move. */
function Hops({ hops, nodes }) {
  const nameOf = (id) => nodes.find((n) => n.id === id)?.name || id;
  return (
    <ol className="space-y-2">
      {hops.map((h) => (
        <li key={`${h.index}-${h.edge_id}`} className="rounded-control border border-border bg-surface p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-control bg-accent-soft px-1.5 py-0.5 text-micro font-semibold text-accent-text">
              <Icon name={STAGE_ICON[h.stage] || 'route'} size={11} />
              {h.stage_label}
            </span>
            <span className="text-meta text-fg">
              {nameOf(h.from_node_id)}
              <Icon name="arrow-right" size={11} className="mx-1 inline text-subtle" />
              {nameOf(h.to_node_id)}
            </span>
            <Badge tone="outline" size="xs">{h.edge_kind}</Badge>
            {!h.observed && (
              <Badge tone="warning" size="xs" title="Not an observed flow">Unconfirmed</Badge>
            )}
          </div>

          <p className="mt-1.5 text-micro leading-relaxed text-subtle">{h.reason}</p>

          {/* Why this edge exists, in the provider's own terms. This is the
              answer to "says who?" and is the whole point of showing a path
              rather than a score. */}
          {h.evidence && (h.evidence.note || h.evidence.field || h.evidence.value) && (
            <dl className="mt-1.5 space-y-0.5 border-l-2 border-border pl-2">
              {h.evidence.note && (
                <div className="text-micro text-fg">{h.evidence.note}</div>
              )}
              {h.evidence.field && (
                <div className="flex gap-1.5 text-micro">
                  <dt className="text-subtle">Field</dt>
                  <dd className="font-mono text-fg">{h.evidence.field}</dd>
                </div>
              )}
              {h.evidence.value && (
                <div className="flex gap-1.5 text-micro">
                  <dt className="shrink-0 text-subtle">Value</dt>
                  <dd className="truncate font-mono text-subtle" title={String(h.evidence.value)}>
                    {String(h.evidence.value)}
                  </dd>
                </div>
              )}
              {h.evidence._withheld && (
                <div className="text-micro italic text-warning-fg">{h.evidence._withheld}</div>
              )}
            </dl>
          )}
        </li>
      ))}
    </ol>
  );
}

/** The score, shown as the sum it actually is. */
function RiskBreakdown({ risk }) {
  return (
    <div className="rounded-control border border-border bg-raised p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-micro font-semibold uppercase tracking-wide text-subtle">
          How this score was reached
        </span>
        <span className="font-mono text-meta tabular-nums text-fg">{risk.points} pts</span>
      </div>
      <ul className="space-y-1.5">
        {risk.components.map((c) => (
          <li key={c.component_id}>
            <div className="flex items-start justify-between gap-2">
              <span className="text-micro font-medium text-fg">{c.label}</span>
              <Delta points={c.points} />
            </div>
            <p className="mt-0.5 text-micro leading-relaxed text-subtle">{c.explanation}</p>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center justify-between border-t border-border pt-1.5">
        <span className="text-micro text-subtle">
          Band thresholds:{' '}
          {risk.thresholds.map((t) => `${t.band} ≥ ${t.min_points}`).join(' · ')}
        </span>
      </div>
    </div>
  );
}

function PathRow({ path, onNode }) {
  const [open, setOpen] = useState(false);
  const band = path.risk?.band;
  return (
    <div className="rounded-control border border-border bg-raised">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2.5 p-3 text-left"
      >
        <Icon
          name={open ? 'chevron-down' : 'chevron-right'}
          size={14}
          className="mt-0.5 shrink-0 text-subtle"
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={severityTone(band)}>{band}</Badge>
            <span className="font-mono text-meta tabular-nums text-subtle">
              {path.risk?.points} pts
            </span>
            <Badge tone={CONFIDENCE_TONE[path.confidence] || 'neutral'} size="xs">
              {path.confidence} confidence
            </Badge>
            <span className="text-meta text-subtle">
              {path.length} hop{path.length === 1 ? '' : 's'}
            </span>
          </div>
          <Chain path={path} onNode={onNode} />
        </div>
      </button>

      {open && (
        <div className="space-y-3 border-t border-border p-3">
          {path.confidence !== 'HIGH' && (
            <div className="flex items-start gap-2 rounded-control border border-warning-soft bg-warning-soft p-2.5 text-micro text-warning-fg">
              <Icon name="help" size={13} className="mt-0.5 shrink-0" />
              <span className="leading-relaxed">{path.confidence_reason}</span>
            </div>
          )}
          <div>
            <h4 className="mb-1.5 text-micro font-semibold uppercase tracking-wide text-subtle">
              Path
            </h4>
            <Hops hops={path.hops} nodes={path.nodes} />
          </div>
          {path.risk && <RiskBreakdown risk={path.risk} />}
        </div>
      )}
    </div>
  );
}

/**
 * One class of path. Collapsed past COLLAPSE_AT rows — a flat subnet produces
 * dozens of structurally identical routes, and an operator who has read eight
 * of them has read the finding. Nothing is dropped; the rest are one click away
 * and the count is always shown.
 */
function PathGroup({ cls, rows, label, meaning, onNode }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, COLLAPSE_AT);
  const hidden = rows.length - shown.length;
  return (
    <CloudSection
      title={(
        <span className="flex items-center gap-1.5">
          <Icon name={CLASS_ICON[cls] || 'route'} size={15} className="text-subtle" />
          {label} ({rows.length})
        </span>
      )}
      description={meaning}
    >
      <div className="space-y-2">
        {shown.map((p) => <PathRow key={p.path_id} path={p} onNode={onNode} />)}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full rounded-control border border-dashed border-border py-2 text-meta text-muted transition-colors hover:border-accent hover:text-accent"
          >
            Show {formatCount(hidden)} more path{hidden === 1 ? '' : 's'} in this group
          </button>
        )}
        {expanded && rows.length > COLLAPSE_AT && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="w-full rounded-control border border-dashed border-border py-2 text-meta text-muted transition-colors hover:border-accent hover:text-accent"
          >
            Show fewer
          </button>
        )}
      </div>
    </CloudSection>
  );
}

export default function AttackPathsPanel({ accountId, enabled = true }) {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useAttackPaths(accountId, {}, enabled);
  const onNode = (n) => { if (n?.id) navigate(`/cloud/resources/${n.id}`); };

  // Grouped by class, but ordered by the worst path each group holds, so the
  // most severe thing found is always the first thing read.
  const groups = useMemo(() => {
    const out = new Map();
    (data?.paths || []).forEach((p) => {
      const k = p.path_class || 'DIRECT_ROUTE';
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(p);
    });
    return [...out.entries()].sort((a, b) => groupRank(b[1]) - groupRank(a[1]));
  }, [data]);

  if (isLoading) return <PageLoading title="Tracing attack paths…" minHeight={220} />;
  if (isError) {
    return (
      <CloudSection>
        <EmptyState
          icon="alert"
          title="Attack path analysis unavailable"
          body={error?.response?.data?.detail
            || 'The request failed. This is a load error, not a clean result.'}
        />
      </CloudSection>
    );
  }
  if (!data) return null;

  if (!data.available) {
    return (
      <CloudSection>
        <EmptyState icon="help" title="Attack paths could not be analysed" body={data.unavailable_reason} />
      </CloudSection>
    );
  }

  const cov = data.coverage || {};
  const sum = data.summary || {};
  const bands = sum.by_band || {};

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <Stat label="Attack paths" value={data.total_paths} tone="bg-danger-soft text-danger-fg" icon="route" />
        <Stat label="Critical" value={bands.CRITICAL || 0} tone="bg-danger-soft text-danger-fg" icon="alert" />
        <Stat label="Entry points" value={sum.distinct_entry_points} tone="bg-warning-soft text-warning-fg" icon="globe" />
        <Stat label="Resources involved" value={sum.resources_involved} tone="bg-info-soft text-info-fg" icon="layers" />
      </div>

      {/* ── What could not be looked for ──────────────────────────────────── */}
      {cov.no_traversable_edges_note && (
        <div className="flex items-start gap-2 rounded-control border border-warning-soft bg-warning-soft p-3 text-xs text-warning-fg">
          <Icon name="help" size={15} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">No path could be traced in this account.</p>
            <p className="mt-1 leading-relaxed">{cov.no_traversable_edges_note}</p>
          </div>
        </div>
      )}

      {cov.identity_edge_note && (
        <div className="flex items-start gap-2 rounded-control border border-warning-soft bg-warning-soft p-3 text-xs text-warning-fg">
          <Icon name="key" size={15} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Identity paths were not searchable here.</p>
            <p className="mt-1 leading-relaxed">{cov.identity_edge_note}</p>
          </div>
        </div>
      )}

      {cov.exposure_undetermined > 0 && (
        <div className="flex items-start gap-2 rounded-control border border-warning-soft bg-warning-soft p-3 text-xs text-warning-fg">
          <Icon name="help" size={15} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">
              {formatCount(cov.exposure_undetermined)} resource
              {cov.exposure_undetermined === 1 ? '' : 's'} could not be checked for reachability.
            </p>
            <p className="mt-1 leading-relaxed">{cov.exposure_undetermined_note}</p>
          </div>
        </div>
      )}

      {(data.truncated || []).map((t) => (
        <div key={t} className="flex items-start gap-2 rounded-control border border-info-soft bg-info-soft p-3 text-xs text-info-fg">
          <Icon name="info" size={15} className="mt-0.5 shrink-0" />
          <span className="leading-relaxed">{t}</span>
        </div>
      ))}

      {/* ── The paths ─────────────────────────────────────────────────────── */}
      {data.total_paths === 0 ? (
        <CloudSection>
          <EmptyState
            icon="shield-check"
            title="No attack path found"
            body={
              cov.any_traversable_edges === false
                ? 'The graph holds no relationship an attacker could move along, so this is not evidence that none exists.'
                : `${formatCount(sum.exposed_resources || 0)} internet-reachable resource(s) were used as entry points, and none reached a data store or privileged identity within ${data.limits?.max_depth} hops.`
            }
          />
        </CloudSection>
      ) : (
        groups.map(([cls, rows]) => (
          <PathGroup
            key={cls}
            cls={cls}
            rows={rows}
            label={sum.class_labels?.[cls] || cls}
            meaning={sum.class_meanings?.[cls]}
            onNode={onNode}
          />
        ))
      )}

      {/* ── What this view is, and is not ─────────────────────────────────── */}
      <CloudSection
        title="How these paths were derived"
        description="Every hop is a relationship discovery recorded. Nothing here is inferred."
      >
        <div className="space-y-2 text-micro leading-relaxed text-subtle">
          <p>
            Paths start only at a resource confirmed reachable from the internet, and walk
            the same graph the Topology tab draws — so each hop can be opened and checked
            there. Relationships that describe ownership or filtering are not steps an
            attacker can take and are never traversed.
          </p>
          <p>
            A path may rest on at most {data.limits?.max_unobserved_hops} hop(s) the provider
            does not confirm. {data.limits?.max_unobserved_hops_note}
          </p>
          {!data.history_available && <p>{data.history_note}</p>}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {Object.entries(cov.traversable_edges_present || {}).map(([k, n]) => (
              <Badge key={k} tone="outline" size="xs">{k}: {n}</Badge>
            ))}
            {(cov.traversable_edges_missing || []).map((k) => (
              <Badge key={k} tone="neutral" size="xs" title="No edge of this kind exists in this account's graph">
                {k}: none
              </Badge>
            ))}
          </div>
        </div>
      </CloudSection>
    </div>
  );
}
