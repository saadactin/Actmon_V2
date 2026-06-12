import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getNotifications, markNotificationsRead } from '../api/agents';

export const useNotifications = (limit = 50) => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['notifications', limit],
    queryFn: () => getNotifications(limit),
    refetchInterval: 30000, // Poll every 30 seconds
    refetchIntervalInBackground: true,
  });

  const markReadMutation = useMutation({
    mutationFn: markNotificationsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const unreadCount = query.data ? query.data.filter((n) => !n.is_read).length : 0;

  const markRead = (ids) => {
    if (ids.length === 0) return;
    markReadMutation.mutate(ids);
  };

  const markAllRead = () => {
    if (query.data) {
      const unreadIds = query.data.filter((n) => !n.is_read).map((n) => n.id);
      if (unreadIds.length > 0) {
        markReadMutation.mutate(unreadIds);
      }
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
