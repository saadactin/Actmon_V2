# ACTMON Universe — Interactive Platform Documentation

A cinematic, explorable 3D map of the ACTMON platform, for customer
demonstrations and internal technical documentation.

**Every meaningful zoom reveals a new level of information.** There are six
levels, and each builds a genuinely different scene rather than re-labelling
its parent.

## Opening it

**Double-click `index.html`.** That is the whole procedure — no build step, no
`npm install`, no server. It is deliberately written as classic scripts rather
than ES modules so it works from `file://`.

If your browser or corporate policy blocks local files, serve the folder over
HTTP instead:

```bash
cd docs/interactive
python -m http.server 8777
# then open http://localhost:8777
```

`three.js` and `gsap` load from cdnjs, so the 3D scene needs internet access on
first load. **Without it the document still works** — it detects the missing
library and opens in the 2D view with the full content intact.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page shell, type scale, all UI chrome |
| `actmon-data.js` | Verified content — every fact, with the source file it came from |
| `actmon-samples.js` | SAMPLE MODE — deterministic illustrative records |
| `actmon-engines.js` | Every non-PostgreSQL engine's dashboard sections |
| `actmon-scene.js` | 3D substrate: camera controller, label LOD, geometry factory |
| `actmon-envs.js` | One builder per explorable environment |
| `actmon-app.js` | Level stack, panels, search, tour, 2D fallback, keyboard |
| `README.md` | This file |

To correct a **fact**, edit `actmon-data.js`. To change an **illustrative
number**, edit `actmon-samples.js`. To add an **environment**, add one builder
to `actmon-envs.js` — nothing else needs to know about it. None of the three
requires touching the 3D engine.

### The six levels

| Level | What it is | Example |
|---|---|---|
| 0 | The ACTMON universe | Seven domains around the platform core |
| 1 | Module environment | Database landscape · cloud bodies · datacentre floor · log river |
| 2 | Technology | PostgreSQL inside its health arcs, 16 feature pathways |
| 3 | Feature environment | Slow-query towers · privilege graph · replication topology |
| 4–5 | A single record | One query's plan tree · one role's effective privileges |

### Data drives the geometry

Nothing in the scene is decorative arrangement:

- A table's **volume** is its size on disk; the red cap is its dead-tuple share.
- A query tower's **width** is cumulative cost, its **height** average duration
  — which is why the most expensive statement is visibly *not* the slowest.
- A standby's **particle speed** is the inverse of its lag; a lost slot has no
  flow at all.
- An index is drawn as a **B-tree**: fan-out is its column count, brightness is
  its scan count, and an unused one is dark and struck through.
- A permission bit's **height** is `log2(value)`, so the doubling is visible.

## Using it

Start at the platform overview and click into whatever you want to see. The
breadcrumb across the top is the navigation — clicking any earlier step returns
you there.

| Control | Does |
|---|---|
| Click a node | Select it — camera eases to it, panel opens |
| **Enter** (or the panel's Enter button) | Descend into that object's own environment |
| Drag | Orbit the camera |
| Shift-drag / right-drag | Pan |
| Scroll | Zoom (clamped per level, so the camera cannot get lost) |
| Breadcrumb | Jump back to any level |
| Back / Forward | Step through history |
| Reset / the ACTMON mark | Return to the overview |
| Search | Every module, technology, section, provider and channel |
| Guided tour | 10 cinematic chapters, pausable — explore freely at any point |
| 2D view | The same content as a flat, keyboard-navigable list |
| Reduce motion | Makes every transition instant |

**Keyboard:** `0` reset · `Backspace` back · `Enter` descend · `T` tour ·
`F` 2D view · `M` reduce motion · `/` search · arrows orbit · `+`/`-` zoom ·
`Esc` close · `?` key help.

Labels have three tiers driven by distance: a dot far away, the name at middle
range, and name + purpose + action when you approach or hover. They de-overlap
and demote when occluded, so nothing is permanently glued to anything.

Honours `prefers-reduced-motion` automatically.

## All eight database technologies

Each engine gets its own level-2 environment built from **its own** dashboard
sections, read from that engine's nav config — so the vocabulary is the
product's, not normalised:

| Engine | Sections | Notable |
|---|---|---|
| PostgreSQL | 16 (+1 detail page) | The one traced section by section |
| Oracle | 20 | Five appear only on RAC / ASM / CDB; Data Guard only when detected |
| SQL Server | 16 | Says **Logins** and **Always On**, not Users and Replication |
| MySQL | 15 | Includes **Binary Logs** — no PostgreSQL equivalent |
| MariaDB | 15 | Partial: rides the MySQL path, no route of its own |
| MongoDB | 14 | Collections, Oplog, Sharding, WiredTiger |
| ClickHouse | 13 | Partitions, Merges, Replicas |
| Azure Cosmos DB | 9 | Containers, Indexing, Request Units |

The scene follows the product: Oracle's twenty sections need two rings,
Cosmos DB's nine fit on one, and a conditional section is drawn as an amber
outline because it is not always there. Central structures differ by family —
MongoDB is loose faceted documents, ClickHouse is uneven columns, the
relational engines are stacked platters.

**Depth is disclosed, not implied.** The section *inventory* is verified for
every engine. Per-section internals were traced exhaustively for PostgreSQL
only, and every other engine's panels say so.

## Bespoke environments

Eleven PostgreSQL sections have a purpose-built 3D environment: Overview,
Performance, Slow Queries, Query Analysis, Users, Replication, Storage, Locks,
Error Logs, Tables and Indexes. The remaining six (Queries, Databases, Config,
Maintenance, Reports and Diagnose) use a generic environment built from that
section's *own* monitored-signal list, so it still differs per feature — the
panel marks which sections have a bespoke scene.

The **guided tour** is ten chapters with Pause, Resume, Next, Previous and
Exit. It plays automatically and you can take control at any point.

## Accuracy

Every capability described was read out of this repository before it was
written down, and each node names the file it came from. Nodes are classified:

| Mark | Meaning |
|---|---|
| **Implemented** | Route, service and UI all exist and were read |
| **Partial** | Works through another code path, or only part is wired |
| **No data source yet** | The UI accepts it; the backend cannot supply it |
| **Illustrative** | An invented example, so the page is explorable offline |
| **Not implemented** | Verified absent |

Things the document says plainly rather than omitting:

- **Google Cloud Platform is not implemented.** `Backend/cloud/app/providers`
  contains `aws`, `azure` and `oci` only.
- **Redis is not a monitored database technology.** It appears in the codebase
  as ACTMON's own hot metrics tier, and as an Azure resource the scanner
  inventories. Neither is database monitoring.
- **MariaDB is partial** — accepted by the agent collector and handled through
  the MySQL code path, with no dashboard route of its own.
- **25 of 43 alert rule types have no data source yet.** That is the product's
  own classification from `config/alertCatalog.js`, not an outside judgement.

## Sample mode

All metrics, hostnames, queries, log lines and topologies are illustrative.
Nothing is read from a live ACTMON installation, and nothing in these files is
or resembles a credential.

## Testing

Three suites, run with `node`:

- `test_envs.js` — builds all 22 environments against a THREE stub: every one
  has a camera pose, zoom limits, clickable objects, **and a provably distinct
  composition** (object count, geometry mix and layout shape). Also checks that
  data really drives geometry.
- `test_doc.js` — 72 assertions driving the document in jsdom (2D fallback path)
- `test_accept.js` — the 14 acceptance tests, with the 3D path active
- `test_engines.js` — per-engine: tab counts match the nav configs, vocabulary
  is preserved, every section explains itself, each engine builds a distinct
  environment, conditional sections are marked

## Known limitations

- **The rendered result has not been seen.** There is no browser automation
  available here and jsdom has no WebGL, so geometry, lighting, camera feel and
  label placement are untested visually. Everything behind them is tested.
- Verified against the `actmon_sept22` branch. It will drift as the product
  changes; `actmon-data.js` records a source path per node so re-checking is
  mechanical.
- Per-engine depth was traced exhaustively for PostgreSQL. The other seven are
  documented at section level: the list is verified, the descriptions explain
  what each section is for rather than every control inside it.
- `Reports` and `Diagnose` are confirmed as registered PostgreSQL tabs; their
  internal depth was not exhaustively traced, and the document says so.
- Cost-API coverage is described from each provider's capability declaration
  rather than from a live billing call.
