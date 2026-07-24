import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight, Cloud, Clock, Globe, Plus, Server } from 'lucide-react';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { useAllResources } from '../hooks/useResources';
import { PROVIDER_META } from '../components/CloudProviderSelector';

const SLUG_TO_KEY = { aws: 'AWS', azure: 'Azure', oci: 'OCI' };
const providerKeyOf = (p) => (p === 'Oracle' ? 'OCI' : p);

export default function CloudProviderAccountsPage() {
  const navigate = useNavigate();
  const { provider: slug } = useParams();
  const providerKey = SLUG_TO_KEY[(slug || '').toLowerCase()] || slug;
  const meta = PROVIDER_META[providerKey] || { label: providerKey, color: '#64748b', bg: '#f1f5f9', logo: '☁️' };

  const { data: accounts, isLoading } = useCloudAccounts();
  const { data: allResources } = useAllResources();

  const providerAccounts = (accounts || []).filter((a) => providerKeyOf(a.provider) === providerKey);
  const resourceCountFor = (accountId) => (allResources || []).filter((r) => r.account_id === accountId).length;

  return (
    <div className="min-h-full bg-[#f1f4f9]">
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 pt-3 pb-4 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />

        <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5">
          <span>ActMon</span><ChevronRight size={11} />
          <button onClick={() => navigate('/cloud')} className="hover:text-white/90 transition-colors">Cloud</button>
          <ChevronRight size={11} /><span className="text-white font-semibold">{providerKey}</span>
        </div>

        <div className="relative flex items-center gap-3">
          <button onClick={() => navigate('/cloud')}
            className="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 flex items-center justify-center flex-shrink-0" title="Back to providers">
            <ArrowLeft size={16} className="text-white" />
          </button>
          <div className="w-9 h-9 rounded-lg bg-white/15 border border-white/25 flex items-center justify-center flex-shrink-0 text-lg">
            {meta.logo}
          </div>
          <div>
            <h1 className="text-lg font-black text-white tracking-tight leading-none">{meta.label || providerKey}</h1>
            <p className="text-sky-200/70 text-[11px] mt-0.5">{providerAccounts.length} account{providerAccounts.length !== 1 ? 's' : ''} · pick one to view its dashboard</p>
          </div>
          <button
            onClick={() => navigate('/cloud/accounts')}
            className="ml-auto h-9 px-4 rounded-lg bg-white text-blue-700 font-bold flex items-center gap-1.5 hover:bg-sky-50 shadow-sm transition-all text-sm flex-shrink-0"
          >
            <Plus size={15} /> Add Account
          </button>
        </div>
      </div>

      <div className="max-w-screen-2xl mx-auto px-8 py-10">
        <div className="flex items-center gap-3 mb-7">
          <h2 className="text-[18px] font-black text-slate-800">Accounts</h2>
          <div className="flex-1 h-px bg-slate-200" />
        </div>

        {isLoading ? (
          <div className="text-center py-16 text-slate-400 text-sm">Loading accounts…</div>
        ) : providerAccounts.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-16 text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
              <Cloud size={28} className="text-slate-300" />
            </div>
            <h3 className="text-lg font-black text-slate-700">No {providerKey} accounts connected</h3>
            <p className="text-slate-400 text-sm mt-1">Add a {providerKey} account to start discovering its resources.</p>
            <button onClick={() => navigate('/cloud/accounts')}
              className="mt-5 h-10 px-5 rounded-xl bg-blue-600 text-white font-bold text-sm hover:bg-blue-700 shadow inline-flex items-center gap-2">
              <Plus size={16} /> Add {providerKey} Account
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {providerAccounts.map((acc) => {
              const resourceCount = resourceCountFor(acc.id);
              return (
                <button
                  key={acc.id}
                  onClick={() => navigate(`/cloud/${slug}/${acc.id}`)}
                  className="group relative bg-white rounded-2xl border-2 border-slate-100 p-6 text-left shadow-md hover:shadow-xl transition-all duration-200 hover:-translate-y-1"
                  style={{ borderColor: undefined }}
                >
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm text-xl"
                      style={{ background: meta.bg, color: meta.color }}>
                      {meta.logo}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-[16px] font-black text-slate-900 leading-tight truncate">{acc.account_name}</h3>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {acc.environment && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">{acc.environment}</span>
                        )}
                        <span className="text-[11px] text-slate-400 flex items-center gap-1"><Globe size={10} /> {acc.tenant_or_region}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 mt-4 flex-wrap">
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-50 border border-slate-200">
                      <Server size={11} className="text-slate-500" />
                      <span className="text-[12px] font-black text-slate-700">{resourceCount}</span>
                      <span className="text-[10px] text-slate-400">resources</span>
                    </div>
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-50 border border-slate-200">
                      <Clock size={11} className="text-slate-500" />
                      <span className="text-[11px] text-slate-500">
                        {acc.last_discovery ? new Date(acc.last_discovery).toLocaleDateString() : 'Never scanned'}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-5 pt-4 border-t border-slate-100">
                    <span className="text-[12px] font-bold" style={{ color: meta.color }}>Open dashboard</span>
                    <ChevronRight size={15} style={{ color: meta.color }} className="group-hover:translate-x-1 transition-transform" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
