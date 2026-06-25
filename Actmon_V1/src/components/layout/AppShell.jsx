import React, { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import RouteGuard from '../../auth/RouteGuard';
import { usePermissions } from '../../hooks/usePermissions';

// Floating AI widget — not needed for first paint, so load it as its own chunk.
const ChatbotWidget = React.lazy(() => import('../../pages/chatbot/ChatbotWidget'));

// Lightweight fallback shown while a lazy page chunk downloads (content area only —
// the sidebar/topbar stay painted, so navigation feels instant).
const PageLoader = () => (
  <div className="w-full h-full min-h-[300px] flex items-center justify-center">
    <div className="w-8 h-8 border-[3px] border-slate-200 border-t-blue-600 rounded-full animate-spin" />
  </div>
);

export const AppShell = () => {
  const { can } = usePermissions();
  // ActMon AI is only available to roles granted View on the ChatBot page.
  const canChat = can('/chatbot', 'view');
  return (
    <FluentProvider theme={webLightTheme} className="h-screen bg-brand-bg flex overflow-hidden">
      {/* Sidebar — fixed height, never scrolls with content */}
      <Sidebar />

      {/* Main Content Area — only this column scrolls */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* TopBar Header */}
        <TopBar />

        {/* Dynamic Page Outlet — scrollable content area */}
        <main className="flex-1 overflow-x-hidden overflow-y-auto p-6 md:p-8">
          <RouteGuard>
            <Suspense fallback={<PageLoader />}>
              <Outlet />
            </Suspense>
          </RouteGuard>
        </main>
      </div>

      {/* ActMon AI — global floating chatbot widget (only if the role can view ChatBot) */}
      {canChat && <Suspense fallback={null}><ChatbotWidget /></Suspense>}
    </FluentProvider>
  );
};
