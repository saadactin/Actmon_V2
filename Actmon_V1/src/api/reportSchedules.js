import client from './client';

/** Every report schedule across every engine, with its enabled state. */
export const listReportSchedules = async () => {
  const res = await client.get('/report-schedules');
  return res.data;
};

/** Enable or disable one schedule. Disabling preserves the configuration —
 *  the scheduler simply skips it from its next 60s tick. */
export const toggleReportSchedule = async (engine, id, enabled) => {
  const res = await client.patch(`/report-schedules/${engine}/${id}`, { enabled });
  return res.data;
};

export const deleteReportSchedule = async (engine, id) => {
  const res = await client.delete(`/report-schedules/${engine}/${id}`);
  return res.data;
};

/** Emergency stop — disables every schedule at once. Nothing is deleted. */
export const disableAllReportSchedules = async () => {
  const res = await client.post('/report-schedules/disable-all');
  return res.data;
};
