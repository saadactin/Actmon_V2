import { forwardRef } from 'react';
import cn from '@/lib/cn';
import Icon from './Icon';
import Tooltip from './Tooltip';

/**
 * Square icon button used all over the chrome.
 *
 * `tone` decides which token set it draws from — `chrome` inherits currentColor
 * so the same component works on the light topbar and the dark sidebar without
 * either place hard-coding a colour.
 */
const TONES = {
  chrome: 'text-current/70 hover:text-current hover:bg-current/10',
  default: 'text-muted hover:text-fg hover:bg-sunken',
  accent: 'text-accent-text hover:bg-accent-soft',
  danger: 'text-danger hover:bg-danger-soft',
};

const SIZES = {
  sm: 'h-7 w-7',
  md: 'h-9 w-9',
  lg: 'h-10 w-10',
};

const IconButton = forwardRef(function IconButton(
  {
    icon,
    label,
    tone = 'default',
    size = 'md',
    active = false,
    tooltip = true,
    tooltipSide = 'bottom',
    iconSize,
    iconClassName,
    className,
    children,
    ...rest
  },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-control',
        // focus ring comes from the global :focus-visible rule in styles/index.css
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
        'disabled:pointer-events-none disabled:opacity-40',
        SIZES[size] || SIZES.md,
        TONES[tone] || TONES.default,
        active && (tone === 'chrome' ? 'bg-current/12 text-current' : 'bg-accent-soft text-accent-text'),
        className,
      )}
      {...rest}
    >
      {icon ? (
        <Icon name={icon} size={iconSize || (size === 'sm' ? 15 : 18)} className={iconClassName} />
      ) : null}
      {children}
    </button>
  );

  if (!tooltip || !label) return btn;
  return (
    <Tooltip label={label} side={tooltipSide}>
      {btn}
    </Tooltip>
  );
});

export default IconButton;
