import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import cn from '@/lib/cn';
import { relativeTime } from '../../utils/resourceModel';
import { Panel } from './OverviewPrimitives';

/**
 * What actually needs a human, ordered by how much.
 *
 * Every item below is derived from a real count returned by the system that
 * owns it. There is no score, no weighting and no invented priority: items are
 * ordered by an explicit severity rank, then by count, and the rank is a fixed
 * list rather than arithmetic nobody can audit.
 *
 * Nothing is double-counted. "12 resources have high-severity findings" and
 * "3 critical findings" describe different sets, and neither is added to the
 * other — the strip above reports the totals, this reports the reasons.
 *
 * The empty state is careful. "Nothing needs attention" is only honest if the
 * underlying systems actually ran; when posture is unavailable the panel says
 * that instead, because an unevaluated account is not a clean one.
 */

const RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };

const SEVERITY_META = {
  CRITICAL: { tone: 'danger', icon: 'alert', label: 'Critical' },
  HIGH: { tone: 'danger', icon: 'alert', label: 'High' },
  MEDIUM: { tone: 'warning', icon: 'clock', label: 'Medium' },
  INFO: { tone: 'info', icon: 'info', label: 'Info' },
};

export function buildAttentionItems({
  summary, posture, freshness, changeSummary, discovery, costError, postureError,
}) {
  const items = [];
  const bySeverity = posture?.findings_summary?.by_severity || {};

  if (bySeverity.CRITICAL > 0) {
    items.push({
      id: 'critical-findings',
      severity: 'CRITICAL',
      count: bySeverity.CRITICAL,
      message: `${bySeverity.CRITICAL} critical security finding${bySeverity.CRITICAL === 1 ? '' : 's'} open`,
      action: 'security',
      actionLabel: 'View Security',
    });
  }
  if (bySeverity.HIGH > 0) {
    items.push({
      id: 'high-findings',
      severity: 'HIGH',
      count: bySeverity.HIGH,
      message: `${bySeverity.HIGH} high-severity finding${bySeverity.HIGH === 1 ? '' : 's'} open`,
      action: 'security',
      actionLabel: 'View Security',
    });
  }

  // A failed scan is the most actionable thing on the page: everything else
  // shown is only as current as the sweep that produced it.
  if (discovery?.last_attempt_failed) {
    items.push({
      id: 'discovery-failed',
      severity: 'CRITICAL',
      count: null,
      message: 'The most recent discovery scan failed — inventory may be out of date',
      action: 'discovery',
      actionLabel: 'Run Discovery',
    });
  } else if (freshness?.severity === 'CRITICALLY_STALE' || freshness?.severity === 'STALE') {
    items.push({
      id: 'stale-inventory',
      severity: freshness.severity === 'CRITICALLY_STALE' ? 'HIGH' : 'MEDIUM',
      count: null,
      message: freshness.observed_at
        ? `Inventory was last confirmed ${relativeTime(freshness.observed_at)}`
        : 'This account has never completed a discovery sweep',
      action: 'discovery',
      actionLabel: 'Run Discovery',
    });
  }

  // Only claimed when BOTH facts are real: the resources are stopped, and the
  // provider is still billing for them. Stopped alone is not waste.
  if (summary?.stopped_count > 0) {
    items.push({
      id: 'stopped',
      severity: 'MEDIUM',
      count: summary.stopped_count,
      message: `${summary.stopped_count} resource${summary.stopped_count === 1 ? ' is' : 's are'} stopped`,
      action: 'resources',
      filters: { status: 'STOPPED' },
      actionLabel: 'View Resources',
    });
  }

  if (summary?.unattached_count > 0) {
    items.push({
      id: 'unattached',
      severity: 'MEDIUM',
      count: summary.unattached_count,
      message: `${summary.unattached_count} storage resource${summary.unattached_count === 1 ? ' is' : 's are'} attached to nothing`,
      action: 'resources',
      filters: { attachment: 'UNATTACHED' },
      actionLabel: 'View Resources',
    });
  }

  if (changeSummary?.by_impact?.security > 0) {
    items.push({
      id: 'security-drift',
      severity: 'HIGH',
      count: changeSummary.by_impact.security,
      message: `${changeSummary.by_impact.security} recent configuration change${changeSummary.by_impact.security === 1 ? '' : 's'} affected security posture`,
      action: 'drift',
      actionLabel: 'View Drift',
    });
  }

  // Subsystem outages are themselves actionable — silently omitting the cost
  // card would leave the page looking complete while a number is missing.
  if (postureError) {
    items.push({
      id: 'posture-unavailable',
      severity: 'HIGH',
      count: null,
      message: 'Security posture could not be evaluated — this account\'s risk is unknown, not zero',
      action: 'security',
      actionLabel: 'View Security',
    });
  }
  if (costError) {
    items.push({
      id: 'cost-unavailable',
      severity: 'INFO',
      count: null,
      message: 'Billing data could not be retrieved for this account',
      action: 'cost',
      actionLabel: 'View Cost',
    });
  }

  return items.sort((a, b) => (
    RANK[a.severity] - RANK[b.severity] || (b.count || 0) - (a.count || 0)
  ));
}

export default function AttentionCenter({
  items, isLoading, evaluated, onAction,
}) {
  return (
    <Panel
      title="Needs Attention"
      icon="alert"
      subtitle="Ordered by severity, then by how many resources are involved"
      loading={isLoading}
      dense
    >
      {items.length === 0 ? (
        <p className="rounded-control border border-dashed border-border px-3 py-5 text-center text-[12px]">
          {evaluated ? (
            <>
              <Icon name="check" size={14} className="mr-1 inline text-success-fg" />
              <span className="text-muted">
                Nothing in this account currently requires attention.
              </span>
            </>
          ) : (
            <span className="text-muted">
              Not enough of this account has been evaluated to say whether
              anything needs attention.
            </span>
          )}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => {
            const meta = SEVERITY_META[item.severity] || SEVERITY_META.INFO;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onAction(item)}
                  className="flex w-full items-center gap-3 px-1 py-2 text-left hover:bg-sunken"
                >
                  <Icon
                    name={meta.icon}
                    size={15}
                    className={cn(
                      'shrink-0',
                      meta.tone === 'danger' ? 'text-danger'
                        : meta.tone === 'warning' ? 'text-warning-fg' : 'text-info-fg',
                    )}
                  />
                  {/* Colour is never the only carrier — the severity is
                      spelled out beside it. */}
                  <Badge tone={meta.tone} size="xs" className="shrink-0 uppercase">
                    {meta.label}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
                    {item.message}
                  </span>
                  <span className="shrink-0 text-[11px] font-semibold text-accent-text">
                    {item.actionLabel}
                    <Icon name="arrow-right" size={11} className="ml-1 inline" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
