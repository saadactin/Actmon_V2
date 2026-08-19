import { useQuery } from '@tanstack/react-query';
import { getSecurityPosture, getInternetExposure, getIamReview } from '../api/security.api';

export const useSecurityPosture = (accountId) => useQuery({
  queryKey: ['securityPosture', accountId],
  queryFn: () => (accountId ? getSecurityPosture(accountId) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 30_000,
});

export const useInternetExposure = (accountId) => useQuery({
  queryKey: ['internetExposure', accountId],
  queryFn: () => (accountId ? getInternetExposure(accountId) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 30_000,
});

export const useIamReview = (accountId) => useQuery({
  queryKey: ['iamReview', accountId],
  queryFn: () => (accountId ? getIamReview(accountId) : Promise.resolve(null)),
  enabled: !!accountId,
  staleTime: 30_000,
});
