import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DiagnosticModal } from '../components/DiagnosticModal';
import AttentionCenter, { buildAttentionItems } from '../components/overview/AttentionCenter';
import CostTrendPanel from '../components/overview/CostTrendPanel';
import {
  DataQualityPanel, RecentChanges, RecentEvents, RecentlyDiscovered, TopCostResources,
  TopRisks, TopologySnapshot,
} from '../components/overview/OverviewActivity';
import { AccountIdentity, DiscoveryPanel, OverviewKpis } from '../components/overview/OverviewHeader';
import {
  RegionDistribution, ResourceLandscape, StatusDistribution,
} from '../components/overview/ResourceLandscape';
import SecurityPosturePanel from '../components/overview/SecurityPosturePanel';
import { useAccountDiagnostics } from '../hooks/useCloudAccounts';
import {
  useChangeSummary, useCostSeries, useCostTotal, useLatestDiscovery,
  useOverviewInventory, useRecentChanges, useRecentEvents, useRecentResources,
  useSecurityPosture, useTopCostResources, useTopologySummary,
} from '../hooks/useCloudOverview';
import { useTriggerDiscovery } from '../hooks/useDiscovery';
import { slugForProvider } from '../utils/providerScope';

/**
 * The account command centre.
 *
 * Three things distinguish this from the page it replaces.
 *
 * It does not download the estate. Every count comes from the resource query
 * layer's database-side aggregation for THIS account. The previous version
 * fetched all 1,530 resources across every account — 1.7 MB — and counted them
 * in the browser to display one account's 476.
 *
 * It does not score security. The Security Center owns posture; this renders
 * what that model returns. The two previously used different engines and
 * disagreed in front of the user (0 vs 35 on oci_test, 0 vs 52 on test_aw).
 *
 * It does not fail as a unit. Each panel has its own query, so a throttled
 * billing API costs you the cost panel and nothing else.
 */
export default function CloudOverview({ account, accountId, providerSlug }) {
  const navigate = useNavigate();
  const [costDays, setCostDays] = useState(30);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  // Region narrows the panels whose data is region-aware. It deliberately does
  // NOT narrow cost, posture or scan state: this estate's billing is reported
  // per account, the assessment is scored per account, and a scan is an account
  // operation. Pretending otherwise would put a region label on an
  // account-wide number, which is worse than not offering the filter.
  const [region, setRegion] = useState(null);

  const inventory = useOverviewInventory(accountId, region);
  const posture = useSecurityPosture(accountId);
  const costTotal = useCostTotal(accountId);
  const costSeries = useCostSeries(accountId, costDays);
  const recent = useRecentResources(accountId, 6);
  const topCost = useTopCostResources(accountId, 5);
  const changes = useChangeSummary(accountId, 30);
  const recentChanges = useRecentChanges(accountId, 5);
  const events = useRecentEvents(accountId, '7d');
  const topology = useTopologySummary(accountId);
  const discovery = useLatestDiscovery(accountId);
  const triggerDiscovery = useTriggerDiscovery();
  const { data: diagnostics, isLoading: diagnosticsLoading } = useAccountDiagnostics(
    accountId, showDiagnostic,
  );

  const summary = inventory.data?.summary;
  const facets = inventory.data?.facets;
  const dataQuality = inventory.data?.data_quality;
  const accountFreshness = dataQuality?.accounts?.[0]?.freshness;

  const base = `/cloud/${providerSlug || slugForProvider(account?.provider)}-accounts/${accountId}`;

  /** Navigate to a sibling tab, optionally carrying filters. The Resources tab
   *  reads its filters from the URL, so the count someone clicked and the set
   *  they land on are the same query — including the region narrowing, which
   *  would otherwise be silently dropped on the way and land the user on a
   *  bigger set than the number they clicked. */
  const go = useCallback((tab, filters) => {
    const params = { ...(filters || {}) };
    if (region && tab === 'resources') params.region = region;
    const search = Object.keys(params).length
      ? `?${new URLSearchParams(params).toString()}`
      : '';
    navigate(`${base}/${tab}${search}`);
  }, [base, navigate, region]);

  const attention = useMemo(() => buildAttentionItems({
    summary,
    posture: posture.data,
    freshness: accountFreshness,
    changeSummary: changes.data,
    discovery: discovery.data,
    costError: costTotal.isError,
    postureError: posture.isError,
  }), [
    summary, posture.data, posture.isError, accountFreshness, changes.data,
    discovery.data, costTotal.isError,
  ]);

  const onAttention = useCallback((item) => {
    if (item.action === 'discovery') {
      if (item.id === 'discovery-failed') setShowDiagnostic(true);
      else triggerDiscovery.mutate(accountId);
      return;
    }
    go(item.action, item.filters);
  }, [accountId, go, triggerDiscovery]);

  // "Nothing needs attention" is only a true statement when the systems that
  // would have raised something actually ran.
  const evaluated = !posture.isLoading && !posture.isError
    && !inventory.isLoading && !inventory.isError;

  return (
    <div className="space-y-4">
      <AccountIdentity
        account={account}
        freshness={accountFreshness}
        discovery={discovery.data}
        discovering={triggerDiscovery.isPending}
        onRunDiscovery={() => triggerDiscovery.mutate(accountId)}
      />

      {/* Region scope. Only offered once more than one region actually holds
          resources — a filter with a single option is furniture. */}
      {(facets?.regions || []).length > 1 && (
        <div className="card flex flex-wrap items-center gap-2 px-4 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Region
          </span>
          <button
            type="button"
            onClick={() => setRegion(null)}
            aria-pressed={region === null}
            className={`rounded-control px-2.5 py-1 text-[12px] font-semibold ${
              region === null
                ? 'bg-accent text-accent-fg'
                : 'border border-border text-muted hover:bg-sunken hover:text-fg'
            }`}
          >
            All regions
          </button>
          {facets.regions.slice(0, 8).map((facet) => (
            <button
              key={facet.value}
              type="button"
              onClick={() => setRegion(region === facet.value ? null : facet.value)}
              aria-pressed={region === facet.value}
              className={`rounded-control px-2.5 py-1 text-[12px] font-semibold ${
                region === facet.value
                  ? 'bg-accent text-accent-fg'
                  : 'border border-border text-muted hover:bg-sunken hover:text-fg'
              }`}
            >
              {facet.label}
              <span className="ml-1.5 text-[10px] opacity-70">{facet.count}</span>
            </button>
          ))}
          {region && (
            <span className="ml-auto text-[11px] text-muted">
              Inventory panels are scoped to
              <span className="font-semibold text-fg">{` ${region}`}</span>
              {'. Cost, security and discovery remain account-wide.'}
            </span>
          )}
        </div>
      )}

      <OverviewKpis
        summary={summary}
        cost={costTotal.data}
        posture={posture.data}
        isLoading={inventory.isLoading}
        costLoading={costTotal.isLoading}
        postureLoading={posture.isLoading}
        costError={costTotal.isError}
        postureError={posture.isError}
        onNavigate={go}
      />

      <AttentionCenter
        items={attention}
        isLoading={inventory.isLoading && posture.isLoading}
        evaluated={evaluated}
        onAction={onAttention}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <CostTrendPanel
          data={costSeries.data}
          total={costTotal.data}
          isLoading={costSeries.isLoading}
          error={costSeries.isError ? costSeries.error : null}
          days={costDays}
          onDaysChange={setCostDays}
          onOpenCost={() => go('cost')}
        />

        <SecurityPosturePanel
          posture={posture.data}
          isLoading={posture.isLoading}
          error={posture.isError ? posture.error : null}
          affectedResources={summary?.risk_resource_count}
          onOpenSecurity={() => go('security')}
          onOpenSeverity={(severity) => go(
            'resources',
            severity ? { risk: severity } : { has_findings: 'true' },
          )}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ResourceLandscape
          facets={facets}
          total={summary?.resource_count}
          isLoading={inventory.isLoading}
          error={inventory.isError ? inventory.error : null}
          onOpenType={(type) => go('resources', type ? { type } : undefined)}
          onOpenCategory={(category) => go('resources', category ? { category } : undefined)}
          region={region}
        />

        <StatusDistribution
          facets={facets}
          summary={summary}
          total={summary?.resource_count}
          isLoading={inventory.isLoading}
          error={inventory.isError ? inventory.error : null}
          onOpenStatus={(status) => go('resources', { status })}
          region={region}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RegionDistribution
          facets={facets}
          total={summary?.resource_count}
          isLoading={inventory.isLoading}
          error={inventory.isError ? inventory.error : null}
          onOpenRegion={(region) => go('resources', { region })}
        />

        <DataQualityPanel
          dataQuality={dataQuality}
          isLoading={inventory.isLoading}
          error={inventory.isError ? inventory.error : null}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <TopCostResources
          rows={topCost.data}
          capabilities={inventory.data?.capabilities}
          isLoading={topCost.isLoading}
          error={topCost.isError ? topCost.error : null}
          onOpenResource={(id) => navigate(`/cloud/resources/${id}`)}
          onOpenCost={() => go('cost')}
        />

        <TopRisks
          posture={posture.data}
          isLoading={posture.isLoading}
          error={posture.isError ? posture.error : null}
          onOpenResource={(id) => navigate(`/cloud/resources/${id}`)}
          onOpenSecurity={() => go('security')}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RecentlyDiscovered
          rows={recent.data?.rows}
          isLoading={recent.isLoading}
          error={recent.isError ? recent.error : null}
          onOpenResource={(id) => navigate(`/cloud/resources/${id}`)}
          onOpenAll={() => go('resources')}
        />

        <RecentChanges
          changes={recentChanges.data}
          summary={changes.data}
          isLoading={recentChanges.isLoading}
          error={recentChanges.isError ? recentChanges.error : null}
          onOpenDrift={() => go('drift')}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <RecentEvents
          events={events.data}
          isLoading={events.isLoading}
          error={events.isError ? events.error : null}
          onOpenEvents={() => go('events')}
        />

        <div className="space-y-4">
          <TopologySnapshot
            topology={topology.data}
            isLoading={topology.isLoading}
            error={topology.isError ? topology.error : null}
            onOpenTopology={() => go('topology')}
          />

          <DiscoveryPanel
            discovery={discovery.data}
            isLoading={discovery.isLoading}
            error={discovery.isError ? discovery.error : null}
            onOpenDiagnostic={() => setShowDiagnostic(true)}
            onRunDiscovery={() => triggerDiscovery.mutate(accountId)}
          />
        </div>
      </div>

      {showDiagnostic && (
        <DiagnosticModal
          title="Account diagnostics"
          items={
            diagnosticsLoading
              ? [{ scope: 'Loading…', category: 'unknown', message: 'Fetching diagnostic information…' }]
              : diagnostics
                ? Object.entries(diagnostics)
                  .filter(([, value]) => value && typeof value === 'object' && 'status' in value)
                  .map(([area, value]) => ({
                    scope: area,
                    provider: diagnostics.provider,
                    category: value.status,
                    message: value.message || 'No further detail was recorded.',
                  }))
                : [{ scope: 'Account', category: 'unknown', message: 'No diagnostic information could be retrieved.' }]
          }
          onClose={() => setShowDiagnostic(false)}
        />
      )}
    </div>
  );
}
