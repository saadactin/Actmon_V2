import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Cloud, Plus, Server } from 'lucide-react';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useAllResources } from '../hooks/useResources';
import { PROVIDER_META } from '../components/CloudProviderSelector';

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

  const providerStats = PROVIDERS.map((p) => {
    const provAccounts = (accounts || []).filter((a) => providerKeyOf(a.provider) === p.key);
    const provAccountIds = new Set(provAccounts.map((a) => a.id));
    const provResources = (allResources || []).filter((r) => provAccountIds.has(r.account_id));
    return { ...p, accountCount: provAccounts.length, resourceCount: provResources.length };
  });

  const totalAccounts = accounts?.length || 0;
  const totalResources = allResources?.length || 0;

  return (
    <div className="min-h-full bg-[#f1f4f9]">
      {/* Hero — matches the Databases "Choose Technology" hero exactly */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 pt-3 pb-4 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />

        <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5">
          <span>ActMon</span>
          <ChevronRight size={11} />
          <span className="text-white font-semibold">Cloud</span>
        </div>

        <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-sky-400/20 border border-sky-400/40 flex items-center justify-center flex-shrink-0">
              <Cloud size={18} className="text-sky-200" />
            </div>
            <div>
              <h1 className="text-lg font-black text-white tracking-tight leading-none">Cloud Infrastructure</h1>
              <p className="text-sky-200/70 text-[11px] mt-0.5">Select a cloud provider to explore accounts &amp; resources</p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 flex-shrink-0">
            <div className="hidden md:flex items-center gap-2.5 bg-white/10 border border-white/15 rounded-xl px-3 py-1.5 backdrop-blur-sm">
              <div>
                <p className="text-white font-black text-[13px] leading-none">{totalAccounts}</p>
                <p className="text-sky-200/70 text-[10px] mt-0.5">accounts</p>
              </div>
              <div className="h-6 w-px bg-white/15" />
              <div>
                <p className="text-white font-black text-[13px] leading-none">{totalResources}</p>
                <p className="text-sky-200/70 text-[10px] mt-0.5">resources</p>
              </div>
            </div>
            <button
              onClick={() => navigate('/cloud/accounts')}
              className="h-9 px-4 rounded-lg bg-white text-blue-700 font-bold flex items-center gap-1.5 hover:bg-sky-50 shadow-sm transition-all text-sm flex-shrink-0"
            >
              <Plus size={15} /> Add Account
            </button>
          </div>
        </div>
      </div>

      {/* Provider Grid */}
      <div className="max-w-screen-2xl mx-auto px-8 py-10">
        <div className="flex items-center gap-3 mb-7">
          <h2 className="text-[18px] font-black text-slate-800">Choose Cloud Provider</h2>
          <div className="flex-1 h-px bg-slate-200" />
          <span className="text-xs text-slate-400 font-medium">{providerStats.length} providers available</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {providerStats.map((p) => {
            const isEmpty = p.accountCount === 0;
            return (
              <button
                key={p.slug}
                onClick={() => navigate(isEmpty ? '/cloud/accounts' : `/cloud/${p.slug}`)}
                className={`group relative bg-white rounded-2xl border-2 border-slate-100 p-6 text-left
                  shadow-md hover:shadow-xl transition-all duration-200 hover:-translate-y-1 ${p.hover}`}
              >
                <div className={`absolute top-0 right-0 w-28 h-28 rounded-2xl opacity-0 group-hover:opacity-[0.07] transition-opacity ${p.accent} pointer-events-none`} />

                <div className="flex items-start gap-4">
                  <div className={`w-14 h-14 rounded-2xl ${p.accent} flex items-center justify-center flex-shrink-0 shadow-lg`}>
                    <span className="text-2xl select-none">{p.emoji}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-[17px] font-black text-slate-900 leading-tight">{p.name}</h3>
                    <p className="text-xs text-slate-400 mt-0.5 font-medium">{p.subtitle}</p>
                    <div className="flex items-center gap-3 mt-3 flex-wrap">
                      <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${p.lightBg} ${p.border} border`}>
                        <Cloud size={11} className={p.text} />
                        <span className={`text-[12px] font-black ${p.text}`}>{p.accountCount}</span>
                        <span className={`text-[10px] ${p.text} opacity-70`}>accounts</span>
                      </div>
                      <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${p.lightBg} ${p.border} border`}>
                        <Server size={11} className={p.text} />
                        <span className={`text-[12px] font-black ${p.text}`}>{p.resourceCount}</span>
                        <span className={`text-[10px] ${p.text} opacity-70`}>resources</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between mt-5 pt-4 border-t border-slate-100">
                  {isEmpty ? (
                    <span className="text-[11px] text-slate-400 font-medium">No accounts yet · click to add</span>
                  ) : (
                    <span className={`text-[12px] font-bold ${p.text}`}>
                      Explore {p.accountCount} account{p.accountCount !== 1 ? 's' : ''}
                    </span>
                  )}
                  <ChevronRight size={15} className={`${p.text} group-hover:translate-x-1 transition-transform`} />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
