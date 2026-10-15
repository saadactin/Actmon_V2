import { cloudAxios } from './axios';

/**
 * The resource assessment report builder: preview (cheap, capped, JSON) and
 * generate (the real file). Both take the exact same request shape — scope,
 * sections, date_range, layout — so a preview and the file it describes can
 * never disagree about what was asked for.
 */

/** A capped, no-file-bytes look at what `generateReport` would produce. */
export const previewReport = async (request) => {
  const { data } = await cloudAxios.post('/reports/preview', request);
  return data;
};

/**
 * Build the file and trigger the browser download. Returns the filename the
 * server chose (it carries the generation timestamp) so the caller can show
 * it in a toast/history entry.
 */
export const generateReport = async (request) => {
  const response = await cloudAxios.post('/reports/generate', request, {
    responseType: 'blob',
  });

  const disposition = response.headers?.['content-disposition'] || '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match ? match[1] : `resource-assessment.${request.layout?.format || 'csv'}`;

  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return { filename, resourcesResolved: Number(response.headers?.['x-resources-resolved']) || null };
};
