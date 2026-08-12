import cn from '@/lib/cn';
import { errorText } from '@/api/client';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Dialog from '@/components/ui/Dialog';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import { InlineLoading } from '@/components/ui/Loading';
import Gauge from '@/components/charts/Gauge';
import { Panel } from './enginePanels';

/**
 * ACTMON AI REPORT — one renderer for the structured report every AI endpoint in
 * the backend returns.
 *
 * The envelope is always the same, whichever engine produced it:
 *
 *   { available: false, reason }                       — engine absent or unconfigured
 *   { available: true,  data: { …the keys below } }
 *
 * and `data` carries some subset of `checks_performed`, `health_score`,
 * `problems_detected`, the four prose analyses, `cost_optimization_suggestions`,
 * `recommended_actions` and `expected_performance_improvement`. Every key is
 * optional — the model is asked for all of them but a partial answer must still
 * render, so nothing here assumes presence.
 *
 * Written once because the same body appears inline on a tab, expanded in a
 * dialog, and (for a single log row) as a three-field explanation. Three copies of
 * it was how the production page ended up with three slightly different versions.
 */

/** The four prose sections, in the order they are useful to read. */
const ANALYSES = [
  { key: 'performance_analysis', label: 'Performance', icon: 'activity' },
  { key: 'storage_analysis', label: 'Storage', icon: 'database' },
  { key: 'partition_analysis', label: 'Partitioning', icon: 'layers' },
  { key: 'index_analysis', label: 'Indexing', icon: 'list' },
];

/** A list of model-written sentences. Prose, so it wraps rather than truncates. */
export function AiBullets({ items, icon = 'check', tone = 'muted' }) {
  const TONES = {
    muted: 'text-subtle',
    good: 'text-success-fg',
    warn: 'text-warning-fg',
    bad: 'text-danger-fg',
    accent: 'text-accent-text',
  };
  return (
    <ul className="space-y-1.5">
      {items.map((text, i) => (
        <li key={`${i}-${String(text).slice(0, 24)}`} className="flex items-start gap-2 text-[13px] text-fg">
          <Icon name={icon} size={13} className={cn('mt-1 shrink-0', TONES[tone] || TONES.muted)} />
          <span className="min-w-0 leading-relaxed">{text}</span>
        </li>
      ))}
    </ul>
  );
}

/** A titled prose block. `whitespace-pre-wrap` keeps the model's own paragraphs. */
export function AiSection({ title, icon, children }) {
  if (!children) return null;
  return (
    <section>
      <h4 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-subtle uppercase">
        {icon && <Icon name={icon} size={12} />}
        {title}
      </h4>
      <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-fg">{children}</p>
    </section>
  );
}

/**
 * The report body. `report` is the raw envelope, so a caller passes what the query
 * returned without unwrapping — an unavailable report is a state this renders, not
 * an error the caller has to handle.
 */
export function AiReportBody({ report, compact = false, only }) {
  if (!report) return null;

  if (!report.available) {
    return (
      <Notice tone="info" className="mb-0" title="Actmon AI is not available.">
        {report.reason || 'The AI engine is not configured on this server.'}
      </Notice>
    );
  }

  const r = report.data || {};
  const show = (key) => !only || only.includes(key);
  const checks = r.checks_performed || [];
  const problems = r.problems_detected || [];
  const savings = r.cost_optimization_suggestions || [];
  const actions = r.recommended_actions || [];

  return (
    <div className="space-y-gutter">
      {/* What was actually inspected, first: it is what makes the rest credible,
          and it is the part a reader can verify. */}
      {show('checks_performed') && checks.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-[11px] font-bold tracking-wide text-subtle uppercase">
            What was checked
          </h4>
          <AiBullets items={checks} icon="check" />
        </section>
      )}

      {show('health_score') && r.health_score != null && (
        <div className="flex items-center gap-gutter rounded-card bg-sunken px-card py-3">
          <Gauge label="Health" value={Number(r.health_score) || 0} icon="sparkles" size={compact ? 84 : 104} />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-fg">Composite score, out of 100</p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
              Weighed by Actmon AI across the checks listed above. A score is a summary of this
              report, not a measurement — read the findings, not just the number.
            </p>
          </div>
        </div>
      )}

      {show('problems_detected') && problems.length > 0 && (
        <section>
          <h4 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-warning-fg uppercase">
            <Icon name="alert" size={12} />
            Problems found
            <Badge tone="warning" size="xs">{problems.length}</Badge>
          </h4>
          <AiBullets items={problems} icon="alert" tone="warn" />
        </section>
      )}

      {ANALYSES.filter((a) => show(a.key) && r[a.key]).map((a) => (
        <AiSection key={a.key} title={a.label} icon={a.icon}>{r[a.key]}</AiSection>
      ))}

      {show('cost_optimization_suggestions') && savings.length > 0 && (
        <section>
          <h4 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-success-fg uppercase">
            <Icon name="zap" size={12} />
            Cost savings
          </h4>
          <AiBullets items={savings} icon="zap" tone="good" />
        </section>
      )}

      {show('recommended_actions') && actions.length > 0 && (
        <section>
          <h4 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-accent-text uppercase">
            <Icon name="wrench" size={12} />
            Recommended actions
          </h4>
          <AiBullets items={actions} icon="chevron-right" tone="accent" />
        </section>
      )}

      {show('expected_performance_improvement') && (
        <AiSection title="Expected improvement" icon="trend">
          {r.expected_performance_improvement}
        </AiSection>
      )}
    </div>
  );
}

/**
 * Run / re-run / expand, plus every in-between state.
 *
 * `state` is a react-query mutation or query result — `isPending`, `isError`,
 * `error`, `data` — so a caller passes the hook result straight through.
 */
export function AiReportPanel({
  title = 'Actmon AI',
  subtitle,
  intro,
  state,
  onRun,
  onExpand,
  runLabel = 'Generate report',
  disabled,
  pendingLabel = 'Actmon AI is reading real data and analysing…',
  emptyLabel = 'Nothing has been generated yet.',
  only,
}) {
  const report = state?.data;
  const hasReport = Boolean(report?.available);

  return (
    <Panel
      title={title}
      subtitle={subtitle}
      icon="sparkles"
      actions={(
        <>
          {hasReport && onExpand && (
            <Button variant="secondary" size="sm" icon="expand" onClick={onExpand}>
              Expand
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            icon="sparkles"
            loading={state?.isPending}
            disabled={disabled}
            onClick={onRun}
          >
            {hasReport ? 'Regenerate' : runLabel}
          </Button>
        </>
      )}
    >
      {intro && <p className="mb-gutter text-[13px] leading-relaxed text-muted">{intro}</p>}

      {state?.isPending && <InlineLoading label={pendingLabel} />}

      {state?.isError && !state.isPending && (
        <Notice tone="danger" className="mb-0" title="The report could not be generated.">
          {errorText(state.error)}
        </Notice>
      )}

      {!state?.isPending && !state?.isError && !report && (
        <p className="py-4 text-center text-[13px] text-subtle">{emptyLabel}</p>
      )}

      {!state?.isPending && report && <AiReportBody report={report} only={only} />}
    </Panel>
  );
}

/** The same body, expanded. Kept here so the dialog can never drift from the tab. */
export function AiReportDialog({ open, onClose, report, target }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Actmon AI report"
      subtitle={target}
      icon="sparkles"
      width={780}
    >
      <AiReportBody report={report} />
    </Dialog>
  );
}

/**
 * The single-row explanation: `{summary, root_cause, suggested_fix}`.
 *
 * Same endpoint family, different shape — one logged call rather than a whole
 * container — so it gets its own small renderer instead of being bent into the
 * report above.
 */
export function AiRowExplanation({ state, slow = false }) {
  if (state?.loading) {
    return <InlineLoading label={`Actmon AI is analysing this ${slow ? 'query' : 'error'}…`} />;
  }
  if (state?.error) {
    return (
      <Notice tone="danger" className="mb-0" title="Analysis failed.">{state.error}</Notice>
    );
  }
  if (!state?.data) return null;
  if (!state.data.available) {
    return (
      <Notice tone="info" className="mb-0" title="Actmon AI is not available.">
        {state.data.reason || 'The AI engine is not configured on this server.'}
      </Notice>
    );
  }

  const d = state.data.data || {};
  return (
    <div className="space-y-gutter">
      <AiSection title="What happened" icon="info">{d.summary}</AiSection>
      <AiSection title={slow ? 'Why it was slow' : 'Root cause'} icon={slow ? 'clock' : 'alert'}>
        {d.root_cause}
      </AiSection>
      <AiSection title="Suggested fix" icon="wrench">{d.suggested_fix}</AiSection>
    </div>
  );
}
