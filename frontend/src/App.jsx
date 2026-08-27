import { lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import AppShell from '@/components/layout/AppShell';
import { AUTH_DISABLED } from '@/auth/devAuthBypass';
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

// Slow Query Analysis — ONE shared list/detail page for every database
// technology (see slowQueryCatalog.js); `tech` picks the engine, same pattern
// as DatabaseServersPage's `tech` prop.
const SlowQueriesPage = lazy(() => import('@/pages/_shared/SlowQueriesPage'));
const SlowQueryDetailPage = lazy(() => import('@/pages/_shared/SlowQueryDetailPage'));

// Agent setup / deploy — ported verbatim from the existing module.
const AgentSetupPage = lazy(() => import('@/pages/agents/setup/AgentSetupPage'));
const SetupWizard = lazy(() => import('@/pages/agents/setup/SetupWizard'));
const AddWebsiteWizard = lazy(() => import('@/pages/agents/setup/AddWebsiteWizard'));
const AddNetworkCheckWizard = lazy(() => import('@/pages/agents/setup/AddNetworkCheckWizard'));
const ComingSoonSetup = lazy(() => import('@/pages/agents/setup/ComingSoonSetup'));
const DeployAgentWizard = lazy(() => import('@/pages/agents/setup/deploy/DeployAgentWizard'));
const AgentDetailPage = lazy(() => import('@/pages/agents/AgentDetailPage'));
const SettingsPage = lazy(() => import('@/pages/settings/SettingsPage'));
const HelpCenterPage = lazy(() => import('@/pages/help/HelpCenterPage'));
const AiAssistantPage = lazy(() => import('@/pages/chat/AiAssistantPage'));
const LogsPage = lazy(() => import('@/pages/logs/LogsPage'));

// Cloud (AWS/Azure/OCI discovery) — ported from the existing module's
// features/cloud/ tree, restyled to plain JS. CloudShell is the layout shell;
// everything else is one of its nested routes (see the route tree below).
// Resources/Cost/Security/Topology/Compliance/Alerts are tabs OF CloudDashboard
// (imported directly by that file, not routed separately) — the same shape as
// an engine dashboard's Overview/Performance/Queries/… tabs for one connection.
const CloudShell = lazy(() => import('@/features/cloud/components/CloudShell').then((m) => ({ default: m.CloudShell })));
const CloudProviderChooser = lazy(() => import('@/features/cloud/pages/CloudProviderChooser'));
const CloudAccountsPage = lazy(() => import('@/features/cloud/pages/CloudAccountsPage').then((m) => ({ default: m.CloudAccountsPage })));
const CloudProviderAccountsPage = lazy(() => import('@/features/cloud/pages/CloudProviderAccountsPage'));
const CloudDashboard = lazy(() => import('@/features/cloud/pages/CloudDashboard').then((m) => ({ default: m.CloudDashboard })));
const CloudResourceDetailPage = lazy(() => import('@/features/cloud/pages/ResourceDetailPage').then((m) => ({ default: m.ResourceDetailPage })));

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
const AddConnectionPage = lazy(() => import('@/pages/connections/AddConnectionPage'));

// Diagnosis — a dedicated full-page troubleshooting workspace (not a modal).
// Every "Diagnose" click site (per-tech dashboards, DatabaseServersPage's
// serverTarget()) navigates here.
const DiagnosisPage = lazy(() => import('@/pages/diagnosis/DiagnosisPage'));

// MySQL — ported verbatim. The dashboard hosts 10 tabs; the pages below are
// separate routes that outrank :tab.
const MySQLDashboard = lazy(() => import('@/pages/mysql/MySQLDashboard'));
const MySQLErrorLogs = lazy(() => import('@/pages/mysql/ErrorLogs'));
const MySQLErrorAnalysis = lazy(() => import('@/pages/mysql/ErrorAnalysis'));
const MySQLSelfHeal = lazy(() => import('@/pages/mysql/MySQLSelfHeal'));
const MySQLIndexAnalysis = lazy(() => import('@/pages/mysql/IndexAnalysis'));
const MySQLBinaryLogs = lazy(() => import('@/pages/mysql/BinaryLogs'));
const MySQLBinaryLogDetail = lazy(() => import('@/pages/mysql/BinaryLogDetail'));
const MySQLReportsPage = lazy(() => import('@/pages/mysql/MySQLReportsPage'));

// PostgreSQL — ported verbatim. Same shape as MySQL: the dashboard hosts the
// tabs, and the named pages below are their own routes.
const PostgreSQLDashboard = lazy(() => import('@/pages/postgresql/PostgreSQLDashboard'));
const PgErrorLogs = lazy(() => import('@/pages/postgresql/ErrorLogs'));
const PgIndexAnalysis = lazy(() => import('@/pages/postgresql/IndexAnalysis'));
const PgReportsPage = lazy(() => import('@/pages/postgresql/PostgreSQLReportsPage'));

// Oracle. Sixteen tabs, each backed by its own endpoint and enabled only while its
// tab is open — the Oracle collector issues real v$/dba_ queries per call, so
// fetching all sixteen on every load would load the instance for nothing.
const OracleDashboard = lazy(() => import('@/pages/oracle/OracleDashboard'));
const OracleLiveQueries = lazy(() => import('@/pages/oracle/LiveQueries'));
const OracleSessionDetailPage = lazy(() => import('@/pages/oracle/SessionDetailPage'));
const OracleErrorLogs = lazy(() => import('@/pages/oracle/ErrorLogs'));
const OracleIndexAnalysis = lazy(() => import('@/pages/oracle/IndexAnalysis'));
const OracleStorageHealth = lazy(() => import('@/pages/oracle/StorageHealth'));
const StorageObjectDetailPage = lazy(() => import('@/pages/oracle/StorageObjectDetailPage'));
const OracleJobDetailPage = lazy(() => import('@/pages/oracle/JobDetailPage'));
const OracleReportsPage = lazy(() => import('@/pages/oracle/OracleReportsPage'));

// SQL Server. Nine tabs, same shape as MySQL. Bound to what
// /monitoring-dashboard actually returns rather than to the fields the old
// page assumed — see the note at the top of MSSQLDashboard.
const MSSQLDashboard = lazy(() => import('@/pages/mssql/MSSQLDashboard'));
const MssqlErrorLogs = lazy(() => import('@/pages/mssql/ErrorLogs'));
const MssqlIndexAnalysis = lazy(() => import('@/pages/mssql/IndexAnalysis'));
const MssqlReportsPage = lazy(() => import('@/pages/mssql/MSSQLReportsPage'));

// MongoDB — ported verbatim. 13 tabs.
const MongoDBDashboard = lazy(() => import('@/pages/mongodb/MongoDBDashboard'));
const MongoErrorLogs = lazy(() => import('@/pages/mongodb/ErrorLogs'));
const MongoCollectionAnalysis = lazy(() => import('@/pages/mongodb/CollectionAnalysis'));

// ClickHouse. 12 tabs, each its own `system.*` query and enabled only while its tab
// is open. Part pressure leads the overview because that is the number that stops
// inserts — see the note at the top of ClickHouseDashboard.
const ClickHouseDashboard = lazy(() => import('@/pages/clickhouse/ClickHouseDashboard'));
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
const AiChatSessionsPage = lazy(() => import('@/pages/administration/AiChatSessionsPage'));
const HelpCenterAppearancePage = lazy(() => import('@/pages/administration/HelpCenterAppearancePage'));

/** MongoDB's Slow Query page moved from /slow-operations to /slow-queries for
 * consistency with every other engine — this keeps an old bookmark working. */
function MongoSlowOpsRedirect() {
  const { id } = useParams();
  return <Navigate to={`/mongodb-dashboard/${id}/slow-queries`} replace />;
}

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
  const explicit = new Set(['/dashboard', '/alerts', '/agents', '/databases', '/settings', '/infra', '/administration', '/help-center', '/cloud', '/logs']);
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
      <Route element={(token || AUTH_DISABLED) ? <AppShell user={user} onSignOut={onSignOut} /> : <Navigate to={APP.loginRoute} replace />}>
        <Route index element={<Navigate to={APP.defaultRoute} replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/notifications" element={<SettingsPage />} />
        <Route path="/help-center" element={<HelpCenterPage />} />
        <Route path="/ai-assistant" element={<AiAssistantPage />} />
        <Route path="/logs" element={<LogsPage />} />

        {/* Cloud (AWS/Azure/OCI discovery) — CloudShell is the layout shell,
            everything below is one of its nested routes (its own <Outlet/>).
            Flow: /cloud (choose provider) → /cloud/{provider}-accounts (its
            accounts) → /cloud/{provider}-accounts/:accountId (that account's
            full dashboard, with Resources/Cost/Security/Topology/Compliance/
            Alerts as tabs) — the same shape as /databases → /mysql-servers →
            /mysql-dashboard/:id, and same reason each provider gets its own
            literal route (with a `provider` prop) rather than a dynamic
            :provider segment: a clean, bookmarkable, tech-specific URL. */}
        <Route path="/cloud" element={<CloudShell />}>
          <Route index element={<CloudProviderChooser />} />
          <Route path="accounts" element={<CloudAccountsPage />} />
          <Route path="resources/:resourceId" element={<CloudResourceDetailPage />} />
          <Route path="resources/:resourceId/:tab" element={<CloudResourceDetailPage />} />

          <Route path="aws-accounts" element={<CloudProviderAccountsPage provider="aws" />} />
          <Route path="aws-accounts/:accountId" element={<CloudDashboard provider="aws" />} />
          <Route path="aws-accounts/:accountId/:tab" element={<CloudDashboard provider="aws" />} />

          <Route path="azure-accounts" element={<CloudProviderAccountsPage provider="azure" />} />
          <Route path="azure-accounts/:accountId" element={<CloudDashboard provider="azure" />} />
          <Route path="azure-accounts/:accountId/:tab" element={<CloudDashboard provider="azure" />} />

          <Route path="oci-accounts" element={<CloudProviderAccountsPage provider="oci" />} />
          <Route path="oci-accounts/:accountId" element={<CloudDashboard provider="oci" />} />
          <Route path="oci-accounts/:accountId/:tab" element={<CloudDashboard provider="oci" />} />
        </Route>

        {/* Order matters: the named wizards + the 8 tab routes must be matched
            before :tech (a single dynamic segment would otherwise collide
            with them — static segments always win by specificity, but keep
            them declared first for readability). */}
        <Route path="/agents/setup" element={<AgentSetupPage />} />
        {/* Kept as fallbacks for any old link/bookmark; every card in the
            catalog itself now points at the nested URLs below instead. */}
        <Route path="/agents/setup/website" element={<AddWebsiteWizard />} />
        <Route path="/agents/setup/network-check" element={<AddNetworkCheckWizard />} />
        {/* The "Add Data" tab bar itself — each tab is its own real, governed
            page (see tabSlugs.js), not just client-side state, so a role can
            be denied one tab (e.g. Integrations) without losing the rest. */}
        <Route path="/agents/setup/intro" element={<AgentSetupPage />} />
        <Route path="/agents/setup/digital-experience" element={<AgentSetupPage />} />
        <Route path="/agents/setup/apm" element={<AgentSetupPage />} />
        <Route path="/agents/setup/databases" element={<AgentSetupPage />} />
        <Route path="/agents/setup/infrastructure" element={<AgentSetupPage />} />
        <Route path="/agents/setup/network" element={<AgentSetupPage />} />
        <Route path="/agents/setup/logs" element={<AgentSetupPage />} />
        <Route path="/agents/setup/integrations" element={<AgentSetupPage />} />
        {/* Every catalog card that already has a real, working setup flow gets
            its real feature page nested under its own tab, individually
            governed, instead of living at a flat /agents/setup/<name> URL. */}
        <Route path="/agents/setup/digital-experience/website-availability" element={<AddWebsiteWizard />} />
        <Route path="/agents/setup/digital-experience/tcp-port" element={<AddNetworkCheckWizard checkType="tcp_port" />} />
        <Route path="/agents/setup/digital-experience/ping" element={<AddNetworkCheckWizard checkType="ping" />} />
        <Route path="/agents/setup/digital-experience/dns" element={<AddNetworkCheckWizard checkType="dns" />} />
        <Route path="/agents/setup/digital-experience/udp-port" element={<AddNetworkCheckWizard checkType="udp_port" />} />
        <Route path="/agents/setup/databases/:tech" element={<SetupWizard />} />
        {/* Real, governed routes for every "Add Data" catalog card that doesn't
            have a working setup wizard yet (most APM languages, most Network
            devices, most Infrastructure resource types, the not-yet-built
            Digital Experience checks, all Integrations) — see ComingSoonSetup's
            own comment. One generic pattern for every tab; per-item RBAC comes
            from each item getting its own literal page_master row server-side,
            not from this route itself. */}
        <Route path="/agents/setup/:tabSlug/:itemId" element={<ComingSoonSetup />} />
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
        <Route path="/connections/add" element={<AddConnectionPage />} />
        {/* Every "Diagnose" click site (per-tech dashboards' header button,
            DatabaseServersPage's serverTarget()) navigates here — a dedicated
            full-page workspace, not a modal. */}
        <Route path="/diagnose/:connId" element={<DiagnosisPage />} />
        <Route path="/diagnose/:connId/:tab" element={<DiagnosisPage />} />
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
        <Route path="/mysql-dashboard/:id/slow-queries/detail" element={<SlowQueryDetailPage tech="mysql" />} />
        <Route path="/mysql-dashboard/:id/slow-queries" element={<SlowQueriesPage tech="mysql" />} />
        <Route path="/mysql-dashboard/:id/error-logs" element={<MySQLErrorLogs />} />
        <Route path="/mysql-dashboard/:id/error-analysis" element={<MySQLErrorAnalysis />} />
        <Route path="/mysql-dashboard/:id/self-heal" element={<MySQLSelfHeal />} />
        <Route path="/mysql-dashboard/:id/index-analysis" element={<MySQLIndexAnalysis />} />
        <Route path="/mysql-dashboard/:id/binary-logs/:logName" element={<MySQLBinaryLogDetail />} />
        <Route path="/mysql-dashboard/:id/binary-logs" element={<MySQLBinaryLogs />} />
        <Route path="/mysql-dashboard/:id/reports" element={<MySQLReportsPage />} />
        <Route path="/mysql-dashboard/:id/:tab" element={<MySQLDashboard />} />

        {/* PostgreSQL. Same ordering rule as MySQL — the named sub-pages are
            declared before :tab so the dashboard cannot swallow them, and the
            slow-query detail page before its own parent for the same reason. */}
        <Route path="/postgresql-dashboard/:id" element={<PostgreSQLDashboard />} />
        <Route path="/postgresql-dashboard/:id/slow-queries/detail" element={<SlowQueryDetailPage tech="postgresql" />} />
        <Route path="/postgresql-dashboard/:id/slow-queries" element={<SlowQueriesPage tech="postgresql" />} />
        <Route path="/postgresql-dashboard/:id/error-logs" element={<PgErrorLogs />} />
        <Route path="/postgresql-dashboard/:id/index-analysis" element={<PgIndexAnalysis />} />
        <Route path="/postgresql-dashboard/:id/reports" element={<PgReportsPage />} />
        <Route path="/postgresql-dashboard/:id/:tab" element={<PostgreSQLDashboard />} />

        {/* Oracle. Named sub-pages before :tab, as with the other engines. Live
            Queries is both a dashboard tab and its own route — the same component,
            with `embedded` deciding whether it draws a page header. */}
        <Route path="/oracle-dashboard/:id" element={<OracleDashboard />} />
        <Route path="/oracle-dashboard/:id/live-queries/session" element={<OracleSessionDetailPage />} />
        <Route path="/oracle-dashboard/:id/live-queries" element={<OracleLiveQueries />} />
        <Route path="/oracle-dashboard/:id/slow-queries/detail" element={<SlowQueryDetailPage tech="oracle" />} />
        <Route path="/oracle-dashboard/:id/slow-queries" element={<SlowQueriesPage tech="oracle" />} />
        <Route path="/oracle-dashboard/:id/error-logs" element={<OracleErrorLogs />} />
        <Route path="/oracle-dashboard/:id/index-analysis" element={<OracleIndexAnalysis />} />
        <Route path="/oracle-dashboard/:id/storage-health/object" element={<StorageObjectDetailPage />} />
        <Route path="/oracle-dashboard/:id/storage-health/job" element={<OracleJobDetailPage />} />
        <Route path="/oracle-dashboard/:id/storage-health" element={<OracleStorageHealth />} />
        <Route path="/oracle-dashboard/:id/reports" element={<OracleReportsPage />} />
        <Route path="/oracle-dashboard/:id/:tab" element={<OracleDashboard />} />

        {/* SQL Server. Named sub-pages before :tab, and the slow-query detail page
            before its own parent, for the same reason as the other engines. */}
        <Route path="/mssql-dashboard/:id" element={<MSSQLDashboard />} />
        <Route path="/mssql-dashboard/:id/slow-queries/detail" element={<SlowQueryDetailPage tech="mssql" />} />
        <Route path="/mssql-dashboard/:id/slow-queries" element={<SlowQueriesPage tech="mssql" />} />
        <Route path="/mssql-dashboard/:id/error-logs" element={<MssqlErrorLogs />} />
        <Route path="/mssql-dashboard/:id/index-analysis" element={<MssqlIndexAnalysis />} />
        <Route path="/mssql-dashboard/:id/reports" element={<MssqlReportsPage />} />
        <Route path="/mssql-dashboard/:id/:tab" element={<MSSQLDashboard />} />

        {/* MongoDB. Named sub-pages before :tab, as with the other engines. */}
        <Route path="/mongodb-dashboard/:id" element={<MongoDBDashboard />} />
        <Route path="/mongodb-dashboard/:id/slow-operations" element={<MongoSlowOpsRedirect />} />
        <Route path="/mongodb-dashboard/:id/slow-queries/detail" element={<SlowQueryDetailPage tech="mongodb" />} />
        <Route path="/mongodb-dashboard/:id/slow-queries" element={<SlowQueriesPage tech="mongodb" />} />
        <Route path="/mongodb-dashboard/:id/error-logs" element={<MongoErrorLogs />} />
        <Route path="/mongodb-dashboard/:id/collection-analysis" element={<MongoCollectionAnalysis />} />
        <Route path="/mongodb-dashboard/:id/:tab" element={<MongoDBDashboard />} />

        {/* ClickHouse. Named sub-pages before :tab, as with the other engines. */}
        <Route path="/clickhouse-dashboard/:id" element={<ClickHouseDashboard />} />
        <Route path="/clickhouse-dashboard/:id/slow-queries/detail" element={<SlowQueryDetailPage tech="clickhouse" />} />
        <Route path="/clickhouse-dashboard/:id/slow-queries" element={<SlowQueriesPage tech="clickhouse" />} />
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
            explorer isn't swallowed as a host id. The three 2-segment-:sub
            routes (network/ip-configuration/config-files) are declared before
            the single-segment /:tab catch-all for the same reason the MySQL
            dashboard declares its named routes before its own /:tab. */}
        <Route path="/infra" element={<InfraPage />} />
        <Route path="/infra/hosts" element={<InfraPage />} />
        <Route path="/infra/:id/files" element={<InfraFileExplorer />} />
        <Route path="/infra/:id/network/:sub" element={<InfraHostDetail />} />
        <Route path="/infra/:id/ip-configuration/:sub" element={<InfraHostDetail />} />
        <Route path="/infra/:id/config-files/:sub" element={<InfraHostDetail />} />
        <Route path="/infra/:id/:tab" element={<InfraHostDetail />} />
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
        <Route path="/ai-chat-sessions" element={<AiChatSessionsPage />} />
        <Route path="/help-center-appearance" element={<HelpCenterAppearancePage />} />

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
