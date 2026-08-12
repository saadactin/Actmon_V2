import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';

/**
 * Side sheet. Portalled to <body> so it can never be clipped by the shell's
 * `overflow: hidden`, and it locks page scroll while open.
 */
export default function Drawer({
  open,
  onClose,
  title,
  subtitle,
  icon,
  side = 'right',
  width = 400,
  footer,
  children,
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

  return createPortal(
    <div className="fixed inset-0 z-[80]" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/45 anim-fade-in" onClick={onClose} />

      <div
        className={cn(
          'absolute inset-y-0 flex max-w-[94vw] flex-col border-border bg-surface shadow-xl',
          side === 'right' ? 'right-0 border-l anim-slide-right' : 'left-0 border-r anim-slide-left',
        )}
        style={{ width }}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3">
          {icon && (
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
              <Icon name={icon} size={18} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate-safe text-[15px] font-bold text-fg">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs leading-snug text-muted">{subtitle}</p>}
          </div>
          <IconButton icon="close" label="Close" size="sm" onClick={onClose} tooltip={false} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>

        {footer && (
          <div className="shrink-0 border-t border-border bg-raised px-4 py-3">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
