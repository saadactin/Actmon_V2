import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  GitCompareArrows, ShieldAlert, DollarSign, Share2, Activity, Tag, Settings2,
  ArrowUpRight, ArrowDownRight, Unlock, Lock, PlusCircle, MinusCircle, PencilLine,
  Bell, ExternalLink, Clock,
} from 'lucide-react';
import {
  useDriftChanges, useDriftSummary, useDriftFacets, useInventoryHistory, useResourceDrift,
} from '../hooks/useDrift';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudSection from '../components/CloudSection';
import CloudFilterBar from '../components/CloudFilterBar';
import Table, { EmptyState } from '@/components/ui/Table';
import Pagination from '@/components/ui/Pagination';
import Badge from '@/components/ui/Badge';
import Drawer from '@/components/ui/Drawer';
import { PageLoading, InlineLoading } from '@/components/ui/Loading';

const PAGE_SIZE = 50;

const RANGES = [
  { id: '7', label: 'Last 7 days' },
  { id: '30', label: 'Last 30 days' },
  { id: '90', label: 'Last 90 days' },
  { id: '365', label: 'Last 365 days' },
];

// The pillars a changed field can land on. Order is deliberate: the two that
// carry real consequence first, so the cards read left-to-right by how much
// someone needs to care.
const PILLARS = [
  { id: 'security', label: 'Security', icon: ShieldAlert, tone: 'danger' },
  { id: 'cost', label: 'Cost', icon: DollarSign, tone: 'warning' },
  { id: 'topology', label: 'Topology', icon: Share2, tone: 'info' },
  { id: 'availability', label: 'Availability', icon: Activity, tone: 'accent' },
  { id: 'governance', label: 'Governance', icon: Tag, tone: 'neutral' },
  { id: 'config', label: 'Other config', icon: Settings2, tone: 'neutral' },
];

const PILLAR_BY_ID = Object.fromEntries(PILLARS.map((p) => [p.id, p]));

const SEVERITY_TONE = {
  CRITICAL: 'danger',
  HIGH: 'danger',
  MEDIUM: 'warning',
  LOW: 'neutral',
};

const CHANGE_TYPE_META = {
  CREATED: { label: 'Created', tone: 'success', icon: PlusCircle },
  MODIFIED: { label: 'Modified', tone: 'info', icon: PencilLine },
  DELETED: { label: 'Deleted', tone: 'danger', icon: MinusCircle },
};

// Only the four transitions the backend can prove from the two values. Anything
// else carries no direction at all rather than a guessed one.
const DIRECTION_META = {
  MORE_OPEN: { label: 'Now internet-reachable', tone: 'danger', icon: Unlock },
  MORE_RESTRICTIVE: { label: 'More restricted', tone: 'success', icon: Lock },
  SCALE_UP: { label: 'Capacity up', tone: 'warning', icon: ArrowUpRight },
  SCALE_DOWN: { label: 'Capacity down', tone: 'success', icon: ArrowDownRight },
};

const relativeTime = (iso) => {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
};

/** Field path stripped of its container prefix for display. */
const fieldLabel = (path) => {
  if (!path) return null;
  if (path.startsWith('config.')) return path.slice(7);
  if (path.startsWith('metadata.')) return path.slice(9);
  if (path.startsWith('tags.')) return `tag: ${path.slice(5)}`;
  return path;
};

const StatCard = ({ icon: Icon, label, value, tone = 'neutral', active, onClick, hint }) => {
  const TONE_BG = {
    danger: 'bg-danger-soft text-danger-fg',
    warning: 'bg-warning-soft text-warning-fg',
    info: 'bg-info-soft text-info-fg',
    accent: 'bg-accent-soft text-accent-text',
    success: 'bg-success-soft text-success-fg',
    neutral: 'bg-sunken text-muted',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`flex items-center gap-3 rounded-card border p-3 text-left transition-colors disabled:cursor-default ${
        active ? 'border-accent bg-accent-soft' : 'border-border bg-surface'
      } ${onClick ? 'hover:border-accent' : ''}`}
    >
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-control ${TONE_BG[tone]}`}>
        <Icon size={17} />
      </span>
      <span className="min-w-0">
        <span className="block text-[18px] font-semibold leading-tight text-fg">{value}</span>
        <span className="block truncate text-[11px] text-muted">{label}</span>
        {hint && <span className="block truncate text-[10px] text-subtle">{hint}</span>}
      </span>
    </button>
  );
};

/** Value pill for the from → to columns. */
const ValueChip = ({ value, muted }) => (
  <span
    title={value || undefined}
    className={`inline-block max-w-[220px] truncate rounded-control px-1.5 py-0.5 font-mono text-[11px] ${
      muted ? 'bg-sunken text-subtle' : 'bg-sunken text-fg'
    }`}
  >
    {value || '—'}
  </span>
);

/** Per-day bar strip. Purely a shape-of-the-window read, so it stays deliberately
    minimal — no axis, no library, just relative heights with real counts on hover. */
const DayBars = ({ days }) => {
  if (!days?.length) return null;
  const max = Math.max(...days.map((d) => d.count), 1);
  return (
    <div className="flex items-end gap-0.5 h-10">
      {days.map((d) => (
        <div
          key={d.date}
          title={`${d.date}: ${d.count} change${d.count === 1 ? '' : 's'}`}
          className="flex-1 min-w-[3px] rounded-t bg-accent/70 hover:bg-accent"
          style={{ height: `${Math.max(8, (d.count / max) * 100)}%` }}
        />
      ))}
    </div>
  );
};

/** One resource's full timeline, opened from a row. This is the
    "what changed on this resource over time" view, alongside the state that
    change left behind: current status and any alert still open against it. */
const ResourceTimelineDrawer = ({ resourceId, open, onClose }) => {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useResourceDrift(open ? resourceId : null);
  const resource = data?.resource;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={resource?.resource_name || 'Change history'}
      subtitle={resource ? `${resource.resource_type} · ${resource.region_or_zone || 'global'}` : undefined}
      width={560}
    >
      {isLoading ? (
        <InlineLoading label="Loading history…" />
      ) : isError || !data ? (
        <p className="text-sm text-muted">
          Could not load this resource&apos;s history. It may have been removed from inventory.
        </p>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-control bg-sunken p-2">
              <span className="block text-[10px] uppercase tracking-wide text-subtle">Status now</span>
              <span className="font-semibold text-fg">{resource.status || 'n/a'}</span>
            </div>
            <div className="rounded-control bg-sunken p-2">
              <span className="block text-[10px] uppercase tracking-wide text-subtle">Last scanned</span>
              <span className="font-semibold text-fg">{relativeTime(resource.updated_at)}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => { onClose(); navigate(`/cloud/resources/${resource.id}`); }}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent-text hover:text-accent-hover"
          >
            Open resource <ExternalLink size={12} />
          </button>

          {/* Cross-pillar link: drift on a resource that already has an open
              alert is the pairing worth looking at before anything else. */}
          {data.active_alerts?.length > 0 && (
            <div className="rounded-card border border-danger/40 bg-danger-soft/40 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-danger-fg">
                <Bell size={13} />
                {data.active_alerts.length} active alert
                {data.active_alerts.length === 1 ? '' : 's'} on this resource
              </p>
              <ul className="mt-2 space-y-1">
                {data.active_alerts.map((a) => (
                  <li key={a.id} className="text-[11px] text-muted">
                    <Badge tone={SEVERITY_TONE[a.severity] || 'neutral'} size="xs">{a.severity}</Badge>{' '}
                    {a.anomaly_type} — {a.details}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-subtle">
              {data.changes.length} recorded change{data.changes.length === 1 ? '' : 's'}
            </p>
            {data.changes.length === 0 ? (
              <p className="text-xs text-muted">
                Nothing has changed on this resource since it was first inventoried.
              </p>
            ) : (
              <ol className="space-y-3 border-l border-border pl-4">
                {data.changes.map((c) => {
                  const dir = DIRECTION_META[c.direction];
                  return (
                    <li key={c.id} className="relative">
                      <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-accent" />
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={SEVERITY_TONE[c.severity] || 'neutral'} size="xs">{c.severity}</Badge>
                        {c.field_path && (
                          <span className="font-mono text-[11px] font-semibold text-fg">
                            {fieldLabel(c.field_path)}
                          </span>
                        )}
                        {dir && <Badge tone={dir.tone} size="xs">{dir.label}</Badge>}
                        <span className="ml-auto text-[10px] text-subtle">{relativeTime(c.detected_at)}</span>
                      </div>
                      {c.field_path && c.old_value !== null && !c.value_vanished ? (
                        <p className="mt-1 flex items-center gap-1.5 text-[11px]">
                          <ValueChip value={c.old_value} muted />
                          <span className="text-subtle">→</span>
                          <ValueChip value={c.new_value} />
                        </p>
                      ) : (
                        <p className="mt-1 text-[11px] text-muted">{c.summary}</p>
                      )}
                      <p className="mt-0.5 flex flex-wrap gap-1">
                        {(c.impact || []).map((p) => (
                          <span key={p} className="text-[10px] text-subtle">
                            {PILLAR_BY_ID[p]?.label || p}
                          </span>
                        ))}
                      </p>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
};

const HISTORY_PAGE_SIZE = 50;

/**
 * Inventory history — what exists and when it came into being.
 *
 * The change log can only start from the day drift capture was switched on:
 * every earlier value was overwritten by the scan that followed it and is gone
 * for good. This panel reaches further back using what IS still on file.
 *
 * Two dates, kept separate on purpose:
 *
 *   Created     the provider's own timestamp. Authoritative, and it goes back
 *               years — 30 months of it on the OCI account. Not every provider
 *               offers one (Azure Resource Graph returns none), so the coverage
 *               is stated rather than left as an unexplained column of blanks.
 *   First seen  when this system first recorded the row. Always available, but
 *               it moves whenever scanner coverage improves, so a cluster of
 *               identical dates usually means "we started looking here", not
 *               "these were all built that day". Merging it into Created would
 *               invent history that never happened.
 */
const InventoryHistoryPanel = ({ accountId, onOpenResource }) => {
  const [sort, setSort] = useState('created');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching } = useInventoryHistory(accountId, {
    sort, search, page, pageSize: HISTORY_PAGE_SIZE,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const coverage = data?.coverage;
  const pageCount = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const noProviderDates = coverage && coverage.with_provider_timestamp === 0;

  const columns = [
    { key: 'created', label: 'Created', width: '150px' },
    { key: 'resource', label: 'Resource' },
    { key: 'type', label: 'Type', width: '150px' },
    { key: 'region', label: 'Region', width: '130px' },
    { key: 'firstSeen', label: 'First seen', width: '120px' },
  ];

  const rows = items.map((r) => ({
    key: r.resource_id,
    onClick: () => onOpenResource(r.resource_id),
    cells: {
      created: r.created_at ? (
        <span
          className="whitespace-nowrap text-[12px] text-fg"
          title={`${new Date(r.created_at).toLocaleString()} (provider field: ${r.created_at_source})`}
        >
          {new Date(r.created_at).toLocaleDateString()}
        </span>
      ) : (
        <span className="text-[11px] italic text-subtle" title="This provider does not report a creation timestamp for this resource.">
          not reported
        </span>
      ),
      resource: (
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-fg" title={r.provider_resource_id}>
            {r.resource_name || r.provider_resource_id}
          </p>
          {r.status && <p className="truncate text-[11px] text-subtle">{r.status}</p>}
        </div>
      ),
      type: <span className="text-[12px] text-muted">{r.resource_type}</span>,
      region: <span className="text-[12px] text-muted">{r.region_or_zone || '—'}</span>,
      firstSeen: (
        <span className="whitespace-nowrap text-[11px] text-subtle">
          {r.first_seen ? new Date(r.first_seen).toLocaleDateString() : '—'}
        </span>
      ),
    },
  }));

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <CloudSection
        title="Inventory history"
        description="Newest first. Click a row for that resource's change timeline."
        bodyClassName="space-y-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <CloudFilterBar
            search={search}
            onSearchChange={(v) => { setSearch(v); setPage(1); }}
            searchPlaceholder="Search resource name, id or type…"
          />
          <div className="inline-flex rounded-control border border-border bg-surface p-0.5">
            {[
              { id: 'created', label: 'By created' },
              { id: 'first_seen', label: 'By first seen' },
            ].map((s) => (
              <button
                key={s.id}
                onClick={() => { setSort(s.id); setPage(1); }}
                className={`rounded-control px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  sort === s.id ? 'bg-accent-soft text-accent-text' : 'text-muted hover:text-fg'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {noProviderDates && (
          <p className="rounded-control bg-warning-soft px-2.5 py-2 text-[11px] leading-relaxed text-warning-fg">
            This provider reports no creation timestamps, so the Created column is
            empty for all {coverage.total_resources} resources. Only “First seen”
            is available here — and that is when this system first recorded the
            resource, which is not the same as when it was built.
          </p>
        )}

        {isLoading ? (
          <InlineLoading label="Loading inventory history…" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="boxes"
            title={search ? 'No resources match that search' : 'No resources on file'}
            body={search ? 'Try a different term.' : 'Run a discovery scan to populate the inventory.'}
          />
        ) : (
          <>
            <div className={isFetching ? 'opacity-60 transition-opacity' : undefined}>
              <Table columns={columns} rows={rows} />
            </div>
            <Pagination
              page={page}
              pageCount={pageCount}
              total={total}
              pageSize={HISTORY_PAGE_SIZE}
              onPage={setPage}
              unit="resources"
            />
          </>
        )}
      </CloudSection>

      <div className="space-y-4">
        <CloudSection title="Created per month" description="From the provider's own timestamps">
          {data?.by_month?.length ? (
            <MonthBars months={data.by_month} field="created" />
          ) : (
            <p className="text-xs text-muted">No creation dates available.</p>
          )}
        </CloudSection>

        <CloudSection title="First seen per month" description="When this system started recording them">
          {data?.by_month?.length ? (
            <MonthBars months={data.by_month} field="first_seen" tone="subtle" />
          ) : (
            <p className="text-xs text-muted">No data.</p>
          )}
        </CloudSection>

        {coverage && (
          <CloudSection title="Coverage">
            <dl className="space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted">Resources on file</dt>
                <dd className="font-semibold text-fg">{coverage.total_resources}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted">With a provider creation date</dt>
                <dd className="font-semibold text-fg">{coverage.with_provider_timestamp}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted">Without one</dt>
                <dd className="font-semibold text-fg">{coverage.without_provider_timestamp}</dd>
              </div>
            </dl>
          </CloudSection>
        )}

        <p className="flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-subtle">
          <Clock size={12} className="mt-0.5 shrink-0" />
          This view answers “when did this come into existence”. It cannot show
          modifications made before drift capture was switched on — the previous
          values were overwritten by the scan that followed them. Field-level
          changes from here on appear under Change log.
        </p>
      </div>
    </div>
  );
};

/** Month buckets as a bar strip. Same minimal treatment as DayBars. */
const MonthBars = ({ months, field, tone }) => {
  const max = Math.max(...months.map((m) => m[field] || 0), 1);
  return (
    <div className="flex items-end gap-0.5 h-12">
      {months.map((m) => (
        <div
          key={m.month}
          title={`${m.month}: ${m[field] || 0} resource${m[field] === 1 ? '' : 's'}`}
          // The token is --color-subtle (index.css), so the utility is
          // bg-subtle. bg-fg-subtle matches nothing and Tailwind drops unknown
          // utilities silently, which renders the bars invisible.
          className={`flex-1 min-w-[3px] rounded-t ${
            tone === 'subtle' ? 'bg-subtle/40 hover:bg-subtle/70' : 'bg-accent/70 hover:bg-accent'
          }`}
          style={{ height: `${Math.max(4, ((m[field] || 0) / max) * 100)}%` }}
        />
      ))}
    </div>
  );
};

/**
 * Configuration Drift — the change history the inventory table cannot hold.
 *
 * Each discovery scan overwrites `cloud_resources` with current state, so the
 * previous value is gone the moment a new sweep lands. This page reads the
 * append-only log written during that overwrite: what field moved, from what
 * to what, and which pillar it lands on.
 *
 * Sits beside Alerts on purpose. An alert says a condition is true right now;
 * this says what changed to make it true, which is the question the Alerts tab
 * has never been able to answer.
 */
export const ConfigDriftPage = ({ embedded = false, accountId }) => {
  const [days, setDays] = useState('30');
  const [impact, setImpact] = useState('');
  const [changeType, setChangeType] = useState('');
  const [severity, setSeverity] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [direction, setDirection] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [openResourceId, setOpenResourceId] = useState(null);
  // 'log' = field-level diffs since drift capture began.
  // 'history' = creation dates, which reach back before this tab existed.
  const [view, setView] = useState('log');

  const numericDays = Number(days);
  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryFailed,
    error: summaryError,
  } = useDriftSummary(accountId, numericDays);
  const { data: facets } = useDriftFacets(accountId, numericDays);
  const { data: changes, isLoading: changesLoading, isFetching } = useDriftChanges(
    accountId,
    numericDays,
    { impact, changeType, severity, resourceType, direction, search, page, pageSize: PAGE_SIZE },
  );

  const rows = changes?.items ?? [];
  const total = changes?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Any filter change invalidates the current page number.
  const setFilter = (setter) => (value) => { setter(value); setPage(1); };

  const activeFilterCount = [impact, changeType, severity, resourceType, direction, search]
    .filter(Boolean).length;

  const resourceTypeOptions = useMemo(() => [
    { id: '', label: 'All resource types' },
    ...(facets?.resource_types || []).map((t) => ({ id: t, label: t })),
  ], [facets]);

  const columns = [
    { key: 'when', label: 'When', width: '110px' },
    { key: 'resource', label: 'Resource' },
    { key: 'change', label: 'Change' },
    { key: 'from', label: 'From' },
    { key: 'to', label: 'To' },
    { key: 'impact', label: 'Impact', width: '190px' },
  ];

  const tableRows = rows.map((c) => {
    const typeMeta = CHANGE_TYPE_META[c.change_type] || CHANGE_TYPE_META.MODIFIED;
    const dir = DIRECTION_META[c.direction];
    const TypeIcon = typeMeta.icon;
    return {
      key: c.id,
      // Every row points at a real resource row, except a DELETED one whose
      // inventory row is gone by design — those open nothing rather than a 404.
      onClick: c.resource_id && c.change_type !== 'DELETED'
        ? () => setOpenResourceId(c.resource_id)
        : undefined,
      cells: {
        when: (
          <span className="whitespace-nowrap text-[11px] text-muted" title={new Date(c.detected_at).toLocaleString()}>
            {relativeTime(c.detected_at)}
          </span>
        ),
        resource: (
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-fg" title={c.provider_resource_id}>
              {c.resource_name || c.provider_resource_id}
            </p>
            <p className="truncate text-[11px] text-subtle">
              {c.resource_type}
              {c.region_or_zone ? ` · ${c.region_or_zone}` : ''}
              {!accountId && c.account_name ? ` · ${c.account_name}` : ''}
            </p>
          </div>
        ),
        change: (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={typeMeta.tone} size="xs">
              <TypeIcon size={10} /> {typeMeta.label}
            </Badge>
            {c.field_path && (
              <span className="font-mono text-[11px] font-semibold text-fg">{fieldLabel(c.field_path)}</span>
            )}
            <Badge tone={SEVERITY_TONE[c.severity] || 'neutral'} size="xs">{c.severity}</Badge>
          </div>
        ),
        // old_value is null (not the string '—') when the field had no stored
        // predecessor: the previous scan never collected it, so there is no
        // before value. Showing a dash there would read as "it was empty".
        from: !c.field_path
          ? <span className="text-subtle">—</span>
          : c.old_value === null
            ? (
              <span className="text-[11px] italic text-subtle" title={c.summary}>
                not collected before
              </span>
            )
            : <ValueChip value={c.old_value} muted />,
        // A vanished value is not the same claim as a changed one: the field
        // stopped being reported, which can mean removed or can mean the
        // provider call that supplies it did not answer. Say that, don't
        // render a bare dash and let it read as a confirmed removal.
        to: !c.field_path
          ? <span className="truncate text-[11px] text-muted" title={c.summary}>{c.summary}</span>
          : c.value_vanished
            ? (
              <span className="text-[11px] text-warning-fg" title={c.summary}>
                no longer reported
              </span>
            )
            : <ValueChip value={c.new_value} />,
        impact: (
          <div className="flex flex-wrap items-center gap-1">
            {(c.impact || []).map((p) => {
              const meta = PILLAR_BY_ID[p];
              return (
                <Badge key={p} tone={meta?.tone || 'neutral'} size="xs">{meta?.label || p}</Badge>
              );
            })}
            {dir && <Badge tone={dir.tone} size="xs"><dir.icon size={10} /> {dir.label}</Badge>}
          </div>
        ),
      },
    };
  });

  // Never had a second scan to compare against — a genuinely different message
  // from "nothing changed", and the one users would otherwise misread.
  const noBaseline = summary && !summary.has_history;

  return (
    <>
      {!embedded && (
        <CloudPageHeader
          backTo="/cloud"
          icon="activity"
          title="Configuration Drift"
          description="What changed on your cloud resources, when, and which pillar it affects."
        />
      )}

      {!accountId ? (
        // Every query here is account-scoped, so without one there is nothing
        // to fetch — say so rather than render a page of zeroes.
        <div className="rounded-card border border-border bg-surface py-12">
          <EmptyState
            icon="cloud"
            title="Pick a cloud account"
            body="Configuration drift is tracked per account. Open an account from the Cloud hub to see its change history."
          />
        </div>
      ) : summaryLoading ? (
        <PageLoading title="Loading change history…" />
      ) : summaryFailed ? (
        // Without this, a failed request fell through to the normal view and
        // painted every counter as 0 — which reads as "nothing has changed",
        // the one conclusion the page had no evidence for. A 404 specifically
        // means the cloud service is serving a build that predates this tab.
        <div className="rounded-card border border-border bg-surface py-12">
          <EmptyState
            icon="alert"
            title="Couldn't load change history"
            body={
              summaryError?.response?.status === 404
                ? 'The cloud service does not have the drift endpoints yet — it is running a build from before this tab existed. Restart it (Backend/cloud: .\\start.ps1 -Force) and reload.'
                : `The cloud service returned ${summaryError?.response?.status ?? 'an error'}${
                  summaryError?.message ? ` (${summaryError.message})` : ''
                }. This is a request failure, not an empty change log.`
            }
          />
        </div>
      ) : (
        <div className="space-y-4">
          {/* ── View switch ───────────────────────────────────────────────────
              Two genuinely different questions, so two views rather than one
              blended list. The change log is field-level and starts the day
              drift capture began; the history reaches back years but can only
              speak to when things were created. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-control border border-border bg-surface p-0.5">
              {[
                { id: 'log', label: 'Change log', count: summary?.total_changes ?? 0 },
                { id: 'history', label: 'Inventory history' },
              ].map((v) => (
                <button
                  key={v.id}
                  onClick={() => setView(v.id)}
                  className={`inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-xs font-semibold transition-colors ${
                    view === v.id ? 'bg-accent-soft text-accent-text' : 'text-muted hover:text-fg'
                  }`}
                >
                  {v.label}
                  {v.count !== undefined && (
                    <span className="rounded-full bg-neutral-soft px-1.5 text-[10px] text-muted">
                      {v.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {view === 'log' && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-subtle">Window</span>
                {RANGES.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => { setDays(r.id); setPage(1); }}
                    className={`rounded-control border px-3 py-1.5 text-xs font-semibold transition-colors ${
                      days === r.id
                        ? 'border-accent bg-accent-soft text-accent-text'
                        : 'border-border bg-surface text-muted hover:text-fg'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {view === 'history' ? (
            <InventoryHistoryPanel accountId={accountId} onOpenResource={setOpenResourceId} />
          ) : noBaseline ? (
            <div className="rounded-card border border-border bg-surface py-12">
              <EmptyState
                icon="clock"
                title="No baseline to compare against yet"
                body="Drift is the difference between two scans. This account has only been scanned once, so there is nothing to diff — changes will start appearing after the next discovery run."
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                {PILLARS.map((p) => (
                  <StatCard
                    key={p.id}
                    icon={p.icon}
                    tone={p.tone}
                    label={p.label}
                    value={summary?.by_impact?.[p.id] ?? 0}
                    active={impact === p.id}
                    onClick={() => setFilter(setImpact)(impact === p.id ? '' : p.id)}
                  />
                ))}
              </div>

              {/* ── The two transitions worth calling out on their own ─────── */}
              {(summary?.newly_exposed > 0 || summary?.scaled_up > 0
                || summary?.correlation?.with_active_alerts > 0) && (
                <div className="grid gap-3 md:grid-cols-3">
                  {summary.newly_exposed > 0 && (
                    <StatCard
                      icon={Unlock}
                      tone="danger"
                      value={summary.newly_exposed}
                      label="Became internet-reachable"
                      hint="A field flipped to its public setting"
                      active={direction === 'MORE_OPEN'}
                      onClick={() => setFilter(setDirection)(direction === 'MORE_OPEN' ? '' : 'MORE_OPEN')}
                    />
                  )}
                  {summary.scaled_up > 0 && (
                    <StatCard
                      icon={ArrowUpRight}
                      tone="warning"
                      value={summary.scaled_up}
                      label="Capacity increased"
                      hint="Provable from the two values — not a cost estimate"
                      active={direction === 'SCALE_UP'}
                      onClick={() => setFilter(setDirection)(direction === 'SCALE_UP' ? '' : 'SCALE_UP')}
                    />
                  )}
                  {summary.correlation?.with_active_alerts > 0 && (
                    <StatCard
                      icon={Bell}
                      tone="danger"
                      value={summary.correlation.with_active_alerts}
                      label="Changed AND has an open alert"
                      hint="Where drift and a live finding overlap"
                    />
                  )}
                </div>
              )}

              <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
                {/* ── Change log ─────────────────────────────────────────── */}
                <CloudSection
                  title="Change log"
                  description="Newest first. Click a row for that resource's full history."
                  action={
                    activeFilterCount > 0 ? (
                      <button
                        onClick={() => {
                          setImpact(''); setChangeType(''); setSeverity('');
                          setResourceType(''); setDirection(''); setSearch(''); setPage(1);
                        }}
                        className="text-xs font-semibold text-accent-text hover:text-accent-hover"
                      >
                        Clear {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'}
                      </button>
                    ) : undefined
                  }
                  bodyClassName="space-y-3"
                >
                  <CloudFilterBar
                    search={search}
                    onSearchChange={setFilter(setSearch)}
                    searchPlaceholder="Search resource, field or summary…"
                    filters={[
                      {
                        key: 'changeType',
                        value: changeType,
                        onChange: setFilter(setChangeType),
                        options: [
                          { id: '', label: 'All change types' },
                          { id: 'MODIFIED', label: 'Modified' },
                          { id: 'CREATED', label: 'Created' },
                          { id: 'DELETED', label: 'Deleted' },
                        ],
                      },
                      {
                        key: 'severity',
                        value: severity,
                        onChange: setFilter(setSeverity),
                        options: [
                          { id: '', label: 'All severities' },
                          { id: 'CRITICAL', label: 'Critical' },
                          { id: 'HIGH', label: 'High' },
                          { id: 'MEDIUM', label: 'Medium' },
                          { id: 'LOW', label: 'Low' },
                        ],
                      },
                      {
                        key: 'resourceType',
                        value: resourceType,
                        onChange: setFilter(setResourceType),
                        options: resourceTypeOptions,
                      },
                    ]}
                  />

                  {changesLoading ? (
                    <InlineLoading label="Loading changes…" />
                  ) : tableRows.length === 0 ? (
                    <EmptyState
                      icon="check"
                      title={activeFilterCount > 0 ? 'No changes match these filters' : 'No configuration changes'}
                      body={
                        activeFilterCount > 0
                          ? 'Widen the window or clear a filter.'
                          : 'Nothing tracked has changed in this window. Usage counters and provider payload churn are deliberately excluded, so this stays a record of real configuration change.'
                      }
                    />
                  ) : (
                    <>
                      <div className={isFetching ? 'opacity-60 transition-opacity' : undefined}>
                        <Table columns={columns} rows={tableRows} />
                      </div>
                      <Pagination
                        page={page}
                        pageCount={pageCount}
                        total={total}
                        pageSize={PAGE_SIZE}
                        onPage={setPage}
                        unit="changes"
                      />
                    </>
                  )}
                </CloudSection>

                {/* ── Right rail ────────────────────────────────────────── */}
                <div className="space-y-4">
                  <CloudSection title="Activity" description={`Changes per day over ${numericDays} days`}>
                    {summary?.by_day?.length ? (
                      <DayBars days={summary.by_day} />
                    ) : (
                      <p className="text-xs text-muted">No activity in this window.</p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {Object.entries(CHANGE_TYPE_META).map(([id, meta]) => {
                        const n = summary?.by_change_type?.[id] ?? 0;
                        return (
                          <button
                            key={id}
                            disabled={n === 0 && changeType !== id}
                            onClick={() => setFilter(setChangeType)(changeType === id ? '' : id)}
                            className={`inline-flex items-center gap-1 rounded-control border px-2 py-1 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                              changeType === id
                                ? 'border-accent bg-accent-soft text-accent-text'
                                : 'border-border bg-surface text-muted hover:text-fg'
                            }`}
                          >
                            {meta.label}
                            <span className="rounded-full bg-neutral-soft px-1.5 text-[10px] text-muted">{n}</span>
                          </button>
                        );
                      })}
                    </div>
                  </CloudSection>

                  <CloudSection title="Most changed" description="Where to look first">
                    {summary?.top_resources?.length ? (
                      <ul className="space-y-1.5">
                        {summary.top_resources.map((r) => (
                          <li key={r.provider_resource_id}>
                            <button
                              type="button"
                              disabled={!r.resource_id}
                              onClick={() => setOpenResourceId(r.resource_id)}
                              className="flex w-full items-center justify-between gap-2 rounded-control px-2 py-1.5 text-left text-xs transition-colors hover:bg-sunken disabled:cursor-default disabled:hover:bg-transparent"
                            >
                              <span className="min-w-0">
                                <span className="block truncate font-medium text-fg">
                                  {r.resource_name || r.provider_resource_id}
                                </span>
                                <span className="block truncate text-[10px] text-subtle">
                                  {r.resource_type} · {relativeTime(r.last_change)}
                                </span>
                              </span>
                              <Badge tone="neutral" size="xs">{r.changes}</Badge>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted">Nothing changed in this window.</p>
                    )}
                  </CloudSection>

                  <CloudSection title="By resource type">
                    {summary?.by_resource_type?.length ? (
                      <ul className="space-y-1">
                        {summary.by_resource_type.map((t) => (
                          <li key={t.resource_type}>
                            <button
                              type="button"
                              onClick={() => setFilter(setResourceType)(
                                resourceType === t.resource_type ? '' : t.resource_type,
                              )}
                              className={`flex w-full items-center justify-between gap-2 rounded-control px-2 py-1 text-xs transition-colors ${
                                resourceType === t.resource_type
                                  ? 'bg-accent-soft font-semibold text-accent-text'
                                  : 'text-muted hover:bg-sunken'
                              }`}
                            >
                              <span className="truncate">{t.resource_type}</span>
                              <span className="text-[10px] font-bold text-subtle">{t.count}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted">No changes in this window.</p>
                    )}
                  </CloudSection>

                  {/* Says out loud what the log leaves out, so an empty page is
                      never mistaken for "nothing is happening". */}
                  <p className="flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-subtle">
                    <Clock size={12} className="mt-0.5 shrink-0" />
                    Drift is detected by comparing each discovery scan against the previous
                    one, so the granularity is your scan interval. Usage counters
                    (item counts, metered bytes, free IPs) and raw provider payloads are
                    excluded. A scan that could not enumerate every scope has its
                    diffs discarded rather than reported as change.
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <ResourceTimelineDrawer
        resourceId={openResourceId}
        open={!!openResourceId}
        onClose={() => setOpenResourceId(null)}
      />
    </>
  );
};

export default ConfigDriftPage;
