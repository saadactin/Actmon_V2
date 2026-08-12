import cn from '@/lib/cn';
import Icon from './Icon';

/**
 * Inline message block. `tone` maps onto the status token trio, so it follows the
 * theme instead of carrying its own colours.
 *
 * `role="alert"` on the danger/warning tones only: an alert interrupts a screen
 * reader mid-sentence, which is right for "sign-in blocked" and wrong for
 * "here is your development code".
 */

const TONES = {
  danger: { cls: 'bg-danger-soft text-danger-fg', icon: 'alert', live: true },
  warning: { cls: 'bg-warning-soft text-warning-fg', icon: 'alert', live: true },
  success: { cls: 'bg-success-soft text-success-fg', icon: 'check', live: false },
  info: { cls: 'bg-info-soft text-info-fg', icon: 'info', live: false },
};

export default function Notice({ tone = 'danger', title, icon, children, className }) {
  const t = TONES[tone] || TONES.danger;
  return (
    <div
      role={t.live ? 'alert' : 'status'}
      className={cn('mb-4 flex items-start gap-2 rounded-card px-3 py-2.5 text-[13px]', t.cls, className)}
    >
      <Icon name={icon || t.icon} size={15} className="mt-px shrink-0" />
      <span className="min-w-0">
        {title && <span className="font-semibold">{title} </span>}
        {children}
      </span>
    </div>
  );
}
