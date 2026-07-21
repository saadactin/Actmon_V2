import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, ArrowLeft } from 'lucide-react';

// Standard page header band — the single source of truth for page headers so every
// page (Settings, Administration, the DB sub-pages, ChatBot …) looks identical and
// aligns flush under the top bar and against the sidebar.
//
// It breaks out of the AppShell <main> horizontal padding with `-mx-6 md:-mx-8`, then
// re-adds `px-6 md:px-8` internally, so the coloured band spans edge-to-edge while its
// content lines up with the page body below it. Drop it in at the top of a page and
// render the body afterwards (the body sits in the normal content padding).
//
// Props:
//   icon      lucide icon component (e.g. Database)
//   title     page title
//   subtitle  small line under the title
//   crumbs    [{label, to?}] breadcrumb trail; the "ActMon" root is prepended for you
//   backTo    optional route for a back-arrow button on the left
//   actions   optional node rendered on the right (buttons / search)
//   accent    'blue' (default) | 'oracle' | 'mysql' | 'postgres' | 'mssql' — band colour
export default function PageHeader({
  icon: Icon,
  title,
  subtitle,
  crumbs = [],
  backTo,
  actions,
  accent = 'blue',
}) {
  const grad = {
    blue: 'from-slate-900 via-blue-800 to-sky-700',
    oracle: 'from-slate-900 via-red-900 to-orange-800',
    mysql: 'from-slate-900 via-sky-900 to-cyan-700',
    postgres: 'from-slate-900 via-indigo-900 to-blue-700',
    mssql: 'from-slate-900 via-red-800 to-rose-700',
  }[accent] || 'from-slate-900 via-blue-800 to-sky-700';

  return (
    <div className={`-mx-6 md:-mx-8 bg-gradient-to-r ${grad} px-6 md:px-8 pt-3 pb-4 relative overflow-hidden`}>
      <div className="absolute inset-0 opacity-[0.04]"
        style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />

      {/* Breadcrumb — always starts at ActMon */}
      <div className="relative flex items-center gap-2 text-xs text-white/60 mb-2.5 flex-wrap">
        <span>ActMon</span>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <React.Fragment key={`${c.label}-${i}`}>
              <ChevronRight size={11} className="opacity-70" />
              {c.to && !last
                ? <Link to={c.to} className="hover:text-white/90 transition-colors">{c.label}</Link>
                : <span className={last ? 'text-white font-semibold' : ''}>{c.label}</span>}
            </React.Fragment>
          );
        })}
      </div>

      {/* Title row */}
      <div className="relative flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          {backTo && (
            <Link to={backTo}
              className="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 flex items-center justify-center flex-shrink-0"
              title="Back">
              <ArrowLeft size={16} className="text-white" />
            </Link>
          )}
          {Icon && (
            <div className="w-9 h-9 rounded-lg bg-white/15 border border-white/25 flex items-center justify-center flex-shrink-0">
              <Icon size={18} className="text-white" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-lg font-black text-white tracking-tight leading-none truncate">{title}</h1>
            {subtitle && <p className="text-white/70 text-[11px] mt-0.5 truncate">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="relative flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
