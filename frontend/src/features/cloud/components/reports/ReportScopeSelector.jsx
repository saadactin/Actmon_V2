import Badge from '@/components/ui/Badge';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import { Field, Section, Segmented } from '@/components/ui/Field';
import { useResourceFacets } from '../../hooks/useResources';

const RISK_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'NONE', 'UNKNOWN'];

// facet name (from /resources/facets) -> the filter key the report sends.
// Same keys the Resources table uses, so a filter means the same thing there.
const PICKERS = [
  { facet: 'regions', filter: 'region', label: 'Region' },
  { facet: 'types', filter: 'type', label: 'Resource type' },
  { facet: 'services', filter: 'service', label: 'Service' },
  { facet: 'environments', filter: 'environment', label: 'Environment' },
];

/** Toggle chips for one facet, each with its resource count. Values a saved
 *  draft still selects but the account no longer has stay visible (count 0),
 *  so a stale filter can be seen and removed rather than silently matching
 *  nothing. */
function FacetPicker({ label, options, selected, onToggle, loading }) {
  const known = new Set(options.map((o) => o.value));
  const stale = selected.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v, count: 0 }));
  const all = [...options, ...stale];
  return (
    <Field label={label} hint={selected.length ? `${selected.length} selected` : 'Any'}>
      {loading && !all.length ? (
        <p className="text-meta text-subtle">Loading values…</p>
      ) : all.length === 0 ? (
        <p className="text-meta text-subtle">This account has no values for this field.</p>
      ) : (
        <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
          {all.map((o) => (
            <button key={o.value} type="button" onClick={() => onToggle(o.value)} className="cursor-pointer">
              <Badge tone={selected.includes(o.value) ? 'accent' : 'outline'}>
                {o.label || o.value}
                <span className="opacity-70">{o.count}</span>
              </Badge>
            </button>
          ))}
        </div>
      )}
    </Field>
  );
}

/**
 * Scope step: current/selected resources (only offered when the caller
 * arrived with a hand-picked set — e.g. from the Resources table's "Build
 * Report…" action), a filtered subset of the account, or the whole account.
 */
export default function ReportScopeSelector({ accountId, scope, onChange, preSelectedIds = [] }) {
  const hasPreSelection = preSelectedIds.length > 0;
  const facetsQuery = useResourceFacets(scope.mode === 'filtered' ? accountId : null, {});
  const facets = facetsQuery.data?.facets || {};

  const modeOptions = [
    ...(hasPreSelection ? [{ id: 'resources', label: `Selected resources (${preSelectedIds.length})` }] : []),
    { id: 'filtered', label: 'Filtered subset' },
    { id: 'account', label: 'Whole account' },
  ];

  const setFilter = (key, value) => onChange({
    ...scope,
    filters: { ...scope.filters, [key]: value || undefined },
  });

  const toggleIn = (key, value) => {
    const current = scope.filters[key] || [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    setFilter(key, next.length ? next : undefined);
  };

  return (
    <div className="space-y-5">
      <Section title="Scope">
        <Segmented
          options={modeOptions}
          value={scope.mode}
          onChange={(mode) => onChange({ ...scope, mode })}
        />
        {scope.mode === 'resources' && !hasPreSelection && (
          <Notice tone="warning" className="mt-3">
            No resources were selected. Go back to the Resources table, select rows, and
            reopen the report builder, or pick a filtered/whole-account scope instead.
          </Notice>
        )}
      </Section>

      {scope.mode === 'filtered' && (
        <Section title="Filters">
          {facetsQuery.isError && (
            <Notice tone="warning">The account's values could not be loaded; only the search box works until they do.</Notice>
          )}
          <Field label="Search" hint="Name, provider ID, IP, type, region, tag value">
            <Input
              value={scope.filters.q || ''}
              onChange={(e) => setFilter('q', e.target.value)}
              placeholder="e.g. prod-db"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {PICKERS.map((p) => (
              <FacetPicker
                key={p.filter}
                label={p.label}
                options={facets[p.facet] || []}
                selected={scope.filters[p.filter] || []}
                loading={facetsQuery.isLoading}
                onToggle={(value) => toggleIn(p.filter, value)}
              />
            ))}
          </div>
          <Field label="Security risk" className="mt-3">
            <div className="flex flex-wrap gap-1.5">
              {RISK_LEVELS.map((level) => (
                <button key={level} type="button" onClick={() => toggleIn('risk', level)} className="cursor-pointer">
                  <Badge tone={(scope.filters.risk || []).includes(level) ? 'accent' : 'outline'}>{level}</Badge>
                </button>
              ))}
            </div>
          </Field>
        </Section>
      )}

      {scope.mode === 'account' && (
        <Notice tone="info">
          Every resource in this account is in scope, plus account-level findings that belong to
          no single resource. Large accounts are capped at 1,000 resources per report — narrow
          the scope with a filter if that cap is hit.
        </Notice>
      )}
    </div>
  );
}
