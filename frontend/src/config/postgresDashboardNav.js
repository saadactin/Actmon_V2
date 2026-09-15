/**
 * POSTGRESQL DASHBOARD NAVIGATION — one shared tab strip, extracted the same
 * way `mysqlDashboardNav.js` extracts MySQL's, so `PostgreSQLDashboard.jsx`
 * (inline tabs) and `SlowQueriesPage.jsx` (its own routed page) show the
 * identical strip instead of each keeping its own copy.
 */
import {
  Activity, TrendingUp, Zap, Search, Database, Table, Lock, GitBranch, Users,
  HardDrive, Settings, AlertTriangle, Key, FileText, Stethoscope, Wrench,
} from 'lucide-react';

export const POSTGRES_DASHBOARD_TABS = [
  { id: 'overview',       label: 'Overview',      icon: Activity },
  { id: 'performance',    label: 'Performance',   icon: TrendingUp },
  { id: 'queries',        label: 'Queries',       icon: Zap },
  { id: 'slow-queries',   label: 'Slow Queries',  icon: Search },
  { id: 'databases',      label: 'Databases',     icon: Database },
  { id: 'tables',         label: 'Tables',        icon: Table },
  { id: 'locks',          label: 'Locks',         icon: Lock },
  { id: 'replication',    label: 'Replication',   icon: GitBranch },
  { id: 'users',          label: 'Users',         icon: Users },
  { id: 'storage',        label: 'Storage',       icon: HardDrive },
  { id: 'config',         label: 'Config',        icon: Settings },
  { id: 'maintenance',    label: 'Maintenance',   icon: Wrench },
  // Former header quick-links, moved into the tab strip proper so the header
  // shows one navigation surface instead of tabs plus a separate row of pills.
  { id: 'error-logs',     label: 'Error Logs',    icon: AlertTriangle },
  { id: 'index-analysis', label: 'Indexes',       icon: Key },
  { id: 'reports',        label: 'Reports',       icon: FileText },
  { id: 'diagnose',       label: 'Diagnose',      icon: Stethoscope },
];

/** connectionId -> real route for one tab id — the one place that knows which
 * tabs render inline inside PostgreSQLDashboard.jsx vs. route to their own
 * page (or, for `diagnose`, to a route outside the /postgresql-dashboard
 * prefix entirely). */
export function postgresTabRoute(connectionId, tabId) {
  if (tabId === 'diagnose') return `/diagnose/${connectionId}`;
  return `/postgresql-dashboard/${connectionId}${tabId && tabId !== 'overview' ? `/${tabId}` : ''}`;
}
