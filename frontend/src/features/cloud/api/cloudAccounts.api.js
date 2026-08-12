import { cloudAxios } from './axios';

export const getCloudAccounts = async () => {
  const { data } = await cloudAxios.get('/accounts');
  return data;
};

export const createCloudAccount = async (payload) => {
  const { data } = await cloudAxios.post('/accounts', payload);
  return data;
};

export const deleteCloudAccount = async (accountId) => {
  await cloudAxios.delete(`/accounts/${accountId}`);
};

export const getAccountDiagnostics = async (accountId) => {
  const { data } = await cloudAxios.get(`/accounts/${accountId}/diagnostics`);
  return data;
};
