/**
 * APP CONFIG — product-level knobs that are not per-user appearance.
 *
 * Anything branding- or deployment-related belongs here so a white-label build
 * only needs this one file (plus VITE_* env overrides) changed.
 */

const env = import.meta.env;

export const APP = {
  /* ── branding ── */
  name: env.VITE_APP_NAME || 'ActMon',
  shortName: env.VITE_APP_SHORT_NAME || 'AM',
  tagline: env.VITE_APP_TAGLINE || 'Unified Observability',
  company: env.VITE_APP_COMPANY || 'Actin Technologies',
  version: env.VITE_APP_VERSION || '1.1.0',
  /** Logo: the real ActMon mark by default (public/actmon-logo.png) — override
      via VITE_APP_LOGO for a white-label build, or set both to '' to fall
      back to the drawn inline mark in LogoMark.jsx. */
  logoUrl: env.VITE_APP_LOGO || '/actmon-logo.png',
  /** ActMon AI's mark. Point this at the Figma export (e.g. /actmon-ai.svg
      dropped in public/) and it replaces the drawn fallback everywhere. */
  aiLogoUrl: env.VITE_APP_AI_LOGO || '',
  logoIcon: 'activity', // lucide name used when logoUrl is empty

  /* ── api ── */
  apiBase: env.VITE_API_BASE || '/api/v1',
  requestTimeout: Number(env.VITE_API_TIMEOUT || 30000),

  /* ── behaviour ── */
  defaultRoute: '/dashboard',
  loginRoute: '/login',
  /** Poll interval (seconds) for live pages — user-overridable in Settings. */
  refreshInterval: Number(env.VITE_REFRESH_INTERVAL || 30),

  /* ── chrome toggles (build-time; per-user prefs live in themeStore) ── */
  features: {
    search: true,
    notifications: true,
    chatbot: true,
    appearancePanel: true,
    quickThemeToggle: true,
    fullscreen: true,
    helpMenu: true,
  },
};

/** Keyboard shortcuts — single source so the help sheet and handlers agree. */
export const SHORTCUTS = {
  search: { keys: ['ctrl', 'k'], label: 'Open search' },
  toggleNav: { keys: ['ctrl', 'b'], label: 'Hide / show menu bar' },
  toggleTheme: { keys: ['ctrl', 'shift', 'l'], label: 'Switch light / dark' },
  appearance: { keys: ['ctrl', 'shift', ','], label: 'Open appearance' },
};

export default APP;
