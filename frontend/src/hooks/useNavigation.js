import { useMemo } from 'react';
import { create } from 'zustand';
import { MENU_ITEMS, MENU_ORDER, MENU_PRESENTATION } from '@/config/navigation';

/**
 * Menu store.
 *
 * `serverMenu` holds the response from GET /auth/menu once login has run. Until
 * then the static MENU_ITEMS list renders — same names, routes, icons and order,
 * so the rail doesn't reshuffle when the real menu arrives.
 */
export const useMenuStore = create((set) => ({
  serverMenu: null,
  /** @param {Array|null} menu build_menu() output: [{ name, route, icon, children }] */
  setServerMenu: (menu) => set({ serverMenu: menu?.length ? menu : null }),

  /** Live counts keyed by item id, e.g. { alerts: 3 }. */
  badges: {},
  setBadge: (id, value) => set((s) => ({ badges: { ...s.badges, [id]: value } })),
  clearBadges: () => set({ badges: {} }),
}));

/** Server module → nav row. Falls back to the first child's url, as the API allows route to be null. */
const fromServer = (m) => ({
  id: String(m.code || m.name || '').toLowerCase().replace(/\s+/g, '-'),
  label: m.name,
  to: m.route || m.children?.[0]?.url || '#',
  icon: m.icon,
});

// Retired from the bar but still present in module_master, so the server menu
// (GET /auth/menu) can still return them for older roles — drop them here too,
// not just from the static MENU_ITEMS fallback, so they never reappear.
const RETIRED_ROUTES = new Set(['/chatbot', '/ml']);

/** The flat list of rows to render, in MENU_ORDER. */
export default function useNavigation() {
  const serverMenu = useMenuStore((s) => s.serverMenu);
  const badges = useMenuStore((s) => s.badges);

  return useMemo(() => {
    const items = (serverMenu ? serverMenu.map(fromServer) : MENU_ITEMS)
      .filter((i) => !RETIRED_ROUTES.has(i.to));
    // Help Center isn't a row in module_master yet, so the server menu never
    // reports it — force it in exactly like the static MENU_ITEMS list already
    // has it, so the bar doesn't lose the item the moment RBAC data lands.
    const withHelp = items.some((i) => i.to === '/help-center')
      ? items
      : [...items, { id: 'help-center', label: 'Help Center', to: '/help-center', icon: 'help' }];

    // Sort by our own route order so the server menu lands in the same
    // arrangement as the fallback. Unknown routes keep their incoming order and
    // fall to the end (stable, since Array.sort is stable in modern engines).
    const rank = (route) => {
      const i = MENU_ORDER.indexOf(route);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };

    return [...withHelp]
      .sort((a, b) => rank(a.to) - rank(b.to))
      .map((item) => ({
        ...item,
        // the design's label and glyph win over whatever module_master stored
        ...(MENU_PRESENTATION[item.to] || {}),
        badge: badges[item.id] ?? item.badge,
      }));
  }, [serverMenu, badges]);
}
