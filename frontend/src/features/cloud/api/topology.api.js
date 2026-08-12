import { cloudAxios } from './axios';

export const getTopology = async (accountId) => {
  const { data } = await cloudAxios.get(`/topology/${accountId}`);
  return data;
};
