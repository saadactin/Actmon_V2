import { useState } from 'react';
import PageHeader from '@/components/layout/PageHeader';
import Button from '@/components/ui/Button';
import Tabs from '@/components/ui/Tabs';
import AppearanceSettingsSection from './AppearanceSettingsSection';
import NotificationsSettingsSection from './NotificationsSettingsSection';
import { useThemeStore } from '@/theme/themeStore';

const TOP_TABS = [
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
];

/**
 * Settings.
 *
 * Both top-level tabs share the same shape: a sub-tab strip over a handful
 * of focused cards, rather than one long scroll. Appearance's sub-tabs
 * (AppearanceSettingsSection.jsx) render the same named section components
 * AppearancePanel.jsx's quick-drawer version uses — one definition, two
 * entry points, so they can never disagree about what is configurable.
 *
 * Notifications covers SMTP + all 9 alert channels + severity routing — see
 * NotificationsSettingsSection.jsx.
 */
export default function SettingsPage() {
  const a = useThemeStore();
  const [tab, setTab] = useState('appearance');

  return (
    <>
      <PageHeader
        title="Settings"
        icon="settings"
        description={
          tab === 'appearance'
            ? 'Appearance, charts and dashboard styles — applied instantly, saved to this browser'
            : 'Alert delivery — SMTP, the 9 notification channels and severity-based routing'
        }
        actions={
          tab === 'appearance' && (
            <Button variant="secondary" icon="refresh" onClick={a.reset}>
              Reset to defaults
            </Button>
          )
        }
      />

      <Tabs tabs={TOP_TABS} value={tab} onChange={setTab} className="mb-gutter-lg" />

      {tab === 'appearance' ? <AppearanceSettingsSection /> : <NotificationsSettingsSection />}
    </>
  );
}
