import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Eye, EyeOff, X, Search, RefreshCw, Check, ChevronLeft, ChevronRight, ChevronDown, KeyRound, ShieldCheck, UserCog, Loader2, LayoutGrid, List } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PERMISSION_BITS, decodePermission } from './mockDb';
import { usePermissions } from '../../../hooks/usePermissions';
import { usersApi, rolesApi, suggestUsername } from '../../../api/admin';

// Accent palette — each record card gets a rotating gradient identity.
const CARD_ACCENTS = [
  { bar: 'from-indigo-500 to-blue-600',   text: 'text-indigo-600',  ring: 'group-hover:border-indigo-300',  soft: 'from-indigo-50 to-blue-50/50' },
  { bar: 'from-rose-500 to-pink-600',     text: 'text-rose-600',    ring: 'group-hover:border-rose-300',    soft: 'from-rose-50 to-pink-50/50' },
  { bar: 'from-emerald-500 to-teal-600',  text: 'text-emerald-600', ring: 'group-hover:border-emerald-300', soft: 'from-emerald-50 to-teal-50/50' },
  { bar: 'from-amber-500 to-orange-600',  text: 'text-amber-600',   ring: 'group-hover:border-amber-300',   soft: 'from-amber-50 to-orange-50/50' },
  { bar: 'from-violet-500 to-purple-600', text: 'text-violet-600',  ring: 'group-hover:border-violet-300',  soft: 'from-violet-50 to-purple-50/50' },
  { bar: 'from-cyan-500 to-sky-600',      text: 'text-cyan-600',    ring: 'group-hover:border-cyan-300',    soft: 'from-cyan-50 to-sky-50/50' },
];
const initialsOf = (s) => {
  const str = String(s ?? '').trim();
  if (!str) return '#';
  const w = str.split(/\s+/);
  return ((w[0][0] || '') + (w[1]?.[0] || (w[0][1] || ''))).toUpperCase();
};

/**
 * Generic Admin CRUD page driven by a config object.
 * config = { title, subtitle, icon, api, idKey, columns[], fields[], searchKeys[] }
 *   columns: { key, label, width?, type?('status'|'permissions'), render?(row) }
 *   fields:  { key, label, type('text'|'textarea'|'number'|'checkbox'|'select'|'date'|'permissions'),
 *              required?, options?[{value,label}], help? }
 */
export default function AdminResourcePage({ config }) {
  const { title, subtitle, icon: Icon, api, idKey, columns, fields, searchKeys = [], readOnly = false, tree } = config;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Org context (set when opened from Administration → Organization → module)
  const orgId = searchParams.get('org');
  const orgName = searchParams.get('orgName');
  // RBAC: gate actions by the user's permission on THIS page (public pages → allowed)
  const { canHere } = usePermissions();
  const allowAdd    = !readOnly && canHere('add');
  const allowEdit   = !readOnly && canHere('edit');
  const allowDelete = !readOnly && canHere('delete');

  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [modal, setModal]     = useState(null);   // { mode:'add'|'edit'|'view', data }
  const [confirm, setConfirm] = useState(null);    // row pending delete
  const [toast, setToast]     = useState(null);
  const [saving, setSaving]   = useState(false);
  const [loginFor, setLoginFor] = useState(null);  // employee → "Create Login" dialog
  const [treeStack, setTreeStack] = useState([]);  // drill path for hierarchical resources (tree mode)
  const [view, setView] = useState('grid');        // 'grid' | 'list'

  // Current parent in the drill (tree mode): root when the stack is empty.
  const currentParent = tree && treeStack.length ? treeStack[treeStack.length - 1] : null;
  const currentParentId = currentParent ? currentParent[idKey] : (tree ? tree.rootValue : null);

  // Back: in tree mode, step UP one level first; only leave the page from the root.
  const goBack = () => {
    if (tree && treeStack.length) { setTreeStack((s) => s.slice(0, -1)); return; }
    navigate(orgId ? `/administration/${orgId}` : '/administration');
  };

  const load = async () => {
    setLoading(true);
    try { setRows(await api.list(orgId)); } finally { setLoading(false); }
  };
  useEffect(() => { load(); setTreeStack([]); /* eslint-disable-next-line */ }, [config, orgId]);

  const flash = (msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 2500); };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q) {   // searching flattens the hierarchy — match across all rows
      const keys = searchKeys.length ? searchKeys : columns.map((c) => c.key);
      return rows.filter((r) => keys.some((k) => String(r[k] ?? '').toLowerCase().includes(q)));
    }
    if (tree) {   // show only the current drill level (children of currentParentId)
      return rows.filter((r) => String(r[tree.parentKey] ?? tree.rootValue) === String(currentParentId));
    }
    return rows;
  }, [rows, search, searchKeys, columns, tree, currentParentId]);

  // How many children a row has (tree mode) → drives the drill button.
  const childCount = (row) =>
    tree ? rows.filter((r) => String(r[tree.parentKey]) === String(row[idKey])).length : 0;

  const openAdd  = () => {
    const blank = blankRow(fields);
    // fields can auto-compute a value from existing rows (e.g. next bitmask)
    fields.forEach((f) => { if (f.autoValue) blank[f.key] = f.autoValue(rows); });
    if (orgId) blank.org_id = Number(orgId);   // create within the selected organization
    if (tree) blank[tree.parentKey] = currentParentId;   // new record joins the current level
    setModal({ mode: 'add', data: blank });
  };
  const openEdit = async (row) => setModal({ mode: 'edit', data: await api.get(row[idKey]) });
  // View: try to fetch the full record, but read-only tables (login history, audit,
  // sessions) may have no GET-by-id endpoint — fall back to the row we already have,
  // so the eye icon always opens the details.
  const openView = async (row) => {
    try { const full = await api.get(row[idKey]); setModal({ mode: 'view', data: full || row }); }
    catch { setModal({ mode: 'view', data: row }); }
  };

  const save = async (form) => {
    setSaving(true);
    try {
      const payload = orgId ? { ...form, org_id: form.org_id || Number(orgId) } : form;
      if (modal.mode === 'add') {
        const res = await api.create(payload);
        flash(res?.row?.employee_code ? `Created — code ${res.row.employee_code}` : 'Record created');
        setModal(null); await load();
        // New employee → offer to create a linked login account (set password / confirm).
        if (config.autoCreateLogin && res?.id) {
          const r = res.row || {};
          setLoginFor({
            employee_id:   res.id,
            employee_name: r.employee_name || payload.employee_name || '',
            email_id:      r.email_id || payload.email_id || '',
            org_id:        payload.org_id || (orgId ? Number(orgId) : undefined),
          });
        }
        return;
      }
      await api.update(form[idKey], payload); flash('Record updated');
      setModal(null); await load();
    } catch (e) { flash(e.message || 'Save failed', false); }
    finally { setSaving(false); }
  };

  const doDelete = async () => {
    try { await api.remove(confirm[idKey]); flash('Record deleted'); setConfirm(null); await load(); }
    catch (e) { flash(e.message || 'Delete failed', false); }
  };

  // Derive card layout roles from the columns config
  const idCol     = columns[0];
  const statusCol = columns.find((c) => c.type === 'status');
  const titleCol  = columns.find((c) => c !== idCol && c.type !== 'status' && c.type !== 'permissions') || columns[1] || idCol;
  const detailCols = columns.filter((c) => c !== idCol && c !== titleCol && c !== statusCol);

  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f5f9]">
      {/* Full-width gradient header (matches Administration) */}
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 md:px-8 pt-3 pb-4 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
        {/* breadcrumb */}
        <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5">
          <button onClick={() => navigate('/administration')} className="hover:text-slate-200 transition-colors">ActMon</button>
          <ChevronRight size={11} />
          <button onClick={() => navigate(orgId ? `/administration/${orgId}` : '/administration')} className="hover:text-slate-200 transition-colors">Administration</button>
          {orgName && (<><ChevronRight size={11} /><button onClick={() => navigate(`/administration/${orgId}`)} className="hover:text-slate-200 transition-colors truncate max-w-[160px]">{orgName}</button></>)}
          <ChevronRight size={11} />
          <span className="text-white font-semibold truncate max-w-[220px]">{title}</span>
        </div>
        {/* header row */}
        <div className="relative flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={goBack}
              className="w-8 h-8 rounded-lg bg-white/10 border border-white/15 flex items-center justify-center text-white hover:bg-white/20 flex-shrink-0"><ChevronLeft size={16} /></button>
            <div className="w-9 h-9 rounded-lg bg-white/10 border border-white/15 flex items-center justify-center text-white flex-shrink-0">
              {Icon && <Icon size={18} />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg font-black text-white tracking-tight leading-none truncate">{title}</h1>
                {orgName && <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-white/10 border border-white/15 text-sky-100">🏢 {orgName}</span>}
              </div>
              {subtitle && <p className="text-sky-200/70 text-[11px] mt-0.5 truncate">{subtitle}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={load} title="Refresh"
              className="h-9 w-9 rounded-lg bg-white/10 border border-white/15 flex items-center justify-center text-white hover:bg-white/20"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
            {allowAdd && (
              <button onClick={openAdd}
                className="h-9 px-4 rounded-lg bg-white text-blue-700 font-bold text-sm flex items-center gap-2 hover:bg-sky-50 shadow-sm transition-all">
                <Plus size={16} /> <span className="hidden sm:inline">Add New</span><span className="sm:hidden">Add</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="px-6 xl:px-10 py-6 max-w-[1700px] mx-auto">
        {/* Search */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3 mb-4 flex items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${title.toLowerCase()}…`}
              className="w-full h-10 pl-9 pr-9 rounded-xl bg-slate-50 border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400" />
            {search && (
              <button onClick={() => setSearch('')} title="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-200 hover:text-slate-600">
                <X size={14} />
              </button>
            )}
          </div>
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 font-bold ml-auto px-3 py-1.5 rounded-full bg-slate-100">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />{filtered.length} record{filtered.length !== 1 ? 's' : ''}
          </span>
          {/* Grid / List toggle */}
          <div className="flex bg-slate-100 rounded-xl p-0.5">
            {[['grid', LayoutGrid], ['list', List]].map(([v, Ico]) => (
              <button key={v} onClick={() => setView(v)} title={`${v[0].toUpperCase()}${v.slice(1)} view`}
                className={`h-8 w-9 rounded-lg flex items-center justify-center transition-all ${view === v ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>
                <Ico size={16} />
              </button>
            ))}
          </div>
        </div>

        {/* Drill breadcrumb (tree mode, hidden while searching) */}
        {tree && !search.trim() && (
          <div className="flex items-center gap-1.5 text-[13px] font-bold mb-4 flex-wrap">
            <button onClick={() => setTreeStack([])}
              className={`px-3 py-1.5 rounded-lg transition-colors ${treeStack.length ? 'text-indigo-600 hover:bg-indigo-50' : 'bg-slate-800 text-white'}`}>
              All {title.toLowerCase()}
            </button>
            {treeStack.map((p, idx) => (
              <React.Fragment key={p[idKey]}>
                <ChevronRight size={14} className="text-slate-300" />
                <button onClick={() => setTreeStack(treeStack.slice(0, idx + 1))}
                  className={`px-3 py-1.5 rounded-lg transition-colors truncate max-w-[220px] ${idx === treeStack.length - 1 ? 'bg-slate-800 text-white' : 'text-indigo-600 hover:bg-indigo-50'}`}>
                  {String(p[titleCol?.key] ?? p[idKey])}
                </button>
              </React.Fragment>
            ))}
          </div>
        )}

        {/* Card grid */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-white rounded-2xl border border-slate-200 p-5 animate-pulse">
                <div className="flex items-center gap-3"><div className="w-12 h-12 rounded-xl bg-slate-200" /><div className="flex-1"><div className="h-4 bg-slate-200 rounded w-2/3" /><div className="h-3 bg-slate-100 rounded w-1/3 mt-2" /></div></div>
                <div className="h-3 bg-slate-100 rounded mt-4" /><div className="h-3 bg-slate-100 rounded mt-2 w-4/5" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm py-16 text-center">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-slate-100 flex items-center justify-center mb-3">{Icon && <Icon className="text-slate-300" size={26} />}</div>
            {search ? (
              <>
                <p className="text-slate-500 font-bold">No matches for "{search}"</p>
                <button onClick={() => setSearch('')} className="text-indigo-600 text-sm font-bold mt-1 hover:underline">Clear search</button>
                <span className="text-slate-400 text-sm"> · {rows.length} total record{rows.length !== 1 ? 's' : ''}</span>
              </>
            ) : (
              <>
                <p className="text-slate-500 font-bold">No records found</p>
                <p className="text-slate-400 text-sm mt-1">Click <b>Add New</b> to create the first one.</p>
              </>
            )}
          </div>
        ) : view === 'list' ? (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100 overflow-hidden">
            {filtered.map((row, i) => {
              const a = CARD_ACCENTS[i % CARD_ACCENTS.length];
              const on = row[statusCol?.key] === true || row[statusCol?.key] === 'true';
              return (
                <div key={row[idKey]} className="flex items-center gap-3.5 px-4 sm:px-5 py-3 hover:bg-slate-50/70 transition-colors">
                  <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${a.bar} flex items-center justify-center text-white font-black text-[13px] shadow ring-2 ring-white flex-shrink-0`}>
                    {initialsOf(row[titleCol?.key])}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[14px] font-extrabold text-slate-800 truncate">{String(row[titleCol?.key] ?? '—')}</h3>
                      {statusCol && (
                        <span className={`flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${on ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-emerald-500' : 'bg-slate-400'}`} />{on ? 'Active' : 'Inactive'}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap mt-1.5">
                      {[
                        { key: '__id', label: idCol.label, value: row[idCol.key] },
                        ...detailCols.slice(0, 6).map((c) => ({ key: c.key, label: c.label, value: renderCell(c, row) })),
                        ...(statusCol ? [{ key: '__status', label: 'Status', value: on ? 'Active' : 'Inactive' }] : []),
                      ].map((f, idx) => (
                        <span key={f.key} className="inline-flex items-center gap-1.5 min-w-0">
                          {idx > 0 && <span className="text-slate-300 select-none mr-1">|</span>}
                          <span className="uppercase text-[10px] font-bold tracking-wide text-slate-500">{f.label}</span>
                          <span className="text-slate-400 font-bold">:</span>
                          <span className="text-[12px] font-semibold text-slate-800 truncate max-w-[220px]">{f.value}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                  {tree && !search.trim() && childCount(row) > 0 && (
                    <button onClick={() => setTreeStack([...treeStack, row])}
                      className="h-8 px-3 rounded-lg text-[12px] font-bold text-indigo-600 hover:bg-indigo-50 flex items-center gap-1 flex-shrink-0">
                      {childCount(row)} {tree.childLabel || 'items'} <ChevronRight size={13} />
                    </button>
                  )}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <ActionBtn title="View" onClick={() => openView(row)} tone="blue"><Eye size={15} /></ActionBtn>
                    {allowEdit && <ActionBtn title="Edit" onClick={() => openEdit(row)} tone="indigo"><Pencil size={15} /></ActionBtn>}
                    {allowDelete && <ActionBtn title="Delete" onClick={() => setConfirm(row)} tone="red"><Trash2 size={15} /></ActionBtn>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {filtered.map((row, i) => {
              const a = CARD_ACCENTS[i % CARD_ACCENTS.length];
              const on = row[statusCol?.key] === true || row[statusCol?.key] === 'true';
              return (
                <div key={row[idKey]}
                  className={`group relative bg-white rounded-2xl border border-slate-200/80 ${a.ring} overflow-hidden shadow-[0_1px_3px_rgba(15,23,42,0.06)] hover:shadow-[0_28px_50px_-20px_rgba(15,23,42,0.32)] hover:-translate-y-1.5 transition-all duration-300`}>
                  <div className={`h-1.5 bg-gradient-to-r ${a.bar}`} />

                  {/* colored header band */}
                  <div className={`relative px-5 pt-5 pb-4 bg-gradient-to-br ${a.soft} overflow-hidden`}>
                    <div className={`pointer-events-none absolute -top-10 -right-10 w-32 h-32 rounded-full bg-gradient-to-br ${a.bar} opacity-[0.08] group-hover:opacity-[0.16] blur-2xl transition-opacity duration-500`} />
                    <div className="relative flex items-start gap-3.5">
                      <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${a.bar} flex items-center justify-center text-white font-black text-lg tracking-tight shadow-lg ring-4 ring-white flex-shrink-0 group-hover:scale-105 group-hover:-rotate-3 transition-transform duration-300`}>
                        {initialsOf(row[titleCol?.key])}
                      </div>
                      <div className="min-w-0 flex-1 pt-0.5">
                        <h3 className="text-[15.5px] font-extrabold text-slate-800 truncate leading-snug tracking-tight">{String(row[titleCol?.key] ?? '—')}</h3>
                        <span className="inline-flex items-center mt-1.5 text-[10.5px] font-bold text-slate-500 font-mono bg-white/70 ring-1 ring-slate-200/70 px-2 py-0.5 rounded-md">{idCol.label} #{row[idCol.key]}</span>
                      </div>
                      {statusCol && (
                        <span className={`flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wide shadow-sm ${on ? 'bg-emerald-500 text-white' : 'bg-white text-slate-500 ring-1 ring-slate-200'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-white animate-pulse' : 'bg-slate-400'}`} />{on ? 'Active' : 'Inactive'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* detail rows */}
                  {detailCols.length > 0 && (
                    <div className="px-5 py-4 space-y-3">
                      {detailCols.map((c) => (
                        <div key={c.key} className="flex items-center justify-between gap-3">
                          <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5 flex-shrink-0">
                            <span className={`w-1.5 h-1.5 rounded-full bg-gradient-to-br ${a.bar}`} />{c.label}
                          </span>
                          <span className="text-[13px] font-bold text-slate-800 text-right truncate max-w-[62%]">{renderCell(c, row)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* footer actions */}
                  <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-end gap-2">
                    {tree && !search.trim() && childCount(row) > 0 && (
                      <button onClick={() => setTreeStack([...treeStack, row])}
                        className="mr-auto h-9 px-3 rounded-xl text-[12px] font-bold text-indigo-600 hover:bg-indigo-50 flex items-center gap-1.5 transition-colors">
                        {childCount(row)} {tree.childLabel || 'items'} <ChevronRight size={14} />
                      </button>
                    )}
                    <ActionBtn title="View" onClick={() => openView(row)} tone="blue"><Eye size={15} /></ActionBtn>
                    {allowEdit && <ActionBtn title="Edit" onClick={() => openEdit(row)} tone="indigo"><Pencil size={15} /></ActionBtn>}
                    {allowDelete && <ActionBtn title="Delete" onClick={() => setConfirm(row)} tone="red"><Trash2 size={15} /></ActionBtn>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {modal && (
        <FormModal config={config} mode={modal.mode} initial={modal.data} orgId={orgId}
          saving={saving} onClose={() => setModal(null)} onSave={save} />
      )}
      {confirm && (
        <ConfirmModal name={title} row={confirm} idKey={idKey}
          onCancel={() => setConfirm(null)} onConfirm={doDelete} />
      )}
      {loginFor && (
        <CreateLoginModal employee={loginFor} orgId={orgId}
          onSkip={() => { setLoginFor(null); flash('Employee created (no login added)'); }}
          onDone={(msg) => { setLoginFor(null); flash(msg); }} />
      )}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl shadow-xl text-sm font-bold text-white flex items-center gap-2 ${toast.ok ? 'bg-emerald-600' : 'bg-red-600'}`}>
          <Check size={16} /> {toast.msg}
        </div>
      )}
    </div>
  );
}

function IconBtn({ children, title, onClick, cls }) {
  return (
    <button title={title} onClick={onClick}
      className={`w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 transition-all ${cls}`}>
      {children}
    </button>
  );
}

const ACTION_TONES = {
  blue:   'hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600',
  indigo: 'hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600',
  red:    'hover:border-red-300 hover:bg-red-50 hover:text-red-600',
};
function ActionBtn({ children, title, onClick, tone = 'blue' }) {
  return (
    <button title={title} onClick={onClick}
      className={`w-9 h-9 rounded-xl border border-slate-200 bg-white text-slate-500 flex items-center justify-center shadow-sm transition-all hover:shadow hover:-translate-y-0.5 active:scale-95 ${ACTION_TONES[tone]}`}>
      {children}
    </button>
  );
}

function renderCell(col, row) {
  if (col.render) return col.render(row);
  const v = row[col.key];
  if (col.type === 'status') {
    const on = v === true || v === 'true';
    return (
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold ${on ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-emerald-500' : 'bg-slate-400'}`} />{on ? 'Active' : 'Inactive'}
      </span>
    );
  }
  if (col.type === 'permissions') {
    const list = decodePermission(v);
    return <span className="font-mono text-[11px] text-slate-600">{list.length ? list.join(', ') : '—'} <span className="text-slate-400">({v})</span></span>;
  }
  if (v === null || v === undefined || v === '') return <span className="text-slate-300">—</span>;
  return String(v);
}

function blankRow(fields) {
  const r = {};
  fields.forEach((f) => { r[f.key] = f.type === 'checkbox' ? true : f.type === 'permissions' ? 0 : ''; });
  return r;
}

function FormModal({ config, mode, initial, saving, onClose, onSave, orgId }) {
  const { title, fields, idKey, icon: Icon, columns = [] } = config;
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [dynOpts, setDynOpts] = useState({});   // fieldKey → [{value,label}] (async FK dropdowns)
  const readOnly = mode === 'view';
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // identity columns (for the read-only detail header)
  const vIdCol    = columns.find((c) => c.key === idKey) || columns[0];
  const vStatusCol = columns.find((c) => c.type === 'status');
  const vTitleCol = columns.find((c) => c !== vIdCol && c.type !== 'status' && c.type !== 'permissions') || columns[1] || vIdCol;
  const vAccent   = CARD_ACCENTS[(Number(form?.[idKey]) || 0) % CARD_ACCENTS.length];

  // load async dropdown options (loadOptions) when the form opens — scoped to the org
  useEffect(() => {
    let alive = true;
    fields.filter((f) => typeof f.loadOptions === 'function').forEach((f) => {
      Promise.resolve(f.loadOptions(orgId)).then((opts) => {
        if (alive) setDynOpts((o) => ({ ...o, [f.key]: opts || [] }));
      }).catch(() => {});
    });
    return () => { alive = false; };
  }, [fields, orgId]);
  const singular = title.replace(/s$/, '');
  const heading = mode === 'add' ? `Add ${singular}` : mode === 'edit' ? `Edit ${singular}` : `${singular} Details`;
  const sub = mode === 'add' ? 'Create a new record' : mode === 'edit' ? 'Update the record below' : 'Read-only view';

  const submit = () => {
    const e = {};
    fields.forEach((f) => { if (f.required && (form[f.key] === '' || form[f.key] == null)) e[f.key] = 'Required'; });
    setErrors(e);
    if (Object.keys(e).length === 0) onSave(form);
  };

  // read-only display value for a field (resolves selects, decodes permissions, formats booleans)
  const viewValue = (f) => {
    const v = form?.[f.key];
    if (f.type === 'checkbox') {
      const on = v === true || v === 'true';
      return (
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-bold ${on ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100' : 'bg-slate-100 text-slate-500 ring-1 ring-slate-200'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-emerald-500' : 'bg-slate-400'}`} />{on ? 'Active' : 'Inactive'}
        </span>
      );
    }
    if (f.type === 'permissions') {
      const list = decodePermission(Number(v) || 0);
      return list.length
        ? <span className="flex flex-wrap gap-1.5">{list.map((p) => <span key={p} className="px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 text-[11px] font-bold ring-1 ring-indigo-100">{p}</span>)}</span>
        : <span className="text-slate-400">— none —</span>;
    }
    if (f.type === 'select') {
      const opts = f.options || dynOpts[f.key] || [];
      const sel = opts.find((o) => String(o.value) === String(v));
      return sel ? sel.label : (v || v === 0 ? String(v) : <span className="text-slate-400">—</span>);
    }
    if (f.type === 'json') {
      return <pre className="w-full max-h-56 overflow-auto rounded-xl border border-slate-200 bg-slate-900 text-slate-100 text-[11px] p-3 font-mono whitespace-pre-wrap">{v ? JSON.stringify(v, null, 2) : '—'}</pre>;
    }
    if (v === null || v === undefined || v === '') return <span className="text-slate-400">—</span>;
    return String(v);
  };

  // fields shown in the detail body (title & status appear in the identity banner instead)
  const viewFields = fields.filter((f) => f.key !== vTitleCol?.key && f.key !== vStatusCol?.key);
  const statusOn = form?.[vStatusCol?.key] === true || form?.[vStatusCol?.key] === 'true';

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex sm:items-center sm:justify-center sm:p-6" onClick={onClose}>
      <div className="bg-white w-full h-full sm:h-auto sm:max-h-[90vh] sm:max-w-3xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden sm:animate-[fadeIn_.18s_ease-out]" onClick={(e) => e.stopPropagation()}>
        {/* gradient header */}
        <div className="flex items-center justify-between px-6 sm:px-8 py-5 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 text-white">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-white/10 border border-white/15 flex items-center justify-center text-indigo-200">
              {Icon && <Icon size={24} />}
            </div>
            <div>
              <h2 className="text-lg sm:text-xl font-black leading-none">{heading}</h2>
              <p className="text-xs text-white/60 mt-1.5">{sub}</p>
            </div>
          </div>
          <button onClick={onClose} className="w-10 h-10 rounded-xl flex items-center justify-center text-white/70 hover:bg-white/15"><X size={20} /></button>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto bg-slate-50/60">
          <div className="max-w-3xl mx-auto px-6 sm:px-8 py-7 space-y-5">
            {readOnly ? (
              <>
                {/* identity banner */}
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 sm:p-6 flex items-center gap-5">
                  <div className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${vAccent.bar} flex items-center justify-center text-white font-black text-2xl shadow-lg ring-4 ring-white flex-shrink-0`}>
                    {initialsOf(form?.[vTitleCol?.key])}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-xl sm:text-2xl font-black text-slate-900 truncate leading-tight">{String(form?.[vTitleCol?.key] ?? '—')}</h3>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      {vIdCol && <span className="text-[11px] font-bold font-mono text-slate-500 bg-slate-100 px-2 py-1 rounded-md">{vIdCol.label} #{form?.[vIdCol.key]}</span>}
                      {vStatusCol && (
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold ${statusOn ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100' : 'bg-slate-100 text-slate-500 ring-1 ring-slate-200'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${statusOn ? 'bg-emerald-500' : 'bg-slate-400'}`} />{statusOn ? 'Active' : 'Inactive'}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {/* details */}
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
                    <span className="w-1 h-5 rounded-full bg-gradient-to-b from-indigo-500 to-violet-500" />
                    <h3 className="text-sm font-black text-slate-700 uppercase tracking-wider">{singular} Information</h3>
                  </div>
                  <dl className="divide-y divide-slate-100">
                    {viewFields.map((f) => (
                      <div key={f.key} className="px-6 py-4 grid grid-cols-1 sm:grid-cols-3 gap-1 sm:gap-4">
                        <dt className="text-[11px] font-black text-slate-500 uppercase tracking-wider sm:pt-0.5">{f.label}</dt>
                        <dd className="sm:col-span-2 text-sm text-slate-800 font-semibold break-words min-w-0">{viewValue(f)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </>
            ) : (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8">
                <div className="flex items-center gap-2 mb-6">
                  <span className="w-1 h-5 rounded-full bg-gradient-to-b from-indigo-500 to-violet-500" />
                  <h3 className="text-sm font-black text-slate-700 uppercase tracking-wider">{singular} Information</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
                  {fields.map((f) => (
                    <Field key={f.key} f={f} value={form[f.key]} onChange={(v) => set(f.key, v)} error={errors[f.key]} readOnly={readOnly} options={f.options || dynOpts[f.key]} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* sticky footer */}
        <div className="px-6 sm:px-8 py-4 border-t border-slate-200 flex items-center justify-end gap-3 bg-white">
          <button onClick={onClose} className="h-11 px-6 rounded-xl bg-slate-100 text-slate-600 font-bold text-sm hover:bg-slate-200 transition-colors">
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {!readOnly && (
            <button onClick={submit} disabled={saving}
              className="h-11 px-8 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-bold text-sm shadow-lg shadow-indigo-200 disabled:opacity-60 transition-all">
              {saving ? 'Saving…' : mode === 'add' ? 'Create Record' : 'Update Record'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ f, value, onChange, error, readOnly, options }) {
  const ro = readOnly || f.readOnly;     // per-field lock (e.g. auto bitmask) OR whole-form view mode
  const full = f.type === 'textarea' || f.type === 'permissions';
  const has = value !== '' && value !== null && value !== undefined;
  const opts = options || f.options || [];
  const base = `w-full h-11 px-3.5 rounded-xl border text-sm transition-all focus:outline-none focus:ring-4 focus:ring-indigo-100 focus:border-indigo-400 ${error ? 'border-red-300 ring-2 ring-red-100' : 'border-slate-200'} ${ro ? 'bg-slate-100 text-slate-500 cursor-not-allowed' : 'bg-white hover:border-slate-300'}`;
  const selected = opts.find((o) => String(o.value) === String(value));
  return (
    <div className={full ? 'md:col-span-2' : ''}>
      <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-2">
        {f.label}{f.required && <span className="text-red-500"> *</span>}
        {f.readOnly && <span className="ml-2 text-[10px] font-bold text-indigo-500 normal-case tracking-normal">🔒 auto</span>}
      </label>
      {f.type === 'textarea' ? (
        <textarea value={value ?? ''} disabled={ro} onChange={(e) => onChange(e.target.value)} rows={3}
          placeholder={`Enter ${f.label.toLowerCase()}…`}
          className={base.replace('h-11', 'min-h-[88px] py-2.5')} />
      ) : f.type === 'checkbox' ? (
        // fancy pill toggle
        <button type="button" disabled={ro} onClick={() => onChange(!value)}
          className={`w-full h-11 px-3.5 rounded-xl border flex items-center justify-between text-sm font-bold transition-all ${value ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-slate-50 border-slate-200 text-slate-500'} ${readOnly ? 'cursor-not-allowed opacity-80' : 'hover:border-slate-300'}`}>
          <span>{value ? 'Active' : 'Inactive'}</span>
          <span className={`relative w-11 h-6 rounded-full transition-colors ${value ? 'bg-emerald-500' : 'bg-slate-300'}`}>
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-5' : ''}`} />
          </span>
        </button>
      ) : f.type === 'select' ? (
        <div className="relative">
          <select value={value ?? ''} disabled={ro}
            onChange={(e) => onChange(e.target.value === '' ? '' : (isNaN(+e.target.value) ? e.target.value : +e.target.value))}
            className={`${base} appearance-none pr-10 font-semibold ${has ? 'text-slate-800' : 'text-slate-400'}`}>
            <option value="">— Select {f.label} —</option>
            {opts.map((o) => <option key={o.value} value={o.value} className="text-slate-800">{o.label}</option>)}
          </select>
          <ChevronDown size={16} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          {has && selected && (
            <span className="absolute right-9 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-indigo-500" title="Selected" />
          )}
        </div>
      ) : f.type === 'permissions' ? (
        <div>
          <div className="flex flex-wrap gap-2">
            {PERMISSION_BITS.map((p) => {
              const on = (Number(value) & p.value) === p.value;
              return (
                <button type="button" key={p.value} disabled={ro}
                  onClick={() => onChange(on ? Number(value) & ~p.value : Number(value) | p.value)}
                  className={`px-3.5 h-10 rounded-xl text-xs font-bold border transition-all flex items-center gap-1.5 ${on ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white border-transparent shadow' : 'bg-white text-slate-500 border-slate-200 hover:border-indigo-300'}`}>
                  {on && <Check size={12} />}{p.name}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-400 mt-2.5">Bitmask value: <b className="text-slate-600">{Number(value) || 0}</b></p>
        </div>
      ) : f.type === 'json' ? (
        <pre className="w-full max-h-56 overflow-auto rounded-xl border border-slate-200 bg-slate-900 text-slate-100 text-[11px] p-3 font-mono whitespace-pre-wrap">
          {value ? JSON.stringify(value, null, 2) : '—'}
        </pre>
      ) : (
        <input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
          value={value ?? ''} disabled={ro}
          placeholder={f.type === 'date' ? undefined : `Enter ${f.label.toLowerCase()}…`}
          onChange={(e) => onChange(f.type === 'number' ? (e.target.value === '' ? '' : +e.target.value) : e.target.value)}
          className={base} />
      )}
      {error && <p className="text-[11px] font-semibold text-red-500 mt-1.5">{error}</p>}
      {!error && f.help && <p className="text-[11px] text-slate-400 mt-1.5">{f.help}</p>}
    </div>
  );
}

function ConfirmModal({ name, row, idKey, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={onCancel}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center" onClick={(e) => e.stopPropagation()}>
        <div className="w-14 h-14 mx-auto rounded-2xl bg-red-50 flex items-center justify-center mb-4">
          <Trash2 className="text-red-500" size={26} />
        </div>
        <h3 className="font-black text-slate-800 text-lg">Delete {name.replace(/s$/, '')}?</h3>
        <p className="text-sm text-slate-500 mt-1.5">This will remove record <b className="text-slate-700">#{row[idKey]}</b>. This action cannot be undone.</p>
        <div className="flex gap-2 mt-6">
          <button onClick={onCancel} className="flex-1 h-10 rounded-xl bg-slate-100 text-slate-600 font-bold text-sm hover:bg-slate-200">Cancel</button>
          <button onClick={onConfirm} className="flex-1 h-10 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-sm">Delete</button>
        </div>
      </div>
    </div>
  );
}

/* ── Create-Login dialog: shown right after an employee is created ── */
function CreateLoginModal({ employee, orgId, onSkip, onDone }) {
  const [username, setUsername] = useState('');
  const [roleId, setRoleId]     = useState('');
  const [roles, setRoles]       = useState([]);
  const [pwd, setPwd]           = useState('');
  const [confirm, setConfirm]   = useState('');
  const [showPwd, setShowPwd]   = useState(false);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      // Suggest a unique username from the employee's name, and load assignable roles.
      const [u, rs] = await Promise.all([
        suggestUsername(employee.employee_name || ''),
        rolesApi.list(orgId).catch(() => []),
      ]);
      if (!alive) return;
      setUsername(u);
      setRoles((rs || []).map((r) => ({ value: r.role_id, label: r.role_name })));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [employee, orgId]);

  const submit = async () => {
    setErr('');
    if (!username.trim())      return setErr('Username is required.');
    if (!roleId)               return setErr('Please choose a role.');
    if (!pwd)                  return setErr('Please set a password.');
    if (pwd.length < 6)        return setErr('Password must be at least 6 characters.');
    if (pwd !== confirm)       return setErr('Passwords do not match.');
    setSaving(true);
    try {
      await usersApi.create({
        user_name: username.trim(),
        password_hash: pwd,
        role_id: Number(roleId),
        employee_id: employee.employee_id,
        is_active: true,
        account_locked: false,
        ...(employee.org_id ? { org_id: employee.org_id } : {}),
      });
      onDone(`Login "${username.trim()}" created for ${employee.employee_name}`);
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || 'Could not create login');
      setSaving(false);
    }
  };

  const match = pwd && confirm && pwd === confirm;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={onSkip}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="bg-gradient-to-r from-indigo-600 to-violet-600 px-6 py-5 text-white flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-white/15 flex items-center justify-center"><UserCog size={22} /></div>
          <div>
            <h3 className="font-black text-lg leading-tight">Create login account</h3>
            <p className="text-indigo-100 text-xs mt-0.5">For <b>{employee.employee_name}</b>{employee.email_id ? ` · ${employee.email_id}` : ''}</p>
          </div>
        </div>

        {loading ? (
          <div className="py-16 flex justify-center"><Loader2 className="animate-spin text-indigo-500" size={26} /></div>
        ) : (
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-2">Username <span className="text-red-500">*</span></label>
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus
                className="w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-4 focus:ring-indigo-100 focus:border-indigo-400 bg-white" />
              <p className="text-[11px] text-slate-400 mt-1.5">Suggested from the employee's name — edit if you prefer.</p>
            </div>

            <div>
              <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-2">Role <span className="text-red-500">*</span></label>
              <div className="relative">
                <select value={roleId} onChange={(e) => setRoleId(e.target.value)}
                  className={`w-full h-11 px-3.5 pr-10 rounded-xl border border-slate-200 text-sm appearance-none font-semibold focus:outline-none focus:ring-4 focus:ring-indigo-100 focus:border-indigo-400 bg-white ${roleId ? 'text-slate-800' : 'text-slate-400'}`}>
                  <option value="">— Select role —</option>
                  {roles.map((o) => <option key={o.value} value={o.value} className="text-slate-800">{o.label}</option>)}
                </select>
                <ChevronDown size={16} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-2">Password <span className="text-red-500">*</span></label>
                <div className="relative">
                  <input type={showPwd ? 'text' : 'password'} value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="Set a password…"
                    className="w-full h-11 px-3.5 pr-10 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-4 focus:ring-indigo-100 focus:border-indigo-400 bg-white" />
                  <button type="button" onClick={() => setShowPwd((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                    {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-black text-slate-500 uppercase tracking-wider mb-2">Confirm Password <span className="text-red-500">*</span></label>
                <div className="relative">
                  <input type={showPwd ? 'text' : 'password'} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter password…"
                    className={`w-full h-11 px-3.5 pr-10 rounded-xl border text-sm focus:outline-none focus:ring-4 bg-white ${confirm ? (match ? 'border-emerald-300 focus:ring-emerald-100 focus:border-emerald-400' : 'border-red-300 focus:ring-red-100 focus:border-red-400') : 'border-slate-200 focus:ring-indigo-100 focus:border-indigo-400'}`} />
                  {confirm && match && <ShieldCheck size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-500" />}
                </div>
                {confirm && !match && <p className="text-[11px] font-semibold text-red-500 mt-1.5">Passwords do not match.</p>}
              </div>
            </div>

            {err && <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-[12px] font-semibold text-red-600">{err}</div>}

            <div className="flex gap-2 pt-1">
              <button onClick={onSkip} disabled={saving}
                className="h-11 px-4 rounded-xl bg-slate-100 text-slate-600 font-bold text-sm hover:bg-slate-200 disabled:opacity-60">Skip</button>
              <button onClick={submit} disabled={saving}
                className="flex-1 h-11 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-bold text-sm shadow hover:shadow-lg disabled:opacity-60 inline-flex items-center justify-center gap-2">
                {saving ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />} Create Login
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
