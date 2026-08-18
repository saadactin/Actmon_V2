/**
 * MONGODB DASHBOARD NAVIGATION — one shared tab strip, same extraction
 * pattern as `mysqlDashboardNav.js`/`postgresDashboardNav.js`.
 */
import {
  Activity, Zap, Terminal, Layers, Key, Search, GitBranch, Archive, Network,
  RotateCcw, Cpu, Users, FileText,
} from 'lucide-react';

export const MONGODB_DASHBOARD_TABS = [
  { id: 'overview',      label: 'Overview',      icon: Activity },
  { id: 'operations',    label: 'Operations',    icon: Zap },
  { id: 'profiler',      label: 'Profiler',      icon: Terminal },
  { id: 'collections',   label: 'Collections',   icon: Layers },
  { id: 'indexes',       label: 'Indexes',       icon: Key },
  { id: 'slow-queries',  label: 'Slow Queries',  icon: Search },
  { id: 'replication',   label: 'Replication',   icon: GitBranch },
  { id: 'oplog',         label: 'Oplog',         icon: Archive },
  { id: 'sharding',      label: 'Sharding',      icon: Network },
  { id: 'transactions',  label: 'Transactions',  icon: RotateCcw },
  { id: 'wiredtiger',    label: 'WiredTiger',    icon: Cpu },
  { id: 'users',         label: 'Users',         icon: Users },
  { id: 'errorlogs',     label: 'Error Logs',    icon: FileText },
];

export function mongodbTabRoute(connectionId, tabId) {
  return `/mongodb-dashboard/${connectionId}${tabId && tabId !== 'overview' ? `/${tabId}` : ''}`;
}
