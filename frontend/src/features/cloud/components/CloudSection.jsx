import cn from '@/lib/cn';

/**
 * Token-styled card wrapper for Cloud page content — replaces the hand-rolled
 * `bg-white rounded-xl border-gray-200 shadow-sm` blocks that used to be
 * copy-pasted per page with the app's shared surface/border/radius tokens.
 */
export default function CloudSection({ title, description, action, className, bodyClassName, children }) {
  return (
    <section className={cn('rounded-card border border-border bg-surface', className)}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 border-b border-border px-card py-3">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-[12px] text-muted">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className={cn('p-card', bodyClassName)}>{children}</div>
    </section>
  );
}
