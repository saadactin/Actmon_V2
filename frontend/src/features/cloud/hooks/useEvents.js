import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  collectEvents,
  deleteSavedQuery,
  getCollectionStatus,
  getEvent,
  getEventAccess,
  getEventActors,
  getEventFacets,
  getEventRaw,
  getEventSettings,
  getEventSources,
  getEventStats,
  getEventTimeline,
  getEvents,
  getEventsForResource,
  getRelatedEvents,
  getSavedQueries,
  saveQuery,
  updateEventSettings,
} from '../api/events.api';

// The audit trail only grows when a collection lands, so a short stale time
// buys nothing on its own. Live mode is opt-in and drives `refetchInterval`
// instead — see useEventLive below. 20s is short enough that switching tabs
// back shows current data, long enough that paging and filtering do not refetch
// what cannot have changed.
const STALE = 20_000;

// Auto-refresh choices, in milliseconds. `0` is Off.
export const REFRESH_INTERVALS = [
  { id: '0', label: 'Off', ms: 0 },
  { id: '10', label: '10 seconds', ms: 10_000 },
  { id: '30', label: '30 seconds', ms: 30_000 },
  { id: '60', label: '1 minute', ms: 60_000 },
  { id: '300', label: '5 minutes', ms: 300_000 },
];

/**
 * The event feed.
 *
 * `placeholderData` keeps the previous page on screen while the next one loads,
 * so paging and filtering do not blank the table — the same treatment the drift
 * log gets. With auto-refresh on, it also stops the table flickering every
 * interval.
 */
export const useEventList = (filters, options = {}, refreshMs = 0) => useQuery({
  queryKey: ['cloudEvents', filters, options],
  queryFn: () => getEvents(filters, options),
  enabled: options.enabled !== false,
  staleTime: STALE,
  placeholderData: (prev) => prev,
  refetchInterval: refreshMs || false,
  // Only poll a visible tab. A background tab polling every 10 seconds spends
  // the provider API budget and the user's battery on a page nobody is reading.
  refetchIntervalInBackground: false,
});

export const useEventStats = (filters, refreshMs = 0, enabled = true) => useQuery({
  queryKey: ['cloudEventStats', filters],
  queryFn: () => getEventStats(filters),
  enabled,
  staleTime: STALE,
  placeholderData: (prev) => prev,
  refetchInterval: refreshMs || false,
  refetchIntervalInBackground: false,
});

export const useEventTimeline = (filters, enabled = true, refreshMs = 0) => useQuery({
  queryKey: ['cloudEventTimeline', filters],
  queryFn: () => getEventTimeline(filters),
  enabled,
  staleTime: STALE,
  placeholderData: (prev) => prev,
  refetchInterval: refreshMs || false,
  refetchIntervalInBackground: false,
});

// Facet lists change only when a new KIND of event arrives, which is far rarer
// than a new event — so they are cached much longer than the feed.
export const useEventFacets = (accountId, range) => useQuery({
  queryKey: ['cloudEventFacets', accountId, range],
  queryFn: () => getEventFacets(accountId, range),
  enabled: !!accountId,
  staleTime: 300_000,
});

export const useEvent = (eventId) => useQuery({
  queryKey: ['cloudEvent', eventId],
  queryFn: () => getEvent(eventId),
  enabled: !!eventId,
  // An event is immutable by design, so once fetched it never needs refetching.
  staleTime: Infinity,
});

// Fetched only when the raw section is actually expanded: a CloudTrail payload
// is large, and opening every drawer would pull one down whether or not anyone
// looks. Reading it is also audited server-side, so an unrequested fetch would
// put a VIEW_RAW_EVENT entry in the access log that nobody actually performed.
export const useEventRaw = (eventId, enabled) => useQuery({
  queryKey: ['cloudEventRaw', eventId],
  queryFn: () => getEventRaw(eventId),
  enabled: !!eventId && !!enabled,
  staleTime: Infinity,
});

export const useRelatedEvents = (eventId, enabled = true) => useQuery({
  queryKey: ['cloudEventRelated', eventId],
  queryFn: () => getRelatedEvents(eventId),
  enabled: !!eventId && enabled,
  staleTime: 60_000,
});

export const useEventSources = (accountId, refreshMs = 0) => useQuery({
  queryKey: ['cloudEventSources', accountId],
  queryFn: () => getEventSources(accountId),
  enabled: !!accountId,
  staleTime: 30_000,
  refetchInterval: refreshMs || false,
  refetchIntervalInBackground: false,
});

export const useCollectionStatus = (accountId, enabled = true) => useQuery({
  queryKey: ['cloudEventCollection', accountId],
  queryFn: () => getCollectionStatus(accountId),
  enabled: !!accountId && enabled,
  staleTime: 15_000,
});

export const useEventActors = (filters, enabled = true) => useQuery({
  queryKey: ['cloudEventActors', filters],
  queryFn: () => getEventActors(filters),
  enabled,
  staleTime: STALE,
});

/** Events touching one resource — used by the drift → events bridge. */
export const useEventsForResource = (params, enabled = true) => useQuery({
  queryKey: ['cloudEventsForResource', params],
  queryFn: () => getEventsForResource(params),
  enabled: enabled && !!(params?.resourceId || params?.resourceName),
  staleTime: 60_000,
});

export const useEventSettings = (enabled = true) => useQuery({
  queryKey: ['cloudEventSettings'],
  queryFn: getEventSettings,
  enabled,
  staleTime: 120_000,
});

export const useEventAccess = (enabled = true) => useQuery({
  queryKey: ['cloudEventAccess'],
  queryFn: getEventAccess,
  enabled,
  staleTime: 120_000,
});

export const useSavedQueries = (enabled = true) => useQuery({
  queryKey: ['cloudEventSavedQueries'],
  queryFn: getSavedQueries,
  enabled,
  staleTime: 120_000,
});

// ── Mutations ────────────────────────────────────────────────────────────────

export const useUpdateEventSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: updateEventSettings,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cloudEventSettings'] });
      // Retention and read-only collection both change what the feed can
      // contain, so the cached lists are no longer trustworthy.
      qc.invalidateQueries({ queryKey: ['cloudEventCollection'] });
    },
  });
};

export const useSaveQuery = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveQuery,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cloudEventSavedQueries'] }),
  });
};

export const useDeleteSavedQuery = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteSavedQuery,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cloudEventSavedQueries'] }),
  });
};

export const useCollectEvents = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, lookbackHours }) => collectEvents(accountId, lookbackHours),
    onSuccess: () => {
      // A collection may have stored events, so every read of the trail is
      // stale — including the source health, which is the whole point of
      // having pressed the button.
      ['cloudEvents', 'cloudEventStats', 'cloudEventTimeline', 'cloudEventSources',
        'cloudEventCollection', 'cloudEventFacets', 'cloudEventActors',
      ].forEach((key) => qc.invalidateQueries({ queryKey: [key] }));
    },
  });
};
