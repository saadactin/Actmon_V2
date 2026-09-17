import { useNavigate, useParams } from 'react-router-dom';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import {
  Server, DollarSign, ShieldAlert, LayoutDashboard, Share2,
  GitCompareArrows, ScrollText,
} from 'lucide-react';
import CloudPageHeader from '../components/CloudPageHeader';
import ProviderLogo from '../components/ProviderLogo';
import Tabs from '@/components/ui/Tabs';
import CloudOverview from './CloudOverview';
import { ResourcesPage } from './ResourcesPage';
import CostIntelligencePage from './CostIntelligencePage';
import SecurityCenterPage from './SecurityCenterPage';
import { CloudTopologyPage } from './CloudTopologyPage';
import { ConfigDriftPage } from './ConfigDriftPage';
import { EventLogPage } from './EventLogPage';

// NOTE: `getSecurityGrade` used to live here — a second, independent mapping
// from score to letter grade, feeding a card that was itself scored by a
// different engine from the Security Center. Both are gone. The canonical
// assessment returns the score AND the grade together, and the Overview
// renders what it is given rather than re-deriving either.

const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'resources', label: 'Resources', icon: Server },
  { id: 'cost', label: 'Cost', icon: DollarSign },
  // One tab replaces the former Security, Compliance and Alerts trio. They were
  // three independent evaluations of the same estate with nothing enforcing
  // that they agreed — and on live data they did not: 3 of AWS's 20 MEDIUM
  // compliance violations came from a rule firing on the wrong provider, and
  // none of the 82 CRITICAL AWS findings had ever produced an alert. The
  // Security Center's own tabs are all views over one canonical finding set.
  { id: 'security', label: 'Security Center', icon: ShieldAlert },
  { id: 'topology', label: 'Topology', icon: Share2 },
  // Beside Alerts on purpose: an alert says a condition is true now, drift says
  // what changed to make it true.
  { id: 'drift', label: 'Config Drift', icon: GitCompareArrows },
  // And beside Config Drift for the same reason one step further: drift says
  // WHAT changed, the event log says WHO changed it, from where, how, and what
  // the provider answered. The two link to each other in both directions.
  { id: 'events', label: 'Event Log', icon: ScrollText },
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
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-border bg-white">
            <ProviderLogo provider={scopedAccount?.provider} size={28} />
          </span>
        )}
        title={scopedAccount?.account_name || 'Account'}
        description={[scopedAccount?.provider, scopedAccount?.tenant_or_region || scopedAccount?.environment].filter(Boolean).join(' · ')}
        tabs={<Tabs tabs={TABS} value={tab} onChange={setTab} />}
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

      {tab === 'resources' && <ResourcesPage embedded accountId={routeAccountId} />}
      {tab === 'cost' && (
        <CostIntelligencePage key={routeAccountId} embedded accountId={routeAccountId} />
      )}
      {/* Keyed on the account so switching accounts resets the tab, filters and
          any open finding rather than carrying another account's triage across. */}
      {tab === 'security' && (
        <SecurityCenterPage key={routeAccountId} embedded accountId={routeAccountId} />
      )}
      {tab === 'topology' && <CloudTopologyPage embedded accountId={routeAccountId} />}
      {/* The old Compliance and Alerts tab ids still resolve, so a bookmarked
          URL lands somewhere sensible instead of on an empty page. */}
      {(tab === 'compliance' || tab === 'alerts') && (
        <SecurityCenterPage key={routeAccountId} embedded accountId={routeAccountId} />
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
