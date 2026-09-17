import { cloudAxios } from './axios';

/**
 * The Overview's own thin API layer.
 *
 * There is no `/cloud/overview/{id}` endpoint and deliberately so. Every number
 * the Overview shows is already owned by a system that computes it: inventory by
 * the resource query layer, posture by the Security Center, spend by the Cost
 * service, changes by Config Drift, activity by the Event Log, relationships by
 * Topology, scans by Discovery. A single aggregating endpoint would have to wait
 * on all of them, so one slow provider call would blank the whole page — and it
 * would become a second place where "how many resources are there" is decided.
 *
 * So the Overview composes. Each call below is separately cacheable, separately
 * refreshable and separately able to fail without taking the page with it.
 *
 * The one call added for this page is `getLatestDiscovery`: the discovery system
 * could previously only be asked about a job id the browser already had, which a
 * freshly-loaded page never does.
 */

/** Inventory: totals, type/region/status counts, coverage — in ONE request.
 *
 *  `page_size=1` is the point. The Overview needs the aggregates, not the rows,
 *  and this endpoint computes every one of them in the database from the same
 *  filter. The page it replaces downloaded all 1,530 resources in the estate
 *  (1.7 MB) and counted them in the browser to show one account's 476. */
export const getOverviewInventory = async (accountId, region = null) => {
  const { data } = await cloudAxios.get(`/resources/query/${accountId}`, {
    params: {
      page_size: 1,
      include_facets: true,
      include_summary: true,
      // A region narrows every inventory figure at once — totals, facets and
      // coverage all come from this one filtered query, so they cannot end up
      // describing different scopes.
      ...(region ? { region } : {}),
    },
  });
  return data;
};

/** The newest resources, ordered and limited by the database rather than by
 *  sorting the whole estate in the browser. */
export const getRecentResources = async (accountId, limit = 6) => {
  const { data } = await cloudAxios.get(`/resources/query/${accountId}`, {
    params: {
      page_size: limit,
      sort: 'discovered_at',
      dir: 'desc',
      include_facets: false,
      include_summary: false,
    },
  });
  return data;
};

/** The most expensive resources, where the provider bills per resource at all.
 *  `has_cost=true` keeps unpriced resources out of a "top cost" list rather
 *  than letting them rank as zero. */
export const getTopCostResources = async (accountId, limit = 5) => {
  const { data } = await cloudAxios.get(`/resources/query/${accountId}`, {
    params: {
      page_size: limit,
      sort: 'cost',
      dir: 'desc',
      has_cost: true,
      include_facets: false,
      include_summary: false,
    },
  });
  return data;
};

/** Canonical security posture — the SAME endpoint the Security Center reads.
 *  The Overview previously called /cloud/security/{id}, a separate rule engine
 *  that scored the same account differently (0 vs 35 on oci_test, 0 vs 52 on
 *  test_aw). One source of truth, or the two disagree in front of the user. */
export const getSecurityPostureCanonical = async (accountId) => {
  const { data } = await cloudAxios.get(`/security-center/${accountId}`);
  return data;
};

/** Daily billed spend. Real series or nothing — never a zero-filled line. */
export const getCostSeries = async (accountId, days = 30) => {
  const { data } = await cloudAxios.get(`/cost/history/${accountId}`, {
    params: { days },
  });
  return data;
};

/** Account-level billed total, with its currency and source. */
export const getCostTotal = async (accountId) => {
  const { data } = await cloudAxios.get(`/cost-estimate/${accountId}`);
  return data;
};

/** What changed, from Config Drift. `has_history` distinguishes "nothing
 *  changed" from "nobody was recording", which a count alone cannot. */
export const getChangeSummary = async (accountId, days = 30) => {
  const { data } = await cloudAxios.get('/drift/summary', {
    params: { account_id: accountId, days },
  });
  return data;
};

export const getRecentChanges = async (accountId, limit = 5) => {
  const { data } = await cloudAxios.get('/drift', {
    params: { account_id: accountId, days: 30, page: 1, page_size: limit },
  });
  return data;
};

/** Recent control-plane activity from the Event Log. page_size is one of the
 *  sizes that endpoint accepts; the Overview slices what it shows. */
export const getRecentEvents = async (accountId, range = '7d') => {
  const { data } = await cloudAxios.get('/events', {
    params: { account_id: accountId, range, page: 1, page_size: 25 },
  });
  return data;
};

/** Relationship counts from the topology engine — not a second graph build. */
export const getTopologySummary = async (accountId) => {
  const { data } = await cloudAxios.get(`/topology/${accountId}/coverage`);
  return data;
};

/** The account's last scan, its last SUCCESSFUL scan, and what that one
 *  changed. The two differ whenever a refresh failed, and reporting only the
 *  first makes stale inventory look fresh. */
export const getLatestDiscovery = async (accountId) => {
  const { data } = await cloudAxios.get(`/discovery/latest/${accountId}`);
  return data;
};
