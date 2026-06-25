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
// Heavy pages are LAZY-loaded → each becomes its own JS chunk fetched only when first
// navigated to, instead of bloating the initial bundle. This is the biggest first-load win.
// (Login + ADMIN_CONFIGS stay eager: Login is the first paint, ADMIN_CONFIGS is just data.)
const Dashboard               = React.lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const AgentsList              = React.lazy(() => import('./pages/agents/AgentsList').then(m => ({ default: m.AgentsList })));
const AgentDetail             = React.lazy(() => import('./pages/agents/AgentDetail').then(m => ({ default: m.AgentDetail })));
const ConnectionsPage         = React.lazy(() => import('./pages/connections/ConnectionsPage').then(m => ({ default: m.ConnectionsPage })));
const AddConnectionPage       = React.lazy(() => import('./pages/connections/AddConnectionPage'));
const MySQLDashboard          = React.lazy(() => import('./pages/mysql/MySQLDashboard'));
const SlowQueries             = React.lazy(() => import('./pages/mysql/SlowQueries'));
const ErrorLogs               = React.lazy(() => import('./pages/mysql/ErrorLogs'));
const ErrorAnalysis           = React.lazy(() => import('./pages/mysql/ErrorAnalysis'));
const MySQLSelfHeal           = React.lazy(() => import('./pages/mysql/MySQLSelfHeal'));
const IndexAnalysis           = React.lazy(() => import('./pages/mysql/IndexAnalysis'));
const MySQLBackupPage         = React.lazy(() => import('./pages/mysql/MySQLBackupPage'));
const MySQLReportsPage        = React.lazy(() => import('./pages/mysql/MySQLReportsPage'));
const PostgreSQLDashboard     = React.lazy(() => import('./pages/postgresql/PostgreSQLDashboard'));
const PostgreSQLBackupPage    = React.lazy(() => import('./pages/postgresql/PostgreSQLBackupPage'));
const PostgreSQLReportsPage   = React.lazy(() => import('./pages/postgres/PostgreSQLReportsPage'));
const PGSlowQueries           = React.lazy(() => import('./pages/postgresql/SlowQueries'));
const PGQueryDetail           = React.lazy(() => import('./pages/postgresql/QueryDetailPage'));
const PGErrorLogs             = React.lazy(() => import('./pages/postgresql/ErrorLogs'));
const PGIndexAnalysis         = React.lazy(() => import('./pages/postgresql/IndexAnalysis'));
const MSSQLDashboard          = React.lazy(() => import('./pages/mssql/MSSQLDashboard'));
const MSSQLBackupPage         = React.lazy(() => import('./pages/mssql/MSSQLBackupPage'));
const MSSQLSlowQueries        = React.lazy(() => import('./pages/mssql/SlowQueries'));
const MSSQLErrorLogs          = React.lazy(() => import('./pages/mssql/ErrorLogs'));
const MSSQLIndexAnalysis      = React.lazy(() => import('./pages/mssql/IndexAnalysis'));
const OracleDashboard         = React.lazy(() => import('./pages/oracle/OracleDashboard'));
const OracleSlowQueries       = React.lazy(() => import('./pages/oracle/SlowQueries'));
const OracleErrorLogs         = React.lazy(() => import('./pages/oracle/ErrorLogs'));
const OracleIndexAnalysis     = React.lazy(() => import('./pages/oracle/IndexAnalysis'));
const OracleReportsPage       = React.lazy(() => import('./pages/oracle/OracleReportsPage'));
const OracleLiveQueriesPage   = React.lazy(() => import('./pages/oracle/OracleLiveQueriesPage'));
const MongoDBDashboard        = React.lazy(() => import('./pages/mongodb/MongoDBDashboard'));
const MongoSlowOperations     = React.lazy(() => import('./pages/mongodb/SlowOperations'));
const MongoErrorLogs          = React.lazy(() => import('./pages/mongodb/ErrorLogs'));
const MongoCollectionAnalysis = React.lazy(() => import('./pages/mongodb/CollectionAnalysis'));
const MongoDBBackupPage       = React.lazy(() => import('./pages/mongodb/MongoDBBackupPage'));
const ClickHouseDashboard     = React.lazy(() => import('./pages/clickhouse/ClickHouseDashboard'));
const CHSlowQueries           = React.lazy(() => import('./pages/clickhouse/SlowQueries'));
const CHErrorLogs             = React.lazy(() => import('./pages/clickhouse/ErrorLogs'));
const CHTableAnalysis         = React.lazy(() => import('./pages/clickhouse/TableAnalysis'));
const DatabaseServersPage     = React.lazy(() => import('./pages/databases/DatabaseServersPage'));
const AddOsServerPage         = React.lazy(() => import('./pages/databases/AddOsServerPage'));
const AddServerPage           = React.lazy(() => import('./pages/databases/AddServerPage'));
const ServerDetail            = React.lazy(() => import('./pages/databases/ServerDetail'));
const CloudPage               = React.lazy(() => import('./pages/cloud/CloudPage').then(m => ({ default: m.CloudPage })));
const MLPage                  = React.lazy(() => import('./pages/ml/MLPage').then(m => ({ default: m.MLPage })));
const AlertsPage              = React.lazy(() => import('./pages/alerts/AlertsPage').then(m => ({ default: m.AlertsPage })));
const InfraPage               = React.lazy(() => import('./pages/infra/InfraPage').then(m => ({ default: m.InfraPage })));
const SettingsPage            = React.lazy(() => import('./pages/settings/SettingsPage').then(m => ({ default: m.SettingsPage })));
const NotFound                = React.lazy(() => import('./pages/NotFound').then(m => ({ default: m.NotFound })));
const ChatbotPage             = React.lazy(() => import('./pages/chatbot/ChatbotPage'));
const AdministrationPage      = React.lazy(() => import('./pages/admin/AdministrationPage'));
const AdminResourcePage       = React.lazy(() => import('./pages/admin/_shared/AdminResourcePage'));
const GroupRolePagePermission = React.lazy(() => import('./pages/admin/GroupRolePagePermission'));
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
      { path: 'administration/:orgId', element: <AdministrationPage /> },
      { path: 'roles', element: <AdminResourcePage config={ADMIN_CONFIGS.roles} /> },
      { path: 'permissions', element: <AdminResourcePage config={ADMIN_CONFIGS.permissions} /> },
      { path: 'modules', element: <AdminResourcePage config={ADMIN_CONFIGS.modules} /> },
      { path: 'pages', element: <AdminResourcePage config={ADMIN_CONFIGS.pages} /> },
      { path: 'organizations', element: <AdminResourcePage config={ADMIN_CONFIGS.organizations} /> },
      { path: 'departments', element: <AdminResourcePage config={ADMIN_CONFIGS.departments} /> },
      { path: 'designations', element: <AdminResourcePage config={ADMIN_CONFIGS.designations} /> },
      { path: 'audit-logs', element: <AdminResourcePage config={ADMIN_CONFIGS['audit-logs']} /> },
      { path: 'login-history', element: <AdminResourcePage config={ADMIN_CONFIGS['login-history']} /> },
      { path: 'user-sessions', element: <AdminResourcePage config={ADMIN_CONFIGS['user-sessions']} /> },
      { path: 'password-history', element: <AdminResourcePage config={ADMIN_CONFIGS['password-history']} /> },
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
