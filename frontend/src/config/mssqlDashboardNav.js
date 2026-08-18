/**
 * SQL SERVER DASHBOARD NAVIGATION — one shared tab strip, same extraction
 * pattern as `mysqlDashboardNav.js`/`postgresDashboardNav.js`.
 */
import {
  Activity, Database, GitBranch, HardDrive, Lock, Search, Table, TrendingUp, Users, Zap,
} from 'lucide-react';

export const MSSQL_DASHBOARD_TABS = [
  { id: 'overview',     label: 'Overview',     icon: Activity },
  { id: 'performance',  label: 'Performance',  icon: TrendingUp },
  { id: 'queries',      label: 'Queries',      icon: Zap },
  { id: 'slow-queries', label: 'Slow Queries', icon: Search },
  { id: 'databases',    label: 'Databases',    icon: Database },
  { id: 'tables',       label: 'Tables',       icon: Table },
  { id: 'locks',        label: 'Locks',        icon: Lock },
  { id: 'replication',  label: 'Always On',    icon: GitBranch },
  { id: 'users',        label: 'Logins',       icon: Users },
  { id: 'storage',      label: 'Storage',      icon: HardDrive },
];

export function mssqlTabRoute(connectionId, tabId) {
  return `/mssql-dashboard/${connectionId}${tabId && tabId !== 'overview' ? `/${tabId}` : ''}`;
}
