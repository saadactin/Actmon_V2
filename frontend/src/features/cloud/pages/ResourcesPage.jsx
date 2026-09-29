import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/Table';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudToolbar from '../components/CloudToolbar';
import { DiagnosticModal } from '../components/DiagnosticModal';
import { DiscoveryStatus } from '../components/DiscoveryStatus';
import RefreshAllButton from '../components/refresh/RefreshAllButton';
import ResourceDetailDrawer from '../components/ResourceDetailDrawer';
import ResourceFacetRail from '../components/resources/ResourceFacetRail';
import ResourceGroupPanel from '../components/resources/ResourceGroupPanel';
import ResourceInventoryTable, {
  ColumnPicker, useColumnPreference,
} from '../components/resources/ResourceInventoryTable';
import ResourceSummaryStrip from '../components/resources/ResourceSummaryStrip';
import SavedViewMenu from '../components/resources/SavedViewMenu';
import { useAccountDiagnostics } from '../hooks/useCloudAccounts';
import { useCloudScope } from '../hooks/useCloudScope';
import {
  useResourceQuery, useResourceReference,
} from '../hooks/useResources';
import { exportResourcesCsv } from '../api/resources.api';
import {
  activeFilterCount, EMPTY_FILTERS, filtersFromSearchParams, filtersToSearchParams,
  formatCount, formatPct, relativeTime,
} from '../utils/resourceModel';

/**
 * The Resources workspace.
 *
 * What changed, and why it had to: this page used to fetch every resource in an
 * account as one array and then filter, search, sort and count it in the
 * browser. That cannot hold — the estate is already 1,526 rows and the work
 * grows with the account, not with what is on screen. Filtering, sorting,
 * paging, faceting and every count now happen in the database, and the browser
 * holds one page.
 *
 * The second change is subtler and matters more. Every number on this page —
 * the header cards, the facet counts, the row total — comes from ONE backend
 * query built from ONE filter. When each of those computed its own total they
 * disagreed with each other, and a page that contradicts itself cannot be used
 * to make a decision about money or security.
 *
 * Filters live in the URL so a view can be shared, bookmarked and linked to
 * from Security, Cost, Drift and Topology.
 */

const GROUP_OPTIONS = [
  { id: '', label: 'No grouping' },
  { id: 'normalized_type', label: 'Category' },
  { id: 'resource_type', label: 'Resource type' },
  { id: 'status', label: 'Status' },
  { id: 'risk', label: 'Risk' },
  { id: 'region', label: 'Region' },
  { id: 'provider', label: 'Provider' },
  { id: 'account', label: 'Account' },
  { id: 'environment', label: 'Environment' },
  { id: 'owner', label: 'Owner' },
  { id: 'resource_group', label: 'Resource group' },
  { id: 'compartment', label: 'Compartment' },
];

const ALL_SCOPE = 'ALL';

export const ResourcesPage = ({ embedded = false, accountId: accountIdProp }) => {
  const navigate = useNavigate();
  const scope = useCloudScope();
  const [searchParams, setSearchParams] = useSearchParams();

  const accounts = scope.scopedAccounts;
  const selectedAccountId = accountIdProp || scope.accountId;

  // "All accounts" is a real scope, not a convenience: a search for a service
  // name has to be able to reach an AWS account, an Azure subscription and an
  // OCI tenancy in one query. Only offered outside the embedded account tab,
  // where the account is fixed by the route.
  const [crossAccount, setCrossAccount] = useState(false);
  const activeScope = !embedded && crossAccount ? ALL_SCOPE : selectedAccountId;

  const filters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams]);

  // The search box is local so typing stays responsive, and is pushed into the
  // URL (and therefore the query) on a debounce. Writing every keystroke to the
  // URL would put one history entry per character into the back button.
  const [searchText, setSearchText] = useState(filters.q || '');
  useEffect(() => { setSearchText(filters.q || ''); }, [filters.q]);

  const [sort, setSort] = useState({ key: 'resource_name', dir: 'asc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [groupBy, setGroupBy] = useState('');
  const [columnKeys, setColumnKeys] = useColumnPreference();
  const [drawerResource, setDrawerResource] = useState(null);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [showRail, setShowRail] = useState(true);
  const [exporting, setExporting] = useState(false);

  const applyFilters = useCallback((next) => {
    setPage(1);
    setSearchParams(filtersToSearchParams(next), { replace: false });
  }, [setSearchParams]);

  /** Apply a saved view: its filters AND the presentation it was saved with.
   *  A view that restored the filters but not the sort would open showing the
   *  right rows in the wrong order, which is a different answer to the
   *  question it was saved to ask. */
  const applyView = useCallback((view) => {
    applyFilters({ ...EMPTY_FILTERS, ...(view.filters || {}) });
    if (view.sort) setSort({ key: view.sort, dir: view.dir || 'asc' });
    setGroupBy(view.groupBy || '');
    if (view.columns?.length) setColumnKeys(view.columns);
  }, [applyFilters, setColumnKeys]);

  useEffect(() => {
    const handle = setTimeout(() => {
      if ((filters.q || '') === searchText) return;
      // replace: a search is a refinement of the current view, not a new
      // destination, so it should not add a history entry per pause in typing.
      setSearchParams(filtersToSearchParams({ ...filters, q: searchText }), { replace: true });
      setPage(1);
    }, 300);
    return () => clearTimeout(handle);
  }, [searchText, filters, setSearchParams]);

  const queryOptions = useMemo(() => ({
    sort: sort.key,
    dir: sort.dir,
    page,
    pageSize,
    groupBy: groupBy || undefined,
  }), [sort, page, pageSize, groupBy]);

  const {
    data, isLoading, isFetching, isError, error,
  } = useResourceQuery(activeScope, filters, queryOptions);
  const { data: reference } = useResourceReference(activeScope);
  const { data: diagnostics, isLoading: diagnosticsLoading } = useAccountDiagnostics(
    selectedAccountId, showDiagnostic,
  );

  const summary = data?.summary;
  const dataQuality = data?.data_quality;
  const filterCount = activeFilterCount(filters);

  const onSort = (key) => {
    const column = key;
    setSort((current) => ({
      key: column,
      dir: current.key === column && current.dir === 'asc' ? 'desc' : 'asc',
    }));
    setPage(1);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      await exportResourcesCsv(activeScope, filters);
    } finally {
      setExporting(false);
    }
  };

  // ── Empty and error states, each saying the thing that is actually true ────
  const renderEmpty = () => {
    if (isError) {
      const envelope = error?.response?.data?.detail?.error;
      return (
        <EmptyState
          icon="alert"
          title={envelope?.category === 'permission_denied' ? 'Permission denied' : 'Could not load resources'}
          body={envelope?.message || error?.message || 'The resource service did not answer.'}
        />
      );
    }
    if (filterCount > 0) {
      return (
        <EmptyState
          icon="search"
          title="No resources match your filters"
          body={`${filterCount} filter${filterCount === 1 ? '' : 's'} applied.`}
          action={<Button variant="secondary" size="sm" onClick={() => applyFilters(EMPTY_FILTERS)}>Clear filters</Button>}
        />
      );
    }
    return (
      <EmptyState
        icon="boxes"
        title="No resources discovered"
        body="Nothing has been discovered for this account yet."
        action={(
          <Button variant="ghost" size="sm" icon="help" onClick={() => setShowDiagnostic(true)}>
            Why is this empty?
          </Button>
        )}
      />
    );
  };

  const header = !embedded && (
    <CloudPageHeader
      backTo="/cloud"
      title="Resources"
      description={
        accounts.length
          ? 'Multi-cloud infrastructure inventory'
          : 'Connect a cloud account to view resources'
      }
      icon="boxes"
      actions={accounts.length ? (
        <CloudToolbar
          selectorProps={{
            accounts,
            mode: 'single',
            selected: selectedAccountId,
            onSelect: (id) => id && scope.setAccountScope(id),
            onAddAccount: () => navigate('/cloud/accounts'),
          }}
        >
          {selectedAccountId ? <RefreshAllButton accountId={selectedAccountId} /> : undefined}
        </CloudToolbar>
      ) : undefined}
    />
  );

  if (!selectedAccountId && !crossAccount) {
    return (
      <>
        {header}
        <div className="card flex flex-col items-center justify-center py-12 text-center">
          <Icon name="cloud" size={40} className="mx-auto mb-3 text-subtle" />
          <h3 className="text-base font-semibold text-fg">No account selected</h3>
          <p className="mt-1 text-sm text-muted">Add a cloud account to start discovering resources</p>
        </div>
      </>
    );
  }

  return (
    <>
      {header}

      <div className="space-y-4">
        {/* No scan button in the tab: inside an account the header above every
            tab has the one Refresh all, and the standalone page carries it in
            its own header. */}
        {selectedAccountId && !crossAccount && <DiscoveryStatus accountId={selectedAccountId} />}

        {/* Stale inventory must never look like fresh inventory. */}
        {dataQuality?.partial && (
          <div className="flex flex-wrap items-center gap-2 rounded-control border border-warning bg-warning-soft px-3 py-2 text-[12px] text-warning-fg">
            <Icon name="clock" size={14} />
            <span className="min-w-0 flex-1">
              {dataQuality.accounts?.some((a) => a.freshness?.stale)
                ? 'Some accounts in this view have not been re-scanned recently — these rows describe what discovery last saw, not necessarily what is running now.'
                : `Cost is known for ${formatPct(dataQuality.coverage?.cost)} of these resources; the rest report no per-resource billing.`}
            </span>
          </div>
        )}

        <ResourceSummaryStrip
          summary={summary}
          dataQuality={dataQuality}
          filters={filters}
          onFilter={applyFilters}
          loading={isFetching}
          error={isError}
        />

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={showRail ? 'chevrons-left' : 'filter'}
            onClick={() => setShowRail((v) => !v)}
            aria-expanded={showRail}
          >
            Filters
            {filterCount > 0 && (
              <Badge tone="accent" size="xs" className="ml-1">{filterCount}</Badge>
            )}
          </Button>

          <div className="min-w-[220px] flex-1">
            <Input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search name, provider ID, IP, type, region, tag value…"
              icon="search"
              size="sm"
            />
          </div>

          {!embedded && accounts.length > 1 && (
            <label className="flex cursor-pointer select-none items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 py-1.5 text-[12px] font-semibold text-muted hover:bg-sunken">
              <input
                type="checkbox"
                checked={crossAccount}
                onChange={(e) => { setCrossAccount(e.target.checked); setPage(1); }}
                className="h-3.5 w-3.5 rounded border-border accent-[var(--accent)]"
              />
              All accounts
            </label>
          )}

          <Select
            value={groupBy}
            // Select hands over the chosen value, not the DOM event.
            onChange={(value) => { setGroupBy(value); setPage(1); }}
            options={GROUP_OPTIONS}
            width="auto"
            size="sm"
          />

          <SavedViewMenu
            scope={activeScope}
            filters={filters}
            columns={columnKeys}
            sort={sort.key}
            dir={sort.dir}
            groupBy={groupBy || null}
            onApply={applyView}
          />

          <ColumnPicker columnKeys={columnKeys} onChange={setColumnKeys} />

          <Button
            variant="secondary"
            size="sm"
            icon="download"
            loading={exporting}
            onClick={handleExport}
            title="Exports exactly the filtered set — every matching row, not just this page."
          >
            CSV
          </Button>

          {filterCount > 0 && (
            <Button variant="ghost" size="sm" onClick={() => applyFilters(EMPTY_FILTERS)}>
              Clear filters
            </Button>
          )}
        </div>

        <div className={showRail ? 'grid gap-4 lg:grid-cols-[248px_minmax(0,1fr)]' : ''}>
          {showRail && (
            <aside className="min-w-0">
              <ResourceFacetRail
                facets={data?.facets}
                filters={filters}
                onChange={applyFilters}
                reference={reference}
                summary={summary}
                isGlobal={activeScope === ALL_SCOPE}
                error={isError}
              />
            </aside>
          )}

          <div className="min-w-0 space-y-4">
            {groupBy && (
              <ResourceGroupPanel
                groups={data?.groups}
                groupBy={groupBy}
                filters={filters}
                onFilter={applyFilters}
              />
            )}

            <ResourceInventoryTable
              data={data}
              isLoading={isLoading}
              isFetching={isFetching}
              columnKeys={columnKeys}
              sort={sort}
              onSort={onSort}
              page={page}
              pageSize={pageSize}
              onPage={setPage}
              onPageSize={(size) => { setPageSize(size); setPage(1); }}
              onOpen={setDrawerResource}
              emptyState={renderEmpty()}
            />

            {/* Coverage is reported, not assumed. A figure nobody collected
                reads as "not applicable" rather than 0%. */}
            {dataQuality?.coverage && (
              <div className="card flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-[12px]">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Data quality
                </span>
                {[
                  ['Status', dataQuality.coverage.status],
                  ['Tags', dataQuality.coverage.tags],
                  ['Cost', dataQuality.coverage.cost],
                  ['Configuration', dataQuality.coverage.configuration],
                ].map(([label, value]) => (
                  <span key={label} className="text-muted">
                    {`${label}: `}
                    <span className="font-semibold text-fg">{formatPct(value)}</span>
                  </span>
                ))}
                {dataQuality.coverage.without_status > 0 && (
                  <span className="text-muted">
                    {`${formatCount(dataQuality.coverage.without_status)} resources have no provider-reported state`}
                  </span>
                )}
                {summary?.newest_seen_at && (
                  <span className="ml-auto text-subtle">
                    {`Last observed ${relativeTime(summary.newest_seen_at)}`}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <ResourceDetailDrawer
        resource={drawerResource}
        open={!!drawerResource}
        onClose={() => setDrawerResource(null)}
      />

      {showDiagnostic && (
        <DiagnosticModal
          title="Why are there no resources?"
          items={
            diagnosticsLoading
              ? [{ scope: 'Loading…', category: 'unknown', message: 'Fetching diagnostic information…' }]
              : diagnostics?.resources
                ? [{
                  scope: diagnostics.account_name || 'Resources',
                  provider: diagnostics.provider,
                  category: diagnostics.resources.status,
                  message: diagnostics.resources.message
                    || (diagnostics.resources.status === 'ok'
                      ? `Discovery completed successfully (${diagnostics.resources.resources_found ?? 0} resources found) — if the list still looks empty, try refreshing.`
                      : 'No further detail was recorded.'),
                }]
                : [{ scope: 'Resources', category: 'unknown', message: 'No diagnostic information could be retrieved for this account.' }]
          }
          onClose={() => setShowDiagnostic(false)}
        />
      )}
    </>
  );
};

export default ResourcesPage;
