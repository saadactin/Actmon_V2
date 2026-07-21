import { useQuery } from '@tanstack/react-query';
import { getTopology } from '../api/topology.api';

export const useTopology = (accountId: string | null) => {
  return useQuery<any>({
    queryKey: ['topology', accountId],
    queryFn: () => (accountId ? getTopology(accountId) : Promise.resolve(null)),
    enabled: !!accountId,
    staleTime: 30_000,
  });
};
