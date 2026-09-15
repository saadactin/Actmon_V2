import { cloudAxios } from './axios';

/**
 * Topology API client.
 *
 * `toParams` is the single definition of the wire format. Every caller goes
 * through it, so the graph request and the export request cannot disagree
 * about what a filter is called — an export that silently dropped a filter and
 * returned the whole cloud would be the worst bug this feature could have.
 *
 * Falsy values are omitted rather than sent as empty strings, because the
 * backend treats a present-but-empty filter as "match the empty value" for
 * some fields, and "no filter" is what an empty control means.
 */
export function toParams({
  view,
  search,
  filters = {},
  hideDefaults,
  hideIsolated,
  hideEmptyContainers,
  nodeLimit,
  contextHops,
  refresh,
} = {}) {
  const params = {};
  if (view && view !== 'infrastructure') params.view = view;
  if (search) params.search = search;

  const map = {
    provider: 'provider',
    accountId: 'account_id',
    accountName: 'account_name',
    region: 'region',
    resourceType: 'resource_type',
    category: 'category',
    status: 'status',
    health: 'health',
    resourceGroup: 'resource_group',
    compartmentId: 'compartment_id',
    compartmentName: 'compartment_name',
    exposureSeverity: 'exposure_severity',
  };
  Object.entries(map).forEach(([key, wire]) => {
    if (filters[key]) params[wire] = filters[key];
  });
  // Booleans are only sent when true; `false` is the default server-side.
  if (filters.hasDrift) params.has_drift = true;
  if (filters.hasEvents) params.has_events = true;
  if (filters.exposed) params.exposed = true;
  if (filters.hasBroadAccess) params.has_broad_access = true;

  if (hideDefaults) params.hide_defaults = true;
  if (hideIsolated) params.hide_isolated = true;
  if (hideEmptyContainers) params.hide_empty_containers = true;
  if (nodeLimit) params.node_limit = nodeLimit;
  if (contextHops) params.context_hops = contextHops;
  if (refresh) params.refresh = true;
  return params;
}

/** True when any filter, search term or hide toggle is active. */
export function hasActiveFilters(options = {}) {
  const params = toParams(options);
  delete params.view;
  delete params.refresh;
  delete params.node_limit;
  delete params.context_hops;
  return Object.keys(params).length > 0;
}

export const getTopology = async (scope, options) => {
  const { data } = await cloudAxios.get(`/topology/${scope}`, { params: toParams(options) });
  return data;
};

export const getGlobalView = async () => {
  const { data } = await cloudAxios.get('/topology/global');
  return data;
};

export const getRelationshipCatalog = async () => {
  const { data } = await cloudAxios.get('/topology/relationships');
  return data;
};

export const getResourceTopology = async (scope, resourceId, { hops = 2, view, includeRaw = false } = {}) => {
  const { data } = await cloudAxios.get(`/topology/${scope}/resource/${resourceId}`, {
    params: { hops, ...(view && view !== 'infrastructure' ? { view } : {}), include_raw: includeRaw },
  });
  return data;
};

export const getNeighbors = async (scope, resourceId, { hops = 1, view } = {}) => {
  const { data } = await cloudAxios.get(`/topology/${scope}/resource/${resourceId}/neighbors`, {
    params: { hops, ...(view && view !== 'infrastructure' ? { view } : {}) },
  });
  return data;
};

export const getPath = async (scope, { source, target, maxDepth = 6, view, relationshipTypes } = {}) => {
  const { data } = await cloudAxios.get(`/topology/${scope}/path`, {
    params: {
      source,
      target,
      max_depth: maxDepth,
      ...(view && view !== 'infrastructure' ? { view } : {}),
      ...(relationshipTypes?.length ? { relationship_types: relationshipTypes.join(',') } : {}),
    },
  });
  return data;
};

export const getImpact = async (scope, resourceId, { maxDepth = 4 } = {}) => {
  const { data } = await cloudAxios.get(`/topology/${scope}/impact/${resourceId}`, {
    params: { max_depth: maxDepth },
  });
  return data;
};

export const getEdge = async (scope, edgeId) => {
  const { data } = await cloudAxios.get(`/topology/${scope}/edge/${edgeId}`);
  return data;
};

export const getCoverage = async (scope) => {
  const { data } = await cloudAxios.get(`/topology/${scope}/coverage`);
  return data;
};

export const getUnresolved = async (scope, { limit = 500 } = {}) => {
  const { data } = await cloudAxios.get(`/topology/${scope}/unresolved`, { params: { limit } });
  return data;
};

export const getIsolated = async (scope) => {
  const { data } = await cloudAxios.get(`/topology/${scope}/isolated`);
  return data;
};

export const getDiagnostics = async (scope) => {
  const { data } = await cloudAxios.get(`/topology/${scope}/diagnostics`);
  return data;
};

export const searchTopology = async (scope, query, { limit = 50 } = {}) => {
  const { data } = await cloudAxios.get(`/topology/${scope}/search`, {
    params: { q: query, limit },
  });
  return data;
};

export const takeSnapshot = async (scope, { label, note } = {}) => {
  const { data } = await cloudAxios.post(`/topology/${scope}/snapshot`, null, {
    params: { ...(label ? { label } : {}), ...(note ? { note } : {}) },
  });
  return data;
};

export const listSnapshots = async ({ scope, limit = 50 } = {}) => {
  const { data } = await cloudAxios.get('/topology/snapshots', {
    params: { ...(scope ? { scope } : {}), limit },
  });
  return data;
};

export const diffSnapshot = async (snapshotId, { against } = {}) => {
  const { data } = await cloudAxios.get(`/topology/snapshots/${snapshotId}/diff`, {
    params: against ? { against } : {},
  });
  return data;
};

export const deleteSnapshot = async (snapshotId) => {
  const { data } = await cloudAxios.delete(`/topology/snapshots/${snapshotId}`);
  return data;
};

/**
 * Download the topology in the format asked for, with the filters that are
 * currently applied.
 *
 * Read as a blob rather than parsed, so a large CSV never becomes a JS string,
 * and the filename comes from the server's Content-Disposition when it sends
 * one — the server knows the scope and the generation timestamp.
 */
export const exportTopology = async (scope, { format = 'json', ...options } = {}) => {
  const response = await cloudAxios.get(`/topology/${scope}/export`, {
    params: { fmt: format, ...toParams(options) },
    responseType: 'blob',
  });

  const disposition = response.headers?.['content-disposition'] || '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match?.[1] || `topology-${scope}.${format}`;

  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: revoking synchronously can cancel the download
  // in some browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { filename };
};
