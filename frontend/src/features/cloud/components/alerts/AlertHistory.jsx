import { useState } from 'react';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Table, { EmptyState } from '@/components/ui/Table';
import { statesFor } from '../../utils/alertModel';
import {
  Count, NotificationBadge, SeverityBadge, StateBadge, When, categoryMeta,
} from './AlertPrimitives';

/**
 * Alert history.
 *
 * The column that matters most and is easiest to leave out is **Notification**.
 * An alert firing and an email arriving are two separate events with two
 * separate outcomes, and collapsing them into one "sent" tick is how an
 * operator comes to believe they were told about something they were not. So
 * the alert's own state and the notification's state sit side by side and never
 * borrow each other's colour.
 */

const STATE_OPTIONS = [
  { id: '', label: 'Open and acknowledged' },
  { id: 'OPEN', label: 'Open only' },
  { id: 'ACKNOWLEDGED', label: 'Acknowledged only' },
  { id: 'RESOLVED', label: 'Resolved only' },
  { id: 'ALL', label: 'Every state' },
];

const SEVERITY_OPTIONS = [
  { id: '', label: 'Any severity' },
  { id: 'CRITICAL', label: 'Critical' },
  { id: 'HIGH', label: 'High' },
  { id: 'MEDIUM', label: 'Medium' },
  { id: 'LOW', label: 'Low' },
  { id: 'INFO', label: 'Info' },
];

const CATEGORY_OPTIONS = [
  { id: '', label: 'Every category' },
  { id: 'security', label: 'Security' },
  { id: 'cost', label: 'Cost' },
  { id: 'resource', label: 'Resources' },
  { id: 'drift', label: 'Config Drift' },
  { id: 'event', label: 'Events' },
  { id: 'discovery', label: 'Discovery' },
  { id: 'platform', label: 'Platform Health' },
];

const DAY_OPTIONS = [
  { id: '', label: 'All time' },
  { id: '1', label: 'Last 24 hours' },
  { id: '7', label: 'Last 7 days' },
  { id: '30', label: 'Last 30 days' },
  { id: '90', label: 'Last 90 days' },
];

// Re-exported from utils/alertModel so the page can keep importing it from
// here, while the logic itself stays in a module the test runner can load.
export { statesFor };

export default function AlertHistory({
  data, loading, error, filters, onFilters, onOpen,
}) {
  const [search, setSearch] = useState(filters.q || '');

  const hasFilters = !!(filters.q || filters.severity || filters.category
    || filters.days || filters.stateKey || filters.ruleId);

  // A rule filter arrives by navigation (from the rule list, a chart or the
  // noisy-rules panel), not from this filter row — so without a visible chip
  // the list would look mysteriously short with nothing to clear.
  const ruleName = filters.ruleId
    ? (data?.alerts || []).find((a) => a.rule_id === filters.ruleId)?.rule_name
    : null;

  const columns = [
    { key: 'when', label: 'Detected', width: 130 },
    { key: 'severity', label: 'Severity', width: 90 },
    { key: 'alert', label: 'Alert', width: '34%' },
    { key: 'rule', label: 'Rule', width: '16%' },
    { key: 'state', label: 'Status', width: 110 },
    { key: 'notification', label: 'Notification', width: 130 },
    { key: 'seen', label: 'Seen', align: 'right', width: 70 },
  ];

  const rows = (data?.alerts || []).map((a) => {
    const cat = categoryMeta(a.category);
    return {
      key: a.id,
      onClick: () => onOpen?.(a.id),
      cells: {
        when: (
          <div className="text-[11px] leading-snug">
            <When iso={a.created_at} />
            {a.last_seen_at && a.last_seen_at !== a.created_at && (
              <div className="text-subtle">
                last seen <When iso={a.last_seen_at} />
              </div>
            )}
          </div>
        ),
        severity: <SeverityBadge severity={a.severity} />,
        alert: (
          <div className="min-w-0">
            <div className="truncate text-[12px] font-semibold text-fg">
              {a.resource_name || cat.label}
            </div>
            <div className="line-clamp-2 text-[11px] leading-snug text-muted">
              {a.details}
            </div>
          </div>
        ),
        rule: (
          <span className="block truncate text-[11px] text-muted">
            {/* A deleted rule is labelled, not blanked — "why did I get this"
                must stay answerable after somebody tidies up. */}
            {a.rule_name || (a.rule_id ? 'Rule no longer exists' : 'Raised directly')}
          </span>
        ),
        state: <StateBadge state={a.state} />,
        notification: <NotificationBadge status={a.notification_status} />,
        seen: <Count value={a.occurrence_count} suffix="×" />,
      },
    };
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          icon="search"
          size="sm"
          placeholder="Search alerts…"
          value={search}
          wrapperClassName="w-56"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onFilters({ ...filters, q: search })}
          onClear={() => { setSearch(''); onFilters({ ...filters, q: '' }); }}
        />
        <Select
          size="sm" width="auto" value={filters.stateKey || ''}
          options={STATE_OPTIONS}
          onChange={(v) => onFilters({ ...filters, stateKey: v })}
        />
        <Select
          size="sm" width="auto" value={filters.severity || ''}
          options={SEVERITY_OPTIONS}
          onChange={(v) => onFilters({ ...filters, severity: v })}
        />
        <Select
          size="sm" width="auto" value={filters.category || ''}
          options={CATEGORY_OPTIONS}
          onChange={(v) => onFilters({ ...filters, category: v })}
        />
        <Select
          size="sm" width="auto" value={filters.days || ''}
          options={DAY_OPTIONS}
          onChange={(v) => onFilters({ ...filters, days: v })}
        />
        {filters.ruleId && (
          <button
            type="button"
            onClick={() => onFilters({ ...filters, ruleId: undefined })}
            className="inline-flex items-center gap-1 rounded-control border border-accent bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent-text"
            title="Showing only alerts raised by this rule"
          >
            Rule: {ruleName || 'selected rule'}
            <Icon name="close" size={11} />
          </button>
        )}
        {hasFilters && (
          <Button
            size="sm" variant="ghost" icon="close"
            onClick={() => { setSearch(''); onFilters({}); }}
          >
            Clear
          </Button>
        )}
      </div>

      {error ? (
        <p className="rounded-control border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted">
          Alert history could not be loaded.
          {' '}
          {error?.response?.data?.detail || error?.message || ''}
        </p>
      ) : (
        <>
          <Table
            columns={columns}
            rows={rows}
            loading={loading}
            empty={(
              <EmptyState
                icon="bell"
                title={hasFilters ? 'No alerts match these filters' : 'Nothing has triggered'}
                // Two genuinely different empty states, and neither is "0".
                // The second explicitly points at the summary's inconclusive
                // count, because a quiet history plus unreadable rules is not
                // the same as a quiet estate.
                body={hasFilters
                  ? 'Clear the filters to see everything recorded for this account.'
                  : 'No alert has been raised on this account. That is a real result, not a missing one — rules that could not read their data source are counted separately as “Could not evaluate” above.'}
              />
            )}
          />
          {data?.truncated && (
            <p className="text-[11px] text-subtle">
              Showing the {data.returned} most recent. Narrow the filters to see
              older alerts.
            </p>
          )}
        </>
      )}
    </div>
  );
}
