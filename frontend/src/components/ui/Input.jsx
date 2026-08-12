import { forwardRef } from 'react';
import cn from '@/lib/cn';
import Icon from './Icon';

const SIZES = {
  sm: 'h-control-sm text-[12px]',
  md: 'h-control text-[13px]',
};

/** Text / number input with an optional leading icon and clear button. */
const Input = forwardRef(function Input(
  { icon, size = 'md', onClear, className, wrapperClassName, ...rest },
  ref,
) {
  const showClear = Boolean(onClear && rest.value);

  return (
    <div className={cn('relative flex min-w-0 items-center', wrapperClassName)}>
      {icon && (
        <Icon name={icon} size={14} className="pointer-events-none absolute left-2.5 text-subtle" />
      )}
      <input
        ref={ref}
        className={cn(
          'w-full min-w-0 rounded-control border border-border bg-surface text-fg',
          'placeholder:text-subtle',
          'transition-colors hover:border-strong',
          SIZES[size] || SIZES.md,
          icon ? 'pl-8' : 'pl-2.5',
          showClear ? 'pr-8' : 'pr-2.5',
          className,
        )}
        {...rest}
      />
      {showClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear"
          className="absolute right-1.5 grid h-5 w-5 place-items-center rounded-sm text-subtle transition-colors hover:bg-sunken hover:text-fg"
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
});

export default Input;
