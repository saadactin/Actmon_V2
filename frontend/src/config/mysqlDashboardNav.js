/**
 * MYSQL DASHBOARD NAVIGATION — one shared tab strip across every MySQL
 * sub-page, whether its content renders inline inside `MySQLDashboard.jsx`
 * (Overview…Storage — an `activeTab` switch on one component) or as its own
 * routed page (Indexes/Binary Logs/Error Logs/Slow Queries — each a
 * separate file that still wants the SAME strip, with itself highlighted).
 *
 * Defined once so all five files agree on the order, labels, icons and
 * routing — a page-local copy would drift the moment one of them changed.
 */
import {
  Activity, TrendingUp, Zap, Database, Table, Lock, GitBranch, Users,
  HardDrive, Key, FileText, AlertTriangle, Search,
} from 'lucide-react';

/** Tab ids that render INLINE inside MySQLDashboard.jsx's own `activeTab`
 * switch, at `/mysql-dashboard/:id` (overview) or `/mysql-dashboard/:id/:tab`. */
export const MYSQL_INLINE_TAB_IDS = [
  'overview', 'performance', 'queries', 'databases', 'tables',
  'locks', 'replication', 'users', 'storage',
];

/** Tab ids that are their OWN routed page — each renders this same header
 * itself, with its own id passed as `activeTab`. Value is the route segment
 * under `/mysql-dashboard/:id/…` (only 'indexes' differs from its own id,
 * for the pre-existing `index-analysis` route). */
export const MYSQL_EXTERNAL_TAB_ROUTES = {
  indexes: 'index-analysis',
  'binary-logs': 'binary-logs',
  'error-logs': 'error-logs',
  'slow-queries': 'slow-queries',
};

export const MYSQL_DASHBOARD_TABS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'performance', label: 'Performance', icon: TrendingUp },
  { id: 'queries', label: 'Queries', icon: Zap },
  { id: 'databases', label: 'Databases', icon: Database },
  { id: 'tables', label: 'Tables', icon: Table },
  { id: 'locks', label: 'Locks', icon: Lock },
  { id: 'replication', label: 'Replication', icon: GitBranch },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'indexes', label: 'Indexes', icon: Key },
  { id: 'binary-logs', label: 'Binary Logs', icon: FileText },
  { id: 'error-logs', label: 'Error Logs', icon: AlertTriangle },
  { id: 'slow-queries', label: 'Slow Queries', icon: Search },
];

/** Resolves ANY tab id to the URL a click should land on, from ANY of the
 * five pages that share this strip — the one function every page's
 * `onTabChange` calls, so the routing rule lives in exactly one place. */
export function mysqlTabRoute(connectionId, tabId) {
  const external = MYSQL_EXTERNAL_TAB_ROUTES[tabId];
  if (external) return `/mysql-dashboard/${connectionId}/${external}`;
  return `/mysql-dashboard/${connectionId}${tabId && tabId !== 'overview' ? `/${tabId}` : ''}`;
}
