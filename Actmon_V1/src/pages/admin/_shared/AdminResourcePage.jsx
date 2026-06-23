import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Eye, X, Search, RefreshCw, Check, ChevronLeft, ChevronDown } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PERMISSION_BITS, decodePermission } from './mockDb';
import { usePermissions } from '../../../hooks/usePermissions';

// Accent palette — each record card gets a rotating gradient identity.
const CARD_ACCENTS = [
  { bar: 'from-indigo-500 to-blue-600',   text: 'text-indigo-600',  ring: 'group-hover:border-indigo-300' },
  { bar: 'from-rose-500 to-pink-600',     text: 'text-rose-600',    ring: 'group-hover:border-rose-300' },
  { bar: 'from-emerald-500 to-teal-600',  text: 'text-emerald-600', ring: 'group-hover:border-emerald-300' },
  { bar: 'from-amber-500 to-orange-600',  text: 'text-amber-600',   ring: 'group-hover:border-amber-300' },
  { bar: 'from-violet-500 to-purple-600', text: 'text-violet-600',  ring: 'group-hover:border-violet-300' },
  { bar: 'from-cyan-500 to-sky-600',      text: 'text-cyan-600',    ring: 'group-hover:border-cyan-300' },
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
  const { title, subtitle, icon: Icon, api, idKey, columns, fields, searchKeys = [], readOnly = false } = config;
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

  const load = async () => {
    setLoading(true);
    try { setRows(await api.list(orgId)); } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [config, orgId]);

  const flash = (msg, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 2500); };

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    const keys = searchKeys.length ? searchKeys : columns.map((c) => c.key);
    return rows.filter((r) => keys.some((k) => String(r[k] ?? '').toLowerCase().includes(q)));
  }, [rows, search, searchKeys, columns]);

  const openAdd  = () => {
    const blank = blankRow(fields);
    // fields can auto-compute a value from existing rows (e.g. next bitmask)
    fields.forEach((f) => { if (f.autoValue) blank[f.key] = f.autoValue(rows); });
    if (orgId) blank.org_id = Number(orgId);   // create within the selected organization
    setModal({ mode: 'add', data: blank });
  };
  const openEdit = async (row) => setModal({ mode: 'edit', data: await api.get(row[idKey]) });
  const openView = async (row) => setModal({ mode: 'view', data: await api.get(row[idKey]) });

  const save = async (form) => {
    setSaving(true);
    try {
      const payload = orgId ? { ...form, org_id: form.org_id || Number(orgId) } : form;
      if (modal.mode === 'add') { await api.create(payload); flash('Record created'); }
      else { await api.update(form[idKey], payload); flash('Record updated'); }
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
    <div className="min-h-screen bg-[#f1f5f9] p-4 sm:p-6">
      <div className="max-w-[1500px] mx-auto">
        {/* Gradient hero header */}
        <div className="rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 px-5 sm:px-7 py-6 mb-6 relative overflow-hidden">
          <div className="absolute inset-0 opacity-[0.04]"
            style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />
          <div className="relative flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <button onClick={() => navigate(orgId ? `/administration/${orgId}` : '/administration')}
                className="w-9 h-9 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center text-white hover:bg-white/20 transition-all flex-shrink-0">
                <ChevronLeft size={18} />
              </button>
              <div className="w-11 h-11 rounded-xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-indigo-300 flex-shrink-0">
                {Icon && <Icon size={22} />}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-lg sm:text-2xl font-black text-white tracking-tight leading-none truncate">{title}</h1>
                  {orgName && <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-white/10 border border-white/15 text-indigo-200">🏢 {orgName}</span>}
                </div>
                {subtitle && <p className="text-slate-400 text-xs mt-1 truncate">{subtitle}</p>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={load} title="Refresh"
                className="h-10 w-10 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center text-white hover:bg-white/20 transition-all">
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              </button>
              {allowAdd && (
                <button onClick={openAdd}
                  className="h-10 px-4 sm:px-5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm flex items-center gap-2 shadow-lg transition-all">
                  <Plus size={16} /> <span className="hidden sm:inline">Add New</span><span className="sm:hidden">Add</span>
                </button>
              )}
            </div>
          </div>
        </div>

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
        </div>

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
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {filtered.map((row, i) => {
              const a = CARD_ACCENTS[i % CARD_ACCENTS.length];
              const on = row[statusCol?.key] === true || row[statusCol?.key] === 'true';
              return (
                <div key={row[idKey]}
                  className={`group relative bg-white rounded-2xl border border-slate-200/80 ${a.ring} overflow-hidden shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:shadow-[0_24px_48px_-18px_rgba(15,23,42,0.28)] hover:-translate-y-1.5 transition-all duration-300`}>
                  <div className={`h-1 bg-gradient-to-r ${a.bar}`} />
                  <div className={`pointer-events-none absolute -top-12 -right-12 w-36 h-36 rounded-full bg-gradient-to-br ${a.bar} opacity-0 group-hover:opacity-[0.10] blur-3xl transition-opacity duration-500`} />

                  <div className="p-5">
                    {/* header */}
                    <div className="flex items-start gap-3.5">
                      <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${a.bar} flex items-center justify-center text-white font-black text-[15px] tracking-tight shadow-lg ring-4 ring-white flex-shrink-0 group-hover:scale-110 group-hover:-rotate-3 transition-transform duration-300`}>
                        {initialsOf(row[titleCol?.key])}
                      </div>
                      <div className="min-w-0 flex-1 pt-0.5">
                        <h3 className="text-[15px] font-extrabold text-slate-800 truncate leading-snug tracking-tight">{String(row[titleCol?.key] ?? '—')}</h3>
                        <span className="inline-block mt-1 text-[10px] font-bold text-slate-400 font-mono bg-slate-100 px-1.5 py-0.5 rounded-md">{idCol.label} #{row[idCol.key]}</span>
                      </div>
                      {statusCol && (
                        <span className={`flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wide ${on ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100' : 'bg-slate-100 text-slate-500 ring-1 ring-slate-200'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />{on ? 'Active' : 'Inactive'}
                        </span>
                      )}
                    </div>

                    {/* detail rows */}
                    {detailCols.length > 0 && (
                      <div className="mt-4 rounded-xl bg-slate-50/70 ring-1 ring-slate-100 divide-y divide-slate-100/80">
                        {detailCols.map((c) => (
                          <div key={c.key} className="flex items-center justify-between gap-3 px-3 py-2">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex-shrink-0">{c.label}</span>
                            <span className="text-[12.5px] font-semibold text-slate-700 text-right truncate max-w-[62%]">{renderCell(c, row)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* footer actions */}
                  <div className="px-4 py-3 border-t border-slate-100 bg-gradient-to-b from-white to-slate-50/60 flex items-center justify-end gap-2">
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
      className={`w-9 h-9 rounded-xl border border-slate-200 bg-white text-slate-400 flex items-center justify-center shadow-sm transition-all hover:shadow active:scale-95 ${ACTION_TONES[tone]}`}>
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
  const { title, fields, idKey, icon: Icon } = config;
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [dynOpts, setDynOpts] = useState({});   // fieldKey → [{value,label}] (async FK dropdowns)
  const readOnly = mode === 'view';
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

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

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex sm:items-center sm:justify-center sm:p-6" onClick={onClose}>
      <div className="bg-white w-full h-full sm:h-[94vh] sm:max-w-5xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden sm:animate-[fadeIn_.18s_ease-out]" onClick={(e) => e.stopPropagation()}>
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
          <div className="max-w-4xl mx-auto px-6 sm:px-8 py-7">
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
