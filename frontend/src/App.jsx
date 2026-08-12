import { lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import AppShell from '@/components/layout/AppShell';
import Placeholder from '@/pages/Placeholder';
import { NAV_INDEX } from '@/config/navigation';
import { ADMIN_RESOURCES } from '@/config/adminResources';
import { APP } from '@/config/app.config';
import { useAuthStore } from '@/store/authStore';
import { getMe } from '@/api/auth';
import Login from '@/pages/Login';
import FirstRunSetup from '@/pages/auth/FirstRunSetup';

const Dashboard = lazy(() => import('@/pages/Dashboard'));
const AlertsPage = lazy(() => import('@/pages/alerts/AlertsPage'));
const AgentsPage = lazy(() => import('@/pages/agents/AgentsPage'));

// Agent setup / deploy — ported verbatim from the existing module.
const AgentSetupPage = lazy(() => import('@/pages/agents/setup/AgentSetupPage'));
const SetupWizard = lazy(() => import('@/pages/agents/setup/SetupWizard'));
const AddWebsiteWizard = lazy(() => import('@/pages/agents/setup/AddWebsiteWizard'));
const AddNetworkCheckWizard = lazy(() => import('@/pages/agents/setup/AddNetworkCheckWizard'));
const DeployAgentWizard = lazy(() => import('@/pages/agents/setup/deploy/DeployAgentWizard'));
const AgentDetailPage = lazy(() => import('@/pages/agents/AgentDetailPage'));
const SettingsPage = lazy(() => import('@/pages/settings/SettingsPage'));
const HelpCenterPage = lazy(() => import('@/pages/help/HelpCenterPage'));

// Cloud (AWS/Azure/OCI discovery) — ported from the existing module's
// features/cloud/ tree, restyled to plain JS. CloudShell is the tab-bar shell;
// everything else is one of its nested routes (see the route tree below).
const CloudShell = lazy(() => import('@/features/cloud/components/CloudShell').then((m) => ({ default: m.CloudShell })));
const CloudProviderChooser = lazy(() => import('@/features/cloud/pages/CloudProviderChooser'));
const CloudAccountsPage = lazy(() => import('@/features/cloud/pages/CloudAccountsPage').then((m) => ({ default: m.CloudAccountsPage })));
const CloudProviderAccountsPage = lazy(() => import('@/features/cloud/pages/CloudProviderAccountsPage'));
const CloudDashboard = lazy(() => import('@/features/cloud/pages/CloudDashboard').then((m) => ({ default: m.CloudDashboard })));
const CloudResourcesPage = lazy(() => import('@/features/cloud/pages/ResourcesPage').then((m) => ({ default: m.ResourcesPage })));
const CloudResourceDetailPage = lazy(() => import('@/features/cloud/pages/ResourceDetailPage').then((m) => ({ default: m.ResourceDetailPage })));
const CloudCostPage = lazy(() => import('@/features/cloud/pages/CostPage').then((m) => ({ default: m.CostPage })));
const CloudSecurityPage = lazy(() => import('@/features/cloud/pages/SecurityPosturePage').then((m) => ({ default: m.SecurityPosturePage })));
const CloudTopologyPage = lazy(() => import('@/features/cloud/pages/CloudTopologyPage').then((m) => ({ default: m.CloudTopologyPage })));
const CloudCompliancePage = lazy(() => import('@/features/cloud/pages/CompliancePage').then((m) => ({ default: m.CompliancePage })));
const CloudAlertsPage = lazy(() => import('@/features/cloud/pages/AlertsPage').then((m) => ({ default: m.AlertsPage })));

// Infrastructure — ported verbatim from the existing module. All three routes
// share one host abstraction (os_servers): the overview/grid, a per-host
// drilldown, and an SSH-backed file browser reached from that drilldown.
const InfraPage = lazy(() => import('@/pages/infra/InfraPage'));
const InfraHostDetail = lazy(() => import('@/pages/infra/InfraHostDetail'));
const InfraFileExplorer = lazy(() => import('@/pages/infra/InfraFileExplorer'));

// Databases — ported verbatim. One component serves the technology grid and each
// per-technology server list; the technology comes in as a prop, not from state.
const DatabaseServersPage = lazy(() => import('@/pages/databases/DatabaseServersPage'));
const AddOsServerPage = lazy(() => import('@/pages/databases/AddOsServerPage'));

// Diagnosis — a dedicated full-page troubleshooting workspace (not a modal).
// Every "Diagnose" click site (per-tech dashboards, DatabaseServersPage's
// serverTarget()) navigates here.
const DiagnosisPage = lazy(() => import('@/pages/diagnosis/DiagnosisPage'));

// MySQL — ported verbatim. The dashboard hosts 11 tabs (Backup & PITR is the
// MySQLBackupPage embedded); the pages below are separate routes that outrank :tab.
const MySQLDashboard = lazy(() => import('@/pages/mysql/MySQLDashboard'));
const MySQLSlowQueries = lazy(() => import('@/pages/mysql/SlowQueries'));
const MySQLErrorLogs = lazy(() => import('@/pages/mysql/ErrorLogs'));
const MySQLErrorAnalysis = lazy(() => import('@/pages/mysql/ErrorAnalysis'));
const MySQLSelfHeal = lazy(() => import('@/pages/mysql/MySQLSelfHeal'));
const MySQLIndexAnalysis = lazy(() => import('@/pages/mysql/IndexAnalysis'));
const MySQLReportsPage = lazy(() => import('@/pages/mysql/MySQLReportsPage'));

// PostgreSQL — ported verbatim. Same shape as MySQL: the dashboard hosts the tabs
// (Backup & PITR embedded), and the named pages below are their own routes.
const PostgreSQLDashboard = lazy(() => import('@/pages/postgresql/PostgreSQLDashboard'));
const PgSlowQueries = lazy(() => import('@/pages/postgresql/SlowQueries'));
const PgQueryDetail = lazy(() => import('@/pages/postgresql/QueryDetailPage'));
const PgErrorLogs = lazy(() => import('@/pages/postgresql/ErrorLogs'));
const PgIndexAnalysis = lazy(() => import('@/pages/postgresql/IndexAnalysis'));
const PgReportsPage = lazy(() => import('@/pages/postgresql/PostgreSQLReportsPage'));

// Oracle. Sixteen tabs, each backed by its own endpoint and enabled only while its
// tab is open — the Oracle collector issues real v$/dba_ queries per call, so
// fetching all sixteen on every load would load the instance for nothing.
const OracleDashboard = lazy(() => import('@/pages/oracle/OracleDashboard'));
const OracleLiveQueries = lazy(() => import('@/pages/oracle/LiveQueries'));
const OracleSlowQueries = lazy(() => import('@/pages/oracle/SlowQueries'));
const OracleErrorLogs = lazy(() => import('@/pages/oracle/ErrorLogs'));
const OracleIndexAnalysis = lazy(() => import('@/pages/oracle/IndexAnalysis'));
const OracleReportsPage = lazy(() => import('@/pages/oracle/OracleReportsPage'));

// SQL Server. Ten tabs with Backup & PITR embedded, same shape as MySQL. Bound to
// what /monitoring-dashboard actually returns rather than to the fields the old
// page assumed — see the note at the top of MSSQLDashboard.
const MSSQLDashboard = lazy(() => import('@/pages/mssql/MSSQLDashboard'));
const MssqlSlowQueries = lazy(() => import('@/pages/mssql/SlowQueries'));
const MssqlQueryDetail = lazy(() => import('@/pages/mssql/QueryDetailPage'));
const MssqlErrorLogs = lazy(() => import('@/pages/mssql/ErrorLogs'));
const MssqlIndexAnalysis = lazy(() => import('@/pages/mssql/IndexAnalysis'));
const MssqlReportsPage = lazy(() => import('@/pages/mssql/MSSQLReportsPage'));
const MssqlBackupPage = lazy(() => import('@/pages/mssql/MSSQLBackupPage'));

// MongoDB — ported verbatim. 13 tabs; backup is its own route here rather than an
// embedded tab, which is how the existing module has it.
const MongoDBDashboard = lazy(() => import('@/pages/mongodb/MongoDBDashboard'));
const MongoSlowOperations = lazy(() => import('@/pages/mongodb/SlowOperations'));
const MongoErrorLogs = lazy(() => import('@/pages/mongodb/ErrorLogs'));
const MongoCollectionAnalysis = lazy(() => import('@/pages/mongodb/CollectionAnalysis'));
const MongoBackupPage = lazy(() => import('@/pages/mongodb/MongoDBBackupPage'));

// ClickHouse. 12 tabs, each its own `system.*` query and enabled only while its tab
// is open. Part pressure leads the overview because that is the number that stops
// inserts — see the note at the top of ClickHouseDashboard.
const ClickHouseDashboard = lazy(() => import('@/pages/clickhouse/ClickHouseDashboard'));
const ChSlowQueries = lazy(() => import('@/pages/clickhouse/SlowQueries'));
const ChErrorLogs = lazy(() => import('@/pages/clickhouse/ErrorLogs'));
const ChTableAnalysis = lazy(() => import('@/pages/clickhouse/TableAnalysis'));

// Azure Cosmos DB. A cloud account, not a host — so it has its own connections and
// edit pages rather than the shared host/port list, and nothing on the dashboard
// polls the account, because every read there is billed in Request Units.
const CosmosDBConnectionsPage = lazy(() => import('@/pages/cosmosdb/CosmosDBConnectionsPage'));
const CosmosDBDashboard = lazy(() => import('@/pages/cosmosdb/CosmosDBDashboard'));
const CosmosDBEditConnectionPage = lazy(() => import('@/pages/cosmosdb/CosmosDBEditConnectionPage'));

// Administration — one generic config-driven CRUD engine serves every
// sub-page (see src/config/adminResources.js); only the hub and the bespoke
// Role/Page Permissions screen are their own components.
const AdminResourcePage = lazy(() => import('@/pages/administration/_shared/AdminResourcePage'));
const AdministrationPage = lazy(() => import('@/pages/administration/AdministrationPage'));
const GroupRolePagePermission = lazy(() => import('@/pages/administration/GroupRolePagePermission'));

/**
 * Routing.
 *
 * Only the dashboard is real so far. Every other nav destination is registered
 * automatically from NAV_INDEX and rendered as a Placeholder, so the sidebar
 * never has a dead link while pages are ported one at a time.
 */
export default function App() {
  /* The signed-in identity comes from the auth store, so the rail, the user menu
     and the RBAC hooks all read the same source. Signing out clears it and returns
     to the login page. */
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const clearToken = useAuthStore((s) => s.clearToken);
  const navigate = useNavigate();
  const onSignOut = () => { clearToken(); navigate(APP.loginRoute, { replace: true }); };

  /* A token can outlive the `user` object it was issued with — e.g. a session
     saved before `user` started being persisted alongside the token, or one
     restored on a fresh boot with a stale in-memory store. Rather than render
     the shell with a "Signed out" placeholder for someone who is, in fact,
     signed in, resolve the real identity from the token. If the token itself
     no longer holds up, GET /auth/me 401s and that's a real invalid session —
     drop it and go to the login page, per RequireAuth below. */
  useEffect(() => {
    if (!token || user) return;
    getMe()
      .then((me) => setUser(me))
      .catch(() => { clearToken(); navigate(APP.loginRoute, { replace: true }); });
  }, [token, user]);

  // Routes we define explicitly must not be shadowed by generated ones.
  const explicit = new Set(['/dashboard', '/alerts', '/agents', '/databases', '/settings', '/infra', '/administration', '/help-center', '/cloud']);
  const generated = NAV_INDEX.filter((n) => !explicit.has(n.to));

  return (
    <Routes>
      {/* Outside the shell on purpose: these two own the whole viewport and must not
          render a sidebar for a session that does not exist yet. /setup is the
          first-run wizard — distinct from /agents/setup/:tech, which is the
          connection wizard for an already-running install. */}
      <Route path={APP.loginRoute} element={<Login />} />
      <Route path="/setup" element={<FirstRunSetup />} />

      {/* Everything below needs a token — no token, no shell. Without this guard,
          a signed-out visit to any app route rendered the full shell (nav, "Signed
          out" account menu, pages that would all 401) instead of going straight to
          the login page. */}
      <Route element={token ? <AppShell user={user} onSignOut={onSignOut} /> : <Navigate to={APP.loginRoute} replace />}>
        <Route index element={<Navigate to={APP.defaultRoute} replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/help-center" element={<HelpCenterPage />} />

        {/* Cloud (AWS/Azure/OCI discovery) — CloudShell is the tab-bar shell,
            everything below is one of its nested routes (its own <Outlet/>). */}
        <Route path="/cloud" element={<CloudShell />}>
          <Route index element={<CloudProviderChooser />} />
          <Route path="accounts" element={<CloudAccountsPage />} />
          <Route path="resources" element={<CloudResourcesPage />} />
          <Route path="resources/:resourceId" element={<CloudResourceDetailPage />} />
          <Route path="cost" element={<CloudCostPage />} />
          <Route path="security" element={<CloudSecurityPage />} />
          <Route path="topology" element={<CloudTopologyPage />} />
          <Route path="compliance" element={<CloudCompliancePage />} />
          <Route path="alerts" element={<CloudAlertsPage />} />
          <Route path=":provider" element={<CloudProviderAccountsPage />} />
          <Route path=":provider/:accountId" element={<CloudDashboard />} />
        </Route>

        {/* Order matters: the two named wizards must be matched before :tech. */}
        <Route path="/agents/setup" element={<AgentSetupPage />} />
        <Route path="/agents/setup/website" element={<AddWebsiteWizard />} />
        <Route path="/agents/setup/network-check" element={<AddNetworkCheckWizard />} />
        <Route path="/agents/setup/:tech" element={<SetupWizard />} />
        <Route path="/agents/deploy" element={<DeployAgentWizard />} />

        {/* Same catalogue reached from the Databases menu — the pages switch their
            own breadcrumbs and exit targets off the pathname. */}
        <Route path="/databases/add-data" element={<AgentSetupPage />} />
        <Route path="/databases/setup/:tech" element={<SetupWizard />} />

        {/* Databases hub, then one list route per technology.
            Flow: /databases → /{tech}-servers → /{tech}-dashboard/:id */}
        <Route path="/databases" element={<DatabaseServersPage />} />
        <Route path="/databases/add-os-server" element={<AddOsServerPage />} />
        {/* Every "Diagnose" click site (per-tech dashboards' header button,
            DatabaseServersPage's serverTarget()) navigates here — a dedicated
            full-page workspace, not a modal. */}
        <Route path="/diagnose/:connId" element={<DiagnosisPage />} />
        <Route path="/mysql-servers" element={<DatabaseServersPage tech="mysql" />} />
        <Route path="/postgresql-servers" element={<DatabaseServersPage tech="postgresql" />} />
        <Route path="/oracle-servers" element={<DatabaseServersPage tech="oracle" />} />
        <Route path="/mssql-servers" element={<DatabaseServersPage tech="mssql" />} />
        <Route path="/mongodb-servers" element={<DatabaseServersPage tech="mongodb" />} />
        <Route path="/clickhouse-servers" element={<DatabaseServersPage tech="clickhouse" />} />
        {/* Cosmos gets its own list: the shared page is built around host and port,
            which a cloud account does not have. */}
        <Route path="/cosmosdb-servers" element={<CosmosDBConnectionsPage />} />

        {/* MySQL. The named pages are declared BEFORE :tab so they win — the
            dashboard would otherwise swallow them as a tab id. */}
        <Route path="/mysql-dashboard/:id" element={<MySQLDashboard />} />
        <Route path="/mysql-dashboard/:id/slow-queries" element={<MySQLSlowQueries />} />
        <Route path="/mysql-dashboard/:id/error-logs" element={<MySQLErrorLogs />} />
        <Route path="/mysql-dashboard/:id/error-analysis" element={<MySQLErrorAnalysis />} />
        <Route path="/mysql-dashboard/:id/self-heal" element={<MySQLSelfHeal />} />
        <Route path="/mysql-dashboard/:id/index-analysis" element={<MySQLIndexAnalysis />} />
        <Route path="/mysql-dashboard/:id/reports" element={<MySQLReportsPage />} />
        <Route path="/mysql-dashboard/:id/:tab" element={<MySQLDashboard />} />

        {/* PostgreSQL. Same ordering rule as MySQL — the named sub-pages are
            declared before :tab so the dashboard cannot swallow them, and the
            slow-query detail page before its own parent for the same reason. */}
        <Route path="/postgresql-dashboard/:id" element={<PostgreSQLDashboard />} />
        <Route path="/postgresql-dashboard/:id/slow-queries/detail" element={<PgQueryDetail />} />
        <Route path="/postgresql-dashboard/:id/slow-queries" element={<PgSlowQueries />} />
        <Route path="/postgresql-dashboard/:id/error-logs" element={<PgErrorLogs />} />
        <Route path="/postgresql-dashboard/:id/index-analysis" element={<PgIndexAnalysis />} />
        <Route path="/postgresql-dashboard/:id/reports" element={<PgReportsPage />} />
        <Route path="/postgresql-dashboard/:id/:tab" element={<PostgreSQLDashboard />} />

        {/* Oracle. Named sub-pages before :tab, as with the other engines. Live
            Queries is both a dashboard tab and its own route — the same component,
            with `embedded` deciding whether it draws a page header. */}
        <Route path="/oracle-dashboard/:id" element={<OracleDashboard />} />
        <Route path="/oracle-dashboard/:id/live-queries" element={<OracleLiveQueries />} />
        <Route path="/oracle-dashboard/:id/slow-queries" element={<OracleSlowQueries />} />
        <Route path="/oracle-dashboard/:id/error-logs" element={<OracleErrorLogs />} />
        <Route path="/oracle-dashboard/:id/index-analysis" element={<OracleIndexAnalysis />} />
        <Route path="/oracle-dashboard/:id/reports" element={<OracleReportsPage />} />
        <Route path="/oracle-dashboard/:id/:tab" element={<OracleDashboard />} />

        {/* SQL Server. Named sub-pages before :tab, and the slow-query detail page
            before its own parent, for the same reason as the other engines. */}
        <Route path="/mssql-dashboard/:id" element={<MSSQLDashboard />} />
        <Route path="/mssql-dashboard/:id/slow-queries/detail" element={<MssqlQueryDetail />} />
        <Route path="/mssql-dashboard/:id/slow-queries" element={<MssqlSlowQueries />} />
        <Route path="/mssql-dashboard/:id/error-logs" element={<MssqlErrorLogs />} />
        <Route path="/mssql-dashboard/:id/index-analysis" element={<MssqlIndexAnalysis />} />
        <Route path="/mssql-dashboard/:id/reports" element={<MssqlReportsPage />} />
        <Route path="/mssql-dashboard/:id/backup-page" element={<MssqlBackupPage />} />
        <Route path="/mssql-dashboard/:id/:tab" element={<MSSQLDashboard />} />

        {/* MongoDB. Named sub-pages before :tab, as with the other engines. */}
        <Route path="/mongodb-dashboard/:id" element={<MongoDBDashboard />} />
        <Route path="/mongodb-dashboard/:id/slow-operations" element={<MongoSlowOperations />} />
        <Route path="/mongodb-dashboard/:id/error-logs" element={<MongoErrorLogs />} />
        <Route path="/mongodb-dashboard/:id/collection-analysis" element={<MongoCollectionAnalysis />} />
        <Route path="/mongodb-dashboard/:id/backup" element={<MongoBackupPage />} />
        <Route path="/mongodb-dashboard/:id/:tab" element={<MongoDBDashboard />} />

        {/* ClickHouse. Named sub-pages before :tab, as with the other engines. */}
        <Route path="/clickhouse-dashboard/:id" element={<ClickHouseDashboard />} />
        <Route path="/clickhouse-dashboard/:id/slow-queries" element={<ChSlowQueries />} />
        <Route path="/clickhouse-dashboard/:id/error-logs" element={<ChErrorLogs />} />
        <Route path="/clickhouse-dashboard/:id/table-analysis" element={<ChTableAnalysis />} />
        <Route path="/clickhouse-dashboard/:id/:tab" element={<ClickHouseDashboard />} />

        {/* Cosmos DB. Slow calls and errors are tabs, not routes — they read the
            same activity log the overview does, so a separate page would refetch it. */}
        <Route path="/cosmosdb-edit/:id" element={<CosmosDBEditConnectionPage />} />
        <Route path="/cosmosdb-dashboard/:id" element={<CosmosDBDashboard />} />
        <Route path="/cosmosdb-dashboard/:id/:tab" element={<CosmosDBDashboard />} />

        {/* Declared last of the /agents routes so the literal paths above win. */}
        <Route path="/agents/:name" element={<AgentDetailPage />} />

        {/* Infrastructure. /infra/:id/files before /infra/:id so the file
            explorer isn't swallowed as a host id. */}
        <Route path="/infra" element={<InfraPage />} />
        <Route path="/infra/:id/files" element={<InfraFileExplorer />} />
        <Route path="/infra/:id" element={<InfraHostDetail />} />

        {/* Administration — the hub, the bespoke Role/Page Permissions
            drill-down, and one generic engine instance per master resource. */}
        <Route path="/administration" element={<AdministrationPage />} />
        <Route path="/administration/:orgId" element={<AdministrationPage />} />
        <Route path="/role-permissions" element={<GroupRolePagePermission />} />
        <Route path="/role-permissions/:orgId" element={<GroupRolePagePermission />} />
        <Route path="/role-permissions/:orgId/:roleId" element={<GroupRolePagePermission />} />
        <Route path="/roles" element={<AdminResourcePage config={ADMIN_RESOURCES.roles} />} />
        <Route path="/permissions" element={<AdminResourcePage config={ADMIN_RESOURCES.permissions} />} />
        <Route path="/modules" element={<AdminResourcePage config={ADMIN_RESOURCES.modules} />} />
        <Route path="/pages" element={<AdminResourcePage config={ADMIN_RESOURCES.pages} />} />
        <Route path="/organizations" element={<AdminResourcePage config={ADMIN_RESOURCES.organizations} />} />
        <Route path="/departments" element={<AdminResourcePage config={ADMIN_RESOURCES.departments} />} />
        <Route path="/designations" element={<AdminResourcePage config={ADMIN_RESOURCES.designations} />} />
        <Route path="/employees" element={<AdminResourcePage config={ADMIN_RESOURCES.employees} />} />
        <Route path="/users" element={<AdminResourcePage config={ADMIN_RESOURCES.users} />} />
        <Route path="/audit-logs" element={<AdminResourcePage config={ADMIN_RESOURCES['audit-logs']} />} />
        <Route path="/login-history" element={<AdminResourcePage config={ADMIN_RESOURCES['login-history']} />} />
        <Route path="/user-sessions" element={<AdminResourcePage config={ADMIN_RESOURCES['user-sessions']} />} />
        <Route path="/password-history" element={<AdminResourcePage config={ADMIN_RESOURCES['password-history']} />} />

        {generated.map((n) => (
          <Route
            key={n.to}
            path={n.to}
            element={<Placeholder title={n.label} icon={n.icon} />}
          />
        ))}

        <Route path="*" element={<Placeholder title="Not found" icon="alert" description="No page is registered for this route." />} />
      </Route>
    </Routes>
  );
}
