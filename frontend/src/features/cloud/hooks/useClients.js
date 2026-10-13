import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/clients.api';

/**
 * Clients, the portfolio, onboarding and reports.
 *
 * Every write that changes which account belongs to whom invalidates the
 * account list too, because the Cloud hub and the provider pages read client
 * names off it.
 */

const ROOT = ['clients'];
const key = (...parts) => [...ROOT, ...parts];

const invalidateAll = (qc) => {
  qc.invalidateQueries({ queryKey: ROOT });
  qc.invalidateQueries({ queryKey: ['cloudAccounts'] });
};

export const usePortfolio = () => useQuery({
  queryKey: key('portfolio'),
  queryFn: api.getPortfolio,
  staleTime: 30_000,
});

export const useClientOptions = () => useQuery({
  queryKey: key('options'),
  queryFn: api.getClientOptions,
  staleTime: 60_000,
});

export const useClient = (clientId) => useQuery({
  queryKey: key('detail', clientId),
  queryFn: () => api.getClient(clientId),
  enabled: !!clientId,
  staleTime: 30_000,
});

// Not a refresh-sensitive root: see DELIBERATELY_NOT_REFRESHED's note on
// 'clients' — no provider sweep changes a maturity score, and it recomputes
// from live data on its own 60s staleTime.
export const useClientScorecard = (clientId) => useQuery({
  queryKey: key('scorecard', clientId),
  queryFn: () => api.getClientScorecard(clientId),
  enabled: !!clientId,
  staleTime: 60_000,
});

export const useCreateClient = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.createClient, onSuccess: () => invalidateAll(qc) });
};

export const useUpdateClient = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, payload }) => api.updateClient(clientId, payload),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useDeleteClient = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.deleteClient, onSuccess: () => invalidateAll(qc) });
};

export const useAssignAccounts = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, accountIds }) => api.assignAccounts(clientId, accountIds),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useUnassignAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, accountId }) => api.unassignAccount(clientId, accountId),
    onSuccess: () => invalidateAll(qc),
  });
};

export const useDiscoverOrganization = () => useMutation({ mutationFn: api.discoverOrganization });

export const useOnboardOrganization = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.onboardOrganization, onSuccess: () => invalidateAll(qc) });
};

export const useReportSchedule = (clientId) => useQuery({
  queryKey: key('schedule', clientId),
  queryFn: () => api.getReportSchedule(clientId),
  enabled: !!clientId,
});

export const useSaveReportSchedule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, schedule }) => api.saveReportSchedule(clientId, schedule),
    onSuccess: (_d, { clientId }) => {
      qc.invalidateQueries({ queryKey: key('schedule', clientId) });
      qc.invalidateQueries({ queryKey: key('portfolio') });
    },
  });
};

export const useReports = (clientId) => useQuery({
  queryKey: key('reports', clientId),
  queryFn: () => api.listReports(clientId),
  enabled: !!clientId,
});

export const useReportPreview = (clientId, period, enabled = true) => useQuery({
  queryKey: key('preview', clientId, period || 'default'),
  queryFn: () => api.previewReport(clientId, period),
  enabled: !!clientId && enabled,
  staleTime: 60_000,
  retry: false,
});

export const useGenerateReport = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, period, send }) => api.generateReport(clientId, { period, send }),
    onSuccess: (_d, { clientId }) => {
      qc.invalidateQueries({ queryKey: key('reports', clientId) });
      qc.invalidateQueries({ queryKey: key('portfolio') });
    },
  });
};

export const useSendReport = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, reportId }) => api.sendReport(clientId, reportId),
    onSuccess: (_d, { clientId }) => qc.invalidateQueries({ queryKey: key('reports', clientId) }),
  });
};
