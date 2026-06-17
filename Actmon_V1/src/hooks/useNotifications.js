import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getNotifications, markNotificationsRead } from '../api/agents';

export const useNotifications = (limit = 50) => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['notifications', limit],
    queryFn: () => getNotifications(limit),
    refetchInterval: 30000,
    refetchIntervalInBackground: true,
  });

  const markReadMutation = useMutation({
    mutationFn: markNotificationsRead,

    // Optimistically flip is_read=true in every cached notification list
    // so the badge count drops the instant the user clicks — no network wait.
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: ['notifications'] });
      const idSet = new Set(ids);
      queryClient.setQueriesData({ queryKey: ['notifications'] }, (old) => {
        if (!Array.isArray(old)) return old;
        return old.map((n) => (idSet.has(n.id) ? { ...n, is_read: true } : n));
      });
    },

    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },

    // Roll back to server truth on error
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const unreadCount = query.data ? query.data.filter((n) => !n.is_read).length : 0;

  const markRead = (ids) => {
    if (!ids.length) return;
    markReadMutation.mutate(ids);
  };

  const markAllRead = () => {
    if (query.data) {
      const unreadIds = query.data.filter((n) => !n.is_read).map((n) => n.id);
      if (unreadIds.length) markReadMutation.mutate(unreadIds);
    }
  };

  return {
    notifications: query.data || [],
    isLoading: query.isLoading,
    isError: query.isError,
    unreadCount,
    markRead,
    markAllRead,
    isPending: markReadMutation.isPending,
  };
};
