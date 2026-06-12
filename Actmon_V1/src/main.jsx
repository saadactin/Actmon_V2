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
import PostgreSQLDashboard from './pages/postgresql/PostgreSQLDashboard';
import PostgreSQLBackupPage from './pages/postgresql/PostgreSQLBackupPage';
import PGSlowQueries from './pages/postgresql/SlowQueries';
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
import MongoDBDashboard from './pages/mongodb/MongoDBDashboard';
import MongoSlowOperations from './pages/mongodb/SlowOperations';
import MongoErrorLogs from './pages/mongodb/ErrorLogs';
import MongoCollectionAnalysis from './pages/mongodb/CollectionAnalysis';
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
import { UsersPage } from './pages/users/UsersPage';
import { InfraPage } from './pages/infra/InfraPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { NotFound } from './pages/NotFound';
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
      {
        path: 'mysql-dashboard/:id',
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
      // PostgreSQL
      { path: 'postgresql-dashboard/:id', element: <PostgreSQLDashboard /> },
      { path: 'postgresql-dashboard/:id/slow-queries', element: <PGSlowQueries /> },
      { path: 'postgresql-dashboard/:id/error-logs', element: <PGErrorLogs /> },
      { path: 'postgresql-dashboard/:id/index-analysis', element: <PGIndexAnalysis /> },
      { path: 'postgresql-dashboard/:id/backup', element: <PostgreSQLBackupPage /> },
      // MSSQL
      { path: 'mssql-dashboard/:id', element: <MSSQLDashboard /> },
      { path: 'mssql-dashboard/:id/slow-queries', element: <MSSQLSlowQueries /> },
      { path: 'mssql-dashboard/:id/error-logs', element: <MSSQLErrorLogs /> },
      { path: 'mssql-dashboard/:id/index-analysis', element: <MSSQLIndexAnalysis /> },
      { path: 'mssql-dashboard/:id/backup', element: <MSSQLBackupPage /> },
      // Oracle
      { path: 'oracle-dashboard/:id', element: <OracleDashboard /> },
      { path: 'oracle-dashboard/:id/slow-queries', element: <OracleSlowQueries /> },
      { path: 'oracle-dashboard/:id/error-logs', element: <OracleErrorLogs /> },
      { path: 'oracle-dashboard/:id/index-analysis', element: <OracleIndexAnalysis /> },
      // MongoDB
      { path: 'mongodb-dashboard/:id', element: <MongoDBDashboard /> },
      { path: 'mongodb-dashboard/:id/slow-operations', element: <MongoSlowOperations /> },
      { path: 'mongodb-dashboard/:id/error-logs', element: <MongoErrorLogs /> },
      { path: 'mongodb-dashboard/:id/collection-analysis', element: <MongoCollectionAnalysis /> },
      // ClickHouse
      { path: 'clickhouse-dashboard/:id', element: <ClickHouseDashboard /> },
      { path: 'clickhouse-dashboard/:id/slow-queries', element: <CHSlowQueries /> },
      { path: 'clickhouse-dashboard/:id/error-logs', element: <CHErrorLogs /> },
      { path: 'clickhouse-dashboard/:id/table-analysis', element: <CHTableAnalysis /> },
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
      {
        path: 'users',
        element: (
          <ProtectedRoute adminOnly>
            <UsersPage />
          </ProtectedRoute>
        ),
      },
      {
        path: 'settings',
        element: <SettingsPage />,
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
