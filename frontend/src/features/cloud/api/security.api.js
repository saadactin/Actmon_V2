import { cloudAxios } from './axios';

export const getSecurityPosture = async (accountId) => {
  const { data } = await cloudAxios.get(`/security/${accountId}`);
  return data;
};

export const getInternetExposure = async (accountId) => {
  const { data } = await cloudAxios.get(`/security/${accountId}/exposure`);
  return data;
};

export const getIamReview = async (accountId) => {
  const { data } = await cloudAxios.get(`/security/${accountId}/iam-review`);
  return data;
};
