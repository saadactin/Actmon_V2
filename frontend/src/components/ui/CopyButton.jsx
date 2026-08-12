import { useEffect, useRef, useState } from 'react';
import Button from './Button';

/**
 * Copy-to-clipboard with confirmation.
 *
 * There were fourteen hand-rolled copies of this across the engine pages, each
 * with its own timeout and its own idea of the label. One version means the
 * feedback is consistent and the failure case is handled once:
 * `navigator.clipboard` is unavailable on a plain-HTTP origin, which is exactly
 * how this app is served in a LAN deployment — so there is a fallback, and if
 * even that fails the button says so instead of silently doing nothing.
 */
export default function CopyButton({
  text,
  label = 'Copy',
  size = 'sm',
  variant = 'secondary',
  className,
}) {
  const [state, setState] = useState('idle'); // idle | done | failed
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const flash = (next) => {
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1800);
  };

  const copy = async (e) => {
    e.stopPropagation();
    const value = String(text ?? '');
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        /* Insecure origins have no async clipboard. execCommand is deprecated but
           it is the only thing that works there, and silently failing to copy is
           worse than using it. */
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('execCommand refused');
      }
      flash('done');
    } catch {
      flash('failed');
    }
  };

  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      onClick={copy}
      disabled={!String(text ?? '')}
      icon={state === 'done' ? 'check' : state === 'failed' ? 'alert' : 'copy'}
    >
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Press Ctrl+C' : label}
    </Button>
  );
}
