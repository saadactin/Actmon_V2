import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import cn from '@/lib/cn';
import { formatDateTime, relativeTime } from '../../utils/resourceModel';
import { BarRow, Panel, PanelEmpty, ViewLink } from './OverviewPrimitives';

/**
 * Security posture, from the canonical Security Center model.
 *
 * This panel replaces a card that called `/cloud/security/{id}` — a separate,
 * older rule engine with its own scoring. The two disagreed on live accounts
 * (oci_test: 0 here vs 35 in the Security Center; test_aw: 0 vs 52), so
 * clicking through to "see more detail" changed the number. There is now one
 * source, and this component only renders it: no score is computed here, and no
 * grade is derived from a score here.
 *
 * The "how is this scored" drawer shows the backend's OWN per-category
 * deductions rather than an explanation invented to look plausible.
 */

const SEVERITY_TONE = {
  CRITICAL: 'danger',
  HIGH: 'danger',
  MEDIUM: 'warning',
  LOW: 'info',
  INFO: 'neutral',
};

const GRADE_TONE = {
  A: 'text-success-fg', B: 'text-success-fg', C: 'text-warning-fg',
  D: 'text-warning-fg', F: 'text-danger',
};

export default function SecurityPosturePanel({
  posture, isLoading, error, affectedResources, onOpenSecurity, onOpenSeverity,
}) {
  const [explain, setExplain] = useState(false);

  const score = posture?.score;
  const summary = posture?.findings_summary;
  const bySeverity = summary?.by_severity || {};
  const total = Object.values(bySeverity).reduce((a, b) => a + b, 0);
  const assessment = posture?.assessment;
  const freshness = posture?.freshness;

  // An account nobody has assessed has no score. That is not zero — zero would
  // read as "assessed, and terrible".
  const unassessed = !isLoading && !error && (
    !posture || score?.score === null || score?.score === undefined
  );

  return (
    <Panel
      title="Security Posture"
      icon="shield"
      subtitle={
        assessment?.outcome
          ? `${assessment.outcome === 'COMPLETE' ? 'Full' : 'Partial'} assessment · ${assessment.resources_evaluated ?? '—'} resources evaluated`
          : 'Canonical Security Center findings'
      }
      updatedAt={freshness?.last_assessed_at}
      source="Security Center"
      action={<ViewLink onClick={onOpenSecurity}>Security Center</ViewLink>}
      loading={isLoading}
      error={error}
    >
      {unassessed ? (
        <PanelEmpty>
          No security assessment has completed for this account, so its posture
          is unknown — not clean. Run an assessment from the Security Center.
        </PanelEmpty>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="shrink-0 text-center">
              <div className={cn('text-4xl font-bold tabular-nums', GRADE_TONE[score?.grade] || 'text-fg')}>
                {score?.score ?? 'NA'}
              </div>
              <div className="mt-0.5 text-meta text-muted">out of 100</div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {score?.grade && (
                  <Badge tone={score.grade === 'F' || score.grade === 'D' ? 'danger' : score.grade === 'C' ? 'warning' : 'success'} size="sm">
                    {`Grade ${score.grade}`}
                  </Badge>
                )}
                {/* The backend tells us when its own score is not reliable —
                    usually because too much of the estate went unevaluated.
                    Hiding that would present a confident number built on a
                    partial scan. */}
                {score?.reliable === false && (
                  <Badge tone="warning" size="xs" title="The assessment did not cover enough of the estate for this score to be relied on.">
                    Low confidence
                  </Badge>
                )}
                {freshness?.assessment_stale && (
                  <Badge tone="warning" size="xs" title={`Last assessed ${formatDateTime(freshness.last_assessed_at)}`}>
                    Assessment stale
                  </Badge>
                )}
              </div>
              <button
                type="button"
                onClick={() => setExplain((v) => !v)}
                className="mt-1.5 inline-flex items-center gap-1 text-meta font-semibold text-accent-text hover:underline"
                aria-expanded={explain}
              >
                <Icon name="help" size={11} />
                {explain ? 'Hide scoring' : 'How is this scored?'}
              </button>
            </div>
          </div>

          {explain && (
            <div className="rounded-control border border-border bg-sunken p-3">
              <p className="mb-2 text-meta leading-snug text-muted">
                Each category has a deduction budget. These are the deductions
                the assessment actually applied.
              </p>
              <div className="space-y-1">
                {(score?.breakdown || []).map((row) => (
                  <div key={row.category} className="flex items-center justify-between gap-2 text-meta">
                    <span className="min-w-0 truncate text-muted">
                      {row.category}
                      <span className="text-subtle">{` · ${row.counted_count ?? row.finding_count} counted`}</span>
                    </span>
                    <span className="shrink-0 tabular-nums font-semibold text-danger">
                      {`-${Number(row.deduction).toFixed(1)}`}
                      <span className="font-normal text-subtle">{` / ${row.budget}`}</span>
                      {row.capped && <span className="ml-1 text-warning-fg" title="This category hit its budget cap.">capped</span>}
                    </span>
                  </div>
                ))}
                {(score?.breakdown || []).length === 0 && (
                  <p className="text-meta text-muted">No per-category breakdown was returned.</p>
                )}
              </div>
              {/* Findings the model deliberately did not score. Saying so stops
                  the severity bars and the score looking like they disagree. */}
              {score?.unscored && Object.values(score.unscored).some((n) => n > 0) && (
                <p className="mt-2 border-t border-border pt-2 text-meta leading-snug text-subtle">
                  {`Not scored: ${Object.entries(score.unscored)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`)
                    .join(', ')}.`}
                </p>
              )}
              {freshness?.last_assessed_at && (
                <p className="mt-2 text-meta text-subtle">
                  {`Last evaluated ${formatDateTime(freshness.last_assessed_at)} (${relativeTime(freshness.last_assessed_at)}).`}
                </p>
              )}
            </div>
          )}

          <div className="space-y-0.5">
            {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map((severity) => (
              bySeverity[severity] > 0 ? (
                <BarRow
                  key={severity}
                  label={severity.charAt(0) + severity.slice(1).toLowerCase()}
                  value={bySeverity[severity]}
                  total={total}
                  tone={SEVERITY_TONE[severity]}
                  onClick={() => onOpenSeverity(severity)}
                />
              ) : null
            ))}
            {total === 0 && (
              <p className="text-[12px] text-muted">
                The assessment completed and returned no open findings.
              </p>
            )}
          </div>

          {/* Findings count how many problems exist; this counts how much of
              the estate has one, which is the number people actually act on. */}
          {typeof affectedResources === 'number' && (
            <div className="flex items-center justify-between border-t border-border pt-3 text-[12px]">
              <span className="text-muted">Resources affected</span>
              <Button variant="ghost" size="sm" onClick={() => onOpenSeverity(null)}>
                <span className="font-semibold text-fg">{affectedResources.toLocaleString()}</span>
              </Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
