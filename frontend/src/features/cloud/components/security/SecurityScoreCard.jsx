import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import CloudSection from '../CloudSection';
import {
  coverageTone, formatPct, gradeColor, isRealGrade,
} from '../../utils/securityModel';

/**
 * The security score gauge, and the drawer that explains it.
 *
 * The interesting case is the one where there is no score. The old gauge always
 * rendered a number, which meant the Azure Production Account — 275 resources,
 * 26.8% coverage, every check returning "could not determine" — displayed
 * **100 / A**, its best possible result, because nothing had been confirmed
 * wrong. This component renders that state as a withheld score with the reason,
 * because a grey "Insufficient data" is the honest output and a green A is not.
 */
export default function SecurityScoreCard({ score, coveragePct, onExplain, explanation }) {
  const [open, setOpen] = useState(false);
  const hasScore = score?.score !== null && score?.score !== undefined;
  const grade = score?.grade || 'Not assessed';
  const color = gradeColor(grade);
  const real = isRealGrade(grade);

  const openDrawer = () => {
    setOpen(true);
    onExplain?.();
  };

  return (
    <>
      <CloudSection bodyClassName="flex flex-col items-center justify-center text-center">
        <button
          type="button"
          onClick={openDrawer}
          className="group flex flex-col items-center rounded-control p-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          aria-label={hasScore
            ? `Security score ${score.score} of 100, grade ${grade}. Open the breakdown.`
            : `Security score not available: ${grade}. Open the explanation.`}
        >
          <div className="relative flex h-[140px] w-[140px] items-center justify-center">
            <svg width="140" height="140" viewBox="0 0 140 140" aria-hidden="true">
              <circle cx="70" cy="70" r="58" fill="none" stroke="var(--border)" strokeWidth="10" />
              {hasScore && (
                <circle
                  cx="70" cy="70" r="58" fill="none"
                  stroke={color}
                  strokeWidth="10"
                  strokeDasharray="364.4"
                  strokeDashoffset={364.4 - (364.4 * score.score) / 100}
                  strokeLinecap="round"
                  transform="rotate(-90 70 70)"
                  style={{ transition: 'stroke-dashoffset 1s ease-out' }}
                />
              )}
              {!hasScore && (
                // A dashed ring rather than an empty one: an empty ring reads
                // as a zero score, which is a claim about the estate.
                <circle
                  cx="70" cy="70" r="58" fill="none" stroke="var(--border)"
                  strokeWidth="10" strokeDasharray="6 10" strokeLinecap="round"
                />
              )}
            </svg>
            <div className="absolute flex flex-col items-center">
              {hasScore ? (
                <>
                  <span className="text-4xl font-bold leading-none text-fg">{score.score}</span>
                  <span className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                    Score
                  </span>
                </>
              ) : (
                <>
                  <Icon name="help" size={30} className="text-muted" />
                  <span className="mt-1 max-w-[92px] text-[11px] font-semibold uppercase leading-tight tracking-wider text-muted">
                    No score
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <span
              className="rounded-full border px-3.5 py-1 text-xs font-bold"
              style={{
                color,
                backgroundColor: `${color}1a`,
                borderColor: `${color}44`,
              }}
            >
              {real ? `Grade ${grade}` : grade}
            </span>
            <Icon
              name="chevron-right"
              size={14}
              className="text-subtle transition-transform group-hover:translate-x-0.5"
            />
          </div>
        </button>

        {/* Coverage sits directly under the score on purpose. The two are only
            meaningful together — a score is a statement about an estate, and it
            is only as strong as the share of the data behind it. */}
        <div className="mt-3 flex items-center gap-2 text-xs">
          <span className="text-muted">Data coverage</span>
          <Badge tone={coverageTone(coveragePct)}>{formatPct(coveragePct, { nullLabel: 'Unknown' })}</Badge>
        </div>

        {score?.grade_capped_by && (
          <p className="mt-3 max-w-[15rem] text-left text-[11px] leading-relaxed text-muted">
            {score.grade_capped_by}
          </p>
        )}
        {!score?.grade_capped_by && hasScore && (
          <p className="mt-3 px-2 text-xs text-muted">
            {score.score >= 90 ? 'No confirmed critical or high findings.'
              : score.score >= 70 ? 'Some confirmed findings need attention.'
                : 'Confirmed critical or high findings are present.'}
          </p>
        )}

        <Button
          variant="ghost"
          size="sm"
          icon="chart-bar"
          className="mt-3"
          onClick={openDrawer}
        >
          Why this score?
        </Button>
      </CloudSection>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={hasScore ? `Why is the score ${score.score}?` : 'Why is there no score?'}
        width={560}
      >
        <ScoreExplanation
          score={score}
          explanation={explanation}
          coveragePct={coveragePct}
        />
      </Drawer>
    </>
  );
}

/**
 * The breakdown. The lines must sum to the displayed total — a breakdown that
 * does not add up is worse than none, because it teaches the reader that the
 * number is arbitrary.
 */
function ScoreExplanation({ score, explanation, coveragePct }) {
  const lines = explanation?.lines || [];
  const excluded = explanation?.excluded || score?.unscored || {};
  const excludedExplain = explanation?.excluded_explanation || {};
  const hasScore = score?.score !== null && score?.score !== undefined;

  return (
    <div className="space-y-5 text-sm">
      {!hasScore && (
        <div className="rounded-control border border-warning-soft bg-warning-soft p-3 text-xs text-warning-fg">
          <p className="font-semibold">No score is shown for this account.</p>
          <p className="mt-1 leading-relaxed">{score?.grade_capped_by}</p>
        </div>
      )}

      {/* The arithmetic, in the order it was applied. */}
      <div>
        <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">
          Deductions
        </h4>
        <div className="overflow-hidden rounded-control border border-border">
          <div className="flex items-center justify-between bg-sunken px-3 py-2 text-xs">
            <span className="font-semibold text-fg">Starting score</span>
            <span className="font-mono text-fg">100</span>
          </div>
          {lines.length === 0 && (
            <div className="px-3 py-3 text-xs text-muted">
              No category removed any points.
            </div>
          )}
          {lines.map((line) => (
            <div key={line.label} className="border-t border-border px-3 py-2">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-2 text-fg">
                  {line.label}
                  {line.capped && <Badge tone="outline" size="xs">capped</Badge>}
                </span>
                <span className="font-mono text-danger">
                  −{Number(line.deduction).toFixed(1)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-subtle">
                <span>
                  {line.findings} finding{line.findings === 1 ? '' : 's'}
                  {line.worst ? ` · worst ${line.worst}` : ''}
                </span>
                <span className="text-border">|</span>
                <span>budget {line.budget}</span>
              </div>
              {line.note && (
                <p className="mt-1 text-[11px] leading-relaxed text-muted">{line.note}</p>
              )}
            </div>
          ))}
          <div className="flex items-center justify-between border-t border-border bg-sunken px-3 py-2 text-xs">
            <span className="font-semibold text-fg">Total deduction</span>
            <span className="font-mono text-danger">
              −{Number(explanation?.total_deduction ?? score?.total_deduction ?? 0).toFixed(1)}
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-border px-3 py-2.5">
            <span className="text-sm font-bold text-fg">Final score</span>
            <span className="font-mono text-lg font-bold text-fg">
              {hasScore ? score.score : '—'}
            </span>
          </div>
        </div>
      </div>

      {/* What was deliberately not counted, and why. The exclusions have to be
          visible: a reader comparing "276 findings" with "−47.8 points" will
          otherwise conclude the number is made up. */}
      <div>
        <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">
          Findings not counted toward the score
        </h4>
        <div className="space-y-2">
          {Object.entries(excluded).filter(([, n]) => n > 0).length === 0 && (
            <p className="text-xs text-muted">Every active finding was counted.</p>
          )}
          {Object.entries(excluded)
            .filter(([, n]) => n > 0)
            .map(([reason, n]) => (
              <div key={reason} className="rounded-control border border-border bg-surface p-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-fg">
                    {reason.replace(/_/g, ' ')}
                  </span>
                  <Badge tone="neutral">{n}</Badge>
                </div>
                {excludedExplain[reason] && (
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">
                    {excludedExplain[reason]}
                  </p>
                )}
              </div>
            ))}
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">
          Reliability
        </h4>
        <div className="rounded-control border border-border bg-surface p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted">Data coverage</span>
            <Badge tone={coverageTone(coveragePct)}>
              {formatPct(coveragePct, { nullLabel: 'Unknown' })}
            </Badge>
          </div>
          <p className="mt-2 leading-relaxed text-muted">
            Coverage never changes the arithmetic — it decides whether the number may be
            presented as a verdict. Below 40% no score is shown at all, because almost every
            check would have returned &ldquo;could not determine&rdquo; rather than
            &ldquo;no problem found&rdquo;.
          </p>
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">
          Methodology
        </h4>
        <p className="text-[11px] leading-relaxed text-muted">
          {explanation?.methodology || score?.methodology}
        </p>
      </div>
    </div>
  );
}
