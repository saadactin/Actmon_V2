import { cloudAxios } from './axios';
import { CloudAccount, CloudAccountCreatePayload } from '../types/cloud';

export const getCloudAccounts = async (): Promise<CloudAccount[]> => {
  const { data } = await cloudAxios.get('/accounts');
  return data;
};

export const createCloudAccount = async (payload: CloudAccountCreatePayload): Promise<CloudAccount> => {
  const { data } = await cloudAxios.post('/accounts', payload);
  return data;
};

export const deleteCloudAccount = async (accountId: string): Promise<void> => {
  await cloudAxios.delete(`/accounts/${accountId}`);
};
