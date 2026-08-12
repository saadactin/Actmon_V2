import { forwardRef } from 'react';
import cn from '@/lib/cn';

/** Multi-line text input — same shape as Input.jsx, for description/notes fields. */
const Textarea = forwardRef(function Textarea(
  { rows = 3, className, wrapperClassName, ...rest },
  ref,
) {
  return (
    <div className={cn('flex min-w-0 flex-col', wrapperClassName)}>
      <textarea
        ref={ref}
        rows={rows}
        className={cn(
          'w-full min-w-0 resize-y rounded-control border border-border bg-surface px-2.5 py-2 text-[13px] text-fg',
          'placeholder:text-subtle',
          'transition-colors hover:border-strong',
          className,
        )}
        {...rest}
      />
    </div>
  );
});

export default Textarea;
