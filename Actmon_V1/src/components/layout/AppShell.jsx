import React from 'react';
import { Outlet } from 'react-router-dom';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export const AppShell = () => {
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
          <Outlet />
        </main>
      </div>
    </FluentProvider>
  );
};
