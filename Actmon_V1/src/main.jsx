import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { ToastProvider } from './components/ui/ToastProvider';
import { AuthProvider } from './auth/AuthProvider';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AppShell } from './components/layout/AppShell';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { AgentsList } from './pages/agents/AgentsList';
import { AgentDetail } from './pages/agents/AgentDetail';
import { ConnectionsPage } from './pages/connections/ConnectionsPage';
import AddConnectionPage from './pages/connections/AddConnectionPage';
import MySQLDashboard from './pages/mysql/MySQLDashboard';
import SlowQueries from './pages/mysql/SlowQueries';
import ErrorLogs from './pages/mysql/ErrorLogs';
import ErrorAnalysis from './pages/mysql/ErrorAnalysis';
import MySQLSelfHeal from './pages/mysql/MySQLSelfHeal';
import IndexAnalysis from './pages/mysql/IndexAnalysis';
import MySQLBackupPage from './pages/mysql/MySQLBackupPage';
import MySQLReportsPage from './pages/mysql/MySQLReportsPage';
import PostgreSQLDashboard from './pages/postgresql/PostgreSQLDashboard';
import PostgreSQLBackupPage from './pages/postgresql/PostgreSQLBackupPage';
import PostgreSQLReportsPage from './pages/postgres/PostgreSQLReportsPage';
import PGSlowQueries from './pages/postgresql/SlowQueries';
import PGQueryDetail from './pages/postgresql/QueryDetailPage';
import PGErrorLogs from './pages/postgresql/ErrorLogs';
import PGIndexAnalysis from './pages/postgresql/IndexAnalysis';
import MSSQLDashboard from './pages/mssql/MSSQLDashboard';
import MSSQLBackupPage from './pages/mssql/MSSQLBackupPage';
import MSSQLSlowQueries from './pages/mssql/SlowQueries';
import MSSQLErrorLogs from './pages/mssql/ErrorLogs';
import MSSQLIndexAnalysis from './pages/mssql/IndexAnalysis';
import OracleDashboard from './pages/oracle/OracleDashboard';
import OracleSlowQueries from './pages/oracle/SlowQueries';
import OracleErrorLogs from './pages/oracle/ErrorLogs';
import OracleIndexAnalysis from './pages/oracle/IndexAnalysis';
import OracleReportsPage from './pages/oracle/OracleReportsPage';
import OracleLiveQueriesPage from './pages/oracle/OracleLiveQueriesPage';
import MongoDBDashboard from './pages/mongodb/MongoDBDashboard';
import MongoSlowOperations from './pages/mongodb/SlowOperations';
import MongoErrorLogs from './pages/mongodb/ErrorLogs';
import MongoCollectionAnalysis from './pages/mongodb/CollectionAnalysis';
import MongoDBBackupPage from './pages/mongodb/MongoDBBackupPage';
import ClickHouseDashboard from './pages/clickhouse/ClickHouseDashboard';
import CHSlowQueries from './pages/clickhouse/SlowQueries';
import CHErrorLogs from './pages/clickhouse/ErrorLogs';
import CHTableAnalysis from './pages/clickhouse/TableAnalysis';
import DatabaseServersPage from './pages/databases/DatabaseServersPage';
import AddOsServerPage from './pages/databases/AddOsServerPage';
import AddServerPage from './pages/databases/AddServerPage';
import ServerDetail from './pages/databases/ServerDetail';
import { CloudPage } from './pages/cloud/CloudPage';
import { MLPage } from './pages/ml/MLPage';
import { AlertsPage } from './pages/alerts/AlertsPage';
import { InfraPage } from './pages/infra/InfraPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { NotFound } from './pages/NotFound';
import ChatbotPage from './pages/chatbot/ChatbotPage';
import AdministrationPage from './pages/admin/AdministrationPage';
import AdminResourcePage from './pages/admin/_shared/AdminResourcePage';
import GroupRolePagePermission from './pages/admin/GroupRolePagePermission';
import { ADMIN_CONFIGS } from './pages/admin/adminConfigs';
import './index.css';

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Configure client routes
const router = createBrowserRouter([
  {
    path: '/login',
    element: <Login />,
  },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      {
        path: '',
        element: <Navigate to="/dashboard" replace />,
      },
      {
        path: 'dashboard',
        element: <Dashboard />,
      },
      {
        path: 'agents',
        element: <AgentsList />,
      },
      {
        path: 'agents/:id',
        element: <AgentDetail />,
      },
      {
        path: 'connections',
        element: <ConnectionsPage />,
      },
      {
        path: 'connections/add',
        element: <AddConnectionPage />,
      },
      // Per-technology SERVER LIST routes (Databases page, locked to one tech).
      // Flow: /databases (tech grid) → /{tech}-servers → /{tech}-dashboard/:id
      { path: 'mysql-servers', element: <DatabaseServersPage tech="mysql" /> },
      { path: 'postgresql-servers', element: <DatabaseServersPage tech="postgresql" /> },
      { path: 'oracle-servers', element: <DatabaseServersPage tech="oracle" /> },
      { path: 'mssql-servers', element: <DatabaseServersPage tech="mssql" /> },
      { path: 'mongodb-servers', element: <DatabaseServersPage tech="mongodb" /> },
      { path: 'clickhouse-servers', element: <DatabaseServersPage tech="clickhouse" /> },
      {
        path: 'mysql-dashboard/:id',
        element: <MySQLDashboard />,
      },
      // Dashboard tabs as routes: /mysql-dashboard/:id/overview, /performance, /queries, …
      // (the explicit pages below — slow-queries, error-logs, etc. — outrank :tab)
      {
        path: 'mysql-dashboard/:id/:tab',
        element: <MySQLDashboard />,
      },
      {
        path: 'mysql-dashboard/:id/slow-queries',
        element: <SlowQueries />,
      },
      {
        path: 'mysql-dashboard/:id/error-logs',
        element: <ErrorLogs />,
      },
      {
        path: 'mysql-dashboard/:id/error-analysis',
        element: <ErrorAnalysis />,
      },
      {
        path: 'mysql-dashboard/:id/self-heal',
        element: <MySQLSelfHeal />,
      },
      {
        path: 'mysql-dashboard/:id/index-analysis',
        element: <IndexAnalysis />,
      },
      {
        path: 'mysql-dashboard/:id/backup',
        element: <MySQLBackupPage />,
      },
      {
        path: 'mysql-dashboard/:id/reports',
        element: <MySQLReportsPage />,
      },
      // PostgreSQL
      { path: 'postgresql-dashboard/:id', element: <PostgreSQLDashboard /> },
      { path: 'postgresql-dashboard/:id/slow-queries', element: <PGSlowQueries /> },
      { path: 'postgresql-dashboard/:id/slow-queries/detail', element: <PGQueryDetail /> },
      { path: 'postgresql-dashboard/:id/error-logs', element: <PGErrorLogs /> },
      { path: 'postgresql-dashboard/:id/index-analysis', element: <PGIndexAnalysis /> },
      { path: 'postgresql-dashboard/:id/backup', element: <PostgreSQLBackupPage /> },
      { path: 'postgresql-dashboard/:id/reports', element: <PostgreSQLReportsPage /> },
      { path: 'postgresql-dashboard/:id/:tab', element: <PostgreSQLDashboard /> },
      // MSSQL
      { path: 'mssql-dashboard/:id', element: <MSSQLDashboard /> },
      { path: 'mssql-dashboard/:id/slow-queries', element: <MSSQLSlowQueries /> },
      { path: 'mssql-dashboard/:id/error-logs', element: <MSSQLErrorLogs /> },
      { path: 'mssql-dashboard/:id/index-analysis', element: <MSSQLIndexAnalysis /> },
      { path: 'mssql-dashboard/:id/backup', element: <MSSQLBackupPage /> },
      { path: 'mssql-dashboard/:id/:tab', element: <MSSQLDashboard /> },
      // Oracle
      { path: 'oracle-dashboard/:id', element: <OracleDashboard /> },
      { path: 'oracle-dashboard/:id/slow-queries', element: <OracleSlowQueries /> },
      { path: 'oracle-dashboard/:id/error-logs', element: <OracleErrorLogs /> },
      { path: 'oracle-dashboard/:id/index-analysis', element: <OracleIndexAnalysis /> },
      { path: 'oracle-dashboard/:id/reports', element: <OracleReportsPage /> },
      { path: 'oracle-dashboard/:id/live-queries', element: <OracleLiveQueriesPage /> },
      { path: 'oracle-dashboard/:id/:tab', element: <OracleDashboard /> },
      // MongoDB
      { path: 'mongodb-dashboard/:id', element: <MongoDBDashboard /> },
      { path: 'mongodb-dashboard/:id/slow-operations', element: <MongoSlowOperations /> },
      { path: 'mongodb-dashboard/:id/error-logs', element: <MongoErrorLogs /> },
      { path: 'mongodb-dashboard/:id/collection-analysis', element: <MongoCollectionAnalysis /> },
      { path: 'mongodb-dashboard/:id/backup', element: <MongoDBBackupPage /> },
      { path: 'mongodb-dashboard/:id/:tab', element: <MongoDBDashboard /> },
      // ClickHouse
      { path: 'clickhouse-dashboard/:id', element: <ClickHouseDashboard /> },
      { path: 'clickhouse-dashboard/:id/slow-queries', element: <CHSlowQueries /> },
      { path: 'clickhouse-dashboard/:id/error-logs', element: <CHErrorLogs /> },
      { path: 'clickhouse-dashboard/:id/table-analysis', element: <CHTableAnalysis /> },
      { path: 'clickhouse-dashboard/:id/:tab', element: <ClickHouseDashboard /> },
      {
        path: 'databases',
        element: <DatabaseServersPage />,
      },
      {
        path: 'databases/add-os-server',
        element: <AddOsServerPage />,
      },
      {
        path: 'databases/add-server',
        element: <AddServerPage />,
      },
      {
        path: 'connections/server/:serverId',
        element: <ServerDetail />,
      },
      
      {
        path: 'cloud',
        element: <CloudPage />,
      },
      {
        path: 'infra',
        element: <InfraPage />,
      },
      {
        path: 'ml',
        element: <MLPage />,
      },
      {
        path: 'alerts',
        element: <AlertsPage />,
      },
      // ── Administration (frontend-only CRUD UI; backend SPs come later) ──
      { path: 'administration', element: <AdministrationPage /> },
      { path: 'roles', element: <AdminResourcePage config={ADMIN_CONFIGS.roles} /> },
      { path: 'permissions', element: <AdminResourcePage config={ADMIN_CONFIGS.permissions} /> },
      { path: 'modules', element: <AdminResourcePage config={ADMIN_CONFIGS.modules} /> },
      { path: 'pages', element: <AdminResourcePage config={ADMIN_CONFIGS.pages} /> },
      { path: 'organizations', element: <AdminResourcePage config={ADMIN_CONFIGS.organizations} /> },
      { path: 'departments', element: <AdminResourcePage config={ADMIN_CONFIGS.departments} /> },
      { path: 'designations', element: <AdminResourcePage config={ADMIN_CONFIGS.designations} /> },
      { path: 'audit-logs', element: <AdminResourcePage config={ADMIN_CONFIGS['audit-logs']} /> },
      { path: 'role-permissions', element: <GroupRolePagePermission /> },
      { path: 'role-permissions/:orgId', element: <GroupRolePagePermission /> },
      { path: 'role-permissions/:orgId/:roleId', element: <GroupRolePagePermission /> },
      { path: 'users', element: <AdminResourcePage config={ADMIN_CONFIGS.users} /> },
      { path: 'employees', element: <AdminResourcePage config={ADMIN_CONFIGS.employees} /> },
      {
        path: 'settings',
        element: <SettingsPage />,
      },
      {
        path: 'chatbot',
        element: <ChatbotPage />,
      },
      {
        path: '*',
        element: <NotFound />,
      },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('app')).render(
  <React.StrictMode>
    <FluentProvider theme={webLightTheme} className="min-h-screen bg-brand-bg flex flex-col">
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AuthProvider>
            <RouterProvider router={router} />
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
    </FluentProvider>
  </React.StrictMode>
);
