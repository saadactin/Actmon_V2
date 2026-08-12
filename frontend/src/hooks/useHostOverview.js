import { useMemo } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAgentUpdateStatus, getHostOverview, getPipelineStatus, getServiceState,
} from '@/api/agents';

/** Live at the agent's own cadence — the ring advances every 15s. */
const REFRESH_MS = 15_000;

/**
 * Everything this agent knows about ITSELF.
 *
 * Three calls, because the agent's own state is spread across three endpoints:
 *   host-overview   telemetry flow, delivery, transport, events
 *   service-state   is the ActMon service actually running on the host
 *   update-status   version / upgrade ledger for this agent
 *
 * The `host` block that host-overview also returns is deliberately ignored — host
 * OS detail belongs to Infrastructure, not to agent self-monitoring.
 */
export default function useHostOverview(name, { hasConnection = false } = {}) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['agents', 'host-overview', name],
    queryFn: () => getHostOverview(name),
    refetchInterval: REFRESH_MS,
    retry: false,
    enabled: Boolean(name),
  });

  const [serviceQ, updateQ, pipelineQ] = useQueries({
    queries: [
      {
        queryKey: ['agents', 'service-state', name],
        queryFn: () => getServiceState(name),
        refetchInterval: 30_000,
        retry: false,
        enabled: Boolean(name),
      },
      {
        queryKey: ['agents', 'update-status', name],
        queryFn: () => getAgentUpdateStatus(name),
        refetchInterval: 60_000,
        retry: false,
        enabled: Boolean(name),
      },
      {
        // Server-wide, not per-agent — the tiers are shared infrastructure.
        queryKey: ['metrics', 'pipeline-status'],
        queryFn: getPipelineStatus,
        refetchInterval: 60_000,
        retry: false,
      },
    ],
  });

  const derived = useMemo(() => {
    const d = query.data || {};
    const agent = d.agent || {};
    const telemetry = d.telemetry || {};
    const comm = telemetry.comm || {};
    const online = agent.status === 'online';

    /* ── telemetry series ───────────────────────────────────────────────────
       The ring arrives newest-first, so it's reversed into chronological order. */
    const ring = Array.isArray(telemetry.ring) ? telemetry.ring : [];
    const series = ring.slice().reverse().map((s) => {
      const at = new Date((s.ts || 0) * 1000);
      const label = Number.isFinite(at.getTime())
        ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : '';
      return {
        label,
        cpu: Number(s.host_cpu || 0),
        memory: Number(s.host_memory || 0),
        disk: Number(s.host_disk || 0),
        qps: Number(s.qps || 0),
        sessions: Number(s.active_sessions || 0),
      };
    });
    const seriesFor = (key) => series.map((s) => ({ label: s.label, value: s[key] }));

    /* ── packet delivery ────────────────────────────────────────────────────
       The API returns delivery_pct 100 when expected_samples is 0, which reads as
       "perfect" for an agent that has delivered nothing at all. Treat a zero
       expectation as unknown instead — a fresh agent has no delivery record yet. */
    const expected = Number(comm.expected_samples) || 0;
    const received = Number(telemetry.live_samples_1h) || 0;
    const deliveryKnown = expected > 0;
    const deliveryPct = deliveryKnown ? Number(comm.delivery_pct ?? 0) : null;
    const deliveryTone = !deliveryKnown ? 'neutral'
      : deliveryPct >= 95 ? 'good'
        : deliveryPct >= 80 ? 'warning'
          : 'critical';

    /* ── the telemetry pipeline, stage by stage ─────────────────────────────
       Each hop is reported from the source that actually knows it, so "no charts"
       resolves to a named stage instead of a blank panel.

       NOTE: host-overview's `telemetry.transport.redis` is NOT a health check —
       the backend sets it to `bool(ring)`, so it reports "Redis down" for any
       empty ring. The tier states come from /metrics/pipeline/status instead. */
    const pipe = pipelineQ.data || null;
    const redisUp = pipe ? Boolean(pipe.redis) : null;
    const chUp = pipe ? Boolean(pipe.clickhouse) : Boolean(telemetry.clickhouse);

    /* Host agents DO feed the metrics pipeline: svc_ingest_agent_infra() ends with
       `db.add(AgentMetric(...host_cpu, host_memory))`, and an after_insert hook on
       AgentMetric calls metrics_pipeline.record(). So a host agent produces a real
       sample on every infra push — the tiers are the only thing that can break. */

    const pipeline = [
      {
        id: 'agent',
        label: 'Agent → API',
        ok: online,
        detail: online
          ? `Heartbeat ${comm.last_sample_age_s !== null && comm.last_sample_age_s !== undefined
            ? `${Math.round(comm.last_sample_age_s)}s ago` : 'received'}`
          : 'The agent is not reporting',
      },
      {
        id: 'pipeline',
        label: 'Metrics pipeline',
        ok: pipe ? Boolean(pipe.enabled) : true,
        detail: !pipe ? 'Checking…'
          : pipe.enabled
            ? 'Each infra push records a metric sample'
            : 'Disabled by METRICS_PIPELINE_ENABLED',
      },
      {
        id: 'redis',
        label: 'Redis hot ring',
        ok: redisUp !== false,
        detail: redisUp === null ? 'Checking…'
          : redisUp
            ? `Connected · ${ring.length} samples for this agent`
            : 'Not reachable — samples are dropped here',
      },
      {
        /* ClickHouse is only fed by samples DISPLACED out of Redis (see
           metrics_pipeline.record: store_sample returns the previous latest, which
           is then queued for CH). With Redis down nothing is displaced, so history
           cannot accumulate even though ClickHouse itself is healthy — say that,
           rather than reporting a green tier that is receiving nothing. */
        id: 'clickhouse',
        label: 'ClickHouse history',
        ok: chUp && redisUp !== false,
        detail: !chUp ? 'Not reachable — history is not being retained'
          : redisUp === false
            ? 'Reachable, but fed only by samples leaving Redis — nothing is arriving'
            : telemetry.clickhouse
              ? `${telemetry.clickhouse.rows_24h ?? 0} rows in 24h`
              : 'Connected · no rows stored for this agent yet',
      },
    ];

    // Only genuine faults count as "broken" — an expected note does not.
    const brokenStage = pipeline.find((s) => !s.ok) || null;

    return {
      agent,
      telemetry,
      comm,
      /* Deliberately NOT exposing telemetry.transport — its `redis` field is
         `bool(ring)`, not a health check. Use `redisUp` / `pipelineStatus`. */
      events: Array.isArray(d.events) ? d.events : [],
      online,

      series,
      seriesFor,
      hasSeries: series.length > 0,
      ringSize: ring.length,

      delivery: {
        known: deliveryKnown,
        pct: deliveryPct,
        tone: deliveryTone,
        received,
        expected,
      },

      pipeline,
      brokenStage,
      pipelineStatus: pipe,
      redisUp,
      /**
       * Every Delivery KPI is computed by the backend from the ring
       * (_comm_stats(agent, ring, …)), so an empty ring means those figures are
       * blank too — worth saying, or eight dashes look like a broken page.
       */
      deliveryFromRing: ring.length === 0,
      /**
       * Why there is no chartable series, in plain words. Null when there is one.
       * Ordered by what the reader can act on first.
       */
      noSeriesReason: series.length > 0 ? null
        : pipe && !pipe.enabled
          ? {
            title: 'The metrics pipeline is switched off',
            body: 'METRICS_PIPELINE_ENABLED is false on the server, so samples are not stored in '
              + 'either tier. The agent is still delivering — only the storage is disabled.',
            tone: 'warning',
          }
          : redisUp === false
            ? {
              title: 'Redis is not reachable',
              body: `${agent.name || 'This agent'} is delivering samples — every infra push records one — `
                + 'but the hot ring is where they land, and Redis is down. ClickHouse is only fed by '
                + 'samples displaced out of Redis, so history is not accumulating either. Bring Redis '
                + 'back up and both the live charts and the stored history start filling on the next push.',
              tone: 'warning',
            }
            : {
              title: 'No samples in the last hour',
              body: 'Both tiers are healthy, but no sample has arrived from this agent recently. '
                + 'Check that the agent service is running and its pushes are reaching the API.',
              tone: 'warning',
            },

      /** Is the ActMon service actually up on the host? */
      service: serviceQ.data || null,
      serviceLoading: serviceQ.isLoading,
      /** Upgrade ledger for this agent. */
      update: updateQ.data || null,
    };
  }, [query.data, serviceQ.data, serviceQ.isLoading, updateQ.data, pipelineQ.data, hasConnection]);

  return {
    ...derived,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    notFound: query.error?.status === 404,
    /** Refreshes this agent's feeds plus the shared pipeline status. */
    refresh: () => {
      for (const key of ['host-overview', 'service-state', 'update-status']) {
        qc.invalidateQueries({ queryKey: ['agents', key, name] });
      }
      qc.invalidateQueries({ queryKey: ['metrics', 'pipeline-status'] });
    },
  };
}
