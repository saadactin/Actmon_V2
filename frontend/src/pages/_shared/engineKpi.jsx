import { ChevronRight } from 'lucide-react';

/**
 * One KPI tile shape, shared by every engine dashboard's Overview strip
 * (Postgres's Uptime/Version/Databases/…, MySQL's, MSSQL's, etc.) — a
 * circular colour-tinted icon badge, the label beside it, the big number
 * below, then the existing "open X" hint link. Centralised so every engine
 * renders the identical card instead of each hand-rolling its own markup;
 * only the icon/title/value/accent/hint per tile differ, all real data the
 * caller already computes.
 */
export default function KpiTile({ icon: Icon, title, value, accent, hint, sub, onClick }) {
  return (
    <button type="button" onClick={onClick} title={hint ? `Open ${hint}` : undefined}
      className="group card p-card text-left transition-all hover:shadow-md hover:-translate-y-0.5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full"
          style={{ background: `color-mix(in srgb, ${accent} 16%, transparent)` }}>
          <Icon size={18} style={{ color: accent }} />
        </span>
        <p className="truncate text-[11px] font-bold uppercase tracking-wide text-slate-400">{title}</p>
      </div>
      <p className="mt-3 truncate text-[22px] font-black text-slate-800">{value ?? 'N/A'}</p>
      {sub && <p className="mt-1 truncate text-[10.5px] text-slate-400">{sub}</p>}
      {hint && (
        <p className="mt-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-slate-300 transition-colors group-hover:text-indigo-500">
          {hint} <ChevronRight size={11} />
        </p>
      )}
    </button>
  );
}
