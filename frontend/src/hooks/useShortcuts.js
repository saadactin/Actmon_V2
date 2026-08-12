import { useEffect } from 'react';
import { useUIStore } from '@/store/uiStore';
import { useThemeStore } from '@/theme/themeStore';

/** Don't hijack keys while the user is typing. */
const isTyping = (el) =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

/**
 * Global shortcuts for the shell. Definitions live in config/app.config.js
 * (SHORTCUTS) so the help sheet and these handlers can't drift apart.
 */
export default function useShortcuts() {
  useEffect(() => {
    const onKey = (e) => {
      const ui = useUIStore.getState();
      const theme = useThemeStore.getState();

      if (e.key === 'Escape') {
        ui.closeAllOverlays();
        return;
      }

      if (!e.ctrlKey && !e.metaKey) return;
      if (isTyping(e.target) && e.key.toLowerCase() !== 'k') return;

      const key = e.key.toLowerCase();

      if (key === 'k' && !e.shiftKey) {
        e.preventDefault();
        ui.toggleSearch();
      } else if (key === 'b' && !e.shiftKey) {
        e.preventDefault();
        ui.toggleNav();
      } else if (key === 'l' && e.shiftKey) {
        e.preventDefault();
        theme.toggleTheme();
      } else if ((key === ',' || key === '<') && e.shiftKey) {
        e.preventDefault();
        ui.toggleAppearance();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
