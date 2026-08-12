# ActMon Frontend (v1.1.0)

Fresh React 19 + Vite 6 + Tailwind 4 frontend. Built token-first: **theme, colour,
fonts, roundness, density and layout are all runtime-configurable**, and no page
needs to know a setting changed.

```bash
npm install
npm run dev      # http://localhost:2106  (proxies /api → 127.0.0.1:8000)
npm run build
```

## The one rule

> **Never hard-code a colour, radius, font or size in a component.**
> Style only through the token utilities.

That rule is the whole reason theming works. The previous frontend styled pages
with `bg-white` / `text-slate-900` and then needed a large `!important` override
layer to retrofit dark mode — every new page reopened the problem. Here the
tokens *are* the styling API.

### Token utilities

| Purpose | Use | Never use |
|---|---|---|
| page / card / hover / inset surfaces | `bg-bg` `bg-surface` `bg-raised` `bg-sunken` | `bg-white` `bg-slate-50` |
| text | `text-fg` `text-muted` `text-subtle` | `text-slate-900` `text-gray-500` |
| lines | `border-border` `border-strong` | `border-slate-200` |
| brand | `bg-accent` `text-accent-fg` `text-accent-text` `bg-accent-soft` `border-accent-border` | `bg-blue-600` |
| status | `bg-success-soft text-success-fg` (+ `warning` `danger` `info`) | `bg-green-100 text-green-700` |
| sidebar | `bg-sidebar` `text-sidebar-fg` `text-sidebar-muted` `bg-sidebar-active` | any fixed dark colour |
| top bar | `bg-topbar` `text-topbar-fg` `text-topbar-muted` | — |
| radius | `rounded-card` `rounded-control` `rounded-sm…2xl` | `rounded-[8px]` |
| sizing | `h-control` `h-row` `p-card` `gap-gutter` `h-topbar` | fixed px heights |
| truncated text | `truncate-safe` | `truncate` + `leading-none`/`leading-tight` |
| charts | `var(--chart-1)` … `var(--chart-8)` | literal hexes |

`text-accent-fg` = text **on** the accent. `text-accent-text` = the accent used
**as** text (contrast-corrected so any accent stays AA-legible).

**Use `truncate-safe`, not `truncate`, for text labels.** Tailwind's `truncate`
sets `overflow: hidden`, which crops anything the line box can't hold. Segoe UI
needs ~1.2em (ascent .98 + descent .22), so `truncate` next to `leading-none` or
even `leading-tight` shaves the tails off g / p / y / q — it clipped "Agents" and
"Logs" in the sidebar. `truncate-safe` pins a 1.35 line-height that survives every
selectable font. Plain `truncate` is fine on digits, or where the inherited 1.5
line-height is left alone.

## Where things live

```
src/
  styles/
    tokens.css        ← the ONLY file with raw colour values; theme presets + modifiers
    index.css         ← Tailwind alias layer (@theme inline), base, .card, animations
  theme/
    presets.js        ← catalogue of every user choice (themes, fonts, densities…)
    color.js          ← WCAG contrast / shade / mix maths
    themeStore.js     ← state → CSS variables (buildTokens / applyAppearance)
    ThemeProvider.jsx ← mount paint, OS dark-mode follow, cross-tab sync
  config/
    app.config.js     ← branding, API base, feature toggles, shortcuts
    navigation.js     ← flat sidebar list (mirrors module_master), breadcrumb labels
  components/
    layout/           ← AppShell, Sidebar, NavItem, TopBar, Breadcrumbs, PageHeader, Brand
    appearance/       ← AppearanceDrawer (generated from presets.js)
    ui/               ← Icon, Button, Input, Select, Switch, Table, Tabs, Tooltip,
                         Popover, Drawer, Dialog, Badge, IconButton, Field
  hooks/
    useNavigation.js  ← static list until GET /auth/menu lands, then the server menu
    useShortcuts.js   ← Ctrl+K / Ctrl+B / Ctrl+Shift+L / Ctrl+Shift+,
```

## Sidebar

Flat list, one row per module, in `module_master` display order — Dashboard,
Agents, Databases, Cloud, Infrastructure, ML / AI, Alerts, Administration,
Settings, ChatBot, Logs. `MENU_ITEMS` in `config/navigation.js` is the pre-login
fallback and is deliberately identical to what `build_menu()` returns, so the
rail doesn't reshuffle once `useMenuStore.setServerMenu()` is called after login.

Alignment is a contract, not per-component guesswork: the header, every nav row
and the account block all use the rail padding plus a fixed **28px glyph box**
(`ICON_BOX` in `NavItem.jsx`), so every label starts on the same x and every
glyph shares one centre line. Collapsed mode centres that same box in the rail.
Changing the geometry means changing those two constants — not each row.

## How a setting reaches the screen

1. A control in `AppearanceDrawer` calls `useThemeStore().update({ … })`.
2. `buildTokens()` turns the appearance object into a CSS-variable map — deriving
   accent hover/active/soft/legible-text shades, sidebar and top-bar skins,
   density sizes, radius scale, font stacks and the chart palette.
3. `applyAppearance()` writes them as inline vars on `<html>` plus a few
   `data-*` attributes (`data-theme`, `data-surface`, `data-nav`, `data-contrast`,
   `data-motion`) that CSS branches on.
4. Every component repaints, because every component reads those vars.

Persisted to `localStorage` under `actmon.appearance`; a tiny inline script in
`index.html` replays theme + accent before React mounts so there is no flash.

### Adding a new option

- **A theme** — add a `[data-theme='x']` block in `tokens.css` + an entry in `THEMES`.
- **A font / density / radius / nav style** — one entry in `presets.js`. The
  Appearance panel picks it up automatically.
- **A new token** — declare it in `tokens.css`, alias it in the `@theme inline`
  block in `index.css`, and it becomes a utility.

## Dashboard

Reads five existing endpoints — nothing new server-side:
`/os-servers/summary`, `/os-servers/`, `/agents/`, `/alerts/active`, `/cloud/accounts`
(one `useQueries` in `hooks/useDashboardData.js`, `retry: false` so a 401 or a
stopped microservice shows an empty state instead of stalling for 30s).

### The reader picks the chart type

Each card declares its **data**; the **form** is the user's choice, from a picker
in the card header. The pick is remembered per card (`localStorage`,
`actmon.chartKinds`), so one dashboard can mix a donut here and a bar there.
`Appearance → Charts` sets a global default, and each picker has "Use the default"
to drop an override.

Cards belong to one of three families (`components/charts/chartKinds.js`), and a
family only offers forms that can actually express its data:

| Family | Data | Forms offered |
|---|---|---|
| `flat` | one value per category | bar · column · single stack · donut · pie |
| `breakdown` | category × status segments | stacked bar · stacked column · grouped column · totals bar · donut · pie |
| `ratio` | values against a 0–100% cap | meters · gauges · columns · bars |

So a percentage is never offered as a pie, and picking "pie" globally leaves the
resource meters as meters. The most accurate form per family is the default and
stays flagged **BEST** in the picker — a different pick is an informed trade-off,
not an accident.

Whichever form is chosen, these hold:

- **Colour meaning doesn't move.** Utilisation and health always wear the fixed
  status scale; switching form never turns a status colour into a series colour.
- **A legend for two or more series**, and values printed on the marks — nothing
  is tooltip-only. Totals-only forms (pie/donut/totals-bar of a `breakdown`) say
  so under the legend, since they drop the split.
- **Pies cap at 6 wedges** and fold the tail into "Other". Past that, adjacent
  angles stop being distinguishable and more hues would break the palette's
  colourblind ordering.
- **2px surface gaps** between touching fills (a surface-coloured stroke on pie
  wedges), 4px rounded data-ends, square at the baseline.

Charts are plain HTML/CSS/SVG — no charting library. Deliberate: these forms are
bars, stacks, arcs and meters, and hand-built markup gives exact control over the
gaps, data-ends and hit targets, themes perfectly from tokens, and costs no
dependency. All 25 family × form × edge-case combinations (including 9-category
tail folding, empty data and zero values) were smoke-tested via SSR render.

### Colour rules (enforced, not stylistic)

- **Series colour is validated, not chosen.** `CHART_PALETTES` holds two orderings
  of the same eight validated hues, each with light and dark steps. Verified with
  the dataviz validator against this app's real worst-case surfaces
  (light `#ffffff`, dim `#222b3c`) — `default` passes every gate
  (adjacent CVD ΔE 9.1 / 8.4); `warm` passes with CVD in the 6–8 floor band, which
  is legal because every chart ships a legend, direct labels and surface gaps. A
  cool-first ordering was tested and **failed**, so it isn't offered.
  **Adding a palette means re-running the validator** — the command is in the
  comment above `CHART_PALETTES`.
- **The accent never colours a series.** Series colour encodes identity and has to
  stay colourblind-safe as an ordered set; an arbitrary user-picked hex can't
  guarantee that. The accent owns UI chrome, charts own their palette.
- **Status is fixed and never themed** (`--status-good/-warning/-serious/-critical`).
  A reader learns these once. Two steps sit below 3:1 on a light surface by design,
  so status is never colour-alone — `StatusKey` always pairs the swatch with an icon
  and a label.
- **Every chart card has a table view** (the toggle in `ChartCard`), so no value is
  reachable only by hovering.

## Agents

Same capabilities as the existing module: four KPI cards that double as status
filters, search across name/host/IP/description, engine + status + environment
filters, grid and list views with the same sort choices, sync-from-connections,
and a 10s auto-refresh with a visible countdown.

**Registration is a faithful copy — design and behaviour.**

*Design:* the original dialog reproduced element for element — gradient header
banner with the title, subtitle and translucent close button; scrolling body with
the same three `grid-cols-2` rows; the same `px-3 py-2 text-sm` field rhythm and
sentence-case bold labels; the same `rounded-xl` tinted info note; a tinted footer
with Cancel and a gradient primary button. Because it's a bespoke layout it does
**not** go through the generic `Dialog`; `FIELD`/`LABEL` constants at the top of
the file mirror the original's `FIELD_CLS`/`LABEL_CLS`.

*Behaviour:* same fields in the same order, same defaults and option lists, same
validation, same request body. Not a rewrite from memory —
`REGISTRATION.toPayload()` in `config/agents.js` reproduces the original submit
logic (blank hostname/ip/description sent as `undefined` so the backend stores
NULL; interval `parseInt` with a 60 fallback), asserted against a transcription of
the original across 7 input cases including whitespace-only fields and junk
intervals.

*What changed:* only that colours, radii, fonts and sizes resolve through tokens.
The header and primary button use `--gradient-accent` — one token, also used by
the sidebar mark and avatars. Set the accent to **Indigo** in Appearance to
reproduce the original indigo palette, or edit that one token in `tokens.css` for
the exact two-hue indigo→violet gradient.

### Agent monitoring (`/agents/:name`)

`AgentDetailPage` applies the existing rule — no linked DB connection means a HOST
agent — and routes to `HostAgentPage`; agents with a connection get the database
dashboard, which isn't ported yet and says so.

`HostAgentPage` is **agent self-monitoring only**. The subject is the agent: its
service, its version, its delivery, its pipeline. Host OS detail — filesystems,
processes, interfaces, disks — is **not** on this page; that belongs to
Infrastructure, and the page links there. The `host` block that
`/agents/{name}/host-overview` also returns is deliberately ignored, and a test
asserts none of it reaches the markup.

Three feeds, because an agent's own state is spread across three endpoints:

| Endpoint | Answers |
|---|---|
| `host-overview` | delivery, cadence, throughput, transport, events |
| `service-state` | is the ActMon service actually running on the host |
| `update-status` | version and upgrade-ledger state |

Sections: **Agent process** (service / version + update ledger / registration) ·
**Delivery** (8 KPIs) · **Telemetry pipeline** · **Live telemetry** (4 charts) ·
**Agent events**.

The pipeline panel is the useful part when nothing is flowing: each hop
(Agent → API → Redis hot ring → ClickHouse) reports separately, and a banner names
the first broken stage. On the current live agent that resolves "no charts" to
*"Telemetry stops at: Redis hot ring — Redis is not connected"* instead of a blank
panel.

Two honesty fixes over the original:

- **Delivery of zero is not 100%.** The API returns `delivery_pct: 100` when
  `expected_samples` is `0`, so a brand-new agent that has delivered nothing
  reported "100% packet delivery". `useHostOverview` treats a zero expectation as
  *unknown* and shows "no samples expected yet".
- **An empty ring is stated, not drawn.** With no samples the charts say "Waiting
  for samples" and explain why, instead of plotting a flat line at zero that looks
  like real data.

`LineChart` is the new time-series primitive — 2px round-capped line, ~10% area
wash, solid hairline gridlines, one y-axis, a crosshair that snaps to the nearest
sample, an end marker with a surface ring, and the latest value always printed so
no number is hover-gated.

## Databases — copied verbatim

`pages/databases/DatabaseServersPage.jsx` (1594 lines) is a literal copy of the
existing module: the "Choose Technology" hub, all six engine cards, the KPI strip
and the Cloud-Based Databases section. One component serves both the hub and each
per-technology list — the technology arrives as a **prop**, not from state, so the
routes mirror the original exactly:

```
/databases            hub (technology grid)
/{tech}-servers       mysql · postgresql · oracle · mssql · mongodb · clickhouse
```

Copied alongside it, also verbatim: `store/authStore.js`,
`components/terminal/XTerminal.jsx` (the SSH drawer) and `api/servers.js`.
`cmp` confirms all four are byte-identical; only relative import paths were
rewritten to `@/…`. Added deps: `@xterm/xterm`, `@xterm/addon-fit`, `jwt-decode`.

**The header is the shared one, not the page's own.** The original drew a dark
gradient hero inline on both the hub and each technology view. Every other page in
this frontend uses `components/layout/PageHeader`, so both heroes were replaced
with it and all their content kept — title, subtitle, the `connected/total` +
percentage badge (now `OnlineBadge`, one component instead of two inline copies),
Add Server, and the back-to-technologies action. The hero's inline breadcrumb went
too: the top bar already derives one from the route. Also removed: the hardcoded
`bg-[#f1f4f9]` page background and the doubled inner padding, so the page follows
the theme and the configurable content width.

### Add OS Server (`/databases/add-os-server`)

The **flow is the existing one**, unchanged. Pick a connection method, then either:

- **Agent** — steps collapse to just `Connection` and Next hands off to
  `/databases/add-data` (the verbatim-ported Add Data catalogue). Nothing is
  registered here, exactly as today. Both choice cards keep their original copy
  word for word.
- **SSH** — Connection · Operating System · Server Identity · SSH Access ·
  Node Role · Services · Review, then `createOsServer()`.

Field names, validation gates, the `testSshConnection` call and the request payload
are identical; the payload is built by `config/servers.js → toServerPayload()` and
asserted against a transcription of the original across four cases (hostname
falling back to IP, junk SSH port → 22, string-vs-boolean toggles, and the agent
case where no `ssh_*` keys are sent at all). Option lists, order and form defaults
are asserted too.

The SSH screens are restyled onto the token system, and the page uses the shared
`PageHeader` plus a token-based `Steps` indicator instead of the old full-bleed
white shell. Per-item Tailwind palette classes became semantic tones, and database
service chips reuse the validated engine slots from `config/agents.js`.

**One deliberate deviation, in `hooks/usePermissions.js`.** The real RBAC engine
denies everything when there is no session, which would render the hub with **zero**
technologies. An additions-only clause treats the app as ungoverned while there is
genuinely no RBAC data at all (no permissions, no catalog, no governed URLs). The
moment login populates the auth store the original logic runs unchanged, so a real
session behaves exactly as production does. The block is marked TEMPORARY and says
to delete it when login lands.

### Setup / deploy wizards — copied verbatim

`pages/agents/setup/` is a **literal copy** of the existing module's 27 files
(Add Data catalogue, the per-engine setup wizard, the deploy wizard and its 9
steps, the website and network-check wizards, plus `techConfig` and the 5 icon
sets). Verified byte-identical except for one mechanical change: relative API
imports rewritten to `@/api/…`. Diffing every file against the original with that
same substitution applied yields **zero differing lines**.

Routes: `/agents/setup`, `/agents/setup/website`, `/agents/setup/network-check`,
`/agents/setup/:tech`, `/agents/deploy`, plus `/databases/add-data` and
`/databases/setup/:tech` (the pages switch their own exit targets off the
pathname). The two named wizards are registered before `:tech` so they aren't
swallowed by it.

These pages draw edge-to-edge with Tailwind's fixed `-mx-6 md:-mx-8`, so
`AppShell` recognises their route prefixes (`BLEED_PREFIXES`) and switches the
content container to matching fixed padding with no max-width — otherwise those
negative margins would overflow a density-driven padding that happens to differ.

**Trade-off, stated plainly:** being a verbatim copy, these pages keep their
original hardcoded palette (`text-slate-800`, `bg-white`, the rose tab underline,
the purple/amber illustrations). They will therefore **not follow the theme,
accent or font settings** the way the rest of the app does. That was the explicit
ask — same-to-same first. Tokenizing them later is a mechanical pass over the same
files whenever you want it.

### What "centralized" means here

The previous build scattered agent styling through the page — an engine→hex map, a
status→hex map, per-status background/border/text triples inline in a helper,
hardcoded cluster-badge Tailwind classes, literal CPU thresholds and a literal
poll interval. None of it could follow the theme.

All of it now lives in `config/agents.js` and refers to **tokens, never hex**:

| Was | Now |
|---|---|
| `DB_COLORS` (6 raw hex) | `DB_ENGINES[].slot` → `var(--chart-N)`, validated categorical slots in fixed order |
| `STATUS_COLORS` (4 raw hex) | `LEVEL_COLORS` → `var(--status-*)` |
| `statusInfo()` returning `{color,bg,border}` | `agentState()` returning a `tone` that maps to the shared status scale |
| `getClusterBadge()` returning Tailwind colour classes | `clusterBadge()` returning a `tone` |
| CPU thresholds `80` / `60` inline | `THRESHOLDS` |
| `refetch` countdown `10` inline | `TIMING.refreshSeconds` |
| Sort/view/filter option lists inline in JSX | `SORT_OPTIONS`, `VIEW_MODES`, `STATUS_FILTERS`, `STAT_CARDS` |

`agentState()` keeps the original decision tree verbatim, including the
service-alive vs service-down regexes on `last_error` — getting those backwards is
what used to label healthy hosts "Service Stopped", so they are transcribed
exactly and verified against the original across 19 status permutations.

**Audit result:** zero Tailwind palette classes (`bg-slate-*`, `text-red-*`, …)
anywhere in `src/`, and the only hex literals outside `styles/` and `theme/` are
the Appearance drawer's colour-picker swatches — which *are* colour values.

## Alerts

Two tabs, because they answer two questions — "what's wrong now" and "what would
we be told about". The tab lives in the URL (`/alerts?tab=rules`).

**Active** — live feed, 15s poll. One filter row (search · severity · source ·
metric) scopes everything below it, so the severity chips always agree with the
rows; the chips are also filters. Rows expand for metric/threshold/origin detail,
sort on every column, and value cells show `96.4%` against `of 90%`.

Only collector events are selectable for acknowledgement. Rule-evaluated alerts
are recomputed from live host state each poll (their id is `"<ruleId>:<hostId>"`,
not a row), so there is nothing to mark read — they clear when the condition
clears. Checkboxes are suppressed for them rather than offering an action that
would silently do nothing (`isAckable()` in `api/alerts.js`).

**Rules** — section-driven, matching the existing module. Pick a section
(Infrastructure · Database · Replication & HA · Backup · Cloud) and everything
below it belongs to that section: the rules listed, the search, and the metrics
offered when creating one. Inline enable/disable, sortable columns, and full CRUD.
Disabled rules stay listed but dimmed rather than disappearing, because "why am I
not getting this alert" is the question this tab exists to answer.

`config/alertCatalog.js` is the catalogue — the same 5 sections, metric ids, units,
defaults (`def`) and directions (`dirLow`) the existing app ships, so a rule means
the same thing in either build. 37 metrics; verified that all 21 seeded rules map
to a section with no unmapped ids.

- `kind: 'event'` metrics (backup failed, host down) are states, not
  measurements — the editor drops operator/threshold and stores `eq 1`, which is
  what the backend evaluates.
- Picking a metric resets operator + threshold to *that metric's* defaults, so
  cache-hit-ratio opens as `< 90%` instead of inheriting `> 80`.
- Scopes follow the section: cloud rules scope to accounts, everything else to
  servers / technologies / agents, with real pickers fed from the live host, agent
  and cloud-account lists.

**One addition worth knowing about.** Each metric carries an `evaluation` field
derived from what the backend can actually raise (`_evaluate` and
`_infer_metric` in `alert_routes.py`):

| | meaning |
|---|---|
| `live` | checked against host state every poll — cpu, memory, disk, host_down, service_down |
| `collector` | no host check, but agent messages map onto it; the enabled rule is what lets them through |
| `reserved` | no data source yet — the rule saves and persists, but nothing will raise it |

Of the 21 seeded rules, 7 are live, 6 agent-reported and 8 sit on reserved
metrics. The editor and the rule rows say so, because a rule that can never fire
is otherwise indistinguishable from a broken one. Keep the field in sync when the
backend grows new evaluators.

## Status

Done: token system, appearance configurator, app shell, sidebar (flat module list,
collapsible, mobile drawer, server-menu ready), top bar (breadcrumbs, search
affordance, theme toggle, notifications shell, help, fullscreen), error boundary,
routing skeleton, API client, UI primitives (Button/Input/Select/Switch/Table/Tabs),
dashboard, alerts, agents.

Next: auth + login (then `useMenuStore.setServerMenu()` and the real user identity
wire up), then the remaining modules one at a time. Their nav destinations render a
`Placeholder` so no link is dead.
