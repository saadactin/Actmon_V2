import { cloudAxios } from './axios';

/**
 * Certificates, secrets and keys — metadata only, never a secret value.
 */

export const getAccountCertificates = async (accountId) => {
  const { data } = await cloudAxios.get(`/certificates/${accountId}`);
  return data;
};

/**
 * What expires across the estate. `clientId` narrows to one client's
 * accounts; `unassigned` to accounts with no client. Only params that are set
 * are sent, so the backend's own defaults apply to the rest.
 */
export const getCertificateEstate = async ({
  clientId, unassigned, withinDays, kind, includeNoExpiry,
} = {}) => {
  const params = {};
  if (clientId) params.client_id = clientId;
  if (unassigned) params.unassigned = true;
  if (withinDays !== undefined && withinDays !== null) params.within_days = withinDays;
  if (kind) params.kind = kind;
  if (includeNoExpiry) params.include_no_expiry = true;
  const { data } = await cloudAxios.get('/certificates', { params });
  return data;
};

/** Re-read every store, then re-assess. Slow on purpose: it calls every region. */
export const collectCertificates = async (accountId) => {
  const { data } = await cloudAxios.post(`/certificates/${accountId}/collect`, null, {
    timeout: 300_000,
  });
  return data;
};
