/**
 * Alerts chapter. Grounded in pages/alerts/* and config/alertCatalog.js.
 * The metric catalogue's evaluation flags (live/collector/reserved) are
 * quoted precisely because they're a real, load-bearing honesty mechanism in
 * the actual UI, not incidental detail.
 */
import { DOCS, icon } from '../helpContent';

export const ALERTS_TOPICS = [
  ['alt-overview', 'Alerts Overview'],
  ['alt-active', 'Active Alerts'],
  ['alt-rules', 'Alert Rules & the Metric Catalogue'],
  ['alt-rule-wizard', 'Creating a Rule'],
  ['alt-notifications', 'Notification Delivery'],
  ['alt-history', 'Notification History'],
  ['alt-permissions', 'Permissions'],
  ['alt-troubleshooting', 'Troubleshooting'],
  ['alt-reference', 'Alerts Reference'],
];

DOCS['alt-overview'] = {
  title: 'Alerts Overview',
  dek: 'What an alert is in ActMon, the two kinds that exist, and the three tabs.',
  crumbs: ['ActMon Documentation', 'Alerts', 'Overview'],
  module: 'Alerts', status: 'Complete',
  body: `
    <p>The Alerts module (<code>/alerts</code>) is three tabs: <b>Active</b>, <b>Rules</b>, and
    <b>Notification History</b>.</p>
    <h2>Severities</h2>
    <p>Exactly three: <span class="pill crit">Critical</span>, <span class="pill warn">Warning</span>,
    <span class="pill neutral">Info</span>. Only Warning and Critical can be chosen when <em>authoring</em> a
    rule — Info exists as a display/filter value, not something you can set a new rule to.</p>
    <h2>Two kinds of alert</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Kind</th><th>Where it comes from</th><th>Can it be acknowledged?</th></tr>
      <tr><td>Rule-evaluated</td><td>Derived live from current host/database state against a rule's condition — clears automatically the moment the condition clears.</td><td>No — there's nothing to acknowledge; it just stops appearing.</td></tr>
      <tr><td>Collector/agent-reported</td><td>A stored row an agent reported (e.g. a specific detected error condition).</td><td>Yes — via Acknowledge.</td></tr>
    </table></div>
    <div class="tip"><b>No separate "Resolved" state</b>${icon('tip', 14)}<span>There is no acknowledged →
    resolved lifecycle in the general sense. A rule-evaluated alert simply stops appearing when its condition
    clears; a collector-reported alert stops appearing once acknowledged. Neither type has a distinct "Resolved"
    view separate from the active feed disappearing.</span></div>
  `,
};

DOCS['alt-active'] = {
  title: 'Active Alerts',
  dek: 'Filters, per-row detail, and every button on the Active tab.',
  crumbs: ['ActMon Documentation', 'Alerts', 'Active Alerts'],
  module: 'Alerts', status: 'Complete',
  body: `
    <h2>Filters</h2>
    <p>Search (alert/host/message text), Severity (All/Critical/Warning/Info, each with a live count), Source
    (a dynamic list of currently-firing sources), and Metric (a dynamic list of currently-firing metrics). A
    <b>"Clear"</b> button appears once any filter is active.</p>
    <h2>Buttons</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Button</th><th>What it does</th></tr>
      <tr><td>"Acknowledge all N events"</td><td>Acknowledges every ackable (collector-reported) alert currently in the filtered list — only shown when at least one exists.</td></tr>
      <tr><td>"Open {source}" (per row)</td><td>Navigates to <code>/infra</code> for that alert's source host.</td></tr>
      <tr><td>Chevron (per row)</td><td>Expands a detail panel: Metric, Section, Technology, Environment, Threshold, Raised time, and Origin ("Rule #N" or "Collector event").</td></tr>
      <tr><td>Refresh pill (header)</td><td>Manually re-fetches the active feed and the rules list, and resets the 15-second auto-refresh countdown.</td></tr>
    </table></div>
    <p>Empty states: with no filters active and nothing firing, "All clear" with a <b>"Review alert rules"</b>
    button that jumps to the Rules tab; with filters active and nothing matching, "No alerts match these filters"
    with a <b>"Clear filters"</b> button.</p>
  `,
};

DOCS['alt-rules'] = {
  title: 'Alert Rules & the Metric Catalogue',
  dek: 'The four rule sections, and why some metrics honestly say "no data source yet."',
  crumbs: ['ActMon Documentation', 'Alerts', 'Rules & Metric Catalogue'],
  module: 'Alerts', status: 'Complete',
  body: `
    <p>There <strong>is</strong> a real rule-creation UI — rules aren't purely fixed/system-generated. But it's
    not an arbitrary rules engine with custom scripting either: every rule picks one metric from a fixed
    catalogue (~34 metrics) and configures its operator/threshold/scope/timing/notification settings around it.
    Rules are organized into four sections, each shown as its own card with a live rule count: <b>Infrastructure,
    Database, Replication &amp; HA, Cloud</b>.</p>
    <h2>Every metric carries an honesty flag</h2>
    <p>Each metric in the catalogue is tagged with how it's actually evaluated — and this is surfaced directly
    in the rule wizard, not hidden:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Flag</th><th>Meaning</th></tr>
      <tr><td><b>live</b></td><td>Checked against host state on every poll — this metric fires reliably today.</td></tr>
      <tr><td><b>collector</b> ("Agent-reported")</td><td>Only raised when an agent actually reports this condition.</td></tr>
      <tr><td><b>reserved</b> ("No data source yet")</td><td>The rule is saved and persists, but nothing will raise it yet — the metric exists in the catalogue ahead of the collector work that would actually feed it.</td></tr>
    </table></div>
    <div class="warnbox"><b>A "reserved" rule won't fire</b>${icon('alerts', 14)}<span>If you create a rule on a
    <code>reserved</code> metric, it saves successfully and looks identical to a working rule in the Rules list
    — but it genuinely will not raise an alert until ActMon's collector for that specific metric is built. Check
    a metric's evaluation flag in the wizard before relying on it.</span></div>
    <h2>Catalogue by section (evaluation flag noted)</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Section</th><th>Metrics</th></tr>
      <tr><td>Infrastructure</td><td>Host down, CPU, Memory, Disk (all <i>live</i>); Swap, Load average, Disk I/O wait (all <i>reserved</i>)</td></tr>
      <tr><td>Database</td><td>Service stopped (<i>live</i>); Database not responding, DB crash (<i>reserved</i>); Active connections, Slow queries, Cache hit ratio, Deadlocks (<i>collector</i>); Connection %, Aborted connections, Query latency, Blocking sessions, Long-running query (<i>reserved</i>); DB size, Tablespace usage, Binlog/WAL disk use, Error-log spike, Critical error (<i>reserved</i>)</td></tr>
      <tr><td>Replication &amp; HA</td><td>Replication lag (<i>collector</i>); Replication broken, Replica down, Cluster node down (<i>reserved</i>); Oracle RAC node down, Oracle service down, Data Guard transport/apply failure &amp; lag, ASM diskgroup critical (<i>collector</i>)</td></tr>
      <tr><td>Cloud</td><td>Everything (<i>reserved</i>) — instance stopped, resource unhealthy, cloud CPU/storage, cost budget, cost spike</td></tr>
    </table></div>
    <h2>Managing existing rules</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Control</th><th>What it does</th></tr>
      <tr><td>On/Off switch (per row)</td><td>Enables/disables the rule immediately.</td></tr>
      <tr><td>Edit (gear icon)</td><td>Opens the same wizard, pre-filled.</td></tr>
      <tr><td>Delete (trash icon)</td><td>A real hard delete — confirm dialog reads "Delete this rule?" and adds: "To stop the alerts without losing the rule, switch it off instead."</td></tr>
    </table></div>
    <p>Badges above the list show "N off" (disabled rules) and "N with no data source" (rules currently sitting
    on a <code>reserved</code> metric).</p>
  `,
};

DOCS['alt-rule-wizard'] = {
  title: 'Creating a Rule',
  dek: 'The 6-step rule wizard, step by step.',
  crumbs: ['ActMon Documentation', 'Alerts', 'Creating a Rule'],
  module: 'Alerts', status: 'Complete',
  body: `
    <p>Clicking <b>"New rule"</b> opens a 6-step wizard:</p>
    <ol class="steps">
      <li><b>Category</b> — one of the four sections (Infrastructure/Database/Replication &amp; HA/Cloud). Locked
      once you're editing an existing rule.</li>
      <li><b>Details</b> — Name (required), Description (optional), Severity (Warning/Critical toggle).</li>
      <li><b>Condition &amp; scope</b> — pick a metric from the section-scoped catalogue. For a numeric metric:
      operator (<code>&gt;</code>, <code>≥</code>, <code>&lt;</code>, <code>≤</code>, <code>=</code>) + threshold
      + unit. An event metric has no threshold to set at all — the wizard states plainly "Fires when {desc} —
      there is no threshold to set." Scope: All servers / By technology / Specific server / Specific agent
      (Cloud offers All accounts / Specific account instead).</li>
      <li><b>Timing</b> — "Sustained for (s)" (how long the condition must hold before it fires) and "Re-notify
      after (s)" (cooldown; 0 means every time), plus an Enabled switch.</li>
      <li><b>Notify</b> — pick zero or more of the 9 notification channels for this specific rule. If none are
      picked, the rule falls back to the organization's Severity Routing default (see
      <button onclick="go('set-templates-routing')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Settings → Templates &amp; Severity Routing</button>).
      Picking Email requires a To address — there's no shared default inbox.</li>
      <li><b>Review &amp; save</b> — a read-only summary, then "Create rule" / "Save changes."</li>
    </ol>
    <div class="warnbox"><b>Scoping to a specific agent or cloud account</b>${icon('alerts', 14)}<span>If you
    scope a rule to a specific agent or account, the wizard warns directly: <em>"Host checks don't evaluate
    {scope} scopes — a rule scoped this way won't be raised by the poller. It still gates agent-reported alerts
    for this metric."</em> In other words, a live/poller-evaluated metric scoped to one specific agent may never
    actually fire — read this warning before saving that combination.</span></div>
  `,
};

DOCS['alt-notifications'] = {
  title: 'Notification Delivery',
  dek: 'How a firing alert actually reaches you — channels, routing, and where they\'re configured.',
  crumbs: ['ActMon Documentation', 'Alerts', 'Notification Delivery'],
  module: 'Alerts', status: 'Complete',
  body: `
    <p>Notification delivery is configured in <b>Settings → Notifications</b>, not in the Alerts module itself
    — a rule only picks <em>which</em> channels to use (Step 5 of the wizard); the channels themselves (SMTP,
    Slack, Teams, and so on) are configured once, centrally. Full detail in
    <button onclick="go('set-notifications-general')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Settings → Notifications</button>.</p>
    <p>If a rule doesn't pick its own channels, delivery falls back to the org's <b>Severity Routing</b> defaults
    — a per-severity (Critical/Warning/Information) default channel set. A rule's own channel selection always
    takes priority over the routing default.</p>
    <div class="tip"><b>An unused, dead API call</b>${icon('tip', 14)}<span>An <code>analyzeAlert()</code> API
    function exists in the codebase (intended as an "ActMon AI: explain the alert" feature) but is not called
    from any current UI component — it is unused/dead code today, not a hidden working feature.</span></div>
  `,
};

DOCS['alt-history'] = {
  title: 'Notification History',
  dek: 'The delivery audit trail — did the notification actually send?',
  crumbs: ['ActMon Documentation', 'Alerts', 'Notification History'],
  module: 'Alerts', status: 'Complete',
  body: `
    <p>This tab is a pure, read-only audit table of every attempted notification delivery — it answers "did the
    notification actually send," not "what alerts fired." Columns: Date &amp; Time, Alert Name, Organization,
    Server, Database, Severity, Channel, Recipient, Status, Resp. Code, Resp. Time, Retries, Error.</p>
    <p>Filters: Search, Channel, Severity (Critical/Warning/Information), Status (Sent/Pending/Failed),
    Organization, Date range. Only a <b>"Refresh"</b> button and a <b>"Clear filters"</b> button — no
    acknowledge/export/action buttons on this tab.</p>
  `,
};

DOCS['alt-permissions'] = {
  title: 'Permissions',
  dek: 'What access is required to view or manage alerts and rules.',
  crumbs: ['ActMon Documentation', 'Alerts', 'Permissions'],
  module: 'Alerts', status: 'Complete',
  body: `
    <p>Viewing the Active feed and Notification History requires view access to the Alerts module. Creating,
    editing, enabling/disabling, or deleting a rule requires edit access. As elsewhere in this documentation,
    confirm real access requirements against your own role rather than assuming a visible/hidden button is the
    full story of what the backend enforces.</p>
  `,
};

DOCS['alt-troubleshooting'] = {
  title: 'Troubleshooting',
  dek: 'Practical answers for common Alerts problems.',
  crumbs: ['ActMon Documentation', 'Alerts', 'Troubleshooting'],
  module: 'Alerts', status: 'Complete',
  body: `
    <h2>A rule I created never fires</h2>
    <p><b>Cause:</b> The metric it's built on may be <code>reserved</code> (no data source yet) — see
    <button onclick="go('alt-rules')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Alert Rules &amp; the Metric Catalogue</button>.
    Alternatively, it may be scoped to a specific agent/account when it's actually a poller-evaluated ("live")
    metric — the wizard warns about this combination at save time (see
    <button onclick="go('alt-rule-wizard')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Creating a Rule</button>).</p>
    <p><b>Resolution:</b> Check the metric's evaluation flag and the rule's scope; re-scope to "All servers" or
    "By technology" if the metric is poller-evaluated.</p>

    <h2>I acknowledged an alert but it came back</h2>
    <p><b>Cause:</b> Acknowledge only applies to collector/agent-reported alerts. If the underlying condition is
    still true, the agent will report it again on its next cycle — acknowledging silences the current instance,
    it doesn't fix the underlying condition or suppress future occurrences.</p>
    <p><b>Resolution:</b> Address the actual underlying cause (the specific error/condition the agent detected),
    not just the alert.</p>

    <h2>Notifications aren't arriving (Authentication Failure / delivery failed)</h2>
    <p><b>How to verify:</b> Check Notification History — a "Failed" status row will show the response code/
    error. A common cause for Email specifically is an SMTP authentication failure (wrong password, or an app
    password required by the provider).</p>
    <p><b>Resolution:</b> Re-test the relevant channel from
    <button onclick="go('set-notifications-general')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Settings → Notifications</button>
    using its own Test action before assuming the alert rule itself is broken.</p>
  `,
};

DOCS['alt-reference'] = {
  title: 'Alerts Reference',
  dek: 'Consolidated reference — tabs, severities, and the metric catalogue summary.',
  crumbs: ['ActMon Documentation', 'Alerts', 'Reference'],
  module: 'Alerts', status: 'Complete',
  body: `
    <div class="tblwrap"><table class="doc">
      <tr><th>Route</th><th>Tab shown</th></tr>
      <tr><td><code>/alerts</code></td><td>Active (default)</td></tr>
      <tr><td><code>/alerts?tab=rules</code></td><td>Rules</td></tr>
      <tr><td><code>/alerts?tab=history</code></td><td>Notification History</td></tr>
    </table></div>
    <p>Severities: Critical, Warning, Info (Info not authorable). Rule sections: Infrastructure, Database,
    Replication &amp; HA, Cloud — ~34 metrics total. Cross-references:
    <button onclick="go('set-notifications-general')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Settings → Notifications</button>,
    <button onclick="go('alt-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Troubleshooting</button>.</p>
  `,
};
