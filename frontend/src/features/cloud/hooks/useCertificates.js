import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/certificates.api';
import { getFindings } from '../api/securityCenter.api';

const ROOT = ['certificates'];

// Everything a person may still need to act on or has decided about:
// resolved findings are history, not a to-do.
const LIVE_FINDING_STATUSES = 'OPEN,IN_PROGRESS,ACCEPTED_RISK,SUPPRESSED';

/** The Security Center findings raised for ONE certificate / secret / key,
 *  matched exactly on the object's provider id. */
export const useCredentialFindings = (accountId, objectKey, enabled = true) => useQuery({
  queryKey: [...ROOT, 'findings', accountId, objectKey],
  queryFn: () => getFindings(accountId, {
    resource_key: objectKey, status: LIVE_FINDING_STATUSES, limit: 20,
  }),
  enabled: enabled && !!accountId && !!objectKey,
  staleTime: 30_000,
});

export const useAccountCertificates = (accountId) => useQuery({
  queryKey: [...ROOT, 'account', accountId],
  queryFn: () => api.getAccountCertificates(accountId),
  enabled: !!accountId,
  staleTime: 60_000,
});

export const useCertificateEstate = (filters) => useQuery({
  queryKey: [...ROOT, 'estate', filters],
  queryFn: () => api.getCertificateEstate(filters),
  staleTime: 60_000,
  placeholderData: (previous) => previous,
});

/** Collecting re-assesses the account, so every Security Center read that an
 *  assessment can change is invalidated along with the inventory. */
export const useCollectCertificates = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.collectCertificates,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ROOT });
      qc.invalidateQueries({ queryKey: ['securityCenter'] });
      qc.invalidateQueries({ queryKey: ['clients'] });
    },
  });
};
