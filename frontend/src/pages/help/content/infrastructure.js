/**
 * Infrastructure Monitoring chapter. Grounded in pages/infra/InfraPage.jsx and
 * InfraHostDetail.jsx — every action, warning string, and Agent/SSH surfacing
 * point quoted here was read directly from that code.
 */
import { DOCS, icon } from '../helpContent';

export const INFRA_TOPICS = [
  ['inf-overview', 'Infrastructure Overview'],
  ['inf-host-list', 'Host List'],
  ['inf-host-tabs', 'Host Detail — Tabs'],
  ['inf-actions', 'Host Actions'],
  ['inf-agent-vs-ssh', 'Agent vs. SSH on This Page'],
  ['inf-windows-linux', 'Windows vs. Linux Differences'],
  ['inf-permissions', 'Permissions'],
  ['inf-troubleshooting', 'Troubleshooting'],
  ['inf-reference', 'Infrastructure Reference'],
];

DOCS['inf-overview'] = {
  title: 'Infrastructure Overview',
  dek: 'What the Infrastructure module monitors, and how it relates to the Agents and Database modules.',
  crumbs: ['ActMon Documentation', 'Infrastructure', 'Overview'],
  module: 'Infrastructure', status: 'Complete',
  body: `
    <p>The Infrastructure module monitors the operating-system layer of every registered host — CPU, memory,
    disk, network, processes, services, and OS-level configuration — whether that host reports via an installed
    ActMon Agent or via SSH polling. It's reached from the top navigation bar's <b>Infrastructure</b> item,
    routed to <code>/infra</code>.</p>
    <div class="tip"><b>Same hosts, different lens</b>${icon('tip', 14)}<span>A host you see here is the same
    physical/virtual machine you'd see linked from a database connection's Server Information panel or from the
    Agents module — Infrastructure is the OS-level view of it; Agents is the collector-identity view; a
    database dashboard is the database-engine view. They share the same underlying <code>os_servers</code> row,
    not three separate inventories.</span></div>
    <h2>Key facts</h2>
    <ul>
      <li>Both collector types — ActMon Agent and SSH — write to the <em>same</em> ClickHouse-backed history
      table, so SSH-polled hosts get real persisted CPU/memory/disk history too, not just live snapshots.</li>
      <li>Several real, state-changing actions exist here: restart a service, reboot a host, end a process, edit
      a config file, edit network configuration, and manage firewall rules — all password re-authenticated.</li>
      <li>Some Network sub-modules are honestly labeled "coming soon" when the agent hasn't reported the
      relevant data yet (e.g. Wi-Fi with no adapter present, or real-time traffic before two samples exist) —
      this is a genuine incomplete-data state, not a hidden feature.</li>
    </ul>
  `,
};

DOCS['inf-host-list'] = {
  title: 'Host List',
  dek: 'The Infrastructure hosts list — status, collector type, and how a host becomes a detail page.',
  crumbs: ['ActMon Documentation', 'Infrastructure', 'Host List'],
  module: 'Infrastructure', status: 'Complete',
  body: `
    <p><code>/infra</code> (and its alias <code>/infra/hosts</code>) lists every registered host with its
    connectivity status, OS type, and collector type. A Fleet Overview donut chart breaks hosts down by
    <b>Collector</b> — ActMon Agent vs. SSH (poll) — so you can see at a glance how much of your fleet uses each
    method. Clicking a host opens its detail page at <code>/infra/:id</code>.</p>
  `,
};

DOCS['inf-host-tabs'] = {
  title: 'Host Detail — Tabs',
  dek: 'The nine tabs on a host\'s detail page.',
  crumbs: ['ActMon Documentation', 'Infrastructure', 'Host Detail Tabs'],
  module: 'Infrastructure', status: 'Complete',
  body: `
    <p>A host's detail page (<code>/infra/:id[/:tab]</code>) has nine tabs: <b>Overview, Ports, Processes,
    Storage, Network, Services, Diagnostics, IP Configuration, Config Files</b>.</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Tab</th><th>What it shows</th></tr>
      <tr><td>Overview</td><td>CPU/Memory/Disk trend charts (real persisted history, range 1h–7d with a granularity picker), a Process CPU-vs-Memory scatter, top processes by CPU/Memory, filesystem usage ranked bars (click to jump into File Explorer), a memory breakdown tile, a network summary tile, and a collapsible System Information panel (OS, kernel, architecture, hostname, virtualization, chassis, hardware vendor/model, firmware).</td></tr>
      <tr><td>Ports</td><td>Real listening-ports table — port, well-known service name, exposure badge ("All interfaces" / "Localhost"), process, PID — with an End Process action.</td></tr>
      <tr><td>Processes</td><td>Real process table (PID, User [Linux only], CPU%, Mem%, command) with an End Process action.</td></tr>
      <tr><td>Storage</td><td>Real filesystems table (mount, filesystem, size/used/available/use%) — a row click jumps to File Explorer at that mount.</td></tr>
      <tr><td>Network</td><td>A 14-module grid: Interface Details, Real-Time Traffic, Connection Statistics, Network Errors, Interfaces Table, DNS, Gateway, TCP/UDP, Open Ports, Bandwidth, Wi-Fi, Routing, ARP Table, Network Processes. Some modules honestly show "coming soon" when the agent hasn't reported enough data yet.</td></tr>
      <tr><td>Services</td><td>Real service inventory with Start/Stop/Restart actions.</td></tr>
      <tr><td>Diagnostics</td><td>Three live tools: Ping, TCP Port Test, DNS Lookup.</td></tr>
      <tr><td>IP Configuration</td><td>A 10-module grid: Interface/IPv4/IPv6/DNS/Advanced Configuration, IP Conflict Detection (from the ARP table), live ping-based Validation Checks, Export (JSON/CSV/Print), Edit Network Config, and Firewall.</td></tr>
      <tr><td>Config Files</td><td>A 19-module grid covering OS/Hardware/CPU/Memory/Disk/Network/IP/DNS/Routing/Firewall/SSH/Service/Process/NTP/Power/Database configuration — each routes to a real file/registry/command panel, or to the matching real tab (e.g. Service Configuration → Services tab).</td></tr>
    </table></div>
    <div class="tip"><b>Genuinely incomplete modules are labeled honestly</b>${icon('tip', 14)}<span>One Config
    Files module renders the literal note: <em>"Structured collection &amp; inline editing for this module is
    planned — the card is wired and ready to fill in."</em> This documentation reflects that same honesty — it
    is not treated as a real, finished feature.</span></div>
  `,
};

DOCS['inf-actions'] = {
  title: 'Host Actions',
  dek: 'Every real, state-changing action available on a host — exact warning text and API endpoint.',
  crumbs: ['ActMon Documentation', 'Infrastructure', 'Host Actions'],
  module: 'Infrastructure', status: 'Complete',
  body: `
    <p>Every action below requires password re-authentication (a <code>PasswordPrompt</code> modal —
    <em>"Confirm your password to run this command"</em>) before it executes.</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Action</th><th>Warning / confirmation copy</th><th>Risk</th></tr>
      <tr><td>Restart a service</td><td>Password re-auth only</td><td>Brief interruption to that one service</td></tr>
      <tr><td>Reboot host</td><td><em>"This will reboot the entire host. It will drop offline and return in a few minutes. All services on it restart."</em></td><td class="num"><span class="pill crit">High</span></td></tr>
      <tr><td>Start/Stop/Restart a specific service (Services tab)</td><td>Password re-auth; Stop is styled as a danger action</td><td>That service becomes unavailable while stopped/restarting</td></tr>
      <tr><td>End process (Ports/Processes tabs)</td><td>Password re-auth, danger styling, titled "End process {cmd} (PID {pid})"</td><td>Whatever that process was doing is interrupted immediately</td></tr>
      <tr><td>Edit &amp; save a file (File Explorer)</td><td><em>"Saved. A .actmon.bak backup was kept."</em></td><td>Low — a backup is always kept automatically</td></tr>
      <tr><td>Edit network config</td><td><em>"Saved. A .actmon.bak backup was kept. Restart networking to apply the change."</em> + a Restart Networking button</td><td>Networking briefly restarts on that host</td></tr>
      <tr><td>Firewall — Allow/Block/Add Rule/Remove</td><td>Applied via the host's own nftables <code>actmon</code> chain</td><td>Can affect connectivity to/from that host immediately</td></tr>
      <tr><td>Windows Registry write</td><td>Password-gated</td><td>Direct registry modification — depends entirely on the key</td></tr>
      <tr><td>Update Agent (Windows agent hosts only)</td><td>Password-gated, titled "Download the latest agent and upgrade in place"</td><td>Brief agent restart</td></tr>
    </table></div>
    <p>File browsing itself is read-only by default; on an SSH-registered host with no stored SSH credentials,
    the File Explorer shows <em>"SSH credentials needed for file browsing"</em> with an inline form (user/
    password/port) and a <b>"Save &amp; Browse"</b> button. Diagnostic commands (Ping, TCP Port Test, DNS Lookup,
    and the informational command runner offering things like <code>systeminfo</code> or <code>uname -a</code>)
    are explicitly read-only — the command runner states directly: <em>"These are read-only informational
    commands."</em></p>
  `,
};

DOCS['inf-agent-vs-ssh'] = {
  title: 'Agent vs. SSH on This Page',
  dek: 'How the two collector types are surfaced, and what differs between them here.',
  crumbs: ['ActMon Documentation', 'Infrastructure', 'Agent vs. SSH'],
  module: 'Infrastructure', status: 'Complete',
  body: `
    <p>Infrastructure deliberately gives Agent-collected and SSH-collected hosts the <em>same</em> detail UI
    (same nine tabs, same metrics shape) while still surfacing which collector a host actually uses in several
    places:</p>
    <ul>
      <li>A <b>"ActMon Agent"</b> vs. <b>"SSH"</b> badge on each host's list card.</li>
      <li>A <b>Collector</b> column on the host list table.</li>
      <li>The Fleet Overview donut chart on <code>/infra</code>, broken down by Collector.</li>
      <li>A description line on the host detail page (<code>via agent</code> / <code>via ssh</code>) and, in the
      System Information panel, <em>"Collector: ActMon Agent (push)"</em> vs. <em>"SSH (poll)"</em>.</li>
    </ul>
    <h2>What genuinely differs</h2>
    <ul>
      <li><b>Performance chart granularity:</b> Agent hosts get a full range/granularity picker; SSH hosts show
      a note (<em>"SSH-polled every 3 min — finer granularities will look sparse"</em>) since their sampling
      cadence is coarser.</li>
      <li><b>History:</b> Both collector types now write to the same ClickHouse-backed history table — a real,
      persisted history exists for SSH-polled hosts too, not just live session data. A brand-new host with no
      persisted history yet falls back to a small client-side session buffer until real history accumulates.</li>
      <li><b>File browsing:</b> Agent hosts browse via the agent directly; SSH-registered hosts without stored
      credentials need them entered first (see
      <button onclick="go('inf-actions')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Host Actions</button>).</li>
      <li><b>Editing &amp; Firewall on Windows:</b> These run through the ActMon agent — the IP Configuration
      tab notes explicitly, for Windows hosts: <em>"Editing &amp; firewall run through the ActMon agent on
      Windows — keep the agent updated to enable them (viewing works now)."</em></li>
      <li><b>Agent self-update:</b> The "Update Agent" button only appears for Windows hosts using the Agent
      collector — there is no equivalent for SSH-polled hosts (there's no agent process on them to update).</li>
    </ul>
  `,
};

DOCS['inf-windows-linux'] = {
  title: 'Windows vs. Linux Differences',
  dek: 'Where the Infrastructure module genuinely behaves differently by OS.',
  crumbs: ['ActMon Documentation', 'Infrastructure', 'Windows vs. Linux'],
  module: 'Infrastructure', status: 'Complete',
  body: `
    <ul>
      <li><b>Config file locations</b> differ throughout (e.g. Linux <code>/etc/mysql/my.cnf</code> vs. Windows
      <code>C:\\ProgramData\\MySQL\\MySQL Server 8.0\\my.ini</code>).</li>
      <li><b>Registry panel</b> — only shown for Windows hosts (there's no registry concept on Linux).</li>
      <li><b>Process table "User" column</b> — only populated for Linux (Linux reports the owning user per
      process; Windows doesn't expose this the same way).</li>
      <li><b>Diagnostic command set</b> — Windows offers <code>systeminfo</code>/<code>wmic os</code>; Linux
      offers <code>uname -a</code>/<code>cat /etc/os-release</code>.</li>
      <li><b>Editing &amp; Firewall on Windows</b> run through the agent specifically — see
      <button onclick="go('inf-agent-vs-ssh')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Agent vs. SSH on This Page</button>.</li>
      <li><b>Agent self-update</b> is Windows-agent-only.</li>
    </ul>
  `,
};

DOCS['inf-permissions'] = {
  title: 'Permissions',
  dek: 'What access is required for Infrastructure actions.',
  crumbs: ['ActMon Documentation', 'Infrastructure', 'Permissions'],
  module: 'Infrastructure', status: 'Complete',
  body: `
    <p>Every state-changing action on this page (service actions, reboot, kill process, file/network/firewall
    edits, registry writes, agent update) requires re-entering your account password at the moment you trigger
    it, in addition to whatever module-level permission gates the button's visibility. Read-only views
    (Overview, Ports, Processes, Storage listing, Diagnostics tools) require only view access.</p>
    <div class="warnbox"><b>No configurable alert thresholds here</b>${icon('alerts', 14)}<span>There is no
    per-host "set CPU alert at X%" control on this page — status bands (online/warning/offline, and the
    CPU/RAM/disk color bands) come from a fixed, shared status scale, not a per-host threshold editor. If you
    need a configurable CPU/memory/disk alert, see
    <button onclick="go('alt-rules')" style="all:unset;cursor:pointer;color:var(--fg)">Alert Rules</button> in the Alerts module.</span></div>
  `,
};

DOCS['inf-troubleshooting'] = {
  title: 'Troubleshooting',
  dek: 'Practical answers for common Infrastructure module problems.',
  crumbs: ['ActMon Documentation', 'Infrastructure', 'Troubleshooting'],
  module: 'Infrastructure', status: 'Complete',
  body: `
    <h2>High CPU</h2>
    <p><b>Symptoms:</b> A host's CPU gauge/band shows Elevated, High, or Critical on the Overview tab.</p>
    <p><b>How to verify:</b> Check the CPU trend chart for whether it's a sustained spike or a brief one; open
    "Top processes by CPU" to identify the specific process driving it.</p>
    <p><b>Resolution:</b> Depends on the process — a runaway query on a database host may need
    <button onclick="go('adm-overview')" style="all:unset;cursor:pointer;color:var(--accent-ink)">the relevant engine's Slow Queries page</button>
    rather than an OS-level fix; a genuinely stuck process can be ended from the Processes tab (password
    re-auth required) if you're certain it's safe to kill.</p>

    <h2>High Memory</h2>
    <p><b>Symptoms:</b> Memory gauge shows Elevated/High/Critical; the Process CPU-vs-Memory scatter shows one or
    a few processes dominating.</p>
    <p><b>How to verify:</b> Check the Memory breakdown tile and "Top processes by Memory."</p>
    <p><b>Resolution:</b> For a database host, high memory is often the engine's own buffer/cache doing its job
    correctly (e.g. PostgreSQL's shared buffers, MySQL's InnoDB buffer pool) — check the relevant engine
    dashboard's memory panel before assuming it's a leak. For a genuine OS-level process leak, restarting the
    specific service (not the whole host, if avoidable) is usually the safer first step.</p>

    <h2>Disk Space Issue</h2>
    <p><b>Symptoms:</b> A filesystem shows a high use% on the Storage tab; disk band shows Elevated/High/
    Critical.</p>
    <p><b>How to verify:</b> Open the Storage tab and identify which mount is filling up, then use File Explorer
    to browse into it and find what's growing (log files, WAL/binlog retention, temp files are common culprits
    on database hosts).</p>
    <p><b>Resolution:</b> Clear or rotate genuinely unneeded files via File Explorer; for a database-specific
    cause (excess WAL/binlog retention, bloated tables), address it from that engine's own dashboard rather than
    deleting database files directly from Infrastructure.</p>

    <h2>SSH Failure</h2>
    <p><b>Symptoms:</b> An SSH-collected host shows offline/unreachable, or File Explorer shows a credentials
    error.</p>
    <p><b>How to verify:</b> Confirm the host's SSH credentials are current (they may have been rotated on the
    remote host without updating ActMon); check that the SSH port is reachable from wherever ActMon's collector
    runs (firewall/security-group change is a common cause).</p>
    <p><b>Resolution:</b> Re-enter SSH credentials via the File Explorer's inline form, or re-check the
    connection's own SSH configuration in the Database module if this host is also a database connection.</p>

    <h2>Windows / Linux Service Failure</h2>
    <p><b>Symptoms:</b> A service on the Services tab shows stopped/failed unexpectedly.</p>
    <p><b>How to verify:</b> Check the service's own status text on that tab; cross-reference with the relevant
    application's error logs if it's a monitored database service (see that engine's Error Logs page).</p>
    <p><b>Resolution:</b> Use the Restart action on that specific service row (password re-auth required) rather
    than rebooting the whole host, unless the host itself is genuinely unresponsive.</p>
  `,
};

DOCS['inf-reference'] = {
  title: 'Infrastructure Reference',
  dek: 'Consolidated reference — routes, tabs, and actions.',
  crumbs: ['ActMon Documentation', 'Infrastructure', 'Reference'],
  module: 'Infrastructure', status: 'Complete',
  body: `
    <div class="tblwrap"><table class="doc">
      <tr><th>Route</th><th>What it renders</th></tr>
      <tr><td><code>/infra</code>, <code>/infra/hosts</code></td><td>Host list</td></tr>
      <tr><td><code>/infra/:id[/:tab]</code></td><td>Host detail — 9 tabs</td></tr>
      <tr><td><code>/infra/:id/files</code></td><td>File Explorer</td></tr>
      <tr><td><code>/infra/:id/network/:sub</code></td><td>A specific Network sub-module</td></tr>
      <tr><td><code>/infra/:id/ip-configuration/:sub</code></td><td>A specific IP Configuration sub-module</td></tr>
      <tr><td><code>/infra/:id/config-files/:sub</code></td><td>A specific Config Files sub-module</td></tr>
    </table></div>
    <p>Cross-references: <button onclick="go('agt-architecture')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Host vs. Database Agent Architecture</button>
    (Agents module), <button onclick="go('inf-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Troubleshooting</button>.</p>
  `,
};
