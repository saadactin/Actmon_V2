import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import cn from '@/lib/cn';
import Icon from './Icon';

/**
 * Transient confirmation for an action that already happened.
 *
 * Four pages had rolled their own, each with a different corner, duration and
 * palette. One implementation, token-driven, and page-owned rather than a global
 * provider — a toast belongs to the screen that fired the action, so there is no
 * app-wide state to keep in sync:
 *
 *   const { toasts, push, dismiss } = useToasts();
 *   push('Schedule deleted');
 *   push('Delete failed', 'error');
 *   …
 *   <Toasts toasts={toasts} onDismiss={dismiss} />
 *
 * `role="status"` and `aria-live="polite"` so a screen reader hears the outcome
 * without being interrupted mid-sentence — an action's result is news, not an
 * emergency. Errors get `assertive`, because a failed action needs to be heard.
 */

const TONES = {
  success: { cls: 'bg-success-soft text-success-fg border-success', icon: 'check' },
  error: { cls: 'bg-danger-soft text-danger-fg border-danger', icon: 'alert' },
  info: { cls: 'bg-info-soft text-info-fg border-info', icon: 'info' },
};

let seq = 0;

export function useToasts(timeout = 4000) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);

  const push = useCallback((message, tone = 'success') => {
    seq += 1;
    const id = seq;
    setToasts((list) => [...list, { id, message, tone }]);
    timers.current.set(id, setTimeout(() => dismiss(id), timeout));
    return id;
  }, [dismiss, timeout]);

  /* Clear pending timers on unmount, or a dismissal fires against a gone component. */
  useEffect(() => {
    const map = timers.current;
    return () => { map.forEach(clearTimeout); map.clear(); };
  }, []);

  return { toasts, push, dismiss };
}

export default function Toasts({ toasts = [], onDismiss }) {
  if (!toasts.length) return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[100] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => {
        const tone = TONES[t.tone] || TONES.info;
        return (
          <div
            key={t.id}
            role="status"
            aria-live={t.tone === 'error' ? 'assertive' : 'polite'}
            className={cn(
              'anim-pop-in pointer-events-auto flex max-w-md items-start gap-2 rounded-card border px-3.5 py-2.5 shadow-lg',
              tone.cls,
            )}
          >
            <Icon name={tone.icon} size={15} className="mt-px shrink-0" />
            <span className="min-w-0 text-[13px] font-semibold">{t.message}</span>
            <button
              type="button"
              onClick={() => onDismiss?.(t.id)}
              aria-label="Dismiss"
              className="-mr-1 ml-1 shrink-0 rounded-sm p-0.5 opacity-60 transition-opacity hover:opacity-100"
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
