import { useMemo, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import { Spinner } from '@/components/ui/Loading';
import {
  edgeStyle, formatCount, formatMoment, providerMeta, typeMeta,
} from '../utils/topologyModel';

/**
 * The three question-shaped drawers: why is this connected, what breaks if
 * this goes away, and is there a path between these two.
 *
 * Each one is a separate request against a separate endpoint, so opening a
 * drawer costs one small query rather than being served out of a graph the
 * browser had to download in full first.
 */

/* ── Why does this edge exist? ───────────────────────────────────────────── */
export function EdgeEvidenceDrawer({ open, onClose, data, loading, onSelectNode }) {
  const edge = data?.edge;
  const style = edge ? edgeStyle(edge.type) : null;

  return (
    <Drawer open={open} onClose={onClose} title="Relationship evidence" icon="route" width={460}>
      {loading && <div className="flex justify-center py-10"><Spinner size="lg" /></div>}

      {!loading && data?.found === false && (
        <Notice tone="warning" title="Relationship not found">
          This relationship is no longer in the topology. It was most likely rebuilt by a
          discovery scan since the graph was drawn.
        </Notice>
      )}

      {!loading && edge && (
        <div className="flex flex-col gap-4">
          <div className="rounded-card border border-border bg-sunken p-3">
            <span
              className="inline-block rounded-md px-2 py-0.5 text-meta font-bold uppercase tracking-wide"
              style={{ color: style.color, background: `${style.color}22` }}
            >
              {style.label}
            </span>
            <p className="mt-2 text-[12.5px] leading-relaxed text-fg">{edge.meaning || style.label}</p>
          </div>

          {/* Endpoints, in the stored direction, with the direction stated in
              words as well as by the arrow. */}
          <div className="flex flex-col gap-2">
            {[['Source', data.source], ['Target', data.target]].map(([role, node]) => {
              if (!node) return null;
              const meta = typeMeta(node.type);
              const provider = providerMeta(node.provider);
              return (
                <button
                  key={role}
                  type="button"
                  onClick={() => { onSelectNode?.(node.id); onClose?.(); }}
                  className="flex items-center gap-2.5 rounded-card border border-border bg-surface p-2.5 text-left hover:border-strong hover:bg-accent-soft"
                >
                  <span className="h-8 w-1.5 shrink-0 rounded-full" style={{ background: meta.color }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-micro font-bold uppercase tracking-wider text-subtle">{role}</span>
                    <span className="block truncate text-[13px] font-semibold text-fg">{node.name}</span>
                    <span className="block truncate text-meta text-muted">
                      {meta.label} · {provider.label}{node.region ? ` · ${node.region}` : ''}
                    </span>
                  </span>
                  <Icon name="chevron-right" size={14} className="shrink-0 text-subtle" />
                </button>
              );
            })}
          </div>

          <dl className="divide-y divide-border overflow-hidden rounded-card border border-border">
            {[
              ['Relationship', edge.semantic],
              ['Direction', edge.direction === 'symmetric'
                ? 'Symmetric — the same fact from either end, stored once'
                : 'Directed — it means something different the other way round'],
              ['Evidence field', edge.evidence?.field],
              ['Evidence value', edge.evidence?.value],
              ['Provider', edge.provider],
              ['Confidence', edge.evidence?.confidence],
              ['Discovered', formatMoment(edge.evidence?.discovered_at)],
            ].map(([label, value]) => (
              <div key={label} className="flex items-start justify-between gap-3 px-3 py-2">
                <dt className="shrink-0 text-meta font-semibold uppercase tracking-wide text-muted">{label}</dt>
                <dd className="flex min-w-0 items-start gap-1.5 text-right">
                  {value ? (
                    <>
                      <span className={label.includes('value') || label === 'Evidence field'
                        ? 'break-all font-mono text-meta text-fg'
                        : 'text-[12.5px] text-fg'}>
                        {value}
                      </span>
                      {label === 'Evidence value' && (
                        <CopyButton text={String(value)} label="" size="sm" variant="ghost" className="shrink-0" />
                      )}
                    </>
                  ) : (
                    <span className="text-[12px] italic text-subtle">Not available</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>

          {edge.evidence?.note && (
            <Notice tone="info" title="How this was resolved">{edge.evidence.note}</Notice>
          )}

          {edge.observed === false && (
            <Notice tone="warning" title="This is a permission, not an access">
              It means the source is <strong>allowed</strong> to reach the target. It is not
              evidence that any access occurred. To find out whether it actually did, look at
              the Event Log for the target resource.
            </Notice>
          )}

          <p className="text-meta leading-relaxed text-subtle">
            Every relationship in this topology is provider-confirmed: it was drawn from an
            identifier the provider itself reported, resolved exactly against the discovered
            inventory. There is no inferred or probabilistic relationship.
          </p>
        </div>
      )}
    </Drawer>
  );
}

/* ── What breaks if this goes away? ──────────────────────────────────────── */
const IMPACT_TONE = { NONE: 'neutral', LOW: 'info', MEDIUM: 'warning', HIGH: 'danger' };

export function ImpactDrawer({ open, onClose, data, loading, onSelectNode }) {
  const [showAll, setShowAll] = useState(false);
  const resource = data?.resource;

  const groups = useMemo(() => {
    if (!data?.found) return [];
    return [
      { label: 'Direct dependents', hint: 'One relationship away.', rows: data.direct_dependents || [] },
      { label: 'Indirect dependents', hint: 'Reached through another affected resource.', rows: data.indirect_dependents || [] },
    ].filter((group) => group.rows.length);
  }, [data]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Impact analysis"
      subtitle={resource ? `If ${resource.name} were removed` : undefined}
      icon="alert"
      width={520}
    >
      {loading && <div className="flex justify-center py-10"><Spinner size="lg" /></div>}

      {!loading && data?.found === false && (
        <Notice tone="warning" title="Resource not in this topology">
          It may belong to another account, or it may not have been returned by the last
          discovery scan.
        </Notice>
      )}

      {!loading && data?.found && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-2">
            {[
              ['Direct', data.direct_count],
              ['Indirect', data.indirect_count],
              ['Total affected', data.total_affected],
            ].map(([label, value]) => (
              <div key={label} className="rounded-card border border-border bg-sunken p-2.5 text-center">
                <p className="text-[18px] font-bold leading-none text-fg">{formatCount(value)}</p>
                <p className="mt-1 text-meta font-semibold uppercase tracking-wide text-subtle">{label}</p>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-meta font-semibold uppercase tracking-wide text-muted">Blast radius</span>
            <Badge tone={IMPACT_TONE[data.impact_level] || 'neutral'} size="sm">{data.impact_level}</Badge>
          </div>
          <p className="-mt-2 text-meta leading-relaxed text-subtle">{data.impact_basis}</p>

          {Object.keys(data.by_dependency_class || {}).length > 0 && (
            <div>
              <p className="mb-1.5 text-meta font-bold uppercase tracking-wider text-muted">
                By kind of dependency
              </p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(data.by_dependency_class).map(([klass, count]) => (
                  <span key={klass} className="rounded-md bg-sunken px-2 py-0.5 text-meta text-muted">
                    <span className="font-semibold capitalize">{klass}</span> {count}
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-meta text-subtle">
                A resource affected through two relationships is counted in both, so these do
                not sum to the total.
              </p>
            </div>
          )}

          {data.truncated && (
            <Notice tone="info" title="Search was bounded">
              The traversal stopped at its node limit, so the real blast radius is at least
              this large.
            </Notice>
          )}

          {groups.map((group) => {
            const rows = showAll ? group.rows : group.rows.slice(0, 20);
            return (
              <div key={group.label}>
                <p className="mb-0.5 text-meta font-bold uppercase tracking-wider text-muted">
                  {group.label} <span className="text-subtle">({group.rows.length})</span>
                </p>
                <p className="mb-1.5 text-meta text-subtle">{group.hint}</p>
                <ul className="flex flex-col gap-1">
                  {rows.map((row) => {
                    const meta = typeMeta(row.type);
                    return (
                      <li key={row.id}>
                        <button
                          type="button"
                          onClick={() => { onSelectNode?.(row.id); onClose?.(); }}
                          className="flex w-full items-center gap-2.5 rounded-control border border-border bg-surface px-2.5 py-1.5 text-left hover:border-strong hover:bg-accent-soft"
                        >
                          <span className="h-5 w-1 shrink-0 rounded-sm" style={{ background: meta.color }} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12.5px] font-medium text-fg">{row.name}</span>
                            <span className="block truncate text-meta text-subtle">
                              {meta.label} · {row.dependency_classes.join(', ')}
                            </span>
                          </span>
                          <span className="shrink-0 text-micro font-bold text-subtle">{row.depth} hop</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {group.rows.length > 20 && !showAll && (
                  <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAll(true)}>
                    {`Show all ${group.rows.length}`}
                  </Button>
                )}
              </div>
            );
          })}

          {data.total_affected === 0 && (
            <Notice tone="info" title="Nothing discovered depends on this">
              No other resource in this topology relies on it. If you expected something to,
              check the unresolved references — the relationship may exist but point at
              something the scan did not return.
            </Notice>
          )}
        </div>
      )}
    </Drawer>
  );
}

/* ── Is there a path between these two? ──────────────────────────────────── */
export function PathFinderDrawer({
  open, onClose, nodes, source, target, onChangeSource, onChangeTarget,
  data, loading, maxDepth, onChangeMaxDepth, onHighlight, onSelectNode,
}) {
  const [query, setQuery] = useState('');

  const options = useMemo(() => {
    const sorted = [...nodes].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const filtered = query
      ? sorted.filter((n) => `${n.name} ${n.type}`.toLowerCase().includes(query.toLowerCase()))
      : sorted;
    // Bounded: a native <select> with 1,600 options is unusable, and the
    // search box above it is the way to narrow it.
    return filtered.slice(0, 300).map((n) => ({
      id: n.id,
      label: `${n.name} — ${typeMeta(n.type).label}`,
    }));
  }, [nodes, query]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  return (
    <Drawer open={open} onClose={onClose} title="Find a path" icon="route" width={500}>
      <div className="flex flex-col gap-3">
        <p className="text-[12px] leading-relaxed text-muted">
          Finds the shortest chain of provider-confirmed relationships between two resources.
          If none exists, that is what it says — no path is invented.
        </p>

        <label className="flex flex-col gap-1">
          <span className="text-meta font-semibold uppercase tracking-wide text-muted">
            Narrow the lists
          </span>
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type to filter by name or type…"
            className="h-control rounded-control border border-border bg-surface px-2.5 text-[13px] text-fg outline-none placeholder:text-subtle focus:ring-2 focus:ring-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-meta font-semibold uppercase tracking-wide text-muted">From</span>
          <Select value={source || ''} onChange={onChangeSource} options={options} placeholder="Select a resource…" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-meta font-semibold uppercase tracking-wide text-muted">To</span>
          <Select value={target || ''} onChange={onChangeTarget} options={options} placeholder="Select a resource…" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-meta font-semibold uppercase tracking-wide text-muted">
            Maximum hops
          </span>
          <Select
            value={String(maxDepth)}
            onChange={(value) => onChangeMaxDepth?.(Number(value))}
            options={[3, 4, 6, 8, 10, 12].map((n) => ({ id: String(n), label: `${n} hops` }))}
          />
        </label>

        {options.length === 300 && (
          <p className="text-meta text-subtle">
            Showing the first 300 matches — type above to narrow the list.
          </p>
        )}

        {loading && <div className="flex justify-center py-6"><Spinner /></div>}

        {!loading && data && !data.found && (
          <Notice tone="warning" title="No confirmed relationship path">
            {data.detail || 'No path was found.'}
          </Notice>
        )}

        {!loading && data?.found && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[12px] font-semibold text-fg">
                {data.length} hop{data.length === 1 ? '' : 's'}
              </p>
              <Button variant="secondary" size="sm" onClick={() => onHighlight?.(data)}>
                Highlight on the graph
              </Button>
            </div>
            <ol className="flex flex-col gap-1">
              {data.nodes.map((node, index) => {
                const meta = typeMeta(node.type);
                const hop = index > 0 ? data.hops[index - 1] : null;
                return (
                  <li key={node.id}>
                    {hop && (
                      <div className="flex items-center gap-1.5 py-1 pl-4 text-meta">
                        <Icon name="chevron-down" size={12} className="text-subtle" />
                        <span
                          className="rounded px-1.5 py-px font-bold uppercase"
                          style={{
                            color: edgeStyle(hop.relationship).color,
                            background: `${edgeStyle(hop.relationship).color}20`,
                          }}
                        >
                          {edgeStyle(hop.relationship).label}
                        </span>
                        {hop.label && <span className="text-subtle">{hop.label}</span>}
                        {!hop.with_direction && (
                          <span
                            className="text-subtle"
                            title="This link is stored in the opposite direction. The two are related, but the relationship itself points the other way."
                          >
                            (traversed backwards)
                          </span>
                        )}
                        {hop.observed === false && (
                          <span className="font-bold text-subtle" title="A permission, not an observed access.">
                            MAY
                          </span>
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => { onSelectNode?.(node.id); onClose?.(); }}
                      className="flex w-full items-center gap-2.5 rounded-control border border-border bg-surface px-2.5 py-1.5 text-left hover:border-strong hover:bg-accent-soft"
                    >
                      <span className="h-5 w-1 shrink-0 rounded-sm" style={{ background: meta.color }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-fg">{node.name}</span>
                        <span className="block truncate text-meta text-subtle">{meta.label}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {source && target && byId.get(source) && byId.get(target)
          && byId.get(source).provider !== byId.get(target).provider && (
          <Notice tone="info" title="These are in different clouds">
            No cross-cloud relationship is drawn unless a provider actually reports one, and
            none of the three does today. A path between two clouds will not be found here
            even if the two systems talk to each other over the network.
          </Notice>
        )}
      </div>
    </Drawer>
  );
}
