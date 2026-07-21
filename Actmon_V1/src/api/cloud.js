import client, { ensureArray } from './client';
export const listAccounts = async () => {
  const response = await client.get('/cloud/accounts');
  return ensureArray(response.data);
};

export const addAccount = async (data) => {
  const response = await client.post('/cloud/accounts', data);
  return response.data;
};

export const getInventory = async (
  provider,
  accountId
) => {
  const response = await client.get(`/cloud/${provider.toLowerCase()}/${accountId}/inventory`);
  return ensureArray(response.data);
};
