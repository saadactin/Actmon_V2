import { useNavigate } from 'react-router-dom';
import { ChevronRight, Plus, Server, Settings } from 'lucide-react';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useAllResources } from '../hooks/useResources';
import CloudPageHeader from '../components/CloudPageHeader';
import Badge from '@/components/ui/Badge';
import { usePermissions } from '@/hooks/usePermissions';

// URL slug ↔ stored provider value ("Oracle" from the API counts as OCI's tile).
const PROVIDERS = [
  { slug: 'aws', key: 'AWS', name: 'Amazon Web Services', subtitle: 'AWS', emoji: '🟠',
    accent: 'bg-gradient-to-br from-orange-400 to-orange-600', lightBg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700', hover: 'hover:border-orange-300 hover:shadow-orange-100/60' },
  { slug: 'azure', key: 'Azure', name: 'Microsoft Azure', subtitle: 'Azure', emoji: '🔵',
    accent: 'bg-gradient-to-br from-sky-400 to-sky-700', lightBg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-700', hover: 'hover:border-sky-300 hover:shadow-sky-100/60' },
  { slug: 'oci', key: 'OCI', name: 'Oracle Cloud Infrastructure', subtitle: 'OCI', emoji: '🔴',
    accent: 'bg-gradient-to-br from-red-400 to-red-600', lightBg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', hover: 'hover:border-red-300 hover:shadow-red-100/60' },
];

// The API sends "Oracle" for OCI accounts on some records — normalize for counting.
const providerKeyOf = (p) => (p === 'Oracle' ? 'OCI' : p);

export default function CloudProviderChooser() {
  const navigate = useNavigate();
  const { data: accounts } = useCloudAccounts();
  const { data: allResources } = useAllResources();
  const { canHere } = usePermissions();

  const providerStats = PROVIDERS.map((p) => {
    const provAccounts = (accounts || []).filter((a) => providerKeyOf(a.provider) === p.key);
    const provAccountIds = new Set(provAccounts.map((a) => a.id));
    const provResources = (allResources || []).filter((r) => provAccountIds.has(r.account_id));
    return { ...p, accountCount: provAccounts.length, resourceCount: provResources.length };
  });

  const totalAccounts = accounts?.length || 0;
  const totalResources = allResources?.length || 0;

  return (
    <>
      <CloudPageHeader
        title="Cloud Infrastructure"
        description="Select a cloud provider to explore its accounts, resources & cost"
        actions={(
          <div className="flex items-center gap-2">
            <Badge tone="neutral" className="gap-1.5">
              {totalAccounts} account{totalAccounts !== 1 ? 's' : ''}
            </Badge>
            <Badge tone="neutral" className="gap-1.5">
              {totalResources} resource{totalResources !== 1 ? 's' : ''}
            </Badge>
            <button
              onClick={() => navigate('/cloud/accounts')}
              className="flex h-control shrink-0 items-center gap-1.5 rounded-control border border-border px-2.5 text-[12px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
            >
              <Settings size={13} /> Manage Accounts
            </button>
            {canHere('add') && (
              <button
                onClick={() => navigate('/cloud/accounts')}
                className="flex h-control shrink-0 items-center gap-1.5 rounded-control bg-accent px-3.5 text-[13px] font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
              >
                <Plus size={15} /> Add Account
              </button>
            )}
          </div>
        )}
      />

      <div className="mx-auto w-full">
        <div className="mb-7 flex items-center gap-3">
          <h2 className="text-[18px] font-black text-fg">Choose Cloud Provider</h2>
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs font-medium text-muted">{providerStats.length} providers available</span>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {providerStats.map((p) => {
            const isEmpty = p.accountCount === 0;
            return (
              <button
                key={p.slug}
                onClick={() => navigate(`/cloud/${p.slug}-accounts`)}
                className={`group relative rounded-2xl border-2 border-border bg-surface p-6 text-left
                  shadow-md transition-all duration-200 hover:-translate-y-1 hover:shadow-xl ${p.hover}`}
              >
                <div className={`pointer-events-none absolute top-0 right-0 h-28 w-28 rounded-2xl opacity-0 transition-opacity group-hover:opacity-[0.07] ${p.accent}`} />

                <div className="flex items-start gap-4">
                  <div className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl shadow-lg ${p.accent}`}>
                    <span className="select-none text-2xl">{p.emoji}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[17px] font-black leading-tight text-fg">{p.name}</h3>
                    <p className="mt-0.5 text-xs font-medium text-muted">{p.subtitle}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <div className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 ${p.lightBg} ${p.border} border`}>
                        <Server size={11} className={p.text} />
                        <span className={`text-[12px] font-black ${p.text}`}>{p.accountCount}</span>
                        <span className={`text-[10px] ${p.text} opacity-70`}>accounts</span>
                      </div>
                      <div className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 ${p.lightBg} ${p.border} border`}>
                        <Server size={11} className={p.text} />
                        <span className={`text-[12px] font-black ${p.text}`}>{p.resourceCount}</span>
                        <span className={`text-[10px] ${p.text} opacity-70`}>resources</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
                  {isEmpty ? (
                    <span className="text-[11px] font-medium text-muted">No accounts yet · click to add</span>
                  ) : (
                    <span className={`text-[12px] font-bold ${p.text}`}>
                      Explore {p.accountCount} account{p.accountCount !== 1 ? 's' : ''}
                    </span>
                  )}
                  <ChevronRight size={15} className={`${p.text} transition-transform group-hover:translate-x-1`} />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
