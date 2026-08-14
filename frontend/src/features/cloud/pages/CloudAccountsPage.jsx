import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CloudAccountList } from '../components/CloudAccountList';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useAllResources } from '../hooks/useResources';
import { providerKeyOf } from '../utils/providerScope';
import { useCloudStore } from '../state/cloudStore';
import { usePermissions } from '@/hooks/usePermissions';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudToolbar from '../components/CloudToolbar';
import CloudFilterBar from '../components/CloudFilterBar';
import Icon from '@/components/ui/Icon';
import Button from '@/components/ui/Button';

// Same pinned brand colours as CloudProviderSelector/CloudProviderChooser.
// Each card is a link to that provider's own accounts page (/cloud/{slug}-
// accounts) — the same relationship the tech-servers page's KPI row would
// have to a dedicated per-tech page, if Databases had a cross-tech list too.
const PROVIDER_KPI = [
  { key: 'AWS', slug: 'aws', label: 'AWS', iconBg: 'bg-orange-50', iconColor: 'text-orange-500', valueColor: 'text-orange-600' },
  { key: 'Azure', slug: 'azure', label: 'Azure', iconBg: 'bg-sky-50', iconColor: 'text-sky-500', valueColor: 'text-sky-600' },
  { key: 'OCI', slug: 'oci', label: 'OCI', iconBg: 'bg-red-50', iconColor: 'text-red-500', valueColor: 'text-red-600' },
];

export const CloudAccountsPage = () => {
  const navigate = useNavigate();
  const setDrawerOpen = useCloudStore((state) => state.setAddAccountDrawerOpen);
  const { canHere } = usePermissions();
  const { data: accounts } = useCloudAccounts();
  const { data: allResources } = useAllResources();
  const [search, setSearch] = useState('');

  const totalAccounts = accounts?.length || 0;
  const totalResources = allResources?.length || 0;
  const providerCounts = PROVIDER_KPI.map((p) => ({
    ...p,
    count: (accounts || []).filter((a) => providerKeyOf(a.provider) === p.key).length,
  }));

  return (
    <>
      <CloudPageHeader
        backTo="/cloud"
        title="Cloud Accounts"
        description="Manage connections to AWS, Azure, and OCI."
        hideBreadcrumbs
        actions={canHere('add') && (
          <CloudToolbar>
            <Button variant="primary" icon="plus" onClick={() => setDrawerOpen(true)}>
              Add Account
            </Button>
          </CloudToolbar>
        )}
      />

      {/* KPI cards — AWS/Azure/OCI open that provider's own accounts page */}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5 shadow-sm">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-sunken text-subtle">
            <Icon name="cloud" size={18} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wide text-subtle">Total</p>
            <p className="text-2xl leading-none font-black text-fg">{totalAccounts}</p>
            <p className="mt-0.5 truncate text-[10px] text-subtle">accounts</p>
          </div>
        </div>

        {providerCounts.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => navigate(`/cloud/${p.slug}-accounts`)}
            className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-strong hover:shadow-md"
          >
            <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${p.iconBg} ${p.iconColor}`}>
              <Icon name="cloud" size={18} />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-wide text-subtle">{p.label}</p>
              <p className={`text-2xl leading-none font-black ${p.valueColor}`}>{p.count}</p>
              <p className="mt-0.5 truncate text-[10px] text-subtle">accounts</p>
            </div>
          </button>
        ))}

        <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5 shadow-sm">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-text">
            <Icon name="boxes" size={18} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wide text-subtle">Resources</p>
            <p className="text-2xl leading-none font-black text-fg">{totalResources}</p>
            <p className="mt-0.5 truncate text-[10px] text-subtle">discovered</p>
          </div>
        </div>
      </div>

      <CloudFilterBar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search account name…"
        className="mb-4"
      />

      {/* No outer .card wrapper — same reason as AgentsPage.jsx/InfraPage.jsx's
          own list tables: darkHeader mode already renders each row as its own
          floating rounded card on a plain backdrop. */}
      <CloudAccountList search={search} />
    </>
  );
};
