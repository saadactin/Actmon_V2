import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import {
  Server, DollarSign, ShieldAlert, LayoutDashboard, Share2,
  GitCompareArrows, ScrollText, BellRing, Lightbulb, KeyRound, FileText,
} from 'lucide-react';
import CloudPageHeader from '../components/CloudPageHeader';
import ProviderLogo from '../components/ProviderLogo';
import { providerTileStyle } from '../utils/providerTheme';
import AccountRefreshBar from '../components/refresh/AccountRefreshBar';
import TabRefreshButton from '../components/refresh/TabRefreshButton';
import { DELEGATED_TABS } from '../utils/tabRefreshModel';
import Tabs from '@/components/ui/Tabs';
import CloudOverview from './CloudOverview';
import { ResourcesPage } from './ResourcesPage';
import CostIntelligencePage from './CostIntelligencePage';
import SecurityCenterPage from './SecurityCenterPage';
import { CloudTopologyPage } from './CloudTopologyPage';
import { ConfigDriftPage } from './ConfigDriftPage';
import { EventLogPage } from './EventLogPage';
import AlertsPage from './AlertsPage';
import ResourceIntelligencePage from './ResourceIntelligencePage';
import IdentityAccessPage from './IdentityAccessPage';
import ReportBuilderPage from './reports/ReportBuilderPage';

// NOTE: `getSecurityGrade` used to live here — a second, independent mapping
// from score to letter grade, feeding a card that was itself scored by a
// different engine from the Security Center. Both are gone. The canonical
// assessment returns the score AND the grade together, and the Overview
// renders what it is given rather than re-deriving either.

const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  // Second, because it is where "what is wrong and what do I do" is answered:
  // optimization findings from the telemetry-backed engine, beside the
  // Security Center's findings (read from its table, not re-evaluated).
  { id: 'intelligence', label: 'Intelligence', icon: Lightbulb },
  { id: 'resources', label: 'Resources', icon: Server },
  { id: 'cost', label: 'Cost', icon: DollarSign },
  // Pulls from every tab before it (Security, Resource Intelligence, Cost)
  // rather than owning a second copy of any of their data — see
  // ReportBuilderPage.jsx and Backend/cloud/app/services/report_service.py.
  { id: 'reports', label: 'Reports', icon: FileText },
  // One tab replaces the former Security, Compliance and Alerts trio. They were
  // three independent evaluations of the same estate with nothing enforcing
  // that they agreed — and on live data they did not: 3 of AWS's 20 MEDIUM
  // compliance violations came from a rule firing on the wrong provider, and
  // none of the 82 CRITICAL AWS findings had ever produced an alert. The
  // Security Center's own tabs are all views over one canonical finding set.
  { id: 'security', label: 'Security Center', icon: ShieldAlert },
  // Beside the Security Center because it answers the other half of the same
  // question. The Security Center asks "what is wrong with this estate"; this
  // asks "who can reach it, what can they actually do, and how much of that
  // access is being used". Its findings land in the Security Center's table
  // rather than in a second one.
  { id: 'identity', label: 'Identity & Access', icon: KeyRound },
  { id: 'topology', label: 'Topology', icon: Share2 },
  // Beside Alerts on purpose: an alert says a condition is true now, drift says
  // what changed to make it true.
  { id: 'drift', label: 'Config Drift', icon: GitCompareArrows },
  // And beside Config Drift for the same reason one step further: drift says
  // WHAT changed, the event log says WHO changed it, from where, how, and what
  // the provider answered. The two link to each other in both directions.
  { id: 'events', label: 'Event Log', icon: ScrollText },
  // Last, and deliberately not first: Alerts is a CONSUMER of every tab before
  // it. It owns no scanner, no cost engine and no event collector — it reads
  // what those already decided and turns it into "tell this person now". The
  // old 'alerts' tab id (which redirected to the Security Center after the
  // Security/Compliance/Alerts merge) is this tab again, so a bookmark from
  // before that merge lands somewhere that makes sense.
  { id: 'alerts', label: 'Alerts', icon: BellRing },
];

/**
 * One cloud account's full dashboard — reached via Cloud → Provider → Account,
 * exactly the way a database connection's own dashboard (e.g. PostgreSQL
 * Dashboard) is reached via Databases → Servers → connection. Overview,
 * Resources, Cost, Security, Topology, Compliance, Alerts and Config Drift are
 * TABS of this one page, scoped to this one account, instead of separate
 * top-level pages — the same shape as EngineDashboardHeader's
 * Overview/Performance/Queries/… tabs for a database connection.
 */
// `provider` ('aws' | 'azure' | 'oci') comes in as a literal prop from the
// route definition (App.jsx), same as CloudProviderAccountsPage — only
// `accountId`/`tab` are genuine dynamic route params.
export const CloudDashboard = ({ provider: routeProviderSlug }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { accountId: routeAccountId, tab = 'overview' } = useParams();
  const { data: accounts } = useCloudAccounts();

  const scopedAccount = (accounts || []).find((a) => a.id === routeAccountId);

  const setTab = (id) => navigate(`/cloud/${routeProviderSlug}-accounts/${routeAccountId}/${id}`, { replace: true });

  return (
    <>
      <CloudPageHeader
        hideBreadcrumbs
        backTo={`/cloud/${routeProviderSlug}-accounts`}
        leading={(
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md border" style={providerTileStyle(scopedAccount?.provider)}>
            <ProviderLogo provider={scopedAccount?.provider} size={28} />
          </span>
        )}
        title={scopedAccount?.account_name || 'Account'}
        description={[scopedAccount?.provider, scopedAccount?.tenant_or_region || scopedAccount?.environment].filter(Boolean).join(' · ')}
        /* "Refresh all" for the whole account, in the header every tab
           shares — every tab re-reads when it finishes. Each tab also has its
           own narrower "Refresh <tab>" beside the tab strip (below). */
        actions={routeAccountId && (
          <AccountRefreshBar account={scopedAccount} accountId={routeAccountId} />
        )}
        tabs={(
          <>
            <Tabs tabs={TABS} value={tab} onChange={setTab} className="min-w-0 flex-1" />
            {/* The Security Center's refresh sits on its own sub-tab strip,
                where it can be specific to the sub-tab. */}
            {routeAccountId && !DELEGATED_TABS.includes(tab) && (
              <TabRefreshButton accountId={routeAccountId} tabKey={tab} className="ml-auto pl-3" />
            )}
          </>
        )}
      />

      {/* Overview is its own component now. It was ~230 lines of inline JSX
          that counted the whole estate in the browser and scored security a
          second way; both are gone, and the tab shell is just a shell. */}
      {tab === 'overview' && (
        <CloudOverview
          key={routeAccountId}
          account={scopedAccount}
          accountId={routeAccountId}
          providerSlug={routeProviderSlug}
        />
      )}

      {tab === 'intelligence' && (
        <ResourceIntelligencePage
          key={routeAccountId}
          accountId={routeAccountId}
          providerSlug={routeProviderSlug}
        />
      )}
      {tab === 'resources' && <ResourcesPage embedded accountId={routeAccountId} />}
      {tab === 'reports' && (
        <ReportBuilderPage
          key={routeAccountId}
          accountId={routeAccountId}
          preSelectedResourceIds={location.state?.resourceIds || []}
        />
      )}
      {tab === 'cost' && (
        <CostIntelligencePage
          key={routeAccountId}
          embedded
          accountId={routeAccountId}
          providerSlug={routeProviderSlug}
        />
      )}
      {/* Keyed on the account so switching accounts resets the tab, filters and
          any open finding rather than carrying another account's triage across. */}
      {tab === 'security' && (
        <SecurityCenterPage key={routeAccountId} embedded accountId={routeAccountId} />
      )}
      {tab === 'identity' && (
        <IdentityAccessPage key={routeAccountId} embedded accountId={routeAccountId} />
      )}
      {tab === 'topology' && <CloudTopologyPage embedded accountId={routeAccountId} />}
      {/* 'compliance' is still a Security Center view, so a bookmarked URL from
          before the Security/Compliance/Alerts merge lands somewhere sensible.
          'alerts' is no longer redirected here — it is a real tab again. */}
      {tab === 'compliance' && (
        <SecurityCenterPage key={routeAccountId} embedded accountId={routeAccountId} />
      )}
      {/* Keyed on the account like the others: the rule list, the history
          filters and any open alert are all account-scoped, and carrying one
          account's alerting configuration across to another would be actively
          dangerous rather than merely confusing. */}
      {tab === 'alerts' && (
        <AlertsPage
          key={routeAccountId}
          embedded
          accountId={routeAccountId}
          account={scopedAccount}
        />
      )}
      {/* Keyed on the account so switching accounts resets the window/filter
          state instead of carrying another account's drill-down across. */}
      {tab === 'drift' && (
        <ConfigDriftPage key={routeAccountId} embedded accountId={routeAccountId} />
      )}
      {/* Keyed on the account for the same reason as drift: the window, the
          filter set and the open event are all account-scoped, and carrying
          another account's investigation across would be actively misleading. */}
      {tab === 'events' && (
        <EventLogPage key={routeAccountId} embedded accountId={routeAccountId} />
      )}
    </>
  );
};
