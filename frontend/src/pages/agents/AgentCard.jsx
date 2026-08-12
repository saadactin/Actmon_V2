import cn from '@/lib/cn';
import Icon from '@/components/ui/Icon';
import Badge from '@/components/ui/Badge';
import Meter from '@/components/charts/Meter';
import { agentState, clusterBadge, engineColor, engineOf, statusLevel, LEVEL_COLORS } from '@/config/agents';
import { ago, num } from '@/lib/format';

/**
 * One agent, in grid view.
 *
 * Every colour comes from config/agents.js (engine slot, state tone, level
 * accent) — nothing here knows a hex. The left accent rule carries the coarse
 * level; the badge carries the precise state with an icon and label, so colour is
 * never the only signal.
 */
export default function AgentCard({ agent, onOpen }) {
  const state = agentState(agent);
  const engine = engineOf(agent.db_type);
  const cluster = clusterBadge(agent);
  const level = statusLevel(agent.status);

  const cpu = Number(agent.agent_host_cpu) || 0;
  const memory = Number(agent.agent_host_memory) || 0;

  return (
    <button
      type="button"
      onClick={() => onOpen(agent)}
      title={state.tip}
      className={cn(
        'card group relative flex flex-col gap-3 overflow-hidden p-card text-left',
        'transition-colors hover:border-strong hover:bg-raised',
      )}
    >
      {/* level accent */}
      <span
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: LEVEL_COLORS[level] }}
        aria-hidden="true"
      />

      {/* ── header ── */}
      <div className="flex items-start gap-2.5">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md"
          style={{
            background: `color-mix(in srgb, ${engineColor(agent.db_type)} 14%, transparent)`,
            color: engineColor(agent.db_type),
          }}
        >
          <Icon name="database" size={17} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="truncate-safe text-[13px] font-bold text-fg group-hover:text-accent-text">
            {agent.name}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-subtle">
            <Icon name="globe" size={11} className="shrink-0" />
            <span className="truncate-safe">{agent.hostname || agent.ip_address || '—'}</span>
          </div>
        </div>

        <Badge tone={state.tone} size="xs" className="shrink-0">
          <Icon name={state.icon} size={9} strokeWidth={3} />
          {state.label}
        </Badge>
      </div>

      {/* ── engine · env · role ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-bold"
          style={{
            background: `color-mix(in srgb, ${engineColor(agent.db_type)} 14%, transparent)`,
            color: engineColor(agent.db_type),
          }}
        >
          {engine.label}
        </span>
        <Badge tone="neutral" size="xs">{agent.environment || '—'}</Badge>
        <Badge tone={cluster.tone} size="xs">{cluster.label}</Badge>
        {agent.agent_version && (
          <span className="text-[10px] text-subtle">v{agent.agent_version}</span>
        )}
      </div>

      {/* ── host utilisation ── */}
      <div className="grid grid-cols-2 gap-3">
        <Meter label="Host CPU" value={cpu} hint="" />
        <Meter label="Host memory" value={memory} hint="" />
      </div>

      {/* ── footer ── */}
      <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5 text-[11px]">
        <span className="flex items-center gap-1 text-subtle">
          <Icon name="users" size={11} />
          {num(agent.active_sessions)} sessions
        </span>
        <span className="flex items-center gap-1 text-subtle">
          <Icon name="history" size={11} />
          {ago(agent.last_heartbeat) === '—' ? 'Never' : ago(agent.last_heartbeat)}
        </span>
      </div>
    </button>
  );
}
