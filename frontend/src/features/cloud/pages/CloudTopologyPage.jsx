import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import CloudPageHeader from '../components/CloudPageHeader';
import TopologyCanvas from '../components/TopologyCanvas';
import TopologyDiagnosticsDrawer from '../components/TopologyDiagnostics';
import TopologyList from '../components/TopologyList';
import TopologyResourcePanel from '../components/TopologyResourcePanel';
import TopologyToolbar from '../components/TopologyToolbar';
import {
  EdgeEvidenceDrawer, ImpactDrawer, PathFinderDrawer,
} from '../components/TopologyInspectors';
import { useCloudScope } from '../hooks/useCloudScope';
import {
  useDiagnostics, useEdgeDetail, useGlobalView, useImpact, useIsolated,
  usePath, useResourceTopology, useSnapshotDiff, useSnapshots, useTakeSnapshot,
  useDeleteSnapshot, useTopology, useTopologySearch, useUnresolved, useExportTopology,
} from '../hooks/useTopology';
import { clusterNodes } from '../utils/topologyLayout';
import {
  HOP_OPTIONS, formatAge, formatCount, formatMoment, providerMeta,
} from '../utils/topologyModel';
import { slugForProvider } from '../utils/providerScope';

/**
 * Multi-Cloud Topology — the infrastructure relationship explorer.
 *
 * Three levels of zoom, in the product sense rather than the graphical one:
 * the global strip is every cloud and account, the canvas is one scope, and
 * selecting a resource narrows to its own neighbourhood. Everything below the
 * toolbar is a view of one graph the server built; nothing here re-derives a
 * relationship, so the UI cannot assert something the resolver did not.
 *
 * ## Local mode is a scoped request, not a client-side hide
 *
 * Switching to Local asks the server for that resource's neighbourhood at N
 * hops. It would have been less code to fetch everything and hide the rest,
 * but that means downloading a whole cloud to look at one instance — which is
 * exactly what the per-resource endpoint exists to avoid.
 */

const EMPTY_FILTERS = {
  accountName: '',
  region: '',
  category: '',
  resourceType: '',
  status: '',
  health: '',
  resourceGroup: '',
  compartmentName: '',
  exposed: false,
  hasDrift: false,
  hasEvents: false,
  hasBroadAccess: false,
};

/** Dragged node positions, per scope, in this browser only.
    Presentation state — never sent to the server, never part of the graph. */
const positionsKey = (scope) => `actmon.topology.positions.${scope}`;

function loadPositions(scope) {
  try {
    const raw = localStorage.getItem(positionsKey(scope));
    return raw ? JSON.parse(raw) : {};
  } catch {
    // A private window, cleared site data, or storage disabled. A missing
    // layout override is not an error — the computed layout is the fallback.
    return {};
  }
}

function savePositions(scope, positions) {
  try {
    if (Object.keys(positions).length) {
      localStorage.setItem(positionsKey(scope), JSON.stringify(positions));
    } else {
      localStorage.removeItem(positionsKey(scope));
    }
  } catch {
    /* Nothing to do — the override simply will not persist. */
  }
}

/* ── Level 1: the global strip ───────────────────────────────────────────── */
function GlobalStrip({ data, scope, onPickScope, collapsed, onToggle }) {
  if (!data?.providers?.length) return null;
  return (
    <section className="rounded-card border border-border bg-surface">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-card py-2.5 text-left"
      >
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={14} className="text-subtle" />
        <span className="text-[12px] font-semibold text-fg">All clouds</span>
        <span className="text-[11.5px] text-muted">
          {formatCount(data.total_resources)} resources across {data.total_accounts} account
          {data.total_accounts === 1 ? '' : 's'}
        </span>
      </button>
      {!collapsed && (
        <div className="flex flex-wrap gap-3 border-t border-border p-card pt-3">
          {data.providers.map((provider) => {
            const meta = providerMeta(provider.provider);
            return (
              <div key={provider.provider} className="min-w-[210px] flex-1">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className={`rounded border px-1.5 py-px text-[10px] font-bold ${meta.badge}`}>
                    {meta.label}
                  </span>
                  <span className="text-[11.5px] text-muted">
                    {formatCount(provider.resources)} resources
                  </span>
                  <button
                    type="button"
                    onClick={() => onPickScope(provider.provider)}
                    className={`ml-auto text-[11px] font-semibold ${
                      scope === provider.provider ? 'text-accent-fg' : 'text-muted hover:text-fg'
                    }`}
                  >
                    {scope === provider.provider ? 'Viewing' : 'View'}
                  </button>
                </div>
                <ul className="flex flex-col gap-0.5">
                  {provider.accounts.map((account) => (
                    <li key={account.account_id}>
                      <button
                        type="button"
                        onClick={() => onPickScope(account.account_id)}
                        className={`flex w-full items-center gap-1.5 rounded-control px-1.5 py-1 text-left text-[11.5px] hover:bg-sunken ${
                          scope === account.account_id ? 'bg-accent-soft' : ''
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate text-fg">{account.account_name}</span>
                        <span className="shrink-0 tabular-nums text-subtle">
                          {formatCount(account.resources)}
                        </span>
                        {account.last_job_status === 'FAILED' && (
                          <Icon
                            name="alert"
                            size={11}
                            className="shrink-0 text-danger-fg"
                            title="The last discovery scan failed for this account."
                          />
                        )}
                        {!account.last_discovery && (
                          <Icon
                            name="info"
                            size={11}
                            className="shrink-0 text-subtle"
                            title="This account has never been scanned."
                          />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ── The page ────────────────────────────────────────────────────────────── */
export const CloudTopologyPage = ({ embedded = false, accountId: propAccountId }) => {
  const navigate = useNavigate();
  const scopeState = useCloudScope();

  // Embedded inside one account's dashboard, the scope is that account and is
  // not the user's to change here — the account switcher lives in the shell.
  const [providerScope, setProviderScope] = useState(
    propAccountId || (scopeState.providerKey ?? 'ALL'),
  );
  const [accountScope, setAccountScope] = useState(propAccountId || 'ALL');

  useEffect(() => {
    if (propAccountId) {
      setProviderScope(propAccountId);
      setAccountScope(propAccountId);
    }
  }, [propAccountId]);

  const scope = useMemo(() => {
    if (propAccountId) return propAccountId;
    if (accountScope && accountScope !== 'ALL') return accountScope;
    return providerScope || 'ALL';
  }, [propAccountId, accountScope, providerScope]);

  /* ── view state ──────────────────────────────────────────────────────── */
  const [view, setView] = useState('infrastructure');
  const [layout, setLayout] = useState('architecture');
  const [displayMode, setDisplayMode] = useState('graph');
  const [scopeMode, setScopeMode] = useState('global'); // global | local
  const [hops, setHops] = useState('2');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [contextHops, setContextHops] = useState(1);
  const [hideDefaults, setHideDefaults] = useState(false);
  const [hideIsolated, setHideIsolated] = useState(false);
  const [hideEmptyContainers, setHideEmptyContainers] = useState(false);
  const [clusterLarge, setClusterLarge] = useState(false);
  const [expandedClusters, setExpandedClusters] = useState([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [globalCollapsed, setGlobalCollapsed] = useState(true);

  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [impactFor, setImpactFor] = useState(null);
  const [pathSource, setPathSource] = useState(null);
  const [pathTarget, setPathTarget] = useState(null);
  const [pathDepth, setPathDepth] = useState(6);
  const [pathOpen, setPathOpen] = useState(false);
  const [highlightPath, setHighlightPath] = useState(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [rawRequested, setRawRequested] = useState(false);
  const [snapshotForDiff, setSnapshotForDiff] = useState(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [exportNote, setExportNote] = useState(null);
  const [crowdingDismissed, setCrowdingDismissed] = useState(false);

  const [positions, setPositions] = useState(() => loadPositions(scope));
  useEffect(() => setPositions(loadPositions(scope)), [scope]);

  // Reset per-scope investigation state when the scope changes: carrying a
  // selection or a path across accounts would point at resources that are not
  // in the new graph.
  useEffect(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setHighlightPath(null);
    setPathSource(null);
    setPathTarget(null);
    setScopeMode('global');
    setExpandedClusters([]);
    setCrowdingDismissed(false);
  }, [scope]);

  useEffect(() => setRawRequested(false), [selectedNodeId]);

  // ── Hand-off from the Security Center (§66) ────────────────────────────────
  // A finding links here as `?focus=<resource-id>` so "view this in the
  // topology" lands on the resource with its relationships showing, rather than
  // on a 500-node graph the user then has to search. Consumed once and the
  // parameter is removed, so clearing the selection does not immediately
  // re-apply it — the same contract the Event Log and Config Drift hand-offs
  // already use.
  const [searchParams, setSearchParams] = useSearchParams();
  const focusConsumed = useRef(false);
  useEffect(() => {
    if (focusConsumed.current) return;
    const focus = searchParams.get('focus');
    if (!focus) return;
    focusConsumed.current = true;
    setSelectedNodeId(focus);
    // Local scope, because the caller is asking about one resource's
    // neighbourhood; the global graph is a different question.
    setScopeMode('local');
    const next = new URLSearchParams(searchParams);
    next.delete('focus');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Debounce the search so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  /* ── queries ─────────────────────────────────────────────────────────── */
  const graphOptions = useMemo(() => ({
    view,
    search: debouncedSearch || undefined,
    filters,
    hideDefaults,
    hideIsolated,
    hideEmptyContainers,
    contextHops,
  }), [view, debouncedSearch, filters, hideDefaults, hideIsolated, hideEmptyContainers, contextHops]);

  const {
    data: topology, isLoading, isFetching, error, refetch,
  } = useTopology(scope, graphOptions);

  const { data: globalView } = useGlobalView(!embedded);
  const { data: searchResults } = useTopologySearch(scope, debouncedSearch);
  const { data: resourceDetail, isLoading: detailLoading } = useResourceTopology(
    scope, selectedNodeId, { hops: 2, includeRaw: rawRequested },
  );
  const { data: edgeDetail, isLoading: edgeLoading } = useEdgeDetail(scope, selectedEdgeId);
  const { data: impact, isLoading: impactLoading } = useImpact(scope, impactFor);
  const { data: pathResult, isLoading: pathLoading } = usePath(
    scope, pathSource, pathTarget, { maxDepth: pathDepth, view },
  );
  const { data: diagnostics, isLoading: diagnosticsLoading } = useDiagnostics(scope, diagnosticsOpen);
  const { data: unresolved, isLoading: unresolvedLoading } = useUnresolved(scope, diagnosticsOpen);
  const { data: isolated, isLoading: isolatedLoading } = useIsolated(scope, diagnosticsOpen);
  const { data: snapshots, isLoading: snapshotsLoading } = useSnapshots(scope, diagnosticsOpen);
  const { data: diff, isLoading: diffLoading } = useSnapshotDiff(
    snapshotForDiff, undefined, !!snapshotForDiff,
  );

  const takeSnapshot = useTakeSnapshot(scope);
  const deleteSnapshot = useDeleteSnapshot();
  const exportTopology = useExportTopology(scope);

  /* ── local mode: the selected resource's neighbourhood ──────────────── */
  const localNodes = resourceDetail?.found ? resourceDetail.neighbors : null;
  const localEdges = resourceDetail?.found ? resourceDetail.edges : null;

  const baseNodes = useMemo(() => {
    if (scopeMode === 'local' && localNodes) {
      if (hops === '99') return topology?.nodes || [];
      const limit = Number(hops);
      const depth = resourceDetail.depth || {};
      return localNodes.filter((node) => (depth[node.id] ?? 0) <= limit);
    }
    return topology?.nodes || [];
  }, [scopeMode, localNodes, hops, resourceDetail, topology]);

  const baseEdges = useMemo(() => {
    if (scopeMode === 'local' && localEdges && hops !== '99') {
      const ids = new Set(baseNodes.map((n) => n.id));
      return localEdges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    }
    return topology?.edges || [];
  }, [scopeMode, localEdges, hops, baseNodes, topology]);

  /* ── clustering ───────────────────────────────────── */
  const expandedSet = useMemo(() => new Set(expandedClusters), [expandedClusters]);

  const { nodes, edges } = useMemo(() => {
    if (!clusterLarge) return { nodes: baseNodes, edges: baseEdges };
    return clusterNodes(baseNodes, baseEdges, { minSize: 8, expanded: expandedSet });
  }, [clusterLarge, baseNodes, baseEdges, expandedSet]);

  const edgeCounts = useMemo(() => {
    const counts = {};
    edges.forEach((edge) => { counts[edge.type] = (counts[edge.type] || 0) + 1; });
    return counts;
  }, [edges]);

  /* ── handlers ────────────────────────────────────────────────────────── */
  const changeFilter = useCallback((key, value) => {
    setFilters((current) => ({ ...current, [key]: value }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    setSearch('');
    setHideDefaults(false);
    setHideIsolated(false);
    setHideEmptyContainers(false);
  }, []);

  const activeFilterCount = useMemo(
    () => Object.entries(filters).filter(([, value]) => value !== '' && value !== false).length,
    [filters],
  );

  const moveNode = useCallback((nodeId, position) => {
    setPositions((current) => {
      const next = { ...current, [nodeId]: position };
      savePositions(scope, next);
      return next;
    });
  }, [scope]);

  const resetPositions = useCallback(() => {
    setPositions({});
    savePositions(scope, {});
    setFitSignal((n) => n + 1);
  }, [scope]);

  const selectNode = useCallback((nodeId) => {
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
    if (!nodeId && scopeMode === 'local') setScopeMode('global');
  }, [scopeMode]);

  const goToTab = useCallback((tab, query) => {
    // The Event Log and Config Drift are sibling tabs of the same account
    // dashboard, so the handoff is a route change with the resource as a query
    // parameter. Both pages read it and pre-filter to that resource.
    const account = propAccountId || (accountScope !== 'ALL' ? accountScope : null);
    if (!account) return;
    const record = (scopeState.allAccounts || []).find((a) => a.id === account);
    const slug = slugForProvider(record?.provider) || 'aws';
    const search = query ? `?${new URLSearchParams(query).toString()}` : '';
    navigate(`/cloud/${slug}-accounts/${account}/${tab}${search}`);
  }, [propAccountId, accountScope, scopeState.allAccounts, navigate]);

  const onExport = useCallback(async () => {
    try {
      const result = await exportTopology.mutateAsync({ format: 'json', ...graphOptions });
      setExportNote({ tone: 'success', text: `Downloaded ${result.filename}` });
    } catch (exportError) {
      setExportNote({
        tone: 'danger',
        text: exportError?.response?.status === 403
          ? 'Your role does not include permission to export the topology.'
          : 'The export failed. The topology itself is unaffected.',
      });
    }
    setTimeout(() => setExportNote(null), 6000);
  }, [exportTopology, graphOptions]);

  /* ── derived warnings ────────────────────────────────────────────────── */
  const inventory = topology?.inventory;
  // From the graph payload, which reports scan health for its own scope. The
  // global view is only fetched on the standalone page, so deriving this from
  // it meant the warning never appeared where the feature is actually used.
  const failedAccounts = inventory?.accounts_with_failed_scan || [];

  const accountOptions = useMemo(() => {
    const relevant = providerScope === 'ALL'
      ? scopeState.allAccounts
      : (scopeState.allAccounts || []).filter(
        (account) => providerMeta(account.provider).label === providerScope,
      );
    return [
      { id: 'ALL', label: providerScope === 'ALL' ? 'All accounts' : `All ${providerScope} accounts` },
      ...(relevant || []).map((account) => ({ id: account.id, label: account.account_name })),
    ];
  }, [providerScope, scopeState.allAccounts]);

  const scopeLabel = useMemo(() => {
    if (propAccountId) {
      const record = (scopeState.allAccounts || []).find((a) => a.id === propAccountId);
      return record?.account_name || 'this account';
    }
    if (accountScope !== 'ALL') {
      const record = (scopeState.allAccounts || []).find((a) => a.id === accountScope);
      return record?.account_name || 'the selected account';
    }
    return providerScope === 'ALL' ? 'all clouds' : providerScope;
  }, [propAccountId, accountScope, providerScope, scopeState.allAccounts]);

  /* ── empty / error states ────────────────────────────────────────────── */
  const emptyState = (
    <div className="absolute inset-0 z-[8] flex flex-col items-center justify-center px-8 text-center">
      <span className="mb-3 rounded-full bg-sunken p-3 text-subtle">
        <Icon name="network" size={24} />
      </span>
      {topology?.graph_nodes > 0 ? (
        <>
          <h3 className="text-base font-semibold text-fg">Nothing matches the current view</h3>
          <p className="mt-1 max-w-md text-sm text-muted">
            {formatCount(topology.graph_nodes)} resources are in this scope, but none match the
            filters, search term or view mode you have applied.
          </p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={clearFilters}>
            Clear filters and search
          </Button>
        </>
      ) : failedAccounts.length > 0 ? (
        <>
          <h3 className="text-base font-semibold text-fg">No resources could be read</h3>
          <p className="mt-1 max-w-md text-sm text-muted">
            The last discovery scan failed for {failedAccounts.length} account
            {failedAccounts.length === 1 ? '' : 's'} in this scope, so this is not an empty
            account — it is one we could not read. Open Diagnostics for the provider&apos;s own error.
          </p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setDiagnosticsOpen(true)}>
            Open diagnostics
          </Button>
        </>
      ) : (
        <>
          <h3 className="text-base font-semibold text-fg">No topology data</h3>
          <p className="mt-1 max-w-md text-sm text-muted">
            No resources have been discovered for {scopeLabel}. Run a discovery scan to build
            the relationship graph.
          </p>
        </>
      )}
    </div>
  );

  return (
    <div
      className={`flex flex-col bg-bg ${
        fullscreen ? 'fixed inset-0 z-50 overflow-auto p-4' : ''
      }`}
    >
      {!embedded && !fullscreen && (
        <CloudPageHeader
          className="shrink-0"
          backTo="/cloud"
          icon="network"
          title="Multi-Cloud Topology"
          
        />
      )}

      <div className="flex shrink-0 flex-col gap-2.5 pb-3">
        {!embedded && !fullscreen && globalView && (
          <GlobalStrip
            data={globalView}
            scope={scope}
            collapsed={globalCollapsed}
            onToggle={() => setGlobalCollapsed((v) => !v)}
            onPickScope={(next) => {
              if (['AWS', 'Azure', 'OCI'].includes(next)) {
                setProviderScope(next);
                setAccountScope('ALL');
              } else {
                setAccountScope(next);
              }
              setFitSignal((n) => n + 1);
            }}
          />
        )}

        {/* Stale inventory. Distinct from "the topology is old" — the graph is
            rebuilt on demand; it is the SCAN behind it that may be hours old,
            and conflating the two would claim real-time data. */}
        {inventory?.stale && (
          <Notice tone="warning" title="This topology may not reflect your cloud right now">
            It is derived from the last discovery scan, and the oldest account in this scope was
            scanned {formatAge(inventory.oldest_age_seconds)}. Anything created or changed since
            then is not shown. Run a discovery scan to refresh the inventory.
          </Notice>
        )}

        {failedAccounts.length > 0 && (
          <Notice
            tone="danger"
            title={
              failedAccounts.some((a) => a.permission_problem)
                ? 'Some resources may be missing because they could not be read'
                : 'The last discovery scan failed'
            }
          >
            {failedAccounts.map((account) => (
              <span key={account.account_id} className="block">
                <strong>{account.account_name}</strong>
                {account.permission_problem
                  ? ' — the configured cloud identity was refused by the provider, so resources and relationships it cannot read are absent from this graph. That is a coverage gap, not an empty account.'
                  : ' — its last discovery scan failed, so anything below may be incomplete or out of date.'}
              </span>
            ))}
            <span className="mt-2 block">
              <Button variant="secondary" size="sm" onClick={() => setDiagnosticsOpen(true)}>
                See the provider&apos;s error
              </Button>
            </span>
          </Notice>
        )}

        {inventory?.accounts_never_scanned?.length > 0 && (
          <Notice tone="info" title="Some accounts have never been scanned">
            {inventory.accounts_never_scanned.join(', ')} — these contribute nothing to the
            topology because no inventory has been collected for them yet.
          </Notice>
        )}

        {error && (
          <Notice tone="danger" title="The topology could not be loaded">
            {error?.response?.status === 403
              ? 'Your role does not include permission to view the topology.'
              : 'The cloud service did not return a topology. This is a request failure, not an empty account — retry, and check the service is running.'}
            <Button variant="secondary" size="sm" className="mt-2" onClick={() => refetch()}>
              Retry
            </Button>
          </Notice>
        )}

        {topology?.error && (
          <Notice tone="danger" title="Invalid scope">{topology.error}</Notice>
        )}

        {topology?.truncated && (
          <Notice tone="info" title="Showing the most connected resources">
            This scope has {formatCount(topology.matching_nodes)} matching resources, more than
            can be drawn at once. The {formatCount(topology.total_nodes)} with the most
            relationships are shown — narrow the scope or a filter to see the rest.
          </Notice>
        )}

        {/* Past a few hundred cards no zoom shows them all legibly - the
            geometry simply does not allow it. Rather than let the user
            discover that by squinting at a 25% canvas, say so and offer the
            control that fixes it. Not applied automatically: silently
            restructuring someone's graph is worse than telling them they can. */}
        {nodes.length > 250 && !clusterLarge && !crowdingDismissed && displayMode === 'graph' && (
          <Notice tone="info" title={`${formatCount(nodes.length)} resources is more than fits legibly on one screen`}>
            Fitting them all lands at roughly a quarter zoom, where the labels stop being
            readable. Grouping resources of the same type in the same container into one node
            keeps the shape of the graph while making it legible — click a group to expand it.
            You can also filter, or switch to the list view.
            <span className="mt-2 flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setClusterLarge(true)}>
                Group large sets
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCrowdingDismissed(true)}>
                Keep every resource separate
              </Button>
            </span>
          </Notice>
        )}

        {exportNote && (
          <Notice tone={exportNote.tone} title={exportNote.tone === 'success' ? 'Export ready' : 'Export failed'}>
            {exportNote.text}
          </Notice>
        )}

        <TopologyToolbar
          providerScope={embedded ? 'ALL' : providerScope}
          onChangeProviderScope={(next) => {
            setProviderScope(next);
            setAccountScope('ALL');
            setFitSignal((n) => n + 1);
          }}
          providerCounts={topology?.facets?.provider}
          accountOptions={embedded ? [] : accountOptions}
          accountScope={accountScope}
          onChangeAccountScope={(next) => { setAccountScope(next); setFitSignal((n) => n + 1); }}
          search={search}
          onChangeSearch={setSearch}
          searchResults={searchResults}
          onPickSearchResult={(id) => { selectNode(id); setSearch(''); }}
          view={view}
          onChangeView={setView}
          layout={layout}
          onChangeLayout={(next) => { setLayout(next); setFitSignal((n) => n + 1); }}
          filters={filters}
          onChangeFilter={changeFilter}
          onClearFilters={clearFilters}
          activeFilterCount={activeFilterCount}
          facets={topology?.facets}
          hideDefaults={hideDefaults}
          onToggleHideDefaults={setHideDefaults}
          hideIsolated={hideIsolated}
          onToggleHideIsolated={setHideIsolated}
          hideEmptyContainers={hideEmptyContainers}
          onToggleHideEmptyContainers={setHideEmptyContainers}
          clusterLarge={clusterLarge}
          onToggleClusterLarge={(value) => { setClusterLarge(value); setExpandedClusters([]); }}
          contextHops={contextHops}
          onChangeContextHops={setContextHops}
          defaultCount={topology?.default_nodes}
          edgeCounts={edgeCounts}
          nodeCount={nodes.length}
          edgeCount={edges.length}
          matchedCount={topology?.matched_nodes}
          onOpenDiagnostics={() => setDiagnosticsOpen(true)}
          onOpenPathFinder={() => setPathOpen(true)}
          onExport={onExport}
          onRefresh={() => { refetch(); setFitSignal((n) => n + 1); }}
          refreshing={isFetching}
          displayMode={displayMode}
          onChangeDisplayMode={setDisplayMode}
          fullscreen={fullscreen}
          onToggleFullscreen={() => { setFullscreen((v) => !v); setFitSignal((n) => n + 1); }}
        />

        {/* Global / local, and the hop depth that only means something in local */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            {[['global', 'Global'], ['local', 'Local']].map(([id, label]) => (
              <button
                key={id}
                type="button"
                disabled={id === 'local' && !selectedNodeId}
                onClick={() => setScopeMode(id)}
                aria-pressed={scopeMode === id}
                title={id === 'local' && !selectedNodeId
                  ? 'Select a resource first — Local shows one resource’s neighbourhood.'
                  : undefined}
                className={`h-control rounded-control border px-2.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  scopeMode === id
                    ? 'border-accent bg-accent-soft text-fg'
                    : 'border-border bg-surface text-muted hover:bg-sunken'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {scopeMode === 'local' && (
            <>
              <Select
                value={hops}
                onChange={(value) => { setHops(value); setFitSignal((n) => n + 1); }}
                options={HOP_OPTIONS}
                size="sm"
                width="auto"
              />
              <span className="text-[11.5px] text-muted">
                Showing {formatCount(nodes.length)} resources around{' '}
                <strong className="text-fg">{resourceDetail?.resource?.name || '—'}</strong>
                {resourceDetail?.truncated && ' (bounded — there are more)'}
              </span>
            </>
          )}
          {highlightPath && (
            <span className="ml-auto inline-flex items-center gap-2">
              <Badge tone="info" size="sm">
                {`Path highlighted · ${highlightPath.length} hop${highlightPath.length === 1 ? '' : 's'}`}
              </Badge>
              <Button variant="ghost" size="sm" onClick={() => setHighlightPath(null)}>
                Clear
              </Button>
            </span>
          )}
          {topology?.topology_generated_at && (
            <span className="ml-auto text-[11px] text-subtle">
              Built {formatMoment(topology.topology_generated_at)}
              {topology.build_ms !== undefined ? ` · ${topology.build_ms} ms` : ''}
            </span>
          )}
        </div>
      </div>

      {/* ── Graph or list, plus the resource panel ───────────────────────── */}
      <div
        className={`flex min-h-0 gap-3 pb-6 ${
          fullscreen ? 'h-[calc(100vh-13rem)]' : 'h-[calc(100vh-25rem)] min-h-[460px]'
        }`}
      >
        {displayMode === 'graph' ? (
          <div className="min-h-0 min-w-0 flex-1">
            <TopologyCanvas
              nodes={nodes}
              edges={edges}
              layout={layout}
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              onSelectNode={selectNode}
              onSelectEdge={setSelectedEdgeId}
              onOpenNode={(id) => navigate(`/cloud/resources/${id}`)}
              onExpandCluster={(cluster) => setExpandedClusters((current) => [...current, cluster.id])}
              highlightPath={highlightPath}
              loading={isLoading}
              emptyState={emptyState}
              positionOverrides={positions}
              onMoveNode={moveNode}
              onResetPositions={resetPositions}
              fitSignal={fitSignal}
            />
          </div>
        ) : (
          <TopologyList
            nodes={nodes}
            edges={edges}
            selectedNodeId={selectedNodeId}
            onSelectNode={selectNode}
            onExplainEdge={setSelectedEdgeId}
          />
        )}

        {selectedNodeId && (
          <TopologyResourcePanel
            detail={resourceDetail}
            loading={detailLoading}
            scope={scope}
            onClose={() => selectNode(null)}
            onSelectNode={selectNode}
            onExplainEdge={setSelectedEdgeId}
            onShowImpact={setImpactFor}
            onFindPathFrom={(id) => { setPathSource(id); setPathOpen(true); }}
            onOpenFullDetail={(id) => navigate(`/cloud/resources/${id}`)}
            onRequestRaw={() => setRawRequested(true)}
            rawRequested={rawRequested}
            onViewEvents={(node) => goToTab('events', {
              resource: node.provider_id || '',
              resourceName: node.name || '',
              range: '30d',
            })}
            onViewDrift={(node) => goToTab('drift', {
              resource: node.provider_id || '',
              resourceName: node.name || '',
            })}
          />
        )}
      </div>

      {/* ── Drawers ──────────────────────────────────────────────────────── */}
      <EdgeEvidenceDrawer
        open={!!selectedEdgeId}
        onClose={() => setSelectedEdgeId(null)}
        data={edgeDetail}
        loading={edgeLoading}
        onSelectNode={selectNode}
      />

      <ImpactDrawer
        open={!!impactFor}
        onClose={() => setImpactFor(null)}
        data={impact}
        loading={impactLoading}
        onSelectNode={selectNode}
      />

      <PathFinderDrawer
        open={pathOpen}
        onClose={() => setPathOpen(false)}
        nodes={topology?.nodes || []}
        source={pathSource}
        target={pathTarget}
        onChangeSource={setPathSource}
        onChangeTarget={setPathTarget}
        data={pathResult}
        loading={pathLoading}
        maxDepth={pathDepth}
        onChangeMaxDepth={setPathDepth}
        onHighlight={(result) => {
          setHighlightPath(result);
          setPathOpen(false);
          setScopeMode('global');
          setFitSignal((n) => n + 1);
        }}
        onSelectNode={selectNode}
      />

      <TopologyDiagnosticsDrawer
        open={diagnosticsOpen}
        onClose={() => { setDiagnosticsOpen(false); setSnapshotForDiff(null); }}
        scope={scope}
        diagnostics={diagnostics}
        diagnosticsLoading={diagnosticsLoading}
        unresolved={unresolved}
        unresolvedLoading={unresolvedLoading}
        isolated={isolated}
        isolatedLoading={isolatedLoading}
        snapshots={snapshots}
        snapshotsLoading={snapshotsLoading}
        diff={diff}
        diffLoading={diffLoading}
        selectedSnapshotId={snapshotForDiff}
        takingSnapshot={takeSnapshot.isPending}
        onSelectNode={selectNode}
        onTakeSnapshot={() => takeSnapshot.mutate({
          label: `${scopeLabel} · ${formatMoment(new Date().toISOString())}`,
        })}
        onDeleteSnapshot={(id) => {
          deleteSnapshot.mutate(id);
          if (snapshotForDiff === id) setSnapshotForDiff(null);
        }}
        onDiffSnapshot={(id) => setSnapshotForDiff((current) => (current === id ? null : id))}
      />
    </div>
  );
};

export default CloudTopologyPage;
