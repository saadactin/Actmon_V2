import React from 'react';
import { CloudDashboard } from '../pages/CloudDashboard';
import { CloudAccountsPage } from '../pages/CloudAccountsPage';
import { ResourcesPage } from '../pages/ResourcesPage';
import { CostPage } from '../pages/CostPage';
import { ResourceDetailPage } from '../pages/ResourceDetailPage';
import { SecurityPosturePage } from '../pages/SecurityPosturePage';
import { CloudTopologyPage } from '../pages/CloudTopologyPage';
import { CompliancePage } from '../pages/CompliancePage';
import { AlertsPage } from '../pages/AlertsPage';

export const cloudRoutes = [
  { path: "/cloud", element: <CloudDashboard /> },
  { path: "/cloud/accounts", element: <CloudAccountsPage /> },
  { path: "/cloud/resources", element: <ResourcesPage /> },
  { path: "/cloud/resources/:resourceId", element: <ResourceDetailPage /> },
  { path: "/cloud/cost", element: <CostPage /> },
  { path: "/cloud/security", element: <SecurityPosturePage /> },
  { path: "/cloud/topology", element: <CloudTopologyPage /> },
  { path: "/cloud/compliance", element: <CompliancePage /> },
  { path: "/cloud/alerts", element: <AlertsPage /> },
];


