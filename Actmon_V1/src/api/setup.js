import client from './client';

// First-run setup — public endpoints (no auth token needed on a fresh install).
export const getSetupStatus = () =>
  client.get('/setup/status').then((r) => r.data);

export const createAdmin = (payload) =>
  client.post('/setup/admin', payload).then((r) => r.data);
