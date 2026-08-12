import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import IconButton from '@/components/ui/IconButton';
import Meter from '@/components/charts/Meter';
import { STATUS } from '@/components/charts/status';
import { engineColor } from '@/config/agents';

/** Coarse bucket — used for the KPI filter, the card accent and the table rows. */
export function hostLevel(h) {
  const v = String(h?.status || '').toLowerCase();
  if (['connected', 'online', 'up', 'running', 'healthy'].includes(v)) return 'online';
  if (['warning', 'degraded', 'slow'].includes(v)) return 'warning';
  return 'offline';
}

/** Level → the shared status scale, so a host wears the same colours as every other status pill in the app. */
export function hostStatus(h) {
  const level = hostLevel(h);
  if (level === 'online') return { ...STATUS.good, tone: 'success' };
  if (level === 'warning') return { ...STATUS.warning, tone: 'warning' };
  return { ...STATUS.critical, label: 'Offline', tone: 'danger' };
}

/** os_type free text → the one label that matters for the badge. */
export function osLabel(os) {
  const v = String(os || '').toLowerCase();
  if (v.includes('win')) return 'Windows';
  if (v.includes('linux') || v.includes('ubuntu') || v.includes('rhel') || v.includes('cent') || v.includes('deb')) return 'Linux';
  return os || 'Other';
}

// cpu/ram/disk arrive as strings like "26%" — parseFloat (NOT Number, which yields NaN).
export const pctOf = (v) => Math.max(0, Math.min(100, Math.round(parseFloat(v) || 0)));

/**
 * One host, in grid view — the Infrastructure twin of AgentCard.
 *
 * A `div` wrapper rather than `button`, because the SSH action beneath it is a
 * real `<button>` of its own; a button cannot nest one. Both the card body and
 * the keyboard path open the detail page, matching how a clickable Table row
 * behaves elsewhere in the app.
 */
export default function InfraHostCard({ host, onOpen, onTerminal, onRefresh, refreshing, canExecute }) {
  const status = hostStatus(host);
  const services = Array.isArray(host.database_services) ? host.database_services : [];
  const cpu = pctOf(host.cpu_usage);
  const ram = pctOf(host.ram_usage);
  const disk = pctOf(host.disk_usage);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(host)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(host); } }}
      className="card group relative flex flex-col gap-3 overflow-hidden p-card text-left transition-colors hover:border-strong hover:bg-raised"
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: status.color }} aria-hidden="true" />

      {/* ── header ── */}
      <div className="flex items-start gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-sunken text-muted">
          <Icon name="server" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate-safe text-[13px] font-bold text-fg group-hover:text-accent-text">
            {host.server_name}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-subtle">
            <Icon name="globe" size={11} className="shrink-0" />
            <span className="truncate-safe">{host.hostname || host.ip_address || '—'}</span>
          </div>
        </div>
        <Badge tone={status.tone} size="xs" className="shrink-0">
          <Icon name={status.icon} size={9} strokeWidth={3} />
          {status.label}
        </Badge>
      </div>

      {/* ── os · env · collector ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral" size="xs">{osLabel(host.os_type)}</Badge>
        {host.environment && <Badge tone="neutral" size="xs">{host.environment}</Badge>}
        <Badge tone={host.collector === 'agent' ? 'accent' : 'info'} size="xs">
          {host.collector === 'agent' ? 'ActMon Agent' : 'SSH'}
        </Badge>
      </div>

      {/* ── utilisation ── */}
      <div className="grid grid-cols-3 gap-3">
        <Meter label="CPU" value={cpu} />
        <Meter label="Memory" value={ram} />
        <Meter label="Disk" value={disk} />
      </div>

      {/* ── db services · uptime ── */}
      <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5 text-[11px]">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {services.length > 0 ? (
            services.slice(0, 3).map((s) => (
              <span
                key={s}
                className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                style={{ background: `color-mix(in srgb, ${engineColor(s)} 14%, transparent)`, color: engineColor(s) }}
              >
                {s}
              </span>
            ))
          ) : (
            <span className="text-subtle">No DB services</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-subtle">
          <Icon name="clock" size={11} />
          {host.uptime || '—'}
        </span>
      </div>

      {/* ── actions ── */}
      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="primary" size="sm" icon="activity" className="flex-1 justify-center"
          onClick={(e) => { e.stopPropagation(); onOpen(host); }}
        >
          Details
        </Button>
        {canExecute && (
          <Button variant="secondary" size="sm" icon="terminal" onClick={(e) => { e.stopPropagation(); onTerminal(host); }}>
            SSH
          </Button>
        )}
        <IconButton
          icon="refresh" label="Refresh (SSH)" size="sm"
          onClick={(e) => { e.stopPropagation(); onRefresh(host.id); }}
          iconClassName={refreshing ? 'animate-spin' : undefined}
        />
      </div>
    </div>
  );
}
