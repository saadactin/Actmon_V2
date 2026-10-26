/**
 * URLs and breadcrumbs for the Oracle service drill-down.
 *
 *   /oracle-dashboard/:id/services/:service
 *   /oracle-dashboard/:id/services/:service/instances
 *   /oracle-dashboard/:id/services/:service/instances/:inst
 *   /oracle-dashboard/:id/services/:service/instances/:inst/sessions
 *   /oracle-dashboard/:id/services/:service/instances/:inst/sessions/:sid/:serial
 *   …/sessions/:sid/:serial/sql/:sqlId      (SQL reached from a session)
 *
 * Every level is ids only — service name, INST_ID, SID + SERIAL#, SQL_ID — so
 * a page can be refreshed, bookmarked or shared and re-reads its own record.
 * The service name is URI-encoded: names carry dots ("KCPRD_KIRAN.paas…")
 * and can carry '$' or '/'.
 */

export const enc = (s) => encodeURIComponent(String(s));

export function drillPath(id, { service, inst, sid, serial, sqlId, level } = {}) {
  let p = `/oracle-dashboard/${id}/services`;
  if (service == null) return p;
  p += `/${enc(service)}`;
  if (level === 'instances' && inst == null) return `${p}/instances`;
  if (inst == null) return p;
  p += `/instances/${enc(inst)}`;
  if (level === 'sessions' && sid == null) return `${p}/sessions`;
  if (sid == null) return p;
  p += `/sessions/${enc(sid)}/${enc(serial)}`;
  if (sqlId) p += `/sql/${enc(sqlId)}`;
  return p;
}

/** The trail for a level, each crumb with the path it returns to. The last
 *  crumb is the current page (no link). `names` supplies display names the
 *  page has read (an instance's name for its INST_ID); ids are used until then. */
export function drillCrumbs(id, ctx, names = {}) {
  const { service, inst, sid, serial, sqlId, level } = ctx;
  const out = [
    { label: 'Oracle Dashboard', to: `/oracle-dashboard/${id}` },
    { label: 'Services', to: `/oracle-dashboard/${id}/services` },
  ];
  if (service != null) out.push({ label: service, to: drillPath(id, { service }) });
  if (service != null && (inst != null || level === 'instances')) {
    out.push({ label: 'Instances', to: drillPath(id, { service, level: 'instances' }) });
  }
  if (inst != null) out.push({ label: names.instance || `Instance ${inst}`, to: drillPath(id, { service, inst }) });
  if (inst != null && (sid != null || level === 'sessions')) {
    out.push({ label: 'Sessions', to: drillPath(id, { service, inst, level: 'sessions' }) });
  }
  if (sid != null) out.push({ label: `Session ${sid}`, to: drillPath(id, { service, inst, sid, serial }) });
  if (sqlId) out.push({ label: `SQL ${sqlId}`, to: drillPath(id, { service, inst, sid, serial, sqlId }) });
  out[out.length - 1] = { ...out[out.length - 1], to: null };
  return out;
}

/** Where Back goes: the previous crumb. */
export function parentPath(id, ctx) {
  const c = drillCrumbs(id, ctx);
  return c.length > 1 ? c[c.length - 2].to : `/oracle-dashboard/${id}/services`;
}
