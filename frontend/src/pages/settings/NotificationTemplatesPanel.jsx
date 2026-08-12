import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Icon from '@/components/ui/Icon';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import { listTemplates } from '@/api/notifications';
import { CHANNEL_DEFS, CHANNEL_ORDER } from '@/config/notificationChannels';
import NotificationTemplateWizard from './NotificationTemplateWizard';

/**
 * One card per channel — its effective subject (custom override, or the
 * built-in default) at a glance, and an "Edit Template" button that opens
 * the 3-step wizard. Templates are optional: a channel with no override
 * still sends fine using template_service.py's default.
 */
export default function NotificationTemplatesPanel() {
  const [editing, setEditing] = useState(null); // channel_type currently open in the wizard

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['notification-templates'],
    queryFn: () => listTemplates(),
  });

  const byType = Object.fromEntries(templates.map((t) => [t.channel_type, t]));

  return (
    <div className="space-y-gutter">
      <div className="flex items-start gap-2">
        <Icon name="type" size={16} className="mt-0.5 text-subtle" />
        <div>
          <h2 className="text-[13px] font-bold text-fg">Notification Templates</h2>
          <p className="text-[12px] text-muted">
            What each channel's message looks like — subject and body, built from the same 14 alert variables.
            Every channel works out of the box with a sensible default; edit one only if you want it to look different.
          </p>
        </div>
      </div>

      {isLoading ? (
        <p className="text-[12px] text-subtle">Loading…</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CHANNEL_ORDER.map((ct) => {
            const def = CHANNEL_DEFS[ct];
            const tpl = byType[ct];
            return (
              <div key={ct} className="card flex flex-col gap-3 p-card">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon name={def.icon} size={15} className="shrink-0 text-subtle" />
                    <span className="truncate-safe text-[13px] font-bold text-fg">{def.label}</span>
                  </div>
                  <Badge tone={tpl?.is_override ? 'accent' : 'neutral'} size="xs">
                    {tpl?.is_override ? 'Custom' : 'Default'}
                  </Badge>
                </div>

                <div className="min-w-0 rounded-control bg-sunken px-2.5 py-2">
                  <p className="text-[10px] font-bold tracking-wide text-subtle uppercase">Subject</p>
                  <p className="truncate-safe mt-0.5 text-[12px] font-medium text-fg">{tpl?.subject_template || '—'}</p>
                </div>

                <Button variant="secondary" size="sm" icon="file-edit" onClick={() => setEditing(ct)} className="mt-auto self-start">
                  Edit Template
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <NotificationTemplateWizard
          channelType={editing}
          initial={byType[editing]}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
