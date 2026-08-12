import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import { useUIStore } from '@/store/uiStore';
import { useThemeStore } from '@/theme/themeStore';
import { THEMES } from '@/theme/presets';
import AppearancePanel from './AppearancePanel';

/**
 * The quick appearance drawer — the same controls the Settings page shows, in a
 * side sheet. Everything lives in <AppearancePanel /> so the two can't drift.
 *
 * Controls write straight to the appearance store, which recomputes the CSS
 * variables and repaints instantly — no "apply" step, and no page needs to know
 * a setting changed.
 */
export default function AppearanceDrawer() {
  const open = useUIStore((s) => s.appearanceOpen);
  const close = useUIStore((s) => s.closeAppearance);
  const a = useThemeStore();

  return (
    <Drawer
      open={open}
      onClose={close}
      title="Appearance"
      subtitle="Changes apply instantly and are saved to this browser"
      icon="palette"
      width={400}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-subtle">
            {THEMES.find((t) => t.id === a.theme)?.label} · {a.accent}
          </span>
          <button
            type="button"
            onClick={a.reset}
            className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border px-3 text-[12px] font-semibold text-fg transition-colors hover:bg-sunken"
          >
            <Icon name="refresh" size={13} />
            Reset to defaults
          </button>
        </div>
      }
    >
      <AppearancePanel />
    </Drawer>
  );
}
