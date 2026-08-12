import cn from '@/lib/cn';
import Icon from './Icon';

/**
 * Underline tab strip.
 *
 *   tabs  [{ id, label, icon, count, tone }]
 * `count` renders as a pill; `tone` colours it (e.g. 'danger' for firing alerts).
 */
const COUNT_TONES = {
  neutral: 'bg-neutral-soft text-muted',
  danger: 'bg-danger-soft text-danger-fg',
  warning: 'bg-warning-soft text-warning-fg',
  accent: 'bg-accent-soft text-accent-text',
};

export default function Tabs({ tabs, value, onChange, className }) {
  return (
    <div className={cn('no-scrollbar flex gap-1 overflow-x-auto border-b border-border', className)} role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === value;
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
            {tab.icon && <Icon name={tab.icon} size={15} />}
            {tab.label}
            {tab.count !== undefined && tab.count !== null && (
              <span
                className={cn(
                  'rounded-full px-1.5 text-[10px] font-bold tabular-nums',
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
