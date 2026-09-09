/**
 * SQL SERVER DASHBOARD NAVIGATION — one shared tab strip across every MSSQL
 * sub-page, whether its content renders inline inside `MSSQLDashboard.jsx`
 * (Overview…Storage — an `activeTab` switch on one component) or as its own
 * routed page (Error Logs/Wait Analysis/Indexes — each a separate file that
 * still wants the SAME strip, with itself highlighted). Same pattern as
 * `mysqlDashboardNav.js`; Error Logs/Indexes/Wait Analysis used to only be
 * header quick-links, duplicating Slow Queries (already a tab) — moved in
 * here instead so the header's quick-links are just Diagnose/Reports, the
 * two genuine "not a tab" sub-pages.
 */
import {
  Activity, AlertTriangle, Clock, Database, GitBranch, HardDrive, Key, Layers, Lock, Search, Table, TrendingUp, Users, Zap,
} from 'lucide-react';

export const MSSQL_DASHBOARD_TABS = [
  { id: 'overview',       label: 'Overview',      icon: Activity },
  { id: 'performance',    label: 'Performance',   icon: TrendingUp },
  { id: 'queries',        label: 'Queries',       icon: Zap },
  { id: 'slow-queries',   label: 'Slow Queries',  icon: Search },
  { id: 'databases',      label: 'Databases',     icon: Database },
  { id: 'tables',         label: 'Tables',        icon: Table },
  { id: 'locks',          label: 'Locks',         icon: Lock },
  { id: 'replication',    label: 'Always On',     icon: GitBranch },
  { id: 'users',          label: 'Logins',        icon: Users },
  { id: 'storage',        label: 'Storage',       icon: HardDrive },
  { id: 'error-logs',     label: 'Error Logs',    icon: AlertTriangle },
  { id: 'wait-analysis',  label: 'Wait Analysis', icon: Clock },
  { id: 'index-analysis', label: 'Indexes',       icon: Key },
  { id: 'fragmentation',  label: 'Fragmentation', icon: Layers },
];

export function mssqlTabRoute(connectionId, tabId) {
  return `/mssql-dashboard/${connectionId}${tabId && tabId !== 'overview' ? `/${tabId}` : ''}`;
}
