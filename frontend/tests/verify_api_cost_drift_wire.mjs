// Cost, Drift and Overview API wire formats.
//
// The single highest-value property here: getCostHistory's custom-date-range
// rule. Both startDate and endDate together mean "this exact window"; either
// alone falls back to `days`. Getting this wrong either sends a request the
// backend rejects (a half-supplied pair), or -- worse -- silently shows a
// chart covering a different period than the one its own title claims.
//
// Also pins getSecurityPostureCanonical hitting /security-center/{id}, not
// /security/{id} -- a one-character regression away from the Overview and
// the Security Center disagreeing about the same account's score again
// (0 vs 35 on oci_test, 0 vs 52 on test_aw, before this endpoint was fixed).
import { cloudAxios } from '../src/features/cloud/api/axios.js';
import * as cost from '../src/features/cloud/api/cost.api.js';
import * as drift from '../src/features/cloud/api/drift.api.js';
import * as overview from '../src/features/cloud/api/overview.api.js';

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

let captured = null;
cloudAxios.defaults.adapter = async (config) => {
  captured = config;
  return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
};

async function capture(label, fn, ...args) {
  captured = null;
  await fn(...args);
  if (!captured) {
    check(`${label}: reached the stub adapter`, false, 'vacuous otherwise');
    return { uri: '', method: '' };
  }
  return { uri: cloudAxios.getUri(captured), method: captured.method };
}

const names = (uri) => {
  const q = uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : '';
  if (!q) return new Set();
  return new Set(q.split('&').map((p) => decodeURIComponent(p.split('=')[0])));
};

console.log('\n1. getCostHistory: the custom-range rule -- both dates, or neither, never a mix');
{
  const { uri: bothDates } = await capture('getCostHistory with both dates', cost.getCostHistory,
    'ACC-1', 90, undefined, { startDate: '2026-08-01', endDate: '2026-08-31' });
  check('BOTH dates given -> sends start_date/end_date and NO days',
    bothDates.includes('start_date=2026-08-01') && bothDates.includes('end_date=2026-08-31')
    && !names(bothDates).has('days'), bothDates);

  const { uri: onlyStart } = await capture('getCostHistory with only startDate', cost.getCostHistory,
    'ACC-1', 90, undefined, { startDate: '2026-08-01' });
  check('only startDate given -> falls back to days, sends NEITHER date '
    + '(a chart must never claim a period it did not actually use)',
    names(onlyStart).has('days') && !names(onlyStart).has('start_date')
    && !names(onlyStart).has('end_date'), onlyStart);

  const { uri: onlyEnd } = await capture('getCostHistory with only endDate', cost.getCostHistory,
    'ACC-1', 90, undefined, { endDate: '2026-08-31' });
  check('only endDate given -> falls back to days, sends neither date',
    names(onlyEnd).has('days') && !names(onlyEnd).has('start_date')
    && !names(onlyEnd).has('end_date'), onlyEnd);

  const { uri: neither } = await capture('getCostHistory with neither date', cost.getCostHistory,
    'ACC-1', 30, undefined, {});
  check('no dates given -> sends days=30 (the passed default)',
    neither.includes('days=30'), neither);
}

console.log('\n2. getCostHistory: region narrows, and absence is absence (not "all")');
{
  const { uri: withRegion } = await capture('getCostHistory with a region', cost.getCostHistory,
    'ACC-1', 30, undefined, { region: 'ap-south-1' });
  check('a region IS sent when given', withRegion.includes('region=ap-south-1'), withRegion);

  const { uri: noRegion } = await capture('getCostHistory with no region', cost.getCostHistory,
    'ACC-1', 30, undefined, {});
  check('no region key sent at all when absent (unregioned spend is excluded, '
    + 'never silently attributed to a region)', !names(noRegion).has('region'), noRegion);

  const { uri: withGroupBy } = await capture('getCostHistory with groupBy', cost.getCostHistory,
    'ACC-1', 30, 'service', {});
  check('group_by IS sent when given', withGroupBy.includes('group_by=service'), withGroupBy);
}

console.log('\n3. getCostReport maps all camelCase options to the backend\'s snake_case names');
{
  const { uri } = await capture('getCostReport with every option', cost.getCostReport,
    'ACC-1', 30, 'service', {
      region: 'ap-south-1', service: 'EC2', resourceType: 'EC2Instance',
      costComponent: 'compute', status: 'final', minCost: 10, maxCost: 900,
      dimensions: 'service,region', page: 2, pageSize: 50,
    });
  const n = names(uri);
  for (const wire of ['region', 'service', 'resource_type', 'cost_component',
    'status', 'min_cost', 'max_cost', 'dimensions', 'page', 'page_size', 'group_by', 'days']) {
    check(`getCostReport sends "${wire}"`, n.has(wire), uri);
  }
}

console.log('\n4. getCostAnomalies maps percentThreshold/minAbsolute correctly');
{
  const { uri } = await capture('getCostAnomalies', cost.getCostAnomalies, 'ACC-1', 60, {
    percentThreshold: 25, minAbsolute: 100,
  });
  check('percent_threshold is sent', uri.includes('percent_threshold=25'), uri);
  check('min_absolute is sent', uri.includes('min_absolute=100'), uri);
}

console.log('\n5. startCostBackfill is the ONLY provider-touching write in this module -- '
  + 'no read function is ever a POST');
{
  const { method: backfillMethod, uri: backfillUri } = await capture('startCostBackfill',
    cost.startCostBackfill, 'ACC-1', 90);
  check('startCostBackfill is POST', backfillMethod === 'post', backfillMethod);
  check('startCostBackfill carries days', backfillUri.includes('days=90'), backfillUri);

  const readOnly = [
    ['getCostSummary', cost.getCostSummary, ['ACC-1']],
    ['getCostEstimate', cost.getCostEstimate, ['ACC-1']],
    ['getCostAnalytics', cost.getCostAnalytics, ['ACC-1']],
    ['getCostCapabilities', cost.getCostCapabilities, ['ACC-1']],
    ['getCostQuality', cost.getCostQuality, ['ACC-1']],
    ['getCostHistory', cost.getCostHistory, ['ACC-1']],
    ['getCostCoverage', cost.getCostCoverage, ['ACC-1']],
    ['getCostForecast', cost.getCostForecast, ['ACC-1']],
    ['getCostAnomalies', cost.getCostAnomalies, ['ACC-1']],
    ['getCostTrends', cost.getCostTrends, ['ACC-1']],
    ['getCostBackfillStatus', cost.getCostBackfillStatus, ['ACC-1']],
    ['getBudgets', cost.getBudgets, ['ACC-1']],
    ['getBudgetStatus', cost.getBudgetStatus, ['ACC-1']],
    ['getAlertPolicies', cost.getAlertPolicies, []],
    ['getCostAllocation', cost.getCostAllocation, ['ACC-1']],
    ['getCostGovernance', cost.getCostGovernance, ['ACC-1']],
    ['getReportTypes', cost.getReportTypes, ['ACC-1']],
    ['getExecutiveReport', cost.getExecutiveReport, ['ACC-1']],
    ['getCostMetrics', cost.getCostMetrics, []],
  ];
  for (const [label, fn, args] of readOnly) {
    const { method } = await capture(label, fn, ...args);
    check(`${label} is a GET, never a provider-touching write`, method === 'get', method);
  }
}

console.log('\n6. Budget/policy/recommendation writes use the right verbs');
{
  const { method: create } = await capture('createBudget', cost.createBudget, { name: 'x' });
  check('createBudget is POST', create === 'post', create);
  const { method: update } = await capture('updateBudget', cost.updateBudget, 'b1', { name: 'y' });
  check('updateBudget is PUT', update === 'put', update);
  const { method: del } = await capture('deleteBudget', cost.deleteBudget, 'b1');
  check('deleteBudget is DELETE', del === 'delete', del);
  const { method: setRec } = await capture('setRecommendationState', cost.setRecommendationState,
    'fp1', { state: 'dismissed' });
  check('setRecommendationState is POST', setRec === 'post', setRec);
}

console.log('\n7. Overview API: the one-request inventory, and the canonical security path');
{
  const { uri: invUri } = await capture('getOverviewInventory', overview.getOverviewInventory, 'ACC-1');
  check('getOverviewInventory sends page_size=1 (aggregates, never a download)',
    invUri.includes('page_size=1'), invUri);
  check('getOverviewInventory sends include_facets=true and include_summary=true',
    invUri.includes('include_facets=true') && invUri.includes('include_summary=true'), invUri);

  const { uri: invRegionUri } = await capture('getOverviewInventory with a region',
    overview.getOverviewInventory, 'ACC-1', 'ap-south-1');
  check('a region narrows the inventory query when given',
    invRegionUri.includes('region=ap-south-1'), invRegionUri);

  const { uri: topCostUri } = await capture('getTopCostResources', overview.getTopCostResources, 'ACC-1', 5);
  check('getTopCostResources sends has_cost=true (unpriced resources never '
    + 'rank as a zero-cost "top spender")', topCostUri.includes('has_cost=true'), topCostUri);
  check('getTopCostResources sorts by cost, descending',
    topCostUri.includes('sort=cost') && topCostUri.includes('dir=desc'), topCostUri);

  const { uri: postureUri } = await capture('getSecurityPostureCanonical',
    overview.getSecurityPostureCanonical, 'ACC-1');
  check('getSecurityPostureCanonical hits /security-center/{id}, NOT /security/{id} '
    + '-- a one-character regression away from two disagreeing scores',
    postureUri.includes('/security-center/ACC-1') && !postureUri.includes('/security/ACC-1'),
    postureUri);

  const { uri: recentUri } = await capture('getRecentResources', overview.getRecentResources, 'ACC-1', 6);
  check('getRecentResources sorts discovered_at desc with facets/summary off',
    recentUri.includes('sort=discovered_at') && recentUri.includes('dir=desc')
    && recentUri.includes('include_facets=false') && recentUri.includes('include_summary=false'),
    recentUri);
}

console.log('\n8. Drift API: account/days threading and default days=30');
{
  const { uri } = await capture('getDriftChanges with every option', drift.getDriftChanges,
    'ACC-1', 14, {
      changeType: 'MODIFIED', impact: 'security', severity: 'HIGH',
      resourceType: 'EC2Instance', providerResourceId: 'i-1', direction: 'increase',
      search: 'sg-', page: 2, pageSize: 25,
    });
  const n = names(uri);
  for (const wire of ['account_id', 'days', 'change_type', 'impact', 'severity',
    'resource_type', 'provider_resource_id', 'direction', 'search', 'page', 'page_size']) {
    check(`getDriftChanges sends "${wire}"`, n.has(wire), uri);
  }

  const { uri: summaryUri } = await capture('getDriftSummary default days', drift.getDriftSummary, 'ACC-1');
  check('getDriftSummary defaults days to 30', summaryUri.includes('days=30'), summaryUri);
  const { uri: facetsUri } = await capture('getDriftFacets default days', drift.getDriftFacets, 'ACC-1');
  check('getDriftFacets defaults days to 30', facetsUri.includes('days=30'), facetsUri);

  const { uri: historyUri } = await capture('getInventoryHistory', drift.getInventoryHistory, 'ACC-1', {
    resourceType: 'EC2Instance', sort: 'discovered_at',
  });
  check('getInventoryHistory carries resource_type and sort',
    historyUri.includes('resource_type=EC2Instance') && historyUri.includes('sort=discovered_at'), historyUri);

  const { uri: resourceUri } = await capture('getResourceDrift', drift.getResourceDrift, 'r1', 100);
  check('getResourceDrift carries limit', resourceUri.includes('limit=100'), resourceUri);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
