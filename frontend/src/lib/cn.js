import clsx from 'clsx';

/** Conditional className helper — `cn('a', cond && 'b', { c: cond })`. */
export const cn = (...args) => clsx(...args);

export default cn;
