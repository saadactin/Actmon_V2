/**
 * Oracle dashboard tab list — extracted from the inline `TABS` const in
 * OracleDashboard.jsx (mirrors mysqlDashboardNav.js's exported-array pattern).
 *
 * `BASE_TABS` is exactly the existing 16 tabs, unchanged — a plain standalone
 * Oracle instance sees precisely what it always has, no regression.
 * `tabsForTopology(topology)` appends topology-specific tabs ONLY when that
 * topology is actually detected, per the "only show relevant sections"
 * requirement — a standalone instance never sees RAC/Services/ASM/Multitenant
 * clutter it can't use.
 */
import {
  Activity, BarChart2, Boxes, Clock, Cpu, HardDrive, Key, Layers, Lock,
  Network, RotateCcw, Server, Settings, ShieldCheck, Table, TrendingUp, Users, Zap,
} from 'lucide-react';

export const BASE_TABS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'performance', label: 'Performance', icon: TrendingUp },
  { id: 'sessions', label: 'Sessions', icon: Users },
  { id: 'sql', label: 'Top SQL', icon: Zap },
  { id: 'tablespaces', label: 'Tablespaces', icon: HardDrive },
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
  { id: 'parameters', label: 'Parameters', icon: Settings },
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
