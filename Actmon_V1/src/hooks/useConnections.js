import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listConnections,
  createConnection,
  deleteConnection,
  testConnection,
} from '../api/connections';

export const useConnectionsList = (dbType) => {
  return useQuery({
    queryKey: ['connections', dbType],
    queryFn: () => listConnections(dbType),
    // Disable automatic retries for MSSQL connections since they are expected to fail (500)
    retry: (failureCount, _error) => {
      if (dbType.toLowerCase() === 'mssql') return false;
      return failureCount < 3;
    },
  });
};

export const useConnectionMutations = (dbType) => {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data) => createConnection(dbType, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connections', dbType] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteConnection(dbType, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connections', dbType] });
    },
  });

  const testMutation = useMutation({
    mutationFn: (data) => testConnection(dbType, data),
  });

  return {
    createConnection: createMutation.mutateAsync,
    isCreating: createMutation.isPending,
    deleteConnection: deleteMutation.mutateAsync,
    isDeleting: deleteMutation.isPending,
    testConnection: testMutation.mutateAsync,
    isTesting: testMutation.isPending,
  };
};
