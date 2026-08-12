import client, { ensureArray } from './client';

/* ── SMTP (Email transport) — reused as-is, this is NOT a new SMTP page ── */
export const smtpApi = {
  list: () => client.get('/settings/smtp').then((r) => r.data),
  default: () => client.get('/settings/smtp/default').then((r) => r.data),
  create: (data) => client.post('/settings/smtp', data).then((r) => r.data),
  update: (id, data) => client.put(`/settings/smtp/${id}`, data).then((r) => r.data),
  remove: (id) => client.delete(`/settings/smtp/${id}`).then((r) => r.data),
  test: (id) => client.post(`/settings/smtp/${id}/test`).then((r) => r.data),
  testInline: (data) => client.post('/settings/smtp/test-inline', data).then((r) => r.data),
};

/* ── Notification channels (the 9 providers) ── */
export const listChannels = (orgId = 1) => client
  .get('/notifications/channels', { params: { org_id: orgId } })
  .then((r) => ensureArray(r.data?.channels));

export const getChannel = (channelType, orgId = 1) => client
  .get(`/notifications/channels/${channelType}`, { params: { org_id: orgId } })
  .then((r) => r.data?.channel);

export const saveChannel = (channelType, payload, orgId = 1) => client
  .put(`/notifications/channels/${channelType}`, payload, { params: { org_id: orgId } })
  .then((r) => r.data?.channel);

export const testChannel = (channelType, orgId = 1) => client
  .post(`/notifications/channels/${channelType}/test`, {}, { params: { org_id: orgId } })
  .then((r) => r.data);

export const sendTestNotification = (channelType, payload = {}, orgId = 1) => client
  .post(`/notifications/channels/${channelType}/test-notification`, payload, { params: { org_id: orgId } })
  .then((r) => r.data);

/* ── Severity-based default routing ── */
export const getSeverityRouting = (orgId = 1) => client
  .get('/notifications/severity-routing', { params: { org_id: orgId } })
  .then((r) => r.data?.routing || {});

export const setSeverityRouting = (severity, channelTypes, orgId = 1) => client
  .put('/notifications/severity-routing', { severity, channel_types: channelTypes }, { params: { org_id: orgId } })
  .then((r) => r.data);

/* ── Delivery history ── */
export const listNotificationHistory = (filters = {}) => client
  .get('/notifications/history', { params: filters })
  .then((r) => ensureArray(r.data?.history));

/* ── Notification templates (per-channel subject/body override) ── */
export const listTemplates = (orgId = 1) => client
  .get('/notifications/templates', { params: { org_id: orgId } })
  .then((r) => ensureArray(r.data?.templates));

export const getTemplate = (channelType, orgId = 1) => client
  .get(`/notifications/templates/${channelType}`, { params: { org_id: orgId } })
  .then((r) => r.data?.template);

export const saveTemplate = (channelType, payload, orgId = 1) => client
  .put(`/notifications/templates/${channelType}`, payload, { params: { org_id: orgId } })
  .then((r) => r.data?.template);

export const resetTemplate = (channelType, orgId = 1) => client
  .delete(`/notifications/templates/${channelType}`, { params: { org_id: orgId } })
  .then((r) => r.data?.template);

export const previewTemplate = (channelType, payload) => client
  .post(`/notifications/templates/${channelType}/preview`, payload)
  .then((r) => r.data);

/* ── Org-wide notification settings (currently: alert timestamp timezone) ── */
export const getNotificationSettings = (orgId = 1) => client
  .get('/notifications/settings', { params: { org_id: orgId } })
  .then((r) => r.data);

export const saveNotificationSettings = (payload, orgId = 1) => client
  .put('/notifications/settings', payload, { params: { org_id: orgId } })
  .then((r) => r.data);
