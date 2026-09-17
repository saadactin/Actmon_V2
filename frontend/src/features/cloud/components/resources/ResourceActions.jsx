import { useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import { InlineLoading } from '@/components/ui/Loading';
import cn from '@/lib/cn';
import { useActionPreview, useAvailableActions } from '../../hooks/useResources';
import { relativeTime } from '../../utils/resourceModel';

/**
 * What can be done to this resource, and what would happen if you did.
 *
 * Nothing here executes anything. No provider adapter in this platform
 * implements a write, so every mutating action is reported as unsupported with
 * the reason — which is the point: an action offered as a live button that then
 * fails, or worse appears to succeed, is the failure mode this design exists to
 * avoid.
 *
 * What IS real is the preview. Selecting an action asks the backend to check
 * the caller's permission, the provider's support, the resource's current state
 * and the topology graph's account of what depends on it. Those answers are
 * true today, and they are exactly what a confirmation dialog will need on the
 * day an adapter gains a write call.
 */

const GATES = [
  ['supported', 'Provider support', 'support'],
  ['authorized', 'Your permission', 'authorization'],
  ['state_valid', 'Resource state', 'state'],
];

export default function ResourceActions({ resource }) {
  const [selected, setSelected] = useState(null);
  const { data, isLoading } = useAvailableActions(resource?.provider);
  const preview = useActionPreview(resource?.id, selected, !!selected);

  if (isLoading) return <InlineLoading label="Checking what this provider supports…" className="py-8" />;

  const actions = data?.actions || [];
  const anySupported = actions.some((a) => a.supported);

  return (
    <section className="space-y-3">
      {!anySupported && (
        <div className="flex items-start gap-2 rounded-control border border-border bg-sunken px-3 py-2.5">
          <Icon name="info" size={14} className="mt-0.5 shrink-0 text-info-fg" />
          <p className="text-[11px] leading-snug text-muted">
            This platform reads from
            {` ${resource.provider}`}
            {' '}
            and does not write to it. Every action below is shown with the reason
            it is unavailable rather than hidden, so the limitation is visible
            instead of looking like a missing feature.
          </p>
        </div>
      )}

      <div className="space-y-1">
        {actions.map((action) => {
          const isOpen = selected === action.action;
          return (
            <div key={action.action} className="rounded-control border border-border">
              <button
                type="button"
                onClick={() => setSelected(isOpen ? null : action.action)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-sunken"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[12px] font-semibold text-fg">{action.label}</span>
                    {action.destructive && (
                      <Badge tone="danger" size="xs">Destructive</Badge>
                    )}
                    {action.supported
                      ? <Badge tone="success" size="xs">Supported</Badge>
                      : <Badge tone="neutral" size="xs">Unavailable</Badge>}
                  </span>
                  {!action.supported && action.reason && (
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                      {action.reason}
                    </span>
                  )}
                </span>
                <Icon
                  name={isOpen ? 'chevron-down' : 'chevron-right'}
                  size={13}
                  className="shrink-0 text-subtle"
                />
              </button>

              {isOpen && (
                <div className="border-t border-border px-3 py-2.5">
                  {preview.isLoading ? (
                    <InlineLoading label="Checking…" className="py-3" />
                  ) : preview.isError ? (
                    <p className="text-[11px] text-danger">
                      {preview.error?.response?.data?.detail?.error?.message
                        || 'This action could not be evaluated.'}
                    </p>
                  ) : preview.data ? (
                    <div className="space-y-2">
                      {GATES.map(([key, label, reasonKey]) => {
                        const pass = preview.data[key];
                        return (
                          <div key={key} className="flex items-start gap-2 text-[11px]">
                            <Icon
                              name={pass ? 'check' : 'close'}
                              size={12}
                              className={cn('mt-0.5 shrink-0', pass ? 'text-success-fg' : 'text-danger')}
                            />
                            <span className="min-w-0 flex-1">
                              <span className={pass ? 'text-muted' : 'text-fg'}>{label}</span>
                              {!pass && preview.data.reasons?.[reasonKey] && (
                                <span className="block leading-snug text-muted">
                                  {preview.data.reasons[reasonKey]}
                                </span>
                              )}
                            </span>
                          </div>
                        );
                      })}

                      {/* Dependencies are shown for destructive actions even
                          when there are none, because "the graph checked and
                          found none" and "the graph could not be asked" are
                          different answers and only one is reassuring. */}
                      {preview.data.destructive && (
                        <div className="rounded-control bg-sunken px-2.5 py-2">
                          <p className="text-[11px] font-semibold text-fg">
                            {preview.data.dependencies.length > 0
                              ? `${preview.data.dependencies.length} resource(s) depend on this`
                              : 'Dependencies'}
                          </p>
                          {preview.data.dependency_note && (
                            <p className="mt-0.5 text-[11px] leading-snug text-muted">
                              {preview.data.dependency_note}
                            </p>
                          )}
                          {preview.data.dependencies.slice(0, 6).map((dep) => (
                            <p key={dep.id} className="mt-0.5 truncate text-[11px] text-muted">
                              {`${dep.name || dep.id} · ${dep.type || 'resource'} (${dep.relation})`}
                            </p>
                          ))}
                        </div>
                      )}

                      {preview.data.warnings?.map((warning) => (
                        <p key={warning} className="flex items-start gap-1.5 text-[11px] text-warning-fg">
                          <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                          {warning}
                        </p>
                      ))}

                      <div className="flex items-center justify-between border-t border-border pt-2">
                        <span className="text-[11px] text-muted">
                          {preview.data.safe
                            ? 'All checks passed.'
                            : 'Blocked by at least one check.'}
                        </span>
                        <Button
                          variant={preview.data.destructive ? 'danger' : 'primary'}
                          size="sm"
                          disabled
                          title={
                            preview.data.reasons?.support
                            || 'This action cannot be executed yet.'
                          }
                        >
                          {preview.data.label}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
