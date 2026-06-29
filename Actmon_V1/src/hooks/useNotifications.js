export const useNotifications = (limit = 50) => {
  return {
    notifications: [],
    isLoading: false,
    isError: false,
    unreadCount: 0,
    markRead: () => {},
    markAllRead: () => {},
    isPending: false,
  };
};

