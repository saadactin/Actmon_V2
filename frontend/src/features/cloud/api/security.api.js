import { cloudAxios } from './axios';

// NOTE: `getSecurityPosture` (GET /security/{id}) was removed. That endpoint is
// the older scoring engine and it does not agree with the Security Center on
// the same account. Posture is read from /security-center/{id} only — see
// api/overview.api.js. The two endpoints below are different data (exposure
// evaluation and IAM review), not a second opinion on the score.

export const getInternetExposure = async (accountId) => {
  const { data } = await cloudAxios.get(`/security/${accountId}/exposure`);
  return data;
};

export const getIamReview = async (accountId) => {
  const { data } = await cloudAxios.get(`/security/${accountId}/iam-review`);
  return data;
};
