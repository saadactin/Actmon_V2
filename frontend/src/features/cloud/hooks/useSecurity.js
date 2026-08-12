import { useQuery } from '@tanstack/react-query';
import { getSecurityPosture } from '../api/security.api';

export const useSecurityPosture = (accountId) => useQuery({
  queryKey: ['securityPosture', accountId],
  queryFn: () => (accountId ? getSecurityPosture(accountId) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 30_000,
});
