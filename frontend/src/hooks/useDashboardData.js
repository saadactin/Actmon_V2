import { useMemo } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import {
  getServerSummary, listActiveAlerts, listAgents, listCloudAccounts, listOsServers,
} from '@/api/dashboard';
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
      { queryKey: ['dash', 'servers'], queryFn: listOsServers, refetchInterval: REFRESH.servers, retry: false },
      { queryKey: ['dash', 'summary'], queryFn: getServerSummary, refetchInterval: REFRESH.summary, retry: false },
      { queryKey: ['dash', 'agents'], queryFn: listAgents, refetchInterval: REFRESH.agents, retry: false },
      { queryKey: ['dash', 'alerts'], queryFn: listActiveAlerts, refetchInterval: REFRESH.alerts, retry: false },
      { queryKey: ['dash', 'cloud'], queryFn: listCloudAccounts, refetchInterval: REFRESH.cloud, retry: false },
    ],
  });

  const [serversQ, summaryQ, agentsQ, alertsQ, cloudQ] = results;

  const hosts = serversQ.data || [];
  const agents = agentsQ.data || [];
  const alerts = alertsQ.data || [];
  const cloud = cloudQ.data || [];
  const summary = summaryQ.data || {};

  const derived = useMemo(() => {
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

    /* ── agents ── */
    const agentTally = tally(agents);

    /* ── resource averages (hosts that actually reported) ── */
    const resources = {
      cpu: mean(hosts.map((h) => num(h.cpu_usage)).filter((v) => v > 0)),
      ram: mean(hosts.map((h) => num(h.ram_usage)).filter((v) => v > 0)),
      disk: mean(hosts.map((h) => num(h.disk_usage)).filter((v) => v > 0)),
      reporting: hosts.filter((h) => num(h.cpu_usage) > 0).length,
    };

    /* ── busiest hosts by CPU ── */
    const topCpu = hosts
      .map((h) => ({
        key: String(h.server_id ?? h.id ?? h.server_name ?? h.ip_address),
        label: h.server_name || h.ip_address || '—',
        value: num(h.cpu_usage),
        sub: h.ip_address && h.server_name ? h.ip_address : undefined,
      }))
      .filter((h) => h.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, TOP_CPU_HOSTS);

    /* ── alerts by severity ── */
    const bySeverity = { critical: 0, warning: 0, info: 0 };
    for (const a of alerts) bySeverity[severityOf(a.severity).id] += 1;

    // Newest first, kept whole: the overview's alert feed scrolls and filters by
    // severity, so it needs every firing alert rather than a top slice. `recent`
    // stays for callers that only want the first few.
    const sortedAlerts = [...alerts]
      .sort((a, b) => new Date(b.timestamp || b.created_at || 0) - new Date(a.timestamp || a.created_at || 0));
    const recentAlerts = sortedAlerts.slice(0, 8);

    /* ── distribution: cloud providers, else host environments ── */
    const providers = {};
    for (const acct of cloud) {
      const key = String(acct.provider || acct.cloud_provider || 'Other').toUpperCase();
      providers[key] = (providers[key] || 0) + 1;
    }
    const environments = {};
    for (const h of hosts) {
      const key = h.environment || 'Unspecified';
      environments[key] = (environments[key] || 0) + 1;
    }
    const toList = (map) => Object.entries(map)
      .map(([label, value]) => ({ key: label, label, value }))
      .sort((a, b) => b.value - a.value);

    return {
      infra,
      databases,
      perTech,
      agents: agentTally,
      resources,
      topCpu,
      alerts: { total: alerts.length, ...bySeverity, recent: recentAlerts, list: sortedAlerts },
      cloud: { total: cloud.length, byProvider: toList(providers) },
      byEnvironment: toList(environments),
    };
  }, [hosts, agents, alerts, cloud, summary]);

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
    offline,
    unauthorised,
    errorCount: errors.length,
    refresh: () => qc.invalidateQueries({ queryKey: ['dash'] }),
  };
}

export { STATUS };
