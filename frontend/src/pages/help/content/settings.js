/**
 * Settings chapter. Grounded in pages/settings/*. Every setting name/option
 * listed here was read directly from the relevant section component.
 */
import { DOCS, icon } from '../helpContent';

export const SETTINGS_TOPICS = [
  ['set-overview', 'Settings Overview'],
  ['set-appearance', 'Appearance'],
  ['set-notifications-general', 'Notifications — General & Time Zone'],
  ['set-smtp', 'SMTP Configuration'],
  ['set-channels', 'Notification Channels'],
  ['set-templates-routing', 'Templates & Severity Routing'],
  ['set-troubleshooting', 'Troubleshooting'],
  ['set-reference', 'Settings Reference'],
];

DOCS['set-overview'] = {
  title: 'Settings Overview',
  dek: 'The two top-level Settings tabs — Appearance and Notifications.',
  crumbs: ['ActMon Documentation', 'Setting', 'Overview'],
  module: 'Setting', status: 'Complete',
  body: `
    <p>Settings (<code>/settings</code>) has exactly two top-level tabs — there is no separate Account/Security/
    General tab beyond these:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Tab</th><th>Route</th><th>Scope</th></tr>
      <tr><td>Appearance</td><td><code>/settings</code></td><td>Purely visual — theme, color, typography, layout. Applied instantly, saved to this browser only.</td></tr>
      <tr><td>Notifications</td><td><code>/settings/notifications</code></td><td>Alert delivery — SMTP, the 9 notification channels, and severity-based routing. Saved server-side, shared across your organization.</td></tr>
    </table></div>
    <div class="tip"><b>Appearance is per-browser, Notifications is per-organization</b>${icon('tip', 14)}<span>
    Changing your Appearance settings on one device doesn't affect anyone else, and doesn't follow you to a
    different browser. Notification settings, by contrast, are shared configuration for your whole
    organization — changing the SMTP server or a channel's webhook affects every alert delivery going forward.</span></div>
  `,
};

DOCS['set-appearance'] = {
  title: 'Appearance',
  dek: 'Every visual setting — theme, color, typography, layout, sidebar, top bar, and accessibility.',
  crumbs: ['ActMon Documentation', 'Setting', 'Appearance'],
  module: 'Setting', status: 'Complete',
  body: `
    <p>11 sub-tabs, saved to this browser's local storage — nothing here is sent to the server.</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Sub-tab</th><th>What it controls</th></tr>
      <tr><td>Theme</td><td>One of several full theme presets (light/dark variants), each with a live mini-preview.</td></tr>
      <tr><td>Colour</td><td>Accent color (preset swatches + a custom picker — drives buttons, links, highlights, and chart series 1) and the chart series palette used across every graph.</td></tr>
      <tr><td>Charts</td><td>Default chart style (Recommended/Bar/Column/Donut/Pie), and a "Clear all" to reset any per-chart overrides.</td></tr>
      <tr><td>Typography</td><td>Body font (6 choices), Heading font, Monospace font (used by logs/queries/terminal), Scale (100% default, or a custom percentage), Font weight.</td></tr>
      <tr><td>Shape &amp; Spacing</td><td>Corner roundness (5 options), Density (3 — row heights/control sizes/padding), Card style (3).</td></tr>
      <tr><td>Dashboard Charts</td><td>A separate section for dashboard-specific chart preferences.</td></tr>
      <tr><td>Page Header</td><td>Style (plain/solid/gradient), "Scroll with the page" switch (default off — header stays pinned), header colour presets, gradient direction, texture and texture strength.</td></tr>
      <tr><td>Sidebar</td><td>Style (3 variants), colour presets, nav item style (4), position (2), width (200–340px slider), "Show menu names" switch (off = icon-only rail).</td></tr>
      <tr><td>Top Bar &amp; Layout</td><td>Top bar style/colour, Content width, Scale, Sticky top bar switch, Show breadcrumbs switch, Rows per page (applies to every list in the app; "All" turns paging off).</td></tr>
      <tr><td>Accessibility</td><td>Contrast (2 levels), Animation/Motion (3 levels).</td></tr>
      <tr><td>Configuration</td><td>"Copy config" / "Paste config" round-trip your entire appearance setup as JSON via the clipboard, so you can share a look between browsers.</td></tr>
    </table></div>
  `,
};

DOCS['set-notifications-general'] = {
  title: 'Notifications — General & Time Zone',
  dek: 'The one General setting: which time zone alert timestamps render in.',
  crumbs: ['ActMon Documentation', 'Setting', 'Notifications — General'],
  module: 'Setting', status: 'Complete',
  body: `
    <p>The Notifications tab has 12 sub-tabs. <b>General</b> has exactly one setting: <b>Alert time zone</b> —
    a dropdown of common IANA zones (IST, UTC, Dubai, Singapore, Tokyo, London, Berlin, New York, Chicago, LA,
    Sydney), or any raw IANA string entered directly (shown as "Other: {value}" if not one of the presets).</p>
    <div class="tip"><b>Display only, not evaluation</b>${icon('tip', 14)}<span>This setting controls how the
    <code>{{Timestamp}}</code> variable renders inside every alert notification — everything is still evaluated
    internally in UTC regardless of this setting.</span></div>
  `,
};

DOCS['set-smtp'] = {
  title: 'SMTP Configuration',
  dek: 'Configuring one or more SMTP servers for the Email notification channel and scheduled reports.',
  crumbs: ['ActMon Documentation', 'Setting', 'SMTP Configuration'],
  module: 'Setting', status: 'Complete',
  body: `
    <p>Multiple named SMTP configurations are supported, with one marked <b>Default</b>. Fields: Name, Host,
    Port, Username, Password/App Password (show/hide toggle), Sender Email, Sender Name, "Use TLS/STARTTLS"
    switch, "Set as default" switch.</p>
    <h2>Quick presets</h2>
    <p>Gmail, Outlook/Office 365, Yahoo Mail, Zoho Mail, SendGrid, AWS SES (US East) — picking one auto-fills
    host/port/TLS for you.</p>
    <div class="tip"><b>Gmail app-password tip (shown in the form)</b>${icon('tip', 14)}<span><em>"Enable
    2-Step Verification → Google Account → Security → App Passwords → generate one for 'Mail'. Host
    smtp.gmail.com · Port 587 · TLS on."</em></span></div>
    <h2>Actions</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Action</th><th>What it does</th></tr>
      <tr><td>Add SMTP Config</td><td>Creates a new named configuration.</td></tr>
      <tr><td>Test (per config)</td><td>Sends a real test email through that config, shows an OK/Failed badge plus the last-tested timestamp.</td></tr>
      <tr><td>Edit</td><td>Opens the form pre-filled — the password field is never shown/pre-filled with a real value; leaving it blank keeps the current one.</td></tr>
      <tr><td>Delete</td><td>Confirm dialog: "'{name}' will no longer be usable for alert emails or reports."</td></tr>
    </table></div>
  `,
};

DOCS['set-channels'] = {
  title: 'Notification Channels',
  dek: 'The Email channel plus 8 provider channels — every field, and how secrets are protected on edit.',
  crumbs: ['ActMon Documentation', 'Setting', 'Notification Channels'],
  module: 'Setting', status: 'Complete',
  body: `
    <p>9 channels total, each rendered through the same generic panel: Email (uses the SMTP config above, plus
    its own Subject Template), Teams, Slack, Telegram, WhatsApp Business Cloud API, generic Webhook, PagerDuty,
    Jira Service Management, ServiceNow.</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Channel</th><th>Fields</th></tr>
      <tr><td>Email</td><td>Uses the SMTP config configured above. Note shown: "Who receives each alert is set per alert rule (Notify via → Email) — there is no shared default inbox here."</td></tr>
      <tr><td>Teams</td><td>Default Channel (text) + Incoming Webhook URL (secret)</td></tr>
      <tr><td>Slack</td><td>Channel, Bot Username, Icon (emoji/URL) + Webhook URL (secret)</td></tr>
      <tr><td>Telegram</td><td>Chat ID(s) (comma-separated) + Bot Token (secret)</td></tr>
      <tr><td>WhatsApp Business Cloud API</td><td>Phone Number ID, Business Account ID, API Version, Default Recipient + Access Token (secret)</td></tr>
      <tr><td>Generic Webhook</td><td>URL, Method (POST/PUT), Headers (JSON), Authentication (None/Basic/Bearer) + conditional Basic Auth Username + Password/Bearer Token (secret)</td></tr>
      <tr><td>PagerDuty</td><td>Integration Key (secret) only</td></tr>
      <tr><td>Jira Service Management</td><td>Base URL, Email, Project Key, Issue Type + API Token (secret)</td></tr>
      <tr><td>ServiceNow</td><td>Instance URL, Username + Password/API Token (secret)</td></tr>
    </table></div>
    <h2>Every channel panel has</h2>
    <p>An Enabled/Disabled toggle, a <b>Test</b> action, and a <b>Send Test Notification</b> action (Email's test
    requires a one-off, never-persisted recipient address, since there's no saved default inbox).</p>
    <div class="tip"><b>Secrets never round-trip as real values</b>${icon('tip', 14)}<span>Every secret field
    (webhook URLs, tokens, API keys) is represented on the frontend as a <code>secrets_set</code> boolean, not the
    real value — leaving a secret field blank on save keeps whatever is already stored server-side. This matches
    the same "Keep Existing / Change Credential" pattern used for every other credential field in the app.</span></div>
  `,
};

DOCS['set-templates-routing'] = {
  title: 'Templates & Severity Routing',
  dek: 'Per-channel subject/body overrides, and the default channel-per-severity fallback.',
  crumbs: ['ActMon Documentation', 'Setting', 'Templates & Severity Routing'],
  module: 'Setting', status: 'Complete',
  body: `
    <h2>Templates</h2>
    <p>One card per channel, showing its effective Subject with a "Custom" or "Default" badge and an
    <b>"Edit Template"</b> button opening a 3-step wizard to build the subject/body from the same 14 alert
    variables (e.g. the <code>{{Timestamp}}</code> variable covered in
    <button onclick="go('set-notifications-general')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Notifications — General</button>).
    Every channel already works with a sensible default even if you never configure a template.</p>
    <h2>Severity Routing</h2>
    <p>For each severity (Critical/Warning/Information), a toggleable set of the 9 channel chips defines the
    default delivery channels used when an alert rule doesn't pick its own — with an explicit Save button per
    severity row. Note shown: <em>"Default channels for a rule that hasn't picked its own — an alert rule's own
    'Notify via' selection always takes priority over this."</em></p>
    <p>See <button onclick="go('alt-rule-wizard')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Creating a Rule</button>
    (Alerts module) for where a rule's own channel selection is made.</p>
  `,
};

DOCS['set-troubleshooting'] = {
  title: 'Troubleshooting',
  dek: 'Practical answers for common Settings problems.',
  crumbs: ['ActMon Documentation', 'Setting', 'Troubleshooting'],
  module: 'Setting', status: 'Complete',
  body: `
    <h2>My Appearance changes don't show up on another device</h2>
    <p><b>Cause:</b> This is expected — Appearance settings are saved to this browser's local storage only, not
    to the server or your account.</p>
    <p><b>Resolution:</b> Use the Configuration sub-tab's "Copy config" on the original device and "Paste
    config" on the new one to carry the same look across.</p>

    <h2>SMTP Test succeeds but real alert emails never arrive</h2>
    <p><b>How to verify:</b> Check
    <button onclick="go('alt-history')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Notification History</button>
    (Alerts module) for a Sent/Failed status on the specific alert's Email delivery — a successful SMTP Test
    proves the server credentials work, not that a specific rule actually routed to Email.</p>
    <p><b>Resolution:</b> Confirm the alert rule itself has Email selected under "Notify via" (Step 5 of the rule
    wizard), or that your organization's Severity Routing default includes Email for that severity.</p>

    <h2>A channel shows "Enabled" but Test fails</h2>
    <p><b>Cause:</b> Enabled only means the channel is configured to be used — it doesn't guarantee the
    credentials/URL are currently valid.</p>
    <p><b>Resolution:</b> Re-check the channel's secret fields (webhook URL, token, API key) — remember a blank
    secret field on save keeps the OLD value, so if you meant to rotate a webhook URL and left the field blank by
    mistake, the channel is still using the stale one.</p>
  `,
};

DOCS['set-reference'] = {
  title: 'Settings Reference',
  dek: 'Consolidated reference — the two tabs and every sub-tab.',
  crumbs: ['ActMon Documentation', 'Setting', 'Reference'],
  module: 'Setting', status: 'Complete',
  body: `
    <div class="tblwrap"><table class="doc">
      <tr><th>Route</th><th>Tab</th></tr>
      <tr><td><code>/settings</code></td><td>Appearance (11 sub-tabs)</td></tr>
      <tr><td><code>/settings/notifications</code></td><td>Notifications (12 sub-tabs: General, Email/SMTP, 8 channels, Templates, Severity Routing)</td></tr>
    </table></div>
    <p>Cross-references: <button onclick="go('alt-notifications')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Alerts → Notification Delivery</button>,
    <button onclick="go('set-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Troubleshooting</button>.</p>
  `,
};
