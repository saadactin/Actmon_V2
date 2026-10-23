import { cloudAxios } from './axios';

/**
 * The account report builder: preview, generate, templates, history and
 * schedules. Preview and generate take the exact same request shape — scope,
 * sections, date_range, layout — so a preview and the file it describes can
 * never disagree about what was asked for.
 */

/** Hand a Blob response to the browser as a download. */
function saveBlob(response, fallbackName) {
  const disposition = response.headers?.['content-disposition'] || '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match ? match[1] : fallbackName;
  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return filename;
}

/** A capped, no-file-bytes look at what `generateReport` would produce. */
export const previewReport = async (request) => {
  const { data } = await cloudAxios.post('/reports/preview', request);
  return data;
};

/**
 * Build the file and trigger the browser download. Returns the filename the
 * server chose, how many resources it covered, and the history id it was kept
 * under (null when `keep` was false).
 */
export const generateReport = async (request) => {
  const response = await cloudAxios.post('/reports/generate', request, {
    responseType: 'blob',
  });
  const filename = saveBlob(response, `resource-assessment.${request.layout?.format || 'csv'}`);
  return {
    filename,
    resourcesResolved: Number(response.headers?.['x-resources-resolved']) || null,
    reportId: response.headers?.['x-report-id'] || null,
  };
};

// ── Templates ────────────────────────────────────────────────────────────────

export const listReportTemplates = async () => {
  const { data } = await cloudAxios.get('/reports/templates');
  return data;
};

/** Create (no id) or replace (id) a saved template. */
export const saveReportTemplate = async (template, id = null) => {
  const { data } = id
    ? await cloudAxios.put(`/reports/templates/${id}`, template)
    : await cloudAxios.post('/reports/templates', template);
  return data;
};

export const deleteReportTemplate = async (id) => {
  const { data } = await cloudAxios.delete(`/reports/templates/${id}`);
  return data;
};

// ── History ──────────────────────────────────────────────────────────────────

export const listReportHistory = async (accountId, limit = 50) => {
  const { data } = await cloudAxios.get(`/reports/history/${accountId}`, { params: { limit } });
  return data;
};

export const downloadHistoryReport = async (accountId, reportId, fallbackName = 'report') => {
  const response = await cloudAxios.get(`/reports/history/${accountId}/${reportId}/download`, {
    responseType: 'blob',
  });
  return saveBlob(response, fallbackName);
};

export const deleteHistoryReport = async (accountId, reportId) => {
  const { data } = await cloudAxios.delete(`/reports/history/${accountId}/${reportId}`);
  return data;
};

// ── Schedules ────────────────────────────────────────────────────────────────

export const listReportSchedules = async (accountId) => {
  const { data } = await cloudAxios.get(`/reports/schedules/${accountId}`);
  return data;
};

/** Create (no id) or replace (id) a schedule on one account. */
export const saveReportSchedule = async (accountId, schedule, id = null) => {
  const { data } = id
    ? await cloudAxios.put(`/reports/schedules/${accountId}/${id}`, schedule)
    : await cloudAxios.post(`/reports/schedules/${accountId}`, schedule);
  return data;
};

export const deleteReportSchedule = async (accountId, id) => {
  const { data } = await cloudAxios.delete(`/reports/schedules/${accountId}/${id}`);
  return data;
};

/** Produce a schedule's report now, into history; e-mail it only when `send`. */
export const runReportSchedule = async (accountId, id, { send = false } = {}) => {
  const { data } = await cloudAxios.post(`/reports/schedules/${accountId}/${id}/run`, null, {
    params: { send },
  });
  return data;
};
