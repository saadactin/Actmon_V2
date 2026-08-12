import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * One hook, reused by every Administration sub-page — list + create/update/
 * remove for whichever `api` (from `@/api/admin`) the page's config points
 * at. `resourceKey` namespaces the query cache per entity; `orgId` (when the
 * resource is org-scoped) is folded into the key so switching organizations
 * refetches rather than showing stale data.
 *
 * Mutations don't optimistically merge a returned row — the backend doesn't
 * reliably hand one back (see api/admin.js) — they just invalidate the list,
 * same as the production reference's `loadRecords()`-after-mutation pattern.
 */
export default function useAdminResource(resourceKey, api, orgId) {
  const qc = useQueryClient();
  const KEY = ['admin', resourceKey, orgId ?? null];

  const query = useQuery({
    queryKey: KEY,
    queryFn: () => api.list(orgId),
    retry: false,
  });

  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: KEY }), [qc, KEY]);

  const create = useMutation({ mutationFn: api.create, onSuccess: invalidate });
  const update = useMutation({ mutationFn: ({ id, row }) => api.update(id, row), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: api.remove, onSuccess: invalidate });

  return {
    rows: query.data || [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refresh: invalidate,

    create: create.mutateAsync,
    isCreating: create.isPending,
    update: update.mutateAsync,
    isUpdating: update.isPending,
    remove: remove.mutateAsync,
    isRemoving: remove.isPending,
  };
}
