import { cloudAxios } from './axios';

/**
 * Resource inventory endpoints.
 *
 * The rows, the facet counts, the summary strip and the CSV export are all
 * driven by ONE filter object, serialized here and nowhere else. That is a
 * correctness requirement rather than tidiness: when the export builds its own
 * query the user gets a file that disagrees with the table it came from, and
 * when the header builds its own the page reports a total the rows contradict.
 *
 * The legacy array-returning calls below are untouched — the topology, drift
 * and dashboard pages consume that shape.
 */

/** Repeated keys (`?type=A&type=B`), which is what FastAPI's List[str] reads.
 *  Axios would otherwise send `type[]=A`, which arrives as a different, unread
 *  parameter name and silently drops the filter. */
const serialize = (params) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      value.filter((v) => v !== undefined && v !== null && v !== '')
        .forEach((v) => search.append(key, String(v)));
      return;
    }
    search.append(key, String(value));
  });
  return search.toString();
};

/** Filters → query params. The single place the wire format is defined. */
export const toParams = (filters = {}) => ({
  q: filters.q || undefined,
  provider: filters.providers?.length ? filters.providers : undefined,
  type: filters.types?.length ? filters.types : undefined,
  category: filters.categories?.length ? filters.categories : undefined,
  service: filters.services?.length ? filters.services : undefined,
  region: filters.regions?.length ? filters.regions : undefined,
  status: filters.statuses?.length ? filters.statuses : undefined,
  risk: filters.risk?.length ? filters.risk : undefined,
  environment: filters.environments?.length ? filters.environments : undefined,
  owner: filters.owners?.length ? filters.owners : undefined,
  resource_group: filters.resourceGroups?.length ? filters.resourceGroups : undefined,
  compartment: filters.compartments?.length ? filters.compartments : undefined,
  attachment: filters.attachment || undefined,
  // Tri-state: true, false and "not filtered" are three different queries, so
  // `false` has to travel. `|| undefined` would erase it.
  has_tags: typeof filters.hasTags === 'boolean' ? filters.hasTags : undefined,
  tag_key: filters.tagKey || undefined,
  tag_value: filters.tagValue || undefined,
  missing_tag: filters.missingTag || undefined,
  has_cost: typeof filters.hasCost === 'boolean' ? filters.hasCost : undefined,
  cost_min: typeof filters.costMin === 'number' ? filters.costMin : undefined,
  cost_max: typeof filters.costMax === 'number' ? filters.costMax : undefined,
  has_findings: typeof filters.hasFindings === 'boolean' ? filters.hasFindings : undefined,
  updated_after: filters.updatedAfter || undefined,
  updated_before: filters.updatedBefore || undefined,
  stale: typeof filters.stale === 'boolean' ? filters.stale : undefined,
  // True is the backend default; sending it on every request only makes the
  // shareable URL noisier.
  include_defaults: filters.includeDefaults === false ? false : undefined,
});

/** Wire params → the UI's filter object. The inverse of `toParams`, kept beside
 *  it so the two cannot drift: a saved view is stored in the backend's
 *  vocabulary, and reopening one has to land back on exactly the filters that
 *  produced it. */
export const fromParams = (params = {}) => {
  const asArray = (v) => (Array.isArray(v) ? v : [v]).filter((x) => x !== undefined && x !== null);
  const out = {};
  const pairs = [
    ['provider', 'providers'], ['type', 'types'], ['category', 'categories'],
    ['service', 'services'],
    ['region', 'regions'], ['status', 'statuses'], ['risk', 'risk'],
    ['environment', 'environments'], ['owner', 'owners'],
    ['resource_group', 'resourceGroups'], ['compartment', 'compartments'],
  ];
  pairs.forEach(([wire, ui]) => {
    if (params[wire] !== undefined && params[wire] !== null) out[ui] = asArray(params[wire]);
  });
  const scalars = [
    ['q', 'q'], ['attachment', 'attachment'], ['tag_key', 'tagKey'],
    ['tag_value', 'tagValue'], ['missing_tag', 'missingTag'],
  ];
  scalars.forEach(([wire, ui]) => {
    if (params[wire]) out[ui] = params[wire];
  });
  // Booleans are copied only when actually present: `false` is a filter, and
  // absent is not the same as false.
  [['has_tags', 'hasTags'], ['has_cost', 'hasCost'], ['has_findings', 'hasFindings'],
    ['stale', 'stale'], ['include_defaults', 'includeDefaults']].forEach(([wire, ui]) => {
    if (typeof params[wire] === 'boolean') out[ui] = params[wire];
  });
  if (typeof params.cost_min === 'number') out.costMin = params.cost_min;
  if (typeof params.cost_max === 'number') out.costMax = params.cost_max;
  return out;
};

const paging = (options = {}) => ({
  sort: options.sort || undefined,
  dir: options.dir || undefined,
  page: options.page || undefined,
  page_size: options.pageSize || undefined,
});

const get = async (path, params) => {
  const { data } = await cloudAxios.get(path, {
    params,
    paramsSerializer: { serialize },
  });
  return data;
};

/** One page of rows, plus the totals and facet counts describing that page's
 *  filter. `scope` is an account id or the literal 'ALL'. */
export const queryResources = (scope, filters = {}, options = {}) => get(
  `/resources/query/${scope}`,
  {
    ...toParams(filters),
    ...paging(options),
    group_by: options.groupBy || undefined,
    include_facets: options.includeFacets === false ? false : undefined,
    include_summary: options.includeSummary === false ? false : undefined,
  },
);

export const getResourceSummary = (scope, filters = {}) => get(
  `/resources/summary/${scope}`, toParams(filters),
);

export const getResourceFacets = (scope, filters = {}) => get(
  `/resources/facets/${scope}`, toParams(filters),
);

export const getResourceGroups = (scope, groupBy, filters = {}) => get(
  `/resources/groups/${scope}`, { ...toParams(filters), group_by: groupBy },
);

/** Statuses, categories, risk levels, the resource-type registry and the
 *  provider capability matrix. Fetched rather than hardcoded so the UI cannot
 *  drift from the vocabulary the backend actually groups by. */
export const getResourceReference = (scope) => get(`/resources/reference/${scope}`);

/**
 * Download the filtered set as CSV.
 *
 * Deliberately sends the filters and NOT the paging: the file covers every
 * matching row, not the fifty currently on screen. The backend honours the
 * same rule; this mirrors it so the intent is visible from both ends.
 */
export const exportResourcesCsv = async (scope, filters = {}) => {
  const response = await cloudAxios.get(`/resources/export/${scope}`, {
    params: toParams(filters),
    paramsSerializer: { serialize },
    responseType: 'blob',
  });

  // Prefer the server's filename — it carries the generation timestamp that
  // the metadata preamble inside the file also records, so a file on disk can
  // be matched to the query that produced it.
  const disposition = response.headers?.['content-disposition'] || '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match ? match[1] : 'resources.csv';

  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return { filename, rows: Number(response.headers?.['x-resource-rows']) || null };
};

/**
 * Download a combined security/utilization/performance/cost-anomaly
 * assessment for a hand-picked set of resources, as one CSV (one row per
 * finding/metric/anomaly — see Backend/cloud/app/services/resource_assessment_service.py).
 */
export const exportResourceAssessment = async (accountId, resourceIds) => {
  const response = await cloudAxios.post(
    '/resources/assessment-export',
    { account_id: accountId, resource_ids: resourceIds },
    { responseType: 'blob' },
  );

  const disposition = response.headers?.['content-disposition'] || '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match ? match[1] : 'resource-assessment.csv';

  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return { filename, rows: Number(response.headers?.['x-assessment-rows']) || null };
};

// ── Actions ──────────────────────────────────────────────────────────────────
// Nothing here changes a cloud resource today: no provider adapter implements a
// write, so `previewAction` reports genuinely (permission, provider support,
// resource state, topology dependencies) and execution is refused and audited.

export const getAvailableActions = (provider) => get(
  '/resources/actions/available', { provider: provider || undefined },
);

/** Ask what an action WOULD do. Safe to call freely — it touches nothing. */
export const previewAction = async (resourceId, action, params = null) => {
  const { data } = await cloudAxios.post('/resources/actions', {
    resource_id: resourceId, action, dry_run: true, params,
  });
  return data;
};

export const previewBulkAction = async (resourceIds, action, params = null) => {
  const { data } = await cloudAxios.post('/resources/actions/bulk', {
    resource_ids: resourceIds, action, dry_run: true, params,
  });
  return data;
};

export const getActionHistory = (params = {}) => get('/resources/actions/history', {
  account_id: params.accountId || undefined,
  resource_id: params.resourceId || undefined,
  limit: params.limit || undefined,
});

// ── Saved views ──────────────────────────────────────────────────────────────
export const listSavedViews = (scope) => get('/resources/views', { scope: scope || undefined });

/** Saving sends the filters in the backend's own vocabulary, so a stored view
 *  is literally a stored request rather than a second dialect to translate. */
export const saveView = async (view) => {
  const { data } = await cloudAxios.post('/resources/views', {
    name: view.name,
    scope: view.scope || 'ALL',
    description: view.description || null,
    filters: toParams(view.filters || {}),
    columns: view.columns || null,
    sort: view.sort || null,
    dir: view.dir || null,
    group_by: view.groupBy || null,
  });
  return data;
};

export const deleteSavedView = async (viewId) => {
  await cloudAxios.delete(`/resources/views/${viewId}`);
  return viewId;
};

// ── Legacy shape: a bare array, no paging ────────────────────────────────────
// Still used by topology, drift and the account dashboard. Left exactly as it
// was; new callers should use queryResources.
export const getResources = async (accountId) => {
  const { data } = await cloudAxios.get(`/resources/${accountId}`);
  return data;
};

export const getAllResources = async () => {
  const { data } = await cloudAxios.get('/resources');
  return data;
};

export const getResourceDetail = async (resourceId) => {
  const { data } = await cloudAxios.get(`/resources/detail/${resourceId}`);
  return data;
};

export const getResourceMetrics = async (resourceId) => {
  const { data } = await cloudAxios.get(`/resources/detail/${resourceId}/metrics`);
  return data;
};
