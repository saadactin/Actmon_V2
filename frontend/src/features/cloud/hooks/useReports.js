import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { generateReport, previewReport } from '../api/reports.api';

/**
 * A preview is a read — it builds the same dataset `generateReport` would,
 * just capped, so it is a query rather than a mutation (same reasoning as
 * `useActionPreview`). `enabled` guards against firing before an account and
 * a scope are both chosen; `keepPreviousData` keeps the last preview on
 * screen while a later keystroke's refetch is in flight, rather than
 * blanking the step on every section toggle.
 */
export const useReportPreview = (request, options = {}) => useQuery({
  queryKey: ['cloudReports', 'preview', request],
  queryFn: () => previewReport(request),
  enabled: !!request?.account_id && (options.enabled ?? true),
  placeholderData: keepPreviousData,
  staleTime: 5_000,
});

export const useGenerateReport = () => useMutation({
  mutationFn: (request) => generateReport(request),
});
