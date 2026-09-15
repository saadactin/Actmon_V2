/**
 * Purge WAL Archive — react-query hooks. Local `base(connId)` + `client`
 * directly, same pattern PatroniPanel.jsx already uses rather than a new
 * `src/api/*.js` file.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';

const base = (connId) => `/connections/postgresql/${connId}/wal-purge`;

export function useWalArchiveInfo(connId, enabled = true) {
  return useQuery({
    queryKey: ['walPurgeInfo', connId],
    queryFn: () => client.get(`${base(connId)}/info`).then((r) => r.data),
    enabled: enabled && !!connId,
    staleTime: 15000,
  });
}

export function useWalPurgeSafety(connId, enabled = true) {
  return useQuery({
    queryKey: ['walPurgeSafety', connId],
    queryFn: () => client.get(`${base(connId)}/safety`).then((r) => r.data.safety),
    enabled: enabled && !!connId,
    refetchInterval: 30000,
  });
}

export function useWalPurgeConfig(connId, enabled = true) {
  return useQuery({
    queryKey: ['walPurgeConfig', connId],
    queryFn: () => client.get(`${base(connId)}/config`).then((r) => r.data.config),
    enabled: enabled && !!connId,
  });
}

export function useWalPurgeHistory(connId, { limit = 20, offset = 0 } = {}, enabled = true) {
  return useQuery({
    queryKey: ['walPurgeHistory', connId, limit, offset],
    queryFn: () => client.get(`${base(connId)}/history`, { params: { limit, offset } }).then((r) => r.data),
    enabled: enabled && !!connId,
  });
}

function invalidateAll(qc, connId) {
  qc.invalidateQueries({ queryKey: ['walPurgeInfo', connId] });
  qc.invalidateQueries({ queryKey: ['walPurgeSafety', connId] });
  qc.invalidateQueries({ queryKey: ['walPurgeConfig', connId] });
  qc.invalidateQueries({ queryKey: ['walPurgeHistory', connId] });
}

export function useSaveWalPurgeConfig(connId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => client.put(`${base(connId)}/config`, body).then((r) => r.data),
    onSuccess: () => invalidateAll(qc, connId),
  });
}

export function usePreviewWalPurge(connId) {
  return useMutation({
    mutationFn: () => client.post(`${base(connId)}/preview`).then((r) => r.data),
  });
}

// Test/Execute dispatch a real agent job that can legitimately run for
// minutes (pg_archivecleanup over a large archive) — the backend itself
// allows up to 300s/900s for these (see _TEST_TIMEOUT_SECONDS /
// _EXECUTE_TIMEOUT_SECONDS), well past the app's normal 30s default. Without
// a matching override here, the BROWSER gave up and showed "took too long to
// respond" while the real purge kept running server-side regardless —
// alarming and misleading, since the operation hadn't actually failed.
const TEST_TIMEOUT_MS = 320_000;
const EXECUTE_TIMEOUT_MS = 920_000;

export function useTestWalPurge(connId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.post(`${base(connId)}/test`, undefined, { timeout: TEST_TIMEOUT_MS }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['walPurgeHistory', connId] }),
  });
}

// Execute now returns almost immediately ({status:'accepted', run_id}) — the
// actual purge runs in a background thread on the backend, reporting real
// chunk-by-chunk progress a run_id poll picks up (see useWalPurgeRunStatus),
// rather than one request held open for the whole operation. The generous
// timeout here is now just a safety margin for the initial dispatch itself.
export function useExecuteWalPurge(connId) {
  return useMutation({
    mutationFn: (body) => client.post(`${base(connId)}/execute`, body, { timeout: EXECUTE_TIMEOUT_MS }).then((r) => r.data),
  });
}

/** Polls one purge run's live status — real "files done so far" progress
 * while it's still running, then its final result once it finishes. Stops
 * polling itself (returns `false`) the moment the run leaves the 'running'
 * state — a pure decision only, so react-query can call it as often as it
 * likes; the CALLER reacts to the finished status via a plain effect on
 * this hook's returned `data`, not from inside this function. */
export function useWalPurgeRunStatus(connId, runId) {
  return useQuery({
    queryKey: ['walPurgeRun', connId, runId],
    queryFn: () => client.get(`${base(connId)}/runs/${runId}`).then((r) => r.data),
    enabled: !!connId && !!runId,
    refetchInterval: (query) => (query.state.data?.run_status === 'running' ? 1200 : false),
  });
}

export function invalidateWalPurge(qc, connId) {
  invalidateAll(qc, connId);
}

export function useScheduleWalPurge(connId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => client.post(`${base(connId)}/schedule`, body).then((r) => r.data),
    onSuccess: () => invalidateAll(qc, connId),
  });
}

export function useDisableWalPurgeSchedule(connId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.post(`${base(connId)}/disable`).then((r) => r.data),
    onSuccess: () => invalidateAll(qc, connId),
  });
}
