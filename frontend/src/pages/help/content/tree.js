/**
 * Documentation tree — the single source of truth for hierarchy. Everything
 * that renders navigation (sidebar, breadcrumbs, landing-page card grids,
 * prev/next) reads from THIS structure, not from ad-hoc per-page logic.
 *
 * Two kinds of node:
 *   - LANDING node: has `children` — clicking it shows a card grid of its
 *     children (title/dek/topic-count), never the full descendant list.
 *   - LEAF node: has `doc` (a real DOCS id) — clicking it shows that
 *     article's actual content.
 *
 * A landing node's own `dek` is authored here; a leaf node's title/dek come
 * from its DOCS entry (so article content stays the single source of truth
 * for article-level copy — the tree only adds the grouping around it).
 *
 * Building new category landings later (e.g. MySQL/Oracle/MSSQL/MongoDB/
 * ClickHouse growing their own Performance/Replication/Security categories
 * the way PostgreSQL already has) means adding nodes here — the sidebar,
 * breadcrumbs, and landing pages all pick it up automatically.
 */
import { DOCS } from '../helpContent';

const leaf = (doc) => ({ id: doc, doc, title: DOCS[doc]?.title || doc, dek: DOCS[doc]?.dek || '' });
const node = (id, title, dek, children) => ({ id, title, dek, children });

/* ---------------- Getting Started (flat — already small) ---------------- */
const GETTING_STARTED = node('mod-getting-started', 'Getting Started',
  'Five short topics before the full module chapters.', [
    leaf('gs-overview'), leaf('gs-understanding'), leaf('gs-navigation'),
    leaf('gs-dashboard-teaser'), leaf('gs-terminology'),
  ]);

/* ---------------- Dashboard ---------------- */
const DASHBOARD = node('mod-dashboard', 'Dashboard',
  'The monitoring landing page — health, alerts, and fleet summary at a glance.', [
    node('db-cat-overview', 'Overview & Layout', 'What the Dashboard shows and how the page is put together.',
      [leaf('db-overview'), leaf('db-navigation'), leaf('db-layout'), leaf('db-summary')]),
    node('db-cat-health', 'Health & Monitoring', 'How database, agent, and infrastructure health are summarized.',
      [leaf('db-health'), leaf('db-monitoring'), leaf('db-database-mon'), leaf('db-agent-mon'), leaf('db-infra-mon')]),
    node('db-cat-alerts-perf', 'Alerts, Performance & Charts', 'Firing alerts, resource utilization, and every chart on the page.',
      [leaf('db-alerts'), leaf('db-performance'), leaf('db-charts')]),
    node('db-cat-controls', 'Filters, Refresh & Actions', 'What can be filtered, how often data updates, and every clickable action.',
      [leaf('db-filters'), leaf('db-refresh'), leaf('db-actions'), leaf('db-drilldown')]),
    node('db-cat-access', 'Access & States', 'Permissions, and what the page looks like empty, loading, or erroring.',
      [leaf('db-permissions'), leaf('db-states')]),
    node('db-cat-ref', 'Troubleshooting & Reference', 'Practical fixes, and the full field-by-field reference.',
      [leaf('db-troubleshooting'), leaf('db-reference')]),
  ]);

/* ---------------- Agents ---------------- */
const AGENTS = node('mod-agents', 'Agents',
  'ActMon collection agents — host monitoring, database monitoring, and deployment.', [
    node('agt-cat-overview', 'Overview & Layout', 'What the Agents module is, and the Monitored Systems list.',
      [leaf('agt-overview'), leaf('agt-navigation'), leaf('agt-list-layout')]),
    node('agt-cat-health', 'Status, Health & Architecture', 'Reading agent status, and why one host can have more than one agent row.',
      [leaf('agt-status'), leaf('agt-architecture'), leaf('agt-host-monitoring'), leaf('agt-database-monitoring'), leaf('agt-checks')]),
    node('agt-cat-deploy', 'Registration & Deployment', 'Adding a new agent, and syncing existing database connections to it.',
      [leaf('agt-registration-deploy'), leaf('agt-sync')]),
    node('agt-cat-controls', 'Filters, Refresh & Actions', 'List controls, polling intervals, and every available action.',
      [leaf('agt-filters'), leaf('agt-refresh'), leaf('agt-actions'), leaf('agt-drilldown')]),
    node('agt-cat-access', 'Access & States', 'Permissions, and empty/loading/error states.',
      [leaf('agt-permissions'), leaf('agt-states')]),
    node('agt-cat-ref', 'Troubleshooting & Reference', 'Practical fixes, and the full field-by-field reference.',
      [leaf('agt-troubleshooting'), leaf('agt-reference')]),
  ]);

/* ---------------- Database → 7 engines (+ shared fundamentals) ---------------- */
const PG_HA_CHILDREN = [
  leaf('pg-patroni-overview'), leaf('pg-replication-concepts'), leaf('pg-patroni-detection'),
  leaf('pg-patroni-tabs'), leaf('pg-patroni-topology'), leaf('pg-patroni-actions'),
  leaf('pg-patroni-config'), leaf('pg-patroni-diagnosis'), leaf('pg-replication-raw'),
  leaf('pg-ha-troubleshooting'),
];

const POSTGRESQL = node('db-engine-postgresql', 'PostgreSQL',
  'Performance, queries, locks, replication, Patroni HA, and operations.', [
    leaf('dbm-postgresql'),
    node('pg-cat-ha', 'Replication & Patroni HA', 'The full 10-tab HA console, every recovery action, and the concepts behind them.', PG_HA_CHILDREN),
    node('pg-cat-perf', 'Performance & Query Monitoring', 'Slow queries, EXPLAIN plans, and AI-assisted analysis.', [leaf('dbm-slow-queries')]),
    node('pg-cat-ops', 'Operations & Diagnostics', 'Error logs, resource drill-down, and the Diagnose workflow.', [leaf('dbm-error-logs'), leaf('dbm-drilldown-diagnose')]),
    { id: 'pg-cat-security', title: 'Security & Configuration', dek: 'Coming soon — not yet written as a dedicated PostgreSQL topic.', comingSoon: true },
    { id: 'pg-cat-backup', title: 'Backup & Recovery', dek: 'Coming soon — not yet written as a dedicated PostgreSQL topic.', comingSoon: true },
  ]);

const DATABASE = node('mod-databases', 'Database',
  'Monitor MySQL, PostgreSQL, Oracle, SQL Server, MongoDB, ClickHouse, and Cosmos DB.', [
    POSTGRESQL,
    node('db-engine-mysql', 'MySQL / MariaDB', '13-tab dashboard, replication, and a dedicated slow-query workspace.', [leaf('dbm-mysql')]),
    node('db-engine-oracle', 'Oracle', 'Sessions, tablespaces, redo logs, RAC/ASM/CDB-PDB, and Data Guard status.', [leaf('dbm-oracle')]),
    node('db-engine-mssql', 'SQL Server', 'DMV-driven performance, AlwaysOn status, and guided error-log self-heal.', [leaf('dbm-mssql')]),
    node('db-engine-mongodb', 'MongoDB', 'Replica sets, oplog, sharding, and operation-level slow-query capture.', [leaf('dbm-mongodb')]),
    node('db-engine-clickhouse', 'ClickHouse', 'Part pressure, merges, replica/cluster topology, and compression.', [leaf('dbm-clickhouse')]),
    node('db-engine-cosmosdb', 'Cosmos DB', 'RU-aware monitoring — connection, containers, indexing, and Actmon AI.', [leaf('dbm-cosmosdb')]),
    node('db-cat-fundamentals', 'Database Fundamentals', 'Adding a server, connections & collectors, reports, and cross-engine reference.',
      [leaf('dbm-overview'), leaf('dbm-navigation'), leaf('dbm-server-list'), leaf('dbm-add-server'), leaf('dbm-connections'),
       leaf('dbm-reports'), leaf('dbm-permissions'), leaf('dbm-states'), leaf('dbm-troubleshooting'), leaf('dbm-reference')]),
  ]);

/* ---------------- Cloud ---------------- */
const CLOUD = node('mod-cloud', 'Cloud',
  'AWS, Azure, and OCI account monitoring, plus Cosmos DB.', [
    node('cld-cat-overview', 'Overview & Providers', 'What Cloud monitors, and which providers are real.', [leaf('cld-overview'), leaf('cld-providers')]),
    node('cld-cat-accounts', 'Accounts & Dashboard', 'Adding an account, and the 7-tab account dashboard.', [leaf('cld-add-account'), leaf('cld-dashboard-tabs')]),
    node('cld-cat-cost', 'Cost Monitoring', 'Real billed spend vs. an estimate.', [leaf('cld-cost')]),
    node('cld-cat-cosmos', 'Cosmos DB', 'What ActMon can and cannot see without Azure Monitor.', [leaf('cld-cosmosdb')]),
    node('cld-cat-ref', 'Access & Reference', 'Permissions, troubleshooting, and the full reference.', [leaf('cld-permissions'), leaf('cld-troubleshooting'), leaf('cld-reference')]),
  ]);

/* ---------------- Infrastructure ---------------- */
const INFRASTRUCTURE = node('mod-infrastructure', 'Infrastructure',
  'OS-level monitoring for every host — Agent or SSH collected.', [
    node('inf-cat-overview', 'Overview & Hosts', 'What Infrastructure monitors, and the host list.', [leaf('inf-overview'), leaf('inf-host-list')]),
    node('inf-cat-detail', 'Host Detail & Actions', 'The 9 host-detail tabs, and every real action with its exact risk.', [leaf('inf-host-tabs'), leaf('inf-actions')]),
    node('inf-cat-collectors', 'Agent vs. SSH', 'How the two collector types are surfaced, and OS-specific differences.', [leaf('inf-agent-vs-ssh'), leaf('inf-windows-linux')]),
    node('inf-cat-ref', 'Access & Reference', 'Permissions, troubleshooting, and the full reference.', [leaf('inf-permissions'), leaf('inf-troubleshooting'), leaf('inf-reference')]),
  ]);

/* ---------------- Alerts ---------------- */
const ALERTS = node('mod-alerts', 'Alerts',
  'Rule-evaluated and agent-reported alerts, and notification delivery.', [
    node('alt-cat-overview', 'Overview & Active Alerts', 'What an alert is, and the live firing feed.', [leaf('alt-overview'), leaf('alt-active')]),
    node('alt-cat-rules', 'Rules & Metric Catalogue', 'The 4 rule sections, honesty flags, and the 6-step rule wizard.', [leaf('alt-rules'), leaf('alt-rule-wizard')]),
    node('alt-cat-notify', 'Notification Delivery & History', 'Where channels are configured, and the delivery audit trail.', [leaf('alt-notifications'), leaf('alt-history')]),
    node('alt-cat-ref', 'Access & Reference', 'Permissions, troubleshooting, and the full reference.', [leaf('alt-permissions'), leaf('alt-troubleshooting'), leaf('alt-reference')]),
  ]);

/* ---------------- AI Assistant ---------------- */
const AI_ASSISTANT = node('mod-ai', 'AI Assistant',
  'The ActMon AI chat assistant, and the per-connection Diagnosis page.', [
    node('ai-cat-chat', 'ActMon AI Chat', 'Using the assistant, and what happens when it proposes an action.', [leaf('ai-overview'), leaf('ai-chat-usage'), leaf('ai-chat-actions')]),
    node('ai-cat-diagnosis', 'Diagnosis & Recommendations', 'The per-connection Diagnosis page, and recommendation vs. action.', [leaf('ai-diagnosis-page'), leaf('ai-recommendation-vs-action')]),
    node('ai-cat-ref', 'Limitations & Reference', 'What AI can’t do, troubleshooting, and the full reference.', [leaf('ai-limitations'), leaf('ai-troubleshooting'), leaf('ai-reference')]),
  ]);

/* ---------------- Administration ---------------- */
const ADMINISTRATION = node('mod-administration', 'Administration',
  'Users, roles, page-level permissions, and audit trails.', [
    node('adm-cat-overview', 'Overview & Structure', 'Every real resource, and the org/department/employee structure.', [leaf('adm-overview'), leaf('adm-users-roles')]),
    node('adm-cat-rbac', 'Permissions & Access Control', 'The global catalogues, and granting page-level permissions.', [leaf('adm-catalog'), leaf('adm-role-page-permission')]),
    node('adm-cat-audit', 'Audit & Security Tracking', 'Row-level change history, and the AI chat sessions audit.', [leaf('adm-audit-security'), leaf('adm-ai-chat-sessions')]),
    node('adm-cat-ref', 'Access & Reference', 'Permissions, troubleshooting, and the full reference.', [leaf('adm-permissions'), leaf('adm-troubleshooting'), leaf('adm-reference')]),
  ]);

/* ---------------- Setting ---------------- */
const SETTINGS = node('mod-settings', 'Setting',
  'Appearance (per-browser) and Notifications (per-organization).', [
    node('set-cat-overview', 'Overview & Appearance', 'The two top-level tabs, and every visual setting.', [leaf('set-overview'), leaf('set-appearance')]),
    node('set-cat-notify', 'Notification Delivery', 'Time zone, SMTP, the 9 channels, templates, and severity routing.',
      [leaf('set-notifications-general'), leaf('set-smtp'), leaf('set-channels'), leaf('set-templates-routing')]),
    node('set-cat-ref', 'Troubleshooting & Reference', 'Practical fixes, and the full reference.', [leaf('set-troubleshooting'), leaf('set-reference')]),
  ]);

const SALES = { id: 'mod-sales', title: 'Sales', dek: 'Documentation for Sales has not been written yet.', comingSoon: true };

/* ---------------- Troubleshooting & Certification (top-level, flat) ---------------- */
const TROUBLESHOOTING = node('mod-troubleshooting', 'Troubleshooting Knowledge Base',
  'Every troubleshooting topic in this documentation, indexed by symptom.', [
    leaf('tsh-hub'), leaf('tsh-connection-failed'), leaf('tsh-authentication-failure'), leaf('tsh-permission-denied'),
  ]);

const CERTIFICATION = node('mod-certification', 'Certification Preparation',
  'This documentation organized into an 11-stage learning path.', [
    leaf('cert-overview'), leaf('cert-fundamentals'), leaf('cert-dashboard'), leaf('cert-agents'),
    leaf('cert-database'), leaf('cert-performance'), leaf('cert-replication-ha'), leaf('cert-alerts'),
    leaf('cert-troubleshooting'), leaf('cert-administration'), leaf('cert-security'), leaf('cert-advanced'),
  ]);

export const TREE = node('root', 'ActMon Documentation', '', [
  GETTING_STARTED, DASHBOARD, AGENTS, DATABASE, CLOUD, INFRASTRUCTURE, ALERTS, AI_ASSISTANT, ADMINISTRATION, SETTINGS, SALES,
  TROUBLESHOOTING, CERTIFICATION,
]);

/* ---------------- lookup helpers ---------------- */

/** Find a node by id, anywhere in the tree. */
export function findNode(id, from = TREE) {
  if (from.id === id) return from;
  for (const child of from.children || []) {
    const found = findNode(id, child);
    if (found) return found;
  }
  return null;
}

/** The chain of ancestors from root to `id` (inclusive), or null. */
export function pathTo(id, from = TREE, trail = []) {
  const next = [...trail, from];
  if (from.id === id) return next;
  for (const child of from.children || []) {
    const found = pathTo(id, child, next);
    if (found) return found;
  }
  return null;
}

/** A leaf node's DOCS id, if `id` resolves to one (landing nodes have none). */
export function docIdFor(id) {
  const n = findNode(id);
  return n && n.doc ? n.doc : null;
}

/** True if `id` is a landing node (has children) rather than a leaf article. */
export function isLanding(id) {
  const n = findNode(id);
  return !!(n && n.children && n.children.length);
}

/** Total leaf-article count under a node (recursive) — the "N topics" count
 * a landing card shows, always real (never hand-typed and liable to drift). */
export function leafCount(n) {
  if (!n.children) return n.doc ? 1 : 0;
  return n.children.reduce((sum, c) => sum + leafCount(c), 0);
}

/** Flattened list of every leaf DOCS id under a node, in document order —
 * used to build FLOW (Prev/Next) contiguously per section. */
export function flattenLeaves(n) {
  if (!n.children) return n.doc ? [n.doc] : [];
  return n.children.flatMap(flattenLeaves);
}
