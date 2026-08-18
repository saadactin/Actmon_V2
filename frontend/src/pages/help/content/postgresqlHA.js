/**
 * PostgreSQL Replication & Patroni HA — deep chapter.
 *
 * Populates the shared DOCS object (imported from ../helpContent) the same
 * way every existing chapter does. Content is grounded directly in
 * PostgreSQLDashboard.jsx's Replication tab and PatroniPanel.jsx — every tab,
 * button, badge, and confirmation string quoted here was read from that code,
 * not invented. Verified against the live app during this documentation pass.
 */
import { DOCS, icon, figure } from '../helpContent';

export const PG_HA_TOPICS = [
  ['pg-patroni-overview', 'Replication & HA Overview'],
  ['pg-replication-concepts', 'Replication Concepts (LSN, WAL, Timeline)'],
  ['pg-patroni-detection', 'Patroni Detection & the Two Views'],
  ['pg-patroni-tabs', 'The Patroni Console (10 Tabs)'],
  ['pg-patroni-topology', 'Topology & Cascading Replicas'],
  ['pg-patroni-actions', 'Patroni Recovery Actions'],
  ['pg-patroni-config', 'Patroni Configuration & patroni.yml'],
  ['pg-patroni-diagnosis', 'AI Pre-Check & Recovery Diagnosis'],
  ['pg-replication-raw', 'Raw pg_stat_replication (No Patroni)'],
  ['pg-ha-troubleshooting', 'Replication & HA Troubleshooting'],
];

DOCS['pg-patroni-overview'] = {
  title: 'Replication & HA Overview',
  dek: 'What this chapter covers, and how it relates to the PostgreSQL Dashboard\'s Replication tab.',
  crumbs: ['ActMon Documentation', 'Database', 'PostgreSQL Replication & Patroni HA', 'Overview'],
  module: 'Database', status: 'Complete',
  body: `
    <p>Every PostgreSQL connection's dashboard has a <strong>Replication</strong> tab
    (<code>/postgresql-dashboard/:id/replication</code>). What renders inside it depends entirely on whether
    ActMon detects <a href="https://patroni.readthedocs.io" target="_blank" rel="noreferrer">Patroni</a> managing
    that cluster:</p>
    <ul>
      <li><b>Patroni detected</b> — the tab is replaced entirely by a 10-tab Patroni console with real HA actions
      (switchover, failover, reinitialize, restart, and more). This is the deep, operational surface this chapter
      mostly covers.</li>
      <li><b>Patroni not detected</b> — PostgreSQL's own raw <code>pg_stat_replication</code>/WAL-receiver data
      renders instead: read-only, no HA actions, but still a genuinely rich replication view.</li>
    </ul>
    <p>ActMon never mixes the two views on one page — a cluster is either Patroni-managed (get the console) or
    plain streaming replication (get the raw view), never both at once.</p>
    <div class="tip"><b>Read this chapter in order</b>${icon('tip', 14)}<span>
    <button onclick="go('pg-replication-concepts')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Replication Concepts</button>
    first if terms like LSN, WAL, or timeline are new to you — every later topic in this chapter uses them without
    re-explaining.</span></div>
    <div class="tblwrap"><table class="doc">
      <tr><th>Topic</th><th>What it covers</th></tr>
      <tr><td><button onclick="go('pg-replication-concepts')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Replication Concepts</button></td><td>LSN, WAL, timeline, streaming, lag, leader/replica, cascading — the vocabulary every other topic assumes.</td></tr>
      <tr><td><button onclick="go('pg-patroni-detection')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Patroni Detection</button></td><td>How ActMon decides which of the two views to show, and what the fallback message looks like.</td></tr>
      <tr><td><button onclick="go('pg-patroni-tabs')" style="all:unset;cursor:pointer;color:var(--accent-ink)">The Patroni Console</button></td><td>All 10 tabs: Overview, Patroni Status, Topology, Replication, Replication Slots, Configuration, patroni.yml, Recovery, Logs, History.</td></tr>
      <tr><td><button onclick="go('pg-patroni-topology')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Topology & Cascading</button></td><td>How the topology diagram is built from each replica's own resolved upstream — not a fixed star shape.</td></tr>
      <tr><td><button onclick="go('pg-patroni-actions')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Recovery Actions</button></td><td>Restart/Reload Patroni, Reinitialize Replica, Switchover, Failover, Pause/Resume HA — exact risk and confirmation text for each.</td></tr>
      <tr><td><button onclick="go('pg-patroni-config')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Configuration & patroni.yml</button></td><td>Dynamic Config vs. patroni.yml, validation, automatic backup/rollback on a failed apply.</td></tr>
      <tr><td><button onclick="go('pg-patroni-diagnosis')" style="all:unset;cursor:pointer;color:var(--accent-ink)">AI Pre-Check & Diagnosis</button></td><td>The advisory-only AI check before a restart, and the Recovery tab's per-member diagnosis.</td></tr>
      <tr><td><button onclick="go('pg-replication-raw')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Raw pg_stat_replication</button></td><td>What you see when Patroni isn't managing the cluster.</td></tr>
      <tr><td><button onclick="go('pg-ha-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Troubleshooting</button></td><td>Replica Not Streaming, Replication Lag, Patroni Warning, Patroni API Unavailable, Replication Slot confusion.</td></tr>
    </table></div>
  `,
};

DOCS['pg-replication-concepts'] = {
  title: 'Replication Concepts (LSN, WAL, Timeline)',
  dek: 'The vocabulary behind every replication screen in ActMon, explained in plain language.',
  crumbs: ['ActMon Documentation', 'Database', 'PostgreSQL Replication & Patroni HA', 'Replication Concepts'],
  module: 'Database', status: 'Complete',
  body: `
    <p>PostgreSQL replication works by streaming a continuous log of every change to the database — the
    <b>Write-Ahead Log (WAL)</b> — from a <b>leader</b> to one or more <b>replicas</b>, which replay it to stay
    in sync. These terms appear throughout the Patroni console and the raw replication view.</p>
    <h2>Leader / Replica (and Primary / Standby)</h2>
    <p>The node accepting writes is the <b>leader</b> (Patroni's term) or <b>primary</b> (plain PostgreSQL's
    term) — ActMon's screens use whichever term the underlying view actually reports: the Patroni console
    consistently says <b>Leader</b>/<b>Replica</b>/<b>Cascading Replica</b>; the raw (non-Patroni) view
    consistently says <b>Primary Server</b>/<b>Standby Replica</b>. Both mean the same thing — don't expect the
    two vocabularies to appear mixed on one screen.</p>
    <h2>WAL — Write-Ahead Log</h2>
    <p>Every change to the database is first written to the WAL before it's applied — this is what makes crash
    recovery and replication both possible. A replica's job is to receive WAL segments from the leader and
    <em>replay</em> them locally. <code>wal_level</code>, <code>WAL Retained</code>, and <code>WAL Receiver</code>
    all refer to this same log.</p>
    <h2>LSN — Log Sequence Number</h2>
    <p>An LSN is a byte-offset position <em>within</em> the WAL — think of it as a bookmark. Comparing two nodes'
    LSNs tells you exactly how far apart they are. ActMon shows several LSN values, each meaning something
    slightly different:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Label</th><th>Meaning</th></tr>
      <tr><td><code>Sent LSN</code> / <code>Current WAL</code></td><td>How far the leader has written, as seen from the leader.</td></tr>
      <tr><td><code>Receive LSN</code> / <code>Received LSN</code></td><td>How far a replica has received bytes over the network — not yet necessarily applied.</td></tr>
      <tr><td><code>Replay LSN</code> / <code>Last Replay LSN</code></td><td>How far a replica has actually replayed (applied) into its own data files — this is what read queries on that replica actually see.</td></tr>
      <tr><td><code>Restart LSN</code></td><td>The oldest WAL position a replication slot still needs — determines how much WAL the leader must retain for that slot.</td></tr>
      <tr><td><code>Confirmed Flush</code></td><td>The position a replica has told the leader it has safely flushed to disk.</td></tr>
    </table></div>
    <h2>Replication Lag</h2>
    <p>The gap between the leader's position and a replica's position, shown two ways:</p>
    <ul>
      <li><b>Byte lag</b> (e.g. <code>Total Byte Lag</code>, <code>Max Byte Lag</code>) — how many bytes of WAL the replica hasn't caught up on yet. Color-coded: 0&nbsp;B is healthy (emerald), under 1&nbsp;MB is a caution yellow, under 10&nbsp;MB is orange, 10&nbsp;MB or more is red.</li>
      <li><b>Time lag</b> (<code>Write Lag</code>, <code>Flush Lag</code>, <code>Apply Lag</code>, <code>Replay Lag</code>) — how many milliseconds behind the replica is at each stage of processing.</li>
    </ul>
    <div class="tip"><b>A little lag is normal</b>${icon('tip', 14)}<span>Streaming replication is asynchronous by
    default — some lag is expected, especially under heavy write load or across a slower network link. What
    matters is whether it's <em>growing</em> (a real problem) or holding roughly steady (normal).</span></div>
    <h2>Streaming</h2>
    <p><b>Streaming</b> means a replica's WAL receiver process is actively connected to the leader and pulling
    WAL in real time. <b>Not Streaming</b> means that connection isn't currently active — the replica may still
    be catching up from archived WAL, or the connection may genuinely be down. ActMon's Patroni console and raw
    view both show this as an explicit badge rather than leaving you to infer it from lag numbers alone.</p>
    <h2>Timeline</h2>
    <p>Every time a replica is promoted to leader (via failover or switchover), PostgreSQL starts a new
    <b>timeline</b> — a new branch of history. All members of a healthy cluster should report the same timeline
    number; a replica stuck on an old timeline after a failover is a real problem (it means it never followed the
    promotion) and is exactly what the <button onclick="go('pg-ha-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Troubleshooting</button>
    topic's "Replica Not Streaming" scenario covers.</p>
    <h2>Cascading Replication</h2>
    <p>A replica can itself act as the upstream source for other replicas, instead of every replica connecting
    directly to the leader:</p>
    <pre style="background:var(--surface-sunken);border:1px solid var(--border);border-radius:var(--radius-md);padding:0.875rem 1rem;font-family:var(--font-mono);font-size:0.78rem;line-height:1.7;overflow-x:auto;max-width:70ch;color:var(--fg-muted)">Leader
   │
   ├── Replica 1
   │
   └── Replica 2 (cascading)
          │
          └── Replica 3 ── streams from Replica 2, not the Leader</pre>
    <p>ActMon's topology view builds this shape from each replica's own <em>actually resolved</em> upstream
    (read from that replica's <code>pg_stat_wal_receiver</code>) — never assumed. A cascading replica is labeled
    <b>Cascading Replica</b> with a <code>from {upstream}</code> annotation, and its replication slot on the
    upstream node is labeled a <b>Cascading / Reserved Slot</b> rather than treated as a broken/unused one — see
    <button onclick="go('pg-patroni-topology')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Topology & Cascading Replicas</button>.
    Use cascading when a leader is under heavy load and shouldn't have to stream to every replica directly, or
    when replicas span multiple sites/regions and you want cross-region traffic to happen once, not per-replica.</p>
    <h2>Replication Slots</h2>
    <p>A replication slot is a promise the leader makes to a specific consumer: "I will not remove WAL this
    consumer still needs, even if that consumer disconnects for a while." This protects a replica from ever
    falling so far behind that the WAL it needs has already been deleted — but it comes with a real trade-off:
    a slot with no connected consumer causes the leader to retain WAL indefinitely, which can fill its disk.
    ActMon's Replication Slots panel explicitly separates upstream-replication slots from cascading/reserved
    ones, and states outright: <em>"Never used as evidence of a health problem — a slot with no consumer is
    reserved capacity, not broken replication."</em></p>
    <h2>Synchronous vs. Asynchronous</h2>
    <p><b>Asynchronous</b> (the default) means the leader confirms a write as soon as it's committed locally,
    without waiting for any replica to acknowledge it — fast, but a replica can lag and a leader failure can lose
    the most recent transactions. <b>Synchronous</b> means the leader waits for at least one named replica to
    confirm before acknowledging the write — safer against data loss, slower under load. ActMon surfaces this via
    the <code>synchronous_commit</code> and <code>synchronous_standby_names</code> configuration values and the
    per-replica <b>sync-state</b> badge (<code>sync</code> / <code>async</code> / <code>quorum</code> /
    <code>potential</code>) on the raw replication view.</p>
    <h2>Failover vs. Switchover</h2>
    <p>Both end with a different node becoming leader — the difference is <em>why</em> and <em>how safely</em>:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th></th><th>Switchover</th><th>Failover</th></tr>
      <tr><td>When</td><td>Planned — the current leader is healthy but you want to move leadership (maintenance, rebalancing).</td><td>Emergency — the current leader is unavailable or unsafe to keep serving.</td></tr>
      <tr><td>Data safety</td><td>Graceful handoff to a caught-up replica — normally no data loss.</td><td>Forces a candidate to become leader — potential data loss depending on how caught-up it was.</td></tr>
      <tr><td>Disruption</td><td>Brief write unavailability (typically a few seconds).</td><td>Was already unavailable (that's why you're failing over).</td></tr>
    </table></div>
    <p>Full detail on triggering either from ActMon in <button onclick="go('pg-patroni-actions')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Patroni Recovery Actions</button>.</p>
  `,
};

DOCS['pg-patroni-detection'] = {
  title: 'Patroni Detection & the Two Views',
  dek: 'How ActMon decides whether to show the Patroni console or the raw pg_stat_replication view.',
  crumbs: ['ActMon Documentation', 'Database', 'PostgreSQL Replication & Patroni HA', 'Detection'],
  module: 'Database', status: 'Complete',
  body: `
    <p>Opening the Replication tab (<code>/postgresql-dashboard/:id/replication</code>) always calls
    <code>GET /connections/postgresql/:id/patroni/status</code> first, polled every 12 seconds.</p>
    <ul>
      <li>If the response reports <code>patroni_detected: true</code>, the entire tab is replaced by the
      10-tab Patroni console — the raw <code>pg_stat_replication</code> view is suppressed completely, so you
      never see the two mixed together on one long page.</li>
      <li>If <code>patroni_detected</code> is false, a message renders instead: <em>"Patroni not detected on this
      connection — showing plain PostgreSQL replication data below"</em> (or the backend's own more specific
      reason), and the raw replication view (see
      <button onclick="go('pg-replication-raw')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Raw pg_stat_replication</button>)
      renders below it.</li>
    </ul>
    <div class="tip"><b>Nothing to configure</b>${icon('tip', 14)}<span>Detection is automatic — there is no
    setting to tell ActMon "this is a Patroni cluster." If Patroni is genuinely running and reachable on the
    connection's host, it will be detected; if the message above appears unexpectedly for a cluster you know runs
    Patroni, check that Patroni's own REST API is reachable from wherever ActMon's collector runs.</span></div>
    <h2>Cluster health banner</h2>
    <p>When Patroni is detected, the console header always shows a cluster-wide health badge:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Badge</th><th>Meaning</th></tr>
      <tr><td><span class="pill good">HEALTHY</span></td><td>Every member is reachable and in the expected state.</td></tr>
      <tr><td><span class="pill warn">WARNING</span></td><td>Something is off — check the Patroni Status tab for which member and why.</td></tr>
      <tr><td><span class="pill crit">DEGRADED</span></td><td>A more serious problem — typically a replica not streaming or unreachable.</td></tr>
      <tr><td><span class="pill crit">CRITICAL</span></td><td>The most severe state — often no confirmed healthy leader.</td></tr>
    </table></div>
    <p>A separate <b>HA PAUSED</b> badge appears whenever Patroni's automatic HA management has been paused (see
    <button onclick="go('pg-patroni-actions')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Pause/Resume Patroni</button>)
    — this is independent of cluster health: a paused cluster can still be perfectly healthy, it just won't
    fail over automatically if something goes wrong. The header subtitle line always summarizes:
    <code>Cluster: {scope} · Leader: {leader} · {healthy}/{total} healthy · {streaming}/{replica_count}
    streaming</code>.</p>
  `,
};

DOCS['pg-patroni-tabs'] = {
  title: 'The Patroni Console (10 Tabs)',
  dek: 'What each of the ten tabs inside the Patroni console actually shows.',
  crumbs: ['ActMon Documentation', 'Database', 'PostgreSQL Replication & Patroni HA', 'Patroni Console'],
  module: 'Database', status: 'Complete',
  body: `
    <p>When Patroni is detected, the Replication tab becomes a 10-tab console of its own:
    <b>Overview, Patroni Status, Topology, Replication, Replication Slots, Configuration, patroni.yml, Recovery,
    Logs, History</b>.</p>
    <h2>Overview</h2>
    <p>Six tiles — Cluster Health, Leader, Nodes (healthy/total), Replicas (streaming/total), Replication Lag
    (ms), Timeline, and Patroni API status (Healthy/Unknown) — plus a compact version of the Topology view and
    quick-action buttons (View Topology, View History, Replication Detail, and conditionally Switchover).</p>
    <h2>Patroni Status</h2>
    <p>A per-node member table — the most detail-dense view in the console: Member, Host, Role
    (<span class="pill neutral">LEADER</span> / <span class="pill neutral">REPLICA</span> /
    <span class="pill neutral">CASCADING REPLICA</span>, with <code>from {upstream}</code> for cascading
    members), State, Timeline, Receive LSN, Receive Lag, Replay LSN, Replay Lag, Health, Patroni API
    (<span class="pill good">Healthy</span> / <span class="pill crit">Unreachable</span>), and Last Updated. A
    node filter and an "Auto Refresh" checkbox sit above it. If Patroni reports a member that isn't registered as
    an OS server in ActMon, the table warns about it explicitly rather than silently omitting it.</p>
    <h2>Topology</h2>
    <p>A visual tree of the cluster — see
    <button onclick="go('pg-patroni-topology')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Topology & Cascading Replicas</button>
    for the full detail on how it's built.</p>
    <h2>Replication</h2>
    <p>Upstream-replication-only detail (deliberately never local slot detail — that's the next tab). A leader
    banner states the streaming replica count; each replica gets a card with Upstream, WAL Receiver status
    (Active/Not connected), Receive LSN, Replay LSN, Receive Lag, Replay Lag, Lag in bytes, Timeline, and Health.
    Status badge is one of <span class="pill good">Streaming</span>, <span class="pill crit">Unreachable</span>,
    or <span class="pill warn">Not Streaming</span>.</p>
    <h2>Replication Slots</h2>
    <p>If the current node can't be reached for slot data, an amber banner explains why with the backend's own
    summary text. Otherwise, an upstream-replication banner (green if this node is itself streaming, red if not
    — explicitly scoped as <em>"This node's OWN stream... see the Replication tab for full detail"</em>) sits
    above the actual local-slots table: Slot Name, Type, Plugin, Active/Unused-Cascading badge, Restart LSN,
    Retained WAL, Database, and Purpose (Upstream Replication Slot vs. Cascading/Reserved Slot). The panel states
    directly that an unused cascading slot is <em>never</em> evidence of a problem.</p>
    <h2>Configuration</h2>
    <p>Two sub-tabs, never mixed: <b>Dynamic Config</b> (TTL, Loop Wait, Retry Timeout, Max Lag on Failover, plus
    a raw JSON editor) and <b>PostgreSQL Config</b> (read-only, searchable <code>pg_settings</code> table). Full
    detail, including the diff-preview-before-apply flow, in
    <button onclick="go('pg-patroni-config')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Configuration & patroni.yml</button>.</p>
    <h2>patroni.yml</h2>
    <p>Direct view/edit of the node's static config file, with an access-method badge (<code>Direct read</code>
    vs. <code>via sudo</code>), search, and a syntax-highlighted YAML editor. Saving validates, keeps an automatic
    backup, and restarts Patroni on that node to apply the change — with an automatic rollback if it doesn't come
    back healthy within 60 seconds. Full detail in
    <button onclick="go('pg-patroni-config')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Configuration & patroni.yml</button>.</p>
    <h2>Recovery</h2>
    <p>Houses the per-member <b>Diagnosis Panel</b> (checklist-driven, advisory-only — see
    <button onclick="go('pg-patroni-diagnosis')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">AI Pre-Check & Recovery Diagnosis</button>)
    and is where the Actions menu's Diagnostics group (Patroni Status, Patroni History, Cluster Health Check)
    lands.</p>
    <h2>Logs</h2>
    <p>Per-node/level/time-range (last 30 min / 2 hours / 24 hours) filtering over Patroni's own service log,
    with free-text search. Suspicious lines — matching patterns like "no route to host," "wal segment already
    removed," "timeline mismatch," "primary unavailable," "wal receiver stopped," "reinitializ," or "leader
    changed" — are highlighted in red automatically. Level badges: <span class="pill crit">FATAL/CRITICAL/ERROR</span>,
    <span class="pill warn">WARNING</span>, <span class="pill neutral">INFO</span>, <span class="pill neutral">DEBUG</span>.</p>
    <h2>History</h2>
    <p>Three tables: <b>ActMon Action History</b> (every action ActMon itself triggered, with Success/Failed
    result), <b>Timeline History</b> (Patroni's own <code>patronictl history</code> — Timeline, LSN, Reason,
    Timestamp, New Leader), and <b>Leader Changes — Last 24h</b> (ActMon-collected).</p>
  `,
};

DOCS['pg-patroni-topology'] = {
  title: 'Topology & Cascading Replicas',
  dek: 'How ActMon draws the cluster topology diagram, and how it represents cascading replication.',
  crumbs: ['ActMon Documentation', 'Database', 'PostgreSQL Replication & Patroni HA', 'Topology'],
  module: 'Database', status: 'Complete',
  body: `
    <p>The Topology tab renders a tree built from <em>each replica's own actually-resolved upstream</em> — read
    from that specific replica's own reported connection state — never a fixed, assumed star shape where every
    replica reports directly to the leader. This is why the diagram correctly shows cascading configurations
    rather than flattening them.</p>
    ${figure('PostgreSQL Replication topology', 'Use the topology view to identify the current leader, every replica, its streaming state, and — for a cascading replica — which node it actually streams from.')}
    <h2>What each node box shows</h2>
    <ul>
      <li>Role label — <b>Leader</b>, <b>Replica</b>, or <b>Cascading Replica</b> (never "Missing" unless a
      registered member genuinely can't be reached).</li>
      <li>Member name and IP address.</li>
      <li>Patroni state.</li>
      <li>Streaming status — <b>Streaming</b>, or <b>Not Streaming · Lag {bytes}</b> if behind.</li>
      <li>For a cascading node specifically: <code>from {upstream}</code>, naming the actual replica it streams
      from (not the leader).</li>
      <li>Timeline number.</li>
      <li>A health badge.</li>
    </ul>
    <p>Any replica whose upstream couldn't be resolved is placed in a separate <b>"Upstream unresolved"</b>
    bucket rather than guessed into the wrong branch of the tree.</p>
    <h2>Why cascading matters operationally</h2>
    <p>A cascading replica reduces load on the leader (it only has to stream to its direct downstream replicas,
    not every replica in the cluster) and can reduce cross-region network cost when replicas span multiple
    sites. The trade-off: a cascading replica's own replicas depend on <em>it</em> staying up and streaming — if
    the cascading node itself falls behind or disconnects, everything downstream of it falls behind too, even
    though the leader itself is perfectly healthy. When investigating lag on a replica, always check the
    Topology tab first to see whether it streams directly from the leader or from another replica — the fix is
    different in each case.</p>
    <div class="warnbox"><b>A cascading slot looking "unused" is expected</b>${icon('alerts', 14)}<span>On the
    Replication Slots tab, the slot a cascading node's downstream replica uses shows as a
    <b>Cascading / Reserved Slot</b>, and the panel explicitly warns not to treat "unused" cascading slots as a
    health problem — see <button onclick="go('pg-patroni-tabs')" style="all:unset;cursor:pointer;color:var(--fg);text-decoration:underline">the Replication Slots tab detail</button>.</span></div>
  `,
};

DOCS['pg-patroni-actions'] = {
  title: 'Patroni Recovery Actions',
  dek: 'Every HA action available from the Patroni Actions menu — what it does, when to use it, and its exact risk.',
  crumbs: ['ActMon Documentation', 'Database', 'PostgreSQL Replication & Patroni HA', 'Recovery Actions'],
  module: 'Database', status: 'Complete',
  body: `
    <p>The Patroni console's top-right <b>Actions</b> menu groups every available action. Every single one
    requires <b>password re-authentication</b> before it fires — you cannot trigger any Patroni action from
    ActMon without re-entering your account password in the confirmation dialog. Disabled menu items always show
    a tooltip explaining why (missing permission, no eligible replica, HA already paused, etc.), never a silently
    greyed-out control.</p>

    <h2>Restart Patroni</h2>
    <p><b>Purpose:</b> Restarts the Patroni OS service on the currently-viewed node (the systemd unit) —
    <em>not</em> PostgreSQL itself.</p>
    <p><b>When to use:</b> Patroni is unresponsive, or a static <code>patroni.yml</code> change needs the service
    reloaded.</p>
    <p><b>Risk:</b> Temporarily interrupts Patroni's management of this node; PostgreSQL may keep running
    depending on its state at the time.</p>
    <p><b>What happens:</b> An <b>AI Pre-Check</b> button (advisory only) is available for this action
    specifically — see <button onclick="go('pg-patroni-diagnosis')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">AI Pre-Check &amp; Recovery Diagnosis</button>.
    After confirming, ActMon polls through the real recovery sequence and reports each stage as it happens:
    "Patroni restarting…" → "Patroni API available" → "PostgreSQL available" → (if this node is a replica)
    "Replica streaming" → "Lag 0" → <b>"Restart Successful"</b>. It never reports success just because the HTTP
    request was accepted — only once the node is verified healthy again. Times out after 120 seconds with
    <em>"Still in progress — check Patroni Status for the latest state."</em></p>
    <p><b>Required permission:</b> <code>restart</code>.</p>

    <h2>Reload Patroni</h2>
    <p><b>Purpose:</b> Asks Patroni to re-read configuration that doesn't require a full restart.</p>
    <p><b>Risk:</b> Minimal — no service interruption.</p>
    <p><b>Required permission:</b> <code>restart</code>.</p>

    <h2>Reinitialize Replica</h2>
    <p><b>Purpose:</b> Rebuilds the selected replica from a fresh base backup of the current leader.</p>
    <p><b>When to use:</b> The replica is not streaming <em>and</em> the WAL it needs has already been removed
    from the leader — at that point it can no longer catch up by streaming and must be rebuilt from scratch.</p>
    <div class="imp"><b>Destructive</b>${icon('alerts', 14)}<span>The confirmation dialog states plainly:
    <em>"Reinitializing the replica may remove its existing PostgreSQL data and rebuild it from the current
    leader."</em> Only use this when the replica is genuinely unable to catch up any other way.</span></div>
    <p><b>What happens:</b> ActMon polls the target node until it reaches <code>streaming</code> + <code>HEALTHY</code>,
    reporting progressive stages: Reinitializing → Base backup / clone → Starting → Streaming → Healthy.</p>
    <p><b>Required permission:</b> <code>execute</code>, and at least one replica must exist (otherwise the menu
    item is disabled with a tooltip explaining there's nothing to reinitialize).</p>

    <h2>Switchover</h2>
    <p><b>Purpose:</b> Gracefully hands leadership to a healthy, caught-up replica.</p>
    <p><b>When to use:</b> Planned maintenance on the current leader, or rebalancing load across nodes.</p>
    <p><b>Risk:</b> Brief write unavailability during the handoff — typically a few seconds.</p>
    <p>Disabled (with a tooltip) if there is no eligible replica to switch to, or if HA is currently paused.</p>

    <h2>Failover</h2>
    <p><b>Purpose:</b> Forces a candidate replica to become leader.</p>
    <p><b>When to use:</b> <strong>Only</strong> when the current leader is unavailable or cannot safely
    continue serving as leader — this is an emergency action, not a routine one.</p>
    <div class="imp"><b>Potential data loss</b>${icon('alerts', 14)}<span>The confirmation dialog states, in full:
    <em>"Failover is an emergency operation — only use it when the current leader is unavailable or cannot
    safely serve as leader. Potential data loss may occur depending on replication state."</em> Unlike a
    switchover, there is no guarantee the candidate had received every transaction the old leader committed.</span></div>
    <p>Disabled (with a tooltip) if there's no eligible failover candidate.</p>

    <h2>Pause Patroni (HA)</h2>
    <p><b>Purpose:</b> Pauses Patroni's automatic HA management cluster-wide — Patroni stops taking any
    automatic action.</p>
    <p><b>Risk:</b> <em>"No automatic failover will happen while paused, even if the leader fails."</em> Use this
    deliberately (e.g. before manual maintenance you don't want Patroni to react to), not as a default state.</p>
    <p>Disabled if HA is already paused.</p>

    <h2>Resume Patroni (HA)</h2>
    <p><b>Purpose:</b> Resumes normal automatic HA management.</p>
    <p><b>Risk:</b> None — this restores the normal, safer state. Disabled if HA is not currently paused.</p>

    <div class="tblwrap"><table class="doc">
      <tr><th>Action</th><th>Destructive?</th><th>Confirmation text (exact)</th></tr>
      <tr><td>Restart Patroni</td><td>No</td><td>Temporarily interrupts Patroni management on this node.</td></tr>
      <tr><td>Reload Patroni</td><td>No</td><td>Minimal — no service interruption.</td></tr>
      <tr><td>Reinitialize Replica</td><td class="num"><span class="pill crit">Yes</span></td><td>May remove its existing PostgreSQL data and rebuild it from the current leader.</td></tr>
      <tr><td>Switchover</td><td>No (brief outage)</td><td>Brief write unavailability during the handoff.</td></tr>
      <tr><td>Failover</td><td class="num"><span class="pill crit">Yes</span></td><td>Emergency operation — potential data loss depending on replication state.</td></tr>
      <tr><td>Pause HA</td><td>No</td><td>No automatic failover will happen while paused.</td></tr>
      <tr><td>Resume HA</td><td>No</td><td>Restores normal automatic HA.</td></tr>
    </table></div>
  `,
};

DOCS['pg-patroni-config'] = {
  title: 'Patroni Configuration & patroni.yml',
  dek: 'Dynamic Config vs. the static patroni.yml file — how each is edited, validated, and rolled back.',
  crumbs: ['ActMon Documentation', 'Database', 'PostgreSQL Replication & Patroni HA', 'Configuration'],
  module: 'Database', status: 'Complete',
  body: `
    <p>The Configuration tab has two sub-tabs that ActMon deliberately never mixes: <b>Dynamic Config</b> and
    <b>PostgreSQL Config</b>. A separate console tab, <b>patroni.yml</b>, edits the static file directly. All
    three require the <code>edit</code> permission to modify (read access needs only <code>view</code>).</p>

    <h2>Dynamic Config</h2>
    <p>Known fields exposed directly — TTL (seconds), Loop Wait (seconds), Retry Timeout (seconds), Max Lag on
    Failover (bytes) — plus a raw JSON editor for anything not surfaced as its own field.</p>
    <p>Saving goes through <b>Validate &amp; Save</b>, which opens a confirmation dialog titled
    <b>"Apply Patroni Configuration"</b> showing a real diff (removed lines in red, added lines in green) before
    anything is written. On success: <em>"Configuration valid ✓ — applied through Patroni's own DCS-stored config
    API."</em> Every applied change (and every rollback) is recorded in the <b>Configuration History</b> panel
    below the editor, with a <b>"Restore this version"</b> link per row — with the caveat that this history
    <em>"only covers changes made through ActMon — not a universal record of every external edit."</em></p>

    <h2>PostgreSQL Config</h2>
    <p>Read-only. Reuses the same underlying config-detail data the plain PostgreSQL dashboard's own Config tab
    shows — a searchable, flat table of Parameter / Current Value / Unit / Context / Source, capped at the first
    300 rows.</p>

    <h2>patroni.yml</h2>
    <p>Edits the actual static file on a chosen node (a per-server selector lets you pick which node's file to
    view/edit). An access-method badge shows whether ActMon read it directly or <code>via sudo</code>. The
    editor has search, Copy, and Edit; saving triggers <b>Validate &amp; Save</b> (a danger-styled button) and a
    confirmation dialog titled <b>"Apply patroni.yml changes"</b>:</p>
    <div class="warnbox"><b>Exact confirmation text</b>${icon('alerts', 14)}<span><em>"Validation Result: YAML
    valid ✓. A backup of the current file is kept automatically (ownership/permissions preserved by the
    underlying write). Patroni will be restarted on this node to apply the change — if it doesn't come back up
    healthy within 60s, ActMon automatically rolls back to the backup and restarts again."</em></span></div>
    <p>This means a bad patroni.yml edit is <strong>self-healing</strong> — you don't need to manually recover a
    failed apply, ActMon does it for you within a minute. The write itself requires password confirmation, same
    as every recovery action.</p>
  `,
};

DOCS['pg-patroni-diagnosis'] = {
  title: 'AI Pre-Check & Recovery Diagnosis',
  dek: 'Two advisory-only features that help you decide whether an action is safe, and what\'s actually wrong with an unhealthy member.',
  crumbs: ['ActMon Documentation', 'Database', 'PostgreSQL Replication & Patroni HA', 'AI Pre-Check & Diagnosis'],
  module: 'Database', status: 'Complete',
  body: `
    <p>Two distinct, entirely advisory tools live in this part of the console — neither one ever takes an action
    by itself.</p>
    <h2>AI Pre-Check (Restart Patroni only)</h2>
    <p>A sparkle-icon <b>AI Pre-Check</b> button appears specifically on the Restart Patroni confirmation dialog
    — nowhere else. It calls a dedicated pre-check endpoint and returns one of three verdicts, plus a plain-text
    reason and a "what to check first" list:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Verdict</th><th>Meaning</th></tr>
      <tr><td><span class="pill good">SAFE TO RESTART</span></td><td>No obvious reason found not to proceed.</td></tr>
      <tr><td><span class="pill warn">CAUTION</span></td><td>Something worth reading before proceeding — check the reason text.</td></tr>
      <tr><td><span class="pill crit">NOT RECOMMENDED</span></td><td>The AI found a specific reason this restart could make things worse right now.</td></tr>
    </table></div>
    <div class="tip"><b>Advisory only</b>${icon('tip', 14)}<span>This verdict never blocks you from clicking
    Restart anyway — it's information to weigh, not a gate. Read the reason text; a "CAUTION" or "NOT
    RECOMMENDED" verdict is a prompt to double-check the cluster state yourself, not an automatic stop.</span></div>

    <h2>Recovery tab: per-member Diagnosis Panel</h2>
    <p>On the Recovery tab, selecting a specific unhealthy member and running its diagnosis calls
    <code>GET /connections/postgresql/:id/patroni/diagnose?member={name}</code>. This runs a fixed checklist
    against that one member (it never executes anything itself) and renders pass/fail chips per check, a
    plain-language <code>diagnosis</code> sentence, and a <code>recommendation</code>. If every check passes:
    <em>"All checks passed — this member looks healthy."</em></p>
    <p>Only if the backend includes a <code>recommended_action</code> in its response does a single action
    button appear — either <b>Reinitialize Replica</b> or <b>Restart Patroni</b> — and clicking it hands off to
    the exact same confirmation-dialog flow described in
    <button onclick="go('pg-patroni-actions')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Patroni Recovery Actions</button>.
    The diagnosis never runs an action on its own initiative — it only ever offers to open the same confirmation
    dialog a human would open manually.</p>
  `,
};

DOCS['pg-replication-raw'] = {
  title: 'Raw pg_stat_replication (No Patroni)',
  dek: 'What the Replication tab shows for a plain streaming-replication cluster with no Patroni.',
  crumbs: ['ActMon Documentation', 'Database', 'PostgreSQL Replication & Patroni HA', 'Raw View'],
  module: 'Database', status: 'Complete',
  body: `
    <p>When Patroni isn't detected, the Replication tab shows PostgreSQL's own replication state directly —
    read-only, with no HA action buttons anywhere on the page.</p>
    <h2>Role banner</h2>
    <p>A role banner up top reads either <b>"Primary Server"</b> (crown icon) with subtitle
    <em>"Streaming WAL to {n} replica(s) · {n} replication slot(s)"</em>, or <b>"Standby Replica"</b> (arrow icon)
    with a subtitle reflecting its actual state — <em>"Streaming WAL from upstream primary · {n}s behind / up to
    date"</em>, or <em>"WAL receiver not streaming"</em>, or <em>"WAL receiver not active · using archive
    recovery or upstream down."</em></p>
    <h2>On a primary</h2>
    <p>KPIs for Replicas count, Max Byte Lag, WAL Retained, and Sync count; a "Current WAL" bar with the LSN and
    a copy button; one card per connected replica (status icon, state badge, sync-state badge, byte-lag bar, full
    LSN grid with copy buttons, and a lag breakdown of Write/Flush/Apply lag). If no replica is connected at all:
    <em>"No Streaming Replicas — This primary has no connected standbys. Configure primary_conninfo on a standby
    and restart it."</em></p>
    <h2>On a standby</h2>
    <p>A "Behind Primary" KPI (seconds) and Cascade Slots count; a WAL Receiver detail panel (status badge, Primary
    Host/Port, Slot, Receive Start/Received/Latest End LSN, Receive/Replay delta, last message received time). If
    no receiver process is running: an explanatory note clarifies this can be entirely normal in a
    Patroni-managed cluster mid-reconnection — but remember, this whole raw view only ever renders when Patroni is
    <em>not</em> detected, so in practice seeing this message here means the connection genuinely has no active
    WAL receiver. A Recovery Configuration panel shows <code>primary_conninfo</code>,
    <code>primary_slot_name</code>, <code>recovery_target_timeline</code>, and related settings.</p>
    <h2>Shared panels (both roles)</h2>
    <p>Replication Slots (with the same "unused ≠ broken for cascading slots" caveat as the Patroni console),
    Replication Configuration (<code>wal_level</code>, <code>max_wal_senders</code>, <code>max_replication_slots</code>,
    <code>synchronous_commit</code>, <code>synchronous_standby_names</code>, and more), WAL Sender Processes, the
    raw <code>pg_stat_replication</code> table itself, Checkpoint &amp; BGWriter stats, WAL Generation
    (<code>pg_stat_wal</code>, PG14+), Replication Conflicts (standby only), and Publications/Subscriptions for
    logical replication.</p>
  `,
};

DOCS['pg-ha-troubleshooting'] = {
  title: 'Replication & HA Troubleshooting',
  dek: 'Practical answers for the most common PostgreSQL replication and Patroni problems.',
  crumbs: ['ActMon Documentation', 'Database', 'PostgreSQL Replication & Patroni HA', 'Troubleshooting'],
  module: 'Database', status: 'Complete',
  body: `
    <h2>PostgreSQL Replica Not Streaming</h2>
    <p><b>Symptoms:</b> A replica's status badge shows <span class="pill crit">Not Streaming</span> instead of
    <span class="pill good">Streaming</span>; byte lag is climbing instead of holding steady.</p>
    <p><b>Possible causes:</b> Network interruption between replica and its upstream (leader or, in a cascading
    setup, another replica); the leader has already removed WAL the replica still needs (no replication slot
    protecting it, or the slot's retained WAL was insufficient); the replica's WAL receiver process crashed; a
    firewall or security-group change blocked the replication port.</p>
    <p><b>How to verify:</b> Open the Patroni console's <b>Topology</b> tab first to confirm which node this
    replica actually streams from (its direct upstream may not be the leader — see
    <button onclick="go('pg-patroni-topology')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Topology &amp; Cascading Replicas</button>).
    Then check the <b>Logs</b> tab for that node — red-highlighted lines mentioning "wal segment already
    removed," "no route to host," or "wal receiver stopped" point straight at the cause.</p>
    <p><b>Resolution:</b> If it's a transient network issue, it will often self-resolve once connectivity is
    restored (watch the lag start shrinking). If the required WAL has genuinely been removed from the upstream,
    the replica cannot catch up by streaming — the only fix is
    <button onclick="go('pg-patroni-actions')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Reinitialize Replica</button>.</p>
    <p><b>Verification:</b> After reinitializing, poll the Patroni console (or just watch it — ActMon polls for
    you) until the node reaches <code>streaming</code> + <code>HEALTHY</code>.</p>
    <p><b>Prevention:</b> Keep a replication slot on the leader for any replica you expect to disconnect
    routinely (planned maintenance, cross-region links) so its required WAL is retained — but monitor leader disk
    space if you do, since an abandoned slot with no consumer retains WAL indefinitely (see the note in
    <button onclick="go('pg-patroni-tabs')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Replication Slots</button>).</p>

    <h2>Replication Lag (growing, not just present)</h2>
    <p><b>Symptoms:</b> Byte or time lag on a replica is increasing over successive refreshes, not holding
    roughly steady.</p>
    <p><b>Possible causes:</b> The replica's hardware (CPU/disk I/O) can't replay WAL as fast as the leader
    produces it; a long-running query on the replica is blocking WAL replay (<code>hot_standby_feedback</code>
    interactions); network bandwidth between leader and replica is saturated; the replica is a cascading node
    whose own upstream is itself lagging.</p>
    <p><b>How to verify:</b> Check the replica's host resource usage (CPU/disk) via its Infrastructure host
    detail page. On the Replication tab, compare Receive Lag (network) against Replay Lag (apply) — if receive
    lag is low but replay lag is high, the bottleneck is CPU/disk on the replica itself, not the network.</p>
    <p><b>Resolution:</b> Address the actual bottleneck (scale the replica's resources, kill the blocking query,
    or fix the network path). Lag caused by a slow cascading upstream requires fixing that upstream node first.</p>
    <p><b>Prevention:</b> Size replicas for the same write throughput as the leader, and monitor lag trend, not
    just its current value.</p>

    <h2>Patroni Warning / Degraded Cluster Health</h2>
    <p><b>Symptoms:</b> The cluster health badge shows <span class="pill warn">WARNING</span> or
    <span class="pill crit">DEGRADED</span> instead of <span class="pill good">HEALTHY</span>.</p>
    <p><b>How to verify:</b> Open <b>Patroni Status</b> — this is the single richest view for finding exactly
    which member and which field is the problem (role mismatch, unreachable Patroni API, a replica not
    streaming, timeline mismatch).</p>
    <p><b>Resolution:</b> Depends entirely on what Patroni Status reveals — see the specific scenario above that
    matches (Not Streaming, growing lag) or check <b>Logs</b> for the affected node.</p>

    <h2>Patroni API Unavailable</h2>
    <p><b>Symptoms:</b> A node's Patroni API column shows <span class="pill crit">Unreachable</span>; ActMon
    can't fetch fresh status for that node.</p>
    <p><b>Possible causes:</b> The Patroni service (not PostgreSQL) has stopped or crashed on that host; a
    firewall change blocked Patroni's REST API port; the host itself is unreachable (check its Infrastructure
    status first — if the host is offline, Patroni being unreachable is a symptom, not the root cause).</p>
    <p><b>Resolution:</b> If the host is otherwise healthy and only Patroni's API is unreachable, use
    <button onclick="go('pg-patroni-actions')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Restart Patroni</button>
    on that node once you've confirmed via its OS-level access (SSH/agent) that the Patroni process is actually
    down and safe to restart.</p>

    <h2>Replication Slot confusion ("why is this slot unused?")</h2>
    <p><b>Symptoms:</b> A replication slot shows as unused/inactive on the Replication Slots tab, and it looks
    alarming.</p>
    <p><b>Resolution:</b> First check its <b>Purpose</b> column. If it's marked <b>Cascading / Reserved Slot</b>,
    this is expected and not a problem — see
    <button onclick="go('pg-replication-concepts')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Replication Slots</button>
    in the Concepts topic. If it's marked <b>Upstream Replication Slot</b> and genuinely unused, check whether
    the consumer it was created for (a specific replica, a logical-replication subscriber) still exists — an
    orphaned slot for a decommissioned consumer should be dropped manually, since it will otherwise retain WAL on
    the leader forever and can eventually fill its disk.</p>
  `,
};
