import { cloudAxios } from './axios';

export const getSecurityPosture = async (accountId) => {
  const { data } = await cloudAxios.get(`/security/${accountId}`);
  return data;
};
