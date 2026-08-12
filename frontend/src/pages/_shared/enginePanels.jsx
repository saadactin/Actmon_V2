import cn from '@/lib/cn';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import Tooltip from '@/components/ui/Tooltip';
import { bandFor } from '@/components/charts/status';

/**
 * The panel furniture every engine dashboard is built from.
 *
 * Each dashboard used to carry its own copy of Panel / Row / MetricKpi /
 * StatusBadge / ChartCard, drawn in raw palette classes — so the same "titled box
 * with label:value rows" existed five times over, in five slightly different
 * paddings and greys. These are the one set, token-only, so they follow the
 * theme, the radius and the density settings like everything else.
 *
 * Nothing here holds state or fetches: they are shapes, so a page can use them in
 * any tab branch without worrying about hook order.
 */

/* ── containers ───────────────────────────────────────────────────────────── */

/** Titled box. `title` is optional — a Panel with none is just a bordered card. */
export function Panel({ title, icon, subtitle, actions, footer, className, bodyClassName, children }) {
  return (
    <section className={cn('card flex flex-col', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-card py-2.5">
          {title && (
            <div className="min-w-0 flex-1">
              <h3 className="flex items-center gap-2 text-[13px] font-bold text-fg">
                {icon && <Icon name={icon} size={14} className="shrink-0 text-subtle" />}
                <span className="truncate-safe">{title}</span>
              </h3>
              {subtitle && <p className="truncate-safe mt-0.5 text-[11px] text-subtle">{subtitle}</p>}
            </div>
          )}
          {actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cn('flex-1 px-card py-card', bodyClassName)}>{children}</div>
      {footer && <div className="border-t border-border px-card py-2.5">{footer}</div>}
    </section>
  );
}

/**
 * A Panel whose body is a table — the table draws its own edge-to-edge rows, so
 * the body padding has to come off or every row is inset from the header.
 */
export function TablePanel({ children, ...rest }) {
  return <Panel {...rest} bodyClassName="p-0" className={cn('overflow-hidden', rest.className)}>{children}</Panel>;
}

/* ── label / value ────────────────────────────────────────────────────────── */

/**
 * One fact. `mono` for identifiers (versions, paths, hostnames) — those get
 * compared character by character, which a proportional face makes harder.
 */
export function DefRow({ label, value, mono, hint, tone }) {
  const TONES = { good: 'text-success-fg', warn: 'text-warning-fg', bad: 'text-danger-fg' };
  const shown = value === null || value === undefined || value === '' ? null : value;
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-0">
      <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted">
        {label}
        {hint && (
          <abbr title={hint} className="cursor-help no-underline">
            <Icon name="info" size={10} className="text-subtle" />
          </abbr>
        )}
      </span>
      <span
        className={cn(
          'truncate-safe min-w-0 text-right text-[12px] font-semibold',
          mono && 'font-mono',
          TONES[tone] || 'text-fg',
        )}
      >
        {shown ?? <span className="text-subtle">—</span>}
      </span>
    </div>
  );
}

/** Two-column grid of DefRows. Odd counts leave the last cell spanning. */
export function DefGrid({ rows, columns = 2, className }) {
  return (
    <div
      className={cn('grid gap-x-gutter', className)}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {rows.filter(Boolean).map((r) => <DefRow key={r.label} {...r} />)}
    </div>
  );
}

/* ── figures ──────────────────────────────────────────────────────────────── */

const TILE_TONES = {
  neutral: 'text-fg',
  good: 'text-success-fg',
  warn: 'text-warning-fg',
  bad: 'text-danger-fg',
  accent: 'text-accent-text',
};

/**
 * A small metric. `tone` carries meaning, so it is the caller's judgement rather
 * than a colour picked to look busy — a tile with nothing to say stays neutral.
 */
export function MetricTile({ label, value, sub, tone = 'neutral', icon, hint, onClick }) {
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={hint}
      className={cn(
        'card group px-card py-3 text-left',
        onClick && 'transition-colors hover:border-strong hover:bg-raised',
      )}
    >
      <span className="flex items-center gap-1.5">
        {icon && <Icon name={icon} size={12} className="shrink-0 text-subtle" />}
        <span className="truncate text-[10px] font-bold tracking-wide text-subtle uppercase">{label}</span>
        {onClick && (
          <Icon
            name="chevron-right"
            size={12}
            className="ml-auto shrink-0 text-subtle transition-colors group-hover:text-accent-text"
          />
        )}
      </span>
      <span className={cn('truncate-safe mt-1 block text-[19px] leading-tight font-bold', TILE_TONES[tone])}>
        {value ?? '—'}
      </span>
      {sub && <span className="truncate-safe mt-0.5 block text-[10px] text-subtle">{sub}</span>}
    </Wrapper>
  );
}

/** Compact figure for a grid of many — label above, value below, no card chrome. */
export function StatCell({ label, value, hint, tone = 'neutral' }) {
  return (
    <div className="rounded-card bg-sunken px-3 py-2.5">
      <p className="truncate text-[10px] font-bold tracking-wide text-subtle uppercase">{label}</p>
      <p className={cn('truncate-safe mt-0.5 text-[16px] font-bold', TILE_TONES[tone])}>{value ?? '—'}</p>
      {hint && <p className="mt-0.5 text-[10px] leading-snug text-subtle">{hint}</p>}
    </div>
  );
}

/**
 * Pass/fail chip. Always icon + text: the status steps are not all ≥3:1 against a
 * light surface, so colour alone would not carry the meaning (see tokens.css).
 */
export function StatusPill({ ok, label, hint, onClick }) {
  const Wrapper = onClick ? 'button' : 'span';
  const chip = (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold',
        ok ? 'bg-success-soft text-success-fg' : 'bg-danger-soft text-danger-fg',
        onClick && 'transition-opacity hover:opacity-85',
      )}
    >
      <Icon name={ok ? 'check' : 'alert'} size={11} />
      {label}
      {onClick && <Icon name="chevron-right" size={11} className="opacity-60" />}
    </Wrapper>
  );
  return hint ? <Tooltip label={hint} side="top">{chip}</Tooltip> : chip;
}

/**
 * Utilisation bar. The fill wears the utilisation band, not the accent — a bar
 * that means "how close to full" must not change meaning with the theme colour.
 */
export function UsageBar({ label, pct, sub, className }) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  const band = bandFor(v);
  return (
    <div className={className}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-muted">{label}</span>
        <span className="shrink-0 font-mono font-semibold text-fg tabular-nums">{v}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
        <div
          className="h-full rounded-full transition-[width] duration-[var(--dur-normal)]"
          style={{ width: `${v}%`, background: band.color }}
        />
      </div>
      {sub && <p className="mt-1 text-[10px] text-subtle">{sub}</p>}
    </div>
  );
}

/* ── severity / state chips ───────────────────────────────────────────────── */

/**
 * A raw engine state string as a chip. `tones` maps the values that carry meaning;
 * anything unmapped stays neutral rather than being guessed at.
 */
export function StateChip({ value, tones = {}, fallback = 'neutral' }) {
  if (value === null || value === undefined || value === '') return null;
  const key = String(value).toUpperCase();
  return <Badge tone={tones[key] || fallback} size="xs">{value}</Badge>;
}

/** SQL text, truncated to one line but complete in the title. */
export function SqlCell({ sql, max = 120, className }) {
  const text = String(sql || '').replace(/\s+/g, ' ').trim();
  if (!text) return <span className="text-subtle">—</span>;
  return (
    <span
      title={text.length > max ? text : undefined}
      className={cn('truncate-safe block max-w-[380px] font-mono text-[11px] text-muted', className)}
    >
      {text.slice(0, max)}
    </span>
  );
}

/** Monospace block for a statement the reader is meant to copy. */
export function SqlBlock({ sql, className }) {
  return (
    <pre
      className={cn(
        'overflow-x-auto rounded-card border border-border bg-sunken px-3 py-2',
        'font-mono text-[11px] whitespace-pre-wrap break-words text-fg',
        className,
      )}
    >
      {sql}
    </pre>
  );
}
