import { useEffect, useMemo, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Table, { EmptyState } from '@/components/ui/Table';
import Pagination from '@/components/ui/Pagination';
import cn from '@/lib/cn';
import {
  categoryTone, costText, formatCount, freshnessMeta, providerLabel, relativeTime,
  riskMeta, statusMeta, typeIcon,
} from '../../utils/resourceModel';

/**
 * The inventory table.
 *
 * Rows, ordering and paging all come from the server. The browser never holds
 * more than one page, so the page stays responsive on an estate the size of the
 * whole account rather than the size of the viewport.
 *
 * Sorting is likewise a server concern: sorting a page client-side would order
 * fifty rows and call it "most expensive", which is worse than not offering it.
 */

const TONE_BG = {
  info: 'bg-info-soft text-info-fg',
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success-soft text-success-fg',
  warning: 'bg-warning-soft text-warning-fg',
  danger: 'bg-danger-soft text-danger-fg',
  neutral: 'bg-neutral-soft text-muted',
};

/** Column definitions. `always` columns cannot be switched off — without a name
 *  a row cannot be identified at all. */
export const COLUMNS = [
  { key: 'risk', label: 'Risk', sortable: true, sortKey: 'risk', width: 92, default: true },
  { key: 'name', label: 'Resource', sortable: true, sortKey: 'resource_name', always: true },
  { key: 'type', label: 'Type', sortable: true, sortKey: 'resource_type', default: true },
  { key: 'service', label: 'Service', sortable: true, sortKey: 'service', default: false },
  { key: 'provider', label: 'Provider', sortable: true, sortKey: 'provider', default: false },
  { key: 'account', label: 'Account', sortable: true, sortKey: 'account', default: false },
  { key: 'region', label: 'Region', sortable: true, sortKey: 'region', default: true },
  // Status and Cost are OFF by default, and still available from the Columns
  // picker. Both were columns of nothing on the estates people actually look
  // at: AWS reports no resource-level billing at all, so Cost was 227 rows of
  // "NA", and most inventory types (IAM roles, buckets, security groups) have
  // no runtime state, so Status was 133 rows of "Not reported". A column that
  // is almost entirely one placeholder costs horizontal space on every row and
  // teaches people to stop reading it — which is worse than not showing it,
  // because the handful of rows where it DOES say something get skipped too.
  { key: 'status', label: 'Status', sortable: true, sortKey: 'status', default: false },
  { key: 'cost', label: 'Cost', sortable: true, sortKey: 'cost', align: 'right', default: false },
  { key: 'tags', label: 'Tags', sortable: true, sortKey: 'tag_count', width: 70, default: true },
  // "Attached to" is off for the same reason as Status and Cost: only storage
  // volumes carry an attachment, so on a general inventory it is a column of
  // em dashes. It stays in the picker for the storage-heavy estates where it
  // is the whole point.
  { key: 'related', label: 'Attached to', default: false },
  { key: 'lastSeen', label: 'Last seen', sortable: true, sortKey: 'last_seen', default: true },
  { key: 'ip', label: 'IP', default: false },
  { key: 'environment', label: 'Environment', sortable: true, sortKey: 'environment', default: false },
  { key: 'owner', label: 'Owner', sortable: true, sortKey: 'owner', default: false },
  { key: 'resourceGroup', label: 'Resource group', default: false },
  { key: 'compartment', label: 'Compartment', default: false },
  { key: 'findings', label: 'Findings', sortable: true, sortKey: 'finding_count', align: 'right', default: false },
  { key: 'updated', label: 'Last changed', sortable: true, sortKey: 'updated_at', default: false },
  { key: 'discovered', label: 'First seen', sortable: true, sortKey: 'discovered_at', default: false },
];

/**
 * Versioned on purpose.
 *
 * Column choice persists per browser, which means a change to the DEFAULT set
 * is invisible to everyone who has already loaded the page once — their stored
 * list wins forever. Turning Status, Cost and "Attached to" off by default did
 * nothing at all until this key changed, because every existing browser was
 * still replaying a preference saved before they were removed.
 *
 * Bumping the suffix resets everyone to the current defaults once. That does
 * discard a layout somebody set up by hand, which is the cost of the fix —
 * paid once, and only when the default set genuinely changes. The old key is
 * left in place rather than deleted: it is a few hundred bytes, and reading it
 * is how a future migration could recover a customisation if that ever
 * mattered.
 */
const STORAGE_KEY = 'cloud.resources.columns.v2';

export const defaultColumnKeys = () => COLUMNS
  .filter((c) => c.always || c.default)
  .map((c) => c.key);

/** Column choice persists per user, so a layout someone set up for their own
 *  work survives a reload. Wrapped because localStorage throws in private
 *  windows and a filter preference is not worth a blank page. */
export function useColumnPreference() {
  const [keys, setKeys] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (Array.isArray(stored) && stored.length) {
        const valid = stored.filter((k) => COLUMNS.some((c) => c.key === k));
        return Array.from(new Set([...COLUMNS.filter((c) => c.always).map((c) => c.key), ...valid]));
      }
    } catch { /* unreadable preference is not an error worth surfacing */ }
    return defaultColumnKeys();
  });

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(keys)); } catch { /* ignore */ }
  }, [keys]);

  return [keys, setKeys];
}

const Cell = {
  risk: (row) => {
    const meta = riskMeta(row.risk?.level);
    if (row.risk?.level === 'UNKNOWN') {
      return (
        <span className="text-meta text-subtle" title={row.risk?.reason || undefined}>
          Not assessed
        </span>
      );
    }
    if (row.risk?.level === 'NONE') {
      return <span className="text-meta text-subtle">—</span>;
    }
    return (
      <Badge tone={meta.tone} size="xs" title={`${row.risk.finding_count} open finding(s)`}>
        {meta.label}
        {row.risk.finding_count > 0 && (
          <span className="tabular-nums opacity-80">{row.risk.finding_count}</span>
        )}
      </Badge>
    );
  },

  name: (row) => {
    const TypeIcon = typeIcon(row.type_icon);
    const tone = categoryTone(row.normalized_type);
    return (
      <div className="flex items-center gap-2.5">
        <span className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-control',
          row.is_default ? TONE_BG.neutral : TONE_BG[tone] || TONE_BG.neutral,
        )}
        >
          <TypeIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={cn('truncate font-semibold', row.is_default ? 'text-muted' : 'text-fg')}>
              {row.resource_name || row.provider_resource_id}
            </span>
            {row.is_default && (
              <Badge tone="neutral" size="xs" className="uppercase tracking-wide">default</Badge>
            )}
          </div>
          <div className="truncate text-meta text-subtle" title={row.provider_resource_id}>
            {row.provider_resource_id}
          </div>
        </div>
      </div>
    );
  },

  type: (row) => (
    <div className="min-w-0">
      <div className="truncate text-fg">{row.type_label || row.resource_type}</div>
      {/* The service first: "AWS Lambda" says more than "Serverless". */}
      <div className="truncate text-meta text-subtle" title={row.service_label || row.category_label}>
        {[row.service_label, row.category_label].filter(Boolean).join(' · ')}
      </div>
    </div>
  ),

  service: (row) => <span className="truncate text-muted">{row.service_label || <span className="text-subtle">—</span>}</span>,

  provider: (row) => <span className="text-muted">{providerLabel(row.provider)}</span>,
  account: (row) => <span className="truncate text-muted">{row.account_name || '—'}</span>,

  region: (row) => (
    <span className="inline-flex items-center gap-1 text-muted">
      {row.region || <span className="text-subtle">Not reported</span>}
    </span>
  ),

  status: (row) => {
    const meta = statusMeta(row.status);
    return (
      <Badge
        tone={meta.tone}
        size="xs"
        title={
          row.status_reason
          || (row.raw_status ? `Provider state: ${row.raw_status}` : undefined)
        }
      >
        {meta.dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
        {meta.label}
      </Badge>
    );
  },

  cost: (row) => {
    const cost = costText(row.cost);
    return (
      <span
        className={cn('tabular-nums', cost.available ? 'font-semibold text-fg' : 'text-subtle')}
        title={cost.title}
      >
        {cost.text}
      </span>
    );
  },

  tags: (row) => (row.tag_count > 0 ? (
    <Badge tone="neutral" size="xs" title={
      Object.entries(row.tags || {}).map(([k, v]) => `${k}: ${v}`).join('\n')
    }
    >
      {row.tag_count}
    </Badge>
  ) : (
    <span className="text-meta text-subtle">None</span>
  )),

  related: (row) => {
    if (row.attached_to) {
      return (
        <span className="inline-flex items-center gap-1.5">
          <Icon name="link" size={13} className="shrink-0 text-accent-text" />
          <span className="truncate text-fg">{row.attached_to.name || row.attached_to.id}</span>
          {/* A volume attached to a stopped instance is still billing. That is
              the reason this column exists, so the state is called out. */}
          {/stop|deallocat/i.test(row.attached_to.status || '') && (
            <Badge tone="danger" size="xs" className="uppercase tracking-wide">stopped</Badge>
          )}
        </span>
      );
    }
    if (row.attachment_state === 'UNATTACHED') {
      return (
        <span className="inline-flex items-center gap-1.5 text-warning-fg">
          <Icon name="plug" size={13} className="shrink-0" />
          Unattached
        </span>
      );
    }
    return <span className="text-subtle">—</span>;
  },

  lastSeen: (row) => {
    const meta = freshnessMeta(row.freshness?.severity);
    const rel = relativeTime(row.freshness?.observed_at);
    return (
      <span
        className={cn('text-[12px]', row.freshness?.stale ? 'text-warning-fg' : 'text-muted')}
        title={[
          row.freshness?.label,
          row.freshness?.note,
        ].filter(Boolean).join('\n')}
      >
        {rel || meta.label}
      </span>
    );
  },

  ip: (row) => <span className="tabular-nums text-muted">{row.ip_address || <span className="text-subtle">—</span>}</span>,
  environment: (row) => <span className="text-muted">{row.environment || <span className="text-subtle">Not set</span>}</span>,
  owner: (row) => <span className="truncate text-muted">{row.owner || <span className="text-subtle">Not set</span>}</span>,
  resourceGroup: (row) => <span className="truncate text-muted">{row.resource_group || <span className="text-subtle">—</span>}</span>,
  compartment: (row) => <span className="truncate text-muted">{row.compartment || <span className="text-subtle">—</span>}</span>,
  findings: (row) => (
    <span className="tabular-nums text-muted">
      {row.risk?.assessed ? formatCount(row.risk.finding_count) : <span className="text-subtle">—</span>}
    </span>
  ),
  updated: (row) => (
    <span className="text-[12px] text-muted" title={row.updated_at || undefined}>
      {relativeTime(row.updated_at) || '—'}
    </span>
  ),
  discovered: (row) => (
    <span className="text-[12px] text-muted" title={row.discovered_at || undefined}>
      {relativeTime(row.discovered_at) || '—'}
    </span>
  ),
};

const SkeletonRows = ({ columns, count = 8 }) => Array.from({ length: count }).map((_, i) => ({
  // eslint-disable-next-line react/no-array-index-key
  key: `skeleton-${i}`,
  cells: Object.fromEntries(columns.map((c) => [
    c.key,
    <div key={c.key} className="h-4 animate-pulse rounded bg-sunken" />,
  ])),
}));

export default function ResourceInventoryTable({
  data, isLoading, isFetching, columnKeys, sort, onSort, page, pageSize,
  onPage, onPageSize, onOpen, emptyState,
  selectable = false, selectedKeys, onSelectionChange,
}) {
  const columns = useMemo(
    () => COLUMNS.filter((c) => columnKeys.includes(c.key)),
    [columnKeys],
  );

  const rows = data?.rows || [];

  const tableRows = isLoading
    ? SkeletonRows({ columns })
    : rows.map((row) => ({
      key: row.id,
      onClick: () => onOpen(row),
      cells: Object.fromEntries(columns.map((c) => [c.key, Cell[c.key](row)])),
    }));

  return (
    <div className="card overflow-hidden">
      <Table
        columns={columns}
        rows={tableRows}
        sort={sort}
        onSort={onSort}
        rowHeight={56}
        virtualize
        virtualizeThreshold={60}
        maxBodyHeight={700}
        selectable={selectable}
        selectedKeys={selectedKeys}
        onSelectionChange={onSelectionChange}
        empty={emptyState || (
          <EmptyState icon="search" title="No resources match your filters" body="Try clearing a filter." />
        )}
      />

      <Pagination
        page={page}
        pageCount={data?.page_count || 1}
        total={data?.total || 0}
        pageSize={pageSize}
        onPage={onPage}
        onPageSize={(value) => onPageSize(Number(value))}
        unit="resources"
        // 'All' is deliberately absent: the API caps a page at 250 rows.
        pageSizes={[
          { id: '10', label: '10' },
          { id: '25', label: '25' },
          { id: '50', label: '50' },
          { id: '100', label: '100' },
          { id: '250', label: '250' },
        ]}
      />

      {isFetching && !isLoading && (
        <div className="border-t border-border bg-sunken px-card py-1.5 text-meta text-muted">
          Updating…
        </div>
      )}
    </div>
  );
}

/** The column picker, kept beside the definitions it edits. */
export function ColumnPicker({ columnKeys, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button variant="secondary" size="sm" icon="layout-grid" onClick={() => setOpen((v) => !v)}>
        Columns
      </Button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close column picker"
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-30 mt-1 max-h-80 w-56 overflow-y-auto rounded-control border border-border bg-surface p-1.5 shadow-lg">
            {COLUMNS.map((c) => {
              const checked = columnKeys.includes(c.key);
              return (
                <label
                  key={c.key}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-[12px]',
                    c.always ? 'cursor-not-allowed opacity-60' : 'hover:bg-sunken',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={c.always}
                    onChange={() => onChange(
                      checked
                        ? columnKeys.filter((k) => k !== c.key)
                        : [...columnKeys, c.key],
                    )}
                    className="h-3.5 w-3.5 rounded border-border accent-[var(--accent)]"
                  />
                  <span className="text-fg">{c.label}</span>
                </label>
              );
            })}
            <button
              type="button"
              onClick={() => onChange(defaultColumnKeys())}
              className="mt-1 w-full rounded-control px-2 py-1.5 text-left text-[12px] text-muted hover:bg-sunken hover:text-fg"
            >
              Reset to defaults
            </button>
          </div>
        </>
      )}
    </div>
  );
}
