import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Dialog from '@/components/ui/Dialog';
import Icon from '@/components/ui/Icon';
import cn from '@/lib/cn';
import { SeverityBadge, categoryMeta } from './AlertPrimitives';

/**
 * Rule templates, and the recommended starter set.
 *
 * The safety property this dialog exists to preserve: **nothing it creates can
 * email anyone.** Recommended rules are created disabled and with no
 * recipients, so enabling each one and choosing who hears about it are two
 * separate, deliberate acts. A product that starts paging people because
 * somebody clicked "apply recommended" has spent trust it had not earned.
 *
 * Unsupported templates are shown greyed WITH THE REASON rather than hidden.
 * "Actmon cannot do cost baselines" and "this account has two days of billing
 * history" are very different messages, and hiding the card sends the first.
 */
export default function TemplatePicker({
  open, onClose, data, loading, onUse, onApplyRecommended, applying, result,
}) {
  const [selected, setSelected] = useState(() => new Set());

  const templates = data?.templates || [];
  const recommended = new Set(data?.recommended || []);

  const eligible = templates.filter(
    (t) => recommended.has(t.key) && t.support?.supported !== false
      && !t.needs_input?.length,
  );

  const toggle = (key) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Start from a template"
      icon="bookmark"
      width={720}
      footer={(
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-meta leading-snug text-muted">
            {selected.size > 0
              ? `${selected.size} selected — created disabled, notifying nobody.`
              : `${eligible.length} recommended rule${eligible.length === 1 ? '' : 's'} can be added for this account.`}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose}>Close</Button>
            <Button
              variant="primary"
              icon="plus"
              loading={applying}
              disabled={!eligible.length}
              onClick={() => onApplyRecommended?.(
                selected.size ? [...selected] : undefined,
              )}
            >
              {selected.size
                ? `Add ${selected.size} rule${selected.size === 1 ? '' : 's'}`
                : 'Add recommended set'}
            </Button>
          </div>
        </div>
      )}
    >
      <p className="mb-3 flex gap-2 rounded-control border border-border bg-sunken px-3 py-2 text-meta leading-snug text-muted">
        <Icon name="info" size={13} className="mt-0.5 shrink-0 text-subtle" />
        <span>
          Templates only pre-fill the builder. Rules added from here are created
          <strong className="text-fg"> disabled and with no recipients</strong>,
          so nothing can email anyone until you enable each one and choose who
          receives it.
        </span>
      </p>

      {result && (
        <div className="mb-3 rounded-control border border-border p-3">
          <p className="text-[12px] font-semibold text-fg">
            {result.created?.length || 0} rule
            {(result.created?.length || 0) === 1 ? '' : 's'} created, disabled.
          </p>
          {!!result.skipped?.length && (
            <ul className="mt-1.5 space-y-0.5">
              {result.skipped.map((s) => (
                <li key={s.key} className="text-meta leading-snug text-muted">
                  <span className="font-medium text-fg">{s.label || s.key}:</span>{' '}
                  {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-control bg-sunken" />
          ))}
        </div>
      ) : (
        <ul className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
          {templates.map((t) => {
            const unsupported = t.support?.supported === false;
            const isRecommended = recommended.has(t.key);
            const picked = selected.has(t.key);
            const meta = categoryMeta(t.category);
            return (
              <li
                key={t.key}
                className={cn(
                  'rounded-control border p-3 transition-colors',
                  picked ? 'border-accent bg-accent-soft' : 'border-border',
                  unsupported && 'opacity-70',
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Icon name={meta.icon} size={13} className="shrink-0 text-subtle" />
                      <span className="text-[13px] font-semibold text-fg">{t.label}</span>
                      <SeverityBadge severity={t.severity} />
                      {isRecommended && <Badge tone="accent" size="sm">Recommended</Badge>}
                      {unsupported && <Badge tone="warning" size="sm">Unavailable</Badge>}
                      {!!t.needs_input?.length && !unsupported && (
                        <Badge tone="neutral" size="sm">Needs your input</Badge>
                      )}
                    </span>
                    <p className="mt-0.5 text-[12px] leading-snug text-muted">
                      {t.rationale}
                    </p>
                    <p className="mt-1 text-meta leading-snug text-subtle">
                      {t.preview_sentence}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {isRecommended && !unsupported && !t.needs_input?.length && (
                      <Button
                        size="sm"
                        variant={picked ? 'subtle' : 'ghost'}
                        icon={picked ? 'check' : 'plus'}
                        onClick={() => toggle(t.key)}
                      >
                        {picked ? 'Selected' : 'Select'}
                      </Button>
                    )}
                    {!unsupported && (
                      <Button size="sm" variant="secondary"
                              onClick={() => onUse?.(t)}>
                        Use
                      </Button>
                    )}
                  </div>
                </div>

                {unsupported && t.support?.reason && (
                  <p className="mt-2 flex gap-1.5 rounded border border-warning bg-warning-soft px-2 py-1.5 text-meta leading-snug text-fg">
                    <Icon name="info" size={12} className="mt-0.5 shrink-0 text-warning-fg" />
                    {t.support.reason}
                  </p>
                )}
                {!unsupported && !!t.needs_input?.length && (
                  <p className="mt-2 text-meta leading-snug text-subtle">
                    Opens in the builder so you can supply{' '}
                    {t.needs_input.join(' and ')}.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
