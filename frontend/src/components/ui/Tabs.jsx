import cn from '@/lib/cn';
import Icon from './Icon';

/**
 * Underline tab strip.
 *
 *   tabs  [{ id, label, icon, count, tone }]
 * `icon` accepts either an icon-registry name string or a component (a lucide
 * icon, say) — same dual form PageHeader's `icon` prop accepts, so callers
 * that already hold a component (an engine dashboard's TABS array, e.g.)
 * don't need to thread it through the registry first.
 * `count` renders as a pill; `tone` colours it (e.g. 'danger' for firing alerts).
 *
 * Tabs WRAP onto a second row when they do not fit. This strip used to scroll
 * sideways with its scrollbar hidden, so at 175–200% zoom the last tabs (Event
 * Log, Alerts; Coverage and Trends in the Security Center) slid out of view
 * with nothing to say they were there. Wrapping keeps every tab visible and
 * clickable at any width, with no JavaScript and nothing to discover.
 */
const COUNT_TONES = {
  neutral: 'bg-neutral-soft text-muted',
  danger: 'bg-danger-soft text-danger-fg',
  warning: 'bg-warning-soft text-warning-fg',
  accent: 'bg-accent-soft text-accent-text',
};

export default function Tabs({ tabs, value, onChange, className }) {
  return (
    <div className={cn('flex flex-wrap gap-x-1 border-b border-border', className)} role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === value;
        const TabIcon = typeof tab.icon === 'function' || (tab.icon && typeof tab.icon === 'object') ? tab.icon : null;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cn(
              'relative flex shrink-0 items-center gap-2 px-3 pt-2 pb-2.5 text-[13px] font-semibold',
              'transition-colors duration-[var(--dur-fast)]',
              active ? 'text-accent-text' : 'text-muted hover:text-fg',
            )}
          >
            {TabIcon ? <TabIcon size={15} /> : tab.icon && <Icon name={tab.icon} size={15} />}
            {tab.label}
            {tab.count !== undefined && tab.count !== null && (
              <span
                className={cn(
                  'rounded-full px-1.5 text-micro font-bold tabular-nums',
                  COUNT_TONES[tab.tone] || COUNT_TONES.neutral,
                )}
              >
                {tab.count}
              </span>
            )}
            {/* the indicator sits on the container's border, not below it */}
            {active && (
              <span className="absolute inset-x-1.5 -bottom-px h-[2px] rounded-full bg-accent" />
            )}
          </button>
        );
      })}
    </div>
  );
}
