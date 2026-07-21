import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSecurityPosture } from '../api/security.api';
import { SecurityPosture } from '../types/security';

export const useSecurityPosture = (accountId: string | null) => {
  return useQuery<SecurityPosture | null>({
    queryKey: ['securityPosture', accountId],
    queryFn: () => (accountId ? getSecurityPosture(accountId) : Promise.resolve(null)),
    enabled: !!accountId,
    staleTime: 30_000,
  });
};
