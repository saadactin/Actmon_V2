import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import cn from '@/lib/cn';
import { SEVERITY_META, buildAttentionItems } from '../../utils/attentionModel';
import { Panel } from './OverviewPrimitives';

/**
 * What actually needs a human, ordered by how much.
 *
 * The logic that DECIDES what needs attention lives in
 * `utils/attentionModel.js` so it can be tested without a DOM - it is the
 * half where a double-count or a missed condition looks like an ordinary row.
 * This file only renders the result.
 *
 * The empty state is careful. "Nothing needs attention" is only honest if the
 * underlying systems actually ran; when posture is unavailable the panel says
 * that instead, because an unevaluated account is not a clean one.
 */

// Re-exported so the Overview page keeps its existing import from here.
export { buildAttentionItems };


export default function AttentionCenter({
  items, isLoading, evaluated, onAction,
}) {
  return (
    <Panel
      title="Needs Attention"
      icon="alert"
      loading={isLoading}
      dense
    >
      {items.length === 0 ? (
        <p className="rounded-control border border-dashed border-border px-3 py-5 text-center text-[12px]">
          {evaluated ? (
            <>
              <Icon name="check" size={14} className="mr-1 inline text-success-fg" />
              <span className="text-muted">
                Nothing in this account currently requires attention.
              </span>
            </>
          ) : (
            <span className="text-muted">
              Not enough of this account has been evaluated to say whether
              anything needs attention.
            </span>
          )}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => {
            const meta = SEVERITY_META[item.severity] || SEVERITY_META.INFO;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onAction(item)}
                  className="flex w-full items-center gap-3 px-1 py-2 text-left hover:bg-sunken"
                >
                  <Icon
                    name={meta.icon}
                    size={15}
                    className={cn(
                      'shrink-0',
                      meta.tone === 'danger' ? 'text-danger'
                        : meta.tone === 'warning' ? 'text-warning-fg' : 'text-info-fg',
                    )}
                  />
                  {/* Colour is never the only carrier — the severity is
                      spelled out beside it. */}
                  <Badge tone={meta.tone} size="xs" className="shrink-0 uppercase">
                    {meta.label}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
                    {item.message}
                  </span>
                  <span className="shrink-0 text-[11px] font-semibold text-accent-text">
                    {item.actionLabel}
                    <Icon name="arrow-right" size={11} className="ml-1 inline" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
