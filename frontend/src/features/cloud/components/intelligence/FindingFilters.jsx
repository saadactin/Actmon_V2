import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import {
  CATEGORY_ORDER, PROVIDER_LABEL, SEVERITIES, STATUS_GROUPS, categoryMeta, statusMeta, toggleIn,
} from '../../utils/intelligenceModel';

const SORTS = [
  { id: 'severity', label: 'Worst first' },
  { id: 'savings', label: 'Largest saving first' },
  { id: 'newest', label: 'Newest first' },
  { id: 'resource', label: 'By resource name' },
];

/**
 * Search, sort and the four chip rows. Counts come from the backend's facets,
 * computed with every OTHER filter applied — so a chip's number is what the
 * list will hold if it is clicked.
 */
export default function FindingFilters({ filters, facets, onChange, total }) {
  const count = (name, value) => (facets?.[name] || []).find((f) => f.value === value)?.count;
  const set = (patch) => onChange({ ...filters, ...patch });
  const categories = CATEGORY_ORDER.filter((c) => count('category', c) || filters.category.includes(c));
  const providers = (facets?.provider || []).map((p) => p.value);

  return (
    <div className="space-y-3 rounded-card border border-border bg-surface px-card py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          icon="search"
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
          onClear={() => set({ search: '' })}
          placeholder="Search resources, findings, recommendations…"
          wrapperClassName="min-w-[16rem] flex-1"
        />
        <Select
          value={filters.sort}
          onChange={(v) => set({ sort: v })}
          options={SORTS}
          width="auto"
          aria-label="Sort"
        />
        <label className="inline-flex items-center gap-1.5 text-[12px] text-muted">
          <input
            type="checkbox"
            checked={filters.has_savings}
            onChange={(e) => set({ has_savings: e.target.checked })}
            className="accent-[var(--accent)]"
          />
          Priced savings only
        </label>
        <span className="ml-auto text-[12px] text-muted">
          {typeof total === 'number' ? `${total.toLocaleString()} finding${total === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      <ChipRow label="Category">
        <Chip active={!filters.category.length} onClick={() => set({ category: [] })}>All</Chip>
        {categories.map((c) => (
          <Chip key={c} active={filters.category.includes(c)} count={count('category', c)}
            icon={categoryMeta(c).icon}
            onClick={() => set({ category: toggleIn(filters.category, c) })}>
            {categoryMeta(c).label}
          </Chip>
        ))}
      </ChipRow>

      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <ChipRow label="Severity">
          {SEVERITIES.filter((s) => count('severity', s) || filters.severity.includes(s)).map((s) => (
            <Chip key={s} active={filters.severity.includes(s)} count={count('severity', s)}
              onClick={() => set({ severity: toggleIn(filters.severity, s) })}>
              {s[0]}{s.slice(1).toLowerCase()}
            </Chip>
          ))}
        </ChipRow>
        {providers.length > 0 && (
          <ChipRow label="Provider">
            {providers.map((p) => (
              <Chip key={p} active={filters.provider.includes(p)} count={count('provider', p)}
                onClick={() => set({ provider: toggleIn(filters.provider, p) })}>
                {PROVIDER_LABEL[p] || p}
              </Chip>
            ))}
          </ChipRow>
        )}
        <ChipRow label="Status">
          {STATUS_GROUPS.map((s) => (
            <Chip key={s} active={filters.status.includes(s)} count={count('status', s)}
              onClick={() => set({ status: toggleIn(filters.status, s) })}>
              {statusMeta(s).label}
            </Chip>
          ))}
        </ChipRow>
      </div>
    </div>
  );
}

function ChipRow({ label, children }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-16 shrink-0 text-[10.5px] font-bold uppercase tracking-wider text-subtle">{label}</span>
      {children}
    </div>
  );
}

function Chip({ active, count, icon, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-semibold transition-colors',
        active
          ? 'border-accent bg-accent-soft text-accent-text'
          : 'border-border text-muted hover:border-strong hover:text-fg',
      )}
    >
      {icon && <Icon name={icon} size={12} />}
      {children}
      {typeof count === 'number' && (
        <span className={cn('tabular-nums', active ? 'text-accent-text' : 'text-subtle')}>{count}</span>
      )}
    </button>
  );
}
