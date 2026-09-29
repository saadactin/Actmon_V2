import { useEffect, useMemo, useRef, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Select from '@/components/ui/Select';
import {
  CATEGORY_ORDER, HEALTH_OPTIONS, LAYOUTS, VIEW_MODES, edgeStyle, formatCount, providerMeta,
  typeMeta,
} from '../utils/topologyModel';

/**
 * The topology's controls: cloud, scope, search, filters, view mode, layout.
 *
 * Every dropdown's options come from the graph's own facets, with counts. A
 * fixed list would offer regions and resource types an account does not have
 * and omit the ones it does — the same failure the original legend had before
 * it was driven by the edges actually present.
 */

function ChipRow({ label, options, value, onChange }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="sr-only">{label}</span>
      {options.map((option) => {
        const active = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            aria-pressed={active}
            className={`inline-flex h-control items-center gap-1.5 whitespace-nowrap rounded-control border px-2.5 text-[12px] font-semibold transition-colors ${
              active
                ? 'border-accent bg-accent-soft text-fg'
                : 'border-border bg-surface text-muted hover:bg-sunken hover:text-fg'
            }`}
          >
            {option.label}
            {option.count !== undefined && (
              <span className={active ? 'text-fg/70' : 'text-subtle'}>{formatCount(option.count)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** A facet dropdown, built from the API's counts. */
function FacetSelect({ label, facet, value, onChange, allLabel }) {
  const options = useMemo(() => [
    { id: '', label: allLabel },
    ...(facet || []).map((row) => ({
      id: String(row.value),
      label: `${row.value} (${formatCount(row.count)})`,
    })),
  ], [facet, allLabel]);

  if (!facet?.length) return null;
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">{label}</span>
      <Select value={value || ''} onChange={onChange} options={options} size="sm" width="auto" />
    </label>
  );
}

export default function TopologyToolbar({
  providerScope,
  onChangeProviderScope,
  providerCounts,
  accountOptions,
  accountScope,
  onChangeAccountScope,
  search,
  onChangeSearch,
  searchResults,
  onPickSearchResult,
  view,
  onChangeView,
  layout,
  onChangeLayout,
  filters,
  onChangeFilter,
  onClearFilters,
  activeFilterCount,
  facets,
  hideDefaults,
  onToggleHideDefaults,
  hideIsolated,
  onToggleHideIsolated,
  hideEmptyContainers,
  onToggleHideEmptyContainers,
  clusterLarge,
  onToggleClusterLarge,
  contextHops,
  onChangeContextHops,
  defaultCount,
  edgeCounts,
  nodeCount,
  edgeCount,
  matchedCount,
  onOpenDiagnostics,
  onOpenPathFinder,
  onExport,
  displayMode,
  onChangeDisplayMode,
  fullscreen,
  onToggleFullscreen,
}) {
  const [showFilters, setShowFilters] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    const onClickAway = (event) => {
      if (searchRef.current && !searchRef.current.contains(event.target)) setSearchOpen(false);
    };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, []);

  const providerChips = useMemo(() => {
    const counts = new Map((providerCounts || []).map((row) => [row.value, row.count]));
    const total = (providerCounts || []).reduce((sum, row) => sum + row.count, 0);
    return [
      { id: 'ALL', label: 'All clouds', count: total },
      ...['AWS', 'Azure', 'OCI']
        .filter((key) => counts.has(key) || providerScope === key)
        .map((key) => ({ id: key, label: providerMeta(key).label, count: counts.get(key) ?? 0 })),
    ];
  }, [providerCounts, providerScope]);

  // Group search results by provider, which is what section 41 asks for and
  // is genuinely useful when the same name exists in two clouds.
  const groupedResults = useMemo(() => {
    const groups = new Map();
    (searchResults?.results || []).forEach((node) => {
      const key = node.provider || 'Unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(node);
    });
    return [...groups.entries()];
  }, [searchResults]);

  return (
    <div className="flex flex-col gap-2.5">
      {/* ── Row 1: scope, search, actions ──────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <ChipRow label="Cloud" options={providerChips} value={providerScope} onChange={onChangeProviderScope} />

        {accountOptions?.length > 1 && (
          <Select
            value={accountScope || 'ALL'}
            onChange={onChangeAccountScope}
            options={accountOptions}
            size="sm"
            width="auto"
          />
        )}

        {/* Search with a grouped result list */}
        <div ref={searchRef} className="relative">
          <div className="flex h-control w-[240px] items-center gap-2 rounded-control border border-border bg-surface px-2.5 focus-within:ring-2 focus-within:ring-accent">
            <Icon name="search" size={14} className="shrink-0 text-subtle" />
            <input
              type="text"
              value={search}
              onChange={(event) => { onChangeSearch(event.target.value); setSearchOpen(true); }}
              onFocus={() => setSearchOpen(true)}
              placeholder="Name, ID, ARN, OCID, IP…"
              aria-label="Search resources"
              className="w-full border-none bg-transparent text-[13px] text-fg outline-none placeholder:text-subtle"
            />
            {search && (
              <button
                type="button"
                onClick={() => { onChangeSearch(''); setSearchOpen(false); }}
                aria-label="Clear search"
                className="shrink-0 text-subtle hover:text-fg"
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>

          {searchOpen && search.length >= 2 && (
            <div className="absolute left-0 top-[calc(100%+4px)] z-30 max-h-[380px] w-[340px] overflow-y-auto rounded-card border border-border bg-surface shadow-lg">
              {!searchResults ? (
                <p className="px-3 py-2.5 text-[12px] text-subtle">Searching…</p>
              ) : searchResults.total === 0 ? (
                <p className="px-3 py-2.5 text-[12px] text-subtle">
                  Nothing in this scope matches “{search}”.
                </p>
              ) : (
                <>
                  <p className="border-b border-border px-3 py-1.5 text-[11px] text-subtle">
                    {formatCount(searchResults.total)} match
                    {searchResults.total === 1 ? '' : 'es'}
                    {searchResults.truncated ? ' · showing the closest' : ''}
                  </p>
                  {groupedResults.map(([provider, rows]) => (
                    <div key={provider}>
                      <p className="sticky top-0 bg-sunken px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-subtle">
                        {providerMeta(provider).label} · {rows.length}
                      </p>
                      {rows.map((node) => {
                        const meta = typeMeta(node.type);
                        return (
                          <button
                            key={node.id}
                            type="button"
                            onClick={() => { onPickSearchResult?.(node.id); setSearchOpen(false); }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent-soft"
                          >
                            <span className="h-5 w-1 shrink-0 rounded-sm" style={{ background: meta.color }} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12.5px] text-fg">{node.name}</span>
                              <span className="block truncate text-[11px] text-subtle">
                                {meta.label}
                                {node.region ? ` · ${node.region}` : ''}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant={showFilters || activeFilterCount ? 'secondary' : 'ghost'}
            size="sm"
            icon="filter"
            onClick={() => setShowFilters((v) => !v)}
          >
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-1 rounded-full bg-accent px-1.5 text-[10px] font-bold text-white">
                {activeFilterCount}
              </span>
            )}
          </Button>
          <Button variant="ghost" size="sm" icon="route" onClick={onOpenPathFinder}>
            Find path
          </Button>
          <Button variant="ghost" size="sm" icon="activity" onClick={onOpenDiagnostics}>
            Diagnostics
          </Button>
          <IconButton
            icon={displayMode === 'graph' ? 'list' : 'network'}
            label={displayMode === 'graph' ? 'Switch to the list view' : 'Switch to the graph view'}
            onClick={() => onChangeDisplayMode(displayMode === 'graph' ? 'list' : 'graph')}
          />
          <IconButton icon="download" label="Export the current view" onClick={onExport} />
          <IconButton
            icon="expand"
            label={fullscreen ? 'Exit full screen' : 'Full screen'}
            onClick={onToggleFullscreen}
          />
          {/* No rebuild button: every refresh drops the cached graph, and the
              header's Refresh all re-reads this tab when it finishes. */}
        </div>
      </div>

      {/* ── Row 2: view mode and layout ────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">View</span>
          <ChipRow label="View mode" options={VIEW_MODES} value={view} onChange={onChangeView} />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">Layout</span>
          <Select
            value={layout}
            onChange={onChangeLayout}
            options={LAYOUTS.map((entry) => ({ id: entry.id, label: entry.label }))}
            size="sm"
            width="auto"
          />
          <span className="hidden text-[11px] text-subtle lg:inline">
            {LAYOUTS.find((entry) => entry.id === layout)?.hint}
          </span>
        </div>
      </div>

      {/* ── Filters ────────────────────────────────────────────────────── */}
      {showFilters && (
        <div className="rounded-card border border-border bg-sunken p-3">
          <div className="flex flex-wrap items-end gap-2.5">
            <FacetSelect label="Account" facet={facets?.account} value={filters.accountName}
              onChange={(v) => onChangeFilter('accountName', v)} allLabel="All accounts" />
            <FacetSelect label="Region" facet={facets?.region} value={filters.region}
              onChange={(v) => onChangeFilter('region', v)} allLabel="All regions" />
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">Category</span>
              <Select
                value={filters.category || ''}
                onChange={(v) => onChangeFilter('category', v)}
                size="sm"
                width="auto"
                options={[
                  { id: '', label: 'All categories' },
                  ...CATEGORY_ORDER
                    .map((name) => {
                      const row = (facets?.category || []).find((entry) => entry.value === name);
                      return row ? { id: name, label: `${name} (${formatCount(row.count)})` } : null;
                    })
                    .filter(Boolean),
                ]}
              />
            </label>
            <FacetSelect label="Resource type" facet={facets?.resource_type} value={filters.resourceType}
              onChange={(v) => onChangeFilter('resourceType', v)} allLabel="All types" />
            <FacetSelect label="Status" facet={facets?.status} value={filters.status}
              onChange={(v) => onChangeFilter('status', v)} allLabel="Any status" />
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">Health</span>
              <Select
                value={filters.health || ''}
                onChange={(v) => onChangeFilter('health', v)}
                options={HEALTH_OPTIONS}
                size="sm"
                width="auto"
              />
            </label>
            <FacetSelect label="Resource group" facet={facets?.resource_group} value={filters.resourceGroup}
              onChange={(v) => onChangeFilter('resourceGroup', v)} allLabel="All groups" />
            <FacetSelect label="Compartment" facet={facets?.compartment} value={filters.compartmentName}
              onChange={(v) => onChangeFilter('compartmentName', v)} allLabel="All compartments" />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
            {[
              ['exposed', 'Internet exposed', 'Only resources the exposure engine found reachable from the internet.'],
              ['hasDrift', 'Has configuration changes', 'Only resources with entries in the change log.'],
              ['hasEvents', 'Has audit events', 'Only resources touched in the last 30 days.'],
              ['hasBroadAccess', 'Has a wildcard IAM grant', 'Only resources whose identity grants access with a wildcard.'],
            ].map(([key, label, title]) => (
              <label key={key} className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted" title={title}>
                <input
                  type="checkbox"
                  checked={!!filters[key]}
                  onChange={(event) => onChangeFilter(key, event.target.checked)}
                  className="h-3.5 w-3.5 rounded border-border accent-[var(--accent)]"
                />
                {label}
              </label>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">Reduce clutter</span>
            {[
              [hideDefaults, onToggleHideDefaults,
                `Hide provider defaults${defaultCount ? ` (${defaultCount})` : ''}`,
                'Default VPCs, security groups, route tables and security lists the provider created.'],
              [hideIsolated, onToggleHideIsolated, 'Hide unconnected',
                'Resources with no discovered relationship. They stay in the data and in Diagnostics.'],
              [hideEmptyContainers, onToggleHideEmptyContainers, 'Hide empty containers',
                'Resource groups and compartments that hold nothing we discovered.'],
              [clusterLarge, onToggleClusterLarge, 'Group large sets',
                'Collapse eight or more resources of the same type in the same container into one node. Click it to expand.'],
            ].map(([checked, toggle, label, title]) => (
              <label key={label} className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted" title={title}>
                <input
                  type="checkbox"
                  checked={!!checked}
                  onChange={(event) => toggle(event.target.checked)}
                  className="h-3.5 w-3.5 rounded border-border accent-[var(--accent)]"
                />
                {label}
              </label>
            ))}
          </div>

          {(activeFilterCount > 0 || search) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <label className="flex items-center gap-1.5 text-[12px] text-muted">
                Keep
                <Select
                  value={String(contextHops)}
                  onChange={(v) => onChangeContextHops(Number(v))}
                  options={[
                    { id: '0', label: 'only matches' },
                    { id: '1', label: '1 hop of context' },
                    { id: '2', label: '2 hops of context' },
                  ]}
                  size="sm"
                  width="auto"
                />
              </label>
              <span className="text-[11px] text-subtle">
                Context resources are dimmed so the matches stay identifiable.
                {matchedCount !== undefined && matchedCount !== nodeCount && (
                  <> {formatCount(matchedCount)} of {formatCount(nodeCount)} shown matched.</>
                )}
              </span>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={onClearFilters}>
                Clear all filters
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Legend ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-card border border-border bg-surface px-3 py-2">
        {Object.entries(edgeCounts || {})
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => {
            const style = edgeStyle(type);
            return (
              <span key={type} className="inline-flex items-center gap-1.5 text-[11.5px] text-muted">
                <svg width="18" height="8" aria-hidden="true">
                  <line
                    x1="0" y1="4" x2="18" y2="4"
                    stroke={style.color}
                    strokeWidth="2.5"
                    strokeDasharray={style.dash}
                  />
                </svg>
                {style.label}
                <span className="text-subtle">{formatCount(count)}</span>
              </span>
            );
          })}
        {(!edgeCounts || Object.keys(edgeCounts).length === 0) && (
          <span className="text-[11.5px] text-subtle">No relationships in the current view</span>
        )}

        <span className="ml-auto inline-flex items-center gap-3 text-[11.5px] text-subtle">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-danger-fg" /> Public
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-warning-fg" /> Changed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-info-fg" /> Events
          </span>
          <Badge tone="neutral" size="sm">
            {formatCount(nodeCount)} resources · {formatCount(edgeCount)} relationships
          </Badge>
        </span>
      </div>
    </div>
  );
}
