import {
  keepPreviousData, useMutation, useQuery, useQueryClient,
} from '@tanstack/react-query';
import {
  deleteHistoryReport, deleteReportSchedule, deleteReportTemplate, generateReport,
  listReportHistory, listReportSchedules, listReportTemplates, previewReport,
  runReportSchedule, saveReportSchedule, saveReportTemplate,
} from '../api/reports.api';

/**
 * Every key here starts with 'cloudReports' — one root, listed in
 * refreshModel.REFRESHED_ROOTS, so an account refresh re-reads the preview and
 * the history alike.
 */
const ROOT = ['cloudReports'];

export const reportKeys = {
  preview: (request) => [...ROOT, 'preview', request],
  templates: () => [...ROOT, 'templates'],
  history: (accountId) => [...ROOT, 'history', accountId],
  schedules: (accountId) => [...ROOT, 'schedules', accountId],
};

/**
 * A preview is a read — it builds the same dataset `generateReport` would,
 * just capped, so it is a query rather than a mutation (same reasoning as
 * `useActionPreview`). `enabled` guards against firing before an account and
 * a scope are both chosen; `keepPreviousData` keeps the last preview on
 * screen while a later keystroke's refetch is in flight, rather than
 * blanking the step on every section toggle.
 */
export const useReportPreview = (request, options = {}) => useQuery({
  queryKey: reportKeys.preview(request),
  queryFn: () => previewReport(request),
  enabled: !!request?.account_id && (options.enabled ?? true),
  placeholderData: keepPreviousData,
  staleTime: 5_000,
});

/** Generating keeps a copy in history, so the history list is now stale. */
export const useGenerateReport = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (request) => generateReport(request),
    onSuccess: (_r, request) => qc.invalidateQueries({ queryKey: reportKeys.history(request.account_id) }),
  });
};

export const useReportTemplates = () => useQuery({
  queryKey: reportKeys.templates(),
  queryFn: listReportTemplates,
  staleTime: 60_000,
});

export const useSaveReportTemplate = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ template, id }) => saveReportTemplate(template, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: reportKeys.templates() }),
  });
};

export const useDeleteReportTemplate = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => deleteReportTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: reportKeys.templates() }),
  });
};

export const useReportHistory = (accountId) => useQuery({
  queryKey: reportKeys.history(accountId),
  queryFn: () => listReportHistory(accountId),
  enabled: !!accountId,
});

export const useDeleteHistoryReport = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reportId) => deleteHistoryReport(accountId, reportId),
    onSuccess: () => qc.invalidateQueries({ queryKey: reportKeys.history(accountId) }),
  });
};

export const useReportSchedules = (accountId) => useQuery({
  queryKey: reportKeys.schedules(accountId),
  queryFn: () => listReportSchedules(accountId),
  enabled: !!accountId,
});

export const useSaveReportSchedule = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ schedule, id }) => saveReportSchedule(accountId, schedule, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: reportKeys.schedules(accountId) }),
  });
};

export const useDeleteReportSchedule = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => deleteReportSchedule(accountId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: reportKeys.schedules(accountId) }),
  });
};

/** Running a schedule by hand writes a history row (and maybe an e-mail). */
export const useRunReportSchedule = (accountId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, send }) => runReportSchedule(accountId, id, { send }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: reportKeys.history(accountId) });
      qc.invalidateQueries({ queryKey: reportKeys.schedules(accountId) });
    },
  });
};
