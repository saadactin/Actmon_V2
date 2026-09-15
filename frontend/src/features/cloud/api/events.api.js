import { cloudAxios } from './axios';

/**
 * Event Log (unified cloud audit trail) endpoints.
 *
 * One `filters` object is threaded through the list, stats, timeline and export
 * calls, so the table, the summary cards and the exported file are always
 * describing the same query. That is a correctness requirement, not tidiness:
 * an export that quietly used a different filter set from the table it was
 * taken from would produce a file nobody can trust.
 *
 * Axios drops `undefined` keys, so a caller that only knows the account and the
 * window sends exactly those two.
 */

/** Filters → query params. The single place the wire format is defined. */
const toParams = (filters = {}) => ({
  account_id: filters.accountId || undefined,
  range: filters.range || undefined,
  start: filters.start || undefined,
  end: filters.end || undefined,
  provider: filters.provider || undefined,
  event_category: filters.category || undefined,
  provider_category: filters.providerCategory || undefined,
  action: filters.action || undefined,
  status: filters.status || undefined,
  risk_level: filters.risk || undefined,
  min_risk: filters.minRisk || undefined,
  actor_name: filters.actor || undefined,
  actor_type: filters.actorType || undefined,
  resource_type: filters.resourceType || undefined,
  resource_id: filters.resourceId || undefined,
  region: filters.region || undefined,
  account_ref: filters.accountRef || undefined,
  subscription_id: filters.subscriptionId || undefined,
  tenant_id: filters.tenantId || undefined,
  compartment_name: filters.compartment || undefined,
  resource_group: filters.resourceGroup || undefined,
  access_method: filters.accessMethod || undefined,
  event_name: filters.eventName || undefined,
  source_ip: filters.sourceIp || undefined,
  correlation_id: filters.correlationId || undefined,
  request_id: filters.requestId || undefined,
  search: filters.search || undefined,
  // `false` must not be sent as a filter at all — it is the default, and
  // sending it makes every URL noisier for no behaviour change.
  exclude_read_only: filters.excludeReadOnly ? true : undefined,
  // The advanced AND/OR tree travels as JSON in a query parameter rather than
  // a POST body, so a filtered view stays a shareable, bookmarkable URL.
  advanced_filter: filters.advanced ? JSON.stringify(filters.advanced) : undefined,
});

export const getEvents = async (filters = {}, options = {}) => {
  const { data } = await cloudAxios.get('/events', {
    params: {
      ...toParams(filters),
      sort: options.sort || undefined,
      page: options.page || undefined,
      page_size: options.pageSize || undefined,
    },
  });
  return data;
};

export const getEventStats = async (filters = {}) => {
  const { data } = await cloudAxios.get('/events/stats', { params: toParams(filters) });
  return data;
};

export const getEventTimeline = async (filters = {}) => {
  const { data } = await cloudAxios.get('/events/timeline', { params: toParams(filters) });
  return data;
};

export const getEventFacets = async (accountId, range) => {
  const { data } = await cloudAxios.get('/events/facets', {
    params: { account_id: accountId || undefined, range: range || undefined },
  });
  return data;
};

export const getEvent = async (eventId) => {
  const { data } = await cloudAxios.get(`/events/${eventId}`);
  return data;
};

export const getEventRaw = async (eventId) => {
  const { data } = await cloudAxios.get(`/events/${eventId}/raw`);
  return data;
};

export const getRelatedEvents = async (eventId) => {
  const { data } = await cloudAxios.get(`/events/${eventId}/related`);
  return data;
};

/** Per-provider collection health — what makes "no events" and "collection is
    broken" tellable apart. */
export const getEventSources = async (accountId) => {
  const { data } = await cloudAxios.get('/events/sources', {
    params: { account_id: accountId || undefined },
  });
  return data;
};

export const getCollectionStatus = async (accountId) => {
  const { data } = await cloudAxios.get('/events/collection', {
    params: { account_id: accountId || undefined },
  });
  return data;
};

export const getEventActors = async (filters = {}, limit = 25) => {
  const { data } = await cloudAxios.get('/events/actors', {
    params: { ...toParams(filters), limit },
  });
  return data;
};

/** Events touching one resource — the Configuration Drift → Event Log link. */
export const getEventsForResource = async ({
  accountId, resourceId, resourceName, around, hours = 72,
}) => {
  const { data } = await cloudAxios.get('/events/for-resource', {
    params: {
      account_id: accountId || undefined,
      resource_id: resourceId || undefined,
      resource_name: resourceName || undefined,
      around: around || undefined,
      hours,
    },
  });
  return data;
};

export const getEventSettings = async () => {
  const { data } = await cloudAxios.get('/events/settings');
  return data;
};

export const updateEventSettings = async (changes) => {
  const { data } = await cloudAxios.put('/events/settings', changes);
  return data;
};

export const getEventRules = async () => {
  const { data } = await cloudAxios.get('/events/rules');
  return data;
};

export const getEventAccess = async () => {
  const { data } = await cloudAxios.get('/events/access');
  return data;
};

export const getSavedQueries = async () => {
  const { data } = await cloudAxios.get('/events/queries');
  return data;
};

export const saveQuery = async (payload) => {
  const { data } = await cloudAxios.post('/events/queries', payload);
  return data;
};

export const deleteSavedQuery = async (queryId) => {
  const { data } = await cloudAxios.delete(`/events/queries/${queryId}`);
  return data;
};

export const collectEvents = async (accountId, lookbackHours) => {
  const { data } = await cloudAxios.post('/events/collect', null, {
    params: {
      account_id: accountId || undefined,
      lookback_hours: lookbackHours || undefined,
    },
    // A synchronous collection walks several provider scopes; the default axios
    // timeout would abandon it long before it finishes and report a failure for
    // a collection that is in fact still running and will complete.
    timeout: 300_000,
  });
  return data;
};

/**
 * Download an export of the CURRENT filter set — every matching event, not the
 * visible page.
 *
 * Fetched as a blob rather than by pointing the browser at the URL, because the
 * server answers a bad filter with a 400 that we want to surface as an error
 * instead of navigating the user to a JSON error document. The blob route also
 * lets the truncation headers be read before the file is offered.
 */
export const exportEvents = async (filters = {}, format = 'csv', options = {}) => {
  const response = await cloudAxios.get('/events/export', {
    params: {
      ...toParams(filters),
      format,
      sort: options.sort || undefined,
      include_raw: options.includeRaw ? true : undefined,
    },
    responseType: 'blob',
    timeout: 300_000,
  });

  const disposition = response.headers['content-disposition'] || '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match ? match[1] : `cloud-events.${format}`;

  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return {
    filename,
    total: Number(response.headers['x-event-total'] || 0),
    truncated: response.headers['x-event-truncated'] === 'true',
  };
};

export { toParams as eventFiltersToParams };
