import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PageHeader from '@/components/layout/PageHeader';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import Dialog from '@/components/ui/Dialog';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Input from '@/components/ui/Input';
import Textarea from '@/components/ui/Textarea';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';
import Button from '@/components/ui/Button';
import IconButton from '@/components/ui/IconButton';
import Badge from '@/components/ui/Badge';
import { usePermissions } from '@/hooks/usePermissions';
import useAdminResource from '@/hooks/useAdminResource';

const PAGE_SIZES = [10, 20, 50, 100];

/** "Roles" → "Role", "Organizations" → "Organization" — for "Add {singular}" etc. */
const singularOf = (title) => (title.endsWith('ies') ? `${title.slice(0, -3)}y`
  : title.endsWith('s') ? title.slice(0, -1) : title);

/** One cell, driven by the column's `type` or a custom `render`. */
function Cell({ col, row }) {
  if (col.render) return col.render(row);
  const v = row[col.key];
  if (col.type === 'status') {
    return v ? <Badge tone="success" size="xs">Active</Badge> : <Badge tone="neutral" size="xs">Inactive</Badge>;
  }
  if (col.type === 'json') {
    return (
      <pre className="max-w-xs overflow-auto rounded-control bg-sunken px-2 py-1.5 text-[11px] text-fg">
        {v ? JSON.stringify(v, null, 2) : '—'}
      </pre>
    );
  }
  if (v === null || v === undefined || v === '') return <span className="text-subtle">—</span>;
  return String(v);
}

/** One form control, driven by the field's `type`. */
function FieldControl({ field, value, onChange, options }) {
  switch (field.type) {
    case 'textarea':
      return <Textarea rows={3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={field.readOnly} />;
    case 'checkbox':
      return <Switch checked={!!value} onChange={onChange} disabled={field.readOnly} />;
    case 'select':
      return (
        <Select
          value={value ?? ''}
          onChange={onChange}
          options={options || field.options || []}
          placeholder={`— Select ${field.label} —`}
          disabled={field.readOnly}
        />
      );
    case 'number':
      return <Input type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={field.readOnly} />;
    case 'date':
      return <Input type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={field.readOnly} />;
    case 'json':
      return (
        <pre className="max-h-40 overflow-auto rounded-control bg-sunken px-2.5 py-2 text-[11px] text-fg">
          {value ? JSON.stringify(value, null, 2) : '—'}
        </pre>
      );
    default:
      return <Input value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={field.readOnly} />;
  }
}

/**
 * The generic Administration CRUD page. One instance per `config` (see
 * @/config/adminResources.js) serves every sub-page — list/search/sort/
 * paginate, add/edit via `Dialog`, delete via `ConfirmDialog`.
 *
 * `orgId`/`orgName` come from the Administration hub's `?org=&orgName=`
 * query params for org-scoped resources (config.orgScoped) — undefined for
 * global catalogs (Permissions, Modules, Pages) and unused for read-only
 * log pages.
 */
export default function AdminResourcePage({ config, orgId: orgIdProp, orgName: orgNameProp }) {
  // Org context for a `orgScoped` resource comes from the Administration hub's
  // `?org=&orgName=` query params by default — routes can still pass it as an
  // explicit prop (e.g. the bespoke Role Permissions page uses a URL param
  // instead of a query string).
  const [searchParams] = useSearchParams();
  const orgId = orgIdProp ?? (searchParams.get('org') ? Number(searchParams.get('org')) : undefined);
  const orgName = orgNameProp ?? searchParams.get('orgName') ?? undefined;

  const { canHere } = usePermissions();
  const allowAdd = !config.readOnly && canHere('add');
  const allowEdit = !config.readOnly && canHere('edit');
  const allowDelete = !config.readOnly && canHere('delete');

  const {
    rows, isLoading, isFetching, refresh,
    create, update, remove, isCreating, isUpdating, isRemoving,
  } = useAdminResource(config.key, config.api, config.orgScoped ? orgId : undefined);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: config.columns[0].key, dir: 'asc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [form, setForm] = useState(null); // { mode: 'add'|'edit'|'view', values, errors }
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [dynOptions, setDynOptions] = useState({});
  const [toast, setToast] = useState(null);

  const searchKeys = config.searchKeys || config.columns.map((c) => c.key);
  const singular = singularOf(config.title);

  const flash = (text, tone = 'success') => {
    setToast({ text, tone });
    setTimeout(() => setToast(null), 2500);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => searchKeys.some((k) => String(r[k] ?? '').toLowerCase().includes(q)));
  }, [rows, search, searchKeys]);

  const tableColumns = useMemo(() => [
    ...config.columns.map((c) => ({ key: c.key, label: c.label, width: c.width, align: c.align, sortable: true })),
    ...(!config.readOnly || allowEdit || allowDelete ? [{ key: '__actions', label: 'Action', align: 'right', width: 120 }] : []),
  ], [config.columns, config.readOnly, allowEdit, allowDelete]);

  const allTableRows = useMemo(() => filtered.map((row) => ({
    key: row[config.idKey],
    cells: {
      ...Object.fromEntries(config.columns.map((c) => [c.key, <Cell key={c.key} col={c} row={row} />])),
      __actions: (
        <div className="flex items-center justify-end gap-1">
          <IconButton icon="eye" label="View" size="sm" onClick={() => openView(row)} />
          {allowEdit && <IconButton icon="file-edit" label="Edit" size="sm" onClick={() => openEdit(row)} />}
          {allowDelete && <IconButton icon="trash" label="Delete" size="sm" tone="danger" onClick={() => setDeleteTarget(row)} />}
        </div>
      ),
    },
    sort: Object.fromEntries(config.columns.map((c) => [c.key, row[c.key]])),
    // eslint-disable-next-line no-use-before-define
  })), [filtered, config.columns, config.idKey, allowEdit, allowDelete]);

  const sortedRows = sortRows(allTableRows, sort);
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = sortedRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const onSort = (key) => { setSort((s) => nextSort(s, key)); setPage(1); };

  // ── async select options (loadOptions) — fetched once the form opens ──
  useEffect(() => {
    if (!form) return;
    const asyncFields = config.fields.filter((f) => f.type === 'select' && f.loadOptions);
    if (!asyncFields.length) return;
    let cancelled = false;
    Promise.all(asyncFields.map((f) => f.loadOptions(orgId).then((opts) => [f.key, opts]).catch(() => [f.key, []])))
      .then((pairs) => { if (!cancelled) setDynOptions(Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.mode, orgId]);

  function emptyValues() {
    const v = {};
    config.fields.forEach((f) => { v[f.key] = f.type === 'checkbox' ? true : (f.autoValue ? f.autoValue(rows) : ''); });
    if (config.orgScoped && orgId) v.org_id = orgId;
    return v;
  }

  function openCreate() { setForm({ mode: 'add', values: emptyValues(), errors: {} }); }
  function openEdit(row) { setForm({ mode: 'edit', values: { ...row }, errors: {} }); }
  function openView(row) { setForm({ mode: 'view', values: { ...row }, errors: {} }); }
  function closeForm() { setForm(null); setDynOptions({}); }

  function setField(key, value) {
    setForm((f) => ({ ...f, values: { ...f.values, [key]: value }, errors: { ...f.errors, [key]: undefined } }));
  }

  async function submitForm() {
    const errors = {};
    config.fields.forEach((f) => {
      if (f.required && (form.values[f.key] === '' || form.values[f.key] == null)) errors[f.key] = 'Required';
    });
    if (Object.keys(errors).length) { setForm((f) => ({ ...f, errors })); return; }

    try {
      if (form.mode === 'add') {
        await create(form.values);
        flash(`${singular} created.`);
      } else {
        await update({ id: form.values[config.idKey], row: form.values });
        flash(`${singular} updated.`);
      }
      closeForm();
    } catch (err) {
      flash(err?.message || 'Something went wrong.', 'danger');
    }
  }

  async function confirmDelete() {
    try {
      await remove(deleteTarget[config.idKey]);
      flash(`${singular} deleted.`);
    } catch (err) {
      flash(err?.message || 'Delete failed.', 'danger');
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <>
      <PageHeader
        title={config.title}
        icon={config.icon}
        description={orgName ? `${config.subtitle} · ${orgName}` : config.subtitle}
        backTo={config.orgScoped && orgId ? `/administration/${orgId}` : '/administration'}
        backLabel="Administration"
        actions={(
          <div className="flex items-center gap-2">
            <IconButton icon="refresh" label="Refresh" onClick={refresh} iconClassName={isFetching ? 'animate-spin' : undefined} />
            {allowAdd && <Button variant="primary" icon="plus" onClick={openCreate}>Add {singular}</Button>}
          </div>
        )}
      />

      <div className="card mt-6 flex flex-wrap items-center gap-2 px-card py-3">
        <Input
          icon="search"
          placeholder={`Search ${config.title.toLowerCase()}…`}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          onClear={() => setSearch('')}
          wrapperClassName="w-full min-w-0 sm:w-auto sm:max-w-72 sm:flex-1"
        />
        <span className="ml-auto text-[12px] whitespace-nowrap text-subtle">
          {filtered.length} of {rows.length} {config.title.toLowerCase()}
        </span>
      </div>

      <section className="card mt-6 overflow-hidden">
        <Table
          columns={tableColumns}
          rows={pageRows}
          sort={sort}
          onSort={onSort}
          loading={isLoading || isFetching}
          empty={(
            <EmptyState
              icon={config.icon}
              title={search ? `No matches for "${search}"` : `No ${config.title.toLowerCase()} yet`}
              body={!search && allowAdd ? `Click "Add ${singular}" to create the first one.` : undefined}
            />
          )}
        />
      </section>

      {sortedRows.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
          <span>
            Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, sortedRows.length)} of {sortedRows.length}
          </span>
          <div className="flex items-center gap-2">
            <Select
              width="auto"
              size="sm"
              value={String(pageSize)}
              onChange={(v) => { setPageSize(Number(v)); setPage(1); }}
              options={PAGE_SIZES.map((n) => ({ id: String(n), label: `${n} / page` }))}
            />
            <IconButton icon="chevron-left" label="Previous page" size="sm" disabled={currentPage <= 1} onClick={() => setPage((p) => p - 1)} />
            <span className="tabular-nums">{currentPage} / {pageCount}</span>
            <IconButton icon="chevron-right" label="Next page" size="sm" disabled={currentPage >= pageCount} onClick={() => setPage((p) => p + 1)} />
          </div>
        </div>
      )}

      {form && (
        <Dialog
          open
          onClose={closeForm}
          icon={config.icon}
          title={form.mode === 'add' ? `Add ${singular}` : form.mode === 'edit' ? `Edit ${singular}` : `${singular} Details`}
          footer={form.mode === 'view' ? (
            <div className="flex justify-end"><Button variant="secondary" onClick={closeForm}>Close</Button></div>
          ) : (
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={closeForm}>Cancel</Button>
              <Button variant="primary" loading={isCreating || isUpdating} onClick={submitForm}>
                {form.mode === 'add' ? 'Create' : 'Save'}
              </Button>
            </div>
          )}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {config.fields.map((f) => (
              <div key={f.key} className={f.type === 'textarea' || f.type === 'json' ? 'sm:col-span-2' : undefined}>
                <label className="mb-1 block text-[12px] font-semibold text-muted">
                  {f.label}{f.required && <span className="text-danger"> *</span>}
                </label>
                {form.mode === 'view' ? (
                  <p className="text-[13px] text-fg">
                    {f.type === 'checkbox' ? (form.values[f.key] ? 'Active' : 'Inactive') : String(form.values[f.key] ?? '—')}
                  </p>
                ) : (
                  <FieldControl
                    field={f}
                    value={form.values[f.key]}
                    onChange={(v) => setField(f.key, v)}
                    options={dynOptions[f.key]}
                  />
                )}
                {form.errors?.[f.key] && <p className="mt-1 text-[11px] text-danger">{form.errors[f.key]}</p>}
                {f.help && <p className="mt-1 text-[11px] text-subtle">{f.help}</p>}
              </div>
            ))}
          </div>
        </Dialog>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title={`Delete ${singular}?`}
        message={deleteTarget ? `This removes "${deleteTarget[config.columns[1]?.key] || deleteTarget[config.idKey]}". This can't be undone.` : ''}
        confirmLabel="Delete"
        tone="danger"
        icon="trash"
        loading={isRemoving}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {toast && (
        <div
          className={`fixed right-6 bottom-6 z-[95] rounded-control px-4 py-2.5 text-[13px] font-semibold shadow-lg ${
            toast.tone === 'danger' ? 'bg-danger text-white' : 'bg-success text-white'}`}
        >
          {toast.text}
        </div>
      )}
    </>
  );
}
