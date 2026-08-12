import { useState } from 'react';
import Tabs from '@/components/ui/Tabs';
import {
  ThemeSection, ColourSection, ChartsSection, TypographySection, ShapeSpacingSection,
  PageHeaderSection, SidebarSection, TopBarLayoutSection, AccessibilitySection, ConfigSection,
} from '@/components/appearance/AppearancePanel';
import DashboardChartsSection from '@/components/appearance/DashboardChartsSection';

const TABS = [
  { id: 'theme', label: 'Theme', icon: 'sun' },
  { id: 'colour', label: 'Colour', icon: 'palette' },
  { id: 'charts', label: 'Charts', icon: 'chart-bar' },
  { id: 'typography', label: 'Typography', icon: 'type' },
  { id: 'shape', label: 'Shape & Spacing', icon: 'layers' },
  { id: 'dashboard-charts', label: 'Dashboard Charts', icon: 'dashboard' },
  { id: 'page-header', label: 'Page Header', icon: 'table' },
  { id: 'sidebar', label: 'Sidebar', icon: 'rows' },
  { id: 'topbar', label: 'Top Bar & Layout', icon: 'table' },
  { id: 'accessibility', label: 'Accessibility', icon: 'eye' },
  { id: 'config', label: 'Configuration', icon: 'save' },
];

const PANELS = {
  theme: ThemeSection,
  colour: ColourSection,
  charts: ChartsSection,
  typography: TypographySection,
  shape: ShapeSpacingSection,
  'dashboard-charts': DashboardChartsSection,
  'page-header': PageHeaderSection,
  sidebar: SidebarSection,
  topbar: TopBarLayoutSection,
  accessibility: AccessibilitySection,
  config: ConfigSection,
};

/**
 * Appearance, organized exactly like Notifications — a horizontal sub-tab
 * strip (same Tabs component, same active-underline, same overflow-scroll
 * behavior), each tab's controls in one card below it, nothing else on the
 * page. Every tab renders one of AppearancePanel.jsx's named section
 * components — the quick drawer still renders all eleven at once from the
 * same components, so there's still exactly one definition of what each
 * control does; this page only changes how they're browsed.
 */
export default function AppearanceSettingsSection() {
  const [tab, setTab] = useState('theme');
  const Active = PANELS[tab];

  return (
    <div className="space-y-gutter">
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <section className="card p-card">
        {/* Each section lays its own controls out as a grid of tiles
            (Tile.jsx) that fills the available width — more tiles per row
            as the viewport widens, rather than either stretching a lone
            control edge-to-edge or capping the whole card to a narrow
            column and leaving the rest empty. */}
        <Active />
      </section>
    </div>
  );
}
