import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';

/**
 * The full-screen chrome every setup / registration flow sits in.
 *
 * These pages take over the content area rather than sitting under a page header,
 * so they can't use <PageHeader> — but they were each rolling their own frame, and
 * the frames had drifted:
 *
 *   AgentSetupPage         h-screen  + overflow-hidden
 *   AddWebsiteWizard       h-screen  + overflow-hidden + pb-16
 *   AddNetworkCheckWizard  min-h-screen, no pb
 *   SetupWizard / Deploy   min-h-full + pb-16
 *
 * `h-screen` is wrong here: the shell's content area already starts below the top
 * bar, so a viewport-height child overflows it and the footer ends up cut off or
 * behind a second scrollbar. `min-h-full` is the correct measure, and defining it
 * once means no page can drift again.
 *
 *   title / mark   the header bar identity
 *   aside          optional left branding panel (logo + blurb)
 *   footer         the action bar; use <WizardFooter> for the standard buttons
 *   onClose        the X — route it through the exit guard, not straight to navigate
 */
export default function WizardShell({
  title,
  mark,
  onClose,
  closeLabel = 'Close',
  aside,
  footer,
  children,
  className,
}) {
  return (
    <div
      className={cn(
        // Bleed to the edges of the content area and stand its full height. The
        // negative margins cancel the shell's own padding; see AppShell.
        '-mx-6 -mb-6 flex min-h-full flex-col bg-surface md:-mx-8 md:-mb-8',
        className,
      )}
    >
      {/* Header bar */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {mark || (
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent text-accent-fg">
              <Icon name="zap" size={16} />
            </span>
          )}
          <span className="truncate-safe text-lg font-bold text-fg">{title}</span>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
            className="grid h-8 w-8 place-items-center rounded-control text-subtle transition-colors hover:bg-sunken hover:text-fg"
          >
            <Icon name="close" size={20} />
          </button>
        )}
      </div>

      {/* Body: optional branding panel + content */}
      <div className="flex min-h-0 flex-1">
        {aside && (
          <aside className="hidden w-[340px] shrink-0 flex-col border-r border-border px-8 py-10 lg:flex">
            {aside}
          </aside>
        )}
        <section className="flex min-w-0 flex-1 flex-col">{children}</section>
      </div>

      {footer}
    </div>
  );
}

/**
 * The standard wizard action bar.
 *
 * Every wizard had its own copy with the buttons in a different order and a
 * different idea of when Previous exists. Here: help on the left, then Cancel,
 * Previous and the primary action — and Previous is ALWAYS present, because a
 * control that appears on step 2 but not step 1 reads as a rendering fault. On the
 * first step it leaves the wizard, which is why it must go through the same
 * confirmation as Cancel.
 */
export function WizardFooter({
  onBack,
  backLabel = 'Back',
  onCancel,
  cancelLabel = 'Cancel',
  onNext,
  nextLabel = 'Next',
  nextDisabled = false,
  onFinish,
  finishLabel = 'Finish',
  finishIcon = 'check',
  finishing = false,
  help,
}) {
  const finishMode = Boolean(onFinish);
  const primary = finishMode
    ? { onClick: onFinish, label: finishLabel, icon: finishing ? 'spinner' : finishIcon, busy: finishing }
    : { onClick: onNext, label: nextLabel, icon: null, busy: false };

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-4">
      {help || <span />}
      <div className="ml-auto flex items-center gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="h-9 rounded-control px-4 text-[13px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
          >
            {cancelLabel}
          </button>
        )}
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="h-9 rounded-control border border-border px-4 text-[13px] font-semibold text-fg transition-colors hover:bg-sunken"
          >
            {backLabel}
          </button>
        )}
        <button
          type="button"
          onClick={primary.onClick}
          disabled={nextDisabled || primary.busy}
          className={cn(
            'flex h-9 items-center gap-2 rounded-control px-5 text-[13px] font-bold transition-colors',
            finishMode
              ? 'bg-success text-white hover:opacity-90'
              : 'bg-accent text-accent-fg hover:bg-accent-hover',
            'disabled:pointer-events-none disabled:opacity-40',
          )}
        >
          {primary.icon && (
            <Icon name={primary.icon} size={15} className={primary.busy ? 'animate-spin' : undefined} />
          )}
          {primary.label}
        </button>
      </div>
    </div>
  );
}
