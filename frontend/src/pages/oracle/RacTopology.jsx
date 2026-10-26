/**
 * The RAC Cluster Topology view.
 *
 * What a reader needs from this tab is the shape of the cluster: which
 * instances exist, whether each one is actually serving, how its host is
 * doing, that the nodes talk over a private interconnect, and that they share
 * one set of disks.
 *
 * Every value comes from the three endpoints the RAC tab already uses —
 * GV$INSTANCE for instance state, the per-node host collector for CPU / RAM /
 * disk / uptime, and V$ASM_DISKGROUP for shared storage. Nothing is assumed
 * from the existence of a record: a node whose host could not be read says so
 * in the place the number would have gone, because a confident "8%" where
 * nothing was measured is worse than an empty slot.
 *
 * The movement on the interconnect and the storage connectors is decoration.
 * It says "these nodes are joined and these disks are shared" — a fact about
 * the cluster's shape — and is not driven by traffic, replication or
 * throughput. It looks the same whether the cluster is busy or idle.
 */
import { useMemo } from 'react';

import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';

import { DOT_COLOR, barTone, clusterHealth, pct, toneFor } from './racTopologyUtils';
import './racTopology.css';

/* Per-node identity colours, in the order the instances are reported. They say
   "this card is node 1, that one is node 2" — they are NOT a health signal, so
   a node that is not healthy drops its identity colour for its status colour
   and the frame can never disagree with the dots inside the card. */
const NODE_ACCENTS = [
  { border: '#22C55E', tile: 'rgba(34,197,94,0.12)', icon: '#16A34A' },
  { border: '#3B82F6', tile: 'rgba(59,130,246,0.12)', icon: '#2563EB' },
  { border: '#8B5CF6', tile: 'rgba(139,92,246,0.12)', icon: '#7C3AED' },
  { border: '#F59E0B', tile: 'rgba(245,158,11,0.12)', icon: '#D97706' },
];

const HEALTH_DOT = { success: 'ok', warning: 'warn', danger: 'bad', neutral: 'unknown' };

function Dot({ tone, size = 8 }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: DOT_COLOR[tone] || DOT_COLOR.unknown }}
    />
  );
}

/* ── node card ───────────────────────────────────────────────────────────── */

/** One of the three state boxes across a node card. */
function StateBox({ label, value, tone }) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 py-2">
      <span className="flex items-center gap-1.5">
        <Dot tone={tone} />
        <span className="truncate-safe text-[12px] font-semibold text-muted">{label}</span>
      </span>
      <span className="mt-0.5 block truncate-safe text-[15px] font-black text-fg">{value}</span>
    </div>
  );
}

/** A host metric and its bar. A reading that was never taken renders an em
 *  dash over an empty rail — never a 0, which would read as "idle". */
function MetricCell({ icon, label, value }) {
  const v = pct(value);
  return (
    <div className="min-w-0 flex-1 px-3">
      <span className="flex items-center gap-1.5 text-[12px] font-semibold text-muted">
        <Icon name={icon} size={13} className="shrink-0 text-subtle" />
        {label}
      </span>
      <span
        className="mt-0.5 block text-[17px] font-black leading-tight"
        style={{ color: v == null ? 'var(--fg-subtle)' : barTone(v) }}
        title={v == null ? 'Not collected' : undefined}
      >
        {v == null ? '—' : `${v}%`}
      </span>
      <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-sunken">
        <span
          className="block h-full rounded-full transition-[width] duration-500"
          style={{ width: `${v == null ? 0 : Math.min(100, Math.max(0, v))}%`, background: barTone(v) }}
        />
      </span>
    </div>
  );
}

function NodeCard({ node, host, index, selected, onSelect }) {
  const instTone = toneFor(node.instance_status);
  const dbTone = toneFor(node.database_status);
  const reachable = host?.host_reachable;
  const osTone = reachable ? 'ok' : reachable === false ? 'bad' : 'unknown';

  const accent = NODE_ACCENTS[index % NODE_ACCENTS.length];
  const states = [instTone, dbTone, osTone];
  const borderColor = states.includes('bad') ? DOT_COLOR.bad
    : states.includes('warn') ? DOT_COLOR.warn
      : states.every((t) => t === 'unknown') ? DOT_COLOR.unknown
        : accent.border;

  return (
    <div
      className={cn(
        'min-w-0 flex-1 rounded-2xl bg-surface p-card shadow-sm transition-shadow',
        selected && 'shadow-md',
      )}
      style={{ border: `2px solid ${borderColor}` }}
    >
      <header className="flex items-start gap-3">
        <span
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl"
          style={{ background: accent.tile }}
        >
          <Icon name="server" size={20} style={{ color: accent.icon }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate-safe text-[21px] font-black leading-tight text-fg">
            {node.instance_name || `Instance ${node.instance_number ?? '?'}`}
          </span>
          <span className="block truncate-safe text-[13px] font-semibold text-muted">
            {node.host_name || 'Host unknown'}
          </span>
          <span className="block truncate-safe font-mono text-[13px] text-subtle">
            {host?.ip_address || (reachable === false ? 'Address unavailable' : 'Unknown')}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Badge tone={selected ? 'accent' : 'neutral'} size="xs">
            Node {node.instance_number ?? '?'}
          </Badge>
          {onSelect && (
            <IconButton
              icon={selected ? 'check' : 'chevron-right'}
              label={selected
                ? 'This instance is the one shown on every tab'
                : `Show ${node.instance_name || 'this instance'} on every tab`}
              size="sm"
              onClick={() => onSelect(Number(node.instance_number))}
            />
          )}
        </span>
      </header>

      <div className="mt-gutter-sm flex flex-wrap gap-2">
        <StateBox label="Instance" value={node.instance_status || 'Unknown'} tone={instTone} />
        <StateBox label="DB Status" value={node.database_status || 'Unknown'} tone={dbTone} />
        <StateBox
          label="OS Status"
          value={reachable ? 'Online' : reachable === false ? 'Unreachable' : 'Unknown'}
          tone={osTone}
        />
      </div>

      <div className="mt-gutter-sm flex flex-wrap items-start divide-x divide-border border-t border-border pt-gutter-sm">
        <MetricCell icon="cpu" label="CPU" value={host?.cpu_usage} />
        <MetricCell icon="memory" label="RAM" value={host?.ram_usage} />
        <MetricCell icon="desktop" label="Disk" value={host?.disk_usage} />
        <div className="min-w-0 flex-1 px-3">
          <span className="flex items-center gap-1.5 text-[12px] font-semibold text-muted">
            <Icon name="clock" size={13} className="shrink-0 text-subtle" />
            Uptime
          </span>
          <span className="mt-0.5 block truncate-safe text-[17px] font-black leading-tight text-fg">
            {host?.uptime || <span className="text-[13px] font-bold text-subtle">Metrics unavailable</span>}
          </span>
        </div>
      </div>

      {/* A node whose host could not be read says why, rather than leaving four
          empty slots for the reader to interpret. */}
      {host && reachable === false && (
        <p className="mt-2.5 text-[12px] leading-snug text-warning-fg">
          Host metrics unavailable
          {host.failure_reason ? ` — ${host.failure_reason}` : ''}
          {host.remedy ? `. ${host.remedy}` : ''}
        </p>
      )}
      {!host && (
        <p className="mt-2.5 text-[12px] leading-snug text-subtle">
          Host metrics unavailable — this node has not been collected yet.
        </p>
      )}
    </div>
  );
}

/* ── interconnect ────────────────────────────────────────────────────────── */

function Interconnect() {
  return (
    <div className="rac-interconnect">
      <span className="text-[13px] font-bold leading-tight text-fg">RAC Interconnect</span>

      {/* The rail is its own line. Strung out beside the pill and the end
          chips it could not fit the column, and the overflow landed on the
          cards either side. */}
      <span className="rac-interconnect-line">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-accent-softer">
          <Icon name="server" size={11} className="text-accent-text" />
        </span>
        <span className="rac-rail">
          <span className="rac-rail-dot" />
          <span className="rac-rail-dot" />
          <span className="rac-rail-dot" />
        </span>
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-accent-softer">
          <Icon name="server" size={11} className="text-accent-text" />
        </span>
      </span>

      <span className="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-accent-border bg-accent-softer px-2.5 py-1 text-[12px] font-bold text-accent-text">
        <Icon name="route" size={12} className="shrink-0" />
        Private Network
      </span>

      {/* Describes the link, not its load. "Live traffic" would read as a
          throughput claim, and nothing here measures throughput. */}
      <span className="text-[11px] leading-tight text-subtle">Cache fusion between instances</span>
    </div>
  );
}

/* ── shared storage ──────────────────────────────────────────────────────── */

function DiskGroup({ group }) {
  const used = pct(group.used_pct);
  const tone = group.severity === 'healthy' ? 'ok'
    : group.severity === 'warning' ? 'warn'
      : group.severity ? 'bad' : 'unknown';
  return (
    <div className="flex min-w-[15rem] flex-1 items-center gap-2.5 rounded-xl border border-border bg-sunken px-3 py-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-softer">
        <Icon name="database" size={16} className="text-accent-text" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate-safe text-[14px] font-black text-fg">+{group.name}</span>
          <span className="shrink-0 text-[12px] font-semibold text-muted">
            {used == null ? 'Usage unknown' : `${used}% used`}
          </span>
        </span>
        <span className="mt-1 flex items-center gap-2">
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted">
            <Dot tone={tone} size={7} />
            {group.state || 'State unknown'}
          </span>
          <span className="block h-1.5 flex-1 overflow-hidden rounded-full bg-surface">
            <span
              className="block h-full rounded-full"
              style={{ width: `${used == null ? 0 : Math.min(100, used)}%`, background: barTone(used) }}
            />
          </span>
        </span>
      </span>
    </div>
  );
}

function SharedStorage({ asm }) {
  const groups = asm?.diskgroups || [];
  const notConfigured = asm?.status === 'not_configured';
  const allHealthy = groups.length > 0 && groups.every((g) => g.severity === 'healthy');

  return (
    <div className="w-full max-w-[36rem] rounded-2xl border border-border bg-surface p-card shadow-sm">
      <header className="flex flex-wrap items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-softer">
          <Icon name="database" size={20} className="text-accent-text" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[17px] font-black leading-tight text-fg">Shared ASM Storage</span>
          {/* Wraps rather than truncates: at phone width this sentence is
              wider than the card, and an ellipsis would hide what the card is
              for. The header is a flex row with min-w-0, so a second line
              costs nothing. */}
          <span className="block text-[13px] font-semibold text-balance text-muted">
            {notConfigured ? 'This database does not use ASM' : 'ASM disk groups accessible by all instances'}
          </span>
        </span>
        {!notConfigured && groups.length > 0 && (
          <Badge tone={allHealthy ? 'success' : 'warning'} size="xs">
            {allHealthy ? 'Online' : 'Attention'}
          </Badge>
        )}
      </header>

      {notConfigured ? (
        <p className="mt-gutter-sm text-[13px] text-muted">
          V$ASM_DISKGROUP reports no disk groups. The cluster's datafiles are on shared
          storage of another kind, which Oracle does not describe here.
        </p>
      ) : groups.length === 0 ? (
        <p className="mt-gutter-sm text-[13px] text-muted">
          Data unavailable — the disk groups could not be read.
        </p>
      ) : (
        <div className="mt-gutter-sm flex flex-wrap gap-2.5">
          {groups.map((g) => <DiskGroup key={g.name} group={g} />)}
        </div>
      )}
    </div>
  );
}

/* ── legend ──────────────────────────────────────────────────────────────── */

function LegendItem({ swatch, title, body }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center">{swatch}</span>
      <span className="min-w-0">
        <span className="block truncate-safe text-[12px] font-bold text-fg">{title}</span>
        <span className="block truncate-safe text-[11px] text-subtle">{body}</span>
      </span>
    </span>
  );
}

/* ── the view ────────────────────────────────────────────────────────────── */

export default function RacTopology({
  racNodes, racHosts, asm, loading, error, lastUpdated, onRefresh,
  selectedInstance, onSelectInstance,
}) {
  const nodes = racNodes?.nodes || [];
  const hostByInstance = useMemo(() => {
    const m = new Map();
    (racHosts?.nodes || []).forEach((h) => m.set(Number(h.instance_number), h));
    return m;
  }, [racHosts]);

  // Counted from the instances themselves, so the headline can never disagree
  // with the node cards directly beneath it.
  const health = clusterHealth(nodes);

  if (loading && !nodes.length) {
    return <p className="text-[13px] text-muted">Reading cluster topology from GV$INSTANCE…</p>;
  }
  if (!nodes.length) {
    return (
      <p className="text-[13px] text-muted">
        Data unavailable — GV$INSTANCE returned no instances for this connection
        {error ? `: ${error}` : '.'}
      </p>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-bg-subtle p-card">
      {/* ── heading ── */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-softer">
            <Icon name="branch" size={19} className="text-accent-text" />
          </span>
          <h3 className="text-[20px] font-black text-fg">RAC Cluster Topology</h3>
          <Badge tone="accent" size="sm">{nodes.length} {nodes.length === 1 ? 'Node' : 'Nodes'}</Badge>
        </span>

        <span className="hidden h-8 w-px bg-border lg:block" aria-hidden="true" />

        <span className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sunken">
            <Icon name="activity" size={16} className="text-muted" />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-[13px] font-black text-fg">
              <Dot tone={HEALTH_DOT[health.tone] || 'unknown'} />
              {health.label}
            </span>
            {/* Says what was counted, so the verdict above can be checked
                against the cards rather than taken on trust. */}
            <span className="block truncate-safe text-[12px] text-subtle">
              Counted from {nodes.length} instance{nodes.length === 1 ? '' : 's'} in GV$INSTANCE
            </span>
          </span>
        </span>

        <span className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-subtle">
            {lastUpdated
              ? `Last updated: ${new Date(lastUpdated).toLocaleString()}`
              : 'Never updated'}
          </span>
          {onRefresh && (
            <IconButton icon="restart" label="Refresh topology" size="sm" onClick={onRefresh} />
          )}
        </span>
      </header>

      {/* ── nodes, joined by the interconnect ──
          A two-node cluster gets the three-column grid: node, interconnect,
          node. A cluster with more nodes than that cannot be laid out as one
          row of pairs, so it wraps instead — the cards keep their width and
          the interconnect is stated once, rather than being drawn between
          every pair and crossing the ones in between. */}
      {nodes.length === 2 ? (
        <>
          <div className="rac-grid mt-gutter">
            <NodeCard
              node={nodes[0]}
              host={hostByInstance.get(Number(nodes[0].instance_number))}
              index={0}
              selected={Number(nodes[0].instance_number) === Number(selectedInstance)}
              onSelect={onSelectInstance}
            />
            <Interconnect />
            <NodeCard
              node={nodes[1]}
              host={hostByInstance.get(Number(nodes[1].instance_number))}
              index={1}
              selected={Number(nodes[1].instance_number) === Number(selectedInstance)}
              onSelect={onSelectInstance}
            />
          </div>

          {/* The connectors have a grid row to themselves, on the same
              template — so each drop lands exactly under its node's centre at
              any width, and no line can cross a card because there is no card
              in this row to cross. */}
          <div className="rac-grid rac-connectors" aria-hidden="true">
            <span className="rac-conn rac-conn--left" />
            <span className="rac-conn rac-conn--mid" />
            <span className="rac-conn rac-conn--right" />
          </div>
        </>
      ) : (
        <div className="mt-gutter flex flex-wrap gap-gutter-sm">
          {nodes.map((n, i) => (
            <div key={n.instance_number ?? i} className="flex min-w-[20rem] flex-1 basis-[28rem]">
              <NodeCard
                node={n}
                host={hostByInstance.get(Number(n.instance_number))}
                index={i}
                selected={Number(n.instance_number) === Number(selectedInstance)}
                onSelect={onSelectInstance}
              />
            </div>
          ))}
        </div>
      )}

      {/* ── shared storage, reached by every node ──
          With two nodes the connector row above supplies the gap and the
          dashed line meets the card's top edge, so no margin is wanted. The
          wrapped layout draws no connectors, so it needs one. */}
      <div className={cn('flex justify-center', nodes.length !== 2 && 'mt-gutter')}>
        <SharedStorage asm={asm} />
      </div>

      {/* ── legend ── */}
      <div className="mt-gutter flex flex-wrap items-center gap-x-gutter gap-y-2.5 rounded-2xl border border-border bg-surface px-card py-2.5">
        <span className="text-[12px] font-bold text-muted">Legend:</span>
        <LegendItem
          swatch={(
            <span className="grid h-7 w-7 place-items-center rounded-lg" style={{ background: NODE_ACCENTS[0].tile }}>
              <Icon name="server" size={14} style={{ color: NODE_ACCENTS[0].icon }} />
            </span>
          )}
          title="RAC Node"
          body="Oracle instance running on host"
        />
        <LegendItem
          swatch={(
            <span className="flex w-7 items-center gap-0.5">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              <span className="h-px flex-1 bg-accent-border" />
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
          )}
          title="RAC Interconnect"
          body="Private network between nodes"
        />
        <LegendItem
          swatch={(
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent-softer">
              <Icon name="database" size={14} className="text-accent-text" />
            </span>
          )}
          title="Shared Storage"
          body="ASM disk groups mounted by all nodes"
        />
        <span className="ml-auto flex flex-wrap items-center gap-3 text-[12px] text-muted">
          <span className="font-bold text-fg">Status indicators:</span>
          <span className="flex items-center gap-1.5"><Dot tone="ok" />Online / Healthy</span>
          <span className="flex items-center gap-1.5"><Dot tone="warn" />Warning</span>
          <span className="flex items-center gap-1.5"><Dot tone="bad" />Critical</span>
          <span className="flex items-center gap-1.5"><Dot tone="unknown" />Unknown</span>
        </span>
      </div>
    </div>
  );
}
