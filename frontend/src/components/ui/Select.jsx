import { forwardRef } from 'react';
import cn from '@/lib/cn';

const SIZES = {
  sm: 'h-control-sm text-[12px]',
  md: 'h-control text-[13px]',
};

/**
 * Native select, themed. Native on purpose — it gets keyboard behaviour, mobile
 * pickers and screen-reader support for free, and nothing here needs richer
 * option rendering.
 *
 *   options  [{ id, label, group? }] — entries sharing a `group` are grouped
 *   width    'full' fills its container (forms) · 'auto' hugs its content
 *            (filter rows, where several sit side by side)
 *
 * Width is a prop rather than something a caller overrides with a class: passing
 * `w-auto` in className can't beat a hardcoded `w-full`, because Tailwind decides
 * between two same-property utilities by CSS order, not by class-attribute order.
 * That's what stacked the alert filter row into one control per line.
 */
const Select = forwardRef(function Select(
  { value, onChange, options = [], size = 'md', width = 'full', placeholder, className, ...rest },
  ref,
) {
  const groups = options.some((o) => o.group);

  const renderOption = (o) => (
    <option key={o.id} value={o.id} disabled={o.disabled}>
      {o.label}
    </option>
  );

  return (
    <select
      ref={ref}
      value={value ?? ''}
      onChange={(e) => onChange?.(e.target.value)}
      className={cn(
        'min-w-0 rounded-control border border-border bg-surface pr-1.5 pl-2 font-medium text-fg',
        'transition-colors hover:border-strong',
        width === 'auto' ? 'w-auto max-w-[220px]' : 'w-full',
        SIZES[size] || SIZES.md,
        className,
      )}
      {...rest}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {groups
        ? Object.entries(
          options.reduce((acc, o) => {
            const key = o.group || 'Other';
            (acc[key] ||= []).push(o);
            return acc;
          }, {}),
        ).map(([label, items]) => (
          <optgroup key={label} label={label}>
            {items.map(renderOption)}
          </optgroup>
        ))
        : options.map(renderOption)}
    </select>
  );
});

export default Select;
