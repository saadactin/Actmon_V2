import { useState } from 'react';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Popover from '@/components/ui/Popover';
import Badge from '@/components/ui/Badge';
import { EVALUATION, groupsForSection, metricOf } from '@/config/alertCatalog';

/**
 * Grouped metric dropdown, scoped to one section.
 *
 * Custom rather than a native <select> with <optgroup> because each option needs
 * more than a label: the unit, and whether the backend can actually raise that
 * metric yet. A native option can't carry that.
 */
export default function MetricPicker({ section, value, onChange }) {
  const [open, setOpen] = useState(false);
  const current = metricOf(value);
  const evaluation = EVALUATION[current.evaluation] || EVALUATION.reserved;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-control w-full items-center gap-2 rounded-control border border-border bg-surface px-2.5 text-left transition-colors hover:border-strong"
      >
        <span className="truncate-safe min-w-0 flex-1 text-[13px] font-medium text-fg">
          {current.label}
          {current.unit ? <span className="text-subtle"> ({current.unit})</span> : null}
        </span>
        {current.evaluation !== 'live' && (
          <Badge tone={evaluation.tone} size="xs">{evaluation.label}</Badge>
        )}
        <Icon
          name="chevron-down"
          size={14}
          className={cn('shrink-0 text-subtle transition-transform', open && 'rotate-180')}
        />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} align="left" width="100%" className="max-h-72 overflow-y-auto">
        {groupsForSection(section).map((g) => (
          <div key={g.group}>
            <div className="sticky top-0 z-10 border-b border-border bg-raised px-3 py-1.5 text-[10px] font-bold tracking-wide text-subtle uppercase">
              {g.group}
            </div>
            {g.metrics.map((m) => {
              const active = m.id === value;
              const evl = EVALUATION[m.evaluation] || EVALUATION.reserved;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { onChange(m.id); setOpen(false); }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                    active ? 'bg-accent-soft' : 'hover:bg-sunken',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className={cn(
                      'truncate-safe block text-[13px]',
                      active ? 'font-semibold text-accent-text' : 'text-fg',
                    )}>
                      {m.label}
                      {m.unit ? <span className="font-normal text-subtle"> ({m.unit})</span> : null}
                    </span>
                    {m.kind === 'event' && (
                      <span className="truncate-safe block text-[10px] text-subtle">
                        Fires when {m.desc}
                      </span>
                    )}
                  </span>
                  {m.evaluation !== 'live' && (
                    <Badge tone={evl.tone} size="xs">{evl.label}</Badge>
                  )}
                  {active && <Icon name="check" size={13} className="shrink-0 text-accent-text" />}
                </button>
              );
            })}
          </div>
        ))}
      </Popover>
    </div>
  );
}
