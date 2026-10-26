import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Input from '@/components/ui/Input';
import { getAgentRemovalPlan, removeAgent } from '@/api/agents';
import { QK } from '@/api/queryKeys';

const TABLE_LABEL = {
  agent_metrics: 'metric samples', agent_sessions: 'session samples', agent_top_sql: 'top-SQL samples',
  agent_wait_events: 'wait-event samples', agent_notifications: 'notifications', agent_oracle_snapshots: 'Oracle snapshots',
  agent_snapshots: 'snapshots', agent_stable_facts: 'stored facts', agent_stable_changes: 'change records', agent_pending_update: 'update records',
};

/**
 * Agents → Remove. Shows the server's dry-run of exactly what will be deleted, and requires typing the agent's
 * name before the destructive button unlocks. Needs the 'delete' permission on /agents (enforced server-side too).
 */
export default function RemoveAgentDialog({ agent, onClose }) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const planQ = useQuery({ queryKey: ['agentRemovalPlan', agent.id], queryFn: () => getAgentRemovalPlan(agent.id), retry: false });
  const del = useMutation({
    mutationFn: () => removeAgent(agent.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.agents });
      qc.invalidateQueries({ queryKey: QK.osServers() });
      onClose();
    },
  });
  const p = planQ.data;
  const dataRows = p ? Object.entries(p.data_rows || {}) : [];

  return (
    <ConfirmDialog
      open
      title={`Remove agent “${agent.name}”?`}
      tone="danger"
      icon="trash"
      confirmLabel="Remove agent"
      cancelLabel="Cancel"
      loading={del.isPending}
      confirmDisabled={!p || typed.trim() !== agent.name}
      onConfirm={() => del.mutate()}
      onCancel={onClose}
    >
      {planQ.isLoading ? <p className="text-[13px] text-muted">Checking what will be removed…</p>
        : planQ.isError ? <p className="text-[13px] text-danger-fg">{planQ.error?.message || 'Could not load the removal details.'}</p>
          : (
            <div className="space-y-3 text-[13px] leading-relaxed">
              <p className="text-muted">This will remove:</p>
              <ul className="list-disc space-y-1 pl-5 text-fg">
                <li>The agent <b>{p.agent_name}</b> ({p.kind === 'host' ? 'host agent' : `${p.db_type} database agent`}) from the Agents page.</li>
                {p.host && <li>The host <b>{p.host.name}</b>{p.host.ip ? ` (${p.host.ip})` : ''} from Infrastructure.</li>}
                {p.kind === 'host' && <li>{p.tokens ? <>Its enrollment token — <b>revoked</b>, so the installed agent's pushes are rejected and it cannot re-register.</> : 'No enrollment token is bound to it.'}</li>}
                {p.db_targets?.length > 0 && <li>{p.db_targets.length} database{p.db_targets.length === 1 ? '' : 's'} it collected: {p.db_targets.map((t) => `${t.name || t.db_type}`).join(', ')}.</li>}
                {p.connection && <li>The database connection <b>{p.connection.name}</b> ({p.connection.db_type}) — otherwise “Sync” would add this agent back.</li>}
                {dataRows.length > 0 && <li>Stored working data: {dataRows.map(([t, n]) => `${n.toLocaleString()} ${TABLE_LABEL[t] || t}`).join(', ')}.</li>}
              </ul>
              <p className="text-muted">Long-term history in ClickHouse is not deleted; it expires on its normal retention. {p.kind === 'host' && 'Uninstall the agent from the machine as well — it will keep running there until you do, but its data will be refused.'}</p>
              <label className="block">
                <span className="text-muted">Type <b className="text-fg">{agent.name}</b> to confirm</span>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type the agent name to confirm" autoFocus />
              </label>
              {del.isError && <p className="text-danger-fg">{del.error?.message || 'Removal failed.'}</p>}
            </div>
          )}
    </ConfirmDialog>
  );
}
