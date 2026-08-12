import { useEffect } from 'react';
import { useThemeStore, applyAppearance, DEFAULT_APPEARANCE, STORAGE_KEY } from './themeStore';

/**
 * Keeps the document in sync with the appearance store.
 *
 * Tokens are already written by themeStore.update(), so this only handles the
 * two cases that happen outside a user action:
 *   1. first mount (hydrating from localStorage)
 *   2. the OS flipping light/dark while theme === 'system'
 *   3. another tab changing appearance (storage event)
 */
export default function ThemeProvider({ children }) {
  const themePref = useThemeStore((s) => s.theme);
  const importAppearance = useThemeStore((s) => s.import);

  // 1. Paint on mount / whenever the stored preference changes.
  useEffect(() => {
    applyAppearance(useThemeStore.getState());
  }, [themePref]);

  // 2. Follow the OS only while the user asked us to.
  useEffect(() => {
    if (themePref !== 'system') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyAppearance(useThemeStore.getState());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [themePref]);

  // 3. Mirror appearance changes made in another tab.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      try {
        importAppearance({ ...DEFAULT_APPEARANCE, ...JSON.parse(e.newValue) });
      } catch {
        /* ignore malformed payloads from other tabs */
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [importAppearance]);

  return children;
}
