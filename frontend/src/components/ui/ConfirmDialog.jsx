import Button from './Button';
import Dialog from './Dialog';

/**
 * Yes / no confirmation. One definition, so every "are you sure?" in the app asks
 * the same way and the destructive choice is always the one on the right.
 *
 * The message should say what is lost, not just ask the question — "Leave setup?"
 * alone gives the operator nothing to decide on.
 */
export default function ConfirmDialog({
  open,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Yes, leave',
  cancelLabel = 'No, stay',
  tone = 'warning',
  icon = 'alert',
  onConfirm,
  onCancel,
  /** In flight. Both buttons lock, so the action cannot be fired twice. */
  loading = false,
  /** Confirm stays disabled regardless of loading — e.g. a destructive action
   * gated behind a typed acknowledgement the caller hasn't completed yet. */
  confirmDisabled = false,
  /** Richer body than one sentence — used instead of `message`, not alongside it. */
  children,
}) {
  return (
    <Dialog
      open={open}
      onClose={loading ? undefined : onCancel}
      title={title}
      icon={icon}
      tone={tone}
      width={440}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" disabled={loading} onClick={onCancel}>{cancelLabel}</Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={loading}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      )}
    >
      {message && <p className="text-[13px] leading-relaxed text-muted">{message}</p>}
      {children}
    </Dialog>
  );
}
