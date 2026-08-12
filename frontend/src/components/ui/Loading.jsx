import cn from '@/lib/cn';

/**
 * LOADING STATES — one definition, so waiting looks the same everywhere.
 *
 * These pages had grown ~100 hand-rolled spinner blocks, and the full-page ones
 * painted their own dark gradient slab (`linear-gradient(135deg,#0f172a …)`) with
 * light text on it. In a light theme that reads as a broken page rather than a
 * page that is loading, and it ignores the operator's theme, accent and density
 * completely.
 *
 * Everything here is token-driven, so a loading state inherits the current theme
 * and accent like the rest of the app.
 *
 *   <Spinner />                       the primitive
 *   <PageLoading title subtitle />    a whole page or tab with nothing to show yet
 *   <InlineLoading label />           a panel, table or card area
 */

const SIZES = { sm: 'h-4 w-4 border-2', md: 'h-6 w-6 border-2', lg: 'h-10 w-10 border-[3px]' };

/** Ring spinner. The track is the border colour, the head is the accent. */
export function Spinner({ size = 'md', className }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block animate-spin rounded-full border-border',
        SIZES[size] || SIZES.md,
        className,
      )}
      style={{ borderTopColor: 'var(--accent)' }}
    />
  );
}

/**
 * A page or tab that has nothing to render yet.
 *
 * Sits in the content flow on the page background — it does NOT take over the
 * viewport. A loader that covers the screen hides the chrome the operator uses to
 * navigate away, which is the wrong thing to do while they wait.
 */
export function PageLoading({ title = 'Loading…', subtitle, className, minHeight = 320 }) {
  return (
    <div
      className={cn('grid w-full place-items-center', className)}
      style={{ minHeight }}
      aria-live="polite"
    >
      <div className="text-center">
        <Spinner size="lg" className="mx-auto" />
        <p className="mt-4 text-[15px] font-semibold text-fg">{title}</p>
        {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
      </div>
    </div>
  );
}

/** A panel, table or card that is filling in. Compact, no layout jump. */
export function InlineLoading({ label = 'Loading…', className, size = 'sm' }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-8', className)} aria-live="polite">
      <Spinner size={size} />
      <span className="text-[13px] text-muted">{label}</span>
    </div>
  );
}

export default PageLoading;
