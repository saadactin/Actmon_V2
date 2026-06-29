import { cloudAxios } from './axios';
import { SecurityPosture } from '../types/security';

export const getSecurityPosture = async (accountId: string): Promise<SecurityPosture> => {
  const { data } = await cloudAxios.get(`/security/${accountId}`);
  return data;
};
