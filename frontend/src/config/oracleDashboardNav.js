/**
 * Oracle dashboard tab list — extracted from the inline `TABS` const in
 * OracleDashboard.jsx (mirrors mysqlDashboardNav.js's exported-array pattern).
 *
 * `BASE_TABS` is every tab a plain standalone Oracle instance sees, no
 * topology required.
 * `tabsForTopology(topology)` appends topology-specific tabs ONLY when that
 * topology is actually detected, per the "only show relevant sections"
 * requirement — a standalone instance never sees RAC/Services/ASM/Multitenant
 * clutter it can't use.
 */
import {
  Activity, Archive, BarChart2, Boxes, Clock, Cpu, FileText, Gauge, HardDrive, Key, Layers, Lock,
  Network, RotateCcw, Server, Settings, ShieldCheck, Stethoscope, Table, TrendingUp, Users, Wrench, Zap,
} from 'lucide-react';

export const BASE_TABS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'performance', label: 'Performance', icon: TrendingUp },
  { id: 'sessions', label: 'Sessions', icon: Users },
  { id: 'sql', label: 'Top SQL', icon: Zap },
  { id: 'tablespaces', label: 'Tablespaces', icon: HardDrive },
  { id: 'maintenance', label: 'Maintenance', icon: Wrench },
  { id: 'backups', label: 'RMAN Backups', icon: Archive },
  { id: 'objects', label: 'Objects', icon: Boxes },
  { id: 'tables', label: 'Tables', icon: Table },
  { id: 'dataguard', label: 'Data Guard', icon: ShieldCheck },
  { id: 'redologs', label: 'Redo Logs', icon: RotateCcw },
  { id: 'processes', label: 'Processes', icon: Cpu },
  { id: 'users', label: 'Users', icon: Key },
  { id: 'systemstats', label: 'Sys Stats', icon: BarChart2 },
  { id: 'slowqueries', label: 'Slow SQL', icon: Clock },
  { id: 'live', label: 'Live Queries', icon: Activity },
  { id: 'locks', label: 'Locks', icon: Lock },
  { id: 'sqlmonitor', label: 'SQL Monitor', icon: Gauge },
  { id: 'parameters', label: 'Parameters', icon: Settings },
  // Former header quick-links, moved into the tab strip proper so the header
  // shows one navigation surface instead of tabs plus a separate row of pills.
  // (The pre-existing quick-links for live/slow/error/index/storage-health
  // are intentionally left as header links — see config/engines.js.)
  { id: 'reports', label: 'Reports', icon: FileText },
  { id: 'diagnose', label: 'Diagnose', icon: Stethoscope },
];

const RAC_TAB = { id: 'rac', label: 'RAC', icon: Server };
const SERVICES_TAB = { id: 'services', label: 'Services', icon: Network };
const ASM_TAB = { id: 'asm', label: 'ASM', icon: Layers };
const MULTITENANT_TAB = { id: 'multitenant', label: 'CDB/PDB', icon: Boxes };
const TOPOLOGY_TAB = { id: 'topology', label: 'Topology', icon: Network };

/**
 * `topology` = { is_rac, is_dataguard, asm_configured, is_cdb } (undefined
 * fields are treated as "not yet known" — false, not true, so tabs don't
 * flash in before detection resolves).
 */
export function tabsForTopology(topology = {}) {
  const tabs = [...BASE_TABS];
  const dgIdx = tabs.findIndex((t) => t.id === 'dataguard');

  // RAC/Services insert right after Overview — they're core topology, not an
  // afterthought — and Topology is always available once anything beyond
  // plain standalone is detected (no value in a topology diagram of one box).
  const extras = [];
  if (topology.is_rac) extras.push(RAC_TAB, SERVICES_TAB);
  if (topology.asm_configured) extras.push(ASM_TAB);
  if (topology.is_cdb) extras.push(MULTITENANT_TAB);
  if (extras.length || topology.is_dataguard) extras.push(TOPOLOGY_TAB);

  if (extras.length) tabs.splice(2, 0, ...extras);

  // Data Guard tab only shows once actually detected — a plain standalone
  // instance shouldn't see a permanently-empty section.
  if (!topology.is_dataguard && dgIdx >= 0) {
    const realIdx = tabs.findIndex((t) => t.id === 'dataguard');
    if (realIdx >= 0) tabs.splice(realIdx, 1);
  }

  return tabs;
}

/** connectionId -> real route for one tab id, mirroring
 * `postgresDashboardNav.js`'s `postgresTabRoute` — `diagnose` is the one tab
 * that lives outside the `/oracle-dashboard` prefix entirely; every other
 * tab id (including `reports`) is a route segment under it that equals the
 * tab id itself. */
export function oracleTabRoute(connectionId, tabId) {
  if (tabId === 'diagnose') return `/diagnose/${connectionId}`;
  return `/oracle-dashboard/${connectionId}${tabId && tabId !== 'overview' ? `/${tabId}` : ''}`;
}
