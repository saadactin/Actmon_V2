import { cloudAxios } from './axios';

export const getTopology = async (accountId: string): Promise<any> => {
  const { data } = await cloudAxios.get(`/topology/${accountId}`);
  return data;
};
