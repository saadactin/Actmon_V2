/**
 * POSTGRESQL DASHBOARD NAVIGATION — one shared tab strip, extracted the same
 * way `mysqlDashboardNav.js` extracts MySQL's, so `PostgreSQLDashboard.jsx`
 * (inline tabs) and `SlowQueriesPage.jsx` (its own routed page) show the
 * identical strip instead of each keeping its own copy.
 */
import {
  Activity, TrendingUp, Zap, Search, Database, Table, Lock, GitBranch, Users,
  HardDrive, Settings,
} from 'lucide-react';

export const POSTGRES_DASHBOARD_TABS = [
  { id: 'overview',     label: 'Overview',     icon: Activity },
  { id: 'performance',  label: 'Performance',  icon: TrendingUp },
  { id: 'queries',      label: 'Queries',      icon: Zap },
  { id: 'slow-queries', label: 'Slow Queries', icon: Search },
  { id: 'databases',    label: 'Databases',    icon: Database },
  { id: 'tables',       label: 'Tables',       icon: Table },
  { id: 'locks',        label: 'Locks',        icon: Lock },
  { id: 'replication',  label: 'Replication',  icon: GitBranch },
  { id: 'users',        label: 'Users',        icon: Users },
  { id: 'storage',      label: 'Storage',      icon: HardDrive },
  { id: 'config',       label: 'Config',       icon: Settings },
];

export function postgresTabRoute(connectionId, tabId) {
  return `/postgresql-dashboard/${connectionId}${tabId && tabId !== 'overview' ? `/${tabId}` : ''}`;
}
