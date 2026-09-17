import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { HardDrive, Save, FileText, RefreshCw, Archive, GitBranch, Eye, Boxes, CheckCircle2, AlertTriangle, HelpCircle } from 'lucide-react';
import cn from '@/lib/cn';
import client from '@/api/client';
import Table, { EmptyState } from '@/components/ui/Table';
import { fullTime } from '@/lib/format';

const ICON_MAP = { HardDrive, Save, FileText, RefreshCw, Archive, GitBranch };
const STATUS_LABEL = { good: 'Healthy', warning: 'Warning', critical: 'Critical', unknown: 'Unavailable' };

// Same cell typography as the Agents list table (AgentsPage.jsx's CELL_SIZE/
// CELL_TEXT) — 16px/18px-lh, so a value reads at the identical size/weight
// wherever it appears in either table, not just a visually-similar approximation.
const CELL_SIZE = 'whitespace-nowrap text-[1rem] leading-[1.125rem]';
const CELL_TEXT = cn(CELL_SIZE, 'font-medium text-subtle');
// Same theme-adaptive scale every other status badge in the app reads from
// (statusLevel()/LEVEL_COLORS in config/agents.js) — a process's own
// good/warning/critical/unknown vocabulary already maps onto it directly.
const STATUS_COLOR = {
  good: 'var(--status-good)', warning: 'var(--status-warning)',
  critical: 'var(--status-critical)', unknown: 'var(--status-unknown)',
};

// Total / Healthy / Issues (warning+critical) / Unavailable — the same
// four-bucket summary shape the Agents list uses (Total/Online/Issues/Offline),
// clickable to filter the list below, same as there.
const STAT_CARDS = [
  { key: 'all', label: 'Total Processes', icon: Boxes },
  { key: 'good', label: 'Healthy', icon: CheckCircle2 },
  { key: 'issues', label: 'Issues', icon: AlertTriangle },
  { key: 'unknown', label: 'Unavailable', icon: HelpCircle },
];

/**
 * PostgreSQL Processes — internal/background activity. Rendered inline at
 * the bottom of the Performance tab (no separate "Processes" nav item).
 * Every row shows a real, process-specific current value (never a repeated
 * generic placeholder) and a friendly name, with the technical Postgres
 * term available on the process's own detail page rather than here.
 *
 * Visually matches the Agents list page (Monitored Systems) — status-colored
 * left accent bar, dark floating-card table rows, a clickable status summary
 * row — using the SAME shared Table component and status color scale, not a
 * separate look-alike. Search/sort/pagination from that page are deliberately
 * left out: this is always exactly 6 known rows, not an open-ended list.
 */
export default function ProcessesTab({ connId }) {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['pgProcessesList', connId],
    queryFn: () => client.get(`/connections/postgresql/${connId}/processes/list`).then((r) => r.data),
    enabled: !!connId,
    refetchInterval: 15000,
  });

  const [statFilter, setStatFilter] = useState('all');
  const processes = data?.processes || [];
  const openProcess = (id) => navigate(`/postgresql-dashboard/${connId}/performance/${id}`);

  const counts = useMemo(() => {
    const c = { all: processes.length, good: 0, issues: 0, unknown: 0 };
    for (const p of processes) {
      if (p.status === 'good') c.good += 1;
      else if (p.status === 'warning' || p.status === 'critical') c.issues += 1;
      else c.unknown += 1;
    }
    return c;
  }, [processes]);

  const filtered = useMemo(() => {
    if (statFilter === 'all') return processes;
    if (statFilter === 'issues') return processes.filter((p) => p.status === 'warning' || p.status === 'critical');
    return processes.filter((p) => (statFilter === 'unknown' ? p.status !== 'good' && p.status !== 'warning' && p.status !== 'critical' : p.status === statFilter));
  }, [processes, statFilter]);

  // Only the name column stays left-aligned — every other column is centered,
  // same as every column but "Agent/Host" in the Agents list table.
  const columns = [
    { key: 'process', label: 'Process', width: 260 },
    { key: 'status', label: 'Status', align: 'center', width: 160 },
    { key: 'value', label: 'Current Value', align: 'center', width: 200 },
    { key: 'updated', label: 'Updated', align: 'center', width: 180 },
    { key: 'action', label: 'Action', align: 'center', width: 70 },
  ];

  const rows = filtered.map((p) => {
    const Icon = ICON_MAP[p.icon] || RefreshCw;
    const color = STATUS_COLOR[p.status] || STATUS_COLOR.unknown;
    return {
      key: p.id,
      onClick: () => openProcess(p.id),
      cells: {
        // Same shape as Agent/Host: left accent bar + bold name, same
        // text-[1rem]/leading-[1.125rem] size as every other cell.
        process: (
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-7 w-[3px] shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
            <Icon size={16} className="shrink-0 text-subtle" />
            <span className={cn(CELL_SIZE, 'truncate-safe font-bold text-fg')}>{p.friendly_name}</span>
          </div>
        ),
        status: (
          <span title={STATUS_LABEL[p.status]} className="inline-flex cursor-help justify-center">
            {/* Same pill metrics as the Agents list Status column: 16px/500/
                18px-lh text, centered, rounded-full — only the width/colour
                source differ (this page's own status scale, not the pinned
                --agent-* one, since these aren't the same Figma spec). */}
            <span
              className="inline-flex items-center justify-center rounded-full px-3"
              style={{
                height: '2.25rem', fontSize: '1rem', lineHeight: '1.125rem', fontWeight: 500,
                background: `color-mix(in srgb, ${color} 16%, transparent)`, color,
              }}
            >
              {STATUS_LABEL[p.status] || 'Unavailable'}
            </span>
          </span>
        ),
        value: <span className={CELL_TEXT}>{p.latest_label || '—'}</span>,
        updated: <span className={CELL_TEXT} title={p.updated_at ? fullTime(p.updated_at) : undefined}>{p.updated_at ? fullTime(p.updated_at) : '—'}</span>,
        action: (
          <button
            type="button"
            title="View details"
            onClick={(e) => { e.stopPropagation(); openProcess(p.id); }}
            className="inline-grid h-7 w-7 place-items-center rounded-control text-subtle transition-colors hover:bg-inverse hover:text-on-inverse"
          >
            <Eye size={14} />
          </button>
        ),
      },
    };
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[16px] font-black text-fg">PostgreSQL Processes</h2>
        <p className="mt-0.5 text-[12.5px] text-subtle">
          What Postgres is doing internally, in plain language — click any row for live detail.
        </p>
      </div>

      {isError && (
        <div className="card p-card">
          <p className="text-[13px] font-semibold text-danger-fg">Unable to collect PostgreSQL metrics right now.</p>
        </div>
      )}

      {/* ── status summary, doubling as a filter — same pattern as the Agents list ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STAT_CARDS.map((card) => {
          const active = statFilter === card.key;
          const color = card.key === 'all' ? 'var(--accent)' : STATUS_COLOR[card.key] || 'var(--status-warning)';
          const Icon = card.icon;
          return (
            <button
              key={card.key}
              type="button"
              onClick={() => setStatFilter(active && card.key !== 'all' ? 'all' : card.key)}
              aria-pressed={active}
              className="card flex h-16 items-center gap-2.5 p-3 text-left transition-colors"
              style={{ borderColor: active ? color : undefined, boxShadow: active ? `0 0 0 2px color-mix(in srgb, ${color} 20%, transparent)` : undefined }}
            >
              <span
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full"
                style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}
              >
                <Icon size={15} />
              </span>
              <span className="truncate-safe min-w-0 flex-1 text-[0.75rem] font-semibold text-fg">{card.label}</span>
              <span className="shrink-0 text-[1.25rem] leading-none font-black" style={{ color: active ? color : 'var(--fg)' }}>
                {counts[card.key]}
              </span>
            </button>
          );
        })}
      </div>

      <Table
        columns={columns}
        rows={rows}
        rowHeight={64}
        loading={isLoading}
        empty={<EmptyState icon="boxes" title="No process data available." />}
        darkHeader
      />
    </div>
  );
}
