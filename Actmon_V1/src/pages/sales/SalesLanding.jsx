import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Briefcase, Building2, Info, Sparkles, BookOpen } from 'lucide-react';

const TILES = [
  { id: 'register', title: 'Register Organization', desc: 'Onboard a new client: register the org, accept policy, pick modules & pages, enter deployment details, and build their installer.', icon: Building2, accent: 'from-blue-500 to-sky-600', text: 'text-blue-600', cta: 'Start onboarding' },
  { id: 'about',    title: 'ActMon Information',     desc: 'What ActMon is, the platform architecture, supported databases, agents, cloud & infrastructure monitoring.', icon: Info, accent: 'from-indigo-500 to-violet-600', text: 'text-indigo-600', cta: 'Learn more' },
  { id: 'benefits', title: 'Benefits of ActMon',     desc: 'The value & ROI: proactive monitoring, faster incident resolution, cost savings, security & compliance.', icon: Sparkles, accent: 'from-emerald-500 to-teal-600', text: 'text-emerald-600', cta: 'See benefits' },
  { id: 'docs',     title: 'Product Documentation',  desc: 'Complete product guide: setup, agents, databases, cloud, logs, RBAC & the onboarding/build workflow.', icon: BookOpen, accent: 'from-amber-500 to-orange-600', text: 'text-amber-600', cta: 'Read docs' },
];

export default function SalesLanding() {
  const navigate = useNavigate();
  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f5f9]">
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 md:px-8 pt-3 pb-6 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
        <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5"><span>ActMon</span><ChevronRight size={11} /><span className="text-white font-semibold">Sales</span></div>
        <div className="relative flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-sky-400/20 border border-sky-400/40 flex items-center justify-center flex-shrink-0"><Briefcase size={18} className="text-sky-200" /></div>
          <div>
            <h1 className="text-lg font-black text-white tracking-tight leading-none">Sales &amp; Onboarding</h1>
            <p className="text-sky-200/70 text-[11px] mt-0.5">Register a client, tailor the product, and generate their installer</p>
          </div>
        </div>
      </div>

      <div className="px-6 xl:px-10 py-6 max-w-[1700px] mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {TILES.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => navigate(`/sales/${t.id}`)}
              className="group text-left bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 overflow-hidden">
              <div className={`h-1.5 bg-gradient-to-r ${t.accent}`} />
              <div className="p-6">
                <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${t.accent} flex items-center justify-center text-white shadow-lg ring-4 ring-white group-hover:scale-105 transition-transform`}><Icon size={26} /></div>
                <h3 className="mt-4 text-[17px] font-black text-slate-800">{t.title}</h3>
                <p className="text-[13px] text-slate-500 mt-1.5 leading-relaxed">{t.desc}</p>
                <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-end">
                  <span className={`text-[13px] font-bold flex items-center gap-1 group-hover:gap-1.5 transition-all ${t.text}`}>{t.cta} <ChevronRight size={14} /></span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
