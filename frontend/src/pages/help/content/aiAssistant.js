/**
 * AI / Diagnosis chapter. Two genuinely separate features are documented
 * here: the general-purpose ActMon AI chat assistant, and the per-connection
 * Diagnosis page. Neither is described as autonomous — every real action
 * either requires explicit confirmation or is itself a user-triggered check.
 */
import { DOCS, icon } from '../helpContent';

export const AI_TOPICS = [
  ['ai-overview', 'AI / Diagnosis Overview'],
  ['ai-chat-usage', 'Using the ActMon AI Chat Assistant'],
  ['ai-chat-actions', 'When the Assistant Proposes an Action'],
  ['ai-diagnosis-page', 'The Per-Connection Diagnosis Page'],
  ['ai-recommendation-vs-action', 'Recommendation vs. Action'],
  ['ai-limitations', 'Limitations & Safety'],
  ['ai-troubleshooting', 'Troubleshooting'],
  ['ai-reference', 'AI Reference'],
];

DOCS['ai-overview'] = {
  title: 'AI / Diagnosis Overview',
  dek: 'Two separate AI features exist in ActMon — a chat assistant, and a per-connection diagnostic runbook.',
  crumbs: ['ActMon Documentation', 'AI Assistant', 'Overview'],
  module: 'AI Assistant', status: 'Complete',
  body: `
    <p>ActMon has two genuinely distinct AI-adjacent features that are easy to conflate but are built, routed,
    and used completely differently:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th></th><th>ActMon AI (chat assistant)</th><th>Diagnosis page</th></tr>
      <tr><td>Reached from</td><td>A floating widget on every signed-in screen, or the full <code>/ai-assistant</code> page</td><td>The "Diagnose" button on any database connection, or Recommended Actions in the Dashboard/Database docs</td></tr>
      <tr><td>Shape</td><td>Open-ended conversation</td><td>A structured, checkbox-driven diagnostic runbook for one connection</td></tr>
      <tr><td>Scope</td><td>Anything about your monitored estate — hosts, databases, alerts</td><td>One specific database connection's health/errors/root cause</td></tr>
      <tr><td>Can it act?</td><td>Only with an explicit, password-confirmed proposal — see <button onclick="go('ai-chat-actions')" style="all:unset;cursor:pointer;color:var(--accent-ink)">next topic</button></td><td>Yes — Start/Restart Service, gated the same way (permission + confirm dialog + password + re-verification)</td></tr>
    </table></div>
    <p>They share the general idea of "AI helping you troubleshoot" but are not the same feature, and not
    interchangeable — this chapter documents both.</p>
  `,
};

DOCS['ai-chat-usage'] = {
  title: 'Using the ActMon AI Chat Assistant',
  dek: 'Sessions, quick prompts, and how the assistant knows what page you\'re on.',
  crumbs: ['ActMon Documentation', 'AI Assistant', 'Using the Chat Assistant'],
  module: 'AI Assistant', status: 'Complete',
  body: `
    <p>The assistant is a real chatbot — a full page at <code>/ai-assistant</code> and a floating, draggable
    widget present on every signed-in screen, sharing the same conversation state so switching between them never
    loses context. It's backed by a streaming (SSE) chat endpoint and is explicitly built as an
    <b>intent-routed pipeline</b> — the backend classifies each turn and returns different response shapes
    (plain text, a clarifying question with suggestion chips, or an action proposal), rather than only ever
    returning plain text.</p>
    <h2>Getting started</h2>
    <p>Suggested prompts on first open: <em>"Is anything unhealthy right now?"</em>, <em>"Summarise today's
    alerts"</em>, <em>"Which host has the highest CPU?"</em>. Placeholder copy invites broader questions too:
    <em>"Ask about a host, a database, an alert, or what needs attention right now."</em></p>
    <h2>Context awareness</h2>
    <p>The assistant reads your current route and sends it as context with every message — e.g. if you ask a
    question while looking at a MySQL slow-queries page, it knows which connection you mean without you having
    to name it.</p>
    <h2>Sessions</h2>
    <p>A left rail (full-page view) lists your conversations, persisted server-side per signed-in user. You can
    start a "New Chat," search across title and message content, rename a conversation inline, or delete one
    (confirm dialog: <em>"This permanently removes the conversation and its messages. This can't be
    undone."</em>). The widget itself offers "Open full chat" and, once messages exist, "Clear conversation."</p>
    <div class="warnbox"><b>Verify before acting</b>${icon('alerts', 14)}<span>Exact disclaimer shown under the
    input box on both surfaces: <em>"ActMon AI can be wrong about specifics — verify before acting on critical
    numbers."</em></span></div>
  `,
};

DOCS['ai-chat-actions'] = {
  title: 'When the Assistant Proposes an Action',
  dek: 'The assistant can suggest a real action — but never runs one without explicit, password-confirmed approval.',
  crumbs: ['ActMon Documentation', 'AI Assistant', 'Action Proposals'],
  module: 'AI Assistant', status: 'Complete',
  body: `
    <p>When the backend decides a concrete action would help (restarting a service, killing a process, rebooting
    a host, acknowledging alerts, and similar), the assistant renders an <b>action proposal card</b> instead of
    just describing it in text:</p>
    <ul>
      <li>A plain-language summary of the proposed action, with a warning icon.</li>
      <li><b>Cancel</b> — dismisses it, nothing happens.</li>
      <li><b>Confirm</b> — opens a password re-authentication prompt. Only once the password is entered does the
      action actually fire.</li>
    </ul>
    <div class="tip"><b>Same code path as the real buttons</b>${icon('tip', 14)}<span>The confirmed action is
    re-verified for permission and password server-side, then calls "the exact same service function the Infra
    page's own buttons use" — this is not a separate, less-safe execution path just because it started from a
    chat message.</span></div>
    <div class="imp"><b>Never autonomous</b>${icon('alerts', 14)}<span>The assistant never runs an action on its
    own initiative — every proposal requires you to click Confirm and then enter your password. If you never
    confirm, nothing happens.</span></div>
  `,
};

DOCS['ai-diagnosis-page'] = {
  title: 'The Per-Connection Diagnosis Page',
  dek: 'The structured, checkbox-driven diagnostic runbook reached via "Diagnose" on any database connection.',
  crumbs: ['ActMon Documentation', 'AI Assistant', 'Diagnosis Page'],
  module: 'AI Assistant', status: 'Complete',
  body: `
    <p>Every database engine dashboard has a <b>Diagnose</b> button (in the shared dashboard header) that opens
    <code>/diagnose/:connId[/:tab]</code> — a dedicated troubleshooting workspace for that one connection, with
    seven tabs: <b>Overview, Terminal, Errors &amp; Logs, Timeline, Root Cause &amp; AI, Recommended Actions,
    History</b>.</p>
    <h2>Explicit, never automatic</h2>
    <p>A left sidebar lists diagnostic checks grouped by System/Network/Database/Logs, each with its own Run
    button and live status badge, plus <b>"Run Selected Checks"</b> and <b>"Run All Safe Diagnostics"</b> at the
    bottom. Nothing runs automatically except a passive overview/plan read on open — every diagnostic command is
    explicitly triggered by you.</p>
    <h2>Root Cause &amp; AI tab</h2>
    <p>Two distinct analyses, both explicit: <b>Root Cause Analysis</b> (a <code>primary_cause</code>, a
    confidence percentage, and supporting evidence, with a "Re-analyze" button) and a separate
    <b>"ActmonAI Analysis"</b> section with its own explicit <b>"Run ActmonAI Analysis"</b> button — showing
    diagnosis, root cause, evidence, a recommended resolution, and a confidence percentage. Neither runs without
    you clicking its own button.</p>
    <h2>Recommended Actions tab — the one place this page can actually change state</h2>
    <p>Alongside purely informational recommendations, a <b>"Recovery Actions"</b> section can show a real
    <b>Start Service</b> or <b>Restart Service</b> button when the diagnostic checks found the service down or
    running (respectively). This is gated on the <code>execute</code> permission, shows a confirm dialog naming
    the server/database/service/action and the exact expected impact —</p>
    <ul>
      <li>Start: <em>"The database will begin accepting connections once the service starts."</em></li>
      <li>Restart: <em>"The database will be briefly unavailable while the service restarts."</em></li>
    </ul>
    <p>— then requires a password re-auth prompt before it runs. Afterward, the page automatically re-runs the
    service and connection checks and reports one of:</p>
    <ul>
      <li><b>Recovery Successful</b> — "service is running and the database is accepting connections."</li>
      <li><b>Recovery Failed</b> — with the specific service/connection error detail.</li>
    </ul>
    <p>Two more buttons round out this tab: <b>Generate Diagnostic Report</b> and <b>Copy Report</b>.</p>
    <h2>Other tabs</h2>
    <p><b>Overview</b> — diagnosis summary, current status, confidence, detected-at time, last heartbeat, host/OS
    health, last successful connection. <b>Terminal</b> — a transcript of every check you've run, with copyable
    commands and a "run again" option. <b>Errors &amp; Logs</b> — latest error (with Copy) and an error files/
    logs table. <b>Timeline</b> — a vertical timeline of diagnosis milestones. <b>History</b> — a table of
    previous diagnosis runs, click any row for its full detail.</p>
  `,
};

DOCS['ai-recommendation-vs-action'] = {
  title: 'Recommendation vs. Action',
  dek: 'ActMon AI never claims to have performed an action when it only provided a recommendation — here\'s the exact distinction.',
  crumbs: ['ActMon Documentation', 'AI Assistant', 'Recommendation vs. Action'],
  module: 'AI Assistant', status: 'Complete',
  body: `
    <p>Across every AI surface in ActMon (chat assistant, Diagnosis page, per-engine "AI Analysis" panels in the
    Database module, Patroni's AI Pre-Check), the same rule holds: <strong>an AI feature that only analyzes and
    suggests is never presented as if it changed anything</strong>, and any feature that genuinely can change
    something is a distinct, explicitly-labeled button with its own confirmation and permission gate.</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Surface</th><th>What's a recommendation only</th><th>What's a real action</th></tr>
      <tr><td>ActMon AI chat</td><td>Any plain-text answer or explanation</td><td>An action-proposal card, only after Confirm + password</td></tr>
      <tr><td>Diagnosis page</td><td>Root Cause Analysis, "ActmonAI Analysis," every diagnostic check</td><td>Start Service / Restart Service (Recommended Actions tab), each password-gated</td></tr>
      <tr><td>Slow query AI analysis (any engine)</td><td>Severity rating, root cause, index recommendations, suggested rewrite — all text/copyable SQL, nothing executes</td><td>None on this surface — it never runs DDL/DML itself</td></tr>
      <tr><td>Patroni AI Pre-Check</td><td>SAFE TO RESTART / CAUTION / NOT RECOMMENDED verdict — advisory only, never blocks the action</td><td>The Restart Patroni action itself is separate and still requires its own confirm + password</td></tr>
    </table></div>
    <div class="imp"><b>The rule in one sentence</b>${icon('alerts', 14)}<span>If an AI panel shows you SQL, a
    root cause, or a verdict, treat it as something to read and decide on — it has not already been applied.
    Only a labeled action button, behind its own confirm dialog and password prompt, actually changes anything.</span></div>
  `,
};

DOCS['ai-limitations'] = {
  title: 'Limitations & Safety',
  dek: 'What ActMon AI is not, and how to use it responsibly.',
  crumbs: ['ActMon Documentation', 'AI Assistant', 'Limitations & Safety'],
  module: 'AI Assistant', status: 'Complete',
  body: `
    <ul>
      <li><b>It can be wrong.</b> The app's own disclaimer states this directly — verify specifics before acting
      on critical numbers, especially before running a copied SQL statement or a suggested index change against
      production.</li>
      <li><b>It only analyzes what it's given.</b> Slow-query AI analysis reasons from the query, its execution
      plan, and real table/index metadata gathered for that specific query — not from your entire schema or
      workload history.</li>
      <li><b>It never acts without confirmation.</b> See
      <button onclick="go('ai-recommendation-vs-action')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Recommendation vs. Action</button>.
      Every state-changing action anywhere in ActMon — whether triggered from the chat assistant, the Diagnosis
      page, or a database/infrastructure module directly — requires password re-authentication at the moment
      it's triggered.</li>
      <li><b>It is not a replacement for your own judgment on a live production system.</b> Treat index/rewrite
      suggestions as a starting point to test, not a guaranteed-safe change — the AI panels themselves often
      include their own "test before production" caveats.</li>
    </ul>
  `,
};

DOCS['ai-troubleshooting'] = {
  title: 'Troubleshooting',
  dek: 'Practical answers for common AI Assistant problems.',
  crumbs: ['ActMon Documentation', 'AI Assistant', 'Troubleshooting'],
  module: 'AI Assistant', status: 'Complete',
  body: `
    <h2>"AI suggestions are temporarily unavailable"</h2>
    <p><b>Cause:</b> The AI backend (the LLM provider integration) is unreachable or erroring.</p>
    <p><b>Resolution:</b> Retry after a moment — this is a transient-dependency message, not a data problem with
    your query/connection. If it persists, the AI provider integration itself may need attention (an
    administration-level configuration concern, not something fixable from this page).</p>

    <h2>An action-proposal card never appears for something I expect it to suggest</h2>
    <p><b>Cause:</b> The chat assistant only proposes actions the backend's intent router explicitly recognizes
    and maps to a real, permitted operation — it does not attempt an action for every request phrased as one.</p>
    <p><b>Resolution:</b> Use the equivalent explicit page instead (e.g. the Infrastructure module's own Restart
    Service button, or the Diagnosis page's Recommended Actions tab) — the assistant is a convenience layer over
    the same underlying actions, not the only way to reach them.</p>

    <h2>Diagnosis page's Start/Restart Service button doesn't appear</h2>
    <p><b>Cause:</b> This button only renders when the diagnostic checks actually detected the service in a
    stopped or running state respectively, and requires the <code>execute</code> permission.</p>
    <p><b>Resolution:</b> Run the relevant System/Database checks first (the button depends on their result);
    confirm your role has the execute permission for this connection.</p>
  `,
};

DOCS['ai-reference'] = {
  title: 'AI Reference',
  dek: 'Consolidated reference — routes and the two AI surfaces.',
  crumbs: ['ActMon Documentation', 'AI Assistant', 'Reference'],
  module: 'AI Assistant', status: 'Complete',
  body: `
    <div class="tblwrap"><table class="doc">
      <tr><th>Route / surface</th><th>What it is</th></tr>
      <tr><td><code>/ai-assistant</code></td><td>Full-page ActMon AI chat</td></tr>
      <tr><td>Floating widget</td><td>Same chat, available on every signed-in screen</td></tr>
      <tr><td><code>/diagnose/:connId[/:tab]</code></td><td>Per-connection Diagnosis page — 7 tabs</td></tr>
    </table></div>
    <p>Cross-references: <button onclick="go('ai-recommendation-vs-action')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Recommendation vs. Action</button>,
    <button onclick="go('dbm-drilldown-diagnose')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Resource Drill-Down &amp; Diagnose</button> (Database module),
    <button onclick="go('pg-patroni-diagnosis')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Patroni AI Pre-Check &amp; Recovery Diagnosis</button>.</p>
  `,
};
