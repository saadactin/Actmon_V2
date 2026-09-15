import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Table, { EmptyState } from '@/components/ui/Table';
import { PageLoading } from '@/components/ui/Loading';
import CloudSection from '../CloudSection';
import {
  coverageTone, exposureMeta, formatCount, formatDateTime, formatPct,
  severityTone,
} from '../../utils/securityModel';
import {
  useCollectIdentity, useCoverage, useExposure, useIdentity, useTrends,
} from '../../hooks/useSecurityCenter';

/* ══════════════════════════════════════════════════════════════════════════
   Internet Exposure
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Per-resource internet reachability, with the evidence path.
 *
 * The rule this panel exists to enforce: a clean empty state may only be shown
 * when the backend says the clean result is trustworthy. The old panel rendered
 * "No internet exposure found" over 49 unevaluated Azure VMs — 25 of them with
 * public addresses — because a resource whose rules could not be resolved was
 * silently skipped instead of counted.
 */
export function ExposurePanel({ accountId, enabled = true }) {
  const { data, isLoading, isError, error } = useExposure(accountId, enabled);
  const [open, setOpen] = useState(() => new Set());

  if (isLoading) return <PageLoading title="Tracing internet-reachable paths…" minHeight={220} />;
  if (isError) {
    return (
      <CloudSection>
        <EmptyState
          icon="alert"
          title="Exposure analysis unavailable"
          body={error?.response?.data?.detail
            || 'The request failed. This is a load error, not a clean result.'}
        />
      </CloudSection>
    );
  }
  if (!data) return null;

  const exposed = (data.resources || []).filter((r) => r.verdict === 'EXPOSED');
  const unknown = (data.resources || []).filter((r) => r.verdict === 'UNKNOWN');
  const protectedRes = (data.resources || []).filter((r) => r.verdict === 'PROTECTED');

  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <Stat label="Exposed" value={data.exposed} tone="bg-danger-soft text-danger-fg" icon="globe" />
        <Stat label="Protected" value={data.protected} tone="bg-success-soft text-success-fg" icon="shield-check" />
        <Stat label="Undetermined" value={data.unknown} tone="bg-warning-soft text-warning-fg" icon="help" />
        <Stat label="Evaluated" value={data.total_evaluated} tone="bg-info-soft text-info-fg" icon="list" />
      </div>

      {/* The honesty gate. Any unresolved resource means the result cannot be
          described as clean, whatever the exposed count says. */}
      {!data.clean_result_trustworthy && data.exposed === 0 && (
        <div className="flex items-start gap-2 rounded-control border border-warning-soft bg-warning-soft p-3 text-xs text-warning-fg">
          <Icon name="help" size={15} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Exposure assessment is incomplete.</p>
            <p className="mt-1 leading-relaxed">
              No confirmed exposure was found, but {formatCount(data.unknown)} resource
              {data.unknown === 1 ? '' : 's'} could not be evaluated — so this is not a clean
              result. See the undetermined list below.
            </p>
          </div>
        </div>
      )}

      {unknown.length > 0 && (
        <CloudSection
          title={`Could not be evaluated (${unknown.length})`}
          description="Internet-facing resources whose governing rules could not be resolved. Not assumed safe."
        >
          <div className="space-y-2">
            {unknown.map((r) => (
              <div key={r.resource_id} className="rounded-control border border-warning-soft bg-warning-soft/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warning">Unknown</Badge>
                  <span className="text-[13px] font-medium text-fg">{r.resource_name}</span>
                  <span className="text-[11px] text-subtle">{r.resource_type}</span>
                  {r.public_addresses?.length > 0 && (
                    <Badge tone="outline" size="xs">{r.public_addresses.join(', ')}</Badge>
                  )}
                </div>
                {r.unknown_reason && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-warning-fg">
                    {r.unknown_reason}
                  </p>
                )}
              </div>
            ))}
          </div>
        </CloudSection>
      )}

      {exposed.length === 0 && unknown.length === 0 ? (
        <CloudSection>
          <EmptyState
            icon="shield-check"
            title={protectedRes.length > 0
              ? 'No internet exposure found'
              : 'No internet-facing resources'}
            body={protectedRes.length > 0
              ? `${protectedRes.length} internet-facing resource(s) were evaluated and every `
                + 'path to them is closed.'
              : 'No resource in this account has a public address.'}
          />
        </CloudSection>
      ) : (
        <div className="space-y-3">
          {exposed.map((r) => {
            const isOpen = open.has(r.resource_id);
            return (
              <div key={r.resource_id} className="card border-l-4 border-l-danger px-card py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={severityTone(r.severity)}>{r.severity}</Badge>
                      <span className="text-[15px] font-semibold text-fg">{r.resource_name}</span>
                      <Badge tone="outline" size="xs">{r.resource_type}</Badge>
                      <Badge tone={exposureMeta(r.verdict).tone}>{exposureMeta(r.verdict).label}</Badge>
                    </div>
                    <div className="mt-1 text-[12px] text-muted">
                      Public address{r.public_addresses.length === 1 ? '' : 'es'}:{' '}
                      <span className="font-mono text-fg">{r.public_addresses.join(', ')}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    icon={isOpen ? 'collapse' : 'expand'}
                    onClick={() => toggle(r.resource_id)}
                  >
                    {isOpen ? 'Hide path' : 'Show path'}
                  </Button>
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {r.open_ports.map((p, i) => (
                    <span
                      key={`${p.port}-${p.service}-${i}`}
                      className="inline-flex items-center gap-1.5 rounded-control border border-border bg-sunken px-2 py-1 text-[11px]"
                      title={p.why}
                    >
                      <Badge tone={severityTone(p.severity)} size="xs">{p.severity}</Badge>
                      <span className="font-mono text-fg">{p.label}</span>
                    </span>
                  ))}
                </div>

                {r.confidence !== 'HIGH' && (
                  <p className="mt-2 text-[11px] italic text-subtle">
                    Confidence: {r.confidence}
                    {r.unknown_reason ? ` — ${r.unknown_reason}` : ''}
                  </p>
                )}

                {isOpen && (
                  <div className="mt-3 rounded-control border border-border bg-sunken p-3">
                    <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">
                      Path from the internet
                    </div>
                    {/* The evidence chain. Without it, "exposed" is an
                        assertion; with it, an analyst can check the conclusion
                        against the provider's own console. */}
                    <ol className="space-y-1.5">
                      <li className="flex items-center gap-2 text-[12px]">
                        <Icon name="globe" size={13} className="text-danger" />
                        <span className="text-fg">Internet</span>
                      </li>
                      {r.path.map((hop, i) => (
                        <li key={`${hop.kind}-${hop.identifier}-${i}`} className="flex items-start gap-2 text-[12px]">
                          <Icon name="chevron-down" size={13} className="mt-0.5 text-subtle" />
                          <div className="min-w-0">
                            <span className="text-fg">{hop.label}</span>
                            <span className="ml-1.5 text-[11px] text-subtle">({hop.kind})</span>
                            {hop.detail && (
                              <div className="text-[11px] text-muted">{hop.detail}</div>
                            )}
                          </div>
                        </li>
                      ))}
                      <li className="flex items-center gap-2 text-[12px]">
                        <Icon name="chevron-down" size={13} className="text-subtle" />
                        <Icon name="server" size={13} className="text-fg" />
                        <span className="font-medium text-fg">{r.resource_name}</span>
                      </li>
                    </ol>

                    {r.port_verdicts?.length > 0 && (
                      <div className="mt-3">
                        <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">
                          Per-port verdicts
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {r.port_verdicts.map((pv) => (
                            <span
                              key={pv.port}
                              title={pv.reason}
                              className="inline-flex items-center gap-1 rounded-control border border-border bg-surface px-1.5 py-0.5 text-[11px]"
                            >
                              <span className="font-mono text-fg">{pv.port}</span>
                              <Badge tone={exposureMeta(pv.verdict).tone} size="xs">
                                {exposureMeta(pv.verdict).label}
                              </Badge>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {r.evaluated_controls?.length > 0 && (
                      <p className="mt-2 text-[11px] text-muted">
                        Rule sets consulted: {r.evaluated_controls.join(', ')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {data.port_catalog_note && (
        <p className="text-[11px] italic leading-relaxed text-subtle">{data.port_catalog_note}</p>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Identity & Access
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Identity risk, and — as importantly — whether the result can be believed.
 *
 * The old panel showed "Not Yet Available for AZURE" for every Azure
 * subscription. It is now per subscription: two of the three live ones return
 * role assignments; the third answers `AuthorizationFailed` and gets the exact
 * missing permission rather than a blanket message.
 */
export function IdentityPanel({ accountId, enabled = true }) {
  const { data, isLoading, isError } = useIdentity(accountId, enabled);
  const collect = useCollectIdentity();

  if (isLoading) return <PageLoading title="Reviewing identity grants…" minHeight={220} />;
  if (isError || !data) {
    return (
      <CloudSection>
        <EmptyState icon="alert" title="Identity review unavailable"
          body="The request failed. This is a load error, not a clean result." />
      </CloudSection>
    );
  }

  return (
    <div className="space-y-4">
      {/* Collection status first. An empty findings list means two opposite
          things depending on this banner, so it cannot be a footnote. */}
      {!data.trustworthy && (
        <div className="flex items-start gap-2 rounded-control border border-warning-soft bg-warning-soft p-3 text-xs text-warning-fg">
          <Icon name="lock" size={15} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              Identity data is not available for this account — status: {data.collection_status}
            </p>
            <p className="mt-1 leading-relaxed">
              {data.reason || 'No identity review is possible, so an empty result below would '
                + 'mean "we could not look", not "nothing is over-privileged".'}
            </p>
            {data.missing_permission && (
              <p className="mt-1.5">
                Missing permission:{' '}
                <span className="font-mono text-[11px]">{data.missing_permission}</span>
                {' '}— granting the Reader role at subscription scope includes it.
              </p>
            )}
            {data.collection_error && (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-[11px] underline">
                  Provider error
                </summary>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[10px] leading-relaxed">
                  {data.collection_error}
                </pre>
              </details>
            )}
          </div>
          <Button
            size="sm"
            icon="refresh"
            loading={collect.isPending}
            onClick={() => collect.mutate(accountId)}
          >
            Retry
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <Stat label="Identities reviewed" value={data.identities_reviewed}
          tone="bg-info-soft text-info-fg" icon="users" />
        <Stat label="Flagged" value={data.total_flagged}
          tone="bg-warning-soft text-warning-fg" icon="key" />
        <Stat label="Escalation paths" value={data.escalation_risk_count}
          tone="bg-danger-soft text-danger-fg" icon="shield" />
        <Stat label="Grants collected" value={data.grants_collected}
          tone="bg-neutral-soft text-muted" icon="id-card" />
      </div>

      {data.findings?.length === 0 ? (
        <CloudSection>
          <EmptyState
            icon={data.trustworthy ? 'shield-check' : 'help'}
            title={data.trustworthy
              ? 'No over-privileged identities found'
              : 'No identity review was possible'}
            body={data.trustworthy
              ? `${data.identities_reviewed} identity/identities were reviewed and none holds `
                + 'unconstrained or escalating access.'
              : 'Fix the collection problem above before reading this as a clean result.'}
          />
        </CloudSection>
      ) : (
        <CloudSection title={`Flagged identities (${data.findings.length})`}>
          <Table
            columns={[
              { key: 'sev', label: 'Severity', width: 100 },
              { key: 'what', label: 'Problem' },
              { key: 'who', label: 'Principal / role' },
              { key: 'scope', label: 'Scope', width: 170 },
            ]}
            rows={data.findings.map((f) => ({
              key: f.fingerprint,
              cells: {
                sev: <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>,
                what: (
                  <div className="min-w-0">
                    <div className="truncate-safe text-[13px] text-fg">{f.title}</div>
                    <div className="truncate-safe text-[11px] text-subtle">{f.rule_id}</div>
                  </div>
                ),
                who: (
                  <span className="truncate-safe text-[12px] text-fg">
                    {f.resource_name || '—'}
                  </span>
                ),
                scope: (
                  <span className="text-[11px] text-muted">
                    {f.evidence?.scope_level || f.evidence?.scope || '—'}
                  </span>
                ),
              },
              sort: { sev: f.severity, what: f.title, who: f.resource_name || '' },
            }))}
          />
        </CloudSection>
      )}

      {data.grants?.length > 0 && (
        <CloudSection
          title={`All collected grants (${data.grants.length}${data.grants_truncated ? ' shown' : ''})`}
          description="Every role assignment collected, risky or not — the denominator behind the numbers above."
        >
          <Table
            columns={[
              { key: 'role', label: 'Role' },
              { key: 'type', label: 'Principal type', width: 150 },
              { key: 'scope', label: 'Scope', width: 190 },
              { key: 'actions', label: 'Actions', width: 100, align: 'right' },
            ]}
            rows={data.grants.map((g) => ({
              key: g.id,
              cells: {
                role: (
                  <div className="min-w-0">
                    <div className="truncate-safe text-[12px] text-fg">{g.role_name || g.role_key}</div>
                    <div className="truncate-safe text-[11px] text-subtle">
                      {g.principal_name || g.principal_id}
                    </div>
                  </div>
                ),
                type: <span className="text-[11px] text-muted">{g.principal_type || '—'}</span>,
                scope: <Badge tone="outline" size="xs">{g.scope_label || g.scope_level}</Badge>,
                actions: (
                  <span className="text-[11px] text-muted">
                    {g.permissions?.actions?.length ?? '—'}
                  </span>
                ),
              },
              sort: {
                role: g.role_name || '', type: g.principal_type || '',
                scope: g.scope_level || '',
              },
            }))}
            rowHeight={48}
            virtualize
            maxBodyHeight={420}
          />
        </CloudSection>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Coverage
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * How much of the data each check needed was actually there.
 *
 * A data-availability metric, never a security score — the distinction the
 * topology coverage score already makes, for the same reason: without it,
 * "we could not evaluate this" is indistinguishable from "this is fine".
 */
export function CoveragePanel({ accountId, enabled = true }) {
  const { data, isLoading } = useCoverage(accountId, enabled);
  if (isLoading) return <PageLoading title="Loading coverage…" minHeight={200} />;
  if (!data) return null;

  const dims = data.dimensions || {};

  return (
    <div className="space-y-4">
      <CloudSection
        title="Security data coverage"
        description={data.note}
        action={<Badge tone={coverageTone(data.overall_pct)}>
          {formatPct(data.overall_pct, { nullLabel: 'Unknown' })}
        </Badge>}
      >
        <div className="space-y-3">
          {Object.entries(dims).map(([dim, pct]) => (
            <div key={dim}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="font-medium capitalize text-fg">{dim.replace(/_/g, ' ')}</span>
                <Badge tone={coverageTone(pct)}>
                  {formatPct(pct, { nullLabel: 'Nothing to assess' })}
                </Badge>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
                <div
                  className={`h-full rounded-full ${
                    pct === null ? 'bg-border'
                      : pct >= 90 ? 'bg-success'
                        : pct >= 70 ? 'bg-info'
                          : pct >= 40 ? 'bg-warning' : 'bg-danger'
                  }`}
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
            </div>
          ))}
          {Object.keys(dims).length === 0 && (
            <p className="text-xs text-muted">
              No assessment has been run for this account yet.
            </p>
          )}
        </div>
      </CloudSection>

      {data.incomplete_reasons?.length > 0 && (
        <CloudSection title="Why the assessment was incomplete">
          <ul className="space-y-2">
            {data.incomplete_reasons.map((r) => (
              <li key={r} className="flex gap-2 text-xs leading-relaxed text-warning-fg">
                <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </CloudSection>
      )}

      {data.identity_collection && !data.identity_collection.trustworthy && (
        <CloudSection title="Identity collection">
          <div className="text-xs">
            <div className="flex items-center gap-2">
              <Badge tone="warning">{data.identity_collection.status}</Badge>
              {data.identity_collection.missing_permission && (
                <span className="font-mono text-[11px] text-muted">
                  {data.identity_collection.missing_permission}
                </span>
              )}
            </div>
            {data.identity_collection.error_detail && (
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-control border border-border bg-sunken p-2 text-[10px] leading-relaxed text-muted">
                {data.identity_collection.error_detail}
              </pre>
            )}
          </div>
        </CloudSection>
      )}

      {data.gaps?.length > 0 && (
        <CloudSection
          title={`Collection gaps (${data.gaps.length})`}
          description="Checks that could not reach a conclusion, worst-affected first. Each one is a finding that is missing, not a finding that is absent."
        >
          <Table
            columns={[
              { key: 'rule', label: 'Check' },
              { key: 'verdict', label: 'Outcome', width: 130 },
              { key: 'count', label: 'Resources', width: 100, align: 'right' },
            ]}
            rows={data.gaps.map((g, i) => ({
              key: `${g.rule_id}-${i}`,
              cells: {
                rule: (
                  <div className="min-w-0">
                    <div className="truncate-safe text-[12px] text-fg">{g.title}</div>
                    <div className="line-clamp-2 text-[11px] leading-relaxed text-subtle">
                      {g.reason}
                    </div>
                  </div>
                ),
                verdict: (
                  <Badge tone={g.verdict === 'UNKNOWN' ? 'warning' : 'neutral'}>
                    {g.verdict === 'UNKNOWN' ? 'Not determined' : 'Not collected'}
                  </Badge>
                ),
                count: <span className="text-[12px] text-fg">{formatCount(g.affected_count)}</span>,
              },
              sort: { rule: g.title, verdict: g.verdict, count: g.affected_count },
            }))}
            rowHeight={62}
            virtualize
            maxBodyHeight={480}
          />
        </CloudSection>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Trends
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Score and finding counts over time.
 *
 * Points where the score was withheld are drawn as gaps, not zeroes — a break
 * in the line is a break in the data, and plotting an unscoreable assessment as
 * 0 would show a coverage failure as a collapse in posture.
 */
export function TrendsPanel({ accountId, enabled = true }) {
  const { data, isLoading } = useTrends(accountId, 60, enabled);
  if (isLoading) return <PageLoading title="Loading history…" minHeight={200} />;
  if (!data) return null;

  const points = data.points || [];
  if (points.length < 2) {
    return (
      <CloudSection>
        <EmptyState
          icon="chart-line"
          title="Not enough history yet"
          body={`${points.length} assessment(s) recorded. A trend needs at least two — `
            + 'run another assessment, or wait for the next discovery scan.'}
        />
      </CloudSection>
    );
  }

  const W = 720; const H = 180; const PAD = 8;
  const scored = points.filter((p) => p.score !== null && p.reliable);
  const x = (i) => PAD + (i * (W - PAD * 2)) / Math.max(1, points.length - 1);
  const y = (v) => H - PAD - ((v / 100) * (H - PAD * 2));

  // Segments rather than one path, so a withheld score breaks the line.
  const segments = [];
  let current = [];
  points.forEach((p, i) => {
    if (p.score !== null && p.reliable) {
      current.push(`${x(i)},${y(p.score)}`);
    } else if (current.length) {
      segments.push(current); current = [];
    }
  });
  if (current.length) segments.push(current);

  const first = scored[0];
  const last = scored[scored.length - 1];
  const delta = first && last ? last.score - first.score : null;

  return (
    <div className="space-y-4">
      <CloudSection
        title="Security score over time"
        description={data.note}
        action={delta !== null && (
          <Badge tone={delta > 0 ? 'success' : delta < 0 ? 'danger' : 'neutral'}>
            {delta > 0 ? '+' : ''}{delta} since {formatDateTime(first.at).split(',')[0]}
          </Badge>
        )}
      >
        <div className="overflow-x-auto">
          <svg
            width={W} height={H} viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Security score history: ${scored.length} scored assessments, `
              + `${points.length - scored.length} without a score.`}
            className="min-w-[520px]"
          >
            {[0, 25, 50, 70, 90, 100].map((v) => (
              <g key={v}>
                <line x1={PAD} x2={W - PAD} y1={y(v)} y2={y(v)}
                  stroke="var(--border)" strokeWidth="1"
                  strokeDasharray={v === 70 ? '4 4' : undefined} />
                <text x={W - PAD} y={y(v) - 3} textAnchor="end"
                  className="fill-[var(--subtle)] text-[9px]">{v}</text>
              </g>
            ))}
            {segments.map((seg, i) => (
              <polyline
                key={i}
                points={seg.join(' ')}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2"
                strokeLinecap="round"
              />
            ))}
            {points.map((p, i) => (
              p.score !== null && p.reliable ? (
                <circle key={i} cx={x(i)} cy={y(p.score)} r="3"
                  fill="var(--accent)">
                  <title>{`${formatDateTime(p.at)}: ${p.score} (${p.grade})`}</title>
                </circle>
              ) : (
                // A hollow marker at the baseline for a withheld score, so the
                // gap is visibly "no data" rather than a missing sample.
                <circle key={i} cx={x(i)} cy={H - PAD} r="3"
                  fill="none" stroke="var(--border)" strokeWidth="1.5">
                  <title>{`${formatDateTime(p.at)}: no score (coverage `
                    + `${formatPct(p.coverage_pct, { nullLabel: 'unknown' })})`}</title>
                </circle>
              )
            ))}
          </svg>
        </div>
      </CloudSection>

      <CloudSection title="Assessment history">
        <Table
          columns={[
            { key: 'at', label: 'When' },
            { key: 'score', label: 'Score', width: 110 },
            { key: 'cov', label: 'Coverage', width: 110 },
            { key: 'conf', label: 'Confirmed', width: 100, align: 'right' },
            { key: 'undet', label: 'Undetermined', width: 120, align: 'right' },
            { key: 'churn', label: 'New / resolved', width: 130, align: 'right' },
          ]}
          rows={[...points].reverse().map((p, i) => ({
            key: `${p.at}-${i}`,
            cells: {
              at: (
                <div className="min-w-0">
                  <div className="text-[12px] text-fg">{formatDateTime(p.at)}</div>
                  <div className="text-[11px] text-subtle">{p.outcome}</div>
                </div>
              ),
              score: p.score !== null && p.reliable
                ? <Badge tone="accent">{p.score} / {p.grade}</Badge>
                : <Badge tone="neutral">No score</Badge>,
              cov: <Badge tone={coverageTone(p.coverage_pct)}>
                {formatPct(p.coverage_pct, { nullLabel: '—' })}
              </Badge>,
              conf: <span className="text-[12px] text-fg">{formatCount(p.findings_confirmed)}</span>,
              undet: <span className="text-[12px] text-muted">{formatCount(p.findings_undetermined)}</span>,
              churn: (
                <span className="text-[11px]">
                  <span className="text-danger">+{p.new ?? 0}</span>
                  {' / '}
                  <span className="text-success">−{p.resolved ?? 0}</span>
                </span>
              ),
            },
          }))}
          rowHeight={52}
          virtualize
          maxBodyHeight={420}
        />
      </CloudSection>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */

export function Stat({ label, value, tone, icon }) {
  return (
    <div className="card flex items-center gap-3.5 p-card">
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${tone}`}>
        <Icon name={icon} size={18} />
      </div>
      <div className="min-w-0">
        <div className="truncate-safe text-[11px] font-semibold uppercase tracking-wider text-muted">
          {label}
        </div>
        <div className="mt-0.5 text-2xl font-bold text-fg">{formatCount(value)}</div>
      </div>
    </div>
  );
}
