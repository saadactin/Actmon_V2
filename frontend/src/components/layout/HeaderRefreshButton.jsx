import Icon from '@/components/ui/Icon';

/**
 * The countdown-pill refresh control every top-level page's header uses —
 * icon + ticking seconds-until-next-refresh, not a bare icon button. First
 * built for AgentsPage.jsx (Figma-specced), then copy-pasted verbatim into
 * Dashboard.jsx and InfraPage.jsx; centralised here so all three (and any
 * future page with the same auto-refresh-with-countdown shape) stay
 * pixel-identical without relying on nobody's copy drifting.
 *
 * The countdown itself stays owned by the caller (a `useState` + one-second
 * `setInterval`, reset in the query's own refresh callback) since each page's
 * refresh interval and refetch call differ — this component only renders it.
 */
export default function HeaderRefreshButton({ seconds, onClick, spinning, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label || `Refresh now (auto in ${seconds}s)`}
      className="flex h-control shrink-0 items-center gap-1.5 rounded-control border border-border px-2.5 text-[0.75rem] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
    >
      <Icon name="refresh" size={13} className={spinning ? 'animate-spin' : undefined} />
      <span className="tabular-nums">{seconds}s</span>
    </button>
  );
}
