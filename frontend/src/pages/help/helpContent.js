/**
 * Help Center content — extracted verbatim from the ActMon documentation build
 * (Getting Started, Dashboard, and Agents chapters). Body HTML strings are
 * rendered via dangerouslySetInnerHTML in HelpCenterPage.jsx, so this data is
 * unchanged from the original source; only the rendering layer is React now.
 */
export const ICONS = {
  dashboard:'<path d="M4 5h7v6H4V5zm9 0h7v4h-7V5zM4 13h7v6H4v-6zm9-2h7v8h-7v-8z" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  agents:'<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  db:'<path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" stroke="currentColor" stroke-width="1.5" fill="none"/>',
  cloud:'<path d="M7 18a4 4 0 01-1-7.87A5 5 0 0116 8a4.5 4.5 0 011 8.9" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  infra:'<rect x="4" y="4" width="16" height="6" rx="1" stroke="currentColor" stroke-width="1.6" fill="none"/><rect x="4" y="14" width="16" height="6" rx="1" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  ml:'<path d="M9 4h6l1 4-4 3 4 3-1 6H9l-1-6 4-3-4-3 1-4z" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  alerts:'<path d="M12 3l9 16H3l9-16z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  admin:'<circle cx="12" cy="8" r="3" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M5 20c1-4 4-6 7-6s6 2 7 6" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  settings:'<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 00-2-1.2L14.2 3H9.8l-.4 2.6a7 7 0 00-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.3-1a7 7 0 002 1.2l.4 2.6h4.4l.4-2.6a7 7 0 002-1.2l2.3 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" stroke="currentColor" stroke-width="1.1" fill="none"/>',
  chatbot:'<rect x="4" y="5" width="16" height="12" rx="3" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M9 21l2-4h2l2 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  sales:'<path d="M4 17l5-6 4 3 7-9" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  profile:'<circle cx="12" cy="8" r="3.4" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M5 20c1.2-4.2 4.3-6.4 7-6.4s5.8 2.2 7 6.4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
  book:'<path d="M4 5c2-1 5-1 8 0 3-1 6-1 8 0v13c-2-1-5-1-8 0-3-1-6-1-8 0V5z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M12 5v13" stroke="currentColor" stroke-width="1.5"/>',
};
export const icon = (name, size=14) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none">${ICONS[name]||ICONS.book}</svg>`;

/* ---- module bar (real, from src/config/navigation.js — module_master) ---- */
export const MODULES = [
  {id:'mod-dashboard', label:'Dashboard', icon:'dashboard', route:'/dashboard', available:true},
  {id:'mod-agents', label:'Agents', icon:'agents', route:'/agents', available:true},
  {id:'mod-databases', label:'Database', icon:'db', route:'/databases', available:true},
  {id:'mod-cloud', label:'Cloud', icon:'cloud', route:'/cloud', available:false},
  {id:'mod-infrastructure', label:'Infrastructure', icon:'infra', route:'/infra', available:false},
  {id:'mod-mlai', label:'ML/AI', icon:'ml', route:'/ml', available:false},
  {id:'mod-alerts', label:'Alerts', icon:'alerts', route:'/alerts', available:false},
  {id:'mod-administration', label:'Administration', icon:'admin', route:'/administration', available:false},
  {id:'mod-settings', label:'Setting', icon:'settings', route:'/settings', available:false},
  {id:'mod-chatbot', label:'ChatBot', icon:'chatbot', route:'/chatbot', available:false},
  {id:'mod-sales', label:'Sales', icon:'sales', route:'/sales', available:false},
  {id:'mod-profile', label:'Profile', icon:'profile', route:'(account menu)', available:false},
];

export const DASH_TOPICS = [
  ['db-overview','Dashboard Overview'],
  ['db-navigation','Dashboard Navigation'],
  ['db-layout','Dashboard Layout'],
  ['db-summary','Global Summary'],
  ['db-health','Health Overview'],
  ['db-monitoring','Monitoring Overview'],
  ['db-database-mon','Database Monitoring'],
  ['db-agent-mon','Agent Monitoring'],
  ['db-infra-mon','Infrastructure Monitoring'],
  ['db-alerts','Alerts'],
  ['db-performance','Performance'],
  ['db-charts','Charts'],
  ['db-filters','Filters'],
  ['db-refresh','Refresh & Real-Time Data'],
  ['db-actions','User Actions'],
  ['db-drilldown','Navigation & Drill-Down'],
  ['db-permissions','Permissions'],
  ['db-states','Error / Empty / Loading States'],
  ['db-troubleshooting','Troubleshooting'],
  ['db-reference','Dashboard Reference'],
];

export const AGENTS_TOPICS = [
  ['agt-overview','Agents Overview'],
  ['agt-navigation','Agents Navigation'],
  ['agt-list-layout','Agents List Layout'],
  ['agt-status','Agent Status & Health'],
  ['agt-architecture','Host vs. Database Agent Architecture'],
  ['agt-host-monitoring','Host Agent Monitoring'],
  ['agt-database-monitoring','Database Agent Monitoring'],
  ['agt-checks','Database Monitoring Checks'],
  ['agt-registration-deploy','Agent Registration & Deployment'],
  ['agt-sync','Sync & Auto-Discovery'],
  ['agt-filters','Filters'],
  ['agt-refresh','Refresh & Real-Time Data'],
  ['agt-actions','User Actions'],
  ['agt-drilldown','Navigation & Drill-Down'],
  ['agt-permissions','Permissions'],
  ['agt-states','Error / Empty / Loading States'],
  ['agt-troubleshooting','Troubleshooting'],
  ['agt-reference','Agents Reference'],
];

export const GS_TOPICS = [
  ['gs-overview','ActMon Overview'],
  ['gs-understanding','Understanding ActMon'],
  ['gs-navigation','Navigation'],
  ['gs-dashboard-teaser','Dashboard Overview'],
  ['gs-terminology','Basic Terminology'],
];

// Topic ids use the `dbm-` prefix (Database Module) rather than `db-`, which
// the Dashboard chapter already owns (db-overview, db-summary, etc.) — the two
// modules share the word "database" but must not collide on topic ids.
export const DATABASE_TOPICS = [
  ['dbm-overview','Database Overview'],
  ['dbm-navigation','Database Navigation'],
  ['dbm-server-list','Server List & Topology'],
  ['dbm-add-server','Adding a Server'],
  ['dbm-connections','Connections & Collectors'],
  ['dbm-mysql','MySQL Dashboard'],
  ['dbm-postgresql','PostgreSQL Dashboard'],
  ['dbm-oracle','Oracle Dashboard'],
  ['dbm-mssql','SQL Server (MSSQL) Dashboard'],
  ['dbm-mongodb','MongoDB Dashboard'],
  ['dbm-clickhouse','ClickHouse Dashboard'],
  ['dbm-cosmosdb','Cosmos DB'],
  ['dbm-slow-queries','Slow Queries & Query Analysis'],
  ['dbm-error-logs','Error Logs & Self-Heal'],
  ['dbm-reports','Reports'],
  ['dbm-drilldown-diagnose','Resource Drill-Down & Diagnose'],
  ['dbm-permissions','Permissions'],
  ['dbm-states','Error / Empty / Loading States'],
  ['dbm-troubleshooting','Troubleshooting'],
  ['dbm-reference','Database Reference'],
];

// Attach each available module's topic list — done here (after every topic
// array above is initialized) rather than inline in MODULES, so adding a new
// module's chapter later is just: fill in its TOPICS array + one line here.
MODULES.find(m=>m.id==='mod-dashboard').topics = DASH_TOPICS;
MODULES.find(m=>m.id==='mod-agents').topics = AGENTS_TOPICS;
MODULES.find(m=>m.id==='mod-databases').topics = DATABASE_TOPICS;

/* ============================================================
   DOCS content — one entry per page. `body` is the article HTML
   (without the <h1>/dek, added by the renderer from `title`/`dek`).
   ============================================================ */
export const DOCS = {};

/* ---------------- GETTING STARTED (blurbs needed by the home page below) ---------------- */
export const GS_BLURBS = {
  'gs-overview':'What ActMon is and who it is for.',
  'gs-understanding':'How the pieces of ActMon fit together.',
  'gs-navigation':'The module bar, breadcrumbs, and how pages connect.',
  'gs-dashboard-teaser':'A short pointer into the full Dashboard chapter.',
  'gs-terminology':'Terms used consistently across this documentation.',
};

/* ---------------- HOME: category tiles + promo banners ----------------
   Information architecture (card grid of categories with sub-links, plus
   promotional-banner sections below) is modeled on docs.oracle.com's
   homepage layout, per the original brief — but every label, link, and
   blurb below points at ActMon's own real pages/topics, never Oracle's
   content or branding. Categories with no written chapter yet show an
   honest "coming in a future phase" state instead of invented sub-links. */
export const ORC_HUES = {
  gs:'#0C7C8C', 'mod-dashboard':'#2F6FED', 'mod-agents':'#7C5CFC',
  'mod-databases':'#059669', 'mod-cloud':'#0EA5E9', 'mod-infrastructure':'#6366F1',
  'mod-mlai':'#D946EF', 'mod-alerts':'#F59E0B', 'mod-administration':'#E11D48',
  'mod-settings':'#64748B', 'mod-chatbot':'#16A34A', 'mod-sales':'#F97316',
  'mod-profile':'#A855F7',
};
const dashLabel = (id) => DASH_TOPICS.find(t => t[0] === id)[1];
const agtLabel = (id) => AGENTS_TOPICS.find(t => t[0] === id)[1];
const dbmLabel = (id) => DATABASE_TOPICS.find(t => t[0] === id)[1];
export const HOME_CATEGORIES = [
  { id:'mod-dashboard', label:'Dashboard', icon:'dashboard', hue:ORC_HUES['mod-dashboard'], available:true, seeAll:'db-reference',
    links: ['db-overview','db-health','db-monitoring','db-alerts','db-troubleshooting'].map(id => ({id, label:dashLabel(id)})) },
  { id:'mod-agents', label:'Agents', icon:'agents', hue:ORC_HUES['mod-agents'], available:true, seeAll:'agt-reference',
    links: ['agt-overview','agt-status','agt-architecture','agt-registration-deploy','agt-troubleshooting'].map(id => ({id, label:agtLabel(id)})) },
  { id:'mod-databases', label:'Database', icon:'db', hue:ORC_HUES['mod-databases'], available:true, seeAll:'dbm-reference',
    links: ['dbm-overview','dbm-server-list','dbm-slow-queries','dbm-permissions','dbm-troubleshooting'].map(id => ({id, label:dbmLabel(id)})) },
  ...MODULES.filter(m => !m.topics).map(m => ({ id:m.id, label:m.label, icon:m.icon, hue:ORC_HUES[m.id], available:false, seeAll:null, links:[] })),
];
export const HOME_BANNERS = [
  { eyebrow:'REFERENCE', title:'Dashboard field reference', hue:ORC_HUES['mod-dashboard'], go:'db-reference',
    desc:'Every panel, chart, and control on the Dashboard module, documented field-by-field.' },
  { eyebrow:'OPERATIONS', title:'Deploying & troubleshooting agents', hue:ORC_HUES['mod-agents'], go:'agt-registration-deploy',
    desc:'How to register, deploy, and diagnose ActMon collection agents on a monitored host.' },
  { eyebrow:'CONCEPTS', title:'Host vs. database agents', hue:ORC_HUES['mod-agents'], go:'agt-architecture',
    desc:'Why one host can have both a host-identity agent row and a per-connection database agent row.' },
  { eyebrow:'REFERENCE', title:'Database module reference', hue:ORC_HUES['mod-databases'], go:'dbm-reference',
    desc:'Every one of the seven engine dashboards, the shared server-list/connection layer, and the real backend routes behind them.' },
  { eyebrow:'ROADMAP', title:'What’s documented next', hue:ORC_HUES.gs, go:'gs-navigation',
    desc:'The order the remaining modules — Cloud, Infrastructure, and more — will be written in.' },
];

/* ---------------- HOME ---------------- */
DOCS['home'] = {
  title:'ActMon Documentation', dek:'Official product documentation for the ActMon monitoring platform.',
  crumbs:['ActMon Documentation'], noMeta:true,
  body:`
    <p>Welcome to the ActMon documentation. ActMon is a monitoring and observability platform that watches
    databases, hosts/infrastructure, cloud accounts, and the ActMon collection agents that report on them,
    and surfaces their status, alerts, and telemetry through a set of product modules.</p>
    <p>This documentation is written directly from the current ActMon implementation — its actual pages, routes,
    API endpoints, and behavior — rather than from a specification. Where a capability described elsewhere as
    planned is not yet present in the running application, this documentation says so explicitly instead of
    describing it as available.</p>

    <div class="note"><b>Documentation coverage</b>${icon('book',14)}<span>
    This library is being built one module at a time. <strong>Dashboard</strong>, <strong>Agents</strong>, and
    <strong>Database</strong> are fully documented below. Every other module is listed for navigation purposes
    and will be completed in the order shown in
    <button onclick="go('gs-navigation')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Navigation</button>.
    </span></div>

    <h2>Getting Started</h2>
    <p>Five short topics that orient you before the full Dashboard, Agents, and Database chapters — what ActMon
    is, how its pieces fit together, how to move around it, and the terms used consistently throughout this
    library.</p>
    <div class="gs-cardgrid">
      ${GS_TOPICS.map(([id,label]) => `
        <button class="gs-card" onclick="go('${id}')">
          <h3>${label}</h3>
          <p>${GS_BLURBS[id]||''}</p>
        </button>`).join('')}
    </div>

    <h2>Browse by category</h2>
    <p>ActMon's own navigation bar lists <strong>11 modules</strong> (Dashboard, Agents, Database, Cloud,
    Infrastructure, ML/AI, Alerts, Administration, Setting, ChatBot, Sales), sourced from
    <code>src/config/navigation.js</code>, plus a separate account-level <strong>Profile</strong> menu. All are
    shown below — each with its real sub-topics where a chapter exists yet, and an honest "coming in a future
    phase" note where it doesn't.</p>
    <div class="orc-grid">
      ${HOME_CATEGORIES.map(cat => cat.available ? `
        <div class="orc-card" style="--hue:${cat.hue}">
          <span class="orc-icon">${icon(cat.icon,19)}</span>
          <h3>${cat.label}</h3>
          <ul>${cat.links.map(l=>`<li><button onclick="go('${l.id}')">${l.label}</button></li>`).join('')}</ul>
          ${cat.seeAll ? `<button class="orc-seeall" onclick="go('${cat.seeAll}')">See all ${cat.label} topics →</button>` : ''}
        </div>` : `
        <div class="orc-card soon" style="--hue:${cat.hue}">
          <span class="orc-icon">${icon(cat.icon,19)}</span>
          <h3>${cat.label}</h3>
          <p class="orc-soon-tag">Documentation coming in a future phase.</p>
        </div>`).join('')}
    </div>

    <div class="orc-cta">
      <div><h3>New to ActMon?</h3><p>Start with a short tour of what ActMon monitors and how its modules fit together.</p></div>
      <button class="primary" onclick="go('gs-overview')">Start with Getting Started →</button>
    </div>

    <h2>Explore the documentation</h2>
    <div class="orc-banner-grid">
      ${HOME_BANNERS.map(b => `
        <button class="orc-banner" style="--hue:${b.hue}" onclick="go('${b.go}')">
          <span class="eyebrow">${b.eyebrow}</span>
          <h4>${b.title}</h4>
          <p>${b.desc}</p>
          <span class="go">Read more →</span>
        </button>`).join('')}
    </div>

    <div class="orc-footer">
      <div class="brandcol">
        <span class="bname">ActMon Documentation</span>
        <small>Written directly from the current ActMon implementation. Where a capability isn't present in the
        running application, this documentation says "Not currently implemented" rather than guessing.</small>
      </div>
      <div class="col">
        <b>Getting Started</b>
        ${GS_TOPICS.map(([id,label])=>`<button onclick="go('${id}')">${label}</button>`).join('')}
      </div>
      <div class="col">
        <b>Dashboard</b>
        <button onclick="go('db-overview')">Overview</button>
        <button onclick="go('db-monitoring')">Monitoring Overview</button>
        <button onclick="go('db-reference')">Reference</button>
      </div>
      <div class="col">
        <b>Agents</b>
        <button onclick="go('agt-overview')">Overview</button>
        <button onclick="go('agt-architecture')">Host vs. Database Agents</button>
        <button onclick="go('agt-reference')">Reference</button>
      </div>
      <div class="col">
        <b>Database</b>
        <button onclick="go('dbm-overview')">Overview</button>
        <button onclick="go('dbm-slow-queries')">Slow Queries & Query Analysis</button>
        <button onclick="go('dbm-reference')">Reference</button>
      </div>
    </div>
  `
};

/* ---------------- GETTING STARTED ---------------- */
DOCS['gs-overview'] = {
  title:'ActMon Overview', dek:'What ActMon is, and what this documentation covers.',
  crumbs:['ActMon Documentation','Getting Started','ActMon Overview'],
  body:`
    <p>ActMon is a monitoring platform for database servers, the hosts they run on, the ActMon collection
    agents installed on those hosts, connected cloud accounts, and the alerts generated from all of the above.
    It is organized into a set of product modules reachable from a single top navigation bar (see
    <button onclick="go('gs-navigation')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Navigation</button>).</p>
    <p>Six database engines are directly supported with their own dedicated dashboards: MySQL, PostgreSQL,
    Oracle, MSSQL, MongoDB, and ClickHouse (confirmed from the application's own routes — see
    <code>/mysql-dashboard/:id</code>, <code>/postgresql-dashboard/:id</code>, <code>/oracle-dashboard/:id</code>,
    <code>/mssql-dashboard/:id</code>, <code>/mongodb-dashboard/:id</code>, <code>/clickhouse-dashboard/:id</code>
    in the application router). Cosmos DB is present as a connection-managed cloud database
    (<code>/cosmosdb-servers</code>, <code>/cosmosdb-dashboard/:id</code>).</p>
    <p>Data reaches ActMon in two ways, depending on how a host is monitored: an installed <strong>ActMon
    agent</strong> collects and pushes metrics from the host itself, or ActMon reaches the host over
    <strong>SSH</strong> and polls it directly. Both paths are referred to in this documentation as
    "collectors."</p>
    <h2>Who this documentation is for</h2>
    <p>This library is written for the people who operate and rely on ActMon day to day: database
    administrators, system and infrastructure administrators, ActMon administrators configuring the platform
    itself, developers integrating with it, support engineers troubleshooting it, and testers verifying its
    behavior.</p>
    <h2>What this phase of the documentation covers</h2>
    <p>This release of the documentation completely covers the <strong>Dashboard</strong> module (the
    monitoring landing page at <code>/dashboard</code>), the <strong>Agents</strong> module, and the
    <strong>Database</strong> module — every one of the seven engine dashboards (MySQL, PostgreSQL, Oracle,
    MSSQL, MongoDB, ClickHouse, Cosmos DB), the server-list/connection layer, and the shared backend patterns
    behind them (collectors, permissions, drill-down). Every other module is present in the navigation tree so
    the overall documentation structure is visible, but its content is marked
    <span class="pill neutral">Coming soon</span> until it is written in a later phase.</p>
  `
};

DOCS['gs-understanding'] = {
  title:'Understanding ActMon', dek:'The mental model behind what the Dashboard (and every module) shows you.',
  crumbs:['ActMon Documentation','Getting Started','Understanding ActMon'],
  body:`
    <p>ActMon's monitoring data has two different "speeds," and knowing which one a given screen uses explains
    a lot of its behavior:</p>
    <ul>
      <li><strong>Polled state</strong> — most list/summary data (host status, agent status, alert rules) is
      read from ActMon's own Postgres database and re-fetched by the browser on a fixed interval (commonly
      15–60 seconds depending on the feed). It is <em>near</em>-real-time, not push-based: a change on a host
      is reflected in the UI on the next poll, not instantly.</li>
      <li><strong>Live telemetry</strong> — for agent-monitored connections, ActMon also keeps a short "hot"
      window of the very latest metric samples (backed by Redis) plus a longer historical record (backed by
      ClickHouse). The Dashboard itself does not use this tier — it works entirely from the polled state
      described above; the live/historical telemetry tier is used by agent- and connection-level detail
      pages instead.</li>
    </ul>
    <p>ActMon is multi-tenant: most data is scoped to an organization (<code>org_id</code>). This documentation
    notes explicitly, where the implementation shows it, whether a given endpoint actually enforces that
    scoping — some of the endpoints the Dashboard depends on do not (see
    <button onclick="go('db-permissions')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Dashboard → Permissions</button>).</p>
    <p>A host can be watched by an installed <strong>ActMon agent</strong> or by <strong>SSH polling</strong> —
    both are always described as "collectors" in this documentation, and most screens (including the Dashboard)
    treat both the same way once data has been collected.</p>
  `
};

DOCS['gs-navigation'] = {
  title:'Navigation', dek:'The module bar, breadcrumbs, and how ActMon screens connect to one another.',
  crumbs:['ActMon Documentation','Getting Started','Navigation'],
  body:`
    <p>ActMon's primary navigation is a horizontal module bar rendered from a single configuration list
    (<code>src/config/navigation.js</code>, which the code comments state mirrors a backend
    <code>module_master</code> table). Every entry below is real and currently present in that list:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Label</th><th>Route</th><th>Notes</th></tr>
      <tr><td>Dashboard</td><td><code>/dashboard</code></td><td>Documented fully in this release.</td></tr>
      <tr><td>Agents</td><td><code>/agents</code></td><td>Monitored Systems / agent fleet list.</td></tr>
      <tr><td>Database</td><td><code>/databases</code></td><td>Documented fully in this release.</td></tr>
      <tr><td>Cloud</td><td><code>/cloud</code></td><td>Listed in navigation; this route has no page implementation currently — visiting it renders the application's generic placeholder view.</td></tr>
      <tr><td>Infrastructure</td><td><code>/infra</code></td><td>Host fleet overview and per-host detail.</td></tr>
      <tr><td>ML/AI</td><td><code>/ml</code></td><td>Present in the module bar.</td></tr>
      <tr><td>Alerts</td><td><code>/alerts</code></td><td>Active alerts and alert rules.</td></tr>
      <tr><td>Administration</td><td><code>/administration</code></td><td>Organizations, roles, permissions, users, audit log, and related admin resources.</td></tr>
      <tr><td>Setting</td><td><code>/settings</code></td><td>Application settings.</td></tr>
      <tr><td>ChatBot</td><td><code>/chatbot</code></td><td>Present in the module bar; carries a distinct "actmon-ai" glyph in the code.</td></tr>
      <tr><td>Sales</td><td><code>/sales</code></td><td>Present in the module bar.</td></tr>
    </table></div>
    <p>A <strong>Profile</strong> menu is also present (top-right of the application chrome) but is an
    account-level menu, not an entry in <code>module_master</code> — it is listed alongside the modules on the
    documentation home page for completeness, but is architecturally separate.</p>
    <h3>Breadcrumbs</h3>
    <p>Most ActMon pages render their title/description through a shared <code>PageHeader</code> component,
    which can optionally show a breadcrumb trail (gated by an application-wide "show breadcrumbs" appearance
    setting). A few pages — the Agents list is one confirmed example — explicitly opt out of breadcrumbs
    because their reference design has none. The Dashboard does not use a <code>backTo</code> link or
    breadcrumb trail of its own; it is a top-level destination.</p>
  `
};

DOCS['gs-dashboard-teaser'] = {
  title:'Dashboard Overview', dek:'A short introduction — see the full Dashboard chapter for complete documentation.',
  crumbs:['ActMon Documentation','Getting Started','Dashboard Overview'],
  body:`
    <p>The Dashboard (<code>/dashboard</code>) is ActMon's monitoring landing page. It shows five headline
    counts (database servers, infrastructure hosts, cloud accounts, agents, active alerts), a set of charts
    breaking those down further, and a live list of firing alerts — all built from data that also powers the
    Agents, Database, Infrastructure, Cloud, and Alerts modules individually.</p>
    <div class="note"><b>Full documentation</b>${icon('book',14)}<span>This page is intentionally brief. See
    <button onclick="go('db-overview')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Dashboard → Dashboard Overview</button>
    for the complete chapter — layout, every card and chart, filters, refresh behavior, permissions, and
    troubleshooting.</span></div>
  `
};

DOCS['gs-terminology'] = {
  title:'Basic Terminology', dek:'Terms used consistently throughout this documentation.',
  crumbs:['ActMon Documentation','Getting Started','Basic Terminology'],
  body:`
    <div class="tblwrap"><table class="doc">
      <tr><th>Term</th><th>Meaning in ActMon</th></tr>
      <tr><td><strong>Host / Server</strong></td><td>A machine ActMon monitors at the OS level — a row in the <code>os_servers</code> table, listed on the Infrastructure module and via <code>GET /os-servers/</code>.</td></tr>
      <tr><td><strong>Collector</strong></td><td>How a host's data reaches ActMon: an installed <strong>ActMon Agent</strong>, or <strong>SSH</strong> polling. Both feed the same host record.</td></tr>
      <tr><td><strong>Agent</strong></td><td>A registered ActMon collection process — a row in the <code>agents</code> table, listed on the Agents module and via <code>GET /agents/</code>. Distinct from a Host: an agent can be a host-level identity or tied to one specific database connection.</td></tr>
      <tr><td><strong>Connection / Database Instance</strong></td><td>One monitored database (a specific engine, host, and port), managed under the Database module and its per-engine dashboards.</td></tr>
      <tr><td><strong>Alert Rule</strong></td><td>A stored, enabled/disabled condition (metric + threshold + scope) that can fire an alert. The application seeds a default set of rules automatically the first time none exist.</td></tr>
      <tr><td><strong>Active Alert</strong></td><td>An alert rule currently firing, or a raw collector notification whose text matches a metric with an enabled rule. Computed fresh on every request — not a stored, ongoing incident record.</td></tr>
      <tr><td><strong>Organization / Tenant (<code>org_id</code>)</strong></td><td>The multi-tenant scope most ActMon data belongs to. Not every endpoint enforces it consistently — see the Permissions topic of each module for specifics.</td></tr>
      <tr><td><strong>Status bands (good / warning / critical)</strong></td><td>The shared coloring scale ActMon uses for host and metric health throughout the application (green/amber/red), independent of a page's own accent color.</td></tr>
    </table></div>
  `
};

/* ============================================================
   DASHBOARD MODULE — full chapter
   ============================================================ */

DOCS['db-overview'] = {
  title:'Dashboard Overview', dek:'What the Dashboard is, who it is for, and how it connects to the rest of ActMon.',
  crumbs:['ActMon Documentation','Dashboard','Dashboard Overview'], module:'Dashboard', status:'Complete',
  body:`
    <h2>What the Dashboard is</h2>
    <p>The Dashboard is ActMon's monitoring landing page, rendered at the route <code>/dashboard</code> by the
    component <code>src/pages/Dashboard.jsx</code>. It is a single-view page — it has no tabs and no
    sub-routes. Its purpose is to answer, at a glance, five questions: how many database servers, infrastructure
    hosts, cloud accounts, and agents ActMon currently knows about, how healthy each group is, and what alerts
    are currently firing.</p>
    <h2>Purpose</h2>
    <p>Every number and chart on the Dashboard is derived — in the browser, not by a dedicated backend
    endpoint — from the same four or five data feeds that also back the Agents, Database (Infrastructure),
    Alerts, and Cloud modules individually. The Dashboard's job is specifically to aggregate and cross-tabulate
    those feeds (counts by status, by engine, by severity) rather than to hold monitoring logic of its own. See
    <button onclick="go('db-reference')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Dashboard Reference</button>
    for the complete API list.</p>
    <h2>Who should use it</h2>
    <ul>
      <li><strong>DBAs and system administrators</strong> — a fleet-wide first look before drilling into a
      specific database server or host.</li>
      <li><strong>ActMon administrators</strong> — a quick check that agents and hosts are reporting in at
      all.</li>
      <li><strong>Support engineers</strong> — a starting point when investigating a reported issue, before
      following a drill-down link into the affected module.</li>
    </ul>
    <h2>What users should understand immediately</h2>
    <ul>
      <li>The Dashboard shows <strong>point-in-time snapshots</strong>, refreshed on a timer — it has no
      historical/trend charts (see <button onclick="go('db-charts')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Charts</button>).</li>
      <li>Every headline number is <strong>clickable</strong> and navigates into the relevant module for detail
      (see <button onclick="go('db-drilldown')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Navigation &amp; Drill-Down</button>).</li>
      <li>The Dashboard itself carries <strong>no fine-grained permission checks</strong> beyond requiring a
      signed-in session — see <button onclick="go('db-permissions')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Permissions</button>.</li>
    </ul>
    <h2>How the Dashboard connects to other modules</h2>
    <p>Every chart and tile on the Dashboard is a summarized view of data that has its own full module
    elsewhere in ActMon:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Dashboard shows</th><th>Full detail lives in</th></tr>
      <tr><td>Database Server tile, Engine Distribution, Servers By Technology</td><td>Database module (per-engine server lists and dashboards)</td></tr>
      <tr><td>Infra Hosts tile, Fleet Health, Top Hosts By CPU, Average Resource Usage, Hosts by Environment</td><td>Infrastructure module</td></tr>
      <tr><td>Agents tile</td><td>Agents module</td></tr>
      <tr><td>Active Alerts tile, Alerts By Severity, Recent Alerts panel</td><td>Alerts module</td></tr>
      <tr><td>Cloud Accounts tile, Cloud by Provider</td><td>Cloud module (route present in navigation; page not yet implemented — see <button onclick="go('db-drilldown')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Navigation &amp; Drill-Down</button>)</td></tr>
    </table></div>
  `
};

DOCS['db-navigation'] = {
  title:'Dashboard Navigation', dek:'How the Dashboard is reached, and what surrounds it in the application chrome.',
  crumbs:['ActMon Documentation','Dashboard','Dashboard Navigation'], module:'Dashboard', status:'Complete',
  body:`
    <h2>Route</h2>
    <p>The Dashboard is registered in the application router (<code>src/App.jsx</code>) as:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Route</th><th>Component</th><th>Access</th></tr>
      <tr><td><code>/dashboard</code></td><td><code>src/pages/Dashboard.jsx</code></td><td>Requires a signed-in session (the route sits inside the authenticated application shell); an unauthenticated visit redirects to the login route.</td></tr>
    </table></div>
    <p>It is the first item in the module bar (see <button onclick="go('gs-navigation')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Getting Started → Navigation</button>) and is reached by clicking
    <strong>Dashboard</strong> in that bar, or by any in-app link/redirect to <code>/dashboard</code>.</p>
    <h2>Header</h2>
    <p>The page header (rendered via the shared <code>PageHeader</code> component) shows the title
    <strong>"Monitoring Overview"</strong> and a single header action — the refresh control described in
    <button onclick="go('db-refresh')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Refresh &amp; Real-Time Data</button>. There is no description/subtitle text under the title.</p>
    <h2>Breadcrumbs</h2>
    <p>The Dashboard does not pass a <code>backTo</code> link — it is a top-level page, not a drill-down
    target, so no "back" affordance is shown above its header.</p>
    <h2>Outbound navigation</h2>
    <p>The Dashboard links out to five destinations via its KPI tiles, plus several more via its charts and the
    Recent Alerts panel — the full list, with exact source and destination, is documented in
    <button onclick="go('db-drilldown')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Navigation &amp; Drill-Down</button>.</p>
  `
};

DOCS['db-layout'] = {
  title:'Dashboard Layout', dek:'The page from top to bottom.',
  crumbs:['ActMon Documentation','Dashboard','Dashboard Layout'], module:'Dashboard', status:'Complete',
  body:`
    <p>Reading top to bottom, the Dashboard is built from these sections:</p>
    <ol>
      <li><strong>Page header</strong> — title "Monitoring Overview" plus the refresh control. Always present.</li>
      <li><strong>Notice banner</strong> — an inline warning/danger banner. <strong>Only rendered</strong> when
      the underlying data requests are failing due to an expired session or an unreachable backend; invisible
      under normal operation. See <button onclick="go('db-states')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Error / Empty / Loading States</button>.</li>
      <li><strong>Headline KPI row</strong> — five tiles in a responsive grid (2 columns on small screens, up to
      5 across on large screens): Database Server, Infra Hosts, Cloud Accounts, Agents, Active Alerts. See
      <button onclick="go('db-summary')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Global Summary</button>.</li>
      <li><strong>Charts region</strong> — a two-column layout: a wider left column (three stacked rows of
      charts) beside a narrower right column running the full height of all three rows.
        <ul>
          <li>Chart row A: Fleet Health, Engine Distribution, and a third card that is either "Cloud by
          Provider" or "Hosts by Environment" depending on whether any cloud accounts exist.</li>
          <li>Chart row B: Alerts By Severity, Servers By Technology.</li>
          <li>Chart row C: Top Hosts By CPU, Average Resource Usage.</li>
          <li>Right column: the Recent Alerts panel, spanning all three rows' height.</li>
        </ul>
      </li>
    </ol>
    <div class="tblwrap"><table class="doc">
      <tr><th>Section</th><th>UI element</th><th>Data source</th><th>Refresh</th></tr>
      <tr><td>Headline KPI row</td><td>5 × <code>StatTile</code></td><td>All 5 dashboard feeds (see Reference)</td><td>Per-feed interval, 15–60s</td></tr>
      <tr><td>Fleet Health</td><td>Donut chart (<code>ChartCard</code>)</td><td>Infra host status tally</td><td>With host feeds</td></tr>
      <tr><td>Engine Distribution</td><td>Donut chart</td><td>Host list, grouped by database engine</td><td>With host feed (60s)</td></tr>
      <tr><td>Cloud by Provider / Hosts by Environment</td><td>Donut chart (title switches)</td><td>Cloud accounts, or host <code>environment</code> field</td><td>60s (cloud) / with host feed</td></tr>
      <tr><td>Alerts By Severity</td><td>Column chart</td><td>Active alerts, grouped by severity</td><td>15s</td></tr>
      <tr><td>Servers By Technology</td><td>Stacked column chart</td><td>Host list, grouped by engine × status</td><td>With host feed (60s)</td></tr>
      <tr><td>Top Hosts By CPU</td><td>Horizontal bar chart</td><td>Host list, sorted by CPU%, top 5</td><td>With host feed (60s)</td></tr>
      <tr><td>Average Resource Usage</td><td>Radial gauges (CPU/RAM/Disk)</td><td>Host list, averaged</td><td>With host feed (60s)</td></tr>
      <tr><td>Recent Alerts panel</td><td>Filterable list</td><td>Active alerts</td><td>15s</td></tr>
    </table></div>
    <p>Every chart card additionally offers a per-card <strong>chart-type picker</strong> and a
    <strong>data-table</strong> toggle (both described in <button onclick="go('db-charts')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Charts</button>) — these change how that
    one card is displayed, not what data it holds.</p>
  `
};

DOCS['db-summary'] = {
  title:'Global Summary', dek:'The five headline KPI tiles at the top of the Dashboard.',
  crumbs:['ActMon Documentation','Dashboard','Global Summary'], module:'Dashboard', status:'Complete',
  body:`
    <p>The headline row is five <code>StatTile</code> components. Every tile is clickable (rendered as a
    button) and navigates on click; every tile dims while the very first load is in progress.</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Tile</th><th>Value</th><th>Sub-text</th><th>Color logic</th><th>Click →</th></tr>
      <tr><td>Database Server</td><td>Total host count running any database service</td><td>Online count (good) + Offline count (critical)</td><td>Fixed neutral — not threshold-colored</td><td><code>/databases</code></td></tr>
      <tr><td>Infra Hosts</td><td>Total infrastructure host count</td><td>Health % (share online)</td><td>Neutral if zero hosts; else good ≥90%, warning ≥60%, else critical</td><td><code>/infra</code></td></tr>
      <tr><td>Cloud Accounts</td><td>Total connected cloud accounts</td><td>Provider names, or "None connected"</td><td><strong>Critical/red whenever one or more accounts are connected</strong>, neutral otherwise (see note below)</td><td><code>/cloud</code> (not yet implemented)</td></tr>
      <tr><td>Agents</td><td>Total registered agents</td><td>Online count (good)</td><td>Neutral if zero; else warning if any agent is in a critical state, else good</td><td><code>/agents</code></td></tr>
      <tr><td>Active Alerts</td><td>Total firing alerts</td><td>Critical count + Warning count</td><td>Critical if any critical alert fires, else warning if any warning fires, else good</td><td><code>/alerts</code></td></tr>
    </table></div>
    <div class="warnbox"><b>Implementation note</b>${icon('alerts',14)}<span>The Cloud Accounts tile's color logic,
    as implemented, marks the tile <em>critical</em> whenever any cloud account is connected — it does not
    currently express a utilization or health threshold the way the other tiles do. This documentation
    describes the code's actual behavior rather than what the color might be assumed to mean.</span></div>
    <p>Values are formatted by a shared helper: single-digit counts are zero-padded ("6" → "06"); larger counts
    abbreviate at 10,000 (K) and 1,000,000 (M). No tile displays a unit suffix — every value is a raw count.</p>
  `
};

DOCS['db-health'] = {
  title:'Health Overview', dek:'How the Dashboard represents overall fleet health.',
  crumbs:['ActMon Documentation','Dashboard','Health Overview'], module:'Dashboard', status:'Complete',
  body:`
    <p>Two elements together form the Dashboard's health picture:</p>
    <h3>Infra Hosts tile</h3>
    <p>Shows total host count with a health percentage sub-text (share of hosts currently online), colored
    good/warning/critical at the 90%/60% thresholds described in
    <button onclick="go('db-summary')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Global Summary</button>.</p>
    <h3>Fleet Health chart</h3>
    <p>A donut chart (<code>cardId="fleet-health"</code>) breaking every known host into Online / Warning /
    Offline, colored with the same good/warning/critical scale used everywhere in ActMon, with the total host
    count printed in the donut's center. Its segments are not clickable. When there are no hosts registered, it
    shows the text <strong>"No hosts registered yet"</strong> instead of an empty ring.</p>
    <p>Both the tile and the chart are computed from the same host status tally, so they always agree; the
    authoritative counts come from a dedicated summary endpoint (see
    <button onclick="go('db-reference')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Dashboard Reference</button>), with the full host list used only for the
    breakdowns a single summary count can't express (by engine, by CPU, by environment).</p>
  `
};

DOCS['db-monitoring'] = {
  title:'Monitoring Overview', dek:'How the Dashboard’s three monitoring areas — database, agent, and infrastructure — relate.',
  crumbs:['ActMon Documentation','Dashboard','Monitoring Overview'], module:'Dashboard', status:'Complete',
  body:`
    <p>The Dashboard's monitoring content splits into three areas, each summarizing one ActMon module:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Area</th><th>Dashboard elements</th><th>Chapter</th></tr>
      <tr><td>Database</td><td>Database Server tile, Engine Distribution chart, Servers By Technology chart</td><td><button onclick="go('db-database-mon')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Database Monitoring</button></td></tr>
      <tr><td>Agent</td><td>Agents tile</td><td><button onclick="go('db-agent-mon')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Agent Monitoring</button></td></tr>
      <tr><td>Infrastructure</td><td>Infra Hosts tile, Fleet Health, Top Hosts By CPU, Average Resource Usage, Hosts by Environment</td><td><button onclick="go('db-infra-mon')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Infrastructure Monitoring</button></td></tr>
    </div></table></div>
    <p>All three areas are derived from the same two underlying feeds — the host list
    (<code>GET /os-servers/</code>) and the host summary (<code>GET /os-servers/summary</code>) — filtered and
    grouped differently in the browser for each area, plus the separate Agents feed for the agent area. None of
    the three areas involves a Dashboard-specific backend computation; see
    <button onclick="go('db-reference')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Dashboard Reference</button> for the shared endpoints.</p>
  `
};

DOCS['db-database-mon'] = {
  title:'Database Monitoring', dek:'What the Dashboard shows about monitored database servers.',
  crumbs:['ActMon Documentation','Dashboard','Database Monitoring'], module:'Dashboard', status:'Complete',
  body:`
    <div class="tblwrap"><table class="doc">
      <tr><th>Element</th><th>Shows</th><th>Click behavior</th></tr>
      <tr><td>Database Server tile</td><td>Total hosts running any database service, split Online/Offline</td><td>Navigates to <code>/databases</code></td></tr>
      <tr><td>Engine Distribution (donut)</td><td>Host count per database engine (MySQL, PostgreSQL, Oracle, MSSQL, MongoDB, ClickHouse). Engines with zero hosts are excluded from the chart.</td><td>Clicking a slice or legend row navigates to that engine's own server-list route, e.g. <code>/mysql-servers</code>, <code>/postgresql-servers</code></td></tr>
      <tr><td>Servers By Technology (stacked column)</td><td>Same per-engine breakdown as Engine Distribution, but split further into Online / Warning / Offline segments per engine</td><td>Clicking a column navigates to that engine's server-list route</td></tr>
    </table></div>
    <p>"Database" here means any host whose <code>database_services</code> list names a recognized engine — a
    single physical host running two database engines counts toward both engines' totals.</p>
    <div class="note"><b>Full detail</b>${icon('db',14)}<span>Per-database detail — connections, slow queries, error
    logs, replication, and more — lives on each engine's own dashboard (e.g. <code>/mysql-dashboard/:id</code>),
    reached from the Database module. See
    <button onclick="go('dbm-overview')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Database → Database Overview</button> for the complete chapter.</span></div>
  `
};

DOCS['db-agent-mon'] = {
  title:'Agent Monitoring', dek:'What the Dashboard shows about ActMon collection agents.',
  crumbs:['ActMon Documentation','Dashboard','Agent Monitoring'], module:'Dashboard', status:'Complete',
  body:`
    <div class="tblwrap"><table class="doc">
      <tr><th>Element</th><th>Shows</th><th>Color logic</th><th>Click behavior</th></tr>
      <tr><td>Agents tile</td><td>Total registered agent count, with an Online sub-count</td><td>Neutral if zero agents; warning if any agent is in a critical state; otherwise good</td><td>Navigates to <code>/agents</code></td></tr>
    </table></div>
    <p>This is the Dashboard's <strong>only</strong> agent-specific element — there is no dedicated agent chart
    on the Dashboard (no per-agent breakdown, no heartbeat chart, no agent-failure list). Per-agent heartbeat
    age, host CPU/memory, active sessions, and failure history are read on the Agents module and each agent's
    own detail page, not summarized here.</p>
    <div class="note"><b>Full detail</b>${icon('agents',14)}<span>Per-agent status, heartbeat, and telemetry live on
    the Agents module. See
    <button onclick="go('agt-overview')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Agents → Agents Overview</button> for the complete chapter.</span></div>
  `
};

DOCS['db-infra-mon'] = {
  title:'Infrastructure Monitoring', dek:'What the Dashboard shows about monitored hosts.',
  crumbs:['ActMon Documentation','Dashboard','Infrastructure Monitoring'], module:'Dashboard', status:'Complete',
  body:`
    <div class="tblwrap"><table class="doc">
      <tr><th>Element</th><th>Shows</th><th>Click behavior</th></tr>
      <tr><td>Infra Hosts tile</td><td>Total host count + health %</td><td>Navigates to <code>/infra</code></td></tr>
      <tr><td>Fleet Health (donut)</td><td>Online / Warning / Offline host counts</td><td>Not clickable</td></tr>
      <tr><td>Cloud by Provider / Hosts by Environment (donut)</td><td>Host count by <code>environment</code> field (Production/Staging/etc, defaulting to "Unspecified") — shown only when there are no cloud accounts, otherwise this card shows cloud provider distribution instead</td><td>Not clickable</td></tr>
      <tr><td>Top Hosts By CPU (bar list, top 5)</td><td>The 5 hosts with the highest current CPU%, each bar colored by utilization band (Normal / Elevated / High / Critical)</td><td>Not clickable</td></tr>
      <tr><td>Average Resource Usage (gauges)</td><td>Fleet-wide average CPU / Memory / Disk usage, each as a percentage ring, hosts reporting 0% excluded from the average</td><td>Not clickable</td></tr>
    </table></div>
    <p>All figures here are <strong>point-in-time</strong> — the last CPU/RAM/disk percentage each host reported
    (a plain string column on the host row), not a time-series query. See
    <button onclick="go('db-performance')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Performance</button> for what that means in practice.</p>
    <div class="note"><b>Full detail</b>${icon('infra',14)}<span>Per-host filesystems, processes, network
    interfaces, and service state live on the Infrastructure module and each host's own detail page.
    <span class="pill neutral">Documentation coming in a future module.</span></span></div>
  `
};

DOCS['db-alerts'] = {
  title:'Alerts', dek:'How the Dashboard surfaces firing alerts.',
  crumbs:['ActMon Documentation','Dashboard','Alerts'], module:'Dashboard', status:'Complete',
  body:`
    <h2>Where alerts appear on the Dashboard</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Element</th><th>Shows</th></tr>
      <tr><td>Active Alerts tile</td><td>Total firing count, with Critical and Warning sub-counts</td></tr>
      <tr><td>Alerts By Severity (column chart)</td><td>Critical / Warning / Info counts as columns; shows <strong>"Nothing firing"</strong> when there are none</td></tr>
      <tr><td>Recent Alerts panel</td><td>The full active-alert list, most recent first, with its own severity filter</td></tr>
    </table></div>
    <h2>What "active alert" means</h2>
    <p>Active alerts are <strong>computed on every request</strong>, not read from a stored, ongoing-incident
    table. On each call, ActMon evaluates every enabled alert rule against every host's latest reported
    metrics right then (CPU/memory/disk thresholds, host-down, service-down), and separately scans recent
    unread agent notifications for messages that match a metric with an enabled rule. Both sets are merged and
    sorted by creation time. A consequence of this design: <strong>disabling a rule makes its alerts disappear
    immediately</strong>, and there is no threshold-duration ("must persist for N minutes") check on this
    read path.</p>
    <h2>Recent Alerts panel</h2>
    <p>Shown in the right-hand column beside the chart rows, this panel:</p>
    <ul>
      <li>Has its own severity filter tabs — <strong>All</strong> (default), <strong>Critical</strong>,
      <strong>Warning</strong>, and <strong>Info</strong> (the Info tab only appears when at least one info-level
      alert exists). Filtering happens entirely client-side against the already-fetched alert list — it does
      not trigger a new request, and it does not affect the KPI tile or the Alerts By Severity chart.</li>
      <li>Shows an <strong>"All clear"</strong> empty state (with a check icon) when nothing is firing at all,
      or <strong>"None at this severity"</strong> when a filter is active but nothing matches it.</li>
      <li>Caps its visible rows at 40; if more alerts exist than that, a "<em>N more not shown — open
      alerts</em>" link appears, navigating to <code>/alerts</code>.</li>
      <li>Has its own header button ("More Alerts") that also navigates to <code>/alerts</code>.</li>
    </ul>
    <h2>Selecting an alert</h2>
    <p>Individual alert rows in the Recent Alerts panel and individual bars in the Alerts By Severity chart do
    not carry their own click-through in the current implementation — the panel's "More Alerts" header button
    and its "N more" overflow link are the confirmed ways to reach the full Alerts module from the Dashboard.
    The Alerts By Severity card does have one explicit action button ("Open alerts") that navigates to
    <code>/alerts</code>, separate from the bars themselves.</p>
  `
};

DOCS['db-performance'] = {
  title:'Performance', dek:'The Dashboard’s resource-utilization view: Top Hosts By CPU and Average Resource Usage.',
  crumbs:['ActMon Documentation','Dashboard','Performance'], module:'Dashboard', status:'Complete',
  body:`
    <p>Two cards give a fleet-wide performance snapshot. Both read the same last-known
    CPU/RAM/disk percentages already described in
    <button onclick="go('db-infra-mon')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Infrastructure Monitoring</button> — this topic focuses on what the bands and
    numbers mean when deciding whether something needs attention.</p>
    <h2>Top Hosts By CPU</h2>
    <p>The five hosts (only hosts currently reporting CPU &gt; 0%) with the highest CPU usage, sorted
    descending. Each bar's color reflects a fixed utilization band, not a per-host custom threshold:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Band</th><th>Range</th></tr>
      <tr><td><span class="pill good">Normal</span></td><td>below 60%</td></tr>
      <tr><td><span class="pill warn">Elevated</span></td><td>60% – 74%</td></tr>
      <tr><td><span class="pill warn">High</span></td><td>75% – 89%</td></tr>
      <tr><td><span class="pill crit">Critical</span></td><td>90% and above</td></tr>
    </table></div>
    <h2>Average Resource Usage</h2>
    <p>Three gauges — CPU, Memory, Disk — each the mean of that metric across every host currently reporting a
    non-zero value for it. The rings themselves are colored by a fixed hue per resource (not by the
    good/warning/critical band) so three rings side by side stay visually distinct; the percentage number
    printed beneath each ring is what carries the severity signal, using the same bands as above (also shown
    in this card's table view).</p>
    <p>Neither card is interactive — see <button onclick="go('db-charts')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Charts</button> for the full technical
    reference of both.</p>
  `
};

DOCS['db-charts'] = {
  title:'Charts', dek:'Complete technical reference for every chart on the Dashboard.',
  crumbs:['ActMon Documentation','Dashboard','Charts'], module:'Dashboard', status:'Complete',
  body:`
    <p>Every chart on the Dashboard is rendered by the same shared <code>ChartCard</code> container, which
    contributes two things identically to all seven charts described below:</p>
    <ul>
      <li>A <strong>chart-type picker</strong> (the header's <code>⋮</code> button) — lets the user switch that
      one card between the display forms valid for its data (e.g. a donut card can also be shown as a bar or
      column). The choice is remembered per card in the browser's local storage and survives navigation and
      reload.</li>
      <li>A <strong>data table</strong> toggle, in the same menu — swaps the chart for a plain table of the same
      figures. Available on every chart on this page.</li>
    </ul>
    <p>None of the seven charts is a time-series/trend chart — the Dashboard has no time-range picker and no
    historical line/area charts; every chart is a snapshot of the current state.</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Chart</th><th>Default form</th><th>Data</th><th>Unit</th><th>Clickable</th><th>Empty state</th></tr>
      <tr><td>Fleet Health</td><td>Donut</td><td>Hosts by status (Online/Warning/Offline)</td><td>Count</td><td>No</td><td>"No hosts registered yet"</td></tr>
      <tr><td>Engine Distribution</td><td>Donut</td><td>Hosts by database engine (zero-host engines excluded)</td><td>Count</td><td><strong>Yes</strong> — per-engine server list</td><td>"No database hosts discovered yet"</td></tr>
      <tr><td>Cloud by Provider / Hosts by Environment</td><td>Donut</td><td>Cloud accounts by provider, or hosts by <code>environment</code></td><td>Count</td><td>No</td><td>"No accounts" / "No hosts registered yet"</td></tr>
      <tr><td>Alerts By Severity</td><td>Column</td><td>Active alerts by severity — only populated if at least one alert is firing</td><td>Count</td><td>No (header has a separate "Open alerts" action)</td><td>"Nothing firing"</td></tr>
      <tr><td>Servers By Technology</td><td>Stacked column</td><td>Hosts by engine × status (Online/Warning/Offline)</td><td>Count</td><td><strong>Yes</strong> — per-engine server list</td><td>"No database hosts discovered yet"</td></tr>
      <tr><td>Top Hosts By CPU</td><td>Horizontal bar</td><td>Top 5 hosts by CPU%, banded coloring</td><td>%</td><td>No</td><td>"No host is reporting CPU yet"</td></tr>
      <tr><td>Average Resource Usage</td><td>Radial gauge ×3</td><td>Fleet average CPU/RAM/Disk</td><td>%</td><td>No</td><td>—</td></tr>
    </table></div>
    <h2>Loading behavior (all charts)</h2>
    <p>While a background refresh is in flight, a chart's content area dims to reduced opacity rather than
    being replaced by a skeleton loader — the previous render stays visible underneath. On the very first page
    load (before any data has arrived), tiles/charts render with default/zero values dimmed the same way.</p>
  `
};

DOCS['db-filters'] = {
  title:'Filters', dek:'What can and cannot be filtered on the Dashboard.',
  crumbs:['ActMon Documentation','Dashboard','Filters'], module:'Dashboard', status:'Complete',
  body:`
    <div class="warnbox"><b>No global filters</b>${icon('alerts',14)}<span>The Dashboard has <strong>no dropdowns,
    search box, or time-range picker</strong> anywhere on the page. This is a deliberate gap to document
    honestly rather than describe filtering that does not exist.</span></div>
    <p>Two real, narrower controls do exist, and only affect their own card:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Control</th><th>Location</th><th>Options</th><th>Default</th><th>Affects</th><th>Persists?</th></tr>
      <tr><td>Severity filter tabs</td><td>Recent Alerts panel</td><td>All, Critical, Warning, Info (Info only shown if any info-level alert exists)</td><td>All</td><td>Only the alert rows shown in that panel — not the KPI tile or Alerts By Severity chart</td><td>No — resets on reload (client-side component state only)</td></tr>
      <tr><td>Chart-type picker</td><td>Every chart card's <code>⋮</code> menu</td><td>Every display form valid for that card's data family (e.g. donut/bar/column)</td><td>Each card's own designed default (see <button onclick="go('db-charts')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Charts</button>)</td><td>Only that one card's presentation — never the underlying data</td><td><strong>Yes</strong> — saved to local storage, per card, survives reload/navigation</td></tr>
    </table></div>
    <p>A global chart-style preference (recommended / bar / column / donut / pie) also exists in the
    application's Settings/Appearance area and is read by every <code>ChartCard</code> on the Dashboard as the
    fallback when a card has no per-card override — but it is not itself a Dashboard control.</p>
  `
};

DOCS['db-refresh'] = {
  title:'Refresh & Real-Time Data', dek:'Polling intervals, the manual refresh control, and what "real-time" means here.',
  crumbs:['ActMon Documentation','Dashboard','Refresh & Real-Time Data'], module:'Dashboard', status:'Complete',
  body:`
    <h2>Automatic refresh</h2>
    <p>Each of the Dashboard's five underlying data feeds polls on its own independent interval — they are not
    all refreshed together:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Feed</th><th>Interval</th><th>Feeds</th></tr>
      <tr><td>Active alerts</td><td class="num">15s</td><td>Active Alerts tile, Alerts By Severity, Recent Alerts panel</td></tr>
      <tr><td>Agents</td><td class="num">30s</td><td>Agents tile</td></tr>
      <tr><td>Host summary</td><td class="num">30s</td><td>Infra Hosts tile, Fleet Health</td></tr>
      <tr><td>Host list</td><td class="num">60s</td><td>Engine Distribution, Servers By Technology, Top Hosts By CPU, Average Resource Usage, Hosts by Environment</td></tr>
      <tr><td>Cloud accounts</td><td class="num">60s</td><td>Cloud Accounts tile, Cloud by Provider</td></tr>
    </table></div>
    <p>None of these requests retry automatically on failure — a failed request surfaces its empty/error state
    immediately rather than silently retrying in the background (see
    <button onclick="go('db-states')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Error / Empty / Loading States</button>).</p>
    <h2>Manual refresh</h2>
    <p>The page header's single action is a refresh button. Its tooltip/label reads
    <strong>"Refresh now (auto in N s)"</strong>, where N counts down from 30 every second, purely as an
    on-screen indicator. Clicking it immediately re-fetches all five feeds at once and resets that
    countdown to 30. While any feed is being fetched, the button's icon spins.</p>
    <div class="note"><b>What the countdown is (and isn't)</b>${icon('book',14)}<span>The visible 30-second
    countdown is a UI-only display — it does not itself control how often data refreshes. The real cadence is
    the five independent intervals listed above (15s–60s), which keep running regardless of what the countdown
    displays.</span></div>
    <h2>No "last updated" timestamp</h2>
    <p>The Dashboard does not display a separate "last updated at HH:MM" timestamp anywhere — the refresh
    button's countdown label is the only refresh-related text on the page.</p>
    <h2>Historical data</h2>
    <p>The Dashboard shows no historical/trend data at all — every number and chart is the current snapshot
    from the feeds above. Historical/time-series telemetry does exist in ActMon (a Redis-backed live tier plus
    a ClickHouse-backed history tier), but it is used by agent and connection detail pages, not by the
    Dashboard.</p>
  `
};

DOCS['db-actions'] = {
  title:'User Actions', dek:'Every action available to a user on the Dashboard.',
  crumbs:['ActMon Documentation','Dashboard','User Actions'], module:'Dashboard', status:'Complete',
  body:`
    <div class="tblwrap"><table class="doc">
      <tr><th>Action</th><th>Where</th><th>Result</th></tr>
      <tr><td>Refresh now</td><td>Header icon button</td><td>Re-fetches all five feeds immediately; resets the visible countdown to 30s</td></tr>
      <tr><td>Click a KPI tile</td><td>Any of the 5 headline tiles</td><td>Navigates to that tile's module (see <button onclick="go('db-drilldown')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Navigation &amp; Drill-Down</button>)</td></tr>
      <tr><td>Click an Engine Distribution slice/legend row</td><td>Engine Distribution chart</td><td>Navigates to that engine's server list</td></tr>
      <tr><td>Click a Servers By Technology column</td><td>Servers By Technology chart</td><td>Navigates to that engine's server list</td></tr>
      <tr><td>Click "Open alerts"</td><td>Alerts By Severity card header</td><td>Navigates to <code>/alerts</code></td></tr>
      <tr><td>Click "More Alerts"</td><td>Recent Alerts panel header</td><td>Navigates to <code>/alerts</code></td></tr>
      <tr><td>Click "N more not shown"</td><td>Recent Alerts panel (only when &gt;40 alerts are active)</td><td>Navigates to <code>/alerts</code></td></tr>
      <tr><td>Change the severity filter</td><td>Recent Alerts panel tabs</td><td>Filters the panel's own list only, client-side, no request</td></tr>
      <tr><td>Open a chart's ⋮ menu</td><td>Any chart card header</td><td>Shows the chart-type options and the "Data table" toggle for that card</td></tr>
      <tr><td>Switch a chart's type</td><td>Chart ⋮ menu</td><td>Re-renders that card in the chosen form; choice is remembered per card</td></tr>
      <tr><td>Toggle a chart to table view</td><td>Chart ⋮ menu</td><td>Replaces that card's chart with a plain table of the same figures</td></tr>
      <tr><td>Reset a chart to its default</td><td>Chart ⋮ menu (only shown once overridden)</td><td>Clears the saved per-card override</td></tr>
    </table></div>
    <p>Fleet Health, Cloud by Provider / Hosts by Environment, Top Hosts By CPU, and Average Resource Usage
    have <strong>no</strong> click-to-navigate behavior on their data (their chart-type/table controls still
    apply) — this is confirmed from the implementation, not an omission in this documentation.</p>
  `
};

DOCS['db-drilldown'] = {
  title:'Navigation & Drill-Down', dek:'Every place the Dashboard sends you, and why.',
  crumbs:['ActMon Documentation','Dashboard','Navigation & Drill-Down'], module:'Dashboard', status:'Complete',
  body:`
    <div class="tblwrap"><table class="doc navmatrix">
      <tr><th>Dashboard item</th><th>Action</th><th>Destination</th><th>Purpose</th></tr>
      <tr><td>Database Server tile</td><td>Click</td><td><code>/databases</code></td><td>See every monitored database host</td></tr>
      <tr><td>Infra Hosts tile</td><td>Click</td><td><code>/infra</code></td><td>See every monitored host</td></tr>
      <tr><td>Cloud Accounts tile</td><td>Click</td><td><code>/cloud</code></td><td>Intended to open Cloud module — <strong>route not yet implemented</strong>, currently renders the application's generic placeholder</td></tr>
      <tr><td>Agents tile</td><td>Click</td><td><code>/agents</code></td><td>See every registered agent</td></tr>
      <tr><td>Active Alerts tile</td><td>Click</td><td><code>/alerts</code></td><td>See every active alert</td></tr>
      <tr><td>Engine Distribution slice/legend</td><td>Click</td><td><code>/mysql-servers</code>, <code>/postgresql-servers</code>, <code>/oracle-servers</code>, <code>/mssql-servers</code>, <code>/mongodb-servers</code>, or <code>/clickhouse-servers</code></td><td>See that engine's server list</td></tr>
      <tr><td>Servers By Technology column</td><td>Click</td><td>Same per-engine routes as above</td><td>Same as above</td></tr>
      <tr><td>Alerts By Severity "Open alerts"</td><td>Click</td><td><code>/alerts</code></td><td>See every active alert</td></tr>
      <tr><td>Recent Alerts panel "More Alerts"</td><td>Click</td><td><code>/alerts</code></td><td>See every active alert</td></tr>
      <tr><td>Recent Alerts panel overflow link</td><td>Click</td><td><code>/alerts</code></td><td>See alerts beyond the panel's 40-row cap</td></tr>
    </table></div>
    <div class="warnbox"><b>Known gap</b>${icon('alerts',14)}<span>The Cloud Accounts tile navigates to
    <code>/cloud</code>, which is listed in the application's own navigation configuration but currently has no
    dedicated page component registered in the router — visiting it renders the application's generic
    placeholder view rather than a Cloud module page.</span></div>
  `
};

DOCS['db-permissions'] = {
  title:'Permissions', dek:'What access is required to view the Dashboard and its data.',
  crumbs:['ActMon Documentation','Dashboard','Permissions'], module:'Dashboard', status:'Complete',
  body:`
    <div class="imp"><b>Not currently implemented</b>${icon('alerts',14)}<span>No fine-grained permission or role
    check gates any section, tile, or chart of the Dashboard. This was verified directly against the page
    component and its data hook — neither references the application's permission-checking mechanism
    (<code>usePermissions</code>), which is confirmed to exist and to be used elsewhere in the application
    (e.g. Infrastructure, Database, Diagnosis, and Administration pages), just not on this page.</span></div>
    <h2>What access <em>is</em> required</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>To</th><th>Requires</th></tr>
      <tr><td>View the Dashboard at all</td><td>A signed-in session (a valid bearer token) — the route redirects to login otherwise. No specific role is checked beyond being authenticated.</td></tr>
      <tr><td>View database/infrastructure figures</td><td>Same as above — no additional gating; the host-list and host-summary endpoints are scoped to the caller's own organization automatically (see note below)</td></tr>
      <tr><td>View agent figures</td><td>Same as above — <strong>and this endpoint is not organization-scoped</strong>, see note below</td></tr>
      <tr><td>View alerts</td><td>Same as above — <strong>also not organization-scoped</strong></td></tr>
      <tr><td>Perform any Dashboard action</td><td>Every action on this page (refresh, navigate, change a chart's display form) requires no permission beyond viewing the page</td></tr>
    </table></div>
    <div class="warnbox"><b>Tenant-scoping inconsistency</b>${icon('alerts',14)}<span>The host list and host summary
    endpoints filter by the caller's organization. The agents endpoint and the active-alerts endpoint that the
    Dashboard also depends on currently do <strong>not</strong> apply that same organization filter — they
    return data across every organization. This is a real, verified characteristic of the current
    implementation, not a Dashboard-specific design choice, and is worth being aware of in a multi-tenant
    deployment.</span></div>
  `
};

DOCS['db-states'] = {
  title:'Error / Empty / Loading States', dek:'What the Dashboard looks like when data is missing, loading, or failing.',
  crumbs:['ActMon Documentation','Dashboard','Error / Empty / Loading States'], module:'Dashboard', status:'Complete',
  body:`
    <h2>Loading</h2>
    <ul>
      <li><strong>Initial load</strong> — KPI tiles render at reduced opacity with default/zero values; no
      skeleton placeholders are used anywhere on this page.</li>
      <li><strong>Background refresh</strong> — charts and the Recent Alerts panel dim to reduced opacity while
      keeping their last-rendered content, rather than being replaced by a loading indicator.</li>
    </ul>
    <h2>Empty states</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Where</th><th>Exact text</th><th>When shown</th></tr>
      <tr><td>Fleet Health</td><td>"No hosts registered yet"</td><td>Zero hosts known</td></tr>
      <tr><td>Engine Distribution</td><td>"No database hosts discovered yet"</td><td>No host runs a recognized database engine</td></tr>
      <tr><td>Cloud by Provider / Hosts by Environment</td><td>"No accounts" / "No hosts registered yet"</td><td>Depending on which mode the card is in</td></tr>
      <tr><td>Alerts By Severity</td><td>"Nothing firing"</td><td>Zero active alerts</td></tr>
      <tr><td>Servers By Technology</td><td>"No database hosts discovered yet"</td><td>Same condition as Engine Distribution</td></tr>
      <tr><td>Top Hosts By CPU</td><td>"No host is reporting CPU yet"</td><td>No host currently reports CPU &gt; 0%</td></tr>
      <tr><td>Recent Alerts panel</td><td>"All clear" / "No alerts are firing."</td><td>Zero active alerts</td></tr>
      <tr><td>Recent Alerts panel (filtered)</td><td>"None at this severity" / "Other alerts are still firing."</td><td>A severity filter is active but matches nothing</td></tr>
    </table></div>
    <h2>Errors</h2>
    <p>A page-level banner appears above the KPI row only when one of the underlying feeds actually fails, in
    one of two forms:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Condition</th><th>Title</th><th>Body</th></tr>
      <tr><td>A request was rejected as unauthorized (401/403)</td><td>"Not signed in"</td><td>"The API rejected these requests. Sign in to load live monitoring data."</td></tr>
      <tr><td>A request failed at the network level (backend unreachable)</td><td>"Backend unreachable"</td><td>"Could not reach the API. Start the backend, then refresh."</td></tr>
    </table></div>
    <p>A separate, application-wide mechanism also force-redirects to the login screen on an out-of-band 401
    seen outside this page's own request handling — in practice a fully expired session is more likely to be
    caught by that redirect before the in-page "Not signed in" banner is ever seen; the banner is the fallback
    path for cases the redirect doesn't catch.</p>
    <div class="note"><b>The Cloud feed fails quietly</b>${icon('cloud',14)}<span>If the cloud accounts feed
    specifically is unreachable, the Cloud Accounts tile simply reads 0 — it does not trigger the page-level
    error banner. Only the host and agent feeds are treated as core to the page.</span></div>
  `
};

DOCS['db-troubleshooting'] = {
  title:'Troubleshooting', dek:'Practical answers grounded in the actual Dashboard implementation.',
  crumbs:['ActMon Documentation','Dashboard','Troubleshooting'], module:'Dashboard', status:'Complete',
  body:`
    <h3>Dashboard does not load / shows "Backend unreachable"</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — the page shows a red "Backend unreachable" banner instead of data.</li>
      <li><strong>Possible cause</strong> — the API backend is not running or is unreachable from the browser at a network level (not an authentication problem).</li>
      <li><strong>Verification</strong> — check whether the backend process is running and reachable at its configured API base URL.</li>
      <li><strong>Resolution</strong> — start/restore the backend, then click the header's refresh button (or reload the page).</li>
    </ul>
    <h3>Dashboard shows "Not signed in"</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — an amber "Not signed in" banner appears; tiles may show stale or zero values.</li>
      <li><strong>Possible cause</strong> — the session token is missing, invalid, or expired.</li>
      <li><strong>Verification</strong> — check whether the browser still holds a valid token; note that a fully expired session more often redirects straight to the login page via the application's global 401 handling, before this banner would appear.</li>
      <li><strong>Resolution</strong> — sign in again.</li>
    </ul>
    <h3>A count looks wrong (e.g. Infra Hosts vs. the host list elsewhere)</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — the Infra Hosts tile's number doesn't seem to match what's expected.</li>
      <li><strong>Possible cause</strong> — the Infra Hosts tile and Fleet Health chart are driven by the dedicated host-summary endpoint, which the implementation treats as authoritative over a count derived from the full host list — if the two ever disagree, the summary wins for this tile (the per-engine/CPU/environment breakdowns still use the full list).</li>
      <li><strong>Verification</strong> — compare against the Infrastructure module's own host count, which reads the same summary.</li>
      <li><strong>Resolution</strong> — no user action; this reflects which of the two feeds most recently completed its own poll (30s vs 60s cadence).</li>
    </ul>
    <h3>Cloud Accounts tile is red even though nothing seems wrong</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — the Cloud Accounts tile is shown in a critical/red tone despite cloud accounts being connected and working.</li>
      <li><strong>Possible cause</strong> — this is expected, current behavior: the tile is colored critical whenever one or more cloud accounts exist, regardless of their health.</li>
      <li><strong>Verification</strong> — none needed; this is the implemented color rule, not a fault condition.</li>
      <li><strong>Resolution</strong> — no action required.</li>
    </ul>
    <h3>Clicking "Cloud Accounts" goes to a blank/placeholder page</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — clicking the tile does not open a Cloud module.</li>
      <li><strong>Possible cause</strong> — the <code>/cloud</code> route has no page component implemented yet.</li>
      <li><strong>Verification</strong> — confirmed in the application router: no dedicated element is registered for this path.</li>
      <li><strong>Resolution</strong> — none available today; this is a known implementation gap, not a configuration issue on your side.</li>
    </ul>
    <h3>A chart is empty</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — a chart shows placeholder text instead of a plot.</li>
      <li><strong>Possible cause</strong> — the underlying feed genuinely has nothing to show yet (see the exact empty-state text in <button onclick="go('db-states')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Error / Empty / Loading States</button> to identify which condition applies).</li>
      <li><strong>Verification</strong> — check the corresponding module (Infrastructure/Database/Alerts) directly to confirm whether data truly is absent.</li>
      <li><strong>Resolution</strong> — register/connect the missing hosts, alerts, or accounts; the chart fills in automatically on its next poll once data exists.</li>
    </ul>
    <h3>Agent status looks wrong on the Dashboard</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — the Agents tile's color or count doesn't match expectations.</li>
      <li><strong>Possible cause</strong> — the tile only distinguishes "zero agents," "any agent critical," and "otherwise good" — it does not show a separate Warning state the way the Database/Infra tiles do.</li>
      <li><strong>Verification</strong> — check the Agents module directly for the specific agent's real status.</li>
      <li><strong>Resolution</strong> — investigate the specific agent on the Agents module; the Dashboard tile is intentionally a coarse summary only.</li>
    </ul>
    <h3>Refresh button spins but nothing changes</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — clicking refresh spins the icon but values stay the same.</li>
      <li><strong>Possible cause</strong> — the underlying data genuinely has not changed since the last poll, or one/more feeds are failing silently (Cloud feed failures in particular do not surface an error banner).</li>
      <li><strong>Verification</strong> — check network requests for the five dashboard endpoints (see <button onclick="go('db-reference')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Dashboard Reference</button>) to confirm they are returning successfully.</li>
      <li><strong>Resolution</strong> — if a request is failing, address that feed's own availability (e.g. the cloud microservice); the Dashboard itself has no retry logic to fall back on.</li>
    </ul>
  `
};

DOCS['db-reference'] = {
  title:'Dashboard Reference', dek:'Consolidated reference — metrics, statuses, cards, charts, APIs, routes, and permissions.',
  crumbs:['ActMon Documentation','Dashboard','Dashboard Reference'], module:'Dashboard', status:'Complete',
  body:`
    <h2>Route</h2>
    <div class="tblwrap"><table class="doc"><tr><th>Route</th><th>Component</th></tr>
      <tr><td><code>/dashboard</code></td><td><code>src/pages/Dashboard.jsx</code></td></tr></table></div>

    <h2>KPI tiles</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Tile</th><th>Destination</th></tr>
      <tr><td>Database Server</td><td><code>/databases</code></td></tr>
      <tr><td>Infra Hosts</td><td><code>/infra</code></td></tr>
      <tr><td>Cloud Accounts</td><td><code>/cloud</code> (not implemented)</td></tr>
      <tr><td>Agents</td><td><code>/agents</code></td></tr>
      <tr><td>Active Alerts</td><td><code>/alerts</code></td></tr>
    </table></div>

    <h2>Charts</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Chart</th><th>Family / default form</th></tr>
      <tr><td>Fleet Health</td><td>flat / donut</td></tr>
      <tr><td>Engine Distribution</td><td>flat / donut</td></tr>
      <tr><td>Cloud by Provider / Hosts by Environment</td><td>flat / donut</td></tr>
      <tr><td>Alerts By Severity</td><td>flat / column</td></tr>
      <tr><td>Servers By Technology</td><td>breakdown / stacked column</td></tr>
      <tr><td>Top Hosts By CPU</td><td>flat / horizontal bar</td></tr>
      <tr><td>Average Resource Usage</td><td>ratio / radial gauge</td></tr>
    </table></div>

    <h2>Status &amp; utilization bands</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Scale</th><th>States</th></tr>
      <tr><td>Host / general status</td><td><span class="pill good">Good</span> <span class="pill warn">Warning</span> <span class="pill crit">Critical</span></td></tr>
      <tr><td>CPU utilization band</td><td>Normal (&lt;60%), Elevated (60–74%), High (75–89%), Critical (≥90%)</td></tr>
      <tr><td>Infra Hosts health %</td><td>Good ≥90%, Warning ≥60%, Critical &lt;60%</td></tr>
    </table></div>

    <h2>APIs</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Endpoint</th><th>Method</th><th>Poll</th><th>Purpose</th><th>Org-scoped?</th></tr>
      <tr><td><code>/os-servers/summary</code></td><td>GET</td><td class="num">30s</td><td>Authoritative host status counts</td><td>Yes</td></tr>
      <tr><td><code>/os-servers/</code></td><td>GET</td><td class="num">60s</td><td>Full host list (engine/CPU/RAM/disk/environment breakdowns)</td><td>Yes</td></tr>
      <tr><td><code>/agents/</code></td><td>GET</td><td class="num">30s</td><td>Registered agents + status</td><td><strong>No</strong></td></tr>
      <tr><td><code>/alerts/active</code></td><td>GET</td><td class="num">15s</td><td>Currently-firing alerts, computed live</td><td><strong>No</strong></td></tr>
      <tr><td><code>/cloud/accounts</code></td><td>GET</td><td class="num">60s</td><td>Connected cloud accounts (separate microservice)</td><td>No (not multi-tenant)</td></tr>
    </table></div>
    <p>None of these is a Dashboard-specific endpoint — every one is shared with at least one other module
    (Infrastructure, Agents, Alerts, Cloud). No credentials, tokens, or secrets are returned by any of them.</p>

    <h2>Permissions</h2>
    <p>Session-required only; no fine-grained RBAC on this page. See
    <button onclick="go('db-permissions')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Permissions</button> for the tenant-scoping caveat on the Agents and Alerts feeds.</p>

    <h2>Navigation summary</h2>
    <p>See <button onclick="go('db-drilldown')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Navigation &amp; Drill-Down</button> for the complete source→destination matrix.</p>
  `
};

/* ============================================================
   AGENTS MODULE — full chapter
   ============================================================ */

DOCS['agt-overview'] = {
  title:'Agents Overview', dek:'What the Agents module is, and how it relates to Dashboard, Infrastructure, and Database.',
  crumbs:['ActMon Documentation','Agents','Agents Overview'], module:'Agents', status:'Complete',
  body:`
    <h2>What the Agents module is</h2>
    <p>The Agents module (route <code>/agents</code>, page title "Monitored Systems") is the fleet view of
    every ActMon agent — every collector process ActMon knows about, whether it monitors a physical/virtual
    host or one specific database connection. Each row is one <code>agents</code> table record.</p>
    <h2>Two kinds of agent, one list</h2>
    <p>An agent row is either a <strong>Host agent</strong> (no linked database connection — reports host-level
    CPU/memory/heartbeat) or a <strong>Database agent</strong> (linked to one specific connection via
    <code>db_connection_id</code> — reports that database's own connectivity, checks, and telemetry). The same
    physical machine commonly has both: one host-identity row, plus one additional row per database engine
    installed on it. See <button onclick="go('agt-architecture')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Host vs. Database Agent Architecture</button> for exactly why, and
    <button onclick="go('agt-status')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Agent Status &amp; Health</button> for how each row's state is decided.</p>
    <h2>Who should use it</h2>
    <ul>
      <li><strong>ActMon administrators</strong> — enrolling new hosts/databases, checking that agents are
      actually reporting.</li>
      <li><strong>DBAs and system administrators</strong> — jumping from an agent straight into that
      connection's own monitoring detail.</li>
      <li><strong>Support engineers</strong> — diagnosing why a specific agent shows an unexpected status.</li>
    </ul>
    <h2>How it connects to other modules</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Agents module shows</th><th>Full detail lives in</th></tr>
      <tr><td>Agents KPI tile on the Dashboard</td><td>Dashboard (this module supplies its count)</td></tr>
      <tr><td>A Host agent's own host resource detail (filesystems, processes, interfaces)</td><td>Infrastructure module — deliberately not duplicated here</td></tr>
      <tr><td>A Database agent's query/table/replication-level detail</td><td>Database module's own per-engine dashboard</td></tr>
      <tr><td>Service restart / "Update Agent" self-upgrade actions</td><td>Infrastructure module (host detail page) — <strong>not available anywhere in the Agents module itself</strong>, see <button onclick="go('agt-actions')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">User Actions</button></td></tr>
    </table></div>
  `
};

DOCS['agt-navigation'] = {
  title:'Agents Navigation', dek:'Routes, header, and how the Agents module is reached.',
  crumbs:['ActMon Documentation','Agents','Agents Navigation'], module:'Agents', status:'Complete',
  body:`
    <div class="tblwrap"><table class="doc">
      <tr><th>Route</th><th>Component</th><th>Purpose</th></tr>
      <tr><td><code>/agents</code></td><td><code>pages/agents/AgentsPage.jsx</code></td><td>The Monitored Systems list</td></tr>
      <tr><td><code>/agents/:name</code></td><td><code>pages/agents/AgentDetailPage.jsx</code></td><td>One agent's own monitoring view — Host or Database, decided automatically (see <button onclick="go('agt-status')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Agent Status &amp; Health</button>)</td></tr>
      <tr><td><code>/agents/deploy</code></td><td><code>DeployAgentWizard</code></td><td>Full install wizard for a brand-new host</td></tr>
      <tr><td><code>/agents/setup</code></td><td><code>AgentSetupPage</code></td><td>"Add data" catalogue (also mounted at <code>/databases/add-data</code>)</td></tr>
      <tr><td><code>/agents/setup/:tech</code></td><td><code>SetupWizard</code></td><td>Attach one of 6 database engines to a new or existing agent</td></tr>
      <tr><td><code>/agents/setup/website</code></td><td><code>AddWebsiteWizard</code></td><td>Synthetic website-monitoring check</td></tr>
      <tr><td><code>/agents/setup/network-check</code></td><td><code>AddNetworkCheckWizard</code></td><td>Ping / DNS / TCP-port / UDP-port check</td></tr>
    </table></div>
    <p>The Agents list opts out of the application's breadcrumb trail — it is one of a small number of pages
    specced pixel-for-pixel against a fixed reference design that has none.</p>
    <h2>Header actions (list page)</h2>
    <p>Register Agent · Sync · Deploy · a manual-refresh button with a live countdown — see
    <button onclick="go('agt-list-layout')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Agents List Layout</button> for exactly what each does.</p>
  `
};

DOCS['agt-list-layout'] = {
  title:'Agents List Layout', dek:'The Monitored Systems page, top to bottom.',
  crumbs:['ActMon Documentation','Agents','Agents List Layout'], module:'Agents', status:'Complete',
  body:`
    <h2>KPI cards</h2>
    <p>Four cards, each also a Status-filter shortcut — clicking one filters the list to that bucket; clicking
    the already-active card resets the filter back to "all."</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Card</th><th>Counts</th></tr>
      <tr><td>Total Agents</td><td>Every agent row</td></tr>
      <tr><td>Online</td><td>Status bucket <code>online</code></td></tr>
      <tr><td>Issues</td><td>Status bucket <code>warning</code> or <code>critical</code></td></tr>
      <tr><td>Offline</td><td>Status bucket <code>offline</code></td></tr>
    </table></div>
    <h2>Search</h2>
    <p>Matches agent <strong>name</strong>, <strong>hostname</strong>, <strong>IP address</strong>, and
    <strong>description</strong> (substring, case-insensitive for name/hostname/description).</p>
    <h2>Filter pills</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Group</th><th>Options</th></tr>
      <tr><td>Engine</td><td>"All" + every distinct <code>db_type</code> actually present in the loaded data (built dynamically, not a fixed list)</td></tr>
      <tr><td>Status</td><td>All, Online, Warning, Critical, Offline (fixed list)</td></tr>
      <tr><td>Env</td><td>"All" + every distinct <code>environment</code> value actually present (dynamic)</td></tr>
    </table></div>
    <p>A "Clear" button appears whenever search text or any filter differs from its default.</p>
    <h2>View toggle</h2>
    <p><strong>Grid</strong> and <strong>List</strong> — the chosen view is remembered in the browser (local
    storage), so it persists across visits. Grid view also shows a <strong>Sort</strong> control (Name A→Z/Z→A,
    Host CPU High→Low/Low→High, Sessions High→Low, Last Seen) — List view doesn't need it because its own
    columns are independently clickable to sort.</p>
    <h2>List view columns</h2>
    <p>Sr. No. · Agent/Host (name, with hostname/IP underneath) · Engine · Environment · Status (colored pill)
    · Agent CPU · Agent Host Memory · Sessions · Last Seen.</p>
    <h2>Grid view card</h2>
    <p>Each card shows: engine icon + name + hostname/IP, a state badge, engine/environment/cluster badges,
    agent version, CPU and memory meters, active-session count, and last-heartbeat age.</p>
    <h2>Header buttons</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Button</th><th>Behavior</th></tr>
      <tr><td>Register Agent</td><td>Navigates to <code>/agents/setup</code> — see the note in <button onclick="go('agt-registration-deploy')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Agent Registration &amp; Deployment</button> about the form this button used to open</td></tr>
      <tr><td>Sync</td><td>Calls the sync-connections action (see <button onclick="go('agt-sync')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Sync &amp; Auto-Discovery</button>) and shows a temporary result message for 6 seconds</td></tr>
      <tr><td>Deploy</td><td>Navigates to <code>/agents/deploy</code></td></tr>
      <tr><td>Refresh (with countdown)</td><td>Manually refetches the agent list immediately and resets the visible countdown</td></tr>
    </table></div>
    <h2>Row / card click</h2>
    <p>Opens that agent's own page at <code>/agents/{name}</code>.</p>
  `
};

DOCS['agt-status'] = {
  title:'Agent Status & Health', dek:'The complete decision tree behind every status label, color, and tooltip.',
  crumbs:['ActMon Documentation','Agents','Agent Status & Health'], module:'Agents', status:'Complete',
  body:`
    <p>Every agent's displayed state comes from one function evaluating the raw <code>status</code>,
    <code>last_error</code>, <code>last_heartbeat</code>, and <code>has_connection</code> fields, in this exact
    order:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Condition</th><th>Label</th><th>Tone</th><th>Meaning</th></tr>
      <tr><td><code>status = online</code></td><td><span class="pill good">Online</span></td><td>Success</td><td>Agent is collecting metrics</td></tr>
      <tr><td><code>status = error</code></td><td><span class="pill crit">DB Error</span></td><td>Danger</td><td>Collector cannot connect to the monitored database — tooltip shows the real <code>last_error</code> text, or a generic credentials/network hint if none is recorded</td></tr>
      <tr><td><code>status = warning</code></td><td><span class="pill warn">Warning</span></td><td>Warning</td><td>Metrics are collecting but a threshold is exceeded</td></tr>
      <tr><td><code>status = offline</code>, has a last heartbeat, error text matches a "service is running/answered" pattern</td><td><span class="pill crit">Offline</span></td><td>Danger</td><td>Stopped reporting — the host/service itself was still confirmed alive at some point, so this reads as a connectivity gap, not a stopped service</td></tr>
      <tr><td><code>status = offline</code>, has a last heartbeat, error text matches "is not running / not installed / reports inactive-stopped-failed"</td><td><span class="pill crit">Service Stopped</span></td><td>Danger</td><td>The OS itself confirmed the ActMon service is not running on that host</td></tr>
      <tr><td>Never reported yet, no DB connection linked</td><td><span class="pill neutral">Push Mode</span></td><td>Accent</td><td>Waiting for an external script to <code>POST /agents/data</code> for the first time</td></tr>
      <tr><td>Never reported yet, has a DB connection linked</td><td><span class="pill neutral">Waiting…</span></td><td>Info</td><td>Collector will attempt on its own interval; a database that stays here may be unreachable</td></tr>
    </table></div>
    <p>For counting/coloring purposes (KPI cards, row accents), every status collapses to one of four coarse
    buckets: <code>online</code>, <code>warning</code> (covers "warning" and "degraded"), <code>offline</code>,
    or <code>critical</code> (covers "error" and anything unrecognized).</p>
    <h2>Cluster badge</h2>
    <p>A small badge derived from the agent's free-text <code>description</code> field (case-insensitive
    substring match): contains "galera" → <strong>GALERA</strong>; "replica" → <strong>REPLICA</strong>;
    "cluster" → <strong>CLUSTER</strong>; "primary"/"master" → <strong>PRIMARY</strong>; otherwise the engine
    name itself, uppercased.</p>
    <div class="note"><b>"Offline" vs. "ambiguous" — a real distinction</b>${icon('agents',14)}<span>The backend
    collector deliberately does <strong>not</strong> flip a database agent's status just because it couldn't
    reach the agent transport for one cycle — that's treated as "ambiguous," not "offline," and is surfaced only
    as a warning notification, never a status change, until the reaper's own, separate heartbeat-silence timer
    (default 180 seconds, adaptive upward for hosts running many database engines at once) concludes the agent
    is genuinely silent. See <button onclick="go('agt-architecture')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Host vs. Database Agent Architecture</button>.</span></div>
  `
};

DOCS['agt-architecture'] = {
  title:'Host vs. Database Agent Architecture', dek:'Why one physical machine can have more than one agent row, and how status transitions really work underneath.',
  crumbs:['ActMon Documentation','Agents','Host vs. Database Agent Architecture'], module:'Agents', status:'Complete',
  body:`
    <h2>One table, two kinds of row</h2>
    <p>Both Host and Database agents are rows in the same underlying table, distinguished purely by whether
    <code>db_connection_id</code> is set:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Row kind</th><th><code>db_connection_id</code></th><th>Matched to its host via</th></tr>
      <tr><td>Host agent</td><td>NULL</td><td>Hostname match against the Infrastructure host list</td></tr>
      <tr><td>Database agent</td><td>Set, to a connection's ID</td><td>The connection's linked database instance → server record</td></tr>
    </table></div>
    <h2>Why the same host can have both</h2>
    <p>When a database is attached to an <em>already-enrolled</em> host agent (adding a database to a host that
    already reports infrastructure metrics), ActMon creates a <strong>second</strong> agent row — sharing the
    same physical host, but representing that one database engine. This is not incidental duplication: the
    backend's per-agent collector threads are keyed strictly on <code>db_connection_id</code> — a pure host row
    never receives database-status polling at all. The per-connection row is what actually gets checked. A
    batch "sync" pass (see <button onclick="go('agt-sync')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Sync &amp; Auto-Discovery</button>) applies the same rule at scale, explicitly
    skipping a duplicate when a matching host agent already covers that connection.</p>
    <p>In practice, one physical ActMon agent PROCESS on a host pushes telemetry under <strong>multiple agent
    names</strong> — its own host identity for infrastructure data, plus one identity per monitored database
    engine on that box.</p>
    <h2>How a status transition actually happens</h2>
    <p>Each database agent is polled on its own independent cycle (its own thread, its own interval — one
    agent's slow cycle never delays another's). Per cycle:</p>
    <ol>
      <li><strong>OS service-state gate</strong> — checked first. If the operating system already reports the
      service isn't running, status is forced to <code>error</code> immediately, with no waiting period.</li>
      <li><strong>Connectivity check</strong> — for the engines the agent's own push loop already covers
      (MySQL/MariaDB/PostgreSQL/MSSQL/Oracle/MongoDB/ClickHouse), only a cheap probe runs here, since full
      metrics already arrive via the agent's own 15-second push.</li>
      <li><strong>On success</strong> — failure streak resets, status becomes <code>online</code>.</li>
      <li><strong>On failure — two distinct outcomes</strong>:
        <ul>
          <li><strong>The agent itself didn't answer</strong> ("ambiguous") — status is <strong>held at its
          last known value</strong>, never flipped on this alone, and a warning notification fires only once
          per unreachable streak (not every cycle). This reflects transport-level uncertainty, not a confirmed
          database problem.</li>
          <li><strong>A real database-level failure</strong> — a failure counter increments; only once it
          reaches a configurable threshold (default <strong>3 consecutive failed cycles</strong>) does status
          actually flip to <code>error</code>. Below that threshold, the displayed status holds — the system is
          designed to degrade slowly and recover instantly.</li>
        </ul>
      </li>
    </ol>
    <p>A database agent's <code>last_heartbeat</code> is bumped only on a non-ambiguous cycle — an "agent
    unreachable" cycle deliberately does not refresh it, so a separate, independent staleness check (the
    reaper) can still correctly notice real silence even while the collector itself is holding the displayed
    status steady.</p>
    <h2>The reaper — a second, independent staleness check</h2>
    <p>Separately from the collector's own cycle, a background reaper watches how long it's been since each
    agent's last heartbeat. The threshold is adaptive: a host running several database engines at once gets
    proportionally more grace (since its single job channel serializes checks across all of them), rather than
    one fixed number for every agent. Only once that adaptive threshold is exceeded does the reaper mark the
    agent <code>offline</code>. A host-only agent with no database attached that stays silent long enough is
    eventually removed entirely; a host with at least one configured database is only ever marked offline,
    never deleted.</p>
    <div class="warnbox"><b>Known gap — no historical CPU/memory trend beyond a couple of hours</b>${icon('alerts',14)}<span>
    The PostgreSQL tables the per-agent metrics/SQL/wait-event/CSV-export endpoints read from are documented
    in the implementation itself as a short-lived transport buffer, pruned on a fixed retention window — in
    practice a couple of hours — regardless of how far back a request asks for (these endpoints accept a
    request for up to 30 days). Requesting a long time range from these specific endpoints will not return
    that much real history even though the parameter allows it.</span></div>
  `
};

DOCS['agt-host-monitoring'] = {
  title:'Host Agent Monitoring', dek:'The self-monitoring view shown for an agent with no linked database connection.',
  crumbs:['ActMon Documentation','Agents','Host Agent Monitoring'], module:'Agents', status:'Complete',
  body:`
    <p>Shown at <code>/agents/{name}</code> whenever that agent has no linked database connection. Its subject
    is deliberately narrow: is the agent itself alive and delivering telemetry — not the host's own OS-level
    detail (filesystems, processes, network interfaces), which belongs to the Infrastructure module and is not
    duplicated here.</p>
    <h2>Sections, top to bottom</h2>
    <ol>
      <li><strong>Header</strong> — agent name, OS type, IP, reporting interval, status badge, last-heartbeat
      age, manual refresh.</li>
      <li><strong>Delivery</strong> — 8 KPI tiles: Heartbeat age, Delivery % (received vs. expected samples in
      the last hour), Average interval, Jitter, Incoming rate, Throughput, Stored 24h (ClickHouse row count),
      Transfer queue (pending → ClickHouse). All computed from the live sample ring — the section explains that
      these read blank whenever that ring is empty, rather than showing misleading zeros.</li>
      <li><strong>Live telemetry</strong> — the same Range / Granularity / Timezone controls used across
      ActMon's telemetry views, plus 4 trend charts: reported host CPU, memory, disk (each 0–100% with
      threshold bands), and telemetry QPS. Shows an explanatory card instead of empty charts when there's
      nothing to plot (metrics pipeline disabled, Redis unreachable, or simply no samples yet).</li>
      <li><strong>Telemetry pipeline</strong> — an ordered 4-stage list (Agent → API, Metrics pipeline, Redis
      hot ring, ClickHouse history), each marked healthy or not, with the first broken stage called out at the
      top.</li>
      <li><strong>Agent process</strong> — three cards: <strong>Service</strong> (running or not, from a live
      OS-level probe), <strong>Version</strong> (reported agent version, plus a read-only view of any pending
      upgrade's status/timestamps — <strong>no button here to trigger an update</strong>), and
      <strong>Registration</strong> (name, host, IP, OS, environment, collection interval, registered-at,
      last heartbeat).</li>
      <li><strong>Agent events</strong> — recent notifications for this agent, or "No recent events" when
      healthy.</li>
    </ol>
    <p>A footer note links to Infrastructure for host-OS-level detail (CPU/disks/processes/interfaces).</p>
    <div class="note"><b>No action buttons on this page</b>${icon('agents',14)}<span>Triggering an agent
    self-update, restarting its service, or any other host-control action is only available from the
    Infrastructure module's own host detail page (each gated behind a password re-confirmation) — this page is
    read-only self-monitoring. See <button onclick="go('agt-actions')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">User Actions</button>.</span></div>
  `
};

DOCS['agt-database-monitoring'] = {
  title:'Database Agent Monitoring', dek:'The self-monitoring view shown for an agent linked to a specific database connection.',
  crumbs:['ActMon Documentation','Agents','Database Agent Monitoring'], module:'Agents', status:'Complete',
  body:`
    <p>Shown at <code>/agents/{name}</code> whenever that agent has a linked database connection. Its subject
    is "is the ActMon agent's monitoring of this database working" — not the database's own query/table/
    replication workload, which belongs to that engine's own dashboard in the Database module.</p>
    <h2>Sections, top to bottom</h2>
    <ol>
      <li><strong>Header</strong> — the database engine as the title, "{Engine} Database Agent · {host}" as
      the description, status badge, last heartbeat, manual refresh.</li>
      <li><strong>Top Status</strong> — 6 KPIs: Database (engine + instance/database name), Agent
      (online/offline + version), Connection (the live result of the connection check), Monitoring
      (Active/Stopped), Last Heartbeat, Monitoring Interval.</li>
      <li><strong>Delivery</strong> — the identical 8-tile block described in
      <button onclick="go('agt-host-monitoring')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Host Agent Monitoring</button>.</li>
      <li><strong>Live Database Telemetry</strong> — the same Range/Granularity/Timezone controls, with 4
      database-specific charts: queries/second, transactions/second, active sessions, cache hit rate.</li>
      <li><strong>More Details</strong> — four click-to-reveal cards, closed by default, one open at a time:
        <ul>
          <li><strong>Database Identity</strong> — technology, host, IP, port, database/instance, connection
          name, agent version.</li>
          <li><strong>Connection Health</strong> — the connection check's last pass/fail result, last
          success/failure timestamps, failure count.</li>
          <li><strong>Permission Status</strong> — one row per monitoring-check category, showing whether
          ActMon's own database account has the access that category's checks need. See
          <button onclick="go('agt-checks')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Database Monitoring Checks</button> for what the categories are.</li>
          <li><strong>Monitoring Timeline</strong> — the latest 5 real events for this connection (enrollment,
          notifications, check results) — fetched only once this card is opened.</li>
        </ul>
      </li>
      <li><strong>Database Error Log</strong> — the database's own native error log, as last read by the
      Errors check, parsed into a short, severity-tagged list (latest 5) — or a plain "OK, no errors found"
      state when clean.</li>
    </ol>
    <p>A footer note links to the Database module for query/table/replication-level detail.</p>
    <div class="imp"><b>Nothing on this page runs a check</b>${icon('agents',14)}<span>Every result shown here —
    Connection Health, Permission Status, the Error Log — is the <strong>last automatically-recorded</strong>
    result. This page has no "Run Check" button; a check is only ever executed on demand from the Diagnosis
    workspace elsewhere in ActMon, or automatically by the backend's own collector cycle. See
    <button onclick="go('agt-checks')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Database Monitoring Checks</button> for exactly what those checks are.</span></div>
  `
};

DOCS['agt-checks'] = {
  title:'Database Monitoring Checks', dek:'The real, per-technology check catalogue behind Connection Health, Permission Status, and the Error Log.',
  crumbs:['ActMon Documentation','Agents','Database Monitoring Checks'], module:'Agents', status:'Complete',
  body:`
    <p>Every database agent's checks come from one shared catalogue, keyed by technology. Eight technologies
    are supported: MySQL, MariaDB, PostgreSQL, MSSQL, Oracle, MongoDB, and ClickHouse.</p>
    <h2>Baseline — every supported technology gets these three</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Check</th><th>Category</th><th>What it does</th></tr>
      <tr><td>Database Connection</td><td>Connection</td><td>A real authentication + query test against the live connection, using each engine's own connect logic</td></tr>
      <tr><td>Server Health</td><td>Server</td><td>Reads the same live health summary that engine's own dashboard shows</td></tr>
      <tr><td>Error Logs</td><td>Errors</td><td>Reads the database's native error log via its own real mechanism; the worst severity found decides whether the check reads as passed, a warning, or failed</td></tr>
    </table></div>
    <h2>ClickHouse — the one technology with extra, granular checks today</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Check</th><th>Category</th><th>Real query</th></tr>
      <tr><td>Databases</td><td>Database</td><td><code>SELECT ... FROM system.databases</code></td></tr>
      <tr><td>Tables</td><td>Tables</td><td><code>SELECT ... FROM system.tables</code></td></tr>
      <tr><td>Query Log</td><td>Queries</td><td><code>SELECT ... FROM system.query_log</code></td></tr>
      <tr><td>Active Merges</td><td>Performance</td><td><code>SELECT ... FROM system.merges</code></td></tr>
      <tr><td>Replication</td><td>Replication</td><td><code>SELECT ... FROM system.replicas</code> — reads "not supported" when there are no replicated tables at all, since a standalone server genuinely has nothing to report here</td></tr>
      <tr><td>Settings</td><td>Storage</td><td><code>SELECT ... FROM system.settings WHERE changed = 1</code></td></tr>
    </table></div>
    <div class="note"><b>Extending this to other engines is additive, not a redesign</b>${icon('book',14)}<span>
    The catalogue is explicitly built so that giving another technology this same granularity later only means
    adding its own real functions to the extra-checks list — no other technology currently has anything beyond
    the 3-check baseline, despite the framework already supporting more.</span></div>
    <h2>Permission Status detection</h2>
    <p>When a check fails with an authentication/authorization-shaped error, ActMon recognizes the pattern
    per engine (e.g. MySQL's "Access denied for user," Oracle's <code>ORA-01031</code>/<code>ORA-01017</code>,
    MSSQL's "permission was denied" / "login failed") and surfaces a structured explanation — what's required,
    why, and how to grant it — instead of a raw driver error. This is what feeds the Database Agent page's
    Permission Status panel.</p>
    <h2>How and when a check actually runs</h2>
    <p>A check result is only ever produced by an explicit, one-off execution — never on a hidden schedule.
    Two things can trigger one: the Diagnosis workspace's own "Run Check" action, or the backend's own
    connectivity probe during its regular collector cycle (for the baseline Connection check specifically).
    The Agents module itself only ever <em>displays</em> the last recorded result — see
    <button onclick="go('agt-database-monitoring')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Database Agent Monitoring</button>.</p>
  `
};

DOCS['agt-registration-deploy'] = {
  title:'Agent Registration & Deployment', dek:'How a new agent or a new monitored database actually gets added.',
  crumbs:['ActMon Documentation','Agents','Agent Registration & Deployment'], module:'Agents', status:'Complete',
  body:`
    <div class="warnbox"><b>"Register Agent" does not open a form</b>${icon('agents',14)}<span>A fully built
    registration dialog (name, engine, environment, hostname, IP, OS, collection interval, description) exists
    in the codebase, but nothing in the running application opens it — the "Register Agent" button on the
    Agents list navigates straight to the Deploy/Setup flow described below instead. This documentation
    describes what the application actually does, not the unused dialog.</span></div>
    <h2>Deploy Agent wizard (<code>/agents/deploy</code>)</h2>
    <p>A multi-step wizard for installing the agent on a brand-new host. Its steps adapt to the chosen method:</p>
    <ul>
      <li><strong>Manual install</strong> (script or installer) — Deployment → Ingestion Token → Configuration →
      (Distribution, Linux only) → Installation → Logs → Suggested Alerts → Summary.</li>
      <li><strong>Automated/container methods</strong> (Ansible, Chef, Puppet, SaltStack, Docker, Kubernetes) —
      a shorter Deployment → Ingestion Token → Instruction → Suggested Alerts flow; the Instruction step is not
      yet built for these methods.</li>
    </ul>
    <p>The Installation step builds a real, copyable install command for the chosen OS: on Windows, an elevated
    PowerShell one-liner that installs the agent as a genuine <strong>Windows Service</strong> (a deliberate
    design choice — an earlier scheduled-task approach silently failed to re-arm itself once in production and
    left a host dark for 46 minutes); on Linux, a shell command that detects the right package manager and
    installs the corresponding package. The wizard polls the agent list every 5 seconds to detect the new agent
    coming online, unlocking the Next button automatically once it does.</p>
    <p>A Suggested Alerts step offers 12 ready-made alert rule templates (agent-stopped, high CPU/disk/memory
    thresholds, host-down, replication lag, and similar) to create for the new host in one step; any template
    that already exists as a rule is shown disabled. The final Summary step live-checks the new agent's status
    by its ingestion token and links onward to the Agents list, the agent's own page, Infrastructure, and (if
    configured) log monitoring.</p>
    <h2>Per-technology setup wizard (<code>/agents/setup/:tech</code>)</h2>
    <p>Attaches one of 6 database engines (MySQL, PostgreSQL, MSSQL, Oracle, MongoDB, ClickHouse) to either a
    brand-new or an already-enrolled agent, in 4 steps: pick or create the Agent, enter Credentials (with a
    "test connection" that runs <strong>through the agent itself</strong> when attaching to an existing one,
    since the ActMon server cannot reach a database on the agent's own localhost directly), a Prepare step
    showing the exact read-only-monitoring-user SQL/commands to run on the database (a real, engine-specific
    grant statement — e.g. PostgreSQL's built-in <code>pg_monitor</code> role, or MySQL's
    PROCESS/SELECT/SHOW VIEW/REPLICATION CLIENT grants), and a read-only Summary before finishing.</p>
    <h2>Website / network-check wizards</h2>
    <p><code>/agents/setup/website</code> and <code>/agents/setup/network-check</code> create synthetic
    monitoring checks (a URL to poll, or a ping/DNS/TCP-port/UDP-port target) rather than installing anything on
    a host.</p>
    <h2>The "Add Data" catalogue (<code>/agents/setup</code>)</h2>
    <p>A tabbed catalogue (Digital Experience / APM / Databases / Infrastructure / Network / Logs /
    Integrations) that the "Register Agent" button and several other entry points land on. Many catalogue
    entries beyond the ones described above (most APM languages, several infrastructure/network/integration
    items) have no destination wired up yet and are inert placeholders.</p>
  `
};

DOCS['agt-sync'] = {
  title:'Sync & Auto-Discovery', dek:'What the "Sync" button on the Agents list actually does.',
  crumbs:['ActMon Documentation','Agents','Sync & Auto-Discovery'], module:'Agents', status:'Complete',
  body:`
    <p>The Sync action scans every saved database connection in ActMon and, for each one, either recognizes it
    is already covered by an existing agent, or creates a new per-connection agent row for it.</p>
    <h2>The dedup rule</h2>
    <p>A new agent row is <strong>not</strong> created for a connection when a host-level agent with a matching
    name already exists — the intent is to avoid a second, disconnected-looking agent appearing for a host
    that's already listed under its host identity. This is the same rule described in
    <button onclick="go('agt-architecture')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Host vs. Database Agent Architecture</button>, applied to every saved connection at once
    rather than one at a time.</p>
    <p>After running, the button shows a temporary result message summarizing how many agents were created and
    how many already existed, for 6 seconds.</p>
    <div class="note"><b>When you'd use this</b>${icon('agents',14)}<span>Sync is the recovery path if a
    database connection was ever added without going through the per-technology setup wizard's own agent-linking
    step, or if the link between a connection and its agent needs to be re-established.</span></div>
  `
};

DOCS['agt-filters'] = {
  title:'Filters', dek:'Search, filter pills, and view/sort controls on the Agents list.',
  crumbs:['ActMon Documentation','Agents','Filters'], module:'Agents', status:'Complete',
  body:`
    <div class="tblwrap"><table class="doc">
      <tr><th>Control</th><th>Options</th><th>Default</th><th>Persists?</th></tr>
      <tr><td>Search</td><td>Free text — matches name, hostname, IP, description</td><td>Empty</td><td>No — resets on reload</td></tr>
      <tr><td>Engine pill</td><td>All + every engine actually present</td><td>All</td><td>No</td></tr>
      <tr><td>Status pill</td><td>All, Online, Warning, Critical, Offline</td><td>All</td><td>No</td></tr>
      <tr><td>Env pill</td><td>All + every environment actually present</td><td>All</td><td>No</td></tr>
      <tr><td>View (Grid/List)</td><td>Grid, List</td><td>Grid</td><td><strong>Yes</strong> — saved in the browser's local storage</td></tr>
      <tr><td>Sort (Grid view only)</td><td>Name A→Z/Z→A, Host CPU High→Low/Low→High, Sessions High→Low, Last Seen</td><td>Name A→Z</td><td>No</td></tr>
    </table></div>
    <p>The 4 KPI cards double as an additional Status-filter shortcut, described in
    <button onclick="go('agt-list-layout')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Agents List Layout</button>. A "Clear" button appears whenever any of search/Engine/Status/Env
    differs from its default.</p>
  `
};

DOCS['agt-refresh'] = {
  title:'Refresh & Real-Time Data', dek:'Polling intervals across the Agents list and both agent detail views.',
  crumbs:['ActMon Documentation','Agents','Refresh & Real-Time Data'], module:'Agents', status:'Complete',
  body:`
    <div class="tblwrap"><table class="doc">
      <tr><th>View</th><th>Feed</th><th>Interval</th></tr>
      <tr><td>Agents list</td><td>Agent list</td><td class="num">10s</td></tr>
      <tr><td>Host / Database agent page</td><td>Host overview (telemetry/comm/events)</td><td class="num">15s</td></tr>
      <tr><td>Host / Database agent page</td><td>Service state</td><td class="num">30s</td></tr>
      <tr><td>Host / Database agent page</td><td>Update status</td><td class="num">60s</td></tr>
      <tr><td>Host / Database agent page</td><td>Metrics pipeline status (server-wide, not per-agent)</td><td class="num">60s</td></tr>
      <tr><td>Database agent page</td><td>Check catalogue</td><td class="num">30s</td></tr>
      <tr><td>Database agent page</td><td>Monitoring timeline</td><td class="num">60s — only once its panel is opened</td></tr>
      <tr><td>Deploy/Setup wizard Summary</td><td>Agent list (watching for the new agent to appear)</td><td class="num">5s</td></tr>
    </table></div>
    <p>The Agents list's visible refresh countdown is a cosmetic 1-second-tick display — the actual data
    refresh runs on the fixed interval above regardless of what the countdown shows, the same pattern used on
    the Dashboard.</p>
    <div class="warnbox"><b>A real data-retention gap</b>${icon('alerts',14)}<span>An agent's per-metric/SQL/
    wait-event history and CSV export accept a request for up to 30 days, but the table they actually read from
    is only ever retained for a couple of hours before being pruned — full long-term history lives in a
    separate store this particular set of endpoints doesn't use. See
    <button onclick="go('agt-architecture')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Host vs. Database Agent Architecture</button>.</span></div>
  `
};

DOCS['agt-actions'] = {
  title:'User Actions', dek:'Every action available across the Agents list and detail pages.',
  crumbs:['ActMon Documentation','Agents','User Actions'], module:'Agents', status:'Complete',
  body:`
    <div class="tblwrap"><table class="doc">
      <tr><th>Action</th><th>Where</th><th>Result</th></tr>
      <tr><td>Click a KPI card</td><td>Agents list</td><td>Filters the list to that status bucket; click again to clear</td></tr>
      <tr><td>Search / filter pills</td><td>Agents list</td><td>Narrows the visible rows, client-side</td></tr>
      <tr><td>Switch Grid/List, change Sort</td><td>Agents list</td><td>Changes presentation only; view choice is remembered</td></tr>
      <tr><td>Register Agent</td><td>Agents list header</td><td>Navigates to <code>/agents/setup</code></td></tr>
      <tr><td>Sync</td><td>Agents list header</td><td>Creates missing per-connection agents from saved connections; shows a result message</td></tr>
      <tr><td>Deploy</td><td>Agents list header</td><td>Navigates to <code>/agents/deploy</code></td></tr>
      <tr><td>Refresh</td><td>Agents list / either agent detail page</td><td>Refetches that page's data immediately</td></tr>
      <tr><td>Click a row/card</td><td>Agents list</td><td>Opens that agent's own page</td></tr>
      <tr><td>Open a "More Details" panel</td><td>Database agent page</td><td>Reveals Identity / Connection Health / Permission Status / Monitoring Timeline, one at a time — nothing is fetched until opened</td></tr>
      <tr><td>Change range/granularity/timezone</td><td>Either agent detail page</td><td>Redraws the telemetry charts for that window</td></tr>
    </table></div>
    <div class="imp"><b>Not available anywhere in this module</b>${icon('alerts',14)}<span>Running a monitoring
    check on demand, restarting the ActMon service, or triggering a self-update are all real ActMon
    capabilities — but none of them are reachable from the Agents module. Running a check on demand lives in
    the Diagnosis workspace; restarting the service and self-updating the agent live only on the Infrastructure
    module's own host detail page (each requiring password re-confirmation there).</span></div>
  `
};

DOCS['agt-drilldown'] = {
  title:'Navigation & Drill-Down', dek:'Every place the Agents module sends you.',
  crumbs:['ActMon Documentation','Agents','Navigation & Drill-Down'], module:'Agents', status:'Complete',
  body:`
    <div class="tblwrap"><table class="doc navmatrix">
      <tr><th>Agents module item</th><th>Action</th><th>Destination</th><th>Purpose</th></tr>
      <tr><td>Agent row/card</td><td>Click</td><td><code>/agents/{name}</code></td><td>Open that agent's own monitoring view</td></tr>
      <tr><td>Register Agent button</td><td>Click</td><td><code>/agents/setup</code></td><td>Add-data catalogue</td></tr>
      <tr><td>Deploy button</td><td>Click</td><td><code>/agents/deploy</code></td><td>Full new-host install wizard</td></tr>
      <tr><td>Host Agent page footer</td><td>Click</td><td><code>/infra</code></td><td>Host OS-level detail</td></tr>
      <tr><td>Database Agent page footer</td><td>Click</td><td><code>/databases</code></td><td>That engine's own workload dashboard</td></tr>
      <tr><td>Setup wizard result (existing agent)</td><td>Click</td><td>e.g. <code>/mysql-dashboard/{id}</code></td><td>Jump straight to the new connection's own dashboard</td></tr>
      <tr><td>Deploy wizard Summary</td><td>Click</td><td><code>/agents</code>, <code>/agents/{name}</code>, <code>/infra</code>, <code>/logs</code></td><td>Jump to the newly-deployed agent or related views</td></tr>
      <tr><td>Deploy wizard "Additional Actions"</td><td>Click</td><td><code>/agents/setup?tab=Databases&amp;agent=...</code></td><td>Pre-selects the just-deployed agent in the per-tech setup wizard</td></tr>
      <tr><td>Per-tech wizard "Deploy a new Agent"</td><td>Click</td><td><code>/agents/deploy</code></td><td>Switch to the full install wizard</td></tr>
      <tr><td>Add-Data catalogue entries</td><td>Click</td><td><code>/infra</code>, <code>/cloud</code>, <code>/logs</code></td><td>Other monitoring setup entry points</td></tr>
    </table></div>
  `
};

DOCS['agt-permissions'] = {
  title:'Permissions', dek:'What access is required to view or act on Agents module data.',
  crumbs:['ActMon Documentation','Agents','Permissions'], module:'Agents', status:'Complete',
  body:`
    <div class="imp"><b>Not currently implemented</b>${icon('alerts',14)}<span>No fine-grained permission or
    role check gates any part of the Agents module. Every page and API route in this module was checked
    directly — none of them reference the application's permission-checking mechanism, which is confirmed to
    exist and to be used elsewhere (Infrastructure, Database, Diagnosis, and Administration).</span></div>
    <div class="warnbox"><b>No organization/tenant scoping either — a real, verified gap</b>${icon('alerts',14)}<span>
    Every endpoint this module depends on — the agent list, an agent's dashboard/metrics/SQL/sessions/
    wait-events/oracle-snapshot/export, host-overview, notifications, registration, enrollment, database
    check catalogue/run/history/timeline — was checked directly for organization scoping. <strong>None of them
    filter by organization at all</strong>: the agent list, for example, returns every agent across every
    organization in one unscoped query. This is a real architectural gap compared to the Infrastructure
    module's host endpoints, which already do filter by organization — the Agents module currently sits
    outside that pattern entirely.</span></div>
    <p>The only access requirement found anywhere in this module is a valid, signed-in session — the same
    baseline every authenticated page requires.</p>
    <p>Note: "Permission Status" on the Database Agent page (see
    <button onclick="go('agt-database-monitoring')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Database Agent Monitoring</button>) is a display of the monitored
    <em>database's own account</em> privileges — it has nothing to do with ActMon's own application-level
    permissions.</p>
  `
};

DOCS['agt-states'] = {
  title:'Error / Empty / Loading States', dek:'What the Agents module looks like when data is missing, loading, or failing.',
  crumbs:['ActMon Documentation','Agents','Error / Empty / Loading States'], module:'Agents', status:'Complete',
  body:`
    <h2>Agents list</h2>
    <ul>
      <li><strong>Zero agents at all</strong> — "No agents registered," with a call to action to register one.</li>
      <li><strong>Filtered to zero</strong> — "No agents match filters," with a clear-filters action.</li>
      <li><strong>Backend unreachable</strong> — an error banner above the KPI cards.</li>
      <li><strong>Background refresh</strong> — the list dims slightly rather than showing a full loading
      screen, in List view via the table's own built-in loading treatment.</li>
    </ul>
    <h2>Agent detail pages (Host and Database)</h2>
    <ul>
      <li><strong>Initial load</strong> — a spinner beneath the header.</li>
      <li><strong>Agent not found</strong> — a distinct "No agent named X" empty state (versus a generic load
      failure message for any other error), with a "Back to agents" action.</li>
      <li><strong>No telemetry series to chart</strong> — an explanatory card naming the actual reason (pipeline
      disabled / Redis unreachable / genuinely no samples yet) instead of four blank charts.</li>
      <li><strong>Database Error Log clean</strong> — an explicit "OK — no errors found" message rather than an
      empty box.</li>
    </ul>
  `
};

DOCS['agt-troubleshooting'] = {
  title:'Troubleshooting', dek:'Practical answers grounded in the actual Agents module implementation.',
  crumbs:['ActMon Documentation','Agents','Troubleshooting'], module:'Agents', status:'Complete',
  body:`
    <h3>An agent stays on "Waiting…" indefinitely</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — a database agent never leaves the "Waiting…" state.</li>
      <li><strong>Possible cause</strong> — it has a linked database connection but has never successfully
      reported; the database may be unreachable from the agent host, or the agent process may not actually be
      running that connection's collection loop.</li>
      <li><strong>Verification</strong> — open the agent's own page and check its Connection Health / Service
      state.</li>
      <li><strong>Resolution</strong> — confirm the credentials and network path from the agent host to the
      database; re-check the per-technology setup wizard's Prepare step for the required grants.</li>
    </ul>
    <h3>Status shows "Offline" but the host/service is clearly running</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — an agent reads Offline even though its host is up.</li>
      <li><strong>Possible cause</strong> — the reaper's silence threshold was exceeded, meaning heartbeats
      genuinely stopped arriving for longer than the (adaptive) grace period — this is a heartbeat-silence
      verdict, separate from the collector's own moment-to-moment connectivity checks.</li>
      <li><strong>Verification</strong> — check the agent's own last-heartbeat timestamp and the host's own
      network reachability to the ActMon server.</li>
      <li><strong>Resolution</strong> — restore connectivity between the agent and the ActMon server; the
      status will recover automatically once a fresh heartbeat arrives.</li>
    </ul>
    <h3>Status flickers between Online and a failure state</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — an agent's status appears to bounce.</li>
      <li><strong>Possible cause</strong> — intermittent, real connectivity failures below the configured
      failure-streak threshold hold status steady rather than flipping on a single bad cycle — genuinely
      flapping connectivity can still surface as visible status changes once the streak crosses that
      threshold.</li>
      <li><strong>Verification</strong> — check the agent's recent notifications/events for repeated warnings.</li>
      <li><strong>Resolution</strong> — investigate the underlying network or database stability between the
      agent and its target; the status logic is reporting a real, if intermittent, problem.</li>
    </ul>
    <h3>Sync doesn't create an agent I expected</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — clicking Sync doesn't add a new row for a connection.</li>
      <li><strong>Possible cause</strong> — a host-level agent with a matching name already exists for that
      connection's host, so Sync deliberately skips creating a second, duplicate-looking row.</li>
      <li><strong>Verification</strong> — check the Sync result message ("N created, M already existed") and
      look for an existing host agent covering that same host.</li>
      <li><strong>Resolution</strong> — no action needed if a covering agent already exists; if it genuinely
      does not, use the per-technology setup wizard instead, which links the connection explicitly.</li>
    </ul>
    <h3>"Register Agent" doesn't open a form</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — clicking Register Agent just navigates away instead of opening a dialog.</li>
      <li><strong>Possible cause</strong> — this is expected, current behavior: the button intentionally routes
      to the Add Data / Setup catalogue instead of the (unused) registration dialog.</li>
      <li><strong>Verification</strong> — none needed.</li>
      <li><strong>Resolution</strong> — use the Deploy or per-technology Setup wizard reached from that page.</li>
    </ul>
    <h3>Requested metrics history is shorter than expected</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — asking for several days/weeks of an agent's metrics/SQL/wait-event history
      returns far less than requested.</li>
      <li><strong>Possible cause</strong> — this endpoint family reads from a short-retention transport table
      (a couple of hours), not the long-term history store.</li>
      <li><strong>Verification</strong> — compare against a technology dashboard's own longer-range charts,
      which read from the long-term store instead.</li>
      <li><strong>Resolution</strong> — none from within this module; this is a known implementation
      characteristic, not a configuration problem.</li>
    </ul>
  `
};

DOCS['agt-reference'] = {
  title:'Agents Reference', dek:'Consolidated reference — routes, status states, checks, APIs, and permissions.',
  crumbs:['ActMon Documentation','Agents','Agents Reference'], module:'Agents', status:'Complete',
  body:`
    <h2>Routes</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Route</th><th>Component</th></tr>
      <tr><td><code>/agents</code></td><td><code>pages/agents/AgentsPage.jsx</code></td></tr>
      <tr><td><code>/agents/:name</code></td><td><code>pages/agents/AgentDetailPage.jsx</code> → Host or Database view</td></tr>
      <tr><td><code>/agents/deploy</code></td><td><code>DeployAgentWizard</code></td></tr>
      <tr><td><code>/agents/setup</code></td><td><code>AgentSetupPage</code></td></tr>
      <tr><td><code>/agents/setup/:tech</code></td><td><code>SetupWizard</code></td></tr>
      <tr><td><code>/agents/setup/website</code></td><td><code>AddWebsiteWizard</code></td></tr>
      <tr><td><code>/agents/setup/network-check</code></td><td><code>AddNetworkCheckWizard</code></td></tr>
    </table></div>
    <h2>Status states</h2>
    <p><span class="pill good">Online</span> <span class="pill crit">DB Error</span>
    <span class="pill warn">Warning</span> <span class="pill crit">Offline</span>
    <span class="pill crit">Service Stopped</span> <span class="pill neutral">Push Mode</span>
    <span class="pill neutral">Waiting…</span> — full decision tree in
    <button onclick="go('agt-status')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Agent Status &amp; Health</button>.</p>
    <h2>Database Monitoring Checks catalogue</h2>
    <p>3 baseline checks (Connection, Server Health, Errors) for all 8 supported technologies; 6 additional
    granular checks for ClickHouse only. Full detail in
    <button onclick="go('agt-checks')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Database Monitoring Checks</button>.</p>
    <h2>APIs</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Endpoint</th><th>Method</th><th>Poll</th><th>Purpose</th></tr>
      <tr><td><code>/agents/</code></td><td>GET</td><td class="num">10s</td><td>Full agent list with live metrics</td></tr>
      <tr><td><code>/agents/register</code></td><td>POST</td><td>—</td><td>Create an agent (reachable only via the unused dialog)</td></tr>
      <tr><td><code>/agents/sync-connections</code></td><td>POST</td><td>—</td><td>Create missing per-connection agents</td></tr>
      <tr><td><code>/agents/{name}/host-overview</code></td><td>GET</td><td class="num">15s</td><td>Telemetry, comms stats, events</td></tr>
      <tr><td><code>/agents/{name}/service-state</code></td><td>GET</td><td class="num">30s</td><td>Live OS service check</td></tr>
      <tr><td><code>/agents/{name}/update-status</code></td><td>GET</td><td class="num">60s</td><td>Pending upgrade ledger (read-only)</td></tr>
      <tr><td><code>/agents/{name}/dashboard</code>, <code>/metrics</code>, <code>/sql</code>, <code>/sessions</code>, <code>/wait-events</code>, <code>/oracle-snapshot</code>, <code>/export/csv</code></td><td>GET</td><td>on demand</td><td>Per-agent drilldown data (short-retention Postgres store)</td></tr>
      <tr><td><code>/agents/notifications/</code>, <code>/notifications/read</code></td><td>GET / POST</td><td>on demand</td><td>Agent event notifications</td></tr>
      <tr><td><code>/agents/install-token</code>, <code>/enroll</code>, <code>/db-config</code>, <code>/db-test</code>, <code>/host-ips</code></td><td>POST/GET</td><td>—</td><td>Registration/deployment flow</td></tr>
      <tr><td><code>/agents/db-agent/{connId}/info</code>, <code>/checks</code>, <code>/timeline</code></td><td>GET</td><td class="num">30–60s</td><td>Database Agent page data</td></tr>
      <tr><td><code>/metrics/pipeline/status</code></td><td>GET</td><td class="num">60s</td><td>Server-wide telemetry tier health</td></tr>
    </table></div>
    <p>None of these endpoints apply organization/tenant scoping — see
    <button onclick="go('agt-permissions')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Permissions</button>.</p>

    <h2>Navigation summary</h2>
    <p>See <button onclick="go('agt-drilldown')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Navigation &amp; Drill-Down</button> for the complete source→destination matrix.</p>
  `
};

/* ============================================================
   DATABASE MODULE — full chapter
   ============================================================ */

DOCS['dbm-overview'] = {
  title:'Database Overview', dek:'What the Database module is, the seven engines it covers, and how it connects to the rest of ActMon.',
  crumbs:['ActMon Documentation','Database','Database Overview'], module:'Database', status:'Complete',
  body:`
    <h2>What the Database module is</h2>
    <p>The Database module is reached at <code>/databases</code> and is built from one shared component,
    <code>frontend/src/pages/databases/DatabaseServersPage.jsx</code>, reused for two different screens exactly
    the way the Dashboard's own component is reused nowhere else — this one component renders both the
    "choose a technology" chooser (no <code>tech</code> prop) and every technology's own server list (a
    <code>tech</code> prop, e.g. <code>/mysql-servers</code>). See
    <button onclick="go('dbm-navigation')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Database Navigation</button>.</p>
    <h2>Seven engines, six + one</h2>
    <p>Six database engines share this component and its <code>/{tech}-servers → /{tech}-dashboard/:id</code>
    flow: <strong>MySQL, PostgreSQL, Oracle, MSSQL, MongoDB, and ClickHouse</strong>. A seventh,
    <strong>Cosmos DB</strong>, is deliberately handled by its own separate connections page
    (<code>CosmosDBConnectionsPage.jsx</code>, route <code>/cosmosdb-servers</code>) rather than
    <code>DatabaseServersPage.jsx</code> — the code's own reasoning, confirmed in that file, is that "a Cosmos
    connection has no host and no port — it has an account endpoint, a key, and a default database/container,"
    so the host/port-shaped server list used by the other six would leave its two identifying columns blank.
    Cosmos DB still gets its own full dashboard at <code>/cosmosdb-dashboard/:id</code>, documented alongside
    the other six in this chapter.</p>
    <p>Eight further "Cloud-Based Databases" (Amazon DynamoDB, Google Cloud Firestore, Google Cloud Bigtable,
    Azure Table Storage, Amazon DocumentDB, MongoDB Atlas, Couchbase Capella, Firebase Realtime Database) are
    listed as static, non-clickable "Coming Soon" tiles on the chooser screen — none of them has a server list,
    a dashboard, or a backend route anywhere in the application; they exist purely to show the roadmap.</p>
    <h2>Who should use it</h2>
    <ul>
      <li><strong>Database administrators</strong> — the primary users: per-engine dashboards, slow-query and
      error-log analysis, index recommendations, and (for MySQL and MSSQL) AI-assisted self-heal.</li>
      <li><strong>ActMon administrators</strong> — registering new servers and connections, choosing SSH vs.
      Agent collection.</li>
      <li><strong>Support/on-call engineers</strong> — the Diagnose and Resource Drill-Down tools reached from a
      struggling connection (see
      <button onclick="go('dbm-drilldown-diagnose')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Resource Drill-Down &amp; Diagnose</button>).</li>
    </ul>
    <h2>What users should understand immediately</h2>
    <ul>
      <li>The seven engines are <strong>not equally capable</strong> — most visibly for self-heal (implemented
      only for MySQL and MSSQL) and for backup reporting (Oracle's Reports page shows read-only RMAN job
      history; no other engine has any backup-related UI — ActMon does not take, schedule, or restore backups
      for any engine). This chapter states each engine's real capability rather than assuming parity.</li>
      <li>Almost none of the per-connection data endpoints check organization/tenant scoping — only each
      engine's connection <em>list</em> and <em>create</em> calls do. See
      <button onclick="go('dbm-permissions')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Permissions</button> for the verified specifics.</li>
      <li>A connection can be reached two ways — direct (SSH-polled or a plain network connection) or through an
      installed ActMon agent — and most of the module treats both identically once data has been collected. See
      <button onclick="go('dbm-connections')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Connections &amp; Collectors</button>.</li>
    </ul>
    <h2>How the Database module connects to other modules</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Database module shows</th><th>Also summarized in</th></tr>
      <tr><td>Total server/engine counts</td><td>Dashboard's Database Server tile, Engine Distribution and Servers By Technology charts (see <button onclick="go('db-database-mon')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Dashboard → Database Monitoring</button>)</td></tr>
      <tr><td>Host-level CPU/RAM/Disk (via the embedded Host Resources widget)</td><td>Infrastructure module (host detail page) — not yet documented</td></tr>
      <tr><td>Per-connection agent status</td><td>Agents module (see <button onclick="go('agt-database-monitoring')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Agents → Database Agent Monitoring</button>)</td></tr>
    </table></div>
  `
};

DOCS['dbm-navigation'] = {
  title:'Database Navigation', dek:'The chooser screen, per-technology routes, and how a server becomes a dashboard.',
  crumbs:['ActMon Documentation','Database','Database Navigation'], module:'Database', status:'Complete',
  body:`
    <h2>Route map</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Route</th><th>Renders</th></tr>
      <tr><td><code>/databases</code></td><td><code>DatabaseServersPage</code> with no <code>tech</code> prop — the "Choose Technology" chooser</td></tr>
      <tr><td><code>/mysql-servers</code>, <code>/postgresql-servers</code>, <code>/oracle-servers</code>, <code>/mssql-servers</code>, <code>/mongodb-servers</code>, <code>/clickhouse-servers</code></td><td>The same <code>DatabaseServersPage</code> with <code>tech="..."</code> — that technology's server list</td></tr>
      <tr><td><code>/cosmosdb-servers</code></td><td><code>CosmosDBConnectionsPage</code> — a separate component, not <code>DatabaseServersPage</code></td></tr>
      <tr><td><code>/databases/add-os-server</code></td><td><code>AddOsServerPage</code> — the server-registration wizard (see <button onclick="go('dbm-add-server')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Adding a Server</button>)</td></tr>
      <tr><td><code>/{tech}-dashboard/:id(/:tab)</code></td><td>That engine's own tabbed dashboard, once a connection exists</td></tr>
    </table></div>
    <h2>Chooser screen (<code>/databases</code>)</h2>
    <p>A grid of technology tiles (one per engine the caller's role can see — gated by <code>can('/{tech}-servers','view')</code>), each showing a live server count and connection count for that engine, and a global summary strip below it with four counts pulled from the OS-server summary endpoint: <strong>Total Servers</strong>, <strong>Online</strong>, <strong>Warning</strong>, and <strong>HA Clusters</strong> — these four are fleet-wide, not per-engine. A separate "Cloud-Based Databases" section below that lists Cosmos DB (live, clickable) alongside eight disabled "Coming Soon" tiles.</p>
    <h2>Per-technology server list (<code>/{tech}-servers</code>)</h2>
    <p>Selecting a tile (or a tech-switcher pill on another engine's own list) navigates here. Full layout — KPI
    cards, environment pills, tech switcher, grid/list toggle, cluster topology, standalone table — is
    documented in <button onclick="go('dbm-server-list')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Server List &amp; Topology</button>.</p>
    <h2>From a server row to a dashboard</h2>
    <p>Clicking a server row (or its dashboard/diagnose/connect action icon) computes one of three destinations,
    depending on what already exists for that row:</p>
    <div class="tblwrap"><table class="doc navmatrix">
      <tr><th>State</th><th>Icon/label shown</th><th>Destination</th></tr>
      <tr><td>No connection linked to this server at all</td><td>"Connect" (Plus icon)</td><td><code>/connections/add?type=...&amp;host=...&amp;port=...&amp;name=...</code></td></tr>
      <tr><td>A connection exists, but the database is not currently up</td><td>"Diagnose" (Stethoscope icon)</td><td><code>/diagnose/{connectionId}</code></td></tr>
      <tr><td>A connection exists and the database is up</td><td>"Dashboard" (Activity icon)</td><td><code>/{tech}-dashboard/{connectionId}</code></td></tr>
    </table></div>
    <p>Breadcrumbs: the per-tech list's header has a "← Technologies" action back to <code>/databases</code>; the
    chooser screen itself is a top-level page with no back action.</p>
  `
};

DOCS['dbm-server-list'] = {
  title:'Server List & Topology', dek:'KPI cards, filters, cluster topology, and the standalone-servers table.',
  crumbs:['ActMon Documentation','Database','Server List & Topology'], module:'Database', status:'Complete',
  body:`
    <h2>KPI cards</h2>
    <p>Five cards, computed <strong>client-side</strong> from servers matching the current technology only (not
    from the fleet-wide summary endpoint the chooser screen uses):</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Card</th><th>Counts</th><th>Clickable</th></tr>
      <tr><td>Total</td><td>Every server matching this technology</td><td>No (clears the status filter)</td></tr>
      <tr><td>Online</td><td>Status = Connected</td><td>Yes — toggles a status filter over the lists below</td></tr>
      <tr><td>Warning</td><td>Status = Warning</td><td>Yes</td></tr>
      <tr><td>Offline</td><td>Neither Connected nor Warning</td><td>Yes</td></tr>
      <tr><td>Clusters</td><td>Distinct <code>cluster_name</code> values among servers whose <code>node_type</code> is not Standalone</td><td>Yes</td></tr>
    </table></div>
    <p>Clicking a non-Total card shows a "Filtered by X · N of M" indicator with a Clear link.</p>
    <h2>Filters and view controls</h2>
    <ul>
      <li><strong>Environment pills</strong> — <code>All, Production, UAT, Development, Testing</code> — selecting one re-fetches the server list filtered server-side.</li>
      <li><strong>Tech-switcher pills</strong> — one per engine the role can see; clicking navigates straight to that engine's own list.</li>
      <li><strong>Search</strong> — client-side, matches server name or IP address.</li>
      <li><strong>Grid/List toggle</strong> — Grid (default) shows topology cards; List shows the table described below. Both read the same filtered data.</li>
    </ul>
    <h2>Clusters vs. standalone</h2>
    <p>A server is grouped under "Cluster Topology" only when <strong>both</strong> are true: its
    <code>node_type</code> is something other than <code>Standalone</code> (one of Primary, Secondary, Master,
    Slave, Galera Node, Arbiter, Cluster Node), <strong>and</strong> it has a non-empty <code>cluster_name</code>.
    A server with a non-Standalone role but no cluster name is still listed under Standalone Servers — role alone
    does not move it out. Each cluster card shows environment, node count, DB-type badges, average CPU/RAM/Disk
    across its nodes, and a status pill: <span class="pill good">HEALTHY</span> if every node is Connected,
    <span class="pill warn">WARNING</span> if any node is Warning, else <span class="pill crit">DEGRADED</span>.
    A cluster containing any Galera-role node renders as a multi-primary ring topology; otherwise it renders as
    a Primary→Secondary streaming-replication chain.</p>
    <h2>Standalone Servers table</h2>
    <p>Columns: <strong>Server</strong> (connection name + initials avatar), <strong>Host / OS</strong> (IP + OS
    badge), <strong>OS Status</strong>, <strong>DB Status</strong> (Running/Stopped/Degraded/Unknown), <strong>Resources</strong>
    (CPU/RAM/Disk mini progress bars), <strong>Uptime</strong>, <strong>Actions</strong>.</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Action icon</th><th>What it does</th></tr>
      <tr><td>Dashboard / Diagnose / Connect</td><td>Same destination logic as clicking the row — see <button onclick="go('dbm-navigation')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Database Navigation</button></td></tr>
      <tr><td>SSH (Terminal icon)</td><td>Opens a real, interactive browser terminal — a WebSocket PTY session to the host over its stored SSH credentials (backend: <code>paramiko.invoke_shell</code> via <code>/api/v1/terminal/ws/{serverId}</code>)</td></tr>
      <tr><td>Refresh</td><td>"Deep refresh (SSH)" — opens a live SSH session, runs <code>top</code>/<code>free</code>/<code>df</code>/<code>uptime</code> and a per-service <code>systemctl is-active</code> check, and writes the resulting CPU/RAM/Disk/uptime and each database instance's Running/Stopped status back to the row</td></tr>
      <tr><td>Delete (Trash icon)</td><td>Confirms, then deletes the server row and any linked connection records — see <button onclick="go('dbm-reference')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Database Reference</button> for the exact endpoint</td></tr>
    </table></div>
    <p>None of these four action icons (Dashboard/Diagnose/Connect, SSH, Refresh, Delete) is gated by a
    permission check in the reviewed code — only the header's "Add Server" button and the empty state's "+ Add
    OS Server" button check <code>canHere('add')</code>.</p>
    <h2>Empty state</h2>
    <p>Zero servers for this technology (or zero matching an active search) shows an explanatory message and,
    when not searching and the caller can add, a "+ Add OS Server" button.</p>
  `
};

DOCS['dbm-add-server'] = {
  title:'Adding a Server', dek:'The AddOsServerPage wizard — SSH vs. Agent, and what gets created.',
  crumbs:['ActMon Documentation','Database','Adding a Server'], module:'Database', status:'Complete',
  body:`
    <h2>Entry point</h2>
    <p>"Add Server" (chooser screen and every per-tech list) and "+ Add OS Server" (empty state) all navigate to
    <code>/databases/add-os-server</code>, gated by <code>canHere('add')</code>. Closing the wizard at any point
    (header "×" or footer Cancel) always returns to <code>/databases</code> without saving anything.</p>
    <h2>Step 1 — Connection method</h2>
    <p>A choice between <strong>Connect via SSH</strong> ("ActMon polls the host over SSH. No install — just
    credentials," the default) and <strong>Connect via Agent</strong> ("Install a lightweight agent that pushes
    the same metrics").</p>
    <div class="note"><b>The Agent path creates nothing here</b>${icon('book',14)}<span>Choosing Agent and clicking
    Next hands off immediately to <code>/databases/add-data</code> (the existing agent Setup catalogue) — this
    wizard itself never creates a server or connection for the agent path.</span></div>
    <h2>Steps 2–7 (SSH path)</h2>
    <p>Staying on SSH proceeds through: <strong>Operating System</strong> (Linux, Ubuntu, Windows, CentOS, Oracle
    Linux, RedHat) → <strong>Server Identity</strong> (server name, IP, optional hostname, environment — Production/UAT/Development/Testing) →
    <strong>SSH Access</strong> (username, port default 22, password, an optional "Test SSH Connection" button
    that performs a real paramiko connect + <code>echo ACTMON_OK</code> — testing is not required to proceed) →
    <strong>Node Role</strong> (Standalone or one of Primary/Secondary/Master/Slave/Galera Node/Arbiter/Cluster
    Node; anything but Standalone requires a cluster name, offered as pills from existing cluster names already
    in use) → <strong>Services</strong> (multi-select which database engines run on this host, plus two toggles:
    Live Monitoring and Auto Discovery, both on by default) → <strong>Review</strong> (read-only summary).</p>
    <h2>On submit</h2>
    <p>Creates one server row (status starts <code>Unknown</code>) and one database-instance row per selected
    service (also status <code>Unknown</code>, port defaulted from a built-in per-engine default-port map). If
    the Agent path had been chosen this step would also mint an agent enrollment token; for SSH,
    <code>agent_token</code> stays empty. On success the page shows "Server registered successfully! Redirecting…"
    and, after ~1.2s, navigates to the server-list route for the <strong>first</strong> database service that was
    selected (or back to <code>/databases</code> if none were selected).</p>
  `
};

DOCS['dbm-connections'] = {
  title:'Connections & Collectors', dek:'SSH vs. Agent, the collector abstraction, and how a connection actually gets created.',
  crumbs:['ActMon Documentation','Database','Connections & Collectors'], module:'Database', status:'Complete',
  body:`
    <h2>Two collector paths, one abstraction</h2>
    <p>Every database connection reaches ActMon either <strong>directly</strong> (a plain network connection, or
    an SSH-polled host) or through an <strong>installed ActMon agent</strong> running on that host. A shared
    backend layer, the collector proxy, makes both paths look identical to the rest of the code: it resolves
    whether a given connection's host has an enrolled agent, and if so builds a SQLAlchemy-engine-shaped shim
    that actually routes queries through that agent instead of connecting directly — so the large majority of
    dashboard code that does "get an engine, run a query" works unchanged either way. For MySQL and PostgreSQL,
    the proxy can also fall back to a direct connection if the agent doesn't answer; for Oracle and MSSQL it
    never silently falls back to direct (it raises an explicit "the agent did not answer in time" error instead),
    since the server generally cannot reach those engines directly.</p>
    <h2>Two ways a connection is actually created</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Path</th><th>Entry point</th><th>What happens</th></tr>
      <tr><td><strong>Manual / direct</strong></td><td>Each engine's own "Add Data Source" connection form</td><td>Tests connectivity immediately (a real <code>SELECT 1</code>), then inserts a connection row tagged as standard registration. <strong>No agent enrollment happens on this path</strong> — the connection is only ever queried directly, never through the collector proxy's agent branch.</td></tr>
      <tr><td><strong>Agent-based</strong></td><td>The Agent Setup wizard (<code>/agents/setup/:tech</code>, reached from Add Server → Connect via Agent, or the Agents module directly)</td><td>Creates/refreshes the connection row tagged as agent registration <strong>and</strong> automatically registers the matching per-connection agent row in the same call — this is what lets the agent fleet start polling that database's status at all.</td></tr>
    </table></div>
    <div class="warnbox"><b>A real, previously-fixed bug this design guards against</b>${icon('alerts',14)}<span>
    The application's own code comments document that a database instance's status was once set only at creation
    time (always "Running") and never updated again, because the per-connection agent row that
    <code>agent_collector_service.py</code> needs to start polling was missing. The agent-based creation path now
    explicitly creates that row in the same request specifically to prevent this from recurring.</span></div>
    <h2>Required fields (manual path)</h2>
    <p>Every engine's connection form shares four required fields — connection name, host, port, username,
    password, database name — plus a few engine-specific additions: Oracle accepts an optional service
    name/SID/TNS descriptor; PostgreSQL an optional SSL mode (default "prefer"); MSSQL optional Windows
    Authentication/instance name; MongoDB optional protocol/auth source/replica set; ClickHouse an optional
    protocol. Cosmos DB's form is entirely different — no host/port at all, instead an account endpoint, a
    primary key, a database name, and a container name (see
    <button onclick="go('dbm-cosmosdb')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Cosmos DB</button>).</p>
    <h2>Linking a discovered instance to a connection</h2>
    <p>When a server was registered first (via Add Server) and a connection is created separately afterward, a
    dedicated endpoint links the two — this is the manual glue step between a discovered
    <code>DatabaseInstance</code> row and the <code>ConnectionMaster</code> row a dashboard actually reads from.</p>
  `
};

DOCS['dbm-mysql'] = {
  title:'MySQL Dashboard', dek:'The MySQL dashboard\'s 11 tabs, Overview content, and what each sub-page adds.',
  crumbs:['ActMon Documentation','Database','MySQL Dashboard'], module:'Database', status:'Complete',
  body:`
    <h2>Route and tabs</h2>
    <p><code>/mysql-dashboard/:id</code> (Overview) and <code>/mysql-dashboard/:id/:tab</code> for the other tabs,
    which are URL-driven, not local state. Exactly 10 tabs:
    <strong>Overview, Performance, Queries, Databases, Tables, Locks, Replication, Users, Storage, Logs</strong>.
    Four further pages have their own dedicated routes rather than being tabs: <code>/slow-queries</code>,
    <code>/error-logs</code>, <code>/error-analysis</code>, <code>/self-heal</code>, <code>/index-analysis</code>,
    <code>/reports</code>.</p>
    <h2>Overview tab</h2>
    <p>An 8-tile KPI strip (Uptime, Version, Databases, Tables, DB Size, Questions, Connections, Slow Queries —
    every tile except Uptime/Version links to its related tab), the shared Host Resources panel, status badges
    (connection %, cache-hit %, storage engine, replication state, binlog format, long-running/lock-contention
    warnings), four semi-circle gauges, in-memory sparklines built from the last ~20 polls (not historical
    data), two charts (cumulative statement-type counts; database sizes), three detail panels (Server
    Information, InnoDB Buffer Pool, Threads &amp; Network), a conditional long-running-query alert, and five
    quick-action cards to the sub-pages below.</p>
    <div class="note"><b>Diagnosis fallback</b>${icon('alerts',14)}<span>If the dashboard's data call errors or
    returns an error status, the whole tab UI is replaced by a diagnosis screen: the raw error, a heuristic
    "possible causes" list keyed to the MySQL error code, a live error-log feed, and quick links to Error Logs,
    Self-Heal, Slow Queries, and Index Analysis.</span></div>
    <h2>Slow Queries</h2>
    <p>The same shared 4-tab page every engine uses (Overview, Query Explorer, AI Analysis, Reports) — a row click
    opens the shared detail page, same as every other engine. Full cross-engine slow-query pattern, including the
    AI/EXPLAIN feature, in
    <button onclick="go('dbm-slow-queries')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Slow Queries &amp; Query Analysis</button>.</p>
    <h2>Error Logs, Error Analysis, and Self-Heal</h2>
    <p><code>ErrorLogs.jsx</code> is the full-featured page (Error Logs / AI Analysis / Self-Heal / Reports
    internal tabs, including a live SSH terminal that streams AI-suggested or user-typed remediation commands).
    <code>ErrorAnalysis.jsx</code> is a separate, much smaller "paste any error text, get an AI opinion" utility
    that is <strong>not linked from the dashboard's own tabs or quick-actions</strong> — it exists at its own
    route but isn't reachable through the dashboard UI. The dedicated <code>MySQLSelfHeal.jsx</code> page is a
    third, distinct surface again — full detail (including a real gap between its UI and what the backend
    actually executes) in
    <button onclick="go('dbm-error-logs')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Error Logs &amp; Self-Heal</button>.</p>
    <h2>Index Analysis</h2>
    <p>Five tabs — Unused Indexes, Duplicate Indexes, Missing Index Hints, Full-Scan Queries, All Indexes — each
    with a count badge and a health-score ring. Every recommendation is a copyable SQL statement (<code>DROP</code>
    or a suggested index template); <strong>nothing on this page executes DDL</strong>. Unused/duplicate/missing-hint
    detection requires <code>performance_schema = ON</code>; when it's off, the page explains exactly what's
    unavailable and shows the config line and restart command needed. "All Indexes" works regardless, since it
    reads from <code>information_schema</code>.</p>
    <h2>Reports</h2>
    <p>A single-page report assembled from ten parallel endpoint calls, exportable as a client-captured PDF (and
    optionally emailed/scheduled) — CSV export is <strong>not</strong> on this page, it lives on Slow Queries and
    Error Logs instead. See <button onclick="go('dbm-reports')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Reports</button>.</p>
  `
};

DOCS['dbm-postgresql'] = {
  title:'PostgreSQL Dashboard', dek:'The PostgreSQL dashboard\'s 11 tabs and how its Query Analysis detail page works.',
  crumbs:['ActMon Documentation','Database','PostgreSQL Dashboard'], module:'Database', status:'Complete',
  body:`
    <h2>Route and tabs</h2>
    <p><code>/postgresql-dashboard/:id</code> and <code>/:tab</code>, URL-driven. Exactly 10 tabs:
    <strong>Overview, Performance, Queries, Databases, Tables, Locks, Replication, Users, Storage, Config</strong>.
    Dedicated sibling pages exist for <code>/slow-queries</code> (plus its own
    <code>/slow-queries/detail</code> — see below), <code>/error-logs</code>, <code>/index-analysis</code>,
    <code>/reports</code>.</p>
    <h2>Overview tab</h2>
    <p>Same overall shape as MySQL's Overview (8 KPI tiles, embedded Host Resources, status badges, four gauges,
    sparklines, two charts, three detail panels, a long-running-query alert, five quick-action cards) with
    PostgreSQL-specific content: a Replication badge (<code>STANDALONE</code> or "N replica(s)"), an "Autovacuum
    DISABLED" warning when applicable, and its own health-score formula (connection %, cache-hit %,
    long-running-query count — no replication/lock penalty in this particular score).</p>
    <h2>Replication tab</h2>
    <p>Role (Primary/Standby), topology, per-standby byte/time lag with color-coded severity, replication slots,
    WAL senders, publications/subscriptions, conflicts, and recovery state.</p>
    <h2>Slow Queries and its detail page</h2>
    <p>PostgreSQL was the reference implementation the shared Slow Queries page was built to match — every engine
    now shares the exact same list and detail page. Clicking a row in the Query Explorer navigates to the shared
    detail page (passing the row via router state); its execution-plan step runs a real
    <code>EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)</code> against the live connection, and its AI step returns a
    severity rating plus a structured summary. A stable per-digest query id also lets this page recover the query
    on a direct link or reload, not only when opened from the list. Full cross-engine detail (filters, columns,
    the "ActMon internal query" exclusion filter) in
    <button onclick="go('dbm-slow-queries')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Slow Queries &amp; Query Analysis</button>.</p>
    <h2>Error Logs</h2>
    <p>Severity buckets FATAL/ERROR/WARNING/LOG/INFO/DEBUG. The response names its own source —
    <code>csv_log</code>, <code>stderr_log</code>, or a <code>pg_stat_activity</code> fallback that only reflects
    live sessions, not real historical errors — and the UI shows a setup guide (enable
    <code>log_destination='csvlog'</code>) whenever it's stuck on that fallback with nothing to show. Per-row AI
    analysis is explicitly labeled "PostgreSQL 17 · Error Intelligence."</p>
    <h2>Index Analysis</h2>
    <p>Four tabs: Unused Indexes, All Indexes, Bloated Tables (dead-tuple % with a copyable <code>VACUUM
    ANALYZE</code>), and pg_stat_statements. As with MySQL, every action here produces copyable SQL — nothing
    executes automatically.</p>
    <h2>Host Resources drill-down</h2>
    <p>PostgreSQL's Overview embeds the shared <code>HostResources</code> widget (also reused, unmodified, by
    every other engine's dashboard) — its 4-level process→session→query drill-down and history view are
    documented once, in
    <button onclick="go('dbm-drilldown-diagnose')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Resource Drill-Down &amp; Diagnose</button>, rather than repeated per engine.</p>
  `
};

DOCS['dbm-oracle'] = {
  title:'Oracle Dashboard', dek:'16 independently-polled tabs, Live Queries, and Oracle\'s read-only RMAN reporting.',
  crumbs:['ActMon Documentation','Database','Oracle Dashboard'], module:'Database', status:'Complete',
  body:`
    <h2>Route and tabs</h2>
    <p><code>/oracle-dashboard/:id</code> and <code>/:tab</code>. Exactly <strong>16</strong> tabs — the most of
    any engine: <strong>Overview, Performance, Sessions, Top SQL, Tablespaces, Objects, Tables, Data Guard,
    Redo Logs, Processes, Users, Sys Stats, Slow SQL, Live Queries, Locks, Parameters</strong>. Architecturally
    distinctive: each tab fires its <strong>own</strong> backend query, enabled only while that tab is active —
    unlike MySQL/PostgreSQL/MSSQL, which fetch one large payload up front and derive every tab from it. Dedicated
    sibling routes exist for <code>/live-queries</code>, <code>/slow-queries</code>, <code>/error-logs</code>,
    <code>/index-analysis</code>, <code>/reports</code>.</p>
    <h2>Overview tab</h2>
    <p>8 metric tiles (Instance, Database, Status, Sessions, Host CPU, SGA, PGA, Database size), the shared Host
    Resources panel, status pills, a tablespace-fullness warning (any tablespace over 85%), two charts
    (utilisation ratios; top wait events by seconds), three in-memory trend panels, three key/value panels
    (Instance, Database, Memory), and a "Top SQL by elapsed time" preview linking to the full Top SQL tab.</p>
    <h2>Data Guard and Redo Logs</h2>
    <p>Data Guard is its own tab: archive destination status, standby redo logs, and Data Guard status messages
    — with an explicit "Not configured" empty state when no standby destination exists (most single-instance
    Oracle connections will see this). Redo Logs shows log groups/members with a warning when any group has
    fewer than 2 members.</p>
    <h2>Live Queries</h2>
    <p>A genuinely real-time active-session view (polls every 5 seconds — deliberately faster than the
    dashboard's own 15s, "the view someone opens when the database is misbehaving"): SID, user, status, client,
    what it's waiting on and for how long (color-banded), the statement, and — fetched on demand per SQL ID and
    cached — its execution plan. A summary row up top (Sessions/Active/Idle/Waiting/Blocked/Longest wait) and a
    blocked-session callout.</p>
    <h2>Slow SQL</h2>
    <p>Ranked by <strong>average</strong> elapsed time per execution (total-elapsed ranking lives on the separate
    Top SQL tab instead). Uses the same shared Slow Queries list and detail page every engine does — a row click
    opens the detail page, whose execution-plan step re-runs the existing <code>v$sql_plan</code> lookup by
    <code>sql_id</code> rather than a new Oracle-specific endpoint. See
    <button onclick="go('dbm-slow-queries')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Slow Queries &amp; Query Analysis</button> for how this compares across engines.</p>
    <h2>RMAN reporting — read-only</h2>
    <div class="warnbox"><b>No backup-execution surface for Oracle — or for any engine</b>${icon('alerts',14)}<span>Oracle's only
    backup-related feature is a read-only RMAN section inside the Reports page (job/failure counts, last full
    backup) — there is no dashboard tab and no UI anywhere that takes, schedules, or restores an Oracle backup.
    ActMon does not take, schedule, or restore backups for any of the seven engines.</span></div>
    <h2>Reports — 20 sections, one conditional</h2>
    <p>Twenty report sections built from 21 parallel endpoint calls. One section — EBS (E-Business Suite)
    workflow and concurrent-manager status — only renders if the connection's own data reports
    <code>is_ebs: true</code>; a non-EBS Oracle instance shows no EBS content at all.</p>
    <h2>Index Analysis and error logs</h2>
    <p>Index fragmentation here is explicitly a <em>proxy</em> (derived from B-tree level, not a direct
    measurement), with copyable <code>ANALYZE INDEX … VALIDATE STRUCTURE</code> and <code>ALTER INDEX … REBUILD
    ONLINE</code> statements. Error Logs reads the alert log and, if inaccessible, falls back to redo-log
    metadata — but refuses to present that fallback as if it were real alert data, showing zero entries plus an
    explanation instead.</p>
  `
};

DOCS['dbm-mssql'] = {
  title:'SQL Server (MSSQL) Dashboard', dek:'9 tabs and a real detail page for slow queries.',
  crumbs:['ActMon Documentation','Database','SQL Server (MSSQL) Dashboard'], module:'Database', status:'Complete',
  body:`
    <h2>Route and tabs</h2>
    <p><code>/mssql-dashboard/:id</code> and <code>/:tab</code>. Exactly 9 tabs:
    <strong>Overview, Performance, Queries, Databases, Tables, Locks, Replication, Logins, Storage</strong>.
    Like MySQL/PostgreSQL, the whole dashboard is derived client-side from one payload call
    (<code>monitoring-dashboard</code>) rather than Oracle's per-tab-query approach. Dedicated sibling routes:
    <code>/slow-queries</code>, its own <code>/slow-queries/detail</code>, <code>/error-logs</code>,
    <code>/index-analysis</code>, <code>/reports</code>.</p>
    <h2>Overview tab</h2>
    <p>8 metric tiles (Version/Edition, Uptime, Databases, Active sessions, Buffer cache %, Host/SQL CPU %, Wait
    types count, Disk footprint), Host Resources, status pills (connection/buffer/CPU/memory %, blocking-chain
    count, AlwaysOn/replication state), two charts (utilisation; top wait types from
    <code>sys.dm_os_wait_stats</code>), three trend panels, three key/value panels (Server, Memory, Throughput),
    and a blocking-chain warning when any exists.</p>
    <h2>Slow Queries → the shared detail page</h2>
    <p>Clicking a row here <strong>navigates</strong> to <code>/mssql-dashboard/:id/slow-queries/detail</code> —
    the same shared detail page every engine opens into, on the reasoning MSSQL's own page originated: "the
    per-query work (parse the tables, read each one's indexes, then ask the model) needs more room than a table
    row, and it should be linkable." Real execution-plan XML retrieval is a disclosed follow-up here — this
    engine's plan step says so rather than faking one. Full cross-engine comparison in
    <button onclick="go('dbm-slow-queries')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Slow Queries &amp; Query Analysis</button>.</p>
    <h2>Error Logs and self-heal</h2>
    <p>Reads <code>xp_readerrorlog</code> (falls back to <code>sys.messages</code>, with an explicit warning that
    the fallback is a message catalogue, not this server's actual log). Selecting a row opens a drawer offering
    permission-gated diagnostic and remediation <strong>T-SQL commands</strong> — each is classified
    safe/caution/dangerous, and a write/DDL command is refused if the connected login lacks the SQL Server
    privilege it needs (sysadmin/securityadmin/ALTER ANY LOGIN). Full detail in
    <button onclick="go('dbm-error-logs')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Error Logs &amp; Self-Heal</button>.</p>
    <h2>Replication / AlwaysOn</h2>
    <p>Shows AlwaysOn availability groups (name, role, synchronization health) when configured, falling back to a
    "STANDALONE" label plus a snapshot-replication participants table otherwise.</p>
    <div class="note"><b>No backup surface</b>${icon('book',14)}<span>ActMon does not take, schedule, or restore
    backups for MSSQL — there is no backup-related tab or page on this dashboard.</span></div>
  `
};

DOCS['dbm-mongodb'] = {
  title:'MongoDB Dashboard', dek:'Operations, not queries — 13 tabs and sharding.',
  crumbs:['ActMon Documentation','Database','MongoDB Dashboard'], module:'Database', status:'Complete',
  body:`
    <h2>Route and tabs</h2>
    <p><code>/mongodb-dashboard/:id</code> and <code>/:tab</code>. 13 tabs:
    <strong>Overview, Operations, Profiler, Collections, Indexes, Replication, Oplog, Sharding, Transactions,
    WiredTiger, Users, Slow Queries, Error Logs</strong>. The last two are <em>also</em> reachable as their own
    dedicated routes (<code>/slow-queries</code>, <code>/error-logs</code>) — the standalone pages and the
    embedded dashboard tabs are separate components covering the same data. The dedicated route moved from
    <code>/slow-operations</code> to <code>/slow-queries</code> to match every other engine (an old bookmark to
    <code>/slow-operations</code> still redirects).</p>
    <div class="note"><b>MongoDB reports individual operations, not aggregated statistics</b>${icon('book',14)}<span>
    <code>currentOp</code>/<code>system.profile</code> have no query-digest concept — each row on the shared
    Slow Queries page is one observed operation, so its duration is that single operation's time, not a running
    average. The page labels this explicitly rather than presenting a one-off value as an aggregate.</span></div>
    <h2>Overview tab</h2>
    <p>KPI strip (Version, Uptime, Databases, Collections, Connections, Memory, a Replication State badge —
    PRIMARY/SECONDARY/STANDALONE, Total Ops), Host Resources, four gauges (connection %, WiredTiger cache used
    %, op rate, WT cache hit %), sparklines, an opcounters chart plus a paged databases table, three info panels
    (Server Information — including replica-set name and state — Memory &amp; WiredTiger Cache, Network &amp;
    Global Lock), and quick-access cards to Slow Queries/Collection Analysis/Error Logs.</p>
    <h2>Replication and Sharding — separate tabs, not part of Overview</h2>
    <p>Replication shows the full replica-set member table (host, state, health, uptime, optime, lag, priority,
    votes) with a per-secondary lag chart, or an explicit "no replica set detected" state on a standalone
    instance. Sharding, likewise its own tab, shows shard count/sharded-DB count/balancer mode/config
    servers/per-shard chunk distribution when sharding is enabled, or a plain "not running as a sharded cluster"
    message when it isn't.</p>
    <h2>Slow Queries (operations)</h2>
    <p>Merges <code>db.currentOp()</code> (live) with <code>system.profile</code> (profiler) results, normalized
    into the same common row shape every engine uses. A row click navigates to the shared detail page, same as
    every other engine — its execution-plan step runs a real <code>explain("executionStats")</code> against the
    operation's own filter and namespace (not just the <code>planSummary</code> string it used to show). Because
    MongoDB has no per-query id, a direct link or reload to the detail page can't recover a specific past
    operation — only opening it fresh from the list works, and the page says so. Full cross-engine comparison in
    <button onclick="go('dbm-slow-queries')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Slow Queries &amp; Query Analysis</button>.</p>
    <h2>Collection Analysis (there is no separate Index Analysis page)</h2>
    <p>MongoDB has no standalone "Index Analysis" file — index browsing is a tab inside
    <code>CollectionAnalysis.jsx</code>, alongside a Collections tab (size/document-count leaderboards, a full
    filterable collection table) and an Insights tab (rollup metrics, a high-scan-ratio collection list, and
    static best-practice recommendations — no live "apply this fix" action).</p>
    <div class="note"><b>No backup surface</b>${icon('book',14)}<span>ActMon does not take, schedule, or restore
    backups for MongoDB — there is no backup-related tab or page on this dashboard.</span></div>
  `
};

DOCS['dbm-clickhouse'] = {
  title:'ClickHouse Dashboard', dek:'Part pressure, merges, and compression — the 12-tab dashboard for a columnar store.',
  crumbs:['ActMon Documentation','Database','ClickHouse Dashboard'], module:'Database', status:'Complete',
  body:`
    <h2>Route and tabs</h2>
    <p><code>/clickhouse-dashboard/:id</code> and <code>/:tab</code>. 12 tabs, each backed by its own
    <code>system.*</code> table read: <strong>Overview, Running, Query Log, Slow Queries, Databases, Tables,
    Partitions, Merges, Replicas, Clusters, System Metrics, Settings</strong>. Slow Queries and Error Logs also
    exist as separate dedicated routes (<code>/slow-queries</code>, <code>/error-logs</code>), plus a third
    dedicated route, <code>/table-analysis</code>.</p>
    <h2>Overview tab — part pressure is the headline concern</h2>
    <p>8 metric tiles include a distinctive one for this engine: <strong>Parts / partition</strong>
    (<code>max_part_count_for_partition</code>), with the explanation "ClickHouse stops accepting inserts into a
    partition once it has too many parts." When part pressure exceeds 60% of a configurable threshold (default
    3000), a warning notice about <code>TOO_MANY_PARTS</code> appears. Status pills cover parts % of limit,
    memory %, disk %, cumulative failed queries, replication delay, and running-merges count; charts cover part
    pressure/memory/disk utilisation and per-database space usage.</p>
    <h2>Table Analysis — the distinctive, ClickHouse-specific page</h2>
    <p>Five tabs, all oriented around the one number that becomes an outage: <strong>Part pressure</strong>
    (per-table active-part count against the warning threshold, with a Healthy/High/"Inserts at risk" verdict),
    <strong>Parts</strong> (the 200 largest active parts — explicitly capped, not a server total),
    <strong>Merges</strong> (running merges, progress %, rows read/written/collapsed, with a warning above 15
    concurrent merges), <strong>Table stats</strong> (rows/size/bytes-per-row per MergeTree table), and
    <strong>Compression</strong> (uncompressed vs. compressed size, % saved, ratio badge per table).</p>
    <h2>Query Log, Running, and Slow Queries</h2>
    <p>Query Log and the dedicated Slow Queries page both read from <code>system.query_log</code>; both apply the
    same ActMon-internal-query exclusion filter used across every SQL-based engine (see
    <button onclick="go('dbm-slow-queries')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Slow Queries &amp; Query Analysis</button>), so ActMon's own bookkeeping queries against this
    same ClickHouse instance never appear in either list.</p>
    <h2>No backup surface</h2>
    <p>ClickHouse has no Backup tab and no backup-related page anywhere in the Database module — ActMon does not
    take, schedule, or restore backups for any of the seven engines.</p>
  `
};

DOCS['dbm-cosmosdb'] = {
  title:'Cosmos DB', dek:'The one engine that is billed per call — why its dashboard polls almost nothing on a timer.',
  crumbs:['ActMon Documentation','Database','Cosmos DB'], module:'Database', status:'Complete',
  body:`
    <h2>A different connection model from the other six</h2>
    <p>Cosmos DB does not go through <code>DatabaseServersPage.jsx</code>, the shared server list, or the
    OS-agent Setup wizard at all — none of those model "an account endpoint, a key, and a default
    database/container" the way they model a host/port. It has its own connections list
    (<code>/cosmosdb-servers</code> → <code>CosmosDBConnectionsPage.jsx</code>) and its own edit page
    (<code>/cosmosdb-edit/:id</code>), whose form fields (endpoint, primary key, database, container, API type,
    preferred region, consistency level, etc.) are driven entirely from a dedicated field catalogue rather than
    the host/port form every other engine shares. One documented quirk: the API never returns a saved key back to
    the edit form, so the key field always loads blank — leaving it blank on save means "keep what is stored,"
    not "clear the key."</p>
    <h2>Why the dashboard polls almost nothing</h2>
    <div class="warnbox"><b>Every read against a live Cosmos account costs money</b>${icon('alerts',14)}<span>The
    dashboard's own code comment states this directly: Cosmos exposes no free, <code>system.*</code>-style
    metrics tier the way the other six engines do — every figure shown is a real Azure API call, billed in
    Request Units. Consequently, nothing on this dashboard polls the live account on an interval except one
    endpoint that reads back ActMon's own log of calls it has already made (refreshed every 30s) — that one is
    free because it never touches Cosmos itself.</span></div>
    <h2>Route and tabs</h2>
    <p><code>/cosmosdb-dashboard/:id</code> and <code>/:tab</code>. 8 tabs: <strong>Overview, Databases,
    Containers, Documents, Indexing, Slow Calls, Errors, ActMon AI</strong>.</p>
    <h2>Overview tab</h2>
    <p>An explicit notice that its trend charts reflect "ActMon's own calls, not your application's traffic";
    6 metric tiles (calls logged, avg response, last RU charge, slow calls, errors, throttled 429s), a
    throttling notice when 429s occurred, four charts, a container-facts panel (partition key, throughput,
    storage, document count, index size, TTL, indexing mode, consistency), and a Partitioning panel that
    explicitly labels data it genuinely cannot show without Azure Monitor rather than omitting it silently.</p>
    <h2>Documents, Indexing, Slow Calls, Errors</h2>
    <p>Documents browses via Cosmos's own continuation-token paging (not page numbers, since Cosmos doesn't
    support offset paging cheaply) and clearly marks a free-text WHERE-clause filter and an exact cross-partition
    count as separately billed actions requiring an explicit click. Indexing shows the indexing policy with
    "buys you / costs you" tradeoffs per path type, plus an AI analysis. Slow Calls and Errors are both driven
    from the same ActMon call-log data as the Overview's Activity feed, not native Cosmos telemetry.</p>
    <h2>No backup surface, and no clear add-connection path confirmed</h2>
    <p>Like ClickHouse, there is no backup UI for Cosmos DB anywhere in the module. Separately: the connections
    page's own "Add connection" button currently points at the generic agent Setup catalogue, whose technology
    list does not include Cosmos DB — only the <strong>edit</strong> flow for an already-existing Cosmos
    connection is clearly implemented in the reviewed frontend code.</p>
  `
};

DOCS['dbm-slow-queries'] = {
  title:'Slow Queries & Query Analysis', dek:'One shared page for every engine — how the backend normalizes six different collectors into a common shape, and what each engine honestly can\'t provide.',
  crumbs:['ActMon Documentation','Database','Slow Queries & Query Analysis'], module:'Database', status:'Complete',
  body:`
    <h2>One shared page, not six</h2>
    <p>Every engine's Slow Queries page — MySQL, PostgreSQL, MSSQL, Oracle, ClickHouse, MongoDB — renders through
    the same two components (<code>frontend/src/pages/_shared/SlowQueriesPage.jsx</code> and
    <code>SlowQueryDetailPage.jsx</code>), the same way <code>DatabaseServersPage</code> already serves every
    engine's server list off one <code>tech</code> prop. Layout, tabs, filters, columns, severity thresholds and
    states are identical everywhere; only the collection mechanism underneath differs per engine, and that
    difference is deliberately invisible to the page itself.</p>
    <h2>Four tabs, every engine</h2>
    <p><strong>Overview</strong> — KPI strip, a slowest-12 bar chart, a by-user pie chart (where the engine reports
    a user), and hotspot cards (slowest / most executed / most rows). <strong>Query Explorer</strong> — the full
    filterable, sortable list; a row opens <strong>Detail</strong>, a separate page with the query's cost, its
    native execution plan, and AI analysis. <strong>AI Analysis</strong> — pick from the worst 5 queries and run
    ActMon's AI on any of them, independent of the detail page. <strong>Reports</strong> — a KPI summary plus a
    client-side CSV export (built from already-fetched rows, not a backend report — PDF export is a different
    feature, see <button onclick="go('dbm-reports')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Reports</button>).</p>
    <h2>A common row shape, normalized server-side</h2>
    <p>Each engine's own service (<code>pg_stat_statements</code> for PostgreSQL, <code>performance_schema</code>/
    slow log for MySQL, <code>sys.dm_exec_query_stats</code> for MSSQL, <code>v$sqlarea</code> for Oracle,
    <code>system.query_log</code> for ClickHouse, <code>currentOp</code>/<code>system.profile</code> for MongoDB)
    keeps its own SQL — nothing here forces one engine's query shape onto another. What changed is the response:
    every endpoint now also returns a <code>normalized</code> array of rows in one common shape (query id, query
    text, database/schema/user/host, execution count, avg/min/max/total time, rows returned/affected, first/last
    seen, status, severity, source) plus a <code>capabilities</code> object saying which of those fields this
    engine can actually populate. The shared page reads only <code>normalized</code> and <code>capabilities</code>
    — a field an engine cannot report is <code>null</code>, never guessed at, and the page hides that column
    entirely rather than showing a column of dashes.</p>
    <h2>Digest engines vs. one honest exception</h2>
    <p>PostgreSQL, MySQL, MSSQL, Oracle and ClickHouse all aggregate by a query digest — one row represents every
    execution of a query shape, with real averages and counts. MongoDB's <code>currentOp</code>/profiler data has
    no digest concept at all: each row is <strong>one observed operation</strong>, not an aggregate, so its
    "average time" column is genuinely that single operation's duration — the page labels this explicitly
    (<code>capabilities.aggregation === "instance"</code>) rather than presenting a one-off value as a running
    average.</p>
    <h2>Refetch-by-id: four engines can, two honestly can't</h2>
    <p>PostgreSQL, MySQL, MSSQL and Oracle rows carry a stable digest id, so the detail page can re-fetch a query
    by id on a direct link or a page reload. ClickHouse's per-instance fallback rows and MongoDB's operations have
    no such id — the specific instance may already be gone from the log or profiler by the time of a reload — so
    those two show an honest "go back to the list" state instead of a broken re-fetch.</p>
    <h2>Execution plans, per engine's own native mechanism</h2>
    <p>PostgreSQL and MySQL run a real <code>EXPLAIN (ANALYZE)</code>; Oracle reuses its existing
    <code>v$sql_plan</code> lookup by <code>sql_id</code>; ClickHouse runs <code>EXPLAIN PLAN</code>/
    <code>EXPLAIN ESTIMATE</code>; MongoDB runs a real <code>explain("executionStats")</code> command (not just
    the <code>planSummary</code> string it used to show). Each shape is rendered as its own kind of result — a
    plan-node tree, an indented operation list, or a def-list of planner stats — rather than forced into one
    generic table that doesn't fit all of them. MSSQL's real execution-plan XML retrieval is an explicit,
    disclosed follow-up, not yet built; its detail page says so rather than faking a plan.</p>
    <h2>ActMon does not let its own queries pollute this list</h2>
    <p>Every engine's slow-query collector excludes ActMon's own internal bookkeeping tables (agents, audit log,
    user/role/permission tables, cloud accounts, and more — one shared, maintained list in
    <code>actmon_internal_tables.py</code>) before the rows ever reach the frontend — Postgres/MySQL/ClickHouse via
    a regex match, MSSQL and Oracle via a <code>NOT LIKE</code> chain (Oracle's own regex engine has a pattern-length
    ceiling a single alternation of this list exceeds), and MongoDB via a Python-side filter on the namespace and
    query text. A monitored connection that happens to share ActMon's own Postgres instance will not show ActMon's
    housekeeping queries mixed in with the real workload being watched.</p>
    <h2>Setup prerequisites, when the engine needs one</h2>
    <p>PostgreSQL's slow-query list requires the <code>pg_stat_statements</code> extension; when it's missing, the
    Overview tab shows a setup panel with a one-click "Enable extension automatically" action alongside the manual
    <code>postgresql.conf</code>/<code>CREATE EXTENSION</code>/grant instructions — falling back to
    <code>pg_stat_activity</code> (live sessions only) in the meantime. Every other engine reads from an
    always-available system view/schema with no equivalent setup gate.</p>
  `
};

DOCS['dbm-error-logs'] = {
  title:'Error Logs & Self-Heal', dek:'What each engine\'s error log actually shows, and the real gap between MySQL\'s self-heal UI and what it executes.',
  crumbs:['ActMon Documentation','Database','Error Logs & Self-Heal'], module:'Database', status:'Complete',
  body:`
    <h2>Error logs, per engine</h2>
    <p>Every engine's error-log page names its own real data source rather than presenting a possibly-stale
    fallback as if it were live: PostgreSQL discloses whether it's reading a CSV log, stderr log, or falling back
    to <code>pg_stat_activity</code> (in which case it explicitly warns that only live sessions are visible, not
    historical errors); Oracle reads the alert log and, if inaccessible, falls back to redo-log metadata while
    refusing to display that as alert content; MSSQL reads <code>xp_readerrorlog</code> and falls back to
    <code>sys.messages</code> with an explicit "this is the message catalogue, not this server's log" warning;
    MySQL's page also carries a guided "Fix Server" flow that offers concrete remediation commands when error
    logging is disabled server-side.</p>
    <h2>Self-heal exists for exactly two engines: MySQL and MSSQL</h2>
    <p>There is no shared/generic self-heal service — each is an independent implementation with its own
    knowledge base and its own permission logic. PostgreSQL, Oracle, MongoDB, ClickHouse, and Cosmos DB have
    <strong>no</strong> self-heal feature at all.</p>
    <h3>MSSQL — permission-gated, command-based</h3>
    <p>Selecting an error opens a drawer with diagnostic and remediation <strong>T-SQL commands</strong>, each
    classified safe/caution/dangerous. A write/DDL command is refused (not just hidden) if the connected SQL
    Server login lacks the specific privilege it needs (sysadmin, securityadmin, or ALTER ANY LOGIN, depending on
    the command) — the gate is a real database-login-privilege check, verified against the live connection each
    time, not a static assumption.</p>
    <h3>MySQL — a real, verified gap between the UI and the backend</h3>
    <div class="warnbox"><b>The dedicated Self-Heal page's action choice is not actually read</b>${icon('alerts',14)}<span>
    <code>MySQLSelfHeal.jsx</code> lets the user choose between "diagnose only" and "run self-heal," but the
    backend service derives its own action type entirely from the AI analysis' output — a field the AI prompt in
    this codebase never actually asks for. In practice this means the code path taken is effectively always the
    read-only diagnose branch (checking service status and reading the latest error logs), regardless of which
    radio button the user selected. This documentation states the code's real, verified behavior rather than
    what the UI implies it does.</span></div>
    <p>Separately, MySQL's full-featured <code>ErrorLogs.jsx</code> page has its own, more powerful Self-Heal
    tab: a live terminal that streams AI-suggested or user-typed shell commands over the connection's <em>own</em>
    configured SSH credentials (not the hardcoded fallback credentials the dedicated Self-Heal page's deeper
    action branches use) — this pathway has no dry-run and no per-command confirmation beyond the initial "Run N
    Commands" click, and requires SSH to already be configured for that connection.</p>
    <h2>What "self-heal" never does, on any engine</h2>
    <p>No self-heal surface on any engine performs a destructive action without either an explicit AI signal that
    was never actually produced (MySQL's dedicated page) or an explicit per-command click plus a live
    login-privilege check (MSSQL, and MySQL's terminal-based Self-Heal tab). There is no engine where self-heal
    runs unattended on a schedule.</p>
  `
};

DOCS['dbm-reports'] = {
  title:'Reports', dek:'The shared report shell every engine builds its report page on, and how PDF export/email/scheduling works.',
  crumbs:['ActMon Documentation','Database','Reports'], module:'Database', status:'Complete',
  body:`
    <h2>One shared shell, seven different reports</h2>
    <p>Every engine's Reports page (MySQL, PostgreSQL, Oracle, MSSQL — MongoDB and ClickHouse assemble equivalent
    material inline elsewhere, not as a dedicated Reports route) is built on the same shared report kit
    (<code>frontend/src/pages/_shared/reportKit.jsx</code>): a period selector (commonly <code>live</code> plus
    historical windows), a set of numbered sections assembled from many parallel endpoint calls specific to that
    engine, and one shared export mechanism.</p>
    <h2>How export actually works</h2>
    <p>"Download PDF" does <strong>not</strong> call a report-generation endpoint — the already-rendered report
    is captured client-side (the DOM is snapshotted to a canvas, then sliced into A4 pages), and the resulting
    file is produced entirely in the browser. "Send / Schedule" opens a modal with a Send Now tab (attaches that
    same client-captured PDF, or falls back to a backend-generated PDF if the client capture fails) and a
    Schedule tab (recurring email delivery — hourly/daily/weekly/monthly/yearly). Sending requires an SMTP
    configuration to already exist; if none is configured, the modal blocks sending and links to Settings.</p>
    <h2>Where CSV lives instead</h2>
    <p>None of the engine Reports pages offer a CSV export — CSV is a feature of the Slow Queries and Error Logs
    pages instead (see <button onclick="go('dbm-slow-queries')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Slow Queries &amp; Query Analysis</button>), built client-side from
    already-fetched rows, not a backend export.</p>
    <h2>Permission gates on the export actions themselves</h2>
    <p>The Download PDF button is only shown to callers with an <code>export</code> permission on the current
    page; the Send/Schedule button requires <code>execute</code>. This is the one place in the Database module's
    reviewed frontend code where an action button is gated by the application's own RBAC permission check rather
    than being unconditionally rendered.</p>
    <h2>Health scores are computed independently per surface</h2>
    <p>A dashboard's own Overview tab and that same engine's Reports page each compute a health score with
    slightly different weighting/thresholds — they are not guaranteed to show the same number for the same
    connection at the same moment, since each was written to answer a slightly different question (a live
    at-a-glance signal vs. a point-in-time report snapshot).</p>
  `
};

DOCS['dbm-drilldown-diagnose'] = {
  title:'Resource Drill-Down & Diagnose', dek:'Two separate, non-overlapping subsystems behind the Host Resources widget and a struggling connection\'s "Diagnose" link.',
  crumbs:['ActMon Documentation','Database','Resource Drill-Down & Diagnose'], module:'Database', status:'Complete',
  body:`
    <div class="note"><b>These are two different features, not one</b>${icon('book',14)}<span>"Drill-down" and
    "diagnose" are separate backend subsystems with no cross-reference between them in the reviewed code — they
    solve different problems and are reached from different places.</span></div>
    <h2>Resource Drill-Down — the Host Resources widget</h2>
    <p>Embedded inline on every engine's dashboard Overview tab (the same shared component, unmodified per
    engine), this is a CPU/RAM/Disk panel that opens into a 4-level, on-demand drill-down when a gauge is
    clicked: <strong>Level 1</strong> the host's OS process list (sortable by CPU/Memory, tagging which processes
    belong to the database); <strong>Level 2</strong> OS process detail for a non-database process, or
    <strong>Level 3</strong> that database's own live sessions for a database-owned process; <strong>Level 4</strong>
    session/query detail — state, wait event, blockers, last query, and, for PostgreSQL specifically, deeper
    analysis (largest tables, missing-index recommendations with ready-to-run DDL, index usage stats,
    partitioning candidates). A "Generate RCA Report" action is available at the final step. A separate
    "History" view charts 1h/6h/24h of logged CPU/RAM/Disk samples, flags utilization spikes, and lets a past
    snapshot be opened or turned into its own RCA. Nothing here is fetched until the user actually opens a
    level — the widget's own top-level gauges are the only thing polled automatically.</p>
    <h2>Diagnose — a connection-specific, on-demand health verdict</h2>
    <p>Reached from a server/connection whose "Dashboard" link instead reads "Diagnose" (see
    <button onclick="go('dbm-navigation')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Database Navigation</button>) — this is a targeted, real-time
    service/port/log check, not a monitoring dashboard. It builds a check catalogue (OS-level plus DB-level
    checks) that runs nothing until an individual check is actually invoked; each check goes over the agent's
    shell channel to get the truth from the host itself (actual service status, whether the port is listening,
    the collector's last real error) rather than trusting a possibly-stale cached dashboard value. PostgreSQL
    gets a materially deeper diagnose implementation than the other six engines, which share one generic
    version. The only mutating action this subsystem exposes directly is starting a stopped service; restart/stop
    go through the same already-audited service-action endpoint the Infrastructure module uses. A diagnosis
    "run" is only recorded to history once an admin actually executes a check — never just from opening the
    page.</p>
    <h2>Neither reads the cached telemetry tiers</h2>
    <p>Both subsystems always query live (via SSH or the agent), never the Redis/ClickHouse metrics pipeline or
    the snapshot cache each dashboard's own Overview payload uses — see
    <button onclick="go('dbm-reference')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Database Reference</button> for how those caches work.</p>
  `
};

DOCS['dbm-permissions'] = {
  title:'Permissions', dek:'What is actually checked before a Database-module action runs — verified per engine, not assumed.',
  crumbs:['ActMon Documentation','Database','Permissions'], module:'Database', status:'Complete',
  body:`
    <div class="imp"><b>No role/permission-based authorization exists in this backend at all</b>${icon('alerts',14)}<span>
    A repository-wide check for a permission-checking mechanism on the backend turns up nothing — every access
    control decision in the Database module's backend is organization (tenant) scoping only, never a role or
    permission check. The frontend's own RBAC system (<code>canHere</code>/<code>can</code>) does gate a handful
    of buttons — see below — but nothing re-checks that decision server-side.</span></div>
    <h2>The one consistent pattern, across all seven engines</h2>
    <p>For every engine, only that engine's connection <strong>list</strong> and <strong>create</strong>
    endpoints apply organization scoping (filtering the list to the caller's org, and stamping new rows with the
    caller's org id). Every other endpoint that engine's dashboard and sub-pages actually call — the dashboard
    payload itself, slow queries, error logs, index analysis, replication, users, reports,
    self-heal — takes only the numeric connection id, with <strong>no organization check</strong> found anywhere
    in the route or service layer. This pattern is identical for MySQL, PostgreSQL, Oracle, MSSQL, MongoDB,
    ClickHouse, and Cosmos DB — there is no engine that is meaningfully more or less scoped than the others.</p>
    <div class="warnbox"><b>A missing or invalid token is treated as unrestricted, by design</b>${icon('alerts',14)}<span>
    The organization-scoping helper explicitly treats a request with no bearer token, or one that fails to
    decode, as a super-admin-equivalent caller with no organization filter applied — the code's own comment
    states this is intentional, so "internal or agent callers" keep working without a user token. Combined with
    the point above, this means any caller who can reach the API and knows (or guesses) a connection id can read
    that connection's monitoring data regardless of which organization actually owns it.</span></div>
    <h2>Where the frontend's own RBAC does gate something</h2>
    <ul>
      <li>The server list's "Add Server" header button and the empty state's "+ Add OS Server" button both
      require the caller's <code>add</code> permission on the current route.</li>
      <li>A Reports page's "Download PDF" button requires <code>export</code>; its "Send / Schedule" button
      requires <code>execute</code> — the only place in this module where an action button (as opposed to a
      whole page) is gated this way.</li>
      <li>The Refresh, SSH-terminal, Dashboard/Diagnose/Connect, and Delete action icons on the server list are
      <strong>not</strong> gated by any permission check in the reviewed frontend code — they render and work
      regardless of role.</li>
    </ul>
    <p>As with the Agents module, "Permission Status"/login-privilege checks that appear inside MSSQL's self-heal
    drawer (sysadmin/securityadmin/ALTER ANY LOGIN) are the <em>monitored database's own account</em> privileges
    — unrelated to ActMon's own application-level RBAC.</p>
  `
};

DOCS['dbm-states'] = {
  title:'Error / Empty / Loading States', dek:'What the Database module looks like when data is missing, loading, or a connection is unreachable.',
  crumbs:['ActMon Documentation','Database','Error / Empty / Loading States'], module:'Database', status:'Complete',
  body:`
    <h2>Server list</h2>
    <ul>
      <li><strong>Zero servers for a technology</strong> — an explanatory empty state with a "+ Add OS Server"
      action (when the caller can add and isn't currently searching).</li>
      <li><strong>Search matches nothing</strong> — a distinct "no servers matching…" message, no add action
      shown.</li>
      <li><strong>No allowed technologies for this role</strong> — the chooser screen shows its own "No database
      access" empty state instead of an empty grid.</li>
    </ul>
    <h2>A dashboard whose connection can't be reached</h2>
    <p>MySQL's dashboard replaces its entire tab UI with a diagnosis screen when the main data call errors: the
    raw error, a heuristic "possible causes" list keyed to the specific error code, a live error-log feed, and
    quick links into Error Logs/Self-Heal/Slow Queries/Index Analysis. Every engine's own "Diagnose" link (shown
    instead of "Dashboard" on the server list whenever a connection exists but the database is not currently up)
    is the more general version of this same idea — see
    <button onclick="go('dbm-drilldown-diagnose')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Resource Drill-Down &amp; Diagnose</button>.</p>
    <h2>Missing prerequisites, named rather than hidden</h2>
    <p>Several features degrade to a named, explained state rather than an empty chart when a server-side
    prerequisite is missing: PostgreSQL's slow queries without <code>pg_stat_statements</code>; MySQL's index
    analysis without <code>performance_schema</code>; PostgreSQL's error logs falling back to
    <code>pg_stat_activity</code>; Oracle's error logs falling back to redo-log metadata; MSSQL's error logs
    falling back to <code>sys.messages</code>. In every one of these cases the UI states which real data source
    it is actually showing, rather than silently substituting a lesser one.</p>
    <h2>Reports</h2>
    <p>The Send/Schedule email modal blocks sending outright, with a link to Settings, when no SMTP configuration
    exists yet — rather than allowing a send that would silently fail.</p>
  `
};

DOCS['dbm-troubleshooting'] = {
  title:'Troubleshooting', dek:'Practical answers grounded in the actual Database module implementation.',
  crumbs:['ActMon Documentation','Database','Troubleshooting'], module:'Database', status:'Complete',
  body:`
    <h3>A server's row still says "Connect," even though I already added a database on that host</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — the row's action icon is "Connect" (Plus), not "Dashboard."</li>
      <li><strong>Possible cause</strong> — a discovered database instance on this host was never linked to an
      actual connection record; the two are separate rows until explicitly linked.</li>
      <li><strong>Verification</strong> — check whether a connection with a matching name/host/port already
      exists on the relevant engine's own connection list.</li>
      <li><strong>Resolution</strong> — link the existing instance to the connection, or click Connect to create
      one; if it was meant to be agent-monitored, use the Agent Setup wizard instead, which links the connection
      automatically as part of registration.</li>
    </ul>
    <h3>A server's DB status is stuck on "Unknown" after registering it</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — a newly-added server never reports Running/Stopped for its services.</li>
      <li><strong>Possible cause</strong> — SSH-registered servers start every database instance at status
      Unknown until a Refresh (or the next scheduled poll) actually reaches the host; agent-registered
      connections depend on the per-connection agent row having been created — this has historically been a real
      bug when that row was missing.</li>
      <li><strong>Verification</strong> — use the row's Refresh action and see whether status updates
      immediately.</li>
      <li><strong>Resolution</strong> — confirm SSH credentials are correct for a direct connection, or confirm
      an agent is actually enrolled and running for an agent-based one.</li>
    </ul>
    <h3>Slow Queries / Error Logs shows nothing, even though the database is clearly busy</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — an empty or near-empty slow-query/error list on an active database.</li>
      <li><strong>Possible cause</strong> — a missing prerequisite named by the page itself: PostgreSQL without
      <code>pg_stat_statements</code>, MySQL without <code>performance_schema</code>, or an error-log page that
      has silently fallen back to a lesser data source (see
      <button onclick="go('dbm-states')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Error / Empty / Loading States</button>).</li>
      <li><strong>Verification</strong> — read the page's own setup-guide or fallback-source notice; it names
      the exact missing prerequisite.</li>
      <li><strong>Resolution</strong> — follow the on-page instructions (enable the extension/schema, or fix the
      logging configuration named).</li>
    </ul>
    <h3>Self-heal on MySQL seems to ignore my "diagnose only" vs "run" choice</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — the dedicated Self-Heal page's radio choice doesn't seem to change what
      actually runs.</li>
      <li><strong>Possible cause</strong> — this is expected, verified behavior: the backend derives its action
      type from the AI analysis' own output, a field the current AI prompt never actually returns, so the
      read-only diagnose path runs in practice regardless of the UI selection (see
      <button onclick="go('dbm-error-logs')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Error Logs &amp; Self-Heal</button>).</li>
      <li><strong>Verification</strong> — check the self-heal history record for the run; it will show a
      diagnose-only outcome.</li>
      <li><strong>Resolution</strong> — for an actual remediation action, use the connection's Error Logs page's
      own Self-Heal tab (the SSH-terminal-based one) instead.</li>
    </ul>
    <h3>A Reports page's "Send / Schedule" button is missing or disabled</h3>
    <ul class="steps">
      <li><strong>Problem</strong> — no way to email or schedule a report.</li>
      <li><strong>Possible cause</strong> — the caller's role lacks the <code>execute</code> permission this
      button is gated behind, or (separately) no SMTP configuration exists yet.</li>
      <li><strong>Verification</strong> — check the role's permissions, and check Settings for an SMTP config.</li>
      <li><strong>Resolution</strong> — grant the permission, or configure SMTP, as applicable.</li>
    </ul>
  `
};

DOCS['dbm-reference'] = {
  title:'Database Reference', dek:'Consolidated reference — routes, the collector/telemetry architecture, and per-engine endpoint tables.',
  crumbs:['ActMon Documentation','Database','Database Reference'], module:'Database', status:'Complete',
  body:`
    <h2>Frontend routes</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Route</th><th>Component</th></tr>
      <tr><td><code>/databases</code></td><td><code>DatabaseServersPage</code> (chooser)</td></tr>
      <tr><td><code>/{tech}-servers</code> (mysql, postgresql, oracle, mssql, mongodb, clickhouse)</td><td><code>DatabaseServersPage</code> (per-tech list)</td></tr>
      <tr><td><code>/cosmosdb-servers</code></td><td><code>CosmosDBConnectionsPage</code></td></tr>
      <tr><td><code>/databases/add-os-server</code></td><td><code>AddOsServerPage</code></td></tr>
      <tr><td><code>/{tech}-dashboard/:id(/:tab)</code></td><td>Per-engine dashboard component</td></tr>
      <tr><td><code>/mysql-dashboard/:id/{slow-queries, error-logs, error-analysis, self-heal, index-analysis, reports}</code></td><td>Dedicated MySQL sub-pages</td></tr>
      <tr><td><code>/postgresql-dashboard/:id/{slow-queries, slow-queries/detail, error-logs, index-analysis, reports}</code></td><td>Dedicated PostgreSQL sub-pages</td></tr>
      <tr><td><code>/oracle-dashboard/:id/{live-queries, slow-queries, error-logs, index-analysis, reports}</code></td><td>Dedicated Oracle sub-pages</td></tr>
      <tr><td><code>/mssql-dashboard/:id/{slow-queries, slow-queries/detail, error-logs, index-analysis, reports}</code></td><td>Dedicated MSSQL sub-pages</td></tr>
      <tr><td><code>/mongodb-dashboard/:id/{slow-operations, error-logs, collection-analysis}</code></td><td>Dedicated MongoDB sub-pages</td></tr>
      <tr><td><code>/clickhouse-dashboard/:id/{slow-queries, error-logs, table-analysis}</code></td><td>Dedicated ClickHouse sub-pages</td></tr>
      <tr><td><code>/cosmosdb-edit/:id</code></td><td>Cosmos connection edit form</td></tr>
    </table></div>
    <h2>Telemetry architecture — three tiers, not one</h2>
    <p>A per-engine dashboard's own payload is served primarily from a PostgreSQL-backed JSON snapshot cache
    (refreshed roughly every 60 seconds by a background collector; a <code>live</code> query parameter bypasses
    it for a fresh read). A separate, generic numeric metrics API (<code>/api/v1/metrics/...</code>) exposes the
    Redis hot-ring (very latest samples) and ClickHouse history (longer-range) tiers used for gauges/trend
    widgets — its own documentation instructs callers to treat an empty result as "this tier is offline" and
    fall back to the PostgreSQL-backed endpoints, confirming it is a supplementary surface, not the primary one.
    A third path — Resource Drill-Down and Diagnose — always queries live over SSH/agent and never reads either
    cached tier; see
    <button onclick="go('dbm-drilldown-diagnose')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Resource Drill-Down &amp; Diagnose</button>.</p>
    <h2>The collector abstraction</h2>
    <p>A shared proxy layer resolves whether a connection's host has an enrolled agent and, if so, builds a
    SQLAlchemy-engine-shaped shim that routes queries through that agent instead of a direct connection — see
    <button onclick="go('dbm-connections')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Connections &amp; Collectors</button>. MySQL/PostgreSQL can fall back to a direct query if the
    agent doesn't answer; Oracle/MSSQL never do (they surface an explicit timeout error instead).</p>
    <h2>Endpoint families, per engine</h2>
    <p>Every engine follows the same two-router shape: one CRUD router (list/create — organization-scoped;
    get/update/delete/test — not organization-scoped) and one (or more) monitoring routers covering the
    dashboard payload, slow queries, error logs, index analysis, and engine-specific tabs — none of the
    monitoring endpoints apply organization scoping. See
    <button onclick="go('dbm-permissions')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Permissions</button> for the verified specifics of that gap.</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Engine</th><th>Primary endpoint prefix</th><th>Distinctive endpoint families</th></tr>
      <tr><td>MySQL</td><td><code>/connections/mysql</code></td><td>slow-queries (explain-analyze, analyze-groq, export), error-logs (self-heal, self-heal-stream), index-analysis, replication, table browsing, report email</td></tr>
      <tr><td>PostgreSQL</td><td><code>/connections/postgresql</code></td><td>24 monitoring endpoints incl. pg-slow-queries, pg-index-analysis, pg-wal-stats, pg-checkpoint-stats, pg-slru-stats, pg-ssl-stats; drilldown (host-metrics, processes, session detail, rca, grant-monitor, history)</td></tr>
      <tr><td>Oracle</td><td><code>/connections/oracle</code></td><td>31 monitoring endpoints — the most granular of any engine — incl. sga/pga-detail, top-sql, wait-events, tablespaces, data-guard, redo-logs, rman-backup (read-only), archive-log-gap, ebs-concurrent/ebs-workflow</td></tr>
      <tr><td>MSSQL</td><td><code>/connections/mssql</code></td><td>One large monitoring-dashboard payload; slow-queries (analyze-groq); error-analysis (error-deep-analysis, heal-permissions, run-command)</td></tr>
      <tr><td>MongoDB</td><td><code>/connections/mongodb</code></td><td>mongo-ops/profiler/slow-operations, mongo-collections/indexes/collection-analysis, mongo-replication/oplog/sharding/transactions/wiredtiger/users, analyze-groq</td></tr>
      <tr><td>ClickHouse</td><td><code>/connections/clickhouse</code></td><td>ch-queries/query-log/slow-queries (ActMon-query-excluded), ch-tables/partitions/merges/replicas/clusters, ch-table-analysis</td></tr>
      <tr><td>Cosmos DB</td><td><code>/connections/cosmosdb</code></td><td>databases/containers/items/query/document-count (billed, RU-based), activity (free — reads ActMon's own call log), ai-analysis</td></tr>
    </table></div>
    <h2>Shared infrastructure endpoints</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Endpoint</th><th>Purpose</th></tr>
      <tr><td><code>GET /os-servers/live-status</code>, <code>/summary</code>, <code>/</code></td><td>Server list live status / fleet summary / full list — polled by the chooser and per-tech screens</td></tr>
      <tr><td><code>POST /os-servers/</code>, <code>PUT/DELETE /os-servers/{id}</code></td><td>Create/update/delete a server (create is org-scoped; update/delete are not)</td></tr>
      <tr><td><code>POST /os-servers/test-ssh</code>, <code>/os-servers/{id}/refresh</code></td><td>SSH connectivity test; deep SSH refresh of CPU/RAM/Disk/uptime and per-service status</td></tr>
      <tr><td><code>POST /os-servers/{id}/instances/{instId}/link</code></td><td>Link a discovered database instance to a connection</td></tr>
      <tr><td><code>/api/v1/drilldown/{tech}/{conn_id}/...</code>, <code>/connections/postgresql/{conn_id}/...</code> (drilldown)</td><td>Resource Drill-Down — see <button onclick="go('dbm-drilldown-diagnose')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Resource Drill-Down &amp; Diagnose</button></td></tr>
      <tr><td><code>/{conn_id}/diagnose/plan</code>, <code>/check/{id}</code>, <code>/rca</code>, <code>/diagnose</code></td><td>Diagnose — connection-specific live health verdict</td></tr>
      <tr><td><code>/api/v1/metrics/live/{agent}</code>, <code>/history/{agent}</code>, <code>/stable/{agent}</code></td><td>Generic Redis/ClickHouse/PostgreSQL telemetry tiers</td></tr>
    </table></div>
    <h2>Navigation summary</h2>
    <p>See <button onclick="go('dbm-navigation')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Database Navigation</button> for the chooser→list→dashboard flow, and each engine's
    own topic for that engine's tab list and sub-pages.</p>
  `
};

/* ---------------- "coming soon" module stubs ---------------- */
MODULES.filter(m=>!m.available).forEach(m=>{
  DOCS[m.id] = {
    title:m.label, dek:`Documentation for ${m.label} has not been written yet.`,
    crumbs:['ActMon Documentation', m.label], noMeta:true,
    body:`
      <div class="note"><b>Coming soon</b>${icon('book',14)}<span>
      ${m.label} is documented in a later phase, after Dashboard is complete. Planned order:
      Dashboard → Agents → Databases → Cloud → Infrastructure → Administration → Sales → Settings → ChatBot → Profile.
      </span></div>
      <p>${m.id==='mod-profile'
        ? 'Profile is an account-level menu in the application chrome rather than an entry in the module bar itself.'
        : `The real route for this module is <code>${m.route}</code>${m.id==='mod-cloud' ? ' — present in the navigation configuration, but no page component is currently registered for it in the application router.' : '.'}`}</p>
    `
  };
});

/* ============================================================
   Runtime — sidebar, router, breadcrumbs, pager, search
   ============================================================ */
export const FLOW = [...GS_TOPICS.map(t=>t[0]), ...DASH_TOPICS.map(t=>t[0]), ...AGENTS_TOPICS.map(t=>t[0]), ...DATABASE_TOPICS.map(t=>t[0])];
