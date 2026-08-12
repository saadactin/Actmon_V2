import Icon from '@/components/ui/Icon';

/**
 * The fixed status scale, shared by every chart and health indicator.
 *
 * Status is never colour-alone: each entry carries an icon and a label, because
 * two of these steps sit below 3:1 on a light surface by design (see the note in
 * styles/tokens.css). Callers must render `icon` + `label` alongside the swatch.
 */
export const STATUS = {
  good: { id: 'good', label: 'Online', color: 'var(--status-good)', icon: 'check' },
  warning: { id: 'warning', label: 'Warning', color: 'var(--status-warning)', icon: 'alert' },
  serious: { id: 'serious', label: 'Degraded', color: 'var(--status-serious)', icon: 'alert' },
  critical: { id: 'critical', label: 'Offline', color: 'var(--status-critical)', icon: 'close' },
  unknown: { id: 'unknown', label: 'Unknown', color: 'var(--status-unknown)', icon: 'circle' },
};

/**
 * Utilisation % → status band, for CPU / RAM / disk meters and host bars.
 * Same colours as STATUS, but labelled for a percentage ("High", not "Offline").
 */
export function bandFor(pct) {
  if (pct >= 90) return { ...STATUS.critical, label: 'Critical' };
  if (pct >= 75) return { ...STATUS.serious, label: 'High' };
  if (pct >= 60) return { ...STATUS.warning, label: 'Elevated' };
  return { ...STATUS.good, label: 'Normal' };
}

/** The utilisation bands, for a chart legend. */
export const UTILISATION_BANDS = [
  { ...STATUS.good, label: 'Normal <60%' },
  { ...STATUS.warning, label: 'Elevated 60–74%' },
  { ...STATUS.serious, label: 'High 75–89%' },
  { ...STATUS.critical, label: 'Critical ≥90%' },
];

/** Normalise the many status strings the backend emits into one scale. */
export function statusOf(raw) {
  const v = String(raw || '').toLowerCase();
  if (['online', 'connected', 'healthy', 'up', 'running', 'active'].includes(v)) return STATUS.good;
  if (['warning', 'degraded', 'warn'].includes(v)) return STATUS.warning;
  if (['error', 'critical', 'failed'].includes(v)) return STATUS.critical;
  if (['offline', 'disconnected', 'down', 'stopped', 'inactive'].includes(v)) return STATUS.critical;
  return STATUS.unknown;
}

/**
 * Alert severity → status band.
 *
 * "Info" takes the neutral step, not a series colour: a categorical slot would
 * make an informational alert look like chart series 1, and inventing a new hex
 * here would put an unvalidated colour on screen.
 */
export function severityOf(raw) {
  const v = String(raw || 'info').toLowerCase();
  if (v === 'critical' || v === 'fatal') return { ...STATUS.critical, id: 'critical', label: 'Critical' };
  if (v === 'warning' || v === 'warn') return { ...STATUS.warning, id: 'warning', label: 'Warning' };
  return { ...STATUS.unknown, id: 'info', label: 'Info', icon: 'info' };
}

/** Swatch + icon + label — the compliant way to show a status. */
export function StatusKey({ status, count, className }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted ${className || ''}`}>
      <span
        className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full text-[8px] text-white"
        style={{ background: status.color }}
      >
        <Icon name={status.icon} size={9} strokeWidth={3.5} />
      </span>
      {status.label}
      {count !== undefined && <b className="text-fg tabular-nums">{count}</b>}
    </span>
  );
}
