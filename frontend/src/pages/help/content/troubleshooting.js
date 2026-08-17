/**
 * Troubleshooting Knowledge Base — a central index over every troubleshooting
 * topic across the whole documentation, plus a handful of genuinely
 * cross-cutting scenarios (connection failed, authentication failure,
 * permission denied) that don't belong to one single module.
 */
import { DOCS, icon } from '../helpContent';

export const TROUBLESHOOTING_TOPICS = [
  ['tsh-hub', 'Troubleshooting Knowledge Base'],
  ['tsh-connection-failed', 'Database Connection Failed'],
  ['tsh-authentication-failure', 'Authentication Failure'],
  ['tsh-permission-denied', 'Permission Denied'],
];

DOCS['tsh-hub'] = {
  title: 'Troubleshooting Knowledge Base',
  dek: 'Every troubleshooting scenario in this documentation, organized in one place by symptom.',
  crumbs: ['ActMon Documentation', 'Troubleshooting'], noMeta: false, module: 'Troubleshooting', status: 'Complete',
  body: `
    <p>Every module's own Troubleshooting topic uses the same format: <b>Symptoms → Possible causes → How to
    verify → Resolution → Prevention (where applicable)</b>. Rather than duplicating that material here, this
    page is an index — find your symptom below and jump straight to the full write-up.</p>

    <h2>Connectivity &amp; authentication</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Symptom</th><th>Full write-up</th></tr>
      <tr><td>Database connection failed / can't reach a database</td><td><button onclick="go('tsh-connection-failed')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Database Connection Failed</button> (this page)</td></tr>
      <tr><td>Sign-in / API authentication failing</td><td><button onclick="go('tsh-authentication-failure')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Authentication Failure</button> (this page)</td></tr>
      <tr><td>"Permission Denied" on a page or action</td><td><button onclick="go('tsh-permission-denied')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Permission Denied</button> (this page)</td></tr>
      <tr><td>SSH connection/browsing failure</td><td><button onclick="go('inf-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Infrastructure Troubleshooting → SSH Failure</button></td></tr>
    </table></div>

    <h2>Agents</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Symptom</th><th>Full write-up</th></tr>
      <tr><td>Agent Offline</td><td><button onclick="go('agt-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Agents Troubleshooting</button></td></tr>
      <tr><td>Two rows for what should be one host</td><td><button onclick="go('agt-architecture')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Host vs. Database Agent Architecture</button></td></tr>
    </table></div>

    <h2>Database &amp; replication</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Symptom</th><th>Full write-up</th></tr>
      <tr><td>Database offline / dashboard replaced by a diagnosis screen</td><td><button onclick="go('dbm-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Database Troubleshooting</button></td></tr>
      <tr><td>Slow queries</td><td><button onclick="go('dbm-slow-queries')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Slow Queries &amp; Query Analysis</button> (per-engine detail pages have their own EXPLAIN/AI workflow)</td></tr>
      <tr><td>PostgreSQL Replica Not Streaming</td><td><button onclick="go('pg-ha-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Replication &amp; HA Troubleshooting</button></td></tr>
      <tr><td>Replication Lag</td><td><button onclick="go('pg-ha-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Replication &amp; HA Troubleshooting</button></td></tr>
      <tr><td>Replication Slot confusion</td><td><button onclick="go('pg-ha-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Replication &amp; HA Troubleshooting</button></td></tr>
      <tr><td>Patroni Warning / Degraded cluster health</td><td><button onclick="go('pg-ha-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Replication &amp; HA Troubleshooting</button></td></tr>
      <tr><td>Patroni API Unavailable</td><td><button onclick="go('pg-ha-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Replication &amp; HA Troubleshooting</button></td></tr>
      <tr><td>PostgreSQL/MySQL/any engine service down</td><td><button onclick="go('tsh-connection-failed')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Database Connection Failed</button> (this page) + <button onclick="go('inf-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Infrastructure Troubleshooting → Service Failure</button></td></tr>
    </table></div>

    <h2>Infrastructure &amp; hosts</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Symptom</th><th>Full write-up</th></tr>
      <tr><td>High CPU</td><td><button onclick="go('inf-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Infrastructure Troubleshooting</button></td></tr>
      <tr><td>High Memory</td><td><button onclick="go('inf-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Infrastructure Troubleshooting</button></td></tr>
      <tr><td>Disk Space Issue / disk full</td><td><button onclick="go('inf-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Infrastructure Troubleshooting</button></td></tr>
      <tr><td>Windows / Linux Service Failure</td><td><button onclick="go('inf-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Infrastructure Troubleshooting</button></td></tr>
    </table></div>

    <h2>Cloud, Alerts, AI, Administration, Settings</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Module</th><th>Troubleshooting topic</th></tr>
      <tr><td>Cloud</td><td><button onclick="go('cld-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Cloud Troubleshooting</button></td></tr>
      <tr><td>Alerts</td><td><button onclick="go('alt-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Alerts Troubleshooting</button></td></tr>
      <tr><td>AI Assistant / Diagnosis</td><td><button onclick="go('ai-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">AI Troubleshooting</button></td></tr>
      <tr><td>Administration</td><td><button onclick="go('adm-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Administration Troubleshooting</button></td></tr>
      <tr><td>Setting</td><td><button onclick="go('set-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Settings Troubleshooting</button></td></tr>
      <tr><td>Dashboard</td><td><button onclick="go('db-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Dashboard Troubleshooting</button></td></tr>
    </table></div>
  `,
};

DOCS['tsh-connection-failed'] = {
  title: 'Database Connection Failed',
  dek: 'A generic, cross-engine walkthrough for "can\'t connect" — before you dig into one engine\'s own error logs.',
  crumbs: ['ActMon Documentation', 'Troubleshooting', 'Database Connection Failed'],
  module: 'Troubleshooting', status: 'Complete',
  body: `
    <p><b>Symptoms:</b> A server on the Database module's server list shows a disconnected/offline status; a
    dashboard fails to load and shows a diagnosis/error screen instead (MySQL does this explicitly — see
    <button onclick="go('dbm-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Database Troubleshooting</button>);
    "Test Connection" fails on the Add/Edit Server form.</p>
    <p><b>Possible causes:</b></p>
    <ul>
      <li>The database service itself is stopped on the host (check
      <button onclick="go('inf-host-tabs')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Infrastructure → Services tab</button>
      for that host).</li>
      <li>Stored credentials are stale (password rotated on the database side without updating ActMon).</li>
      <li>A network/firewall change blocked the database port between ActMon's collector and the host.</li>
      <li>For an agent-linked connection, the agent itself may be offline — check
      <button onclick="go('agt-status')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Agent Status &amp; Health</button>.</li>
      <li>For SSH-based monitoring, an SSH-layer problem (see
      <button onclick="go('inf-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Infrastructure Troubleshooting → SSH Failure</button>)
      can look identical to a database-layer failure at first glance.</li>
    </ul>
    <p><b>How to verify:</b> Check the connection's collector type (agent vs. SSH) first — it changes which
    layer to investigate. Then check the host's own Infrastructure page for whether the host itself is reachable
    at all before assuming the database service is the problem.</p>
    <p><b>Resolution:</b> Start the database service if it's stopped (via
    <button onclick="go('ai-diagnosis-page')" style="all:unset;cursor:pointer;color:var(--accent-ink)">the Diagnosis page's Start/Restart Service action</button>
    if available for that engine, or directly from Infrastructure → Services); update stored credentials via
    the connection's Edit form if they've been rotated; confirm network/firewall reachability between ActMon
    and the host on the database's port.</p>
    <p><b>Prevention:</b> Rotate database credentials through a coordinated process that also updates the ActMon
    connection, not just the database side.</p>
  `,
};

DOCS['tsh-authentication-failure'] = {
  title: 'Authentication Failure',
  dek: 'Two different kinds of "authentication failure" in ActMon — signing in, vs. a monitored database rejecting credentials.',
  crumbs: ['ActMon Documentation', 'Troubleshooting', 'Authentication Failure'],
  module: 'Troubleshooting', status: 'Complete',
  body: `
    <p>This phrase means two genuinely different things depending on where it appears — treat them separately.</p>
    <h2>Signing in to ActMon itself fails</h2>
    <p><b>Symptoms:</b> Login page rejects a correct-seeming username/password.</p>
    <p><b>Possible causes:</b> Account is locked (check the Account Locked/OK badge on
    <button onclick="go('adm-users-roles')" style="all:unset;cursor:pointer;color:var(--accent-ink)">User Master</button>,
    if you have access to check it); the account is inactive; a genuinely wrong password.</p>
    <p><b>Resolution:</b> Have an administrator check the account's Active/Locked state, or reset the password.</p>

    <h2>A monitored database rejects ActMon's stored credentials</h2>
    <p><b>Symptoms:</b> A connection shows a connection-failed/error state whose detail mentions an
    authentication-shaped error — e.g. MySQL's <em>"Access denied for user,"</em> Oracle's
    <code>ORA-01017</code>/<code>ORA-01031</code>, or MSSQL's <em>"login failed."</em></p>
    <p><b>Possible causes:</b> The password was rotated on the database side without updating ActMon's stored
    credential; the account's grants were revoked; the account was locked/expired on the database side (Oracle
    shows this directly on its Users tab — <span class="pill crit">LOCKED</span> / <span class="pill warn">EXPIRED(GRACE)</span> badges).</p>
    <p><b>Resolution:</b> Update the stored password via the connection's Edit form (leave it blank if unchanged
    — never re-type a masked placeholder value), or unlock/renew the account on the database side first if
    that's the actual cause.</p>
    <div class="warnbox"><b>These are per-engine, verified patterns — not assumed</b>${icon('alerts', 14)}<span>
    The specific error-message patterns above (MySQL "Access denied," Oracle ORA-01017/ORA-01031, MSSQL "login
    failed") are exactly what ActMon's own Database Monitoring Checks catalogue matches against — see
    <button onclick="go('agt-checks')" style="all:unset;cursor:pointer;color:var(--fg)">Database Monitoring Checks</button> (Agents module) for the full per-technology list.</span></div>
  `,
};

DOCS['tsh-permission-denied'] = {
  title: 'Permission Denied',
  dek: 'What "Permission Denied" means in ActMon\'s own RBAC vs. a monitored database\'s own grants — two different systems.',
  crumbs: ['ActMon Documentation', 'Troubleshooting', 'Permission Denied'],
  module: 'Troubleshooting', status: 'Complete',
  body: `
    <p>Like Authentication Failure, this phrase spans two unrelated systems — knowing which one you're looking
    at changes the fix entirely.</p>
    <h2>ActMon's own access control (a page or action is blocked)</h2>
    <p><b>Symptoms:</b> A module/page isn't visible in navigation, or an action button is disabled/hidden.</p>
    <p><b>Cause:</b> Your role has no grant (or an insufficient permission level) on that specific page — ActMon's
    RBAC is per-page and per-permission-bit, not a single "is admin" toggle.</p>
    <p><b>Resolution:</b> Ask an administrator to grant your role the needed permission on that page via
    <button onclick="go('adm-role-page-permission')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Granting Page Permissions</button>.</p>
    <div class="warnbox"><b>Frontend RBAC coverage varies by module</b>${icon('alerts', 14)}<span>Several modules'
    own documentation notes explicitly that backend RBAC enforcement is inconsistent or absent for specific
    endpoints (see the Permissions topic inside each module chapter, e.g.
    <button onclick="go('dbm-permissions')" style="all:unset;cursor:pointer;color:var(--fg)">Database Permissions</button>,
    <button onclick="go('agt-permissions')" style="all:unset;cursor:pointer;color:var(--fg)">Agents Permissions</button>).
    A hidden button in the UI is not always proof the backend would also reject the equivalent API call — verify
    against your own role rather than assuming.</span></div>

    <h2>A monitored database's own "permission denied" (a grant issue on the database itself)</h2>
    <p><b>Symptoms:</b> A monitoring check or a specific dashboard panel shows an error mentioning insufficient
    privilege — e.g. a PostgreSQL panel showing <code>&lt;insufficient privilege&gt;</code> because the
    monitoring role lacks <code>pg_monitor</code>, or a MySQL page needing Performance Schema access it doesn't
    have.</p>
    <p><b>Resolution:</b> Grant the monitoring account the specific privilege the panel names. PostgreSQL's Host
    Resources drill-down has a one-click <b>"Grant monitoring access"</b> button for exactly this case (with a
    manual SQL/shell fallback if the click itself fails due to the same privilege gap) — see
    <button onclick="go('dbm-drilldown-diagnose')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Resource Drill-Down &amp; Diagnose</button>.</p>
  `,
};
