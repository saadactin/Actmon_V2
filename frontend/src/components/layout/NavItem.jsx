import { NavLink } from 'react-router-dom';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Tooltip from '@/components/ui/Tooltip';
import Badge, { LiveBadge } from '@/components/ui/Badge';
import { useUIStore } from '@/store/uiStore';
import { useThemeStore } from '@/theme/themeStore';

/* ── nav style variants ───────────────────────────────────────────────────
   How an active row is drawn is a user setting (Appearance → Nav item style),
   so each variant is a pair of class strings instead of being baked in. */
const STYLE = {
  pill: {
    base: 'rounded-control',
    idle: 'text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-fg',
    active: 'bg-sidebar-active text-sidebar-active-fg',
    marker: false,
  },
  bar: {
    base: 'rounded-r-control',
    idle: 'text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-fg',
    active: 'bg-sidebar-active text-sidebar-active-fg',
    marker: true,
  },
  block: {
    base: 'rounded-none',
    idle: 'text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-fg',
    active: 'bg-sidebar-active text-sidebar-active-fg',
    marker: true,
  },
  minimal: {
    base: 'rounded-control',
    idle: 'text-sidebar-muted hover:text-sidebar-fg',
    active: 'text-sidebar-active-fg font-semibold',
    marker: false,
  },
};

function ItemBadge({ badge }) {
  if (!badge) return null;
  if (badge === 'live') return <LiveBadge />;
  if (typeof badge === 'number') {
    return <Badge tone="danger" size="xs">{badge > 99 ? '99+' : badge}</Badge>;
  }
  return <Badge tone="accent" size="xs">{badge}</Badge>;
}

/**
 * One sidebar row.
 *
 * Alignment contract, shared with the rail header and the account block:
 *   • the row itself is inset by NAV_ROW_PAD from the nav container
 *   • the glyph sits in a fixed 28px box (ICON_BOX), so labels start on the
 *     same x for every item regardless of how wide the icon's artwork is
 *   • collapsed mode centres that same 28px box in the rail
 * Any change here must be mirrored in Sidebar.jsx's header/footer rows.
 */
export const ICON_BOX = 'h-7 w-7'; // 28px — matches the brand mark and avatar
export const NAV_ROW_PAD = 'px-2';

export default function NavItem({ item, collapsed }) {
  const s = STYLE[useThemeStore((st) => st.navStyle)] || STYLE.pill;
  const closeMobileNav = useUIStore((st) => st.closeMobileNav);

  const row = (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={closeMobileNav}
      title={undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex h-10 w-full items-center text-sm font-medium',
          'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
          collapsed ? 'justify-center px-0' : `gap-2.5 ${NAV_ROW_PAD}`,
          s.base,
          isActive ? s.active : s.idle,
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* edge marker for the `bar` / `block` styles */}
          {s.marker && isActive && (
            <span className="absolute top-1/2 left-0 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-sidebar-marker" />
          )}

          <span className={cn('grid shrink-0 place-items-center', ICON_BOX)}>
            <Icon name={item.icon} size={18} />
          </span>

          {!collapsed && (
            <>
              {/* truncate-safe, not truncate: a tight line-height would clip the
                  descenders in "Agents" and "Logs" */}
              <span className="truncate-safe min-w-0 flex-1">{item.label}</span>
              <ItemBadge badge={item.badge} />
            </>
          )}
        </>
      )}
    </NavLink>
  );

  // The tooltip anchor is inline-flex, so it needs w-full or the collapsed row
  // would shrink to its content and stop being centred in the rail.
  return collapsed
    ? <Tooltip label={item.label} side="right" className="w-full">{row}</Tooltip>
    : row;
}
