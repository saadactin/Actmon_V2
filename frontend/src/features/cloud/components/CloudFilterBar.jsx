import cn from '@/lib/cn';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';

/**
 * Recurring search + dropdown-filter row used across the Resources/Security/
 * Cost list views — replaces each page's own raw `<input>`/`<select>` filter
 * markup with the shared, token-driven Input/Select components.
 *
 *   search, onSearchChange   omit both to hide the search box
 *   filters: [{ key, value, onChange, options, placeholder, width }]
 */
export default function CloudFilterBar({
  search,
  onSearchChange,
  searchPlaceholder = 'Search…',
  filters = [],
  className,
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {onSearchChange && (
        <Input
          icon="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          onClear={() => onSearchChange('')}
          placeholder={searchPlaceholder}
          wrapperClassName="min-w-[200px] max-w-xs flex-1"
        />
      )}
      {filters.map((f, i) => (
        <Select
          key={f.key ?? i}
          value={f.value}
          onChange={f.onChange}
          options={f.options}
          placeholder={f.placeholder}
          width={f.width || 'auto'}
        />
      ))}
    </div>
  );
}
