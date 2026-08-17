import { useMemo } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import {
  getServerSummary, listActiveAlerts, listAgents, listCloudAccounts, listOsServers,
} from '@/api/dashboard';
import { QK } from '@/api/queryKeys';
import { severityOf, STATUS, statusOf } from '@/components/charts/status';

/** Database engines we roll hosts up by, in a fixed display order. */
export const DB_TECHS = [
  { id: 'mysql', label: 'MySQL', route: '/mysql-servers' },
  { id: 'postgresql', label: 'PostgreSQL', route: '/postgresql-servers' },
  { id: 'oracle', label: 'Oracle', route: '/oracle-servers' },
  { id: 'mssql', label: 'SQL Server', route: '/mssql-servers' },
  { id: 'mongodb', label: 'MongoDB', route: '/mongodb-servers' },
  { id: 'clickhouse', label: 'ClickHouse', route: '/clickhouse-servers' },
];

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const mean = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

/** MariaDB reports under the MySQL bucket, as it does everywhere else in the app. */
function hostRunsTech(host, techId) {
  const services = (host.database_services || []).map((s) => String(s).toLowerCase());
  if (techId === 'mysql') return services.some((s) => s === 'mysql' || s === 'mariadb');
  return services.includes(techId);
}

/** Split a host list into the fixed status buckets, keyed off an arbitrary field getter. */
function tallyBy(hosts, getStatus) {
  const out = { total: hosts.length, good: 0, warning: 0, critical: 0, unknown: 0 };
  for (const h of hosts) out[statusOf(getStatus(h)).id] += 1;
  return out;
}

/** Split a host list into the fixed status buckets by host/machine connectivity. */
function tally(hosts) {
  return tallyBy(hosts, (h) => h.status);
}

/** A host's own db_instances entry for one engine — MariaDB reports under MySQL. */
function instanceFor(host, techId) {
  const list = host.db_instances || [];
  const matches = (dbType) => {
    const t = String(dbType || '').toLowerCase();
    return techId === 'mysql' ? (t === 'mysql' || t === 'mariadb') : t === techId;
  };
  return list.find((i) => matches(i.db_type));
}

const REFRESH = { servers: 60_000, summary: 30_000, agents: 30_000, alerts: 15_000, cloud: 60_000 };

/** How many hosts the "busiest by CPU" card ranks. */
export const TOP_CPU_HOSTS = 5;

/**
 * Every dashboard feed in one hook.
 *
 * Uses useQueries so the five requests fire together and share one loading and
 * one error surface. `retry: false` because a 401 (not logged in yet) or a
 * missing microservice should show an empty state immediately rather than spend
 * 30s retrying.
 */
export default function useDashboardData() {
  const qc = useQueryClient();

  const results = useQueries({
    queries: [
      // Shared keys with InfraPage/DatabaseServersPage/AddOsServerPage/useAgents
      // (see api/queryKeys.js) — one cache entry per endpoint instead of each
      // page refetching the same list on every navigation.
      { queryKey: QK.osServers(), queryFn: listOsServers, refetchInterval: REFRESH.servers, retry: false },
      { queryKey: QK.osServersSummary, queryFn: getServerSummary, refetchInterval: REFRESH.summary, retry: false },
      { queryKey: QK.agents, queryFn: listAgents, refetchInterval: REFRESH.agents, retry: false },
      { queryKey: ['dash', 'alerts'], queryFn: listActiveAlerts, refetchInterval: REFRESH.alerts, retry: false },
      { queryKey: ['dash', 'cloud'], queryFn: listCloudAccounts, refetchInterval: REFRESH.cloud, retry: false },
    ],
  });

  const [serversQ, summaryQ, agentsQ, alertsQ, cloudQ] = results;

  // Array.isArray, not just `|| []`: the ['os-servers'] query-cache entry is
  // shared with pages that (previously) wrote the raw {status,data:[...]}
  // wrapper instead of an unwrapped array — a truthy object slipped past a
  // plain `|| []` guard and threw "hosts is not iterable" one line later in
  // tallyBy(). The root cause (two listOsServers() with different unwrap
  // conventions racing for the same cache key) is fixed at the source in
  // api/servers.js now, but this stays as a cheap defensive guard.
  const hosts = Array.isArray(serversQ.data) ? serversQ.data : [];
  const alerts = alertsQ.data || [];
  const cloud = cloudQ.data || [];
  const summary = summaryQ.data || {};

  // Split by domain, each with its OWN dependency array, rather than one big
  // memo keyed on all 5 query results together. Alerts refetch every 15s —
  // 2-4x more often than servers/summary/agents/cloud (30-60s) — and every
  // React Query refetch returns a new array reference even when the data is
  // byte-for-byte identical. With one shared memo, an alerts-only refetch used
  // to recompute (and, since ChartCard/StatTile read these values straight
  // through, re-render) infra/resources/topCpu/perTech too, even though none
  // of them actually changed. Now an alerts refetch only touches `alertData`.
  const hostDerived = useMemo(() => {
    /* ── infrastructure ── */
    const local = tally(hosts);
    // The summary endpoint is authoritative when present; the host list is the
    // fallback so the tiles still populate if only one of the two answers.
    const infra = {
      total: summary.total ?? local.total,
      good: summary.connected ?? local.good,
      warning: summary.warning ?? local.warning,
      critical: summary.disconnected ?? (local.critical + local.unknown),
    };
    infra.health = infra.total ? Math.round((infra.good / infra.total) * 100) : 0;

    /* ── databases, per engine ──
       Bucketed by the ENGINE's own db_instances[].status ("Running"/"Stopped"),
       not the host's connectivity status — a host stays reachable even after its
       MySQL service is stopped, so tallying by host.status never reflected that
       the service itself went down. */
    const perTech = DB_TECHS.map((tech) => ({
      ...tech,
      ...tallyBy(
        hosts.filter((h) => hostRunsTech(h, tech.id)),
        (h) => instanceFor(h, tech.id)?.status,
      ),
    }));
    const dbHosts = hosts.filter((h) => DB_TECHS.some((t) => hostRunsTech(h, t.id)));
    // db_status is the host's own worst/blended instance status (backend's
    // _db_status_summary: Running / Degraded / Stopped / Unknown) — the same
    // "is the database service actually up" signal, just rolled up per host
    // instead of per engine.
    const databases = tallyBy(dbHosts, (h) => h.db_status);

    /* ── resource averages (hosts that actually reported) ── */
    const resources = {
      cpu: mean(hosts.map((h) => num(h.cpu_usage)).filter((v) => v > 0)),
      ram: mean(hosts.map((h) => num(h.ram_usage)).filter((v) => v > 0)),
      disk: mean(hosts.map((h) => num(h.disk_usage)).filter((v) => v > 0)),
      reporting: hosts.filter((h) => num(h.cpu_usage) > 0).length,
    };

    /* ── busiest hosts by CPU ──
       The OS rides along in the label itself (rather than a new column) since
       the side-legend that renders this list is the same shared PieChart used
       by charts with no host/OS concept at all — folding it into the text is
       the only change that doesn't leak a host-specific field into that
       generic component.
       Offline hosts are excluded outright: their cpu_usage is whatever was
       last reported before they stopped reporting — frozen, not live — so it
       has no business being ranked against hosts that are actually reporting
       right now. Warning hosts stay in; a warning is still a live reading. */
    const topCpu = hosts
      .filter((h) => { const s = statusOf(h.status); return s === STATUS.good || s === STATUS.warning; })
      .map((h) => {
        const name = h.server_name || h.ip_address || '—';
        return {
          key: String(h.server_id ?? h.id ?? h.server_name ?? h.ip_address),
          label: h.os_type ? `${name} · ${h.os_type}` : name,
          value: num(h.cpu_usage),
          sub: h.ip_address && h.server_name ? h.ip_address : undefined,
        };
      })
      .filter((h) => h.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, TOP_CPU_HOSTS);

    /* ── distribution: host environments/OS ── */
    const environments = {};
    for (const h of hosts) {
      const key = h.environment || 'Unspecified';
      environments[key] = (environments[key] || 0) + 1;
    }
    const osTypes = {};
    for (const h of hosts) {
      const key = h.os_type || 'Unspecified';
      osTypes[key] = (osTypes[key] || 0) + 1;
    }
    const toList = (map) => Object.entries(map)
      .map(([label, value]) => ({ key: label, label, value }))
      .sort((a, b) => b.value - a.value);

    return {
      infra, databases, perTech, resources, topCpu,
      byEnvironment: toList(environments),
      byOsType: toList(osTypes),
    };
  }, [hosts, summary]);

  // "Agents" means an actual installed host-agent process, not every saved DB
  // connection — the /agents/ endpoint has one row per connection regardless of
  // how it's collected, so an org monitoring 6 hosts over SSH plus 1 real agent
  // install showed "13 agents" instead of the 1 that's real. The real signal is
  // os_servers.collector, already fetched as part of `hosts`.
  const agentDerived = useMemo(() => tally(hosts.filter((h) => h.collector === 'agent')), [hosts]);
  const sshDerived = useMemo(() => tally(hosts.filter((h) => h.collector === 'ssh')), [hosts]);

  const alertDerived = useMemo(() => {
    const bySeverity = { critical: 0, warning: 0, info: 0 };
    for (const a of alerts) bySeverity[severityOf(a.severity).id] += 1;

    // Newest first, kept whole: the overview's alert feed scrolls and filters by
    // severity, so it needs every firing alert rather than a top slice. `recent`
    // stays for callers that only want the first few.
    const sortedAlerts = [...alerts]
      .sort((a, b) => new Date(b.timestamp || b.created_at || 0) - new Date(a.timestamp || a.created_at || 0));
    const recentAlerts = sortedAlerts.slice(0, 8);

    return { total: alerts.length, ...bySeverity, recent: recentAlerts, list: sortedAlerts };
  }, [alerts]);

  const cloudDerived = useMemo(() => {
    const providers = {};
    for (const acct of cloud) {
      const key = String(acct.provider || acct.cloud_provider || 'Other').toUpperCase();
      providers[key] = (providers[key] || 0) + 1;
    }
    const toList = (map) => Object.entries(map)
      .map(([label, value]) => ({ key: label, label, value }))
      .sort((a, b) => b.value - a.value);
    return { total: cloud.length, byProvider: toList(providers) };
  }, [cloud]);

  const derived = {
    ...hostDerived,
    agents: agentDerived,
    ssh: sshDerived,
    alerts: alertDerived,
    cloud: cloudDerived,
  };

  /* ── one error surface: only report failures that leave the page empty ── */
  const errors = results.filter((r) => r.isError).map((r) => r.error);
  const offline = errors.some((e) => e?.offline);
  const unauthorised = errors.some((e) => e?.status === 401 || e?.status === 403);

  return {
    ...derived,
    /** true only on the very first load — refetches keep the previous render. */
    isLoading: results.some((r) => r.isLoading),
    isFetching: results.some((r) => r.isFetching),
    /** Cloud runs as its own service, so its absence isn't a dashboard failure. */
    hasCoreData: !serversQ.isError || !agentsQ.isError,
    /** The cloud microservice failing (proxied 500, connection refused, etc.)
     * must never render identically to "genuinely zero cloud accounts" — the
     * Cloud Accounts tile checks this to show "Cloud service unavailable"
     * instead of a misleading "None connected". */
    cloudError: cloudQ.isError,
    offline,
    unauthorised,
    errorCount: errors.length,
    // No longer one shared ['dash'] prefix — servers/summary/agents now use
    // the cross-page canonical keys (see api/queryKeys.js), so each tier is
    // invalidated explicitly instead of relying on a prefix match.
    refresh: () => {
      qc.invalidateQueries({ queryKey: QK.osServers() });
      qc.invalidateQueries({ queryKey: QK.osServersSummary });
      qc.invalidateQueries({ queryKey: QK.agents });
      qc.invalidateQueries({ queryKey: ['dash', 'alerts'] });
      qc.invalidateQueries({ queryKey: ['dash', 'cloud'] });
    },
  };
}

export { STATUS };
