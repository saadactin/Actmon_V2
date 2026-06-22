import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, KeyRound, Boxes, FileText, Lock, UserCog, Users, ChevronRight } from 'lucide-react';

const CARDS = [
  { to: '/roles',            icon: Shield,   title: 'Roles',            desc: 'Define access roles',                    color: 'from-indigo-500 to-indigo-600' },
  { to: '/permissions',      icon: KeyRound, title: 'Permissions',      desc: 'Permission types & bitmask values',       color: 'from-violet-500 to-violet-600' },
  { to: '/modules',          icon: Boxes,    title: 'Modules',          desc: 'Top-level application modules',           color: 'from-blue-500 to-blue-600' },
  { to: '/pages',            icon: FileText, title: 'Pages',            desc: 'Pages & menu hierarchy',                  color: 'from-cyan-500 to-cyan-600' },
  { to: '/role-permissions', icon: Lock,     title: 'Role Page Permissions', desc: 'Grant permissions per role & page',  color: 'from-rose-500 to-rose-600' },
  { to: '/users',            icon: UserCog,  title: 'User Master',      desc: 'Application user accounts',               color: 'from-emerald-500 to-emerald-600' },
  { to: '/employees',        icon: Users,    title: 'Employees',        desc: 'Organization employee records',           color: 'from-amber-500 to-amber-600' },
];

export default function AdministrationPage() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-[#f1f5f9] p-6">
      <div className="max-w-[1400px] mx-auto">
        {/* Hero */}
        <div className="rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 px-7 py-7 mb-7 relative overflow-hidden">
          <div className="absolute inset-0 opacity-[0.04]"
            style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
          <div className="relative flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center">
              <Shield size={24} className="text-indigo-300" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-white tracking-tight leading-none">Administration</h1>
              <p className="text-slate-400 text-sm mt-1">Manage roles, permissions, pages, users & employees</p>
            </div>
          </div>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {CARDS.map((c) => {
            const Icon = c.icon;
            return (
              <button key={c.to} onClick={() => navigate(c.to)}
                className="group relative bg-white rounded-3xl border border-slate-200 overflow-hidden text-left shadow-sm hover:shadow-2xl hover:-translate-y-1.5 transition-all duration-300">
                {/* top accent bar */}
                <div className={`h-1.5 bg-gradient-to-r ${c.color}`} />
                {/* hover glow */}
                <div className={`pointer-events-none absolute -top-12 -right-12 w-40 h-40 rounded-full bg-gradient-to-br ${c.color} opacity-0 group-hover:opacity-10 blur-3xl transition-opacity duration-500`} />
                <div className="p-6">
                  <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${c.color} flex items-center justify-center text-white shadow-lg group-hover:scale-110 transition-transform`}>
                    <Icon size={24} />
                  </div>
                  <h3 className="font-black text-slate-800 text-lg mt-4">{c.title}</h3>
                  <p className="text-sm text-slate-500 mt-1">{c.desc}</p>
                  <div className="mt-5 flex items-center gap-1.5 text-sm font-extrabold text-slate-700 group-hover:gap-2.5 transition-all">
                    Open <ChevronRight size={16} className="group-hover:translate-x-0.5 transition-transform" />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
