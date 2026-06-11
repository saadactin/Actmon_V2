import React from 'react';
import { Outlet } from 'react-router-dom';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export const AppShell = () => {
  return (
    <FluentProvider theme={webLightTheme} className="min-h-screen bg-brand-bg flex">
      {/* Sidebar on the Left */}
      <Sidebar />

      {/* Main Content Area on the Right */}
      <div className="flex-1 flex flex-col min-h-screen min-w-0">
        {/* TopBar Header */}
        <TopBar />

        {/* Dynamic Page Outlet */}
        <main className="flex-1 overflow-x-hidden overflow-y-auto p-6 md:p-8">
          <Outlet />
        </main>
      </div>
    </FluentProvider>
  );
};
