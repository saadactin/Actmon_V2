import { useNavigate } from 'react-router-dom';
import { Building2, ChevronRight, Lock, Plus, Server, Settings } from 'lucide-react';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useAccountResourceCounts } from '../hooks/useResources';
import CloudPageHeader from '../components/CloudPageHeader';
import ProviderLogo from '../components/ProviderLogo';
// The API sends "Oracle" for OCI accounts on some records; `providerKeyOf` is the
// one normalisation — this page used to carry its own copy of it.
import { providerKeyOf } from '../utils/providerScope';
import { providerAccentStyle, providerBadgeStyle, providerInkStyle, providerTileStyle } from '../utils/providerTheme';
import { usePermissions } from '@/hooks/usePermissions';

/* URL slug ↔ stored provider value ("Oracle" from the API counts as OCI's tile).
   Each tile's colours come from the brand registry rather than the five
   Tailwind palette classes that used to be written out here per provider:
   `bg-orange-50` and friends are fixed light-theme swatches, so the whole
   chooser — the page a user lands on first — rendered as three white cards on
   the dim / dark / midnight themes. */
const PROVIDERS = [
  { slug: 'aws', key: 'AWS', name: 'Amazon Web Services', subtitle: 'AWS' },
  { slug: 'azure', key: 'Azure', name: 'Microsoft Azure', subtitle: 'Azure' },
  { slug: 'oci', key: 'OCI', name: 'Oracle Cloud Infrastructure', subtitle: 'OCI' },
];

export default function CloudProviderChooser() {
  const navigate = useNavigate();
  const { data: accounts } = useCloudAccounts();
  // Counted in the database, not by downloading the estate to measure it.
  const { data: counts } = useAccountResourceCounts();
  const { canHere } = usePermissions();

  const providerStats = PROVIDERS.map((p) => {
    const provAccounts = (accounts || []).filter((a) => providerKeyOf(a.provider) === p.key);
    return {
      ...p,
      accountCount: provAccounts.length,
      // Keyed on the canonical provider key, so an account stored as "Oracle"
      // still lands in the OCI tile.
      resourceCount: provAccounts.reduce(
        (sum, a) => sum + (counts?.byAccount?.[a.id] || 0), 0,
      ),
    };
  });

  const totalAccounts = accounts?.length || 0;
  const totalResources = counts?.total ?? 0;

  return (
    <>
      <CloudPageHeader
        title="Cloud Infrastructure"
        hideBreadcrumbs
        actions={(
          <div className="flex items-center gap-2">
            {/* Same h-control height as the buttons beside them — Badge's own
                size="sm" (the default) is a much shorter pill, which made
                these look visibly smaller than Manage Accounts/Add Account. */}
            <span className="flex h-control items-center rounded-control border border-border px-3 text-[13px] font-semibold text-fg">
              {totalAccounts} account{totalAccounts !== 1 ? 's' : ''}
            </span>
            <span className="flex h-control items-center rounded-control border border-border px-3 text-[13px] font-semibold text-fg">
              {totalResources} resource{totalResources !== 1 ? 's' : ''}
            </span>
            <button
              onClick={() => navigate('/cloud/clients')}
              className="flex h-control shrink-0 items-center gap-1.5 rounded-control border border-border px-2.5 text-[12px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
            >
              <Building2 size={13} /> Clients
            </button>
            <button
              onClick={() => navigate('/cloud/certificates')}
              className="flex h-control shrink-0 items-center gap-1.5 rounded-control border border-border px-2.5 text-[12px] font-semibold text-muted transition-colors hover:bg-sunken hover:text-fg"
            >
              <Lock size={13} /> Certificates
            </button>
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
                className="group relative rounded-2xl border-2 border-border bg-surface p-6 text-left
                  shadow-md transition-all duration-200 hover:-translate-y-1 hover:border-strong hover:shadow-xl"
              >
                <div
                  className="pointer-events-none absolute top-0 right-0 h-28 w-28 rounded-2xl opacity-0 transition-opacity group-hover:opacity-[0.07]"
                  style={providerAccentStyle(p.key)}
                />

                <div className="flex items-start gap-4">
                  {/* A plate tinted with the provider's own hue. It was a pinned
                      white one, which fought the dark themes rather than the
                      logo — the logos carry their own brand colours, so the
                      plate only has to separate them from the card. */}
                  <div
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border shadow-md"
                    style={providerTileStyle(p.key)}
                  >
                    <ProviderLogo provider={p.key} size={36} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[17px] font-black leading-tight text-fg">{p.name}</h3>
                    <p className="mt-0.5 text-xs font-medium text-muted">{p.subtitle}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1" style={providerBadgeStyle(p.key)}>
                        <Server size={11} />
                        <span className="text-[12px] font-black">{p.accountCount}</span>
                        <span className="text-micro opacity-70">accounts</span>
                      </div>
                      <div className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1" style={providerBadgeStyle(p.key)}>
                        <Server size={11} />
                        <span className="text-[12px] font-black">{p.resourceCount}</span>
                        <span className="text-micro opacity-70">resources</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
                  {isEmpty ? (
                    <span className="text-meta font-medium text-muted">No accounts yet · click to add</span>
                  ) : (
                    <span className="text-[12px] font-bold" style={providerInkStyle(p.key)}>
                      Explore {p.accountCount} account{p.accountCount !== 1 ? 's' : ''}
                    </span>
                  )}
                  <ChevronRight size={15} className="transition-transform group-hover:translate-x-1" style={providerInkStyle(p.key)} />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
