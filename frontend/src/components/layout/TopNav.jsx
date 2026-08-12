import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Popover from '@/components/ui/Popover';
import LogoMark from '@/components/brand/LogoMark';
import useNavigation from '@/hooks/useNavigation';
import { useChartKindStore } from '@/components/charts/chartKinds';
import { useUIStore } from '@/store/uiStore';
import { useThemeStore, resolveThemeId } from '@/theme/themeStore';
import { THEME_MODE } from '@/theme/presets';
import { APP, SHORTCUTS } from '@/config/app.config';

/**
 * The module bar — brand, the eleven modules, the account.
 *
 * Every measurement (height, padding, icon size, label size, ink) comes from the
 * `--topnav-*` tokens, so the bar is retuned in styles/tokens.css rather than
 * here, and the same markup renders at any density or scale. The item list comes
 * from useNavigation(), which is the RBAC-filtered server menu once login has
 * landed and the static config before that.
 *
 * The bar renders OUTSIDE the scrolling <main> (see AppShell), so it holds its
 * place without `position: fixed` and without a content offset to keep in sync.
 */
export default function TopNav({ user, onSignOut }) {
  const items = useNavigation();

  return (
    <header
      className="z-30 flex shrink-0 items-center justify-between gap-4 bg-topnav text-topnav-fg"
      style={{
        height: 'var(--topnav-h)',
        paddingInline: 'var(--topnav-pad-x)',
        paddingBlock: 'var(--topnav-pad-y)',
      }}
    >
      <BrandMark />

      {/* Scrolls rather than crushes: eleven stacked items need ~1200px, and the
          alternative to a scroll strip is labels truncating to nothing. */}
      <nav
        aria-label="Modules"
        className="no-scrollbar flex min-w-0 flex-1 items-center justify-center overflow-x-auto"
        style={{ gap: 'var(--topnav-item-gap)' }}
      >
        {items.map((item) => <TopNavItem key={item.to} item={item} />)}
      </nav>

      <AccountMenu user={user} onSignOut={onSignOut} />
    </header>
  );
}

/* ── brand ────────────────────────────────────────────────────────────────── */

/**
 * The product mark. See LogoMark for the drawing itself (and its
 * VITE_APP_LOGO override) — this just places it as the home link.
 */
function BrandMark() {
  return (
    <NavLink
      to="/dashboard"
      aria-label={`${APP.name} home`}
      className="grid shrink-0 place-items-center rounded-md transition-opacity hover:opacity-85"
      style={{ width: 'var(--topnav-brand)', height: 'var(--topnav-brand)' }}
    >
      <LogoMark size={48} />
    </NavLink>
  );
}

/* ── one module ───────────────────────────────────────────────────────────── */

/**
 * Icon over label, the active one in white.
 *
 * `end` is false so a module stays lit while you are deeper inside it — on
 * /agents/deploy the Agents item is still the one you are in. Dashboard is the
 * exception and matches exactly, since every route would otherwise be "under" it
 * if it were ever mounted at "/".
 */
function TopNavItem({ item }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/dashboard'}
      className={({ isActive }) => cn(
        'group relative flex shrink-0 flex-col items-center rounded-md py-1 transition-colors',
        isActive ? 'text-topnav-fg' : 'text-topnav-muted hover:text-topnav-fg',
      )}
      style={{
        gap: 'var(--topnav-stack-gap)',
        paddingInline: 'var(--topnav-item-pad-x)',
      }}
    >
      {({ isActive }) => (
        <>
          <span className="relative grid place-items-center">
            {/* size= sets the SVG's width/height ATTRIBUTES, which cannot take a
                var(); the style overrides them so the token still drives it. */}
            <Icon
              name={item.icon}
              size={26}
              strokeWidth={1.6}
              style={{ width: 'var(--topnav-icon)', height: 'var(--topnav-icon)' }}
            />
            {/* Live count, e.g. firing alerts. Nothing renders unless something
                sets a badge, so the bar matches the design at rest. */}
            {item.badge ? (
              <span className="absolute -top-1.5 -right-2 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-white tabular-nums">
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            ) : null}
          </span>
          <span
            className={cn('leading-none whitespace-nowrap', isActive ? 'font-semibold' : 'font-normal')}
            style={{ fontSize: 'var(--topnav-label)' }}
          >
            {item.label}
          </span>
        </>
      )}
    </NavLink>
  );
}

/* ── account ──────────────────────────────────────────────────────────────── */

/** Initials from a display name, max two letters. */
const initialsOf = (name) =>
  String(name || 'User')
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || 'U';

const fmtKeys = (keys) =>
  keys.map((k) => (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join('+');

/**
 * Avatar over "Profile", opening the account menu.
 *
 * This menu is where the chrome utilities live now. The bar the design specifies
 * has room for the brand, the modules and one avatar — so search, theme,
 * notifications, appearance, full screen and help moved in here rather than being
 * dropped. Each is still behind its `APP.features` flag, exactly as when they sat
 * in the old top bar, so a deployment that switched one off still sees it gone.
 */
function AccountMenu({ user, onSignOut }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [showKeys, setShowKeys] = useState(false);

  const toggleSearch = useUIStore((s) => s.toggleSearch);
  const openAppearance = useUIStore((s) => s.openAppearance);
  const toggleNav = useUIStore((s) => s.toggleNav);

  // Cards remember a form the reader picked, which is right — but it also means a
  // page can drift away from the form it was designed around, one card at a time,
  // with no single place to undo it. This row is that place, and it only appears
  // when something has actually been overridden.
  const chosenKinds = useChartKindStore((s) => s.chosen);
  const resetKinds = useChartKindStore((s) => s.reset);
  const overrideCount = Object.keys(chosenKinds).length;

  const themePref = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const isDark = THEME_MODE[resolveThemeId(themePref)] === 'dark';

  {/* This shell only ever mounts once App.jsx has confirmed a token (see
      RequireAuth in App.jsx) — `user` being momentarily unset means its
      identity is still resolving via GET /auth/me, never "signed out". A
      fabricated "name@actmon.local" here would look like real data; "Loading…"
      doesn't. */}
  const name = user?.employee_name || user?.username || 'Loading…';
  const email = user?.email || (user ? '—' : 'Loading…');
  const role = user?.role || user?.role_name || (user ? 'No role' : 'Loading…');
  const avatar = user?.avatar_url || user?.photo_url;

  const [full, setFull] = useState(false);
  useEffect(() => {
    const onChange = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const close = () => { setOpen(false); setShowKeys(false); };
  const run = (fn) => () => { close(); fn?.(); };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex flex-col items-center rounded-md text-topnav-fg transition-opacity hover:opacity-85"
        style={{ gap: 'var(--topnav-stack-gap)', paddingInline: 'var(--topnav-item-pad-x)' }}
      >
        <span
          className="grid shrink-0 place-items-center overflow-hidden rounded-full bg-white/10 text-[13px] font-bold ring-2 ring-white/70"
          style={{ width: 'var(--topnav-avatar)', height: 'var(--topnav-avatar)' }}
        >
          {avatar
            ? <img src={avatar} alt="" className="h-full w-full object-cover" />
            : initialsOf(name)}
        </span>
        <span className="leading-none font-semibold whitespace-nowrap" style={{ fontSize: 'var(--topnav-label)' }}>
          Profile
        </span>
      </button>

      <Popover open={open} onClose={close} width={286}>
        <div className="border-b border-border px-3.5 py-3">
          <p className="truncate-safe text-[13px] font-bold text-fg">{name}</p>
          <p className="truncate-safe text-[11px] text-subtle">{email}</p>
          <p className="truncate-safe mt-1 text-[11px] font-semibold text-accent-text">{role}</p>
        </div>

        <div className="p-1.5">
          {APP.features.search && (
            <MenuRow icon="search" label="Search" hint={fmtKeys(SHORTCUTS.search.keys)} onClick={run(toggleSearch)} />
          )}
          {APP.features.quickThemeToggle && (
            <MenuRow
              icon={isDark ? 'sun' : 'moon'}
              label={isDark ? 'Light theme' : 'Dark theme'}
              hint={fmtKeys(SHORTCUTS.toggleTheme.keys)}
              onClick={toggleTheme}
            />
          )}
          {APP.features.appearancePanel && (
            <MenuRow icon="palette" label="Appearance" hint={fmtKeys(SHORTCUTS.appearance.keys)} onClick={run(openAppearance)} />
          )}
          {APP.features.fullscreen && (
            <MenuRow
              icon={full ? 'collapse' : 'expand'}
              label={full ? 'Exit full screen' : 'Full screen'}
              onClick={() => {
                if (document.fullscreenElement) document.exitFullscreen?.();
                else document.documentElement.requestFullscreen?.();
              }}
            />
          )}
          {overrideCount > 0 && (
            <MenuRow
              icon="refresh"
              label="Reset chart types"
              hint={String(overrideCount)}
              onClick={run(() => resetKinds())}
            />
          )}
          <MenuRow
            icon="collapse"
            label="Hide menu bar"
            hint={fmtKeys(SHORTCUTS.toggleNav.keys)}
            onClick={run(toggleNav)}
          />
          <MenuRow icon="settings" label="Settings" onClick={run(() => navigate('/settings'))} />
        </div>

        {APP.features.helpMenu && (
          <div className="border-t border-border p-1.5">
            <MenuRow
              icon="help"
              label="Keyboard shortcuts"
              trailing={<Icon name={showKeys ? 'chevron-down' : 'chevron-right'} size={13} className="text-subtle" />}
              onClick={() => setShowKeys((v) => !v)}
            />
            {showKeys && (
              <div className="space-y-1.5 px-2 pt-1 pb-2">
                {Object.values(SHORTCUTS).map((s) => (
                  <div key={s.label} className="flex items-center justify-between gap-3">
                    <span className="text-[12px] text-muted">{s.label}</span>
                    <span className="shrink-0 text-[10px] font-semibold text-fg">{fmtKeys(s.keys)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="border-t border-border p-1.5">
          <MenuRow icon="logout" label="Sign out" tone="danger" onClick={run(onSignOut)} />
        </div>

        <div className="border-t border-border px-3.5 py-2 text-[11px] font-semibold text-subtle">
          {APP.name} v{APP.version} · {APP.company}
        </div>
      </Popover>
    </div>
  );
}

function MenuRow({ icon, label, hint, trailing, tone, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-sunken',
        tone === 'danger' ? 'text-danger-fg' : 'text-fg',
      )}
    >
      <Icon name={icon} size={15} className={cn('shrink-0', tone === 'danger' ? undefined : 'text-subtle')} />
      <span className="truncate-safe min-w-0 flex-1 text-[12px] font-semibold">{label}</span>
      {hint && <span className="shrink-0 text-[10px] font-semibold text-subtle">{hint}</span>}
      {trailing}
    </button>
  );
}
