import { create } from 'zustand';

/**
 * Transient shell state — what's open right now.
 * Only the bits worth remembering across reloads are persisted (sidebar collapse
 * and which nav groups are expanded); overlays always start closed.
 */
const KEY = 'actmon.ui';

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      sidebarCollapsed: !!raw.sidebarCollapsed,
      navHidden: !!raw.navHidden,
      openGroups: Array.isArray(raw.openGroups) ? raw.openGroups : [],
    };
  } catch {
    return { sidebarCollapsed: false, navHidden: false, openGroups: [] };
  }
}

function persist(s) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        sidebarCollapsed: s.sidebarCollapsed,
        navHidden: s.navHidden,
        openGroups: s.openGroups,
      }),
    );
  } catch {
    /* non-fatal */
  }
}

const initial = load();

export const useUIStore = create((set, get) => ({
  /* ── sidebar ── */
  sidebarCollapsed: initial.sidebarCollapsed,
  mobileNavOpen: false, // drawer on < lg screens
  openGroups: initial.openGroups, // ids of expanded nav groups

  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    set({ sidebarCollapsed: next });
    persist({ ...get(), sidebarCollapsed: next });
  },
  setSidebarCollapsed: (v) => {
    set({ sidebarCollapsed: !!v });
    persist({ ...get(), sidebarCollapsed: !!v });
  },
  openMobileNav: () => set({ mobileNavOpen: true }),
  closeMobileNav: () => set({ mobileNavOpen: false }),

  /* ── module bar ──
     Hiding it hands ~100px back to the content, which is worth having on a
     laptop screen full of charts. Persisted, because someone who works with it
     hidden should not have to hide it again every morning — and AppShell always
     leaves a way back, since a hidden bar takes every nav link with it. */
  navHidden: initial.navHidden,
  toggleNav: () => {
    const next = !get().navHidden;
    set({ navHidden: next });
    persist({ ...get(), navHidden: next });
  },
  setNavHidden: (v) => {
    set({ navHidden: !!v });
    persist({ ...get(), navHidden: !!v });
  },

  toggleGroup: (id) => {
    const open = get().openGroups;
    const next = open.includes(id) ? open.filter((g) => g !== id) : [...open, id];
    set({ openGroups: next });
    persist({ ...get(), openGroups: next });
  },
  /* ── overlays ── */
  appearanceOpen: false,
  notificationsOpen: false,
  searchOpen: false,
  profileOpen: false,

  openAppearance: () => set({ appearanceOpen: true, notificationsOpen: false, profileOpen: false }),
  closeAppearance: () => set({ appearanceOpen: false }),
  toggleAppearance: () => set((s) => ({ appearanceOpen: !s.appearanceOpen, notificationsOpen: false, profileOpen: false })),

  toggleNotifications: () => set((s) => ({ notificationsOpen: !s.notificationsOpen, profileOpen: false })),
  closeNotifications: () => set({ notificationsOpen: false }),

  toggleSearch: () => set((s) => ({ searchOpen: !s.searchOpen })),
  closeSearch: () => set({ searchOpen: false }),

  toggleProfile: () => set((s) => ({ profileOpen: !s.profileOpen, notificationsOpen: false })),
  closeProfile: () => set({ profileOpen: false }),

  closeAllOverlays: () =>
    set({ appearanceOpen: false, notificationsOpen: false, searchOpen: false, profileOpen: false }),
}));

export default useUIStore;
