import { useState } from 'react';
import cn from '@/lib/cn';
import { errorText } from '@/api/client';
import Icon from './Icon';
import IconButton from './IconButton';
import Button from './Button';

/**
 * Password re-auth modal for control actions (start/stop/restart a service,
 * kill a process, reboot a host, …). Shared so every caller gets the same
 * re-auth UX and the same honest success/failure messaging — extracted from
 * the copy that already lived in InfraHostDetail.jsx (services panel) so new
 * callers (the Diagnosis window) don't duplicate it a second time.
 *
 * `onConfirm(password)` must return the API call's promise; its resolved
 * value's `.message` (if any) is shown before the dialog auto-closes.
 */
export default function PasswordPrompt({ title, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const go = async () => {
    if (!pw) { setMsg({ ok: false, text: 'Enter your password to confirm.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await onConfirm(pw);
      setMsg({ ok: true, text: r?.message || 'Done.' });
      setTimeout(onClose, 900);
    } catch (e) {
      setMsg({ ok: false, text: errorText(e, 'Action failed.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="card shadow-2xl w-full max-w-md overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Icon name="shield-check" size={18} className={danger ? 'text-danger' : 'text-accent-text'} />
            <h3 className="font-bold text-[15px] text-fg">{title}</h3>
          </div>
          <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
        </div>
        <div className="p-5">
          <label className="block text-[13px] font-bold text-muted mb-1.5">Confirm your password to run this command</label>
          <div className="relative">
            <input
              type={show ? 'text' : 'password'}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && go()}
              placeholder="Your ActMon login password"
              autoFocus
              className="w-full h-10 px-3 pr-9 rounded-control border border-border bg-surface text-fg placeholder:text-subtle outline-none focus:border-accent"
            />
            <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-subtle hover:text-fg">
              <Icon name={show ? 'eye-off' : 'eye'} size={15} />
            </button>
          </div>
          {msg && (
            <p className={cn('mt-2 flex items-center gap-1.5 text-[13px] font-semibold', msg.ok ? 'text-success-fg' : 'text-danger-fg')}>
              <Icon name={msg.ok ? 'check' : 'alert'} size={14} />{msg.text}
            </p>
          )}
          <div className="flex justify-end gap-2 mt-5">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant={danger ? 'danger' : 'primary'} icon="check" loading={busy} disabled={busy} onClick={go}>{confirmLabel}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
