/**
 * Content merge layer — combines the original core chapters (Getting
 * Started, Dashboard, Agents, generic Database, all in ../helpContent.js)
 * with every new chapter added in this directory. Every new chapter file
 * populates the SAME shared `DOCS` object by importing it from
 * ../helpContent — this file is what actually pulls them all in (import
 * order here is what makes their DOCS[...] assignments run) and re-wires
 * MODULES/HOME_CATEGORIES/FLOW to include them.
 *
 * Why chapters live in separate files instead of growing the original
 * 2600-line helpContent.js further: the original 4 chapters are verified,
 * stable content — splitting new chapters into their own files means adding
 * chapter N+1 later never risks a merge conflict or an accidental edit
 * inside chapter N's already-reviewed HTML.
 */
import {
  DOCS, MODULES, icon, ORC_HUES,
  GS_TOPICS, DASH_TOPICS, AGENTS_TOPICS, DATABASE_TOPICS, GS_BLURBS,
} from '../helpContent';

import { PG_HA_TOPICS } from './postgresqlHA';
import { CLOUD_TOPICS } from './cloud';
import { INFRA_TOPICS } from './infrastructure';
import { ALERTS_TOPICS } from './alerts';
import { AI_TOPICS } from './aiAssistant';
import { ADMIN_TOPICS } from './administration';
import { SETTINGS_TOPICS } from './settings';
import { TROUBLESHOOTING_TOPICS } from './troubleshooting';
import { CERT_TOPICS } from './certification';

export { DOCS, MODULES, icon, ORC_HUES, GS_TOPICS, GS_BLURBS };
export { TROUBLESHOOTING_TOPICS, CERT_TOPICS };

/* The PostgreSQL/Patroni deep-dive isn't its own top-nav module (Postgres is
   part of Database) — it's appended to the Database module's own sidebar
   group, right after the per-engine dashboard topics, rather than becoming a
   4th level of nesting the sidebar doesn't support. */
const DATABASE_TOPICS_FULL = [...DATABASE_TOPICS, ...PG_HA_TOPICS];

const topicsFor = (id, topics) => {
  const m = MODULES.find((x) => x.id === id);
  if (m) m.topics = topics;
};
topicsFor('mod-dashboard', DASH_TOPICS);
topicsFor('mod-agents', AGENTS_TOPICS);
topicsFor('mod-databases', DATABASE_TOPICS_FULL);
topicsFor('mod-cloud', CLOUD_TOPICS);
topicsFor('mod-infrastructure', INFRA_TOPICS);
topicsFor('mod-alerts', ALERTS_TOPICS);
topicsFor('mod-ai', AI_TOPICS);
topicsFor('mod-administration', ADMIN_TOPICS);
topicsFor('mod-settings', SETTINGS_TOPICS);

export const DATABASE_TOPICS_WITH_HA = DATABASE_TOPICS_FULL;

/* ---------------- extended FLOW (Prev/Next footer) ----------------
   Chapter order: Getting Started → Dashboard → Agents → Database (incl.
   Patroni HA) → Cloud → Infrastructure → Alerts → AI Assistant →
   Administration → Setting → Troubleshooting → Certification. */
export const FLOW = [
  ...GS_TOPICS.map((t) => t[0]),
  ...DASH_TOPICS.map((t) => t[0]),
  ...AGENTS_TOPICS.map((t) => t[0]),
  ...DATABASE_TOPICS_FULL.map((t) => t[0]),
  ...CLOUD_TOPICS.map((t) => t[0]),
  ...INFRA_TOPICS.map((t) => t[0]),
  ...ALERTS_TOPICS.map((t) => t[0]),
  ...AI_TOPICS.map((t) => t[0]),
  ...ADMIN_TOPICS.map((t) => t[0]),
  ...SETTINGS_TOPICS.map((t) => t[0]),
  ...TROUBLESHOOTING_TOPICS.map((t) => t[0]),
  ...CERT_TOPICS.map((t) => t[0]),
];

/* ---------------- rebuilt HOME_CATEGORIES ----------------
   Every module that now has a written chapter gets curated links + a seeAll
   pointer, same shape the original 3 categories used — 'Sales' is the only
   module bar item still genuinely unbuilt, so it's the only one left in the
   auto-generated "coming soon" state. */
const label = (topics, id) => topics.find((t) => t[0] === id)[1];

export const HOME_CATEGORIES = [
  { id: 'mod-dashboard', label: 'Dashboard', icon: 'layout-grid', hue: ORC_HUES['mod-dashboard'], available: true, seeAll: 'db-reference',
    links: ['db-overview', 'db-health', 'db-monitoring', 'db-alerts', 'db-troubleshooting'].map((id) => ({ id, label: label(DASH_TOPICS, id) })) },
  { id: 'mod-agents', label: 'Agents', icon: 'shield', hue: ORC_HUES['mod-agents'], available: true, seeAll: 'agt-reference',
    links: ['agt-overview', 'agt-status', 'agt-architecture', 'agt-registration-deploy', 'agt-troubleshooting'].map((id) => ({ id, label: label(AGENTS_TOPICS, id) })) },
  { id: 'mod-databases', label: 'Database', icon: 'database', hue: ORC_HUES['mod-databases'], available: true, seeAll: 'dbm-reference',
    links: ['dbm-overview', 'dbm-server-list', 'dbm-slow-queries', 'pg-patroni-overview', 'dbm-troubleshooting'].map((id) => ({ id, label: label(DATABASE_TOPICS_FULL, id) })) },
  { id: 'mod-cloud', label: 'Cloud', icon: 'cloud', hue: ORC_HUES['mod-cloud'], available: true, seeAll: 'cld-reference',
    links: ['cld-overview', 'cld-providers', 'cld-add-account', 'cld-cost', 'cld-cosmosdb'].map((id) => ({ id, label: label(CLOUD_TOPICS, id) })) },
  { id: 'mod-infrastructure', label: 'Infrastructure', icon: 'server', hue: ORC_HUES['mod-infrastructure'], available: true, seeAll: 'inf-reference',
    links: ['inf-overview', 'inf-host-tabs', 'inf-actions', 'inf-agent-vs-ssh', 'inf-troubleshooting'].map((id) => ({ id, label: label(INFRA_TOPICS, id) })) },
  { id: 'mod-alerts', label: 'Alerts', icon: 'alert', hue: ORC_HUES['mod-alerts'], available: true, seeAll: 'alt-reference',
    links: ['alt-overview', 'alt-rules', 'alt-rule-wizard', 'alt-notifications', 'alt-troubleshooting'].map((id) => ({ id, label: label(ALERTS_TOPICS, id) })) },
  { id: 'mod-ai', label: 'AI Assistant', icon: 'sparkles', hue: '#8B5CF6', available: true, seeAll: 'ai-reference',
    links: ['ai-overview', 'ai-chat-usage', 'ai-diagnosis-page', 'ai-recommendation-vs-action', 'ai-troubleshooting'].map((id) => ({ id, label: label(AI_TOPICS, id) })) },
  { id: 'mod-administration', label: 'Administration', icon: 'user-cog', hue: ORC_HUES['mod-administration'], available: true, seeAll: 'adm-reference',
    links: ['adm-overview', 'adm-users-roles', 'adm-role-page-permission', 'adm-audit-security', 'adm-troubleshooting'].map((id) => ({ id, label: label(ADMIN_TOPICS, id) })) },
  { id: 'mod-settings', label: 'Setting', icon: 'settings', hue: ORC_HUES['mod-settings'], available: true, seeAll: 'set-reference',
    links: ['set-overview', 'set-appearance', 'set-smtp', 'set-channels', 'set-troubleshooting'].map((id) => ({ id, label: label(SETTINGS_TOPICS, id) })) },
  ...MODULES.filter((m) => !m.topics && m.id !== 'mod-profile').map((m) => ({ id: m.id, label: m.label, icon: m.icon, hue: ORC_HUES[m.id] || '#94A3B8', available: false, seeAll: null, links: [] })),
];

export const HOME_BANNERS = [
  { eyebrow: 'REFERENCE', title: 'Replication & HA field guide', hue: ORC_HUES['mod-databases'], go: 'pg-patroni-overview',
    desc: 'LSN, WAL, timeline, leader/replica, cascading replicas, and every Patroni recovery action — with exact risk and confirmation text.' },
  { eyebrow: 'OPERATIONS', title: 'Deploying & troubleshooting agents', hue: ORC_HUES['mod-agents'], go: 'agt-registration-deploy',
    desc: 'How to register, deploy, and diagnose ActMon collection agents on a monitored host.' },
  { eyebrow: 'KNOWLEDGE BASE', title: 'Troubleshooting, by symptom', hue: '#DC2626', go: 'tsh-hub',
    desc: 'Every troubleshooting topic in this documentation, indexed in one place — find your symptom and jump straight to the fix.' },
  { eyebrow: 'REFERENCE', title: 'Database module reference', hue: ORC_HUES['mod-databases'], go: 'dbm-reference',
    desc: 'Every one of the seven engine dashboards, the shared server-list/connection layer, and the real backend routes behind them.' },
  { eyebrow: 'LEARNING PATH', title: 'ActMon Certification Preparation', hue: '#0C7C8C', go: 'cert-overview',
    desc: 'This documentation organized into an 11-stage learning path, ready for a future certification course.' },
];
