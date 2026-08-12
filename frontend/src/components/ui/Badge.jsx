import cn from '@/lib/cn';

/** Small status/label chip. Tones map to the status token trio (soft bg + fg). */
const TONES = {
  neutral: 'bg-neutral-soft text-muted',
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success-soft text-success-fg',
  warning: 'bg-warning-soft text-warning-fg',
  danger: 'bg-danger-soft text-danger-fg',
  info: 'bg-info-soft text-info-fg',
  outline: 'border border-border text-muted',
};

export default function Badge({ tone = 'neutral', size = 'sm', className, style, children, ...rest }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-semibold whitespace-nowrap',
        size === 'xs' ? 'px-1.5 py-0.5 text-[0.625rem]' : 'px-2 py-0.5 text-[0.6875rem]',
        TONES[tone] || TONES.neutral,
        className,
      )}
      style={style}
      {...rest}
    >
      {children}
    </span>
  );
}

/** Pulsing dot + label, for "live" style indicators. */
export function LiveBadge({ label = 'Live', tone = 'success' }) {
  return (
    <Badge tone={tone} size="xs">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {label}
    </Badge>
  );
}
