import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import cn from '@/lib/cn';
import PageHeader from '@/components/layout/PageHeader';
import Table, { EmptyState, nextSort, sortRows } from '@/components/ui/Table';
import Pagination, { pageCountOf, paginate } from '@/components/ui/Pagination';
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
import { useThemeStore } from '@/theme/themeStore';
import { uploadsApi } from '@/api/admin';
import { useLogsTimezoneStore, LOG_TIMEZONES } from '@/store/logsTimezoneStore';

/** Same 16px/500/18px-lh body-cell size as the Agents list's dark-header
    table (AgentsPage.jsx's CELL_TEXT) — kept as its own copy rather than a
    shared import since the two pages don't share a module today, but the
    literal values must stay identical for the two tables to read as one
    system. */
const CELL_TEXT = 'whitespace-nowrap text-[1rem] leading-[1.125rem] font-medium';

/** "Roles" → "Role", "Organizations" → "Organization" — for "Add {singular}" etc. */
const singularOf = (title) => (title.endsWith('ies') ? `${title.slice(0, -3)}y`
  : title.endsWith('s') ? title.slice(0, -1) : title);

/** One cell, driven by the column's `type` or a custom `render`. `identity`
    (the row's primary name field, column index 1 in every resource) renders
    bold — matching how the Agents list bolds its own identity column
    (the name half of "Agent/Host"), while every other column stays the
    regular CELL_TEXT weight. */
function Cell({ col, row, identity }) {
  if (col.render) return col.render(row);
  const v = row[col.key];
  if (col.type === 'status') {
    // Same 16px/500/18px-lh text as every other cell (CELL_TEXT) and as the
    // Agents list's own Status pill — set via inline style, not a size prop,
    // since Badge's own xs/sm classes are same-specificity Tailwind
    // utilities that aren't guaranteed to lose to an override class.
    const pillStyle = { paddingTop: '0.25rem', paddingRight: '0.5rem', paddingBottom: '0.25rem', paddingLeft: '0.5rem', fontSize: '1rem', lineHeight: '1.125rem', fontWeight: 500 };
    return v
      ? <Badge tone="success" style={pillStyle}>Active</Badge>
      : <Badge tone="neutral" style={pillStyle}>Inactive</Badge>;
  }
  if (col.type === 'json') {
    return (
      <pre className="max-w-xs overflow-auto rounded-control bg-sunken px-2 py-1.5 text-[11px] text-fg">
        {v ? JSON.stringify(v, null, 2) : '—'}
      </pre>
    );
  }
  if (v === null || v === undefined || v === '') return <span className={CELL_TEXT}>—</span>;
  return <span className={cn(CELL_TEXT, identity && 'font-bold text-fg')}>{String(v)}</span>;
}

/** Upload-and-preview control for `type: 'image'` fields (org logos). The
    field's value is always a served URL string, same as a text field — this
    just replaces typing that URL with picking a file, which the backend
    uploads and hands a URL back for. */
function ImageFieldControl({ field, value, onChange }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // lets the same file be re-picked later
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      onChange(await uploadsApi.logo(file));
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {value ? (
        <img src={encodeURI(value)} alt="" className="h-12 w-12 rounded-control border border-border bg-sunken object-contain" />
      ) : (
        <span className="grid h-12 w-12 place-items-center rounded-control border border-dashed border-border text-[10px] text-muted">
          No logo
        </span>
      )}
      <div className="flex flex-col gap-1">
        <label className={cn(
          'inline-flex w-fit items-center gap-2 rounded-control border border-border bg-raised px-3 py-1.5 text-[12px] font-semibold text-fg hover:bg-sunken',
          (uploading || field.readOnly) ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        )}>
          {uploading ? 'Uploading…' : value ? 'Replace image' : 'Upload image'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
            className="hidden"
            disabled={uploading || field.readOnly}
            onChange={handleFile}
          />
        </label>
        {error && <span className="text-[11px] text-danger">{error}</span>}
      </div>
    </div>
  );
}

/** One form control, driven by the field's `type`. */
function FieldControl({ field, value, onChange, options }) {
  switch (field.type) {
    case 'image':
      return <ImageFieldControl field={field} value={value} onChange={onChange} />;
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
    case 'password':
      // Value is always blank on open (see openEdit/openCreate) — never
      // pre-filled from a fetched row, and never displayed in view mode
      // (handled separately, above this switch). Blank on submit means
      // "leave unchanged"; the backend is responsible for not overwriting
      // the stored value with an empty string.
      return (
        <Input type="password" value={value ?? ''} onChange={(e) => onChange(e.target.value)}
          disabled={field.readOnly} autoComplete="new-password" placeholder={field.editPlaceholder} />
      );
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
 * paginate, add/edit/view as a full page (replaces the list entirely while
 * open, same shell as AddOsServerPage.jsx), delete via `ConfirmDialog`.
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

  // Subscribing here (not just reading it inside dt()'s getState() call) is
  // what makes changing the dropdown actually repaint the table — dt() is a
  // plain function used inside column `render`, not a component, so it can't
  // subscribe itself; this re-renders the whole page (and every cell with
  // it) whenever the selected timezone changes.
  const logsTz = useLogsTimezoneStore((s) => s.tz);
  const setLogsTz = useLogsTimezoneStore((s) => s.setTz);

  const {
    rows, isLoading, isFetching, refresh,
    create, update, remove, isCreating, isUpdating, isRemoving,
  } = useAdminResource(config.key, config.api, config.orgScoped ? orgId : undefined);

  const [sort, setSort] = useState({ key: config.columns[0].key, dir: 'asc' });
  const [page, setPage] = useState(1);
  // Same pattern as AgentsPage.jsx/ObjectTable.jsx: the app-wide rowsPerPage
  // appearance setting is the default, overridable per-session by the
  // pager's own page-size control — so this table's pager behaves exactly
  // like every other paged list in the app, not just visually.
  const appPageSize = useThemeStore((s) => s.rowsPerPage);
  const [ownPageSize, setOwnPageSize] = useState(null);
  const pageSize = ownPageSize ?? appPageSize;
  const [form, setForm] = useState(null); // { mode: 'add'|'edit'|'view', values, errors }
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [dynOptions, setDynOptions] = useState({});
  const [toast, setToast] = useState(null);

  const singular = singularOf(config.title);

  const flash = (text, tone = 'success') => {
    setToast({ text, tone });
    setTimeout(() => setToast(null), 2500);
  };

  const tableColumns = useMemo(() => [
    // Every resource's column list is [ID, primary name/label field, …others].
    // The ID centers (short, like Agents' "Sr. No.") and the primary field
    // stays left (the row's identity, like Agents' "Agent/Host") — everything
    // after that defaults to centered so it lines up under the dark header's
    // always-centered label, unless a column explicitly wants otherwise
    // (e.g. permission_value/display_order stay right-aligned as numbers).
    ...config.columns.map((c, i) => ({
      key: c.key, label: c.label, width: c.width,
      align: c.align || (i === 1 ? 'left' : 'center'),
      sortable: true,
    })),
    ...(!config.readOnly || allowEdit || allowDelete ? [{ key: '__actions', label: 'Action', align: 'right', width: 120 }] : []),
  ], [config.columns, config.readOnly, allowEdit, allowDelete]);

  const allTableRows = useMemo(() => rows.map((row) => ({
    key: row[config.idKey],
    cells: {
      ...Object.fromEntries(config.columns.map((c, i) => [c.key, <Cell key={c.key} col={c} row={row} identity={i === 1} />])),
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
  })), [rows, config.columns, config.idKey, allowEdit, allowDelete]);

  const sortedRows = sortRows(allTableRows, sort);
  const pageCount = pageCountOf(sortedRows.length, pageSize);
  const currentPage = Math.min(page, pageCount);
  const pageRows = paginate(sortedRows, currentPage, pageSize);

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

  // Password-type fields are never pre-filled from a fetched row — whatever
  // the API returned for one (a hash, a masked placeholder) is blanked out
  // here so it's never displayed, never re-submitted unchanged, and never
  // sitting in form state at all longer than necessary.
  function withPasswordsBlanked(row) {
    const v = { ...row };
    config.fields.forEach((f) => { if (f.type === 'password') v[f.key] = ''; });
    return v;
  }

  function openCreate() { setForm({ mode: 'add', values: emptyValues(), errors: {} }); }
  function openEdit(row) { setForm({ mode: 'edit', values: withPasswordsBlanked(row), errors: {} }); }
  function openView(row) { setForm({ mode: 'view', values: withPasswordsBlanked(row), errors: {} }); }
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
        // A blank password field means "leave it unchanged" — never send an
        // empty string on update, which some backends would otherwise treat
        // as a real (empty) value and overwrite the stored credential/hash.
        const row = { ...form.values };
        config.fields.forEach((f) => { if (f.type === 'password' && !row[f.key]) delete row[f.key]; });
        await update({ id: form.values[config.idKey], row });
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

  // Add/Edit/View replace the whole list with a full page, same shape as
  // AddOsServerPage.jsx (PageHeader + .card + footer bar) — not a modal.
  if (form) {
    const formTitle = form.mode === 'add' ? `Add ${singular}` : form.mode === 'edit' ? `Edit ${singular}` : `${singular} Details`;
    return (
      <>
        <PageHeader
          title={formTitle}
          icon={config.icon}
          description={orgName ? `${config.subtitle} · ${orgName}` : config.subtitle}
          onBack={closeForm}
          backLabel={config.title}
        />

        <div className="card overflow-hidden">
          <div className="px-card py-card">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {config.fields.map((f) => (
                <div key={f.key} className={f.type === 'textarea' || f.type === 'json' || f.fullWidth ? 'sm:col-span-2' : undefined}>
                  <label className="mb-1 block text-[12px] font-semibold text-muted">
                    {f.label}{f.required && <span className="text-danger"> *</span>}
                  </label>
                  {form.mode === 'view' ? (
                    f.type === 'image' ? (
                      form.values[f.key]
                        ? <img src={encodeURI(form.values[f.key])} alt="" className="h-12 w-12 rounded-control border border-border bg-sunken object-contain" />
                        : <p className="text-[13px] text-fg">—</p>
                    ) : (
                      <p className="text-[13px] text-fg">
                        {f.type === 'checkbox' ? (form.values[f.key] ? 'Active' : 'Inactive')
                          : f.type === 'password' ? 'Configured'
                          : String(form.values[f.key] ?? '—')}
                      </p>
                    )
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
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-raised px-card py-3">
            {form.mode === 'view' ? (
              <Button variant="secondary" onClick={closeForm}>Close</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={closeForm}>Cancel</Button>
                <Button variant="primary" loading={isCreating || isUpdating} onClick={submitForm}>
                  {form.mode === 'add' ? 'Create' : 'Save'}
                </Button>
              </>
            )}
          </div>
        </div>

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

  return (
    <>
      <PageHeader
        title={config.title}
        icon={config.icon}
        description={orgName ? `${config.subtitle} · ${orgName}` : config.subtitle}
        backTo={config.orgScoped && orgId ? `/administration/${orgId}` : (config.hub?.to || '/administration')}
        backLabel={config.orgScoped ? 'Administration' : (config.hub?.label || 'Administration')}
        actions={(
          <div className="flex items-center gap-2">
            {config.showTimezoneSelector && (
              <div className="w-44">
                <Select
                  value={logsTz}
                  onChange={setLogsTz}
                  options={LOG_TIMEZONES.map((t) => ({ id: t.id, label: t.label }))}
                />
              </div>
            )}
            <IconButton icon="refresh" label="Refresh" onClick={refresh} iconClassName={isFetching ? 'animate-spin' : undefined} />
            {allowAdd && <Button variant="primary" icon="plus" onClick={openCreate}>Add {singular}</Button>}
          </div>
        )}
      />

      {/* No outer .card wrapper — matches AgentsPage.jsx's list view: darkHeader
          mode already renders each row as its own floating rounded card on a
          plain backdrop, so an enclosing bordered card would double the chrome.
          Negative margin pulls the table up against PageHeader's own bottom
          spacing plus darkHeader's own internal top padding (Table.jsx's
          `rounded-2xl bg-sunken p-3` wrapper) — both are shared/app-wide, so
          rather than touch either, this page (the only one with nothing in
          between) compensates locally for a genuinely minimal gap. */}
      <div className="-mt-4">
        <Table
          columns={tableColumns}
          rows={pageRows}
          sort={sort}
          onSort={onSort}
          rowHeight={64}
          loading={isLoading || isFetching}
          empty={(
            <EmptyState
              icon={config.icon}
              title={`No ${config.title.toLowerCase()} yet`}
              body={allowAdd ? `Click "Add ${singular}" to create the first one.` : undefined}
            />
          )}
          darkHeader
        />
      </div>

      {sortedRows.length > 0 && (
        <div className="card mt-4">
          <Pagination
            page={currentPage}
            pageCount={pageCount}
            total={sortedRows.length}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={setOwnPageSize}
            unit={config.title.toLowerCase()}
          />
        </div>
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
