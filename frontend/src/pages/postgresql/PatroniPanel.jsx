import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GitBranch, Shield, RefreshCw, ChevronDown, Server, Activity, Clock, AlertTriangle,
  CheckCircle2, Settings, ScrollText, History, Repeat, Zap, Power, RotateCw, Play,
  Pause, Save, Info, FileText, ArrowRightLeft, LayoutGrid, Wrench, Stethoscope,
  ArrowDown, Crown,
} from 'lucide-react';
import client, { errorText } from '@/api/client';
import { usePermissions } from '@/hooks/usePermissions';
import Popover from '@/components/ui/Popover';
import Button from '@/components/ui/Button';
import Dialog from '@/components/ui/Dialog';
import CodeEditor from '@/components/ui/CodeEditor';
import { load as yamlLoad } from 'js-yaml';

/* ══════════════════════════════════════════════════════
   DATA LAYER
══════════════════════════════════════════════════════ */
const base = (connId) => `/connections/postgresql/${connId}/patroni`;
const LEADER_ROLES = ['leader', 'standby_leader', 'sync_standby_leader'];
const isLeaderRole = (role) => LEADER_ROLES.includes(role);

function usePatroniQuery(connId, path, { params, enabled = true, refetchInterval } = {}) {
  return useQuery({
    queryKey: ['patroni', connId, path, params],
    queryFn: () => client.get(`${base(connId)}${path}`, { params }).then((r) => r.data),
    enabled: enabled && !!connId,
    refetchInterval,
    retry: false,
  });
}

const HEALTH_STYLE = {
  HEALTHY: { bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500', border: 'border-emerald-200' },
  WARNING: { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500', border: 'border-amber-200' },
  DEGRADED: { bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500', border: 'border-red-200' },
  CRITICAL: { bg: 'bg-red-200', text: 'text-red-800', dot: 'bg-red-600', border: 'border-red-400' },
};
const hStyle = (h) => HEALTH_STYLE[h] || HEALTH_STYLE.WARNING;

/* ══════════════════════════════════════════════════════
   TOP-LEVEL PANEL — one console, clearly separated tabs (not one long page).
   Nav: Overview / Patroni Status / Topology / Replication / Replication Slots /
   Configuration / patroni.yml / Recovery / Logs / History. Actions stays a
   single top-right dropdown, organized into Node Actions / Recovery /
   Configuration / Diagnostics — never a flat list of every operation.
══════════════════════════════════════════════════════ */
const TABS = [
  ['overview', 'Overview', LayoutGrid],
  ['members', 'Patroni Status', Activity],
  ['topology', 'Topology', GitBranch],
  ['replication', 'Replication', ArrowDown],
  ['slots', 'Replication Slots', Server],
  ['config', 'Configuration', Settings],
  ['yaml', 'patroni.yml', FileText],
  ['recovery', 'Recovery', Wrench],
  ['logs', 'Logs', ScrollText],
  ['history', 'History', History],
];

export default function PatroniPanel({ connId }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState('overview');
  const [actionsOpen, setActionsOpen] = useState(false);
  const [pending, setPending] = useState(null); // { action, label, danger, needsTarget, targetPool }

  // Fast status: 12s, per spec's "10-15s where appropriate" — the patronictl-
  // list equivalent every other tab reads from, so there is ONE fetch of it.
  const status = usePatroniQuery(connId, '/status', { refetchInterval: 12000 });
  const s = status.data;

  const invalidateAll = () => qc.invalidateQueries({ queryKey: ['patroni', connId] });
  const goTo = (t) => { setTab(t); setActionsOpen(false); };
  const fireAction = (spec) => { setActionsOpen(false); setPending(spec); };

  if (status.isLoading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white px-5 py-8 flex items-center justify-center text-slate-400 text-[13px]">
        <RefreshCw size={14} className="animate-spin mr-2" /> Checking for Patroni…
      </div>
    );
  }

  if (!s?.patroni_detected) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-3.5 flex items-center gap-2.5 text-slate-500 text-[12px]">
        <Info size={15} className="flex-shrink-0" />
        {s?.reason || 'Patroni not detected on this connection — showing plain PostgreSQL replication data below.'}
      </div>
    );
  }

  const hs = hStyle(s.cluster_health);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-visible">
      {/* ── Header: cluster health + centralized Actions toolbar (top-right, per §29) ── */}
      <div className="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center flex-shrink-0">
            <Shield size={18} className="text-indigo-600" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-black text-slate-900">PostgreSQL Replication — Patroni</h3>
              <span className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-black ${hs.bg} ${hs.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${hs.dot} ${s.cluster_health === 'HEALTHY' ? 'animate-pulse' : ''}`} />
                {s.cluster_health}
              </span>
              {s.paused && (
                <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-black">HA PAUSED</span>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Cluster: <span className="font-mono text-slate-500">{s.scope}</span> · Leader: <span className="font-bold text-slate-600">{s.leader || '—'}</span>
              {' '}· {s.healthy_members}/{s.member_count} healthy · {s.streaming_replicas}/{s.replica_count ?? '—'} streaming
              {s.reason && <span className="text-amber-600 font-semibold"> · {s.reason}</span>}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => status.refetch()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 text-slate-500 hover:text-indigo-600 text-[12px] font-bold transition-all"
          >
            <RefreshCw size={12} className={status.isFetching ? 'animate-spin' : ''} /> Refresh
          </button>
          <div className="relative">
            <button
              onClick={() => setActionsOpen((v) => !v)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-slate-900 hover:bg-indigo-700 text-white text-[12px] font-bold transition-all shadow-sm"
            >
              Actions <ChevronDown size={13} />
            </button>
            <Popover open={actionsOpen} onClose={() => setActionsOpen(false)} align="right" width={280}>
              <ActionsMenu s={s} onNavigate={goTo} onAction={fireAction} onRefresh={() => { status.refetch(); setActionsOpen(false); }} />
            </Popover>
          </div>
        </div>
      </div>

      {/* ── Tab strip — each tab owns its OWN content, nothing dumped together ── */}
      <div className="px-5 pt-3 flex items-center gap-1 border-b border-slate-100 overflow-x-auto">
        {TABS.map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-[12px] font-bold border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === id ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      <div className="p-5">
        {tab === 'overview' && <OverviewTab s={s} onNavigate={goTo} onAction={fireAction} />}
        {tab === 'members' && <MemberTable members={s.members} unregistered={s.unregistered_members} />}
        {tab === 'topology' && <TopologyView s={s} />}
        {tab === 'replication' && <ReplicationTab s={s} />}
        {tab === 'slots' && <SlotsPanel connId={connId} />}
        {tab === 'config' && <ConfigurationTab connId={connId} onApplied={invalidateAll} />}
        {tab === 'yaml' && <YamlPanel connId={connId} members={s.members} />}
        {tab === 'recovery' && <RecoveryTab connId={connId} s={s} onAction={fireAction} />}
        {tab === 'logs' && <LogsPanel connId={connId} members={s.members} />}
        {tab === 'history' && <HistoryPanel connId={connId} />}
      </div>

      {pending && (
        <ActionDialog
          connId={connId}
          spec={pending}
          members={s.members}
          leader={s.leader}
          currentMember={s.current_member}
          onClose={() => setPending(null)}
          onDone={() => { setPending(null); invalidateAll(); }}
        />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   ACTIONS MENU (§19) — Node Actions / Recovery / Configuration / Diagnostics.
   Dangerous ops (red) visually distinguished; irrelevant ones disabled with
   a reason tooltip instead of vanishing (predictable layout).
══════════════════════════════════════════════════════ */
function MenuItem({ icon: Icon, label, onClick, danger, disabled, reason }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? reason : undefined}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] font-semibold transition-colors text-left
        ${disabled ? 'text-slate-300 cursor-not-allowed' : danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-700 hover:bg-slate-100'}`}
    >
      <Icon size={14} className="flex-shrink-0" />
      {label}
    </button>
  );
}

function SectionLabel({ children }) {
  return <p className="px-2.5 pt-2.5 pb-1 text-[10px] font-black uppercase tracking-wider text-slate-400">{children}</p>;
}

function ActionsMenu({ s, onNavigate, onAction, onRefresh }) {
  const replicas = s.members.filter((m) => !isLeaderRole(m.role) && m.patroni_state !== 'missing');
  const hasReplicas = replicas.length > 0;

  // Same page (/postgresql-dashboard/:id/replication) and bits the backend
  // gates on — canHere() resolves against the CURRENT route, which this panel
  // only ever renders on, so it lines up with require_permission() exactly.
  const { canHere } = usePermissions();
  const canEdit = canHere('edit');
  const canExecute = canHere('execute');
  const canRestart = canHere('restart');
  const NO_PERM = 'You do not have permission for this action.';

  return (
    <div className="p-1.5 max-h-[75vh] overflow-y-auto">
      <MenuItem icon={RefreshCw} label="Refresh" onClick={onRefresh} />

      <SectionLabel>Node Actions</SectionLabel>
      <MenuItem
        icon={Power} label="Restart Patroni"
        disabled={!canRestart} reason={NO_PERM}
        onClick={() => onAction({ action: 'restart_patroni_service', label: 'Restart Patroni', danger: false, needsTarget: true, targetPool: 'current' })}
      />
      <MenuItem
        icon={RotateCw} label="Reload Patroni"
        disabled={!canRestart} reason={NO_PERM}
        onClick={() => onAction({ action: 'reload', label: 'Reload Patroni', danger: false, needsTarget: false })}
      />
      <MenuItem icon={ScrollText} label="View Logs" onClick={() => onNavigate('logs')} />

      <SectionLabel>Recovery</SectionLabel>
      <MenuItem
        icon={Repeat} label="Reinitialize Replica" danger
        disabled={!canExecute || !hasReplicas} reason={!canExecute ? NO_PERM : 'No replicas available to reinitialize.'}
        onClick={() => onAction({ action: 'reinitialize', label: 'Reinitialize Replica', danger: true, needsTarget: true, targetPool: 'replicas' })}
      />
      <MenuItem
        icon={ArrowRightLeft} label="Switchover"
        disabled={!canExecute || !hasReplicas || s.paused}
        reason={!canExecute ? NO_PERM : s.paused ? 'HA is paused.' : 'No eligible replica to switch to.'}
        onClick={() => onAction({ action: 'switchover', label: 'Switchover', danger: false, needsTarget: true, targetPool: 'replicas' })}
      />
      <MenuItem
        icon={Zap} label="Failover" danger
        disabled={!canExecute || !hasReplicas} reason={!canExecute ? NO_PERM : 'No eligible candidate for failover.'}
        onClick={() => onAction({ action: 'failover', label: 'Failover', danger: true, needsTarget: true, targetPool: 'replicas' })}
      />
      <MenuItem
        icon={Pause} label="Pause Patroni"
        disabled={!canExecute || s.paused} reason={!canExecute ? NO_PERM : 'HA is already paused.'}
        onClick={() => onAction({ action: 'pause', label: 'Pause HA', danger: false, needsTarget: false })}
      />
      <MenuItem
        icon={Play} label="Resume Patroni"
        disabled={!canExecute || !s.paused} reason={!canExecute ? NO_PERM : 'HA is not currently paused.'}
        onClick={() => onAction({ action: 'resume', label: 'Resume HA', danger: false, needsTarget: false })}
      />

      <SectionLabel>Configuration</SectionLabel>
      <MenuItem icon={Settings} label="View Dynamic Configuration" onClick={() => onNavigate('config')} />
      <MenuItem icon={Save} label="Edit Dynamic Configuration" disabled={!canEdit} reason={NO_PERM} onClick={() => onNavigate('config')} />
      <MenuItem icon={FileText} label="View patroni.yml" onClick={() => onNavigate('yaml')} />
      <MenuItem icon={FileText} label="Edit patroni.yml" disabled={!canEdit} reason={NO_PERM} onClick={() => onNavigate('yaml')} />

      <SectionLabel>Diagnostics</SectionLabel>
      <MenuItem icon={Activity} label="Patroni Status" onClick={() => onNavigate('members')} />
      <MenuItem icon={History} label="Patroni History" onClick={() => onNavigate('history')} />
      <MenuItem icon={Stethoscope} label="Cluster Health Check" onClick={() => onNavigate('recovery')} />
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   OVERVIEW (§3) — concise DBA summary + compact topology + quick actions.
   No detailed configuration here by design.
══════════════════════════════════════════════════════ */
function Tile({ label, value, sub, tone = 'slate' }) {
  const tones = {
    slate: 'text-slate-900', emerald: 'text-emerald-600', amber: 'text-amber-600', red: 'text-red-600', indigo: 'text-indigo-600',
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-[20px] font-black mt-0.5 ${tones[tone] || tones.slate}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function OverviewTab({ s, onNavigate, onAction }) {
  const replicas = s.members.filter((m) => !isLeaderRole(m.role));
  const streaming = replicas.filter((m) => m.wal_receiver_streaming).length;
  const maxLag = Math.max(0, ...replicas.map((m) => m.replay_lag || 0));
  const hs = hStyle(s.cluster_health);
  const hasReplicas = replicas.some((m) => m.patroni_state !== 'missing');

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        <Tile label="Cluster Health" value={s.cluster_health} tone={s.cluster_health === 'HEALTHY' ? 'emerald' : s.cluster_health === 'WARNING' ? 'amber' : 'red'} />
        <Tile label="Leader" value={s.leader || '—'} />
        <Tile label="Nodes" value={`${s.healthy_members}/${s.member_count}`} sub="Healthy" />
        <Tile label="Replicas" value={`${streaming}/${replicas.length}`} sub="Streaming" />
        <Tile label="Replication Lag" value={maxLag > 0 ? `${maxLag}ms` : '0s'} tone={maxLag > 1000 ? 'amber' : 'emerald'} />
        <Tile label="Timeline" value={s.timeline ?? '—'} />
        <Tile label="Patroni API" value={s.dcs_last_seen ? 'Healthy' : 'Unknown'} tone={s.dcs_last_seen ? 'emerald' : 'amber'} />
      </div>

      <div>
        <p className="text-[11px] font-black uppercase tracking-wide text-slate-400 mb-3">Topology</p>
        <TopologyView s={s} compact />
      </div>

      <div>
        <p className="text-[11px] font-black uppercase tracking-wide text-slate-400 mb-2">Quick Actions</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" icon="branch" onClick={() => onNavigate('topology')}>View Topology</Button>
          <Button variant="secondary" size="sm" icon="history" onClick={() => onNavigate('history')}>View History</Button>
          <Button variant="secondary" size="sm" icon="database" onClick={() => onNavigate('replication')}>Replication Detail</Button>
          {hasReplicas && (
            <Button variant="secondary" size="sm" icon="arrow-right" onClick={() => onAction({ action: 'switchover', label: 'Switchover', danger: false, needsTarget: true, targetPool: 'replicas' })}>
              Switchover
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   PATRONI STATUS (§4) — patronictl list equivalent, full member table.
══════════════════════════════════════════════════════ */
function MemberTable({ members, unregistered }) {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [nodeFilter, setNodeFilter] = useState('all');
  const shown = nodeFilter === 'all' ? members : members.filter((m) => m.member_name === nodeFilter);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select value={nodeFilter} onChange={(e) => setNodeFilter(e.target.value)} className="h-9 px-2.5 rounded-lg border border-slate-200 text-[12px] font-bold">
          <option value="all">All nodes</option>
          {members.map((m) => <option key={m.member_name} value={m.member_name}>{m.member_name}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 cursor-pointer">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} /> Auto Refresh
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-400 text-[10px] font-black uppercase tracking-wide">
              <th className="py-2 pr-3">Member</th>
              <th className="py-2 pr-3">Host</th>
              <th className="py-2 pr-3">Role</th>
              <th className="py-2 pr-3">State</th>
              <th className="py-2 pr-3">Timeline</th>
              <th className="py-2 pr-3">Receive LSN</th>
              <th className="py-2 pr-3">Receive Lag</th>
              <th className="py-2 pr-3">Replay LSN</th>
              <th className="py-2 pr-3">Replay Lag</th>
              <th className="py-2 pr-3">Health</th>
              <th className="py-2 pr-3">Patroni API</th>
              <th className="py-2 pr-3">Last Updated</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => {
              const hs = hStyle(m.node_health);
              const isLeader = isLeaderRole(m.role);
              return (
                <tr key={m.member_name} className="border-b border-slate-100 last:border-0">
                  <td className="py-2.5 pr-3 font-bold text-slate-800">{m.member_name}</td>
                  <td className="py-2.5 pr-3 font-mono text-slate-500">{m.ip_address}</td>
                  <td className="py-2.5 pr-3">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${isLeader ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`}>
                      {isLeader ? 'LEADER' : m.is_cascading ? 'CASCADING REPLICA' : 'REPLICA'}
                    </span>
                    {!isLeader && m.upstream_member && (
                      <p className="text-[9px] text-slate-400 font-bold mt-0.5">from {m.upstream_member}</p>
                    )}
                  </td>
                  <td className="py-2.5 pr-3 text-slate-600">{m.patroni_state}</td>
                  <td className="py-2.5 pr-3 text-slate-500">{m.timeline ?? '—'}</td>
                  <td className="py-2.5 pr-3 font-mono text-slate-500">{isLeader ? '—' : (m.receive_lsn ?? '—')}</td>
                  <td className="py-2.5 pr-3 text-slate-500">{isLeader ? '—' : (m.receive_lag ?? '—')}</td>
                  <td className="py-2.5 pr-3 font-mono text-slate-500">{isLeader ? '—' : (m.replay_lsn ?? '—')}</td>
                  <td className="py-2.5 pr-3 text-slate-500">{isLeader ? '—' : (m.replay_lag ?? '—')}</td>
                  <td className="py-2.5 pr-3">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${hs.bg} ${hs.text}`}>{m.node_health}</span>
                  </td>
                  <td className="py-2.5 pr-3">
                    <span className={`flex items-center gap-1 text-[11px] font-bold ${m.patroni_running ? 'text-emerald-600' : 'text-red-500'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${m.patroni_running ? 'bg-emerald-500' : 'bg-red-500'}`} />
                      {m.patroni_running ? 'Healthy' : 'Unreachable'}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 text-slate-400">just now</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {unregistered?.length > 0 && (
        <p className="text-[11px] text-amber-600 flex items-center gap-1.5">
          <AlertTriangle size={12} /> Patroni reports member(s) not registered as an OS server in ActMon: {unregistered.join(', ')}
        </p>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   TOPOLOGY (§5) — visual tree, generated live from Patroni; updates on its own
   when the leader changes (status refetches every 12s, this just renders it).
══════════════════════════════════════════════════════ */
function roleLabel(m) {
  if (isLeaderRole(m.role)) return 'Leader';
  if (m.patroni_state === 'missing') return 'Missing';
  return m.is_cascading ? 'Cascading Replica' : 'Replica';
}

function TopologyView({ s, compact = false }) {
  const leader = s.members.find((m) => isLeaderRole(m.role));

  // The WAL-path tree is built from each replica's ACTUAL resolved upstream
  // (m.upstream_member, derived server-side from that replica's own
  // pg_stat_wal_receiver) — never a fixed "Leader -> every replica" star.
  // A replica whose upstream couldn't be resolved is bucketed separately
  // rather than silently drawn as hanging off the Leader.
  const childrenOf = {};
  const unresolved = [];
  (s.members || []).forEach((m) => {
    if (isLeaderRole(m.role) || m.patroni_state === 'missing') return;
    if (m.upstream_member) {
      (childrenOf[m.upstream_member] ||= []).push(m);
    } else {
      unresolved.push(m);
    }
  });

  const NodeBox = ({ m, isLeader }) => {
    const hs = hStyle(m.node_health);
    const label = roleLabel(m);
    return (
      <div className={`rounded-xl border-2 px-4 py-3 text-center shadow-sm ${isLeader ? 'border-emerald-300 bg-emerald-50' : m.patroni_state === 'missing' ? 'border-red-300 bg-red-50' : 'border-blue-200 bg-blue-50'}`}>
        <div className="flex items-center justify-center gap-1">
          {isLeader && <Crown size={11} className="text-emerald-600" />}
          <p className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</p>
        </div>
        <p className="text-[14px] font-black text-slate-900 mt-0.5">{m.member_name}</p>
        <p className="text-[11px] font-mono text-slate-500">{m.ip_address}</p>
        <p className="text-[10px] text-slate-400 uppercase font-bold mt-0.5">{m.patroni_state}</p>
        {!isLeader && m.patroni_state !== 'missing' && (
          <>
            <p className={`text-[11px] font-bold mt-1 ${m.wal_receiver_streaming ? 'text-emerald-600' : 'text-amber-600'}`}>
              {m.wal_receiver_streaming ? 'Streaming' : 'Not Streaming'} · Lag {m.lag_bytes ?? m.replay_lag ?? '—'}
            </p>
            {m.upstream_member && <p className="text-[10px] text-slate-400 mt-0.5">from {m.upstream_member}</p>}
          </>
        )}
        {!compact && <p className="text-[10px] text-slate-400 mt-0.5">Timeline {m.timeline ?? '—'}</p>}
        <span className={`inline-block mt-1.5 px-2 py-0.5 rounded-full text-[9px] font-black ${hs.bg} ${hs.text}`}>
          {m.node_health}
        </span>
      </div>
    );
  };

  const renderChain = (parentName) => {
    const kids = childrenOf[parentName] || [];
    if (!kids.length) return null;
    return (
      <div className="flex flex-wrap justify-center gap-6">
        {kids.map((r) => (
          <div key={r.member_name} className="flex flex-col items-center gap-1.5">
            <ArrowDown size={13} className="text-slate-300" />
            <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wide">
              {r.is_cascading ? `WAL Streaming · via ${r.upstream_member}` : 'WAL Streaming'}
            </div>
            <NodeBox m={r} />
            {renderChain(r.member_name)}
          </div>
        ))}
      </div>
    );
  };

  if (!leader) return <p className="text-slate-400 text-[12px]">No leader detected right now.</p>;

  return (
    <div className="flex flex-col items-center gap-3 py-2">
      <NodeBox m={leader} isLeader />
      <div className="w-px h-5 bg-slate-300" />
      {renderChain(leader.member_name)}
      {unresolved.length > 0 && (
        <div className="mt-2 flex flex-col items-center gap-2">
          <p className="text-[10px] font-bold text-amber-500 uppercase tracking-wide">Upstream unresolved</p>
          <div className="flex flex-wrap justify-center gap-6">
            {unresolved.map((r) => <NodeBox key={r.member_name} m={r} />)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   REPLICATION (§6) — upstream replication ONLY. Never local slots here.
══════════════════════════════════════════════════════ */
function ReplicationTab({ s }) {
  const leader = s.members.find((m) => isLeaderRole(m.role));
  const replicas = s.members.filter((m) => m !== leader);

  return (
    <div className="space-y-5">
      {leader && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
          <p className="text-[13px] font-black text-emerald-700">Leader: {leader.member_name}</p>
          <p className="text-[11px] text-slate-500 mt-1">
            Connected replicas: {replicas.filter((r) => r.wal_receiver_streaming).length} streaming
            {replicas.length > 0 && ' — ' + replicas.map((r) => `${r.member_name} (${r.wal_receiver_streaming ? 'Streaming' : 'Not Streaming'}${r.is_cascading ? `, via ${r.upstream_member}` : ''}, ${r.lag_bytes ?? r.replay_lag ?? '—'} lag)`).join(', ')}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {replicas.map((r) => (
          <div key={r.member_name} className={`rounded-xl border px-4 py-3.5 ${r.wal_receiver_streaming ? 'border-emerald-200 bg-emerald-50/50' : r.patroni_state === 'missing' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
            <div className="flex items-center justify-between mb-2">
              <p className="font-black text-slate-800 text-[13px]">{r.member_name}</p>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${r.wal_receiver_streaming ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                {r.wal_receiver_streaming ? 'Streaming' : r.patroni_state === 'missing' ? 'Unreachable' : 'Not Streaming'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
              {/* Actual upstream this node streams from (its own pg_stat_wal_receiver
                  sender), NOT always the cluster Leader — a cascading replica's
                  upstream is another replica. */}
              <div><span className="text-slate-400">Upstream</span><p className="font-bold text-slate-700">{r.upstream_member || s.leader || '—'}{r.is_cascading && ' (cascading)'}</p></div>
              <div><span className="text-slate-400">WAL Receiver</span><p className="font-bold text-slate-700">{r.wal_receiver_streaming ? 'Active' : 'Not connected'}</p></div>
              <div><span className="text-slate-400">Receive LSN</span><p className="font-mono text-slate-600">{r.receive_lsn ?? '—'}</p></div>
              <div><span className="text-slate-400">Replay LSN</span><p className="font-mono text-slate-600">{r.replay_lsn ?? '—'}</p></div>
              <div><span className="text-slate-400">Receive Lag</span><p className="text-slate-600">{r.receive_lag ?? '—'}</p></div>
              <div><span className="text-slate-400">Replay Lag</span><p className="text-slate-600">{r.replay_lag ?? '—'}</p></div>
              <div><span className="text-slate-400">Lag (bytes)</span><p className="text-slate-600">{r.lag_bytes ?? '—'}</p></div>
              <div><span className="text-slate-400">Timeline</span><p className="text-slate-600">{r.timeline ?? '—'}</p></div>
              <div><span className="text-slate-400">Health</span><p className={`font-bold ${hStyle(r.node_health).text}`}>{r.node_health}</p></div>
            </div>
          </div>
        ))}
        {replicas.length === 0 && <p className="text-slate-400 text-[12px]">No replicas in this cluster.</p>}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   REPLICATION SLOTS (§7) — a completely separate section. Upstream vs.
   cascading/reserved, correctly labeled. Never drives node health.
══════════════════════════════════════════════════════ */
function SlotsPanel({ connId }) {
  const { data, isLoading } = usePatroniQuery(connId, '/slots');
  if (isLoading) return <p className="text-slate-400 text-[12px]">Loading…</p>;
  if (!data) return null;

  if (data.unreachable) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3">
        <AlertTriangle size={16} className="text-amber-600 flex-shrink-0" />
        <p className="text-[12.5px] text-amber-700">{data.summary}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {data.upstream_replication && (
        <div className={`rounded-xl border px-4 py-3 flex items-center gap-3 ${
          data.upstream_replication.streaming ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
          <Activity size={16} className={data.upstream_replication.streaming ? 'text-emerald-600' : 'text-red-600'} />
          <div>
            <p className={`text-[13px] font-black ${data.upstream_replication.streaming ? 'text-emerald-700' : 'text-red-700'}`}>
              Upstream Replication: {data.upstream_replication.label}
            </p>
            <p className="text-[11px] text-slate-500">
              This node's OWN stream from {data.upstream_replication.sender_host || 'its upstream'} — see the Replication tab for full detail.
              {data.upstream_replication.seconds_behind != null && ` ${data.upstream_replication.seconds_behind}s behind.`}
            </p>
          </div>
        </div>
      )}

      <div>
        <p className="text-[11px] font-black uppercase tracking-wide text-slate-400 mb-1">Local Replication Slots — {data.summary}</p>
        <p className="text-[10px] text-slate-400 mb-2">Never used as evidence of a health problem — a slot with no consumer is reserved capacity, not broken replication.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-slate-400 text-[10px] font-black uppercase border-b border-slate-200">
                <th className="py-2 pr-3">Slot Name</th><th className="py-2 pr-3">Type</th><th className="py-2 pr-3">Plugin</th>
                <th className="py-2 pr-3">Active</th><th className="py-2 pr-3">Restart LSN</th><th className="py-2 pr-3">Retained WAL</th>
                <th className="py-2 pr-3">Database</th><th className="py-2 pr-3">Purpose</th>
              </tr>
            </thead>
            <tbody>
              {data.local_slots.map((slot) => (
                <tr key={slot.slot_name} className="border-b border-slate-100 last:border-0">
                  <td className="py-2.5 pr-3 font-mono font-bold text-slate-700">{slot.slot_name}</td>
                  <td className="py-2.5 pr-3 text-slate-500">{slot.slot_type}</td>
                  <td className="py-2.5 pr-3 text-slate-500">{slot.plugin || '—'}</td>
                  <td className="py-2.5 pr-3">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${slot.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>
                      {slot.active ? 'Active' : 'Unused Cascading Slot'}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-slate-500">{slot.restart_lsn ?? '—'}</td>
                  <td className="py-2.5 pr-3 text-slate-500">{slot.retained_bytes ?? 0} B</td>
                  <td className="py-2.5 pr-3 text-slate-500">{slot.database || '—'}</td>
                  <td className="py-2.5 pr-3">
                    <span className={`text-[11px] font-bold ${slot.active ? 'text-emerald-600' : 'text-slate-400'}`}>
                      {slot.active ? 'Upstream Replication Slot' : 'Cascading / Reserved Slot'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   CONFIGURATION (§8) — two clearly separated sub-tabs: Patroni Dynamic
   Configuration vs. PostgreSQL Configuration. Never mixed.
══════════════════════════════════════════════════════ */
function ConfigurationTab({ connId, onApplied }) {
  const [sub, setSub] = useState('dynamic');
  return (
    <div>
      <div className="flex items-center gap-1 mb-4 bg-slate-100 rounded-xl p-1 w-fit">
        {[['dynamic', 'Dynamic Config'], ['postgresql', 'PostgreSQL Config']].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setSub(id)}
            className={`px-3.5 py-1.5 rounded-lg text-[12px] font-bold transition-all ${sub === id ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-500'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {sub === 'dynamic' && <DynamicConfigPanel connId={connId} onApplied={onApplied} />}
      {sub === 'postgresql' && <PostgresConfigPanel connId={connId} />}
    </div>
  );
}

const KNOWN_KEYS = [
  { key: 'ttl', label: 'TTL (seconds)', type: 'number' },
  { key: 'loop_wait', label: 'Loop Wait (seconds)', type: 'number' },
  { key: 'retry_timeout', label: 'Retry Timeout (seconds)', type: 'number' },
  { key: 'maximum_lag_on_failover', label: 'Max Lag on Failover (bytes)', type: 'number' },
];

function DynamicConfigPanel({ connId, onApplied }) {
  const qc = useQueryClient();
  const { canHere } = usePermissions();
  const canEdit = canHere('edit');
  const { data, isLoading } = usePatroniQuery(connId, '/config');
  const { data: historyData } = usePatroniQuery(connId, '/config/history');
  const [draft, setDraft] = useState(null);
  const [rawText, setRawText] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const config = data?.config;
  const working = draft ?? config;

  if (isLoading) return <p className="text-slate-400 text-[12px]">Loading…</p>;
  if (!config) return <p className="text-slate-400 text-[12px]">Could not load Patroni configuration.</p>;

  const setField = (key, value) => setDraft({ ...(working || {}), [key]: value });
  const resetDraft = () => { setDraft(null); setRawText(null); setError(null); };

  const beginApply = () => {
    const changes = {};
    for (const { key, type } of KNOWN_KEYS) {
      const v = working[key];
      if (v !== config[key] && v !== undefined && v !== '') changes[key] = type === 'number' ? Number(v) : v;
    }
    if (rawText != null) {
      try { Object.assign(changes, JSON.parse(rawText)); }
      catch { setError('Raw config JSON is invalid — fix it before applying.'); return; }
    }
    if (Object.keys(changes).length === 0) { setError('No changes to apply.'); return; }
    setError(null);
    setConfirming({ changes });
  };

  const confirmApply = async () => {
    setBusy(true);
    try {
      await client.patch(`${base(connId)}/config`, { changes: confirming.changes });
      setConfirming(null); setDraft(null); setRawText(null);
      onApplied();
      qc.invalidateQueries({ queryKey: ['patroni', connId, '/config/history'] });
    } catch (e) {
      setError(errorText(e, 'Failed to apply configuration.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-black uppercase tracking-wide text-slate-400 mb-2">Patroni Dynamic Configuration</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {KNOWN_KEYS.map(({ key, label, type }) => (
            <div key={key}>
              <label className="text-[11px] font-bold text-slate-500">{label}</label>
              <input
                type={type} value={working?.[key] ?? ''} onChange={(e) => setField(key, e.target.value)} disabled={!canEdit}
                className="mt-1 w-full h-9 px-2.5 rounded-lg border border-slate-200 text-[12px] font-mono focus:outline-none focus:border-indigo-400 disabled:bg-slate-50 disabled:text-slate-400"
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="text-[11px] font-black uppercase tracking-wide text-slate-400 mb-2">Full Configuration (JSON)</p>
        <CodeEditor language="json" value={rawText ?? JSON.stringify(working, null, 2)} onChange={canEdit ? setRawText : undefined} readOnly={!canEdit} minHeight="180px" />
        <p className="text-[10px] text-slate-400 mt-1">postgresql.conf-style server settings are NOT edited here — see the PostgreSQL Config sub-tab for those.</p>
      </div>

      {error && <p className="text-[12px] text-red-600 font-semibold">{error}</p>}
      {canEdit && (
        <div className="flex justify-end gap-2">
          {(draft || rawText) && <Button variant="secondary" onClick={resetDraft}>Reset</Button>}
          <Button variant="primary" icon="save" onClick={beginApply}>Validate &amp; Save</Button>
        </div>
      )}

      {confirming && (
        <Dialog
          open onClose={busy ? undefined : () => setConfirming(null)} title="Apply Patroni Configuration" tone="warning" icon="alert"
          footer={(
            <div className="flex justify-end gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming(null)}>Cancel</Button>
              <Button variant="primary" loading={busy} onClick={confirmApply}>Apply Configuration</Button>
            </div>
          )}
        >
          <p className="text-[12px] text-slate-500 mb-2">Affected settings — a backup of the current configuration is kept automatically:</p>
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 font-mono text-[12px] space-y-1">
            {Object.entries(confirming.changes).map(([k, v]) => (
              <div key={k}>
                <span className="text-red-500">- {k}: {JSON.stringify(config[k])}</span><br />
                <span className="text-emerald-600">+ {k}: {JSON.stringify(v)}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-400 mt-2">Configuration valid ✓ — applied through Patroni's own DCS-stored config API.</p>
        </Dialog>
      )}

      <div>
        <p className="text-[11px] font-black uppercase tracking-wide text-slate-400 mb-2">Configuration History</p>
        <p className="text-[10px] text-slate-400 mb-2">Only covers changes made through ActMon — not a universal record of every external edit.</p>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {(historyData || []).length === 0 && <p className="text-slate-400 text-[12px]">No changes applied through ActMon yet.</p>}
          {(historyData || []).map((h) => (
            <div key={h.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-[12px]">
              <div>
                <span className="font-bold text-slate-700">{h.target === 'dynamic' ? 'Dynamic Config' : 'patroni.yml'}</span>
                <span className="text-slate-400 ml-2">{new Date(h.applied_at).toLocaleString()}</span>
                <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold ${
                  h.result === 'applied' ? 'bg-emerald-100 text-emerald-700' : h.result === 'rolled_back' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                  {h.result}
                </span>
              </div>
              {canEdit && h.target === 'dynamic' && h.result === 'applied' && (
                <button className="text-indigo-600 hover:underline text-[11px] font-bold"
                  onClick={() => { setDraft(h.before_content); setRawText(JSON.stringify(h.before_content, null, 2)); }}>
                  Restore this version
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Read-only postgresql.conf-style settings — reuses the EXISTING plain
 * PostgreSQL Config tab's own endpoint (svc_config_detail), not a new query,
 * kept in its own sub-tab so it's never confused with Patroni's own config. */
function PostgresConfigPanel({ connId }) {
  const [search, setSearch] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['pgConfigDetailForPatroni', connId],
    queryFn: () => client.get(`/connections/postgresql/${connId}/config-detail`).then((r) => r.data),
    enabled: !!connId,
    retry: false,
  });

  if (isLoading) return <p className="text-slate-400 text-[12px]">Loading…</p>;
  if (error) return <p className="text-[12px] text-red-600">{errorText(error, 'Could not load PostgreSQL configuration.')}</p>;

  // svc_config_detail groups settings by category (Memory/WAL/Checkpoint/...) —
  // flatten for a single searchable table, matching this sub-tab's simpler scope.
  const all = Object.values(data?.groups || {}).flat();
  const filtered = search ? all.filter((s) => s.name?.toLowerCase().includes(search.toLowerCase())) : all;

  return (
    <div className="space-y-3">
      <p className="text-[11px] font-black uppercase tracking-wide text-slate-400">PostgreSQL Configuration (postgresql.conf / pg_settings)</p>
      <input
        placeholder="Search all params…" value={search} onChange={(e) => setSearch(e.target.value)}
        className="h-9 px-2.5 rounded-lg border border-slate-200 text-[12px] w-full max-w-xs"
      />
      <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-white">
            <tr className="text-left text-slate-400 text-[10px] font-black uppercase border-b border-slate-200">
              <th className="py-2 pr-3">Parameter</th><th className="py-2 pr-3">Current Value</th>
              <th className="py-2 pr-3">Unit</th><th className="py-2 pr-3">Context</th><th className="py-2 pr-3">Source</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 300).map((row) => (
              <tr key={row.name} className="border-b border-slate-100 last:border-0">
                <td className="py-2 pr-3 font-mono font-bold text-slate-700">{row.name}</td>
                <td className="py-2 pr-3 font-mono text-slate-600">{row.setting}</td>
                <td className="py-2 pr-3 text-slate-400">{row.unit || '—'}</td>
                <td className="py-2 pr-3 text-slate-400">{row.context}</td>
                <td className="py-2 pr-3 text-slate-400">{row.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="text-slate-400 text-[12px] py-6 text-center">No parameters match.</p>}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   patroni.yml (§9-§11) — proper static config viewer/editor.
   Access tier (direct/sudo/none) shown plainly, never a false "not found".
══════════════════════════════════════════════════════ */
function YamlPanel({ connId, members }) {
  const { canHere } = usePermissions();
  const canEdit = canHere('edit');
  const [serverId, setServerId] = useState(members[0]?.os_server_id);
  const { data, isLoading, error, refetch } = usePatroniQuery(connId, '/yaml', { params: { server_id: serverId }, enabled: !!serverId });
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const startEdit = () => { setText(data?.masked_yaml || ''); setEditing(true); };

  const beginSave = () => {
    try { yamlLoad(text); }
    catch (e) { setResult({ ok: false, text: `Invalid YAML: ${e.message}` }); return; }
    setConfirmOpen(true);
  };

  const doSave = async () => {
    setBusy(true);
    try {
      const r = await client.put(`${base(connId)}/yaml`, { server_id: serverId, content: text, password });
      setResult({ ok: true, text: r.data.message });
      setEditing(false); setConfirmOpen(false); setPassword('');
      refetch();
    } catch (e) {
      setResult({ ok: false, text: errorText(e, 'Failed to update patroni.yml.') });
    } finally {
      setBusy(false);
    }
  };

  const displayed = search && data?.masked_yaml
    ? data.masked_yaml.split('\n').filter((l) => l.toLowerCase().includes(search.toLowerCase())).join('\n')
    : data?.masked_yaml;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <select
            value={serverId}
            onChange={(e) => { setServerId(Number(e.target.value)); setEditing(false); setSearch(''); }}
            className="h-9 px-2.5 rounded-lg border border-slate-200 text-[12px] font-bold"
          >
            {members.map((m) => <option key={m.os_server_id} value={m.os_server_id}>{m.member_name} ({m.ip_address})</option>)}
          </select>
          <span className="font-mono text-[11px] text-slate-400">{data?.path || '/etc/patroni/patroni.yml'}</span>
          {data?.access && (
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${data.access === 'direct' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
              {data.access === 'direct' ? 'Direct read' : 'via sudo'}
            </span>
          )}
        </div>
        {!editing && data?.masked_yaml && (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" icon="refresh" onClick={() => refetch()}>Refresh</Button>
            <Button variant="secondary" size="sm" icon="copy" onClick={() => navigator.clipboard.writeText(data.masked_yaml)}>Copy</Button>
            {canEdit && <Button variant="primary" size="sm" icon="file-edit" onClick={startEdit}>Edit</Button>}
          </div>
        )}
      </div>

      {!editing && data?.masked_yaml && (
        <input
          placeholder="Search patroni.yml…" value={search} onChange={(e) => setSearch(e.target.value)}
          className="h-9 px-2.5 rounded-lg border border-slate-200 text-[12px] w-full max-w-xs"
        />
      )}

      {isLoading && <p className="text-slate-400 text-[12px]">Loading…</p>}
      {error && (
        <p className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {errorText(error, 'Could not read this file.')}
        </p>
      )}
      {data?.masked_yaml && (
        <CodeEditor language="yaml" value={editing ? text : (displayed ?? data.masked_yaml)} onChange={editing ? setText : undefined} readOnly={!editing} minHeight="320px" />
      )}
      {editing && (
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
          <Button variant="danger" icon="save" onClick={beginSave}>Validate &amp; Save</Button>
        </div>
      )}
      {result && <p className={`text-[12px] font-semibold ${result.ok ? 'text-emerald-600' : 'text-red-600'}`}>{result.text}</p>}

      {confirmOpen && (
        <Dialog
          open onClose={busy ? undefined : () => setConfirmOpen(false)} title="Apply patroni.yml changes" tone="danger" icon="alert"
          footer={(
            <div className="flex justify-end gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => setConfirmOpen(false)}>Cancel</Button>
              <Button variant="danger" loading={busy} disabled={!password} onClick={doSave}>Confirm &amp; Restart Patroni</Button>
            </div>
          )}
        >
          <p className="text-[12.5px] text-slate-600 leading-relaxed">
            Validation Result: YAML valid ✓. A backup of the current file is kept automatically (ownership/permissions
            preserved by the underlying write). Patroni will be restarted on this node to apply the change — if it
            doesn't come back up healthy within 60s, ActMon automatically rolls back to the backup and restarts again.
          </p>
          <label className="block text-[12px] font-bold text-slate-500 mt-4 mb-1">Confirm your password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus
            className="w-full h-10 px-3 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:border-indigo-400" />
        </Dialog>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   RECOVERY (§12-§13, §22) — dedicated tab. Each operation explains what it
   does, when to use it, risk, target and current state. Includes the
   Recovery Assistant / diagnostics for an unhealthy replica.
══════════════════════════════════════════════════════ */
const RECOVERY_OPS = [
  { action: 'reinitialize', label: 'Reinitialize Replica', icon: Repeat, danger: true, targetPool: 'replicas', needsTarget: true,
    what: 'Rebuilds the selected replica from a fresh base backup of the current leader.',
    when: 'The replica is not streaming and a required WAL segment has already been removed from the leader.',
    risk: 'Existing PostgreSQL data on the replica may be removed and rebuilt.' },
  { action: 'switchover', label: 'Switchover', icon: ArrowRightLeft, danger: false, targetPool: 'replicas', needsTarget: true,
    what: 'Gracefully hands leadership to a healthy, caught-up replica.',
    when: 'Planned maintenance on the current leader, or load rebalancing.',
    risk: 'Brief write unavailability during the handoff (typically a few seconds).' },
  { action: 'failover', label: 'Failover', icon: Zap, danger: true, targetPool: 'replicas', needsTarget: true,
    what: 'Forces a candidate replica to become leader.',
    when: 'ONLY when the current leader is unavailable or cannot safely continue serving as leader.',
    risk: 'Potential data loss depending on replication state at the time of failover.' },
  { action: 'restart_patroni_service', label: 'Restart Patroni', icon: Power, danger: false, targetPool: 'current', needsTarget: true,
    what: 'Restarts the Patroni OS service on the selected node (systemd unit) — not PostgreSQL itself.',
    when: 'Patroni is unresponsive, or a static patroni.yml change needs the service reloaded.',
    risk: 'Temporarily interrupts Patroni management on this node; PostgreSQL may keep running depending on state.' },
  { action: 'reload', label: 'Reload Patroni', icon: RotateCw, danger: false, targetPool: null, needsTarget: false,
    what: "Asks Patroni to re-read configuration that doesn't require a restart.",
    when: 'After a dynamic config change that only needs a reload (not every change does).',
    risk: 'Minimal — no service interruption.' },
  { action: 'pause', label: 'Pause Patroni', icon: Pause, danger: false, targetPool: null, needsTarget: false,
    what: 'Pauses Patroni HA management cluster-wide — Patroni stops taking automatic action.',
    when: 'Planned maintenance where you need to manually control PostgreSQL without Patroni intervening.',
    risk: 'No automatic failover will happen while paused, even if the leader fails.' },
  { action: 'resume', label: 'Resume Patroni', icon: Play, danger: false, targetPool: null, needsTarget: false,
    what: 'Resumes normal Patroni HA management.',
    when: 'After planned maintenance is complete.',
    risk: 'None — restores normal automatic HA.' },
];

function RecoveryTab({ connId, s, onAction }) {
  const { canHere } = usePermissions();
  const canExecute = canHere('execute');
  const canRestart = canHere('restart');
  const replicas = s.members.filter((m) => !isLeaderRole(m.role) && m.patroni_state !== 'missing');
  const unhealthy = s.members.filter((m) => m.node_health !== 'HEALTHY');
  const [diagnoseFor, setDiagnoseFor] = useState(unhealthy[0]?.member_name || null);

  const eligible = (op) => {
    if (op.action === 'reinitialize' || op.action === 'switchover' || op.action === 'failover') return replicas.length > 0;
    return true;
  };
  const canFor = (op) => (op.action === 'restart_patroni_service' ? canRestart : op.action === 'reload' ? canRestart : canExecute);

  return (
    <div className="space-y-6">
      {unhealthy.length > 0 && (
        <div>
          <p className="text-[11px] font-black uppercase tracking-wide text-slate-400 mb-2">Recovery Assistant</p>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Stethoscope size={15} className="text-amber-600" />
              <select value={diagnoseFor || ''} onChange={(e) => setDiagnoseFor(e.target.value)} className="h-8 px-2 rounded-lg border border-amber-200 text-[12px] font-bold bg-white">
                {unhealthy.map((m) => <option key={m.member_name} value={m.member_name}>{m.member_name} ({m.node_health})</option>)}
              </select>
            </div>
            {diagnoseFor && <DiagnosisPanel connId={connId} member={diagnoseFor} onAction={onAction} canExecute={canExecute} />}
          </div>
        </div>
      )}

      <div>
        <p className="text-[11px] font-black uppercase tracking-wide text-slate-400 mb-2">Cluster: {s.scope} · Current Leader: {s.leader}</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {RECOVERY_OPS.map((op) => {
            const Icon = op.icon;
            const ok = eligible(op) && canFor(op);
            return (
              <div key={op.action} className={`rounded-xl border p-4 ${op.danger ? 'border-red-200 bg-red-50/40' : 'border-slate-200 bg-slate-50/60'}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Icon size={15} className={op.danger ? 'text-red-600' : 'text-slate-500'} />
                    <p className={`font-black text-[13px] ${op.danger ? 'text-red-700' : 'text-slate-800'}`}>{op.label}</p>
                  </div>
                  {op.danger && <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-600 text-[9px] font-black uppercase">Dangerous</span>}
                </div>
                <p className="text-[11px] text-slate-500 mb-1"><span className="font-bold text-slate-600">What: </span>{op.what}</p>
                <p className="text-[11px] text-slate-500 mb-1"><span className="font-bold text-slate-600">When: </span>{op.when}</p>
                <p className="text-[11px] text-slate-500 mb-3"><span className="font-bold text-slate-600">Risk: </span>{op.risk}</p>
                <Button
                  variant={op.danger ? 'danger' : 'primary'} size="sm"
                  disabled={!ok}
                  title={!eligible(op) ? 'No eligible replica for this operation right now.' : !canFor(op) ? 'You do not have permission for this action.' : undefined}
                  onClick={() => onAction({ action: op.action, label: op.label, danger: op.danger, needsTarget: op.needsTarget, targetPool: op.targetPool })}
                >
                  {op.label}
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Runs the §22 checklist against one member and shows a plain diagnosis +
 * one recommended action — never executes anything on its own. */
function DiagnosisPanel({ connId, member, onAction, canExecute }) {
  const { data, isLoading, error } = usePatroniQuery(connId, '/diagnose', { params: { member } });
  if (isLoading) return <p className="text-[12px] text-slate-500">Running diagnostics…</p>;
  if (error) return <p className="text-[12px] text-red-600">{errorText(error, 'Diagnosis failed.')}</p>;
  if (!data) return null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {data.checks.map((c) => (
          <div key={c.check} className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] ${c.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
            {c.ok ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
            <span className="font-bold">{c.check}</span><span className="text-slate-400">— {c.detail}</span>
          </div>
        ))}
      </div>
      {!data.healthy && (
        <div className="rounded-lg bg-white border border-amber-200 p-3">
          <p className="text-[12px] font-black text-red-700">{data.diagnosis}</p>
          <p className="text-[11px] text-slate-500 mt-1">{data.recommendation}</p>
          {data.recommended_action && (
            <Button
              variant="danger" size="sm" className="mt-2" disabled={!canExecute}
              onClick={() => onAction({
                action: data.recommended_action,
                label: data.recommended_action === 'reinitialize' ? 'Reinitialize Replica' : 'Restart Patroni',
                danger: true, needsTarget: true,
                targetPool: data.recommended_action === 'reinitialize' ? 'replicas' : 'all',
              })}
            >
              {data.recommended_action === 'reinitialize' ? 'Reinitialize Replica' : 'Restart Patroni'}
            </Button>
          )}
        </div>
      )}
      {data.healthy && <p className="text-[12px] text-emerald-600 font-semibold">All checks passed — this member looks healthy.</p>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   LOGS (§20)
══════════════════════════════════════════════════════ */
// journalctl's default (non-JSON) line shape:
// "Aug 16 20:33:03 pg-node1 patroni[1234]: 2026-08-16 20:33:03,123 INFO: message..."
// Parsed into columns rather than shown as a raw text dump. Lines that don't
// match (journalctl's own "-- No entries --"/hint preamble) still render as a
// message-only row instead of being dropped.
const _LOG_LINE_RE = /^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^:\[]+?)(?:\[(\d+)\])?:\s?(.*)$/;
const _LEVEL_IN_MSG_RE = /\b(FATAL|CRITICAL|ERROR|WARNING|WARN|INFO|DEBUG)\b/;

function parseLogLine(line) {
  const m = _LOG_LINE_RE.exec(line);
  const rawMsg = m ? m[5] : line;
  const levelMatch = _LEVEL_IN_MSG_RE.exec(rawMsg);
  let level = levelMatch ? levelMatch[1].toUpperCase() : null;
  if (level === 'WARN') level = 'WARNING';
  if (!level) {
    if (/error|fatal/i.test(line)) level = 'ERROR';
    else if (/warn/i.test(line)) level = 'WARNING';
    else if (/info/i.test(line)) level = 'INFO';
  }
  return {
    timestamp: m ? m[1] : '', host: m ? m[2] : '', process: m ? m[3] : '',
    pid: m ? m[4] : '', message: rawMsg, level: level || '—', raw: line,
  };
}

const LOG_LEVEL_STYLE = {
  FATAL: 'bg-red-100 text-red-700', CRITICAL: 'bg-red-100 text-red-700', ERROR: 'bg-red-100 text-red-700',
  WARNING: 'bg-amber-100 text-amber-700', INFO: 'bg-blue-100 text-blue-700', DEBUG: 'bg-slate-100 text-slate-500',
  '—': 'bg-slate-100 text-slate-400',
};

function LogsPanel({ connId, members }) {
  const [serverId, setServerId] = useState(members[0]?.os_server_id);
  const [since, setSince] = useState('2 hours ago');
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState('all');
  const { data, isLoading, error, refetch } = usePatroniQuery(connId, '/logs', { params: { server_id: serverId, unit: 'patroni', since } });

  const isBad = (line) => /no route to host|wal segment already removed|timeline mismatch|primary unavailable|wal receiver stopped|reinitializ|leader changed|error|fatal/i.test(line);

  let rows = (data?.lines || []).map(parseLogLine);
  if (level !== 'all') rows = rows.filter((r) => r.level === level.toUpperCase());
  if (filter) rows = rows.filter((r) => r.raw.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={serverId} onChange={(e) => setServerId(Number(e.target.value))} className="h-9 px-2.5 rounded-lg border border-slate-200 text-[12px] font-bold">
          {members.map((m) => <option key={m.os_server_id} value={m.os_server_id}>{m.member_name}</option>)}
        </select>
        <select value={level} onChange={(e) => setLevel(e.target.value)} className="h-9 px-2.5 rounded-lg border border-slate-200 text-[12px]">
          <option value="all">All levels</option><option value="error">ERROR</option><option value="warning">WARNING</option><option value="info">INFO</option>
        </select>
        <select value={since} onChange={(e) => setSince(e.target.value)} className="h-9 px-2.5 rounded-lg border border-slate-200 text-[12px]">
          <option value="30 minutes ago">Last 30 min</option><option value="2 hours ago">Last 2 hours</option><option value="24 hours ago">Last 24 hours</option>
        </select>
        <input placeholder="Search…" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-9 px-2.5 rounded-lg border border-slate-200 text-[12px] flex-1 min-w-[160px]" />
        <Button variant="secondary" size="sm" icon="refresh" onClick={() => refetch()}>Refresh</Button>
        <Button variant="secondary" size="sm" icon="copy" onClick={() => navigator.clipboard.writeText(rows.map((r) => r.raw).join('\n'))}>Copy</Button>
      </div>
      {isLoading && <p className="text-slate-400 text-[12px]">Loading…</p>}
      {error && <p className="text-[12px] text-red-600">{errorText(error, 'Could not read logs.')}</p>}
      {!isLoading && !error && (
        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-[11.5px]">
              <thead className="sticky top-0 bg-slate-50">
                <tr className="text-left text-slate-400 text-[10px] font-black uppercase tracking-wide border-b border-slate-200">
                  <th className="py-2 pl-3 pr-3 whitespace-nowrap">Time</th>
                  <th className="py-2 pr-3 whitespace-nowrap">Level</th>
                  <th className="py-2 pr-3 whitespace-nowrap">Process</th>
                  <th className="py-2 pr-3">Message</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={`border-b border-slate-100 last:border-0 ${isBad(r.raw) ? 'bg-red-50/60' : ''}`}>
                    <td className="py-1.5 pl-3 pr-3 font-mono text-slate-400 whitespace-nowrap">{r.timestamp || '—'}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-black ${LOG_LEVEL_STYLE[r.level] || LOG_LEVEL_STYLE['—']}`}>{r.level}</span>
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-slate-500 whitespace-nowrap">{r.process ? `${r.process}${r.pid ? `[${r.pid}]` : ''}` : '—'}</td>
                    <td className={`py-1.5 pr-3 font-mono ${isBad(r.raw) ? 'text-red-700 font-semibold' : 'text-slate-700'}`}>{r.message}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={4} className="py-4 text-center text-slate-400">No matching log lines.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   HISTORY (§21) — Patroni native history + ClickHouse trend + ActMon action audit.
══════════════════════════════════════════════════════ */
function HistoryPanel({ connId }) {
  const { data, isLoading } = usePatroniQuery(connId, '/history');
  const { data: chData } = usePatroniQuery(connId, '/ch-history', { params: { minutes: 1440 } });
  const { data: actionData } = usePatroniQuery(connId, '/action-history');

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-black uppercase tracking-wide text-slate-400 mb-2">ActMon Action History</p>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-slate-400 text-[10px] font-black uppercase border-b border-slate-200">
                <th className="py-2 pr-3">Action</th><th className="py-2 pr-3">Target</th><th className="py-2 pr-3">Result</th><th className="py-2 pr-3">Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {(actionData || []).map((a) => (
                <tr key={a.id} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-bold text-slate-700">{a.action}</td>
                  <td className="py-2 pr-3 text-slate-500">{a.target || '—'}</td>
                  <td className="py-2 pr-3">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${a.error ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-700'}`}>
                      {a.error ? 'Failed' : 'Success'}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-slate-400">{a.timestamp ? new Date(a.timestamp).toLocaleString() : '—'}</td>
                </tr>
              ))}
              {(actionData || []).length === 0 && <tr><td colSpan={4} className="py-4 text-center text-slate-400">No actions fired through ActMon yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <p className="text-[11px] font-black uppercase tracking-wide text-slate-400 mb-2">Timeline History (patronictl history)</p>
        {isLoading && <p className="text-slate-400 text-[12px]">Loading…</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-slate-400 text-[10px] font-black uppercase border-b border-slate-200">
                <th className="py-2 pr-3">Timeline</th><th className="py-2 pr-3">LSN</th>
                <th className="py-2 pr-3">Reason</th><th className="py-2 pr-3">Timestamp</th><th className="py-2 pr-3">New Leader</th>
              </tr>
            </thead>
            <tbody>
              {(data?.history || []).slice().reverse().map((h, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-bold">{h.timeline}</td>
                  <td className="py-2 pr-3 font-mono text-slate-500">{h.lsn}</td>
                  <td className="py-2 pr-3 text-slate-500">{h.reason}</td>
                  <td className="py-2 pr-3 text-slate-500">{h.timestamp}</td>
                  <td className="py-2 pr-3 font-bold text-indigo-600">{h.new_leader}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <p className="text-[11px] font-black uppercase tracking-wide text-slate-400 mb-2">Leader Changes — Last 24h (ActMon-collected)</p>
        {(chData?.transitions || []).length === 0
          ? <p className="text-slate-400 text-[12px]">No leader changes recorded in the last 24 hours.</p>
          : (
            <div className="space-y-1.5">
              {chData.transitions.map((t, i) => (
                <div key={i} className="flex items-center gap-2 text-[12px] text-slate-600">
                  <Clock size={11} className="text-slate-400" /> {t.ts} — {t.previous_leader} → <span className="font-bold text-indigo-600">{t.new_leader}</span>
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   ACTION DIALOG — switchover / failover / restart / reload / reinit / pause / resume
══════════════════════════════════════════════════════ */
function ActionDialog({ connId, spec, members, leader, currentMember, onClose, onDone }) {
  // "current" = Restart Patroni/PostgreSQL — locked to the node this dashboard
  // is actually viewing, never a picker (§2A/§2B/§4: "Do not add unnecessary
  // node selectors to Restart Patroni"). Every other action keeps its normal
  // target-picker pool, unchanged.
  const isCurrentNodeAction = spec.targetPool === 'current';
  const pool = spec.targetPool === 'replicas'
    ? members.filter((m) => m.member_name !== leader && m.patroni_state !== 'missing')
    : isCurrentNodeAction ? members.filter((m) => m.member_name === currentMember)
    : [];
  const [target, setTarget] = useState(isCurrentNodeAction ? currentMember : (pool[0]?.member_name || ''));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [aiCheck, setAiCheck] = useState(null); // AI Pre-check (§3B) — advisory only

  const targetMember = pool.find((m) => m.member_name === target)
    || (isCurrentNodeAction ? members.find((m) => m.member_name === currentMember) : null);

  const runAiPrecheck = () => {
    setAiCheck({ loading: true });
    client.post(`${base(connId)}/ai-precheck`, { member: target })
      .then(r => setAiCheck({ loading: false, data: r.data?.analysis, err: r.data?.status === 'error' ? r.data.error : null }))
      .catch(() => setAiCheck({ loading: false, err: 'AI suggestions are temporarily unavailable.' }));
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.post(`${base(connId)}/action`, { action: spec.action, target: spec.needsTarget ? target : undefined, password });
      if (spec.action === 'reinitialize') {
        setProgress('Requested — reinitializing…');
        await pollUntilHealthy(connId, target, setProgress);
      } else if (spec.action === 'restart' || spec.action === 'restart_patroni_service') {
        await pollRestartVerification(connId, target, targetMember?.role, setProgress);
      }
      onDone();
    } catch (e) {
      setError(errorText(e, `${spec.label} failed.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open onClose={busy ? undefined : onClose} title={spec.label} tone={spec.danger ? 'danger' : 'warning'} icon="alert"
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant={spec.danger ? 'danger' : 'primary'} loading={busy} disabled={!password || (spec.needsTarget && !target)} onClick={run}>
            Confirm {spec.label}
          </Button>
        </div>
      )}
    >
      {spec.action === 'failover' && (
        <p className="text-[12px] font-black text-red-600 mb-3 uppercase tracking-wide">
          Failover is an emergency operation — only use it when the current leader is unavailable or cannot safely
          serve as leader. Potential data loss may occur depending on replication state.
        </p>
      )}
      {spec.action === 'reinitialize' && (
        <p className="text-[12px] text-slate-600 mb-3">
          Reinitializing the replica may remove its existing PostgreSQL data and rebuild it from the current leader.
        </p>
      )}
      {spec.action === 'restart_patroni_service' && (
        <p className="text-[12px] text-slate-600 mb-3">
          Restarting Patroni will temporarily interrupt Patroni management on this node. PostgreSQL may continue
          running depending on Patroni's state.
        </p>
      )}

      {isCurrentNodeAction ? (
        <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-1 text-[12px]">
          <div className="flex justify-between"><span className="text-slate-400">Target</span><span className="font-black text-slate-800">{currentMember || '—'}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Role</span><span className="font-bold text-slate-700">{targetMember?.role || '—'}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">State</span><span className="font-bold text-slate-700">{targetMember?.patroni_state || '—'}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Replication Lag</span><span className="font-bold text-slate-700">{targetMember?.replay_lag ?? '—'}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">Current Leader</span><span className="font-bold text-indigo-600">{leader || '—'}</span></div>
        </div>
      ) : spec.needsTarget && (
        <div className="mb-3">
          <label className="block text-[12px] font-bold text-slate-500 mb-1.5">Target</label>
          <div className="space-y-1.5">
            {pool.map((m) => (
              <label key={m.member_name} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-[12px] cursor-pointer hover:bg-slate-50">
                <input type="radio" name="target" checked={target === m.member_name} onChange={() => setTarget(m.member_name)} />
                <span className="font-bold text-slate-700">{m.member_name}</span>
                <span className="text-slate-400">{m.role} · {m.patroni_state} · lag {m.replay_lag ?? '—'}</span>
              </label>
            ))}
            {pool.length === 0 && <p className="text-[12px] text-slate-400">No eligible target available right now.</p>}
          </div>
        </div>
      )}

      {!isCurrentNodeAction && targetMember && (
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-[11px] text-slate-500 mb-3">
          Current role: {targetMember.role} · State: {targetMember.patroni_state} · Lag: {targetMember.replay_lag ?? '—'}
        </div>
      )}

      {/* AI Pre-check (§3B) — scoped to Restart Patroni only, per spec; advisory
          only, never executes anything itself */}
      {isCurrentNodeAction && target && (
        <div className="mb-3">
          {!aiCheck && (
            <button onClick={runAiPrecheck} type="button"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-[11px] font-black">
              ✨ AI Pre-check
            </button>
          )}
          {aiCheck?.loading && <p className="text-[11px] text-slate-400 mt-1.5">Running AI pre-check…</p>}
          {aiCheck && !aiCheck.loading && (
            aiCheck.err
              ? <p className="text-[11px] text-amber-600 mt-1.5">{aiCheck.err}</p>
              : <AiPrecheckResult data={aiCheck.data} />
          )}
        </div>
      )}

      <label className="block text-[12px] font-bold text-slate-500 mb-1">Confirm your password</label>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus
        className="w-full h-10 px-3 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:border-indigo-400" />

      {progress && <p className="text-[12px] text-indigo-600 font-semibold mt-3">{progress}</p>}
      {error && <p className="text-[12px] text-red-600 font-semibold mt-3">{error}</p>}
    </Dialog>
  );
}

function AiPrecheckResult({ data }) {
  if (!data) return null;
  const REC = {
    SAFE_TO_RESTART: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', label: 'SAFE TO RESTART' },
    CAUTION: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', label: 'CAUTION' },
    NOT_RECOMMENDED: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', label: 'NOT RECOMMENDED' },
  };
  const r = REC[data.recommendation] || REC.CAUTION;
  return (
    <div className={`mt-1.5 rounded-xl border p-3 ${r.bg} ${r.border}`}>
      <p className={`text-[12px] font-black ${r.text}`}>{r.label}</p>
      {data.reason && <p className="text-[11px] text-slate-600 mt-1">{data.reason}</p>}
      {Array.isArray(data.what_to_check_first) && data.what_to_check_first.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {data.what_to_check_first.map((item, i) => (
            <li key={i} className="text-[11px] text-slate-500 flex gap-1.5">
              <span>·</span><span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Polls /status until the reinitialized member reaches 'streaming', or times out.
 * Never reports success just because the command was accepted (§13). */
async function pollUntilHealthy(connId, memberName, setProgress, timeoutMs = 120000) {
  const steps = ['Reinitializing', 'Base backup / clone', 'Starting', 'Streaming', 'Healthy'];
  const start = Date.now();
  let stepIdx = 0;
  while (Date.now() - start < timeoutMs) {
    setProgress(`${steps[Math.min(stepIdx, steps.length - 2)]}…`);
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const { data } = await client.get(`${base(connId)}/status`);
      const m = data.members?.find((mm) => mm.member_name === memberName);
      if (m?.patroni_state === 'streaming' && m.node_health === 'HEALTHY') {
        setProgress('Healthy'); return;
      }
    } catch { /* keep polling */ }
    stepIdx++;
  }
  setProgress('Still in progress — check Patroni Status for the latest state.');
}

/** Polls /status after a Restart Patroni action (§2E) — walks through the real
 * recovery sequence (Patroni restarting → API available → PostgreSQL available
 * → [replica] streaming → lag 0 → Restart Successful) and only ever reports
 * success once the target node is genuinely healthy again, never on POST-accepted alone. */
async function pollRestartVerification(connId, memberName, expectedRole, setProgress, timeoutMs = 120000) {
  setProgress('Restarting…');
  const isReplica = (expectedRole || '').toLowerCase() !== 'leader';
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 2000));
  while (Date.now() - start < timeoutMs) {
    try {
      const { data } = await client.get(`${base(connId)}/status`);
      const m = data.members?.find((mm) => mm.member_name === memberName);
      if (!m || !m.patroni_running) {
        setProgress('Patroni restarting…');
      } else {
        setProgress('Patroni API available');
        if (m.node_health === 'CRITICAL') {
          setProgress('Patroni API available — waiting for PostgreSQL…');
        } else {
          setProgress('PostgreSQL available');
          if (isReplica && !m.wal_receiver_streaming) {
            setProgress('PostgreSQL available — waiting for replica streaming…');
          } else {
            if (isReplica) setProgress('Replica streaming');
            const lag = m.replay_lag;
            if (isReplica && lag != null && lag !== 0) {
              setProgress('Replica streaming — waiting for lag to reach 0…');
            } else {
              if (isReplica) setProgress('Lag 0');
              if (m.node_health === 'HEALTHY') {
                setProgress('Restart Successful');
                return;
              }
            }
          }
        }
      }
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  setProgress('Still in progress — check Patroni Status for the latest state.');
}
