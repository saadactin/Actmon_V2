import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Notice from '@/components/ui/Notice';
import Switch from '@/components/ui/Switch';
import { Panel } from '@/pages/_shared/enginePanels';
import { API, QueryState, SeverityBadge, TypeBadge, fmtWhen } from './shared';

export default function AlertsTab({ databaseKey }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['awrAlerts'], queryFn: () => client.get(`${API}/alerts`).then((r) => r.data), retry: false });
  const toggle = useMutation({
    mutationFn: (enabled) => client.post(`${API}/alerts/rule`, { enabled }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['awrAlerts'] }),
  });
  return (
    <QueryState q={q}>
      {(d) => {
        const mine = d.alerts.filter((a) => a.database_key === databaseKey);
        return (
          <div className="flex flex-col gap-gutter">
            <Panel title="Show AWR risks on the Alerts page" icon="alert"
                   subtitle="Uses the existing alert engine — no second alert system"
                   actions={<Switch checked={d.rule.enabled} onChange={(v) => toggle.mutate(v)} disabled={toggle.isPending} label="Oracle AWR Risk rule" />}>
              <p className="text-meta text-fg">
                When the <b>Oracle AWR Risk</b> rule is on, open high/medium findings from each database's latest uploaded report appear in
                {' '}<Link to="/alerts" className="font-semibold text-accent-text hover:underline">Alerts → Active</Link>, labelled with their snapshot window.
                The rule is also listed (and can be switched) under the alert rules.
              </p>
              <Notice tone="info" className="mt-3 mb-0">{d.note} Status changes (acknowledge / resolve) on a finding remove it from the feed.</Notice>
              <p className="mt-2 text-micro text-subtle">Rule {d.rule.exists ? `#${d.rule.id}` : 'not created yet'} · currently {d.rule.enabled ? 'enabled' : 'disabled'}</p>
            </Panel>
            <Panel title="Open AWR risks for this database" icon="report" subtitle={`${mine.length} item(s) — what the Alerts page shows when the rule is on`}>
              {!mine.length ? <p className="py-3 text-center text-meta text-muted">No open high/medium findings.</p> : (
                <ul className="flex flex-col gap-2">
                  {mine.map((a) => (
                    <li key={a.finding_id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2">
                      <SeverityBadge severity={a.severity} /><TypeBadge type={a.finding_type} />
                      <span className="min-w-0 flex-1 text-meta text-fg">{a.title}</span>
                      <Badge tone="outline" size="xs">snapshot to {fmtWhen(a.snapshot_end)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3"><Link to="/alerts"><Button size="sm" variant="secondary">Open the Alerts page</Button></Link></div>
            </Panel>
          </div>
        );
      }}
    </QueryState>
  );
}
