/**
 * CLICKHOUSE DASHBOARD NAVIGATION — one shared tab strip, same extraction
 * pattern as `mysqlDashboardNav.js`/`postgresDashboardNav.js`.
 *
 * Unlike Postgres/MSSQL/MongoDB, ClickHouse's "Slow Queries" tab id stays
 * `slowqueries` (no hyphen) — it's still an IN-PAGE preview panel inside
 * `ClickHouseDashboard.jsx` (KPI tiles + a short list that opens the full
 * shared page), not yet migrated to a purely external tab route.
 */
import {
  Activity, Zap, FileText, TrendingUp, Server, Database, Layers, GitMerge,
  Copy, Network, ClipboardCheck, Clipboard,
} from 'lucide-react';

export const CLICKHOUSE_DASHBOARD_TABS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'queries', label: 'Running', icon: Zap },
  { id: 'querylog', label: 'Query Log', icon: FileText },
  { id: 'slowqueries', label: 'Slow Queries', icon: TrendingUp },
  { id: 'databases', label: 'Databases', icon: Server },
  { id: 'tables', label: 'Tables', icon: Database },
  { id: 'partitions', label: 'Partitions', icon: Layers },
  { id: 'merges', label: 'Merges', icon: GitMerge },
  { id: 'replicas', label: 'Replicas', icon: Copy },
  { id: 'clusters', label: 'Clusters', icon: Network },
  { id: 'sysmetrics', label: 'System Metrics', icon: ClipboardCheck },
  { id: 'settings', label: 'Settings', icon: Clipboard },
];

export function clickhouseTabRoute(connectionId, tabId) {
  return `/clickhouse-dashboard/${connectionId}${tabId && tabId !== 'overview' ? `/${tabId}` : ''}`;
}
