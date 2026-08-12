import { useState } from 'react';
import { Link } from 'react-router-dom';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Tooltip from '@/components/ui/Tooltip';
import Popover from '@/components/ui/Popover';
import { ICON_BOX, NAV_ROW_PAD } from './NavItem';
import { useUIStore } from '@/store/uiStore';
import { APP } from '@/config/app.config';

/** Initials from a display name, max two letters. */
const initialsOf = (name) =>
  String(name || 'User')
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || 'U';

/**
 * Account block pinned to the bottom of the rail.
 *
 * `user` is passed in rather than read from an auth store so the shell stays
 * usable before auth is wired up — it falls back to a placeholder identity.
 */
export default function SidebarUser({ collapsed, user, onSignOut }) {
  const [open, setOpen] = useState(false);
  const openAppearance = useUIStore((s) => s.openAppearance);

  {/* This rail only ever renders inside the authenticated shell — `user` being
      momentarily unset means its identity is still resolving via GET /auth/me,
      never "signed out". A fabricated "name@actmon.local" would look like real
      data; "Loading…" doesn't. */}
  const name = user?.employee_name || user?.username || 'Loading…';
  const role = user?.role || user?.role_name || (user ? 'No role' : 'Loading…');
  const email = user?.email || (user ? '—' : 'Loading…');
  const org = user?.org_name || APP.company;

  // Same padding + 28px glyph box as a nav row, so the avatar sits in the rail's
  // single glyph column and the name starts where nav labels start.
  const trigger = (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      className={cn(
        'flex h-10 w-full items-center rounded-control text-left',
        'transition-colors duration-[var(--dur-fast)] hover:bg-sidebar-hover',
        collapsed ? 'justify-center px-0' : `gap-2.5 ${NAV_ROW_PAD}`,
      )}
    >
      <span
        className={cn(
          'grid shrink-0 place-items-center rounded-full text-[10px] font-bold text-accent-fg',
          ICON_BOX,
        )}
        style={{ background: 'var(--gradient-accent)' }}
      >
        {initialsOf(name)}
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1">
            <span className="truncate-safe block text-[13px] font-semibold text-sidebar-fg">{name}</span>
            <span className="truncate-safe block text-[11px] text-sidebar-muted">{role}</span>
          </span>
          <Icon name="more" size={15} className="shrink-0 text-sidebar-muted" />
        </>
      )}
    </button>
  );

  return (
    <div className="relative">
      {collapsed
        ? <Tooltip label={`${name} · ${role}`} side="right" className="w-full">{trigger}</Tooltip>
        : trigger}

      {/* Anchored above the trigger since the block sits at the bottom of the rail */}
      <Popover open={open} onClose={() => setOpen(false)} align="left" side="top" width={252}>
        <div className="border-b border-border px-3.5 pt-3.5 pb-3">
          <div className="truncate text-sm font-bold text-fg">{name}</div>
          <div className="truncate text-xs text-subtle">{email}</div>
          <div className="mt-2.5 space-y-1.5">
            <Row label="Organization" value={org} />
            <Row label="Role" value={role} accent />
          </div>
        </div>

        <div className="p-1.5">
          <MenuItem to="/settings" icon="settings" label="Settings" onClick={() => setOpen(false)} />
          <MenuItem
            icon="palette"
            label="Appearance"
            onClick={() => { setOpen(false); openAppearance(); }}
          />
          <MenuItem to="/logs" icon="history" label="My activity" onClick={() => setOpen(false)} />
        </div>

        <div className="border-t border-border p-1.5">
          <MenuItem
            icon="logout"
            label="Sign out"
            tone="danger"
            onClick={() => { setOpen(false); onSignOut?.(); }}
          />
        </div>

        <div className="border-t border-border px-3.5 py-2 text-[10px] font-semibold text-subtle">
          {APP.name} v{APP.version}
        </div>
      </Popover>
    </div>
  );
}

function Row({ label, value, accent }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] font-bold tracking-wide text-subtle uppercase">{label}</span>
      <span
        className={cn(
          'max-w-[140px] truncate text-right text-[11px] font-semibold',
          accent ? 'rounded-full bg-accent-soft px-2 py-0.5 text-accent-text' : 'text-fg',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function MenuItem({ to, icon, label, onClick, tone = 'default' }) {
  const cls = cn(
    'flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-[13px] font-medium transition-colors',
    tone === 'danger'
      ? 'text-danger hover:bg-danger-soft'
      : 'text-fg hover:bg-sunken',
  );
  if (to) {
    return (
      <Link to={to} onClick={onClick} className={cls}>
        <Icon name={icon} size={15} />
        {label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      <Icon name={icon} size={15} />
      {label}
    </button>
  );
}
