import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import { APP } from '@/config/app.config';
import { ICON_BOX } from './NavItem';

/**
 * Product mark + wordmark.
 *
 * The mark uses the same 28px box as nav icons and the account avatar, so the
 * rail has one glyph column running top to bottom. Uses APP.logoUrl when a
 * deployment supplies one, otherwise an accent-tinted glyph — a white-label
 * build needs no asset at all.
 */
export default function Brand({ collapsed = false, className, tone = 'sidebar' }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <span
        className={cn('grid shrink-0 place-items-center rounded-md text-accent-fg', ICON_BOX)}
        style={{ background: 'var(--gradient-accent)' }}
      >
        {APP.logoUrl
          ? <img src={APP.logoUrl} alt="" className="h-4 w-4 object-contain" />
          : <Icon name={APP.logoIcon} size={17} strokeWidth={2.4} />}
      </span>

      {!collapsed && (
        <span className="min-w-0">
          <span
            className={cn(
              'truncate-safe block text-[15px] font-bold tracking-tight',
              tone === 'sidebar' ? 'text-sidebar-fg' : 'text-fg',
            )}
          >
            {APP.name}
          </span>
          <span
            className={cn(
              'truncate-safe block text-[9px] font-semibold tracking-[0.09em] uppercase',
              tone === 'sidebar' ? 'text-sidebar-section' : 'text-subtle',
            )}
          >
            {APP.tagline}
          </span>
        </span>
      )}
    </div>
  );
}
