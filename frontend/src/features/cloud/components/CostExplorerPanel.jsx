import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Filter, Link2, Unlink, PowerOff, Sparkles, AlertTriangle, X, Loader2,
} from 'lucide-react';
import { useCostReport } from '../hooks/useCost';
import { CostFilterTree, EMPTY_TREE_SELECTION, matchesTreeSelection } from './CostFilterTree';
import CloudFilterBar from './CloudFilterBar';
import Table, { EmptyState } from '@/components/ui/Table';
import Pagination, { paginate, pageCountOf } from '@/components/ui/Pagination';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { InlineLoading } from '@/components/ui/Loading';
import { compact, exact, symbolFor } from '../utils/costFormat';

const DAY_PRESETS = [30, 90, 180, 365];
const PAGE_SIZE = 25;
const STOPPED_RE = /stop|deallocat/i;

// Drives both the Group By selector and the table's dynamic columns. 'resource'
// is the only leaf that isn't an aggregation — it shows the raw per-resource
// rows the tree/filters already narrowed down to.
const GROUP_DIMENSIONS = [
  { id: 'service', label: 'Service' },
  { id: 'resource_type', label: 'Resource Type' },
  { id: 'resource', label: 'Resource' },
  { id: 'region', label: 'Region' },
  { id: 'account_name', label: 'Account' },
  { id: 'cost_component', label: 'Cost Component' },
];

const COMPONENT_TONE = {
  Compute: 'info', Database: 'warning', Storage: 'accent', Network: 'success', Other: 'neutral',
};

// Grouped on `cost_inr` (every row converted to INR server-side), not the
// native `cost` — rows here can span providers that bill in different
// currencies, and summing their raw amounts would add dollars to rupees.
function groupRows(rows, dimId) {
  const groups = new Map();
  for (const r of rows) {
    const key = r[dimId] || 'Unknown';
    const g = groups.get(key) || { key, count: 0, cost: 0, resourceIds: new Set() };
    g.cost += Number(r.cost_inr) || 0;
    g.resourceIds.add(r.provider_resource_id || r.resource_name || `${key}:${g.count}`);
    groups.set(key, g);
  }
  return Array.from(groups.values())
    .map((g) => ({ key: g.key, count: g.resourceIds.size, cost: g.cost }))
    .sort((a, b) => b.cost - a.cost);
}

export const CostExplorerPanel = ({ accountId, potentialSavings, savingsCurrency }) => {
  const navigate = useNavigate();
  const [days, setDays] = useState(30);
  const [groupBy, setGroupBy] = useState('service');
  const [treeSelection, setTreeSelection] = useState(EMPTY_TREE_SELECTION);
  // Narrow layouts only (below md the tree stacks above the table): collapsed
  // until asked for, so the results are not pushed a screen down.
  const [treeOpen, setTreeOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('All');
  const [serviceFilter, setServiceFilter] = useState('All');
  const [regionFilter, setRegionFilter] = useState('All');
  const [typeFilter, setTypeFilter] = useState('All');
  const [componentFilter, setComponentFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [stoppedOnly, setStoppedOnly] = useState(false);
  const [minCost, setMinCost] = useState('');
  const [maxCost, setMaxCost] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching, isError } = useCostReport(accountId, days, true, 'resource');
  const rawRows = data?.rows || [];

  // AWS has no per-resource billing API — fall back to the service/day shape
  // once, the same way the Detailed Cost Report panel already does, instead
  // of showing a permanently empty Explorer for that provider.
  const [autoFellBack, setAutoFellBack] = useState(false);
  useEffect(() => {
    if (isLoading || !data) return;
    if (rawRows.length === 0 && !autoFellBack) {
      setAutoFellBack(true);
      setGroupBy('service');
    }
  }, [isLoading, data, rawRows.length, autoFellBack]);
  const { data: fallbackData, isLoading: fallbackLoading } = useCostReport(
    accountId, days, autoFellBack, 'service',
  );
  const rows = autoFellBack ? (fallbackData?.rows || []) : rawRows;
  const usingFallback = autoFellBack;

  // The panel's own currency is fixed at INR: every row carries `cost_inr`,
  // converted server-side with a live FX rate (see `cost_service.get_cost_report`
  // / `fx_rate_service`), so totals here are never a raw sum across whatever
  // currencies the underlying providers happen to bill in.

  const uniqSorted = (key, source) => Array.from(new Set(source.map((r) => r[key]).filter(Boolean))).sort();
  const providers = useMemo(() => uniqSorted('provider', rows), [rows]);
  const services = useMemo(() => uniqSorted('service', rows), [rows]);
  const regions = useMemo(() => uniqSorted('region', rows), [rows]);
  const resourceTypes = useMemo(() => uniqSorted('resource_type', rows), [rows]);
  const components = useMemo(() => uniqSorted('cost_component', rows), [rows]);
  const statuses = useMemo(() => uniqSorted('status', rows), [rows]);

  const treeFiltered = useMemo(() => rows.filter((r) => matchesTreeSelection(r, treeSelection)), [rows, treeSelection]);

  const filtered = useMemo(() => {
    const minC = minCost !== '' ? parseFloat(minCost) : null;
    const maxC = maxCost !== '' ? parseFloat(maxCost) : null;
    const s = search.trim().toLowerCase();
    return treeFiltered.filter((r) => {
      if (providerFilter !== 'All' && r.provider !== providerFilter) return false;
      if (serviceFilter !== 'All' && r.service !== serviceFilter) return false;
      if (regionFilter !== 'All' && r.region !== regionFilter) return false;
      if (typeFilter !== 'All' && r.resource_type !== typeFilter) return false;
      if (componentFilter !== 'All' && r.cost_component !== componentFilter) return false;
      if (statusFilter !== 'All' && r.status !== statusFilter) return false;
      if (stoppedOnly && !STOPPED_RE.test(r.status || '')) return false;
      if (minC != null && !Number.isNaN(minC) && (r.cost_inr ?? 0) < minC) return false;
      if (maxC != null && !Number.isNaN(maxC) && (r.cost_inr ?? 0) > maxC) return false;
      if (s) {
        const hay = [
          r.service, r.account_name, r.region, r.provider, r.resource_name,
          r.resource_type, r.attached_to_name, r.provider_resource_id, r.cost_component,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [treeFiltered, providerFilter, serviceFilter, regionFilter, typeFilter,
    componentFilter, statusFilter, stoppedOnly, minCost, maxCost, search]);

  // Real cost-component totals for the summary cards — computed from the same
  // filtered dataset the table shows, so the cards always agree with it.
  const componentTotals = useMemo(() => {
    const totals = { Compute: 0, Database: 0, Storage: 0, Network: 0, Other: 0 };
    let total = 0;
    for (const r of filtered) {
      const c = Number(r.cost_inr) || 0;
      total += c;
      const bucket = r.cost_component && totals[r.cost_component] !== undefined ? r.cost_component : 'Other';
      totals[bucket] += c;
    }
    return { ...totals, total };
  }, [filtered]);

  // usingFallback rows are day/service totals (AWS has no per-resource billing
  // API), never individual resources — rendering them through the Resource
  // table would label billing-dimension codes like "APS3-TimedStorage-ByteHrs"
  // as "not in inventory" resources, which is what they are NOT. Gate on both,
  // not just groupBy, so a stale 'resource' selection can never hit this path.
  const isResourceLevel = groupBy === 'resource' && !usingFallback;
  const groupedRows = useMemo(() => (isResourceLevel ? null : groupRows(filtered, groupBy)), [isResourceLevel, filtered, groupBy]);
  const resultCount = isResourceLevel ? filtered.length : groupedRows.length;

  const clearFilters = () => {
    setSearch(''); setProviderFilter('All'); setServiceFilter('All'); setRegionFilter('All');
    setTypeFilter('All'); setComponentFilter('All'); setStatusFilter('All'); setStoppedOnly(false);
    setMinCost(''); setMaxCost(''); setPage(1);
  };
  const hasActiveFilters = !!(search || providerFilter !== 'All' || serviceFilter !== 'All'
    || regionFilter !== 'All' || typeFilter !== 'All' || componentFilter !== 'All'
    || statusFilter !== 'All' || stoppedOnly || minCost || maxCost || treeSelection.provider);

  const pageCount = pageCountOf(resultCount, PAGE_SIZE);
  const clampedPage = Math.min(page, pageCount);

  const breadcrumb = [
    treeSelection.provider, treeSelection.account, treeSelection.region,
    treeSelection.service, treeSelection.type,
  ].filter(Boolean);

  const groupLabel = GROUP_DIMENSIONS.find((d) => d.id === groupBy)?.label || groupBy;

  const columns = isResourceLevel
    ? [
      { key: 'resource', label: 'Resource' },
      { key: 'component', label: 'Component' },
      { key: 'service', label: 'Service' },
      { key: 'region', label: 'Region' },
      { key: 'attached', label: 'Attached To' },
      { key: 'status', label: 'Status' },
      { key: 'cost', label: 'Cost', align: 'right' },
    ]
    : [
      { key: 'name', label: groupLabel },
      { key: 'count', label: 'Resources', align: 'right' },
      { key: 'cost', label: 'Cost', align: 'right' },
      { key: 'share', label: '% of Total', align: 'right' },
    ];

  const pageItems = isResourceLevel
    ? paginate(filtered, clampedPage, PAGE_SIZE)
    : paginate(groupedRows, clampedPage, PAGE_SIZE);
  const filteredTotal = isResourceLevel
    ? filtered.reduce((sum, r) => sum + (Number(r.cost_inr) || 0), 0)
    : groupedRows.reduce((sum, g) => sum + g.cost, 0);

  const tableRows = isResourceLevel
    ? pageItems.map((r, i) => ({
      key: i,
      // Only rows actually matched to inventory have our internal id to link
      // to — an unmatched ("not in inventory") row has nowhere to navigate.
      onClick: r.resource_id ? () => navigate(`/cloud/resources/${r.resource_id}`) : undefined,
      cells: {
        resource: (
          <div className="max-w-[240px]">
            {r.resource_name ? (
              <span className="font-semibold text-fg">{r.resource_name}</span>
            ) : (
              <span className="text-subtle italic" title={r.compartment_name ? `${r.provider_resource_id} (compartment: ${r.compartment_name})` : r.provider_resource_id}>
                not in inventory
              </span>
            )}
            <div className="text-micro text-subtle">{r.resource_type || '—'}</div>
          </div>
        ),
        component: r.cost_component
          ? <Badge tone={COMPONENT_TONE[r.cost_component] || 'neutral'}>{r.cost_component}</Badge>
          : '—',
        service: r.service || '—',
        region: r.region || '—',
        attached: r.attached_to_name ? (
          <span className="inline-flex items-center gap-1.5 text-fg">
            <Link2 size={12} className="shrink-0 text-accent-text" />
            {r.attached_to_name}
          </span>
        ) : r.attachment_status === 'Unattached' ? (
          <span className="inline-flex items-center gap-1.5 text-warning">
            <Unlink size={12} className="shrink-0" /> Unattached
          </span>
        ) : <span className="text-subtle">—</span>,
        status: r.status ? (
          <Badge tone={STOPPED_RE.test(r.status) ? 'danger' : 'neutral'}>{r.status}</Badge>
        ) : '—',
        cost: <span className="font-semibold text-fg" title={exact(r.cost_inr, 'INR')}>{compact(r.cost_inr, 'INR')}</span>,
      },
    }))
    : pageItems.map((g, i) => {
      // Without per-resource billing (AWS today), Service -> Resource Type is
      // the only click that ever reveals something new — Region and Account
      // rows would just re-narrow to the value they already show and stay on
      // the same grouping, which LOOKS interactive but does nothing, the
      // exact "why isn't/why doesn't this do anything" confusion Resource
      // Type rows caused before they were made explicitly non-clickable. With
      // real per-resource billing (OCI/Azure), every level genuinely drills
      // down to the Resource view, so all of them stay clickable.
      const clickAdvancesView = usingFallback ? groupBy === 'service' : groupBy !== 'cost_component';
      return {
        key: i,
        onClick: clickAdvancesView ? () => {
          if (groupBy === 'service') setServiceFilter(g.key);
          else if (groupBy === 'resource_type') setTypeFilter(g.key);
          else if (groupBy === 'region') setRegionFilter(g.key);
          setPage(1);
          setGroupBy(usingFallback ? 'resource_type' : 'resource');
        } : undefined,
        cells: {
          name: <span className="font-semibold text-fg">{g.key}</span>,
          count: g.count.toLocaleString(),
          cost: <span className="font-semibold text-fg" title={exact(g.cost, 'INR')}>{compact(g.cost, 'INR')}</span>,
          share: componentTotals.total > 0 ? `${((g.cost / componentTotals.total) * 100).toFixed(1)}%` : '—',
        },
      };
    });

  const filterFields = [
    providers.length > 1 && {
      key: 'provider', value: providerFilter,
      onChange: (v) => { setProviderFilter(v); setPage(1); },
      options: [{ id: 'All', label: 'All Providers' }, ...providers.map((p) => ({ id: p, label: p }))],
    },
    {
      key: 'service', value: serviceFilter,
      onChange: (v) => { setServiceFilter(v); setPage(1); },
      options: [{ id: 'All', label: 'All Services' }, ...services.map((s) => ({ id: s, label: s }))],
    },
    resourceTypes.length > 0 && {
      key: 'type', value: typeFilter,
      onChange: (v) => { setTypeFilter(v); setPage(1); },
      options: [{ id: 'All', label: 'All Resource Types' }, ...resourceTypes.map((t) => ({ id: t, label: t }))],
    },
    {
      key: 'region', value: regionFilter,
      onChange: (v) => { setRegionFilter(v); setPage(1); },
      options: [{ id: 'All', label: 'All Regions' }, ...regions.map((r) => ({ id: r, label: r }))],
    },
    components.length > 0 && {
      key: 'component', value: componentFilter,
      onChange: (v) => { setComponentFilter(v); setPage(1); },
      options: [{ id: 'All', label: 'All Components' }, ...components.map((c) => ({ id: c, label: c }))],
    },
    statuses.length > 0 && {
      key: 'status', value: statusFilter,
      onChange: (v) => { setStatusFilter(v); setPage(1); },
      options: [{ id: 'All', label: 'All Statuses' }, ...statuses.map((s) => ({ id: s, label: s }))],
    },
  ].filter(Boolean);

  const loading = isLoading || (autoFellBack && fallbackLoading);

  return (
    <div className="space-y-4">
      {/* Cost Summary cards — real totals from the currently filtered rows */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Total', componentTotals.total, 'text-fg', null],
          ['Compute', componentTotals.Compute, 'text-info', 'info'],
          ['Database', componentTotals.Database, 'text-warning', 'warning'],
          ['Storage', componentTotals.Storage, 'text-accent-text', 'accent'],
          ['Network', componentTotals.Network, 'text-success', 'success'],
          ['Other', componentTotals.Other, 'text-muted', 'neutral'],
        ].map(([label, value]) => (
          <div key={label} className="rounded-control border border-border bg-surface p-3">
            <p className="text-micro font-bold uppercase tracking-wider text-subtle">{label}</p>
            <p className="mt-1 truncate text-base font-bold text-fg" title={exact(value, 'INR')}>
              {compact(value, 'INR')}
            </p>
          </div>
        ))}
        <div className="rounded-control border border-success/30 bg-success-soft p-3">
          <p className="flex items-center gap-1 text-micro font-bold uppercase tracking-wider text-success-fg">
            <Sparkles size={11} /> Potential Savings
          </p>
          <p className="mt-1 truncate text-base font-bold text-success">
            {potentialSavings == null ? 'NA' : `${symbolFor(savingsCurrency)}${potentialSavings.toFixed(2)}`}
          </p>
        </div>
      </div>

      {/* Range + Group By */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-meta font-bold uppercase tracking-wider text-muted">Range:</span>
        {DAY_PRESETS.map((d) => (
          <Button key={d} size="sm" variant={days === d ? 'subtle' : 'secondary'} onClick={() => { setDays(d); setPage(1); }}>
            Last {d} days
          </Button>
        ))}
        {isFetching && (
          <span className="flex items-center gap-1.5 text-xs text-subtle">
            <Loader2 size={12} className="animate-spin" /> Refreshing…
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-meta font-bold uppercase tracking-wider text-muted">Group By:</span>
        {GROUP_DIMENSIONS.map((d) => (
          <Button
            key={d.id}
            size="sm"
            variant={groupBy === d.id ? 'subtle' : 'secondary'}
            disabled={d.id === 'resource' && usingFallback}
            title={d.id === 'resource' && usingFallback ? 'Not available for AWS — Cost Explorer has no per-resource billing API' : undefined}
            onClick={() => { setGroupBy(d.id); setPage(1); }}
          >
            {d.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant={stoppedOnly ? 'subtle' : 'secondary'}
          onClick={() => { setStoppedOnly((v) => !v); setPage(1); }}
        >
          <PowerOff size={12} /> Stopped only
        </Button>
        {usingFallback && (
          <span className="rounded-control border border-warning/30 bg-warning-soft px-2 py-1 text-meta text-warning-fg">
            No per-resource billing for this provider — showing Service &amp; day totals; Resource level is unavailable.
          </span>
        )}
      </div>

      {isError ? (
        <div className="flex items-center gap-2 py-6 text-sm text-danger">
          <AlertTriangle size={16} /> Failed to load cost data.
        </div>
      ) : loading || !data ? (
        <InlineLoading label={`Querying billing APIs for the last ${days} days…`} className="py-14" />
      ) : rows.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted">
          No billing rows returned for this range.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[220px_1fr]">
          {/* Below md (≈250% zoom on a 1080p screen) the tree would stack above
              the table and push the results down by its full length, so there
              it collapses behind this toggle. From md up it is always shown. */}
          <button
            type="button"
            onClick={() => setTreeOpen((v) => !v)}
            aria-expanded={treeOpen}
            aria-controls="cost-drill-down"
            className="flex items-center justify-between gap-2 rounded-control border border-border bg-sunken px-3 py-2 text-left text-meta font-bold uppercase tracking-wider text-muted md:hidden"
          >
            <span className="inline-flex items-center gap-1.5">
              <Filter size={12} /> Drill down
              {Object.values(treeSelection).filter(Boolean).length > 0 && (
                <span className="rounded-full bg-accent-soft px-1.5 text-accent-text normal-case">
                  {Object.values(treeSelection).filter(Boolean).length} active
                </span>
              )}
            </span>
            <span aria-hidden="true">{treeOpen ? '−' : '+'}</span>
          </button>

          {/* Drill-down tree */}
          <div
            id="cost-drill-down"
            className={`rounded-control border border-border bg-sunken p-3 ${treeOpen ? 'block' : 'hidden'} md:block`}
          >
            <div className="mb-2 flex items-center gap-1.5 px-1 text-meta font-bold uppercase tracking-wider text-muted">
              <Filter size={12} /> Drill Down
            </div>
            <CostFilterTree items={rows} selection={treeSelection} onChange={(sel) => { setTreeSelection(sel); setPage(1); }} />
          </div>

          <div className="space-y-3">
            {breadcrumb.length > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-muted">
                {breadcrumb.map((crumb, i) => (
                  <span key={i} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-subtle">/</span>}
                    <span className="font-semibold text-fg">{crumb}</span>
                  </span>
                ))}
                <button
                  onClick={() => { setTreeSelection(EMPTY_TREE_SELECTION); setPage(1); }}
                  className="ml-1 inline-flex items-center gap-1 text-accent-text hover:opacity-80"
                >
                  <X size={12} /> Clear
                </button>
              </div>
            )}

            <CloudFilterBar
              search={search}
              onSearchChange={(v) => { setSearch(v); setPage(1); }}
              searchPlaceholder="Search resource, service, region…"
              filters={filterFields}
            />
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                placeholder="Min cost"
                className="w-24 rounded-control border border-border bg-surface px-2.5 py-1.5 text-xs text-fg placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-accent"
                value={minCost}
                onChange={(e) => { setMinCost(e.target.value); setPage(1); }}
              />
              <input
                type="number"
                placeholder="Max cost"
                className="w-24 rounded-control border border-border bg-surface px-2.5 py-1.5 text-xs text-fg placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-accent"
                value={maxCost}
                onChange={(e) => { setMaxCost(e.target.value); setPage(1); }}
              />
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" icon="close" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border bg-sunken px-4 py-2.5">
              <span className="text-xs text-muted">
                <strong className="text-fg">{resultCount.toLocaleString()}</strong>{' '}
                {isResourceLevel ? 'resources' : groupLabel.toLowerCase() + ' groups'} ·
                Total <strong className="text-fg">{exact(filteredTotal, 'INR')}</strong>
              </span>
            </div>
            {usingFallback && groupBy !== 'service' && groupBy !== 'cost_component' && (
              <p className="text-meta text-subtle">
                Rows here aren&rsquo;t clickable — {groupBy === 'resource_type'
                  ? 'Resource Type is the deepest billing detail available for this provider.'
                  : `grouping by ${groupLabel} has nothing further to drill into for this provider.`}{' '}
                AWS Cost Explorer has no per-resource billing API, so individual resources behind a
                usage-type code (e.g. a specific S3 bucket or Elastic IP) can&rsquo;t be identified from
                cost data alone — Group By Service is the only view that drills any deeper.
              </p>
            )}

            <div className="card overflow-hidden">
              <Table
                columns={columns}
                rows={tableRows}
                empty={<EmptyState icon="search" title="No rows match these filters" />}
              />
              <Pagination page={clampedPage} pageCount={pageCount} total={resultCount} onPage={setPage} unit={isResourceLevel ? 'resources' : 'groups'} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
