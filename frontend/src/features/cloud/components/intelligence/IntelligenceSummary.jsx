import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import ProviderLogo from '../ProviderLogo';
import { relativeTime } from '../../utils/resourceModel';
import { PROVIDER_LABEL, savingsTotalView } from '../../utils/intelligenceModel';

const CARD_STYLE = {
  critical: { icon: 'alert', tone: 'bg-danger-soft text-danger-fg' },
  high: { icon: 'alert', tone: 'bg-warning-soft text-warning-fg' },
  optimization: { icon: 'sparkles', tone: 'bg-accent-soft text-accent-text' },
  savings: { icon: 'trend', tone: 'bg-success-soft text-success-fg' },
  underutilized: { icon: 'gauge', tone: 'bg-info-soft text-info-fg' },
  unused: { icon: 'archive', tone: 'bg-warning-soft text-warning-fg' },
  security: { icon: 'shield', tone: 'bg-danger-soft text-danger-fg' },
  analyzed: { icon: 'boxes', tone: 'bg-neutral-soft text-muted' },
};

/**
 * The page header and its eight cards. Every number is the backend's; a card
 * that cannot be counted shows N/A with the reason, never 0.
 *
 * No refresh button here: the account header's "Refresh all" and the tab's
 * own "Refresh intelligence" are the only two, and both sit above this.
 */
export default function IntelligenceSummary({ summary, activeCard, onCard, onCoverage }) {
  if (!summary) return null;
  const { last_scan: scan, last_analysis: run } = summary;
  const regions = summary.regions || [];
  const provider = summary.account?.provider;

  return (
    <div className="space-y-4">
      <section className="rounded-card border border-border bg-surface px-card py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-[17px] font-bold text-fg">Cloud Resource Intelligence</h2>
            <p className="mt-0.5 max-w-2xl text-[12.5px] leading-relaxed text-muted">
              Continuous analysis of security, cost, performance and resource utilization —
              from provider telemetry, billing and configuration, never estimated.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1 text-right">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Last analyzed</span>
            {run ? (
              <span className="text-[14px] font-bold text-fg" title={new Date(run.at).toLocaleString()}>
                {relativeTime(run.at)}
                <Badge tone={run.outcome === 'COMPLETE' ? 'success' : 'warning'} size="xs" className="ml-2 align-middle">
                  {run.outcome === 'COMPLETE' ? 'Complete' : 'Partial'}
                </Badge>
              </span>
            ) : (
              <span className="text-[13px] font-semibold text-muted">Not analyzed yet</span>
            )}
            {summary.analysis_running && (
              <span className="inline-flex items-center gap-1 text-[11px] text-accent-text">
                <Icon name="spinner" size={12} className="animate-spin" /> Analysis running…
              </span>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11.5px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            <ProviderLogo provider={provider} size={16} />
            <span className="font-semibold text-fg">{PROVIDER_LABEL[provider] || provider}</span>
            <span className="truncate-safe max-w-[16rem]">{summary.account?.name}</span>
          </span>
          <span className="inline-flex items-center gap-1.5" title={regions.map((r) => r.region).join(', ')}>
            <Icon name="globe" size={13} />
            {regions.length
              ? `${regions.slice(0, 3).map((r) => r.region).join(', ')}${regions.length > 3 ? ` +${regions.length - 3}` : ''}`
              : 'No regions recorded'}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Icon name="cloud" size={13} />
            Last scan{' '}
            <span className="text-fg">{scan?.at ? relativeTime(scan.at) : 'never'}</span>
            {scan?.partial && <Badge tone="warning" size="xs">Partial sweep</Badge>}
            {scan?.status === 'FAILED' && <Badge tone="danger" size="xs">Failed</Badge>}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Icon name="activity" size={13} />
            Telemetry collected{' '}
            <span className="text-fg">
              {summary.telemetry_collected_at ? relativeTime(summary.telemetry_collected_at) : 'never'}
            </span>
          </span>
          {summary.last_assessment?.at && (
            <span className="inline-flex items-center gap-1.5">
              <Icon name="shield" size={13} />
              Security assessed <span className="text-fg">{relativeTime(summary.last_assessment.at)}</span>
            </span>
          )}
          {onCoverage && (
            <button type="button" onClick={onCoverage}
              className="inline-flex items-center gap-1 font-semibold text-accent-text hover:underline">
              <Icon name="gauge" size={13} /> What was analyzed, and what could not be
            </button>
          )}
        </div>

        {run?.incomplete_reasons?.length > 0 && (
          <div className="mt-3 rounded-control border border-warning-soft bg-warning-soft px-3 py-2 text-[11.5px] text-warning-fg">
            <p className="font-semibold">This analysis is partial — findings it could not re-check stay open.</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {run.incomplete_reasons.slice(0, 4).map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
        )}
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(summary.cards || []).map((card) => (
          <SummaryCard
            key={card.id}
            card={card}
            active={activeCard === card.id}
            onClick={card.filter ? () => onCard(card) : onCoverage}
          />
        ))}
      </div>
    </div>
  );
}

function SummaryCard({ card, active, onClick }) {
  const style = CARD_STYLE[card.id] || { icon: 'circle', tone: 'bg-neutral-soft text-muted' };
  let value;
  let caption = null;
  if (card.id === 'savings') {
    const view = savingsTotalView(card.by_currency);
    value = view.text;
    caption = `${card.priced || 0} priced · ${card.unpriced || 0} not quantified`;
  } else if (card.id === 'analyzed') {
    value = card.value === null || card.value === undefined ? 'N/A' : card.value.toLocaleString();
    caption = card.of !== null && card.of !== undefined
      ? `of ${card.of.toLocaleString()} in the inventory` : 'no analysis yet';
  } else {
    value = typeof card.value === 'number' ? card.value.toLocaleString() : 'N/A';
    if (card.id === 'security' && card.undetermined) caption = `+${card.undetermined} undetermined`;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={card.note || undefined}
      className={cn(
        'card flex items-center gap-3 p-card text-left transition-colors hover:border-strong',
        active && 'border-accent ring-1 ring-accent',
      )}
    >
      <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg', style.tone)}>
        <Icon name={style.icon} size={18} />
      </span>
      <span className="min-w-0">
        <span className="block truncate-safe text-[10.5px] font-semibold uppercase tracking-wider text-muted">
          {card.label}
        </span>
        <span className={cn('block truncate-safe text-[21px] font-bold tabular-nums',
          value === 'N/A' ? 'text-muted' : 'text-fg')}
        >
          {value}
        </span>
        {caption && <span className="block truncate-safe text-[10.5px] text-subtle">{caption}</span>}
      </span>
    </button>
  );
}
