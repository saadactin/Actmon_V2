# ACTMON — Interactive Platform Documentation

An explorable 3D map of the ACTMON platform, for customer demonstrations and
internal technical documentation.

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
| `index.html` | Page shell, styles and all UI chrome |
| `actmon-data.js` | The content model — every fact, with the source file it came from |
| `actmon-app.js` | 3D scene, navigation, panels, search and the guided tour |
| `README.md` | This file |

To correct or extend the content, edit `actmon-data.js` only. It is plain data
and needs no knowledge of the 3D code.

## Using it

Start at the platform overview and click into whatever you want to see. The
breadcrumb across the top is the navigation — clicking any earlier step returns
you there.

| Control | Does |
|---|---|
| Click a node | Zoom into it and open its panel |
| Drag | Orbit the camera |
| Scroll | Zoom (clamped, so the camera cannot get lost) |
| Breadcrumb | Jump back to any level |
| Back / Forward | Step through history |
| Reset / the ACTMON mark | Return to the overview |
| Search | Every module, technology, section, provider and channel |
| Guided tour | 11 chapters, pausable — explore freely at any point |
| 2D view | The same content as a flat, keyboard-navigable list |
| Reduce motion | Makes every transition instant |

**Keyboard:** `0` reset · `Backspace` back · `T` tour · `F` 2D view ·
`M` reduce motion · `/` search · `Esc` close · `?` key help.

Honours `prefers-reduced-motion` automatically.

## What is in it

- **Level 0** — the seven monitoring domains
- **Level 1** — each domain's own exploration (technologies, cloud providers,
  host tabs, collection methods, alert tiers, the permission model)
- **Level 2** — the eight database technology entries, with a capability
  comparison
- **Level 3** — all 16 PostgreSQL dashboard tabs plus the Query Analysis
  detail page
- **Level 4** — per feature: what it does, why it matters, what it monitors,
  sample data, an operational scenario, how a DBA uses it, and its relations
- **Three guided walkthroughs** — investigating a slow query, inspecting a
  role's effective privileges, and the incident lifecycle

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

## Known limitations

- Verified against the `actmon_sept22` branch. It will drift as the product
  changes; `actmon-data.js` records a source path per node so re-checking is
  mechanical.
- Per-engine depth was traced exhaustively for PostgreSQL. The other six
  engines are documented at dashboard level.
- `Reports` and `Diagnose` are confirmed as registered PostgreSQL tabs; their
  internal depth was not exhaustively traced, and the document says so.
- Cost-API coverage is described from each provider's capability declaration
  rather than from a live billing call.
