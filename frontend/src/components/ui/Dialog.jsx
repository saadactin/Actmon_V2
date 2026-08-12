import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import cn from '@/lib/cn';
import Icon from './Icon';
import IconButton from './IconButton';

/**
 * Centred modal. Portalled to <body> so the shell's `overflow: hidden` can't clip
 * it, locks page scroll while open, and closes on Escape or scrim click.
 *
 * Header/body/footer are separate regions so a long form scrolls between two
 * pinned bars instead of the whole dialog growing past the viewport.
 */
export default function Dialog({
  open,
  onClose,
  title,
  subtitle,
  icon,
  tone = 'accent',
  width = 520,
  footer,
  className,
  children,
  /** 'full' gives a wizard-style dialog room to breathe — near full-viewport
      instead of a compact centred box. Opt-in so every other dialog keeps
      its current, more modest footprint. */
  size = 'md',
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const TONES = {
    accent: 'bg-accent-soft text-accent-text',
    danger: 'bg-danger-soft text-danger-fg',
    warning: 'bg-warning-soft text-warning-fg',
  };

  return createPortal(
    <div className="fixed inset-0 z-[90] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/45 anim-fade-in" onClick={onClose} />

      <div
        className={cn(
          'card relative flex w-full flex-col overflow-hidden anim-pop-in',
          size === 'full' ? 'h-[94vh] max-h-[94vh]' : 'max-h-[92vh]',
          className,
        )}
        style={{ maxWidth: width }}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-border px-card py-3.5">
          {icon && (
            <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-md', TONES[tone] || TONES.accent)}>
              <Icon name={icon} size={18} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate-safe text-[15px] font-bold text-fg">{title}</h2>
            {subtitle && <p className="truncate-safe mt-0.5 text-[12px] text-muted">{subtitle}</p>}
          </div>
          <IconButton icon="close" label="Close" size="sm" tooltip={false} onClick={onClose} />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-card py-card">{children}</div>

        {footer && (
          <footer className="shrink-0 border-t border-border bg-raised px-card py-3">{footer}</footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
