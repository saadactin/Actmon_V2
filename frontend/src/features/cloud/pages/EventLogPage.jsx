import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Activity, AlertTriangle, Bot, ChevronDown, ChevronRight, Cloud, Eye, Filter,
  ListFilter, ScrollText, Settings2, ShieldAlert, Star, Trash, Trash2, User,
  UserCog, X, Zap,
} from 'lucide-react';
import Badge, { LiveBadge } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Pagination from '@/components/ui/Pagination';
import Select from '@/components/ui/Select';
import Table, { EmptyState } from '@/components/ui/Table';
import { InlineLoading } from '@/components/ui/Loading';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudSection from '../components/CloudSection';
import EventDetailDrawer from '../components/EventDetailDrawer';
import ProviderLogo from '../components/ProviderLogo';
import {
  REFRESH_INTERVALS,
  useCollectEvents,
  useCollectionStatus,
  useEventAccess,
  useEventFacets,
  useEventList,
  useEventSettings,
  useEventStats,
  useEventTimeline,
  useDeleteSavedQuery,
  useSaveQuery,
  useSavedQueries,
  useUpdateEventSettings,
} from '../hooks/useEvents';
import { exportEvents } from '../api/events.api';
import {
  ACTION_OPTIONS,
  ACTOR_TYPE_OPTIONS,
  CATEGORY_CHIPS,
  DEFAULT_RANGE,
  MIN_RISK_OPTIONS,
  PAGE_SIZE_OPTIONS,
  RISK_ORDER,
  RISK_TONE,
  SORT_OPTIONS,
  SOURCE_STATUS_ADVICE,
  SOURCE_STATUS_META,
  STATUS_OPTIONS,
  STATUS_TONE,
  TIME_RANGES,
  collectionLookbackHours,
  formatCount,
  formatEventTime,
  formatUtc,
  localZone,
  localZoneAbbrev,
  relativeTime,
} from '../utils/eventFormat';

/**
 * Event Log — the unified cloud audit trail.
 *
 * Sits beside Configuration Drift on purpose, and the pairing is the point:
 * drift says *what changed*, this says *who changed it, from where, how, and
 * what the provider answered*. Together they close the loop that either alone
 * cannot.
 *
 * Three rules govern everything on this page:
 *
 * 1.  **An empty table is never presented as "nothing happened."** Every
 *     response carries the collection health of its sources, and a degraded
 *     source produces a warning above the table. "No events" and "collection
 *     is broken" look identical in a data table and mean opposite things.
 *
 * 2.  **Nothing is fabricated.** A field the provider did not report shows as
 *     "Not available", never as a blank or a plausible substitute. Timestamps
 *     are stored in UTC and converted once, with the zone named.
 *
 * 3.  **The cards, the table and the export always describe the same query.**
 *     One filter object drives all three, so a summary cannot disagree with
 *     the rows beneath it and an exported file cannot represent a different
 *     question from the one on screen.
 */

const ACTOR_ICON = {
  Human: User,
  RootAccount: ShieldAlert,
  IAMRole: UserCog,
  ServicePrincipal: Bot,
  ServiceAccount: Bot,
  CloudService: Cloud,
  AutomatedProcess: Zap,
  Unknown: User,
};

/** The empty filter set. Also what "Clear filters" restores, and what a saved
    query is merged onto — defined once so those three cannot diverge. */
const EMPTY_FILTERS = {
  provider: '',
  category: '',
  action: '',
  status: '',
  minRisk: '',
  actorType: '',
  actor: '',
  resourceType: '',
  region: '',
  accessMethod: '',
  eventName: '',
  sourceIp: '',
  search: '',
  excludeReadOnly: false,
  advanced: null,
};

/** Which filters count as "active" for the clear-filters affordance. The window
    and the account are scope, not filters, so they are excluded. */
const FILTER_KEYS = Object.keys(EMPTY_FILTERS);

const StatCard = ({
  icon: Icon, label, value, tone = 'neutral', hint, active, onClick, loading,
}) => {
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
      aria-pressed={onClick ? !!active : undefined}
      title={active
        ? `Filtering by ${label.toLowerCase()} — click again to remove`
        : onClick ? `Filter the table by ${label.toLowerCase()}` : hint}
      className={`relative flex items-center gap-3 rounded-card border p-3 text-left transition-colors disabled:cursor-default ${
        active
          ? 'border-accent bg-accent-soft ring-1 ring-accent'
          : 'border-border bg-surface'
      } ${onClick ? 'hover:border-accent' : ''}`}
    >
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-control ${TONE_BG[tone]}`}>
        <Icon size={17} />
      </span>
      <span className="min-w-0">
        {loading ? (
          <span className="block h-6 w-14 animate-pulse rounded bg-sunken" />
        ) : (
          <span className="block text-[18px] font-semibold leading-tight text-fg tabular-nums">
            {value}
          </span>
        )}
        <span className="block truncate text-[11px] text-muted">{label}</span>
        {/* When the card is filtering, its own hint is replaced by the fact
            that it is — the state the user needs is "this one is on and
            clicking removes it", not the static description. */}
        <span className="block truncate text-[10px] text-subtle">
          {active ? 'Filtering · click to remove' : hint}
        </span>
      </span>
      {active && (
        <X size={12} className="absolute right-2 top-2 shrink-0 text-accent-text" />
      )}
    </button>
  );
};

/**
 * Per-provider collection health.
 *
 * Rendered above the data, not tucked into a settings page, because it is what
 * makes the data interpretable. A provider showing "Permission denied" beside
 * an empty table is a completely different statement from an empty table with
 * everything Connected.
 */
const SourceStatusBar = ({ sources, onOpenDetail }) => {
  if (!sources?.providers?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-subtle">
        Event sources
      </span>
      {sources.providers.map((p) => {
        const meta = SOURCE_STATUS_META[p.status] || SOURCE_STATUS_META.NeverRun;
        const advice = SOURCE_STATUS_ADVICE[p.status];
        return (
          <button
            key={p.provider}
            type="button"
            onClick={onOpenDetail}
            title={[
              `${p.provider}: ${meta.label}`,
              p.last_success_at ? `Last successful collection: ${formatEventTime(p.last_success_at)}` : 'Never collected successfully',
              p.scopes ? `${p.scopes_healthy}/${p.scopes} collection scopes healthy` : null,
              p.last_error ? `Last error: ${p.last_error}` : null,
              advice ? `\n${advice}` : null,
              p.provider_retention_days ? `\nProvider keeps events for ${p.provider_retention_days} days.` : null,
            ].filter(Boolean).join('\n')}
            className="inline-flex items-center gap-1.5 rounded-control border border-border bg-surface px-2 py-1 transition-colors hover:border-accent"
          >
            <ProviderLogo provider={p.provider} size={13} />
            <span className="text-[11px] font-semibold text-fg">{p.provider}</span>
            <Badge tone={meta.tone} size="xs">{meta.label}</Badge>
            {p.scopes_failing > 0 && p.scopes_healthy > 0 && (
              <span className="text-[10px] text-subtle tabular-nums">
                {p.scopes_healthy}/{p.scopes}
              </span>
            )}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onOpenDetail}
        className="text-[11px] font-semibold text-accent-text hover:text-accent-hover"
      >
        Collection health
      </button>
    </div>
  );
};

/** Counts per time bucket, split by risk. Minimal by design — the shape of the
    window at a glance, with real numbers on hover; the table below is where
    detail lives. */
const TimelineBars = ({ timeline, onPick }) => {
  const buckets = timeline?.buckets || [];
  if (!buckets.length) {
    return <p className="text-xs text-muted">No activity in this window.</p>;
  }
  const max = Math.max(...buckets.map((b) => b.total), 1);
  return (
    <>
      <div className="flex h-16 items-end gap-px">
        {buckets.map((b) => {
          const risky = b.high_risk > 0;
          return (
            <button
              key={b.bucket}
              type="button"
              onClick={() => onPick?.(b)}
              title={[
                formatEventTime(b.bucket),
                `${b.total} event${b.total === 1 ? '' : 's'}`,
                b.high_risk ? `${b.high_risk} high or critical` : null,
                b.failed ? `${b.failed} failed or denied` : null,
              ].filter(Boolean).join('\n')}
              className={`min-w-[2px] flex-1 rounded-t transition-colors ${
                risky ? 'bg-danger/70 hover:bg-danger' : 'bg-accent/60 hover:bg-accent'
              }`}
              style={{ height: `${Math.max(6, (b.total / max) * 100)}%` }}
            />
          );
        })}
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-3 text-[10px] text-subtle">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-accent/60" /> events
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-danger/70" /> bucket contains high/critical
        </span>
        <span className="ml-auto">one bar = 1 {timeline.bucket}</span>
      </p>
    </>
  );
};

/** The timeline VIEW — a chronological feed rather than a grid. Same data, read
    the way an incident is read: down the page, in order. */
const TimelineFeed = ({ events, onOpen }) => {
  if (!events.length) return null;
  let lastDate = null;
  return (
    <ol className="space-y-0">
      {events.map((e) => {
        const date = formatEventTime(e.timestamp).split(' ')[0];
        const newDay = date !== lastDate;
        lastDate = date;
        const ActorIcon = ACTOR_ICON[e.actor_type] || User;
        return (
          <li key={e.id}>
            {newDay && (
              <p className="mt-3 mb-1.5 text-[10px] font-bold uppercase tracking-wider text-subtle">
                {date}
              </p>
            )}
            <button
              type="button"
              onClick={() => onOpen(e.id)}
              className="flex w-full gap-3 border-l-2 border-border py-2 pl-3 text-left transition-colors hover:border-accent hover:bg-sunken"
            >
              <span
                className="w-[68px] shrink-0 font-mono text-[11px] text-muted tabular-nums"
                title={formatUtc(e.timestamp)}
              >
                {formatEventTime(e.timestamp, { withZone: false }).split(' ')[1]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={RISK_TONE[e.risk_level] || 'neutral'} size="xs">
                    {e.risk_level}
                  </Badge>
                  <span className="text-[13px] font-semibold text-fg">{e.event_name}</span>
                  {e.status !== 'Success' && (
                    <Badge tone={STATUS_TONE[e.status] || 'neutral'} size="xs">
                      {e.status}
                    </Badge>
                  )}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                  <span className="inline-flex items-center gap-1">
                    <ActorIcon size={11} className="text-subtle" />
                    {e.actor_name || 'Unidentified principal'}
                  </span>
                  {e.resource_name && <span className="text-subtle">→ {e.resource_name}</span>}
                  {e.region && <span className="text-subtle">{e.region}</span>}
                  <span className="text-subtle">{e.provider}</span>
                </span>
              </span>
              <ChevronRight size={13} className="mt-1 shrink-0 text-subtle" />
            </button>
          </li>
        );
      })}
    </ol>
  );
};

/** Per-scope collection detail, plus the ingestion metrics and the retention
    comparison. Behind a toggle because it is diagnostic, not everyday. */
const CollectionHealthPanel = ({ accountId, onClose }) => {
  const { data, isLoading } = useCollectionStatus(accountId);
  const settingsMutation = useUpdateEventSettings();
  const { data: settings } = useEventSettings();
  const [retention, setRetention] = useState('');

  useEffect(() => {
    if (settings?.retention_days) setRetention(String(settings.retention_days));
  }, [settings?.retention_days]);

  if (isLoading) return <InlineLoading label="Loading collection health…" />;
  if (!data) return <p className="text-xs text-muted">Collection status unavailable.</p>;

  const failing = (data.scopes || []).filter(
    (s) => ['AuthenticationFailed', 'PermissionDenied', 'Unavailable'].includes(s.status),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11.5px] leading-relaxed text-muted">
          Collection runs on an interval and checkpoints each scope separately, so one
          unreadable region or compartment cannot stall or silently skip the others.
        </p>
        <Button size="sm" variant="ghost" icon="close" onClick={onClose}>Close</Button>
      </div>

      {/* Retention, stated as two separate numbers. Implying the application
          figure can reach past the provider's window would be a lie the UI
          repeated on every page load. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-card border border-border bg-surface p-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-subtle">
            Application retention
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <Select
              value={retention}
              onChange={setRetention}
              width="auto"
              size="sm"
              options={(settings?.retention_options || [7, 30, 90, 180, 365])
                .map((d) => ({ id: String(d), label: `${d} days` }))}
            />
            <Button
              size="sm"
              variant="secondary"
              loading={settingsMutation.isPending}
              disabled={!retention || Number(retention) === settings?.retention_days}
              onClick={() => settingsMutation.mutate({ retention_days: Number(retention) })}
            >
              Save
            </Button>
          </div>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-subtle">
            How long ACTMON keeps collected events. Changing this is recorded in the
            Event Log&apos;s own access log.
          </p>
        </div>
        <div className="rounded-card border border-border bg-surface p-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-subtle">
            Provider retention
          </p>
          <dl className="mt-1.5 space-y-1">
            {Object.entries(data.retention?.provider_days || {}).map(([provider, days]) => (
              <div key={provider} className="flex items-center justify-between gap-2 text-[11.5px]">
                <dt className="text-muted">{provider}</dt>
                <dd className="font-semibold text-fg tabular-nums">{days} days</dd>
              </div>
            ))}
          </dl>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-subtle">
            A hard ceiling. Raising application retention above these figures cannot
            retrieve older events — the provider will not serve them.
          </p>
        </div>
      </div>

      {failing.length > 0 && (
        <Notice tone="danger" title={`${failing.length} collection scope${failing.length === 1 ? '' : 's'} failing.`}>
          Events from {failing.length === 1 ? 'this scope' : 'these scopes'} are missing
          from the feed until it is fixed.
          <ul className="mt-1.5 space-y-1">
            {failing.slice(0, 5).map((s) => (
              <li key={s.id} className="text-[11px]">
                <span className="font-mono">{s.scope}</span> — {s.last_error}
              </li>
            ))}
            {failing.length > 5 && (
              <li className="text-[11px] italic">…and {failing.length - 5} more.</li>
            )}
          </ul>
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Events received', data.metrics?.events_received],
          ['Events stored', data.metrics?.events_stored],
          ['Duplicates discarded', data.metrics?.events_duplicate],
          ['Malformed / failed', data.metrics?.events_failed],
          ['Provider API calls', data.metrics?.api_calls],
          ['API errors', data.metrics?.api_errors],
          ['Rate-limit hits', data.metrics?.rate_limit_hits],
          ['Max ingestion delay', data.metrics?.max_ingestion_latency_s
            ? `${Number(data.metrics.max_ingestion_latency_s).toFixed(1)}s` : '—'],
        ].map(([label, value]) => (
          <div key={label} className="rounded-control border border-border bg-sunken p-2">
            <p className="text-[16px] font-semibold text-fg tabular-nums">
              {typeof value === 'number' ? formatCount(value) : (value ?? '—')}
            </p>
            <p className="text-[10.5px] text-muted">{label}</p>
          </div>
        ))}
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-subtle">
          Collection scopes ({data.scopes?.length || 0})
        </p>
        {!data.scopes?.length ? (
          <p className="text-xs text-muted">
            No collection scopes registered yet — the first collection discovers them.
          </p>
        ) : (
          <div className="max-h-72 overflow-y-auto rounded-card border border-border">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-sunken">
                <tr className="text-left text-[10px] uppercase tracking-wide text-subtle">
                  <th className="px-2 py-1.5">Scope</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5">Checkpoint</th>
                  <th className="px-2 py-1.5 text-right">Stored</th>
                  <th className="px-2 py-1.5 text-right">Dupes</th>
                </tr>
              </thead>
              <tbody>
                {data.scopes.map((s) => {
                  const meta = SOURCE_STATUS_META[s.status] || SOURCE_STATUS_META.NeverRun;
                  return (
                    <tr key={s.id} className="border-t border-border">
                      <td className="max-w-[280px] px-2 py-1.5">
                        <span className="block truncate font-mono text-[10.5px] text-fg" title={s.scope}>
                          {s.provider} · {s.scope}
                        </span>
                        {s.last_error && (
                          <span className="block truncate text-[10px] text-danger-fg" title={s.last_error}>
                            {s.last_error}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <Badge tone={meta.tone} size="xs">{meta.label}</Badge>
                      </td>
                      <td className="px-2 py-1.5 text-muted" title={s.checkpoint ? formatUtc(s.checkpoint) : ''}>
                        {s.checkpoint ? relativeTime(s.checkpoint) : 'never'}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted">
                        {formatCount(s.events_stored)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-subtle">
                        {formatCount(s.events_duplicate)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export const EventLogPage = ({ embedded = false, accountId }) => {
  // ── Arriving from somewhere else ─────────────────────────────────────────
  // Topology (and Config Drift) hand off a resource by query parameter. The
  // range comes with it because the badge that was clicked counts a 30-day
  // window: landing on the default 24 hours would show "0 events" right after
  // the user clicked "5 events", which reads as a bug in the audit trail.
  const [searchParams, setSearchParams] = useSearchParams();
  const handoffResource = searchParams.get('resource') || searchParams.get('resourceName') || '';
  const handoffRange = searchParams.get('range') || '';

  // ── Scope ────────────────────────────────────────────────────────────────
  const [range, setRange] = useState(
    handoffRange && TIME_RANGES.some((r) => r.id === handoffRange) ? handoffRange : DEFAULT_RANGE,
  );
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [useCustom, setUseCustom] = useState(false);

  // ── Filters ──────────────────────────────────────────────────────────────
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [searchInput, setSearchInput] = useState(handoffResource);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showHealth, setShowHealth] = useState(false);
  const [showQueries, setShowQueries] = useState(false);

  // ── View ─────────────────────────────────────────────────────────────────
  const [view, setView] = useState('table');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [refreshId, setRefreshId] = useState('0');
  const [openEventId, setOpenEventId] = useState(null);
  const [exportState, setExportState] = useState(null);

  const refreshMs = REFRESH_INTERVALS.find((r) => r.id === refreshId)?.ms || 0;

  // How far back "Load events for the last Nh" asks the provider to read. The time-range
  // selector only filters events that are ALREADY stored, so without this the
  // button fetched nothing older than the last checkpoint and there was no way
  // to back-fill — selecting 7 days then collecting appeared to do nothing.
  const lookbackHours = collectionLookbackHours({
    range, useCustom, start: customStart, end: customEnd,
  });
  const collectNow = () => collect.mutate({ accountId, lookbackHours });

  // The parameters are consumed once. Leaving them in the URL would re-apply
  // the handoff on every later render — clearing the search box would silently
  // refill it — so they are dropped as soon as they have been read.
  useEffect(() => {
    if (!handoffResource && !handoffRange) return;
    const next = new URLSearchParams(searchParams);
    next.delete('resource');
    next.delete('resourceName');
    next.delete('range');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced search: a keystroke per request would hammer a table designed to
  // hold millions of rows, and the backend query is not free.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((f) => (f.search === searchInput ? f : { ...f, search: searchInput }));
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // One object drives the list, the cards, the timeline and the export, so
  // they cannot describe different queries.
  const query = useMemo(() => ({
    accountId,
    range: useCustom ? undefined : range,
    start: useCustom && customStart ? new Date(customStart).toISOString() : undefined,
    end: useCustom && customEnd ? new Date(customEnd).toISOString() : undefined,
    ...filters,
  }), [accountId, range, useCustom, customStart, customEnd, filters]);

  /**
   * The summary cards deliberately do NOT use the table's query.
   *
   * Each card both DISPLAYS a count and TOGGLES the filter that produces it.
   * Feeding them the fully-filtered stats made every card rewrite every other
   * card: click "Successful" and "Failed or denied" drops to 0 — not because
   * there are no failures, but because zero failures are successes. The same
   * click turned "Critical events: 14" into "14 critical successes" under a
   * label that still said Critical events.
   *
   * So the cards are computed with the four card-controlled dimensions
   * removed. They then describe the WINDOW — a stable denominator — and
   * toggling one changes only which card is highlighted and what the table
   * below shows. The row of numbers stops moving under the cursor.
   *
   * Scope filters (category, search, provider, actor…) ARE still applied,
   * because those genuinely narrow what the page is about.
   */
  const cardQuery = useMemo(() => {
    const { status, excludeReadOnly, action, minRisk, ...scope } = query;
    return scope;
  }, [query]);

  const {
    data: list, isLoading: listLoading, isFetching, isError: listFailed, error: listError,
  } = useEventList(query, { sort, page, pageSize, enabled: !!accountId }, refreshMs);
  const { data: stats, isLoading: statsLoading } = useEventStats(cardQuery, refreshMs, !!accountId);
  const { data: timeline } = useEventTimeline(query, !!accountId, refreshMs);
  const { data: facets } = useEventFacets(accountId, useCustom ? undefined : range);
  const { data: access } = useEventAccess(!!accountId);
  const { data: saved } = useSavedQueries(!!accountId && showQueries);
  const collect = useCollectEvents();
  const saveQueryMutation = useSaveQuery();
  const deleteQueryMutation = useDeleteSavedQuery();

  const rows = list?.items ?? [];
  const total = list?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const sources = list?.sources || stats?.sources;
  const zone = localZoneAbbrev() || localZone();

  const activeFilterCount = FILTER_KEYS.filter((k) => {
    const v = filters[k];
    return k === 'excludeReadOnly' ? v === true : !!v;
  }).length;

  // The four dimensions the summary cards toggle.
  const CARD_FILTER_KEYS = ['status', 'excludeReadOnly', 'action', 'minRisk'];
  const cardFilterCount = CARD_FILTER_KEYS.filter((k) => (
    k === 'excludeReadOnly' ? filters[k] === true : !!filters[k]
  )).length;

  const CARD_FILTER_RESET = {
    status: '', excludeReadOnly: false, action: '', minRisk: '',
  };

  const clearCardFilters = () => {
    setFilters((f) => ({ ...f, ...CARD_FILTER_RESET }));
    setPage(1);
  };

  /**
   * The cards are SINGLE-SELECT: picking one clears the other three.
   *
   * They are technically independent dimensions (status, read-only, action,
   * risk) and stacking them is a coherent query — "failed delete operations"
   * is a real question. But two cards lit at once reads as a stuck control
   * rather than a compound filter, and the combinations quietly produce
   * empty tables ("Successful" + "Failed or denied" can only ever be zero).
   * One highlighted card, one meaning.
   *
   * Clicking the card that is already on turns it off, so there is always a
   * way back to the unfiltered window without hunting for a Clear button.
   */
  const selectCardFilter = (key, value) => () => {
    setFilters((f) => ({
      ...f,
      ...CARD_FILTER_RESET,
      // Toggle off when it is already the active one, otherwise make it the
      // only one on.
      [key]: (key === 'excludeReadOnly' ? f[key] === true : f[key] === value)
        ? CARD_FILTER_RESET[key]
        : value,
    }));
    setPage(1);
  };

  const setFilter = (key) => (value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setSearchInput('');
    setPage(1);
  };

  const canExport = access?.you?.permissions?.includes('events:export') ?? true;
  const canConfigure = access?.you?.permissions?.includes('events:configure') ?? true;
  const canCollect = access?.you?.permissions?.includes('events:collect') ?? true;
  const canSaveQuery = access?.you?.permissions?.includes('events:save_query') ?? true;

  const runExport = async (format) => {
    setExportState({ status: 'running', format });
    try {
      const result = await exportEvents(query, format, { sort });
      setExportState({ status: 'done', ...result });
    } catch (err) {
      setExportState({
        status: 'error',
        message: err?.response?.data?.detail || err?.message || 'Export failed.',
      });
    }
  };

  // ── Table shape ──────────────────────────────────────────────────────────
  const columns = [
    { key: 'when', label: `Timestamp (${zone})`, width: '150px' },
    { key: 'provider', label: 'Provider', width: '92px' },
    { key: 'actor', label: 'Actor' },
    { key: 'action', label: 'Action' },
    { key: 'resource', label: 'Resource' },
    { key: 'scope', label: 'Account / region', width: '150px' },
    { key: 'result', label: 'Result', width: '130px' },
    { key: 'source', label: 'Source', width: '150px' },
  ];

  const tableRows = rows.map((e) => {
    const ActorIcon = ACTOR_ICON[e.actor_type] || User;
    return {
      key: e.id,
      onClick: () => setOpenEventId(e.id),
      cells: {
        when: (
          <span
            className="whitespace-nowrap font-mono text-[11px] text-muted tabular-nums"
            title={`${formatEventTime(e.timestamp)}\n${formatUtc(e.timestamp)}\nCollected ${relativeTime(e.ingested_at)}`}
          >
            {formatEventTime(e.timestamp, { withZone: false })}
          </span>
        ),
        provider: (
          <span className="inline-flex items-center gap-1.5">
            <ProviderLogo provider={e.provider} size={14} />
            <span className="text-[11.5px] font-semibold text-fg">{e.provider}</span>
          </span>
        ),
        actor: (
          <div className="min-w-0">
            <p className="flex items-center gap-1 truncate text-[12.5px] font-medium text-fg">
              <ActorIcon size={11} className="shrink-0 text-subtle" />
              <span className="truncate" title={e.actor_name || undefined}>
                {e.actor_name || <span className="italic text-subtle">Unidentified</span>}
              </span>
            </p>
            <p className="truncate text-[10.5px] text-subtle">
              {e.actor_type === 'Human' ? 'user'
                : e.actor_type === 'RootAccount' ? 'root / tenancy admin'
                  : e.actor_type === 'IAMRole' ? 'assumed role'
                    : e.actor_type === 'ServicePrincipal' ? 'service principal'
                      : e.actor_type === 'CloudService' ? 'cloud service'
                        : e.actor_type}
            </p>
          </div>
        ),
        action: (
          <div className="min-w-0">
            <p className="truncate text-[12.5px] font-medium text-fg" title={e.api_operation || e.event_name}>
              {e.event_name}
            </p>
            <p className="flex items-center gap-1 truncate text-[10.5px] text-subtle">
              <Badge tone={RISK_TONE[e.risk_level] || 'neutral'} size="xs">{e.risk_level}</Badge>
              {e.event_category}
              {e.has_change && (
                <span title="This event carries a before/after state change from the provider.">
                  · diff
                </span>
              )}
            </p>
          </div>
        ),
        resource: (
          <div className="min-w-0">
            <p className="truncate text-[12.5px] text-fg" title={e.resource_id || undefined}>
              {e.resource_name || e.resource_id
                || <span className="italic text-subtle">Not reported</span>}
            </p>
            {e.resource_type && (
              <p className="truncate text-[10.5px] text-subtle">{e.resource_type}</p>
            )}
          </div>
        ),
        scope: (
          <div className="min-w-0">
            <p className="truncate text-[11px] text-muted" title={e.account_ref || e.subscription_id || undefined}>
              {e.account_ref || e.subscription_id || '—'}
            </p>
            <p className="truncate text-[10.5px] text-subtle">
              {e.region || e.compartment_name || e.resource_group
                || <span className="italic">not reported</span>}
            </p>
          </div>
        ),
        result: (
          <div className="min-w-0">
            <Badge tone={STATUS_TONE[e.status] || 'neutral'} size="xs">{e.status}</Badge>
            {e.error_code && (
              <p className="mt-0.5 truncate font-mono text-[10px] text-danger-fg" title={e.error_code}>
                {e.error_code}
              </p>
            )}
          </div>
        ),
        source: (
          <div className="min-w-0">
            <p className="truncate font-mono text-[10.5px] text-muted">
              {e.source_ip || <span className="font-sans italic text-subtle">Not available</span>}
            </p>
            <p className="truncate text-[10.5px] text-subtle">
              {e.access_method || <span className="italic">method unknown</span>}
            </p>
          </div>
        ),
      },
    };
  });

  // ── Guard rails ──────────────────────────────────────────────────────────
  if (!accountId) {
    return (
      <>
        {!embedded && (
          <CloudPageHeader
            backTo="/cloud"
            icon="logs"
            title="Event Log"
          />
        )}
        <div className="rounded-card border border-border bg-surface py-12">
          <EmptyState
            icon="cloud"
            title="Pick a cloud account"
            body="Audit events are collected per account. Open an account from the Cloud hub to see its event log."
          />
        </div>
      </>
    );
  }

  return (
    <>
      {!embedded && (
        <CloudPageHeader
          backTo="/cloud"
          icon="logs"
          title="Event Log"
        />
      )}

      <div className="space-y-4">
        {/* ── Toolbar: source health, window, live mode, actions ──────────── */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SourceStatusBar sources={sources} onOpenDetail={() => setShowHealth(true)} />
          <div className="flex flex-wrap items-center gap-2">
            {refreshMs > 0 && <LiveBadge label="Live" />}
            {/* "Live view", not "Auto-refresh": this only re-reads the events
                already stored, every N seconds. The account header's "Auto
                refresh" is the provider schedule, and the two used one name.
                The toolbar's "Collect now" is gone for the same reason — the
                header's Refresh all collects events with everything else. */}
            <Select
              value={refreshId}
              onChange={setRefreshId}
              width="auto"
              size="sm"
              options={REFRESH_INTERVALS.map((r) => ({
                id: r.id, label: r.id === '0' ? 'Live view: off' : `Live view: every ${r.label}`,
              }))}
            />
          </div>
        </div>

        {/* Collection failure is stated above the data, because it changes what
            the data means. */}
        {sources?.degraded && (
          <Notice tone="warning" title="Event collection is degraded.">
            {sources.note
              || 'One or more event sources is not collecting, so events may be missing from this view. An empty or short list here is not evidence that nothing happened.'}
            {' '}
            <button
              type="button"
              onClick={() => setShowHealth(true)}
              className="font-semibold underline"
            >
              See collection health
            </button>
          </Notice>
        )}

        {/* RBAC posture, stated rather than assumed. A security feature whose
            access controls are off must say so. */}
        {access?.rbac && !access.rbac.enforced && (
          <Notice tone="info" title="Audit access is not restricted.">
            Event Log access control is not enforced on this deployment, so anyone who
            can reach the cloud service can read and export audit events. Set
            {' '}<span className="font-mono">EVENTLOG_RBAC_ENFORCE=true</span>{' '}
            in <span className="font-mono">Backend/cloud/.env</span> to require a
            signed token with a role claim. Refusals and exports are recorded either way.
          </Notice>
        )}

        {collect.isSuccess && collect.data && (
          <Notice
            tone={collect.data.scopes_failed > 0 ? 'warning' : 'success'}
            title="Collection finished."
          >
            Read the last {lookbackHours}h from the provider:
            stored {formatCount(collect.data.events_stored)} new event
            {collect.data.events_stored === 1 ? '' : 's'},
            discarded {formatCount(collect.data.events_duplicate)} already on file.
            {collect.data.scopes_failed > 0 && (
              <> {collect.data.scopes_failed} scope
                {collect.data.scopes_failed === 1 ? '' : 's'} could not be read — their
                checkpoints were held, so those windows will be retried rather than
                skipped.</>
            )}
          </Notice>
        )}
        {collect.isError && (
          <Notice tone="danger" title="Could not collect events.">
            {collect.error?.response?.data?.detail || collect.error?.message}
          </Notice>
        )}

        {showHealth && (
          <CloudSection title="Collection health" >
            <CollectionHealthPanel accountId={accountId} onClose={() => setShowHealth(false)} />
          </CloudSection>
        )}

        {/* ── Time range ──────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-subtle">
            Time range
          </span>
          {TIME_RANGES.slice(0, 7).map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => { setRange(r.id); setUseCustom(false); setPage(1); }}
              className={`rounded-control border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                !useCustom && range === r.id
                  ? 'border-accent bg-accent-soft text-accent-text'
                  : 'border-border bg-surface text-muted hover:text-fg'
              }`}
            >
              {r.label.replace('Last ', '')}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setUseCustom((v) => !v)}
            className={`rounded-control border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
              useCustom
                ? 'border-accent bg-accent-soft text-accent-text'
                : 'border-border bg-surface text-muted hover:text-fg'
            }`}
          >
            Custom range
          </button>
          {/* Timestamps are stored in UTC and converted once for display. Said
              out loud so nobody has to infer which zone they are reading. */}
          <span className="ml-auto text-[10.5px] text-subtle" title={`Stored in UTC, shown in ${localZone()}.`}>
            Times shown in {localZone()} ({zone}) · stored in UTC
          </span>
        </div>

        {useCustom && (
          <div className="flex flex-wrap items-end gap-3 rounded-card border border-border bg-surface p-3">
            <label className="text-[11px] font-semibold text-muted">
              <span className="mb-1 block">Start ({zone})</span>
              <input
                type="datetime-local"
                value={customStart}
                onChange={(e) => { setCustomStart(e.target.value); setPage(1); }}
                className="h-control-sm rounded-control border border-border bg-surface px-2 text-[12px] text-fg"
              />
            </label>
            <label className="text-[11px] font-semibold text-muted">
              <span className="mb-1 block">End ({zone})</span>
              <input
                type="datetime-local"
                value={customEnd}
                onChange={(e) => { setCustomEnd(e.target.value); setPage(1); }}
                className="h-control-sm rounded-control border border-border bg-surface px-2 text-[12px] text-fg"
              />
            </label>
            <p className="max-w-md text-[10.5px] leading-relaxed text-subtle">
              Entered in your local timezone and converted to UTC for the query. Leaving
              the end blank means &ldquo;until now&rdquo;.
            </p>
          </div>
        )}

        {/* ── Summary cards ───────────────────────────────────────────────
            Five of the six are toggles and only ONE can be active at a time:
            picking a card clears the others. The banner still explains the
            one thing that is genuinely surprising — the numbers on the cards
            cover the whole window and deliberately do not move when you
            filter, so the card you clicked keeps showing the count you
            clicked it for. */}
        {cardFilterCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-control border border-accent bg-accent-soft px-3 py-1.5">
            <Filter size={12} className="shrink-0 text-accent-text" />
            <span className="text-[11px] text-fg">
              One card is filtering the table below. The counts themselves
              cover the whole window and do not change as you switch between
              them.
            </span>
            <button
              type="button"
              onClick={clearCardFilters}
              className="ml-auto text-[11px] font-semibold text-accent-text hover:underline"
            >
              Clear it
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          {/* The only card that is not a toggle. It is the denominator the
              others are read against, so it shows the window total and says so
              — "Matching the current filters" was wrong the moment any card
              was clicked, because the card row no longer moves with them. */}
          <StatCard
            icon={ScrollText} tone="accent" label="Total events" loading={statsLoading}
            value={formatCount(stats?.total_events)}
            hint={cardFilterCount > 0
              ? `${formatCount(total)} shown below`
              : 'In this time window'}
          />
          <StatCard
            icon={Activity} tone="success" label="Successful" loading={statsLoading}
            value={formatCount(stats?.successful_events)}
            active={filters.status === 'Success'}
            onClick={selectCardFilter('status', 'Success')}
          />
          <StatCard
            icon={AlertTriangle} tone="danger" label="Failed or denied" loading={statsLoading}
            value={formatCount(stats?.failed_events)}
            hint={stats?.denied_events ? `${formatCount(stats.denied_events)} refused` : undefined}
            active={filters.status === 'Denied'}
            onClick={selectCardFilter('status', 'Denied')}
          />
          <StatCard
            icon={Settings2} tone="info" label="Administrative changes" loading={statsLoading}
            value={formatCount(stats?.administrative_changes)}
            hint="Provably changed something"
            active={filters.excludeReadOnly}
            onClick={selectCardFilter('excludeReadOnly', true)}
          />
          <StatCard
            icon={Trash} tone="warning" label="Delete operations" loading={statsLoading}
            value={formatCount(stats?.delete_operations)}
            active={filters.action === 'Delete'}
            onClick={selectCardFilter('action', 'Delete')}
          />
          <StatCard
            icon={ShieldAlert} tone="danger" label="Critical events" loading={statsLoading}
            value={formatCount(stats?.critical_events)}
            hint={stats?.high_risk_events ? `${formatCount(stats.high_risk_events)} high` : undefined}
            active={filters.minRisk === 'CRITICAL'}
            onClick={selectCardFilter('minRisk', 'CRITICAL')}
          />
        </div>

        {/* ── Category chips ──────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-1.5">
          <ListFilter size={13} className="shrink-0 text-subtle" />
          {CATEGORY_CHIPS.map((chip) => {
            const count = chip.id ? stats?.by_category?.[chip.id] : stats?.total_events;
            // A category with nothing in it is shown but disabled, so the chip
            // row does not reshuffle every time the window changes.
            const empty = chip.id && !count;
            return (
              <button
                key={chip.id || 'all'}
                type="button"
                disabled={empty && filters.category !== chip.id}
                onClick={() => setFilter('category')(filters.category === chip.id ? '' : chip.id)}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                  filters.category === chip.id
                    ? 'border-accent bg-accent-soft text-accent-text'
                    : 'border-border bg-surface text-muted hover:text-fg'
                }`}
              >
                {chip.label}
                {count > 0 && (
                  <span className="text-[10px] tabular-nums text-subtle">{formatCount(count)}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* ── Search + filters ────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            icon="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onClear={() => setSearchInput('')}
            placeholder="Search events, users, resources, IP addresses, event names…"
            wrapperClassName="min-w-[260px] max-w-md flex-1"
          />
          <Select
            value={filters.provider} onChange={setFilter('provider')} width="auto" size="sm"
            options={[
              { id: '', label: 'All providers' },
              ...(facets?.present?.providers || ['AWS', 'Azure', 'OCI'])
                .map((p) => ({ id: p, label: p })),
            ]}
          />
          <Select
            value={filters.minRisk} onChange={setFilter('minRisk')} width="auto" size="sm"
            options={MIN_RISK_OPTIONS}
          />
          <Select
            value={filters.status} onChange={setFilter('status')} width="auto" size="sm"
            options={STATUS_OPTIONS}
          />
          <Select
            value={filters.actorType} onChange={setFilter('actorType')} width="auto" size="sm"
            options={ACTOR_TYPE_OPTIONS}
          />
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-control border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
              showAdvanced || activeFilterCount > 4
                ? 'border-accent bg-accent-soft text-accent-text'
                : 'border-border bg-surface text-muted hover:text-fg'
            }`}
          >
            <Filter size={12} /> Advanced
          </button>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent-text hover:text-accent-hover"
            >
              <X size={12} /> Clear {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'}
            </button>
          )}
        </div>

        {showAdvanced && (
          <div className="grid gap-3 rounded-card border border-border bg-surface p-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-[11px] font-semibold text-muted">
              <span className="mb-1 block">Action</span>
              <Select value={filters.action} onChange={setFilter('action')} options={ACTION_OPTIONS} size="sm" />
            </label>
            <label className="text-[11px] font-semibold text-muted">
              <span className="mb-1 block">Resource type</span>
              <Select
                value={filters.resourceType} onChange={setFilter('resourceType')} size="sm"
                options={[
                  { id: '', label: 'All resource types' },
                  ...(facets?.present?.resource_types || []).map((t) => ({ id: t, label: t })),
                ]}
              />
            </label>
            <label className="text-[11px] font-semibold text-muted">
              <span className="mb-1 block">Region / location</span>
              <Select
                value={filters.region} onChange={setFilter('region')} size="sm"
                options={[
                  { id: '', label: 'All regions' },
                  ...(facets?.present?.regions || []).map((r) => ({ id: r, label: r })),
                ]}
              />
            </label>
            <label className="text-[11px] font-semibold text-muted">
              <span className="mb-1 block">Actor</span>
              <Select
                value={filters.actor} onChange={setFilter('actor')} size="sm"
                options={[
                  { id: '', label: 'All actors' },
                  ...(facets?.present?.actors || []).map((a) => ({ id: a, label: a })),
                ]}
              />
            </label>
            <label className="text-[11px] font-semibold text-muted">
              <span className="mb-1 block">Event name</span>
              <Select
                value={filters.eventName} onChange={setFilter('eventName')} size="sm"
                options={[
                  { id: '', label: 'All event names' },
                  ...(facets?.present?.event_names || []).map((n) => ({ id: n, label: n })),
                ]}
              />
            </label>
            <label className="text-[11px] font-semibold text-muted">
              <span className="mb-1 block">Access method</span>
              <Select
                value={filters.accessMethod} onChange={setFilter('accessMethod')} size="sm"
                options={[
                  { id: '', label: 'All access methods' },
                  ...(facets?.present?.access_methods || []).map((m) => ({ id: m, label: m })),
                ]}
              />
            </label>
            <label className="text-[11px] font-semibold text-muted">
              <span className="mb-1 block">Account / subscription</span>
              <Select
                value={filters.accountRef} onChange={setFilter('accountRef')} size="sm"
                options={[
                  { id: '', label: 'All' },
                  ...(facets?.present?.accounts || []).map((a) => ({ id: a, label: a })),
                  ...(facets?.present?.subscriptions || []).map((a) => ({ id: a, label: a })),
                ]}
              />
            </label>
            <label className="text-[11px] font-semibold text-muted">
              <span className="mb-1 block">Source IP</span>
              <Input
                value={filters.sourceIp || ''}
                onChange={(e) => setFilter('sourceIp')(e.target.value)}
                onClear={() => setFilter('sourceIp')('')}
                placeholder="e.g. 10.20.30.40"
              />
            </label>
            <label className="col-span-full flex items-center gap-2 text-[11.5px] text-muted">
              <input
                type="checkbox"
                checked={filters.excludeReadOnly}
                onChange={(e) => setFilter('excludeReadOnly')(e.target.checked)}
                className="h-3.5 w-3.5 rounded-xs border-strong"
              />
              Hide read-only operations
              <span className="text-[10.5px] text-subtle">
                (reads are most of an audit trail&apos;s volume and rarely what an
                investigation is looking for; events whose provider did not state a
                read-only flag are kept)
              </span>
            </label>
            <p className="col-span-full text-[10.5px] leading-relaxed text-subtle">
              Searchable fields:{' '}
              {(facets?.query_capabilities?.searchable_fields || []).join(', ') || '—'}.
              {' '}The raw provider payload is deliberately not searched — scanning every
              stored document would read the whole table.
            </p>
          </div>
        )}

        {/* ── Saved queries ───────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowQueries((v) => !v)}
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted hover:text-fg"
          >
            <Star size={12} /> Saved queries
            {showQueries ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Select value={sort} onChange={(v) => { setSort(v); setPage(1); }} width="auto" size="sm" options={SORT_OPTIONS} />
            <Select
              value={String(pageSize)}
              onChange={(v) => { setPageSize(Number(v)); setPage(1); }}
              width="auto" size="sm" options={PAGE_SIZE_OPTIONS}
            />
            <div className="inline-flex rounded-control border border-border bg-surface p-0.5">
              {[
                { id: 'table', label: 'Table' },
                { id: 'timeline', label: 'Timeline' },
              ].map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setView(v.id)}
                  className={`rounded-control px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                    view === v.id ? 'bg-accent-soft text-accent-text' : 'text-muted hover:text-fg'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            {canExport && (
              <>
                <Button
                  size="sm" variant="secondary" icon="download"
                  loading={exportState?.status === 'running'}
                  onClick={() => runExport('csv')}
                  title="Export every event matching the current filters — not just this page."
                >
                  CSV
                </Button>
                <Button
                  size="sm" variant="secondary"
                  loading={exportState?.status === 'running'}
                  onClick={() => runExport('json')}
                >
                  JSON
                </Button>
              </>
            )}
          </div>
        </div>

        {showQueries && (
          <SavedQueriesPanel
            saved={saved}
            canSave={canSaveQuery}
            currentFilters={filters}
            currentRange={useCustom ? undefined : range}
            accountId={accountId}
            onRun={(q) => {
              setFilters({ ...EMPTY_FILTERS, ...(q.filters?.filters || {}) });
              setSearchInput(q.filters?.filters?.search || '');
              if (q.filters?.range) { setRange(q.filters.range); setUseCustom(false); }
              setPage(1);
            }}
            onSave={(payload) => saveQueryMutation.mutate(payload)}
            onDelete={(id) => deleteQueryMutation.mutate(id)}
            saving={saveQueryMutation.isPending}
            error={saveQueryMutation.error}
          />
        )}

        {exportState?.status === 'done' && (
          <Notice tone={exportState.truncated ? 'warning' : 'success'} title="Export downloaded.">
            {exportState.filename} — {formatCount(exportState.total)} event
            {exportState.total === 1 ? '' : 's'} matching the current filters.
            {exportState.truncated && ' The export was capped, so it does not contain every matching event — narrow the window or the filters for a complete file.'}
          </Notice>
        )}
        {exportState?.status === 'error' && (
          <Notice tone="danger" title="Export failed.">{exportState.message}</Notice>
        )}

        {/* ── Activity strip ──────────────────────────────────────────────── */}
        {timeline?.buckets?.length > 0 && (
          <CloudSection
            title="Activity"
            description={`Events per ${timeline.bucket} across the selected window`}
          >
            <TimelineBars timeline={timeline} />
          </CloudSection>
        )}

        {/* ── The feed ────────────────────────────────────────────────────── */}
        <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
          <CloudSection
            title={view === 'table' ? 'Events' : 'Event timeline'}
            description={
              total > 0
                ? `${formatCount(total)} event${total === 1 ? '' : 's'} match. Click a row for the full record.`
                : 'Click a row for the full record.'
            }
            bodyClassName="space-y-3"
          >
            {listLoading ? (
              <InlineLoading label="Loading events…" />
            ) : listFailed ? (
              // A failed request must never fall through to an empty table:
              // painting zero would read as "nothing happened", the one
              // conclusion there is no evidence for.
              <EmptyState
                icon="alert"
                title="Couldn't load the event log"
                body={
                  listError?.response?.status === 404
                    ? 'The cloud service does not have the Event Log endpoints yet — it is running a build from before this tab existed. Restart it (Backend/cloud: .\\start.ps1 -Force) and reload.'
                    : `The cloud service returned ${listError?.response?.status ?? 'an error'}${
                      listError?.response?.data?.detail ? `: ${listError.response.data.detail}` : ''
                    }. This is a request failure, not an empty event log.`
                }
              />
            ) : rows.length === 0 ? (
              <EmptyState
                icon={sources?.degraded ? 'alert' : 'check'}
                title={
                  activeFilterCount > 0
                    ? 'No events match these filters'
                    : sources?.degraded
                      ? 'No events — but collection is degraded'
                      : 'No events in this window'
                }
                body={
                  activeFilterCount > 0
                    ? 'Widen the time range or clear a filter.'
                    : sources?.degraded
                      ? 'One or more event sources is not collecting, so this empty result is not evidence that nothing happened. Check collection health above.'
                      : 'Every event source is collecting normally, so nothing was recorded in the selected window. Control-plane audit events only cover changes made through the cloud API — a change made inside a VM leaves no event here.'
                }
                action={
                  // Kept, and only here: loading OLDER history for the chosen
                  // window is something a refresh does not do — it collects
                  // forward from the last checkpoint. Named for that, so it is
                  // not mistaken for a second refresh button.
                  canCollect ? (
                    <Button size="sm" variant="secondary" icon="history"
                      loading={collect.isPending}
                      onClick={collectNow}
                      title={`Fetch audit events for the selected window (last ${lookbackHours}h) from the provider. The provider's own retention still caps how far back this can reach.`}
                    >
                      Load events for the last {lookbackHours}h
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <div className={isFetching ? 'opacity-60 transition-opacity' : undefined}>
                  {view === 'table' ? (
                    <Table columns={columns} rows={tableRows} />
                  ) : (
                    <TimelineFeed events={rows} onOpen={setOpenEventId} />
                  )}
                </div>
                <Pagination
                  page={page}
                  pageCount={pageCount}
                  total={total}
                  pageSize={pageSize}
                  onPage={setPage}
                  unit="events"
                />
              </>
            )}
          </CloudSection>

          {/* ── Right rail ──────────────────────────────────────────────── */}
          <div className="space-y-4">
            <CloudSection title="Risk" >
              <ul className="space-y-1">
                {[...RISK_ORDER].reverse().map((level) => {
                  const count = stats?.by_risk?.[level] ?? 0;
                  return (
                    <li key={level}>
                      <button
                        type="button"
                        disabled={count === 0 && filters.minRisk !== level}
                        onClick={() => setFilter('minRisk')(filters.minRisk === level ? '' : level)}
                        className={`flex w-full items-center justify-between gap-2 rounded-control px-2 py-1 text-[11.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          filters.minRisk === level
                            ? 'bg-accent-soft font-semibold text-accent-text'
                            : 'text-muted hover:bg-sunken'
                        }`}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <Badge tone={RISK_TONE[level]} size="xs">{level}</Badge>
                        </span>
                        <span className="font-bold tabular-nums text-subtle">
                          {formatCount(count)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </CloudSection>

            <CloudSection title="Most active principals" >
              {stats?.top_actors?.length ? (
                <ul className="space-y-1">
                  {stats.top_actors.map((a) => {
                    const ActorIcon = ACTOR_ICON[a.actor_type] || User;
                    return (
                      <li key={a.actor_name}>
                        <button
                          type="button"
                          onClick={() => setFilter('actor')(
                            filters.actor === a.actor_name ? '' : a.actor_name,
                          )}
                          className={`flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors ${
                            filters.actor === a.actor_name
                              ? 'bg-accent-soft text-accent-text'
                              : 'hover:bg-sunken'
                          }`}
                        >
                          <ActorIcon size={12} className="shrink-0 text-subtle" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11.5px] font-medium text-fg">
                              {a.actor_name}
                            </span>
                            <span className="block truncate text-[10px] text-subtle">
                              {a.actor_type}
                              {a.high_risk > 0 && ` · ${a.high_risk} high risk`}
                              {a.failed > 0 && ` · ${a.failed} failed`}
                            </span>
                          </span>
                          <Badge tone={a.high_risk > 0 ? 'danger' : 'neutral'} size="xs">
                            {formatCount(a.events)}
                          </Badge>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-xs text-muted">No principals active in this window.</p>
              )}
            </CloudSection>

            <CloudSection title="Most touched resources">
              {stats?.top_resources?.length ? (
                <ul className="space-y-1">
                  {stats.top_resources.map((r) => (
                    <li key={r.resource_id}>
                      <button
                        type="button"
                        onClick={() => { setSearchInput(r.resource_name || r.resource_id); }}
                        className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-sunken"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11.5px] font-medium text-fg" title={r.resource_id}>
                            {r.resource_name || r.resource_id}
                          </span>
                          <span className="block truncate text-[10px] text-subtle">
                            {r.resource_type} · {relativeTime(r.last_seen)}
                          </span>
                        </span>
                        <Badge tone="neutral" size="xs">{formatCount(r.events)}</Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">No resources touched in this window.</p>
              )}
            </CloudSection>

            <CloudSection title="By provider">
              {stats?.by_provider && Object.keys(stats.by_provider).length ? (
                <ul className="space-y-1">
                  {Object.entries(stats.by_provider).map(([provider, count]) => (
                    <li key={provider}>
                      <button
                        type="button"
                        onClick={() => setFilter('provider')(
                          filters.provider === provider ? '' : provider,
                        )}
                        className={`flex w-full items-center justify-between gap-2 rounded-control px-2 py-1 text-[11.5px] transition-colors ${
                          filters.provider === provider
                            ? 'bg-accent-soft font-semibold text-accent-text'
                            : 'text-muted hover:bg-sunken'
                        }`}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <ProviderLogo provider={provider} size={13} /> {provider}
                        </span>
                        <span className="font-bold tabular-nums text-subtle">
                          {formatCount(count)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">No events in this window.</p>
              )}
            </CloudSection>

            {/* Says out loud what this feed does and does not cover, so an
                empty page is never mistaken for a quiet cloud. */}
            <p className="flex items-start gap-1.5 px-1 text-[10.5px] leading-relaxed text-subtle">
              <Eye size={12} className="mt-0.5 shrink-0" />
              This is control-plane activity: calls made to the cloud provider&apos;s
              management API, as the provider recorded them. Changes made inside a
              virtual machine, in an application, or by a provider-internal process
              leave no event here. Read operations are excluded from collection by
              default. Provider audit APIs publish with their own delay, so the newest
              minutes may still be filling in.
            </p>
          </div>
        </div>
      </div>

      <EventDetailDrawer
        eventId={openEventId}
        open={!!openEventId}
        onClose={() => setOpenEventId(null)}
        onOpenEvent={(id) => setOpenEventId(id)}
        // Clicking a principal, resource or IP inside the drawer re-filters the
        // log by it and closes the drawer, so the result is visible rather than
        // hidden behind the panel that was just used. This is the move an
        // investigation actually makes; without it the value has to be copied,
        // the drawer closed, the right filter found and the value pasted.
        onPivot={({ actor, search }) => {
          if (actor) setFilter('actor')(actor);
          if (search) setSearchInput(search);
          setPage(1);
          setOpenEventId(null);
        }}
      />
    </>
  );
};

/** Save, run and delete named filter sets. */
const SavedQueriesPanel = ({
  saved, canSave, currentFilters, currentRange, accountId,
  onRun, onSave, onDelete, saving, error,
}) => {
  const [name, setName] = useState('');
  const items = saved?.items || [];

  const activeCount = FILTER_KEYS.filter((k) => (
    k === 'excludeReadOnly' ? currentFilters[k] === true : !!currentFilters[k]
  )).length;

  return (
    <div className="space-y-3 rounded-card border border-border bg-surface p-3">
      {items.length === 0 ? (
        <p className="text-[11.5px] text-muted">
          No saved queries yet. Set up a filter combination you use often and save it here.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {items.map((q) => (
            <li key={q.id} className="inline-flex items-center gap-1 rounded-control border border-border bg-sunken pl-2">
              <button
                type="button"
                onClick={() => onRun(q)}
                title={q.description || 'Run this saved query'}
                className="py-1 text-[11px] font-semibold text-fg hover:text-accent-text"
              >
                {q.name}
              </button>
              <button
                type="button"
                onClick={() => onDelete(q.id)}
                aria-label={`Delete ${q.name}`}
                className="px-1.5 py-1 text-subtle transition-colors hover:text-danger-fg"
              >
                <Trash2 size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {canSave && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onClear={() => setName('')}
            placeholder="Name this filter set, e.g. Critical IAM changes"
            wrapperClassName="min-w-[220px] max-w-sm flex-1"
          />
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            loading={saving}
            disabled={!name.trim() || activeCount === 0}
            onClick={() => {
              // The saved payload records the filters AND the window, so
              // re-running it reproduces the same question rather than the
              // same filters over whatever window happens to be selected.
              onSave({
                name: name.trim(),
                account_id: accountId,
                filters: { filters: currentFilters, range: currentRange },
              });
              setName('');
            }}
          >
            Save current filters
          </Button>
          {activeCount === 0 && (
            <span className="text-[10.5px] text-subtle">
              Set at least one filter before saving.
            </span>
          )}
          {error && (
            <span className="text-[10.5px] text-danger-fg">
              {error?.response?.data?.detail || 'Could not save that query.'}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default EventLogPage;
