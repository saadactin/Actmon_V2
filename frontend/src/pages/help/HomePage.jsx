import { useMemo, useState } from 'react';
import Icon from '@/components/ui/Icon';
import { PhotoBand } from './Illustration';
import { GS_TOPICS, GS_BLURBS, MODULES, CERT_TOPICS, TREE, leafCount } from './content';
import { useHelpSearchIndex, searchDocs } from './useHelpSearch';
import { TYPE } from './designTokens';
import { useHelpAppearance } from './appearance/HelpAppearanceContext';
import { DEFAULT_CONFIG } from './appearance/helpAppearanceConfig';
import { resolveCategoryColor } from './appearance/cardStyleVars';
import DocumentationCard from './appearance/DocumentationCard';

const IMG = {
  metricsWave: '/help-images/metrics-wave.jpg',
  networkTopology: '/help-images/network-topology.png',
  controlDesk: '/help-images/control-desk-illustration.avif',
  dashboardTiles: '/help-images/dashboard-tiles.jpg',
  circuitAbstract: '/help-images/circuit-abstract.jpg',
  getStartedDesk: '/help-images/get-started-desk.png',
  heroBanner: '/help-images/hero-banner.jpg',
  retroMonitor: '/help-images/retro-monitor-chart.avif',
  dashboardOverview: '/help-images/dashboard-overview.jpg',
  agentModule: '/help-images/agent-module.jpg',
  cloudModule: '/help-images/cloud-module.jpg',
  infraModule: '/help-images/infra-module.jpg',
  mysqlEngine: '/help-images/mysql-engine.jpg',
  postgresqlEngine: '/help-images/postgresql-engine.png',
  oracleEngine: '/help-images/oracle-engine.jpg',
  mssqlEngine: '/help-images/mssql-engine.jpg',
  mongodbEngine: '/help-images/mongodb-engine.png',
  clickhouseEngine: '/help-images/clickhouse-engine.png',
  postgresqlPatroni: '/help-images/postgresql-patroni.png',
  alertModule: '/help-images/alert-module.webp',
  dashboardModule: '/help-images/dashboard-module.jpg',
  salesModule: '/help-images/sales-module.jpeg',
  settingModule: '/help-images/setting-module.jpg',
  troubleshootModule: '/help-images/troubleshoot-module.webp',
  recoveryModule: '/help-images/recovery-module.jpg',
  replicationHaConcept: '/help-images/replication-ha-concept.jpg',
  databaseModule: '/help-images/database-module.jpg',
};

/** A few cards use one specific, deliberately-chosen photo instead of the
 * cycled pool below — set per card id here so that choice is explicit and
 * doesn't get shuffled if the pool or card order changes later. Every
 * dedicated photo here is shown in its own real colors (no hue tint) — the
 * tint exists only to differentiate the shared pool photos used by cards
 * that don't have one of their own. */
const FIXED_PHOTO = {
  'gs-overview': IMG.dashboardOverview,
  'mod-dashboard': IMG.dashboardModule,
  'mod-agents': IMG.agentModule,
  'mod-cloud': IMG.cloudModule,
  'mod-infrastructure': IMG.infraModule,
  'mod-alerts': IMG.alertModule,
  'mod-settings': IMG.settingModule,
  'mod-sales': IMG.salesModule,
  'mod-databases': IMG.databaseModule,
};

/** The 7 real, cleared images this Help Center has, in a fixed rotation.
 * Every card-grid section below picks from this SAME pool by index (with a
 * per-section offset so different sections don't all open on the same
 * photo) rather than needing one bespoke image per card — there are more
 * cards across the page than real photos, so cards that carry their own
 * brand hue (database engines, module categories) get a `color-mix` tint
 * over the shared photo (see `PhotoBand`'s `hue` prop) so they still read as
 * visually distinct, not as the same picture repeated. */
const PHOTO_POOL = [
  IMG.dashboardTiles, IMG.networkTopology, IMG.controlDesk, IMG.circuitAbstract,
  IMG.getStartedDesk, IMG.metricsWave, IMG.retroMonitor,
];
const photoAt = (i, offset = 0) => PHOTO_POOL[(i + offset) % PHOTO_POOL.length];

const SUGGESTIONS = [
  'replication lag', 'restart patroni', 'agent offline', 'slow query', 'database health',
];

const POPULAR_TOPICS = [
  ['dbm-add-server', 'Add a database server'],
  ['agt-registration-deploy', 'Install the ActMon Agent'],
  ['db-health', 'Check database health'],
  ['pg-replication-concepts', 'Understand replication'],
  ['dbm-slow-queries', 'Investigate slow queries'],
  ['dbm-error-logs', 'View error logs'],
  ['alt-rule-wizard', 'Configure alerts'],
  ['ai-diagnosis-page', 'Diagnose database problems'],
  ['pg-patroni-actions', 'Perform recovery actions'],
];

const TROUBLESHOOTING_LINKS = [
  ['agt-troubleshooting', 'Agent Offline'],
  ['tsh-connection-failed', 'Database Connection Failed'],
  ['pg-ha-troubleshooting', 'Replication Lag'],
  ['pg-ha-troubleshooting', 'PostgreSQL Replica Not Streaming'],
  ['pg-ha-troubleshooting', 'Patroni Warning'],
  ['inf-troubleshooting', 'High CPU'],
  ['inf-troubleshooting', 'High Memory'],
  ['inf-troubleshooting', 'Disk Space Issue'],
  ['dbm-slow-queries', 'Slow Query'],
  ['tsh-authentication-failure', 'Authentication Failure'],
];

/** Home shows exactly ONE card per module — never its children (e.g. one
 * "Database" card, not seven per-engine cards). Clicking it opens that
 * module's own landing page, where the engines/categories become the next
 * level's card grid. Getting Started, Troubleshooting, and Certification
 * are excluded here since each already has its own dedicated Home section
 * below. */
const HIDDEN_ON_BROWSE = new Set(['mod-getting-started', 'mod-troubleshooting', 'mod-certification']);
/** Hue is resolved per-render from the admin-configurable `categoryColors`
 * (see HomePage()) rather than baked in here — this list only carries the
 * content-shape fields that never change with appearance settings. */
const BROWSE_MODULES_BASE = TREE.children
  .filter((n) => !HIDDEN_ON_BROWSE.has(n.id))
  .map((n) => ({
    id: n.id,
    title: n.title,
    dek: n.dek,
    comingSoon: !!n.comingSoon,
    count: n.comingSoon ? 0 : leafCount(n),
    icon: MODULES.find((m) => m.id === n.id)?.icon || 'report',
  }));

const OPERATIONS_CARDS = [
  { id: 'pg-patroni-overview', label: 'PostgreSQL Replication & Patroni', desc: 'The full 10-tab HA console — topology, recovery actions, configuration.', hue: '#336791', photo: '/help-images/postgresql-patroni.png' },
  { id: 'pg-replication-concepts', label: 'Replication & HA Concepts', desc: 'LSN, WAL, timeline, leader/replica, cascading — explained plainly.', hue: '#7C5CFC', photo: '/help-images/replication-ha-concept.jpg' },
  { id: 'tsh-hub', label: 'Troubleshooting', desc: 'Every symptom in this documentation, indexed in one place.', hue: '#DC2626', photo: '/help-images/troubleshoot-module.webp' },
  { id: 'pg-patroni-actions', label: 'Recovery & Operations', desc: 'Every HA action, its risk, and exactly when to use it.', hue: '#059669', photo: '/help-images/recovery-module.jpg' },
];

const COVERAGE = [
  { label: 'Getting Started', pct: 100 },
  { label: 'Dashboard', pct: 100 },
  { label: 'Agents', pct: 100 },
  { label: 'Database (core + PostgreSQL/Patroni HA)', pct: 100 },
  { label: 'MySQL / Oracle / MSSQL / MongoDB / ClickHouse deep dive', pct: 35 },
  { label: 'Cloud', pct: 100 },
  { label: 'Infrastructure', pct: 100 },
  { label: 'Alerts', pct: 100 },
  { label: 'AI Assistant', pct: 100 },
  { label: 'Administration', pct: 100 },
  { label: 'Setting', pct: 100 },
  { label: 'Certification Preparation', pct: 100 },
  { label: 'Sales', pct: 0 },
];

export default function HomePage({ go }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const index = useHelpSearchIndex();
  const results = useMemo(() => searchDocs(index, query, 8), [index, query]);
  const { config } = useHelpAppearance();
  const BROWSE_MODULES = useMemo(
    () => BROWSE_MODULES_BASE.map((m) => ({ ...m, hue: resolveCategoryColor(config, m.id, DEFAULT_CONFIG) })),
    [config],
  );

  const submitSearch = () => {
    if (query.trim()) go(`search:${query.trim()}`);
  };

  return (
    <div className="pb-6">
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="card relative mb-gutter-lg overflow-hidden px-8 py-14 text-center sm:px-14">
        <PhotoBand src={IMG.heroBanner} className="pointer-events-none absolute inset-0" objectPosition="center" />
        <div className="relative">
          <h1 className="mx-auto max-w-[38ch] text-[2.1rem] leading-[1.15] font-bold tracking-[-0.015em] text-fg sm:text-[2.6rem]">
            How can we help you with ActMon?
          </h1>
          <p className="mx-auto mt-3 max-w-[62ch] text-[15.5px] leading-relaxed text-muted">
            Explore ActMon documentation, monitoring guides, troubleshooting procedures, and certification
            learning resources.
          </p>

          <div className="relative mx-auto mt-8 max-w-[580px]">
            <Icon name="search" size={18} className="pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 120)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitSearch(); }}
              placeholder="Search ActMon documentation…"
              className="h-14 w-full rounded-full border border-border bg-surface pl-13 pr-5 text-[15px] text-fg shadow-md placeholder:text-subtle focus:border-accent-border focus:outline-none"
            />
            {focused && query.trim() && (
              <div className="absolute top-[calc(100%+8px)] right-0 left-0 z-30 max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-surface p-1.5 text-left shadow-lg">
                {results.length === 0 ? (
                  <p className="px-3 py-3 text-[12.5px] text-subtle">No matches yet — try a different word.</p>
                ) : results.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onMouseDown={() => go(r.id)}
                    className="block w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-sunken"
                  >
                    <div className="truncate-safe font-mono text-[10px] font-semibold tracking-wide text-subtle uppercase">{r.module}</div>
                    <div className="truncate-safe text-[13.5px] font-semibold text-fg">{r.title}</div>
                  </button>
                ))}
                <button
                  type="button"
                  onMouseDown={submitSearch}
                  className="mt-1 block w-full rounded-md px-3 py-2 text-left font-mono text-[11.5px] font-semibold text-accent-text hover:bg-accent-soft"
                >
                  See all results for &ldquo;{query.trim()}&rdquo; →
                </button>
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <span className="text-[11.5px] text-subtle">Try:</span>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => { setQuery(s); go(`search:${s}`); }}
                className="rounded-full border border-border bg-surface px-3 py-1 text-[11.5px] text-muted transition-colors hover:border-accent hover:text-accent-text"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── Get Started (image-led) ──────────────────────────────────── */}
      <SectionHeading title="Get Started" desc="Five short topics before the full module chapters." />
      <div className="hc-grid mb-gutter-lg">
        {GS_TOPICS.map(([id, lbl], i) => (
          <DocumentationCard
            key={id}
            onClick={() => go(id)}
            image={FIXED_PHOTO[id] || photoAt(i)}
            imageAlt={lbl}
            title={lbl}
            description={GS_BLURBS[id]}
          />
        ))}
      </div>

      {/* ── Browse ActMon (module grid — one card per module, never its
          children; Database shows a single card here, not per-engine
          cards — drilling into it is what reveals the 7 engines) ───── */}
      <SectionHeading title="Browse ActMon" desc="Every module ActMon's own navigation bar links to — documented where a chapter exists, honestly marked Coming Soon where it doesn't." />
      <div className="hc-grid mb-gutter-lg">
        {BROWSE_MODULES.map((m, i) => (
          <DocumentationCard
            key={m.id}
            onClick={() => go(m.id)}
            disabled={m.comingSoon}
            image={FIXED_PHOTO[m.id] || photoAt(i, 2)}
            imageAlt={m.title}
            hue={m.hue}
            imageHue={FIXED_PHOTO[m.id] ? null : m.hue}
            icon={m.icon}
            title={m.title}
            meta={m.comingSoon ? 'Soon' : undefined}
            description={m.dek}
            disabledNote={m.comingSoon ? 'Planned once the current phase of module chapters is complete.' : undefined}
            footerLeft={m.comingSoon ? undefined : `${m.count} topic${m.count !== 1 ? 's' : ''}`}
            footerRight={m.comingSoon ? undefined : 'Explore'}
          />
        ))}
      </div>

      {/* ── Operations & High Availability ───────────────────────────── */}
      <SectionHeading title="Operations & High Availability" />
      <div className="mb-gutter-lg grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {OPERATIONS_CARDS.map((c) => (
          <button key={c.label} type="button" onClick={() => go(c.id)} className="card group flex flex-col overflow-hidden p-0 text-left">
            <PhotoBand src={c.photo} className="h-24 w-full transition-transform duration-300 group-hover:scale-[1.04]" objectPosition="center" />
            <div className="flex flex-1 flex-col gap-1.5 px-3.5 py-3.5">
              <span className={`font-mono font-semibold text-fg ${TYPE.cardTitleCompact}`}>{c.label}</span>
              <span className={`leading-snug text-muted ${TYPE.bodySecondary}`}>{c.desc}</span>
            </div>
          </button>
        ))}
      </div>

      {/* ── Learn ActMon (editorial 2-col) ───────────────────────────── */}
      <div className="card mb-gutter-lg grid grid-cols-1 gap-6 overflow-hidden p-0 lg:grid-cols-2">
        <div className="flex flex-col justify-center gap-3 px-8 py-9">
          <span className="font-mono text-[10px] font-bold tracking-wide text-accent-text uppercase">Learn ActMon</span>
          <h2 className="text-[1.4rem] font-bold text-fg">Go from first login to confident operator</h2>
          <p className={`leading-relaxed text-muted ${TYPE.bodySecondary}`}>
            Start with the fundamentals, then work module by module — Dashboard, Agents, and Database first, then
            Performance, Replication &amp; HA, and Alerts. Every topic is grounded in the real ActMon interface, so
            what you read is exactly what you'll see on screen.
          </p>
          <button
            type="button"
            onClick={() => go('gs-overview')}
            className="mt-1 flex w-fit items-center gap-1.5 rounded-control bg-accent px-4 py-2 text-[13px] font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
          >
            Start with Getting Started <Icon name="chevron-right" size={13} />
          </button>
        </div>
        <PhotoBand src={IMG.networkTopology} className="min-h-[220px] w-full" />
      </div>

      {/* ── Certification portal ─────────────────────────────────────── */}
      <section className="card mb-gutter-lg overflow-hidden p-0">
        <div className="relative overflow-hidden px-8 py-10 text-center sm:px-14">
          <PhotoBand src={IMG.controlDesk} className="pointer-events-none absolute inset-0" overlay objectPosition="center 20%" />
          <div className="relative">
            <span className="font-mono text-[10px] font-bold tracking-wide text-accent-text uppercase">Certification</span>
            <h2 className="mx-auto mt-2 max-w-[36ch] text-[1.75rem] font-bold text-fg">
              Become an ActMon Certified Monitoring Professional
            </h2>
            <p className={`mx-auto mt-2.5 max-w-[58ch] leading-relaxed text-muted ${TYPE.bodySecondary}`}>
              Build practical knowledge of ActMon monitoring, database operations, infrastructure monitoring,
              troubleshooting, and administration.
            </p>
            <button
              type="button"
              onClick={() => go('cert-overview')}
              className="mx-auto mt-5 flex items-center gap-1.5 rounded-control bg-accent px-5 py-2.5 text-[13.5px] font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
            >
              Start Certification Preparation <Icon name="chevron-right" size={14} />
            </button>
          </div>
        </div>

        <div className="border-t border-border px-5 py-6 sm:px-7">
          <div className="mb-4 flex items-center gap-1 overflow-x-auto pb-1">
            {CERT_TOPICS.slice(1).map(([, lbl], i) => (
              <div key={lbl} className="flex shrink-0 items-center">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft font-mono text-[10px] font-bold text-accent-text">
                  {String(i + 1).padStart(2, '0')}
                </span>
                {i < 10 && <span className="h-px w-5 bg-border" />}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {CERT_TOPICS.slice(1).map(([id, lbl], i) => (
              <button
                key={id}
                type="button"
                onClick={() => go(id)}
                className="card flex flex-col gap-1.5 px-3.5 py-3 text-left transition-colors hover:border-accent hover:bg-accent-soft"
              >
                <span className="font-mono text-[9.5px] font-bold tracking-wide text-subtle uppercase">Stage {String(i + 1).padStart(2, '0')}</span>
                <span className="text-[13px] font-semibold text-fg">{lbl.replace(/^\d+\.\s*/, '')}</span>
                <span className="mt-auto flex items-center gap-1 pt-1 font-mono text-[10.5px] font-bold text-accent-text">
                  Start Learning <Icon name="chevron-right" size={11} />
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── Popular topics ───────────────────────────────────────────── */}
      <SectionHeading title="Popular topics" />
      <div className="mb-gutter-lg grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {POPULAR_TOPICS.map(([id, lbl]) => (
          <button
            key={lbl}
            type="button"
            onClick={() => go(id)}
            className="card flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:border-accent hover:bg-accent-soft"
          >
            <Icon name="report" size={14} className="shrink-0 text-accent-text" />
            <span className="truncate-safe text-[13px] font-medium text-fg">{lbl}</span>
          </button>
        ))}
      </div>

      {/* ── Troubleshooting ──────────────────────────────────────────── */}
      <SectionHeading title="Troubleshooting Center" desc="Common problems, indexed by symptom." />
      <div className="mb-gutter-lg grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {TROUBLESHOOTING_LINKS.map(([id, lbl]) => (
          <button
            key={lbl}
            type="button"
            onClick={() => go(id)}
            className="card flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:border-danger hover:bg-danger-soft"
          >
            <Icon name="wrench" size={14} className="shrink-0 text-danger-fg" />
            <span className="truncate-safe text-[13px] font-medium text-fg">{lbl}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => go('tsh-hub')}
          className="card flex items-center justify-center gap-2 px-3.5 py-2.5 text-left font-mono text-[12px] font-bold text-accent-text transition-colors hover:bg-accent-soft"
        >
          View the full Troubleshooting Knowledge Base →
        </button>
      </div>

      {/* ── Documentation coverage ────────────────────────────────────── */}
      <SectionHeading title="Documentation Coverage" desc="An honest status, not a claim of completeness." />
      <div className="card flex flex-col gap-3 px-5 py-5">
        {COVERAGE.map((c) => (
          <div key={c.label} className="flex items-center gap-4">
            <span className="w-[min(46%,320px)] shrink-0 truncate-safe text-[12.5px] font-medium text-fg">{c.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-sunken">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${c.pct}%`, background: c.pct === 100 ? 'var(--success)' : c.pct === 0 ? 'var(--border-strong)' : 'var(--warning)' }}
              />
            </div>
            <span className="w-24 shrink-0 text-right font-mono text-[11px] font-semibold text-muted">
              {c.pct === 100 ? 'Complete' : c.pct === 0 ? 'Coming Soon' : 'In Progress'}
            </span>
          </div>
        ))}
      </div>

      <p className="mt-8 max-w-[70ch] border-t border-border pt-5 text-[12px] leading-relaxed text-subtle">
        This documentation is written directly from the current ActMon implementation. Where a capability is not
        yet present in the running application, this documentation says so explicitly instead of describing it as
        available.
      </p>
    </div>
  );
}

function SectionHeading({ title, desc }) {
  return (
    <div className="mt-2 mb-3.5">
      <h2 className={`font-mono font-semibold text-fg ${TYPE.sectionTitle}`}>{title}</h2>
      {desc && <p className={`mt-0.5 text-muted ${TYPE.bodySecondary}`}>{desc}</p>}
    </div>
  );
}

