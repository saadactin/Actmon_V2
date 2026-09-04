import { useSearchParams } from 'react-router-dom';
import cn from '@/lib/cn';
import MaintenanceOverview from './MaintenanceOverview';
import TableMaintenancePage from './TableMaintenancePage';
import IndexMaintenancePage from './IndexMaintenancePage';
import StatisticsMaintenancePage from './StatisticsMaintenancePage';
import PartitionMaintenancePage from './PartitionMaintenancePage';
import SpaceMaintenancePage from './SpaceMaintenancePage';
import MaintenanceWindow from '@/pages/alerts/MaintenanceWindow';

/**
 * Oracle Dashboard -> Maintenance tab.
 *
 * Overview is the landing view (five real-time category cards answering
 * "what needs attention right now"); clicking one opens its own telemetry +
 * operations page. Job History is the pre-existing approve/reject/schedule
 * table (MaintenanceWindow, unchanged) — kept one tab away rather than
 * dominating the landing page, per the redesign brief.
 */

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'table', label: 'Table' },
  { id: 'index', label: 'Index' },
  { id: 'statistics', label: 'Statistics' },
  { id: 'partition', label: 'Partition' },
  { id: 'space', label: 'Space / Storage' },
  { id: 'history', label: 'Job History' },
];

export default function OracleMaintenanceModule({ connId }) {
  // URL-driven (not local state) so a job launched from, say, the
  // Statistics tab returns there on Back instead of resetting to Overview.
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('section');
  const tab = TABS.some((t) => t.id === tabParam) ? tabParam : 'overview';
  const setTab = (id) => {
    const next = new URLSearchParams(params);
    if (id === 'overview') next.delete('section');
    else next.set('section', id);
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-gutter">
      <span className="flex flex-wrap items-center gap-0.5 rounded-control border border-border p-0.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-control px-2.5 text-[11px] font-bold transition-colors',
              tab === t.id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-sunken hover:text-fg',
            )}
          >
            {t.label}
          </button>
        ))}
      </span>

      {tab === 'overview' && <MaintenanceOverview connId={connId} onOpenCategory={setTab} />}
      {tab === 'table' && <TableMaintenancePage connId={connId} />}
      {tab === 'index' && <IndexMaintenancePage connId={connId} />}
      {tab === 'statistics' && <StatisticsMaintenancePage connId={connId} />}
      {tab === 'partition' && <PartitionMaintenancePage connId={connId} />}
      {tab === 'space' && <SpaceMaintenancePage connId={connId} />}
      {tab === 'history' && <MaintenanceWindow connId={connId} />}
    </div>
  );
}
