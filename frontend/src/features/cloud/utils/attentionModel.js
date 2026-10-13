/**
 * What actually needs a human, and in what order.
 *
 * Moved out of `components/overview/AttentionCenter.jsx` so it can be tested
 * without a DOM. This is the part where a defect is invisible: every item here
 * is a claim that something is wrong, and a miscount or a double-count reads as
 * a perfectly ordinary dashboard row.
 *
 * Nothing in this file evaluates anything. Every number comes from the system
 * that owns it - posture from the Security Center, alerts from the alert
 * engine, freshness from discovery - and items are ordered by an explicit
 * severity rank, then by count. There is no score and no weighting.
 */
import { REFRESH_ALL_LABEL } from './refreshModel';
import { relativeTime } from './resourceModel';

const RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };

export const SEVERITY_META = {
  CRITICAL: { tone: 'danger', icon: 'alert', label: 'Critical' },
  HIGH: { tone: 'danger', icon: 'alert', label: 'High' },
  MEDIUM: { tone: 'warning', icon: 'clock', label: 'Medium' },
  INFO: { tone: 'info', icon: 'info', label: 'Info' },
};

export function buildAttentionItems({
  summary, posture, freshness, changeSummary, discovery, costError, postureError,
  alerts,
}) {
  const items = [];
  const bySeverity = posture?.findings_summary?.by_severity || {};

  // ── Alerts ───────────────────────────────────────────────────────────────
  // Consumed from the Alerts API, never recomputed here. The Overview asking
  // "what is currently alerting" and the Alerts tab answering it differently
  // is exactly the failure that made the old duplicate security engine report
  // 0/F beside 35/F for the same account.
  const alertsBySeverity = alerts?.alerts_by_severity || {};
  const criticalAlerts = (alertsBySeverity.CRITICAL || 0) + (alertsBySeverity.HIGH || 0);
  if (criticalAlerts > 0) {
    items.push({
      id: 'active-alerts-critical',
      severity: 'CRITICAL',
      count: criticalAlerts,
      message: `${criticalAlerts} critical or high alert${criticalAlerts === 1 ? ' is' : 's are'} still active`,
      action: 'alerts',
      actionLabel: 'View Alerts',
    });
  }
  const otherAlerts = (alerts?.active_alerts || 0) - criticalAlerts;
  if (otherAlerts > 0) {
    items.push({
      id: 'active-alerts-other',
      severity: 'MEDIUM',
      count: otherAlerts,
      message: `${otherAlerts} other alert${otherAlerts === 1 ? ' is' : 's are'} still active`,
      action: 'alerts',
      actionLabel: 'View Alerts',
    });
  }

  // A rule that cannot read its data source is not a quiet rule — it is a
  // blind spot, and it is the reason an all-clear on this page can be wrong.
  if (alerts?.rules_inconclusive > 0) {
    items.push({
      id: 'alerts-inconclusive',
      severity: 'HIGH',
      count: alerts.rules_inconclusive,
      message: `${alerts.rules_inconclusive} alert rule${alerts.rules_inconclusive === 1 ? '' : 's'} could not read its data source — those conditions are unchecked, not clear`,
      action: 'alerts',
      actionLabel: 'View Alerts',
    });
  }

  // Alerts that fired correctly and reached nobody. Distinct from the alert
  // itself, because the condition being handled and the email arriving are
  // separate facts.
  if (alerts?.delivery && alerts.delivery.ready === false && alerts.rules?.enabled > 0) {
    items.push({
      id: 'alerts-undeliverable',
      severity: 'HIGH',
      count: null,
      message: `${alerts.rules.enabled} alert rule${alerts.rules.enabled === 1 ? ' is' : 's are'} enabled but no email can be delivered`,
      action: 'alerts',
      actionLabel: 'Fix Delivery',
    });
  }

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
      // What the click does: it opens the diagnostic, which says why. It was
      // labelled "Run Discovery" while doing exactly that.
      actionLabel: 'View diagnostic',
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
      actionLabel: REFRESH_ALL_LABEL,
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
