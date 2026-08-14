import { CloudProviderSelector } from './CloudProviderSelector';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';

/**
 * Recurring "provider/account scope selector + primary action(s)" row, meant
 * to be passed into CloudPageHeader's `actions` slot. Centralizes a pattern
 * every Cloud page used to hand-roll (its own CloudProviderSelector + its own
 * button markup) into one place.
 *
 *   selectorProps  props forwarded to CloudProviderSelector, omit to hide it
 *   scopeLabel     when set, renders a small dismissible "<label> only" chip
 *                  (e.g. the active provider scope) before the children
 */
export default function CloudToolbar({ selectorProps, scopeLabel, onClearScope, children }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {scopeLabel && (
        <button
          type="button"
          onClick={onClearScope}
          title="Showing one provider — click to view all providers"
          className="group"
        >
          <Badge tone="accent" className="gap-1.5">
            <Icon name="filter" size={11} />
            {scopeLabel} only
            <Icon name="close" size={11} className="opacity-70 group-hover:opacity-100" />
          </Badge>
        </button>
      )}
      {selectorProps && <CloudProviderSelector {...selectorProps} />}
      {children}
    </div>
  );
}
