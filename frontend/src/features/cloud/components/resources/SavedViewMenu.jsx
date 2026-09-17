import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import cn from '@/lib/cn';
import { fromParams } from '../../api/resources.api';
import { useDeleteView, useSavedViews, useSaveView } from '../../hooks/useResources';
import { EMPTY_FILTERS } from '../../utils/resourceModel';

/**
 * Saved views, plus the standing questions everyone asks.
 *
 * The built-ins below are query definitions, not a separate code path: each one
 * is a filter set applied through exactly the same mechanism a user's own saved
 * view uses. That matters because a "quick filter" implemented as special-case
 * browser logic would answer a slightly different question from the identical
 * filter set chosen by hand.
 *
 * "Wasteful" is deliberately absent. Stopped is not wasteful on its own — a
 * stopped instance costing nothing is just switched off — and the evidence
 * needed to make that claim honestly (cost AND stopped, or cost AND unattached)
 * is what the two entries below actually require.
 */
const BUILT_INS = [
  {
    id: 'unattached-storage',
    name: 'Unattached storage',
    hint: 'Volumes the provider reports as attached to nothing',
    filters: { ...EMPTY_FILTERS, attachment: 'UNATTACHED' },
  },
  {
    id: 'stopped',
    name: 'Stopped resources',
    hint: 'Not running, per the provider',
    filters: { ...EMPTY_FILTERS, statuses: ['STOPPED'] },
  },
  {
    id: 'stopped-but-billed',
    name: 'Stopped but still billed',
    hint: 'Stopped AND carrying a real cost — evidence of waste, not a guess',
    filters: { ...EMPTY_FILTERS, statuses: ['STOPPED'], hasCost: true },
  },
  {
    id: 'unattached-but-billed',
    name: 'Unattached but still billed',
    hint: 'Detached storage the provider is still charging for',
    filters: { ...EMPTY_FILTERS, attachment: 'UNATTACHED', hasCost: true },
  },
  {
    id: 'high-risk',
    name: 'High risk',
    hint: 'Critical or High security findings',
    filters: { ...EMPTY_FILTERS, risk: ['CRITICAL', 'HIGH'] },
  },
  {
    id: 'untagged',
    name: 'Untagged',
    hint: 'No tags at all',
    filters: { ...EMPTY_FILTERS, hasTags: false },
  },
  {
    id: 'stale',
    name: 'Stale inventory',
    hint: 'Not re-observed within the freshness window',
    filters: { ...EMPTY_FILTERS, stale: true },
  },
  {
    id: 'no-state',
    name: 'No reported state',
    hint: 'The provider returned no lifecycle state',
    filters: { ...EMPTY_FILTERS, statuses: ['UNKNOWN'] },
  },
  {
    id: 'expensive',
    name: 'Most expensive',
    hint: 'Only resources with real per-resource billing',
    filters: { ...EMPTY_FILTERS, hasCost: true },
    sort: 'cost',
    dir: 'desc',
  },
];

export default function SavedViewMenu({
  scope, filters, columns, sort, dir, groupBy, onApply,
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);

  const { data, isLoading } = useSavedViews(scope);
  const save = useSaveView();
  const remove = useDeleteView();
  const views = data?.views || [];

  const apply = (view) => {
    setOpen(false);
    onApply({
      filters: view.filters,
      sort: view.sort || null,
      dir: view.dir || null,
      groupBy: view.group_by ?? view.groupBy ?? null,
      columns: view.columns || null,
    });
  };

  const handleSave = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      await save.mutateAsync({
        name, scope, filters, columns, sort, dir, groupBy,
      });
      setName('');
      setSaving(false);
    } catch (err) {
      setError(err?.response?.data?.detail?.error?.message || err.message || 'Could not save.');
    }
  };

  return (
    <div className="relative">
      <Button variant="secondary" size="sm" icon="bookmark" onClick={() => setOpen((v) => !v)}>
        Views
        {views.length > 0 && <Badge tone="accent" size="xs" className="ml-1">{views.length}</Badge>}
      </Button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close views menu"
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => { setOpen(false); setSaving(false); }}
          />
          <div className="absolute right-0 z-30 mt-1 max-h-[26rem] w-80 overflow-y-auto rounded-control border border-border bg-surface p-1.5 shadow-lg">
            <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-subtle">
              Standing questions
            </p>
            {BUILT_INS.map((view) => (
              <button
                key={view.id}
                type="button"
                onClick={() => apply(view)}
                className="w-full rounded-control px-2 py-1.5 text-left hover:bg-sunken"
              >
                <span className="block text-[12px] font-semibold text-fg">{view.name}</span>
                <span className="block text-[11px] leading-snug text-muted">{view.hint}</span>
              </button>
            ))}

            <div className="my-1 border-t border-border" />
            <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-subtle">
              Saved views
            </p>

            {isLoading && <p className="px-2 py-2 text-[12px] text-muted">Loading…</p>}
            {!isLoading && views.length === 0 && (
              <p className="px-2 py-2 text-[12px] text-muted">
                Nothing saved yet. Filter the table, then save it here.
              </p>
            )}

            {views.map((view) => (
              <div
                key={view.id}
                className="group flex items-center gap-1 rounded-control hover:bg-sunken"
              >
                <button
                  type="button"
                  onClick={() => apply({ ...view, filters: fromParams(view.filters) })}
                  className="min-w-0 flex-1 px-2 py-1.5 text-left"
                >
                  <span className="block truncate text-[12px] font-semibold text-fg">
                    {view.name}
                  </span>
                  {view.description && (
                    <span className="block truncate text-[11px] text-muted">{view.description}</span>
                  )}
                  {/* A view that quietly lost a filter would return more rows
                      than it used to and still look like it worked. */}
                  {view.dropped_filters?.length > 0 && (
                    <span className="block text-[11px] text-warning-fg">
                      {`${view.dropped_filters.length} filter(s) no longer supported`}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${view.name}`}
                  onClick={() => remove.mutate(view.id)}
                  className="mr-1 shrink-0 rounded p-1 text-subtle opacity-0 transition-opacity hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            ))}

            <div className="my-1 border-t border-border" />
            {saving ? (
              <form onSubmit={handleSave} className="space-y-1.5 p-1.5">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name this view…"
                  size="sm"
                  autoFocus
                />
                {error && <p className="text-[11px] text-danger">{error}</p>}
                <div className="flex gap-1.5">
                  <Button type="submit" variant="primary" size="sm" loading={save.isPending} disabled={!name.trim()}>
                    Save
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setSaving(false); setError(null); }}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setSaving(true)}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-control px-2 py-1.5',
                  'text-left text-[12px] font-semibold text-accent-text hover:bg-sunken',
                )}
              >
                <Icon name="plus" size={13} />
                Save current filters
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
