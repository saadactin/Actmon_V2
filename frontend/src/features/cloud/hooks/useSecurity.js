import { useQuery } from '@tanstack/react-query';
import { getInternetExposure, getIamReview } from '../api/security.api';

/**
 * Internet exposure and IAM review, which the Security Center's panels consume.
 *
 * `useSecurityPosture` used to live here too, reading /cloud/security/{id} — a
 * second scoring engine that disagreed with the Security Center about the same
 * account (0/F against 35/F on oci_test). It is gone, along with the page that
 * was its last caller. Posture comes from the canonical assessment only; see
 * useCloudOverview.useSecurityPosture.
 */
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
