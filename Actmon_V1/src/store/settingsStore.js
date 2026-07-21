import { create } from 'zustand';

/**
 * Dynamic UI settings — persisted to localStorage and applied LIVE by overriding
 * the Tailwind-v4 brand CSS variables on :root. Because the whole design system
 * maps `brand-*` classes to these vars, changing them re-themes the app instantly.
 */
const KEY = 'actmon_ui_settings';

const DEFAULTS = {
  theme: 'light',          // light | dim | dark | system
  accent: '#0078D4',
  sidebarStyle: 'slate',   // slate | midnight | ocean | match
  sidebarColor: '',        // custom sidebar hex — overrides sidebarStyle when set ('' = use preset)
  topbarColor: '#FFFFFF',  // top bar background color (text/border auto-picked for contrast)
  fontScale: 'default',    // compact | default | large  → interface size
  fontStyle: 'system',     // system | rounded | serif | mono
  radius: 'default',       // sharp | default | round
  contrast: false,         // high-contrast text
  density: 'comfortable',  // comfortable | compact
  sidebarLabels: true,     // false → icon-only sidebar (hide menu names)
  brightness: 100,         // screen brightness % (50 = dim .. 150 = bright), applied as a CSS filter
  reduceMotion: false,
  toasts: true,
  refreshInterval: 30,     // seconds
  retention: 90,           // days
  autoDiscovery: true,
};

const FONT_SCALE = { compact: '15px', default: '17px', large: '19px' };
const FONT_FAMILY = {
  system:  '"Segoe UI", system-ui, -apple-system, sans-serif',
  rounded: 'ui-rounded, "Segoe UI", system-ui, sans-serif',
  serif:   'ui-serif, Georgia, "Times New Roman", serif',
  mono:    'ui-monospace, "Cascadia Code", Consolas, monospace',
};
const SIDEBAR_STYLES = {
  slate:    ['#201F1E', '#323130'],
  midnight: ['#0b1220', '#1e293b'],
  ocean:    ['#0f2438', '#16324b'],
};

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}

const hexToRgb = (hex) => {
  const h = String(hex).replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(f, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const clamp = (c) => Math.round(Math.min(255, Math.max(0, c)));
const toHex = (r, g, b) => `#${[r, g, b].map((x) => clamp(x).toString(16).padStart(2, '0')).join('')}`;
const shade = (hex, pct) => { const [r, g, b] = hexToRgb(hex); const f = (c) => c + (pct < 0 ? c * pct : (255 - c) * pct); return toHex(f(r), f(g), f(b)); };
const tint = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };

const THEMES = {
  light: { bg: '#F3F2F1', surface: '#FFFFFF', textP: '#323130', textS: '#605E5C', border: '#EDEBE9', sidebar: '#201F1E', sidebarHover: '#323130' },
  dim:   { bg: '#1e293b', surface: '#273449', textP: '#e2e8f0', textS: '#94a3b8', border: '#334155', sidebar: '#0f172a', sidebarHover: '#1e293b' },
  dark:  { bg: '#0b1220', surface: '#111a2b', textP: '#e5edf7', textS: '#93a2b8', border: '#1e2b40', sidebar: '#070d18', sidebarHover: '#16223a' },
};

function resolveTheme(theme) {
  if (theme === 'system') {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
    catch { return 'light'; }
  }
  return theme;
}

export function applySettings(s) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const themeKey = resolveTheme(s.theme);        // resolve "system" → light/dark
  const t = THEMES[themeKey] || THEMES.light;
  const set = (k, v) => root.style.setProperty(k, v);
  // accent → primary family
  set('--color-primary', s.accent);
  set('--color-primary-hover', shade(s.accent, -0.15));
  set('--color-primary-light', tint(s.accent, 0.16));
  set('--color-info', s.accent);
  set('--color-sidebar-active', tint(s.accent, 0.18));
  set('--ac', s.accent);
  // theme → surfaces / text / chrome
  set('--color-bg', t.bg);
  set('--color-surface', t.surface);
  set('--color-text-primary', s.contrast ? (themeKey === 'light' ? '#000000' : '#ffffff') : t.textP);
  set('--color-text-secondary', t.textS);
  set('--color-border', t.border);
  set('--color-sidebar', t.sidebar);
  set('--color-sidebar-hover', t.sidebarHover);
  // sidebar style — explicit dark palette (overrides the theme's sidebar color)
  let sb = SIDEBAR_STYLES[s.sidebarStyle];
  if (s.sidebarStyle === 'match') sb = [shade(s.accent, -0.62), shade(s.accent, -0.45)];
  if (sb) { set('--color-sidebar', sb[0]); set('--color-sidebar-hover', sb[1]); }
  // custom sidebar colour overrides the preset when set
  if (s.sidebarColor) { set('--color-sidebar', s.sidebarColor); set('--color-sidebar-hover', shade(s.sidebarColor, 0.14)); }
  // topbar colour — background + auto-contrast text/border
  const topbar = s.topbarColor || '#FFFFFF';
  const [tr, tg, tb] = hexToRgb(topbar);
  const lum = 0.299 * tr + 0.587 * tg + 0.114 * tb;   // perceived brightness 0–255
  set('--color-topbar', topbar);
  set('--color-topbar-text', lum > 150 ? '#323130' : '#ffffff');
  set('--color-topbar-border', lum > 150 ? '#EDEBE9' : 'rgba(255,255,255,0.14)');
  // interface size → root font-size (scales all rem-based spacing/text)
  root.style.fontSize = FONT_SCALE[s.fontScale] || FONT_SCALE.default;
  // font style → applied to the whole UI
  if (document.body) document.body.style.fontFamily = FONT_FAMILY[s.fontStyle] || FONT_FAMILY.system;
  root.dataset.theme = themeKey;                 // resolved theme drives the dark CSS layer
  root.dataset.density = s.density;
  root.dataset.radius = s.radius || 'default';   // corner roundness (see index.css)
  root.dataset.contrast = s.contrast ? 'on' : 'off';
  root.classList.toggle('reduce-motion', !!s.reduceMotion);
  // brightness → whole-app filter (clamped 50–150%); 100 = untouched
  const b = Math.min(150, Math.max(50, Number(s.brightness) || 100));
  if (document.body) document.body.style.filter = b === 100 ? '' : `brightness(${b}%)`;
}

// keep "system" theme in sync with the OS setting
if (typeof window !== 'undefined' && window.matchMedia) {
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const st = useSettingsStore.getState();
      if (st.theme === 'system') applySettings(st);
    });
  } catch (_) {}
}

const persist = (data) => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (_) {} };

export const useSettingsStore = create((set, get) => ({
  ...load(),
  update: (patch) => {
    const { update, reset, ...data } = { ...get(), ...patch };
    persist(data);
    applySettings(data);
    set(patch);
  },
  reset: () => {
    persist(DEFAULTS);
    applySettings(DEFAULTS);
    set({ ...DEFAULTS });
  },
}));

// apply persisted settings immediately on load
applySettings(useSettingsStore.getState());
