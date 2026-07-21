import client from './client';

// Register a client organization (full onboarding fields). Returns { org_id, ... }.
export const registerOrganization = async (org) => {
  const res = await client.post('/onboarding/register-org', org);
  return res.data;
};

// Build a per-client installer .zip (app build + deploy manifest + install scripts).
export const buildInstaller = async (config) => {
  const res = await client.post('/onboarding/build', config, { responseType: 'blob' });
  return res.data; // Blob (application/zip)
};

export const triggerDownload = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};
