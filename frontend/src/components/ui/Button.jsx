import { forwardRef } from 'react';
import cn from '@/lib/cn';
import Icon from './Icon';

/**
 * The app's button. Every variant is token-driven, so the accent, radius and
 * density settings reach buttons with no per-page work.
 */
const VARIANTS = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-active',
  secondary: 'border border-border bg-surface text-fg hover:bg-sunken hover:border-strong',
  subtle: 'bg-accent-soft text-accent-text hover:bg-accent-softer',
  ghost: 'text-muted hover:bg-sunken hover:text-fg',
  danger: 'bg-danger text-white hover:opacity-90',
  'danger-ghost': 'text-danger hover:bg-danger-soft',
};

const SIZES = {
  sm: 'h-control-sm gap-1.5 px-2.5 text-[12px]',
  md: 'h-control gap-2 px-3.5 text-[13px]',
  lg: 'h-control-lg gap-2 px-4 text-sm',
};

const Button = forwardRef(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    iconRight,
    loading = false,
    disabled,
    className,
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-control font-semibold whitespace-nowrap',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
        'disabled:pointer-events-none disabled:opacity-50',
        SIZES[size] || SIZES.md,
        VARIANTS[variant] || VARIANTS.secondary,
        className,
      )}
      {...rest}
    >
      {loading
        ? <Icon name="spinner" size={size === 'sm' ? 13 : 15} className="animate-spin" />
        : icon && <Icon name={icon} size={size === 'sm' ? 13 : 15} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 13 : 15} />}
    </button>
  );
});

export default Button;
