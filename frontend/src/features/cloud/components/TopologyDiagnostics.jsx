import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Notice from '@/components/ui/Notice';
import { Spinner } from '@/components/ui/Loading';
import {
  ISOLATION_LABEL, REFERENCE_CLASS_LABEL, formatAge, formatCount, formatMoment, formatPct,
  providerMeta, typeMeta,
} from '../utils/topologyModel';

/**
 * Topology diagnostics — what we have, what is missing, and why.
 *
 * This drawer is where the feature stops being a picture and becomes an
 * operational tool. Its whole purpose is that a missing relationship should
 * always be explainable: either the target was not discovered, or nothing
 * collects that resource type, or the identity's grant is a wildcard with no
 * specific target to point at. "63 unconnected" with no explanation is the
 * thing this replaces.
 */

const STATE_META = {
  ok: { tone: 'success', label: 'Collecting' },
  no_resources: { tone: 'neutral', label: 'No resources' },
  scan_failed: { tone: 'danger', label: 'Scan failed' },
  never_scanned: { tone: 'neutral', label: 'Never scanned' },
};

function Stat({ label, value, hint, tone }) {
  return (
    <div className="rounded-card border border-border bg-sunken p-2.5">
      <p className={`text-[19px] font-bold leading-none ${tone === 'danger' ? 'text-danger-fg' : tone === 'warning' ? 'text-warning-fg' : 'text-fg'}`}>
        {value}
      </p>
      <p className="mt-1 text-[10.5px] font-semibold uppercase tracking-wide text-subtle">{label}</p>
      {hint && <p className="mt-1 text-[10.5px] leading-relaxed text-subtle">{hint}</p>}
    </div>
  );
}

function TabButton({ active, children, onClick, count }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={`rounded-control px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors ${
        active ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-sunken hover:text-fg'
      }`}
    >
      {children}
      {count !== undefined && count !== null && (
        <span className="ml-1.5 rounded-full bg-sunken px-1.5 text-[10px] font-bold text-subtle">{count}</span>
      )}
    </button>
  );
}

export default function TopologyDiagnosticsDrawer({
  open,
  onClose,
  scope,
  diagnostics,
  diagnosticsLoading,
  unresolved,
  unresolvedLoading,
  isolated,
  isolatedLoading,
  snapshots,
  snapshotsLoading,
  diff,
  diffLoading,
  onSelectNode,
  onTakeSnapshot,
  onDeleteSnapshot,
  onDiffSnapshot,
  selectedSnapshotId,
  takingSnapshot,
}) {
  const [tab, setTab] = useState('coverage');
  const coverage = diagnostics?.coverage;

  return (
    <Drawer open={open} onClose={onClose} title="Topology diagnostics" icon="activity" width={620}>
      <div className="mb-4 flex flex-wrap gap-1 border-b border-border pb-2">
        <TabButton active={tab === 'coverage'} onClick={() => setTab('coverage')}>Coverage</TabButton>
        <TabButton active={tab === 'unresolved'} onClick={() => setTab('unresolved')}
          count={diagnostics?.unresolved?.total}>
          Unresolved
        </TabButton>
        <TabButton active={tab === 'isolated'} onClick={() => setTab('isolated')}
          count={isolated?.total}>
          Unconnected
        </TabButton>
        <TabButton active={tab === 'accounts'} onClick={() => setTab('accounts')}
          count={diagnostics?.accounts?.length}>
          Accounts
        </TabButton>
        <TabButton active={tab === 'snapshots'} onClick={() => setTab('snapshots')}
          count={snapshots?.total}>
          Snapshots
        </TabButton>
      </div>

      {/* ── Coverage ─────────────────────────────────────────────────────── */}
      {tab === 'coverage' && (
        diagnosticsLoading ? <div className="flex justify-center py-10"><Spinner size="lg" /></div> : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Resources" value={formatCount(diagnostics?.resources)} />
              <Stat label="Relationships" value={formatCount(diagnostics?.relationships)} />
              <Stat
                label="Resolved references"
                value={formatPct(coverage?.resolved_pct)}
                hint="Of the references that could resolve."
              />
              <Stat
                label="Missing targets"
                value={formatCount(coverage?.missing_target)}
                tone={coverage?.missing_target ? 'warning' : undefined}
                hint="A collected type whose instance we did not find."
              />
            </div>

            {coverage?.definition && (
              <div className="rounded-card border border-border bg-sunken p-3">
                <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted">
                  What this measures
                </p>
                <p className="text-[12px] leading-relaxed text-muted">{coverage.definition}</p>
              </div>
            )}

            {coverage?.unsupported_type > 0 && (
              <Notice tone="info" title={`${formatCount(coverage.unsupported_type)} references to resource types not collected yet`}>
                These are relationships the providers reported that no scanner collects the
                other end of — OCI gateways, encryption keys, WAF policies. They are a known
                gap in this product, not a problem with your cloud, so they are excluded from
                the resolved percentage and listed separately under Unresolved.
              </Notice>
            )}

            {coverage?.by_provider?.length > 0 && (
              <div>
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">
                  By provider
                </p>
                <div className="divide-y divide-border overflow-hidden rounded-card border border-border">
                  {coverage.by_provider.map((row) => {
                    const provider = providerMeta(row.provider);
                    return (
                      <div key={row.provider} className="flex items-center gap-3 px-3 py-2">
                        <span className={`shrink-0 rounded border px-1.5 py-px text-[10px] font-bold ${provider.badge}`}>
                          {provider.label}
                        </span>
                        <span className="flex-1 text-[12px] text-muted">
                          {formatCount(row.resources)} resources · {formatCount(row.confirmed)} relationships
                        </span>
                        <span className="shrink-0 text-[12.5px] font-semibold text-fg">
                          {formatPct(row.resolved_pct)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {diagnostics?.inventory && (
              <div className="rounded-card border border-border bg-sunken p-3">
                <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted">
                  How current this is
                </p>
                <p className="text-[12px] leading-relaxed text-muted">{diagnostics.inventory.note}</p>
                <dl className="mt-2 flex flex-col gap-1 text-[12px]">
                  <div className="flex justify-between gap-2">
                    <dt className="text-subtle">Topology built</dt>
                    <dd className="text-fg">{formatMoment(diagnostics.topology_generated_at) || '—'}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-subtle">Oldest discovery scan</dt>
                    <dd className={diagnostics.inventory.stale ? 'font-semibold text-warning-fg' : 'text-fg'}>
                      {formatAge(diagnostics.inventory.oldest_age_seconds) || 'Never'}
                    </dd>
                  </div>
                  {diagnostics.build_ms !== undefined && (
                    <div className="flex justify-between gap-2">
                      <dt className="text-subtle">Build time</dt>
                      <dd className="text-fg">{diagnostics.build_ms} ms</dd>
                    </div>
                  )}
                </dl>
              </div>
            )}

            {diagnostics?.rules && (
              <div>
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">
                  Relationship rules
                </p>
                <p className="mb-2 text-[12px] text-muted">
                  {diagnostics.rules.active} rules are active. The fields below are deliberately
                  <em> not</em> turned into relationships:
                </p>
                <ul className="flex flex-col gap-1.5">
                  {diagnostics.rules.excluded_fields.map((row) => (
                    <li key={row.field} className="rounded-control border border-border bg-sunken p-2">
                      <p className="font-mono text-[11px] font-semibold text-fg">{row.field}</p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-subtle">{row.reason}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )
      )}

      {/* ── Unresolved references ────────────────────────────────────────── */}
      {tab === 'unresolved' && (
        unresolvedLoading ? <div className="flex justify-center py-10"><Spinner size="lg" /></div> : (
          <div className="flex flex-col gap-4">
            <p className="text-[12px] leading-relaxed text-muted">
              Identifiers the providers reported that did not match any discovered resource.
              Each one is a relationship that exists in your cloud and cannot be drawn here —
              which is worth knowing, and is better than the edge silently not appearing.
            </p>

            {unresolved?.total === 0 && (
              <Notice tone="success" title="Every reference resolved">
                Every relationship identifier the providers reported matched a resource in the
                inventory.
              </Notice>
            )}

            {unresolved?.by_reason?.length > 0 && (
              <div className="divide-y divide-border overflow-hidden rounded-card border border-border">
                {unresolved.by_reason.map((row) => (
                  <div key={row.gap} className="px-3 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[12.5px] font-semibold text-fg">{row.gap}</p>
                      <span className="shrink-0 rounded-full bg-sunken px-2 text-[11px] font-bold text-muted">
                        {formatCount(row.count)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge tone={row.reference_class === 'unsupported_type' ? 'info' : 'warning'} size="sm">
                        {REFERENCE_CLASS_LABEL[row.reference_class] || row.reference_class}
                      </Badge>
                      {row.providers?.map((provider) => (
                        <span key={provider} className="text-[10.5px] text-subtle">{provider}</span>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[11.5px] leading-relaxed text-subtle">{row.explanation}</p>
                  </div>
                ))}
              </div>
            )}

            {unresolved?.references?.length > 0 && (
              <div>
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">
                  Individual references
                </p>
                <div className="flex flex-col gap-1.5">
                  {unresolved.references.slice(0, 120).map((ref) => (
                    <div
                      key={`${ref.resource_id}-${ref.field}-${ref.value}`}
                      className="rounded-control border border-border bg-surface p-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => { onSelectNode?.(ref.resource_id); onClose?.(); }}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-[12px] font-semibold text-fg hover:underline">
                            {ref.resource_name || ref.provider_resource_id}
                          </span>
                          <span className="block truncate text-[11px] text-subtle">
                            {typeMeta(ref.resource_type).label} · {ref.provider}
                            {ref.region ? ` · ${ref.region}` : ''}
                          </span>
                        </button>
                        <span className="shrink-0 text-[10px] font-bold uppercase text-subtle">
                          {ref.relationship}
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-[10.5px] text-muted">
                        {ref.field} = <span className="break-all text-fg">{ref.value}</span>
                      </p>
                      {ref.expected_type && (
                        <p className="mt-0.5 text-[10.5px] text-subtle">
                          Expected a {ref.expected_type}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                {unresolved.references.length > 120 && (
                  <p className="mt-2 text-[11px] text-subtle">
                    Showing the first 120 of {formatCount(unresolved.references.length)}. Group
                    totals above cover all of them.
                  </p>
                )}
              </div>
            )}
          </div>
        )
      )}

      {/* ── Unconnected resources ───────────────────────────────────────── */}
      {tab === 'isolated' && (
        isolatedLoading ? <div className="flex justify-center py-10"><Spinner size="lg" /></div> : (
          <div className="flex flex-col gap-4">
            <p className="text-[12px] leading-relaxed text-muted">
              Resources with no discovered relationship — each with the reason. An unconnected
              resource is usually a collection gap rather than something genuinely standalone,
              and the two are worth telling apart.
            </p>

            {isolated?.total === 0 && (
              <Notice tone="success" title="Every resource is connected">
                Every discovered resource has at least one provider-confirmed relationship.
              </Notice>
            )}

            {isolated?.by_reason?.map((row) => (
              <div key={row.reason} className="rounded-card border border-border bg-sunken p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[12.5px] font-semibold text-fg">
                    {ISOLATION_LABEL[row.reason] || row.reason}
                  </p>
                  <span className="shrink-0 rounded-full bg-surface px-2 text-[11px] font-bold text-muted">
                    {formatCount(row.count)}
                  </span>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-subtle">{row.explanation}</p>
              </div>
            ))}

            {isolated?.resources?.length > 0 && (
              <div>
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">
                  Resources
                </p>
                <div className="flex flex-col gap-1">
                  {isolated.resources.slice(0, 150).map((row) => {
                    const meta = typeMeta(row.type);
                    return (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => { onSelectNode?.(row.id); onClose?.(); }}
                        className="flex items-center gap-2.5 rounded-control border border-border bg-surface px-2.5 py-1.5 text-left hover:border-strong hover:bg-accent-soft"
                      >
                        <span className="h-5 w-1 shrink-0 rounded-sm" style={{ background: meta.color }} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-medium text-fg">{row.name}</span>
                          <span className="block truncate text-[11px] text-subtle">
                            {meta.label} · {row.provider}
                            {row.region ? ` · ${row.region}` : ''}
                          </span>
                        </span>
                        <span className="shrink-0 text-[10px] font-semibold text-subtle">
                          {ISOLATION_LABEL[row.reason] || row.reason}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {isolated.resources.length > 150 && (
                  <p className="mt-2 text-[11px] text-subtle">
                    Showing the first 150 of {formatCount(isolated.resources.length)}.
                  </p>
                )}
              </div>
            )}
          </div>
        )
      )}

      {/* ── Accounts / permission gaps ──────────────────────────────────── */}
      {tab === 'accounts' && (
        diagnosticsLoading ? <div className="flex justify-center py-10"><Spinner size="lg" /></div> : (
          <div className="flex flex-col gap-3">
            <p className="text-[12px] leading-relaxed text-muted">
              An empty topology and an unreadable one look identical on the canvas. This is
              where they are told apart.
            </p>

            {diagnostics?.permission_gaps > 0 && (
              <Notice tone="warning" title="Coverage may be incomplete">
                {diagnostics.permission_gaps} account
                {diagnostics.permission_gaps === 1 ? '' : 's'} reported a permission error on
                the last scan. Resources and relationships in those accounts may be missing
                because the configured cloud identity cannot read them — not because they do
                not exist.
              </Notice>
            )}

            {diagnostics?.accounts?.map((account) => {
              const state = STATE_META[account.state] || { tone: 'neutral', label: account.state };
              const provider = providerMeta(account.provider);
              return (
                <div key={account.account_id} className="rounded-card border border-border bg-surface p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <span className={`rounded border px-1.5 py-px text-[10px] font-bold ${provider.badge}`}>
                          {provider.label}
                        </span>
                        <Badge tone={state.tone} size="sm">{state.label}</Badge>
                        {account.permission_problem && (
                          <Badge tone="danger" size="sm">Permission denied</Badge>
                        )}
                      </div>
                      <p className="truncate text-[13px] font-semibold text-fg">{account.account_name}</p>
                      <p className="text-[11px] text-subtle">
                        {formatCount(account.resources)} resources
                        {account.environment ? ` · ${account.environment}` : ''}
                        {account.last_discovery ? ` · scanned ${formatAge(
                          Math.round((Date.now() - new Date(account.last_discovery).getTime()) / 1000),
                        )}` : ' · never scanned'}
                      </p>
                    </div>
                  </div>
                  {account.explanation && (
                    <p className="mt-2 text-[11.5px] leading-relaxed text-muted">{account.explanation}</p>
                  )}
                  {account.last_job_error && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-semibold text-muted hover:text-fg">
                        Provider error
                      </summary>
                      <p className="mt-1 break-words rounded-control border border-border bg-sunken p-2 font-mono text-[10.5px] leading-relaxed text-muted">
                        {account.last_job_error}
                      </p>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {/* ── Snapshots and diff ─────────────────────────────────────────── */}
      {tab === 'snapshots' && (
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-2 text-[12px] leading-relaxed text-muted">
              A topology is a point-in-time view derived from the current inventory, so
              yesterday&apos;s shape is gone the moment a scan lands. A snapshot keeps it, and can
              be compared with now or with another snapshot.
            </p>
            <Button
              variant="secondary"
              size="sm"
              icon="plus"
              disabled={takingSnapshot}
              onClick={() => onTakeSnapshot?.()}
            >
              {takingSnapshot ? 'Capturing…' : 'Capture a snapshot of this scope'}
            </Button>
          </div>

          {snapshotsLoading && <div className="flex justify-center py-6"><Spinner /></div>}

          {!snapshotsLoading && snapshots?.snapshots?.length === 0 && (
            <p className="text-[12px] italic text-subtle">
              No snapshots captured yet.
            </p>
          )}

          {snapshots?.snapshots?.map((snapshot) => (
            <div
              key={snapshot.id}
              className={`rounded-card border p-3 ${
                selectedSnapshotId === snapshot.id ? 'border-accent bg-accent-soft' : 'border-border bg-surface'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] font-semibold text-fg">
                    {snapshot.label || 'Untitled snapshot'}
                  </p>
                  <p className="text-[11px] text-subtle">
                    {formatMoment(snapshot.taken_at)}
                    {snapshot.taken_by ? ` · ${snapshot.taken_by}` : ''}
                    {snapshot.scope ? ` · scope ${snapshot.scope === 'ALL' ? 'all clouds' : snapshot.scope.slice(0, 8)}` : ''}
                  </p>
                  <p className="mt-1 text-[11px] text-muted">
                    {formatCount(snapshot.node_count)} resources · {formatCount(snapshot.edge_count)} relationships
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="secondary" size="sm" onClick={() => onDiffSnapshot?.(snapshot.id)}>
                    Compare
                  </Button>
                  <IconButton
                    size="sm"
                    icon="trash"
                    label="Delete snapshot"
                    onClick={() => onDeleteSnapshot?.(snapshot.id)}
                  />
                </div>
              </div>

              {selectedSnapshotId === snapshot.id && (
                <div className="mt-3 border-t border-border pt-3">
                  {diffLoading && <div className="flex justify-center py-4"><Spinner /></div>}
                  {!diffLoading && diff?.error && (
                    <Notice tone="danger" title="Comparison failed">{diff.error}</Notice>
                  )}
                  {!diffLoading && diff?.summary && (
                    <>
                      <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">
                        Versus {diff.compared_with?.label}
                      </p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {[
                          ['Resources added', diff.summary.added_resources],
                          ['Resources removed', diff.summary.removed_resources],
                          ['Relationships added', diff.summary.added_relationships],
                          ['Relationships removed', diff.summary.removed_relationships],
                          ['Relationships changed', diff.summary.changed_relationships],
                        ].map(([label, value]) => (
                          <div key={label} className="rounded-control border border-border bg-sunken px-2 py-1.5">
                            <p className="text-[14px] font-bold leading-none text-fg">{formatCount(value)}</p>
                            <p className="mt-0.5 text-[10px] uppercase tracking-wide text-subtle">{label}</p>
                          </div>
                        ))}
                      </div>

                      {[
                        ['Added resources', diff.added_resources, 'success'],
                        ['Removed resources', diff.removed_resources, 'danger'],
                      ].map(([label, rows, tone]) => (rows?.length ? (
                        <div key={label} className="mt-3">
                          <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted">
                            {label} ({rows.length})
                          </p>
                          <ul className="flex flex-col gap-0.5">
                            {rows.slice(0, 25).map((row) => (
                              <li
                                key={row.key}
                                className="flex items-center gap-1.5 text-[11.5px]"
                              >
                                <span
                                  aria-hidden="true"
                                  className={`w-2.5 shrink-0 text-center font-bold ${
                                    tone === 'success' ? 'text-success-fg' : 'text-danger-fg'
                                  }`}
                                >
                                  {tone === 'success' ? '+' : '−'}
                                </span>
                                <span className="sr-only">
                                  {tone === 'success' ? 'Added:' : 'Removed:'}
                                </span>
                                <span className="truncate text-fg">{row.name}</span>
                                <span className="shrink-0 text-subtle">{typeMeta(row.type).label}</span>
                              </li>
                            ))}
                          </ul>
                          {rows.length > 25 && (
                            <p className="mt-1 text-[10.5px] text-subtle">
                              …and {rows.length - 25} more
                            </p>
                          )}
                        </div>
                      ) : null))}

                      {diff.changed_relationships?.length > 0 && (
                        <div className="mt-3">
                          <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted">
                            Changed relationships ({diff.changed_relationships.length})
                          </p>
                          <ul className="flex flex-col gap-1">
                            {diff.changed_relationships.slice(0, 20).map((row) => (
                              <li key={`${row.source}-${row.target}-${row.type}`} className="text-[11px] text-muted">
                                <span className="font-semibold text-fg">{row.type}</span>
                                {': '}
                                <span className="line-through">{row.before_label || '—'}</span>
                                {' → '}
                                <span className="text-fg">{row.after_label || '—'}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <p className="mt-3 text-[10.5px] leading-relaxed text-subtle">
                        {diff.identity_note}
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}
