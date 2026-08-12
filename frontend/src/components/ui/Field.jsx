import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import BaseSwitch from './Switch';
import BaseSelect from './Select';

// Re-exported so existing callers keep one import site, but there is only one
// implementation of each control.
export const Switch = BaseSwitch;
export const Select = (props) => <BaseSelect size="sm" {...props} />;

/* ══════════════════════════════════════════════════════════════════════════
   Form building blocks used by the appearance panel and settings pages.
   All token-driven, so they restyle with the theme like everything else.
   ══════════════════════════════════════════════════════════════════════════ */

/** Labelled row wrapper. */
export function Field({ label, hint, children, className, inline = false }) {
  return (
    <div className={cn(inline ? 'flex items-center justify-between gap-3' : 'space-y-1.5', className)}>
      <div className={inline ? 'min-w-0' : undefined}>
        <div className="text-[12px] font-semibold text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-snug text-subtle">{hint}</div>}
      </div>
      <div className={inline ? 'shrink-0' : undefined}>{children}</div>
    </div>
  );
}

/** Collapsible-free titled block. */
export function Section({ title, icon, children, className }) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="flex items-center gap-2">
        {icon && <Icon name={icon} size={14} className="text-subtle" />}
        <h3 className="text-[11px] font-bold tracking-[0.07em] text-subtle uppercase">{title}</h3>
        <span className="h-px flex-1 bg-border" />
      </div>
      {children}
    </section>
  );
}

/** Horizontal option picker. `options` = [{ id, label, hint }]. */
export function Segmented({ options, value, onChange, columns, size = 'md' }) {
  return (
    <div
      className={cn(
        columns ? 'grid gap-1.5' : 'inline-flex rounded-control bg-sunken p-0.5',
      )}
      style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
      role="radiogroup"
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.hint}
            onClick={() => onChange(o.id)}
            className={cn(
              'truncate rounded-control font-semibold transition-colors duration-[var(--dur-fast)]',
              size === 'sm' ? 'h-7 px-2 text-[11px]' : 'h-8 px-2.5 text-[12px]',
              columns && 'border',
              active
                ? columns
                  ? 'border-accent-border bg-accent-soft text-accent-text'
                  : 'bg-surface text-fg shadow-xs'
                : columns
                  ? 'border-border text-muted hover:border-strong hover:text-fg'
                  : 'text-muted hover:text-fg',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Numeric slider with a live value read-out. */
export function Slider({ value, onChange, min, max, step = 1, suffix = '' }) {
  return (
    <div className="flex items-center gap-2.5">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-sunken accent-[var(--accent)]"
        style={{ accentColor: 'var(--accent)' }}
      />
      <span className="w-14 shrink-0 text-right font-mono text-[11px] font-semibold text-muted">
        {value}{suffix}
      </span>
    </div>
  );
}

/** Colour swatch grid + free-form hex entry. */
export function ColorPicker({ value, onChange, presets = [], allowCustom = true }) {
  const current = String(value || '').toLowerCase();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => {
          const active = String(p.value).toLowerCase() === current;
          return (
            <button
              key={p.id}
              type="button"
              title={p.label}
              aria-label={p.label}
              aria-pressed={active}
              onClick={() => onChange(p.value)}
              className={cn(
                'grid h-7 w-7 place-items-center rounded-full transition-transform duration-[var(--dur-fast)]',
                active ? 'scale-110' : 'hover:scale-105',
              )}
              style={{
                background: p.value,
                boxShadow: active ? `0 0 0 2px var(--surface), 0 0 0 4px ${p.value}` : 'none',
              }}
            >
              {active && <Icon name="check" size={13} className="text-white drop-shadow" strokeWidth={3} />}
            </button>
          );
        })}
      </div>

      {allowCustom && (
        <div className="flex items-center gap-2">
          <label className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-full border border-border">
            <span className="absolute inset-0" style={{ background: value }} />
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#3b6ef5'}
              onChange={(e) => onChange(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
          <input
            type="text"
            value={value}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            placeholder="#3b6ef5"
            className="h-8 min-w-0 flex-1 rounded-control border border-border bg-surface px-2 font-mono text-[12px] text-fg placeholder:text-subtle"
          />
        </div>
      )}
    </div>
  );
}
