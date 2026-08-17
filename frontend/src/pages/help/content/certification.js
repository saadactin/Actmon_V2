/**
 * Certification Preparation — a learning-path structure over the existing
 * documentation. Per the brief, this does NOT invent exam questions; it
 * structures the material (objectives, concepts, practical procedure,
 * common mistakes) so questions can be layered on top later.
 */
import { DOCS, icon } from '../helpContent';

export const CERT_TOPICS = [
  ['cert-overview', 'Certification Preparation'],
  ['cert-fundamentals', '1. ActMon Fundamentals'],
  ['cert-dashboard', '2. ActMon Dashboard'],
  ['cert-agents', '3. Agent Management'],
  ['cert-database', '4. Database Monitoring'],
  ['cert-performance', '5. Performance Monitoring'],
  ['cert-replication-ha', '6. Replication & HA'],
  ['cert-alerts', '7. Alerts'],
  ['cert-troubleshooting', '8. Troubleshooting'],
  ['cert-administration', '9. ActMon Administration'],
  ['cert-security', '10. ActMon Security'],
  ['cert-advanced', '11. Advanced Monitoring'],
];

DOCS['cert-overview'] = {
  title: 'Certification Preparation',
  dek: 'A structured learning path through this documentation, in the order a future ActMon certification course would follow.',
  crumbs: ['ActMon Documentation', 'Certification Preparation'], module: 'Certification', status: 'Complete',
  body: `
    <p>This section is not a course or an exam — it's the documentation's material organized into a learning
    <em>path</em>, so a future certification course can be built directly on top of it without re-deriving
    structure from scratch. Each of the eleven stages below states its learning objectives, points to the real
    concept/procedure documentation, and calls out common mistakes worth knowing in advance.</p>
    <div class="tip"><b>No exam questions here — yet</b>${icon('tip', 14)}<span>Per the current phase of this
    documentation, no fake knowledge-check questions have been invented. Each stage ends with a "Knowledge check"
    placeholder marking exactly where real questions will be added once this becomes an actual certification
    course.</span></div>
    <pre style="background:var(--surface-sunken);border:1px solid var(--border);border-radius:var(--radius-md);padding:0.875rem 1rem;font-family:var(--font-mono);font-size:0.78rem;line-height:1.9;overflow-x:auto;max-width:70ch;color:var(--fg-muted)">1. ActMon Fundamentals
   ↓
2. ActMon Dashboard
   ↓
3. Agent Management
   ↓
4. Database Monitoring
   ↓
5. Performance Monitoring
   ↓
6. Replication &amp; HA
   ↓
7. Alerts
   ↓
8. Troubleshooting
   ↓
9. ActMon Administration
   ↓
10. ActMon Security
   ↓
11. Advanced Monitoring</pre>
    <p>Each stage assumes everything before it. A learner who completes all eleven has touched every module this
    documentation currently covers in depth.</p>
  `,
};

const stage = (id, num, title, objectives, links, mistakes, crumbLabel) => {
  DOCS[id] = {
    title: `${num}. ${title}`,
    dek: `Learning path stage ${num} of 11.`,
    crumbs: ['ActMon Documentation', 'Certification Preparation', crumbLabel || title],
    module: 'Certification', status: 'Complete',
    body: `
      <h2>Learning objectives</h2>
      <ul>${objectives.map((o) => `<li>${o}</li>`).join('')}</ul>
      <h2>Study material</h2>
      <ul>${links.map(([tid, label]) => `<li><button onclick="go('${tid}')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">${label}</button></li>`).join('')}</ul>
      <h2>Common mistakes</h2>
      <ul>${mistakes.map((m) => `<li>${m}</li>`).join('')}</ul>
      <div class="note"><b>Knowledge check</b>${icon('cert', 14)}<span>Not yet written — this is where stage-specific
      questions will be added once this section becomes a scored course.</span></div>
    `,
  };
};

stage('cert-fundamentals', 1, 'ActMon Fundamentals', [
  'Explain what ActMon monitors and what it does not (no invented capabilities).',
  'Distinguish Agent-based collection from SSH-based collection.',
  'Read a health/status badge correctly (Online/Offline/Warning/Error) without confusing it with a utilization band.',
], [
  ['gs-overview', 'ActMon Overview'],
  ['gs-understanding', 'Understanding ActMon'],
  ['gs-terminology', 'Basic Terminology'],
  ['agt-architecture', 'Host vs. Database Agent Architecture'],
], [
  'Assuming every host uses the same collector — a fleet is almost always a mix of Agent and SSH.',
  'Treating a connectivity status band and a resource-utilization band as the same color scale — they use the same colors but mean different things.',
]);

stage('cert-dashboard', 2, 'ActMon Dashboard', [
  'Explain what each Dashboard KPI tile actually aggregates.',
  'Know which refresh intervals apply to which tile, and that there is no historical trend on the Dashboard itself.',
  'Correctly state what IS and is NOT filterable on the Dashboard.',
], [
  ['db-overview', 'Dashboard Overview'],
  ['db-summary', 'Global Summary'],
  ['db-refresh', 'Refresh & Real-Time Data'],
  ['db-filters', 'Filters'],
], [
  'Assuming the Dashboard has a date-range or search filter — it deliberately has none.',
  'Reading the Dashboard as historical data — most of it is live-polled, not stored trend data.',
]);

stage('cert-agents', 3, 'Agent Management', [
  'Explain the difference between a host-identity agent row and a per-connection database agent row.',
  'Walk through registering/deploying a new agent.',
  'Read the agent status decision tree correctly (Online / DB Error / Warning / Offline / Service Stopped).',
], [
  ['agt-architecture', 'Host vs. Database Agent Architecture'],
  ['agt-registration-deploy', 'Agent Registration & Deployment'],
  ['agt-status', 'Agent Status & Health'],
  ['agt-checks', 'Database Monitoring Checks'],
], [
  'Assuming "Register Agent" opens a form — it doesn\'t; deployment is a separate wizard.',
  'Treating two agent rows for one physical host as a bug — it\'s an expected consequence of the host-vs-database-agent model.',
]);

stage('cert-database', 4, 'Database Monitoring', [
  'Add a new database server via both the SSH and Agent paths.',
  'Navigate any of the seven supported engine dashboards confidently.',
  'Know which self-heal/AI features exist per engine, and which don\'t.',
], [
  ['dbm-overview', 'Database Overview'],
  ['dbm-add-server', 'Adding a Server'],
  ['dbm-connections', 'Connections & Collectors'],
  ['dbm-error-logs', 'Error Logs & Self-Heal'],
], [
  'Assuming self-heal exists for every engine — it only exists for MySQL and MSSQL.',
  'Assuming every engine\'s slow-query source works the same way — each engine has a genuinely different native data source (see Slow Queries & Query Analysis).',
]);

stage('cert-performance', 5, 'Performance Monitoring', [
  'Read a slow-query execution plan and know what to check first.',
  'Explain the difference between digest-aggregated and per-instance query capture across engines.',
  'Use the Index Analysis page to identify unused, duplicate, and missing-index candidates without executing anything from that page.',
], [
  ['dbm-slow-queries', 'Slow Queries & Query Analysis'],
  ['pg-replication-concepts', 'Replication Concepts (also covers LSN/WAL terminology used in performance discussions)'],
  ['dbm-drilldown-diagnose', 'Resource Drill-Down & Diagnose'],
], [
  'Assuming Index Analysis can drop an index for you — every page in this area only generates copyable SQL, it never executes DDL.',
  'Confusing MongoDB/ClickHouse\'s instance-level query capture (no stable digest, no reload recovery) with the digest-aggregated model the other four engines use.',
]);

stage('cert-replication-ha', 6, 'Replication & HA', [
  'Define LSN, WAL, timeline, and replication lag correctly.',
  'Distinguish a switchover from a failover, and state when each is appropriate.',
  'Explain why an unused cascading replication slot is not evidence of a problem.',
  'List every Patroni recovery action and its risk level.',
], [
  ['pg-replication-concepts', 'Replication Concepts (LSN, WAL, Timeline)'],
  ['pg-patroni-actions', 'Patroni Recovery Actions'],
  ['pg-patroni-topology', 'Topology & Cascading Replicas'],
  ['pg-ha-troubleshooting', 'Replication & HA Troubleshooting'],
], [
  'Using Failover for a planned, non-emergency leadership change — that\'s what Switchover is for.',
  'Treating a replica\'s replay lag and receive lag as the same signal — they point to different bottlenecks (network vs. replica CPU/disk).',
]);

stage('cert-alerts', 7, 'Alerts', [
  'Explain the two kinds of alert (rule-evaluated vs. collector-reported) and which can be acknowledged.',
  'Build a rule using the 6-step wizard, including correctly scoping it.',
  'Recognize a "reserved" (no data source) metric before relying on it.',
], [
  ['alt-overview', 'Alerts Overview'],
  ['alt-rules', 'Alert Rules & the Metric Catalogue'],
  ['alt-rule-wizard', 'Creating a Rule'],
  ['set-notifications-general', 'Settings → Notifications'],
], [
  'Scoping a live/poller-evaluated metric to one specific agent or cloud account — the wizard\'s own warning explains why this silently never fires.',
  'Assuming Acknowledge fixes the underlying condition — it only silences the current instance.',
]);

stage('cert-troubleshooting', 8, 'Troubleshooting', [
  'Locate the right troubleshooting article for a given symptom quickly, using the central index.',
  'Distinguish ActMon\'s own authentication/permission system from a monitored database\'s own authentication/grants.',
], [
  ['tsh-hub', 'Troubleshooting Knowledge Base'],
  ['tsh-connection-failed', 'Database Connection Failed'],
  ['tsh-authentication-failure', 'Authentication Failure'],
  ['tsh-permission-denied', 'Permission Denied'],
], [
  'Debugging a "permission denied" as an ActMon RBAC issue when it\'s actually a monitored database\'s own grant issue, or vice versa.',
]);

stage('cert-administration', 9, 'ActMon Administration', [
  'Grant a role page-level access using the Module → Parent Page → Sub Page cascade.',
  'Explain why cascading a grant to a parent page also grants every descendant page.',
  'Locate the audit trail for a specific data change.',
], [
  ['adm-role-page-permission', 'Granting Page Permissions'],
  ['adm-audit-security', 'Audit Logs & Security Tracking'],
  ['adm-users-roles', 'Users, Roles & Organization Structure'],
], [
  'Trying to edit your own current role\'s permissions — this is blocked by design, even for a super-admin.',
]);

stage('cert-security', 10, 'ActMon Security', [
  'Explain the Keep-Existing/Change-Credential pattern used across every credential field in the app.',
  'State what ActMon AI can and cannot do without explicit human confirmation.',
  'Identify which actions across the app require password re-authentication.',
], [
  ['ai-recommendation-vs-action', 'Recommendation vs. Action'],
  ['ai-limitations', 'Limitations & Safety'],
  ['set-channels', 'Notification Channels (secrets handling)'],
  ['inf-actions', 'Host Actions (password re-auth pattern)'],
], [
  'Assuming an AI-suggested SQL statement or recommendation has already been applied — it never has, until a distinct, separately-confirmed action button is used.',
]);

stage('cert-advanced', 11, 'Advanced Monitoring', [
  'Explain the real gaps in a specific engine\'s monitoring (e.g. Cosmos DB\'s reliance on ActMon\'s own call log rather than Azure Monitor).',
  'Read a per-engine Reports page and know what\'s live-only vs. historical.',
  'Correctly state what Cloud cost data is real-billed vs. estimated.',
], [
  ['dbm-reports', 'Reports'],
  ['cld-cost', 'Cloud → Cost Monitoring'],
  ['cld-cosmosdb', 'Cloud → Cosmos DB'],
  ['dbm-reference', 'Database Reference'],
], [
  'Presenting a Cosmos DB metric derived from ActMon\'s own call log as if it reflected real application traffic.',
  'Assuming every engine\'s Reports page has the same sections — several sections are explicitly live-only per engine.',
]);
