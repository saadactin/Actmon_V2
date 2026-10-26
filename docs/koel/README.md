# KOEL — interactive 3D architecture documentation

Two pages, same content. Double-click either; no server, no build step, no
install.

| File | What it is |
|---|---|
| **`koel-3d-explorer.html`** | The explorer: a full-screen 3D model you descend through, with detail in a side panel. Start here. |
| `koel-architecture.html` | The same content as a document you scroll, with the 3D as a header — clicking a node scrolls the page to its entry. |

## The levels

| Level | What it shows |
|---|---|
| **Estate** | The whole hybrid estate over a slowly turning Earth. Three platforms, left to right in the order data travels, every connection between them named and arrowheaded |
| **Third-party ecosystem** | All 18 feeds on a two-column board, each with its own name and protocol, converging on one integration server |
| **On-premises data centre** | Two bands: the two components the diagram connects, and the five it draws nothing to (ringed) |
| **Oracle Cloud Infrastructure** | Three decks — public DMZ, private core, Siebel stack — with all 15 components in single rows and every internal edge captioned |
| **Siebel stack** | Five columns, one per tier, where the height of each column is its count |
| **Data flows** | All eight connections as an ordered list: name, endpoints, and one arrowhead or two |

**About the globe.** The Earth is a setting, not a map. The diagram names no
country, region or data-centre site anywhere, so nothing on it should be read as
a location — the platforms are placed left to right in the order data travels,
and that is all the arrangement means.

**Reading a connection.** Every link carries its name in the scene. One
arrowhead means the diagram draws one direction; two facing apart mean it draws
both. On the connections level, a red ring means the diagram draws no
alternative path.

**Controls (explorer).** Drag to orbit · scroll to zoom · shift-drag to pan ·
click to select · <kbd>Enter</kbd> to descend · <kbd>Backspace</kbd> to go back ·
<kbd>T</kbd> tour · <kbd>F</kbd> 2D index · <kbd>/</kbd> search · <kbd>?</kbd>
for the full key list.

Without WebGL the explorer switches to its 2D index by itself, and the document
turns its header into a row of buttons that do the same job. Nothing in the
content depends on the 3D working.

## Where the content comes from

**One source: the draw.io diagram `KOEL_ARCHITECTURE1.1`.** No repository,
configuration file or running system was inspected, and nothing was assumed.

Because of that, every statement carries a label saying how it is known:

| Label | Meaning |
|---|---|
| On the diagram | Literally in the file — a node, a label, or an edge |
| Implied by the diagram | Follows necessarily from what is drawn |
| Product knowledge, not KOEL-specific | True of Oracle ERP / Siebel / an HSM in general; not a statement about KOEL's configuration |
| Not answered by the diagram | A gap, listed so it can be asked rather than guessed |

The **"What the diagram does not say"** section collects eight such gaps along
with who would be able to answer each one. The **"Where monitoring would go"**
section is explicitly marked as a proposal — it is the only part of the
document that is an opinion rather than a transcription.

No IP address, hostname, credential or connection string appears anywhere in
these files, and the test suite checks that on every run.

## Files

```
koel-3d-explorer.html    the explorer — start here
koel-architecture.html   the same content as a scrolling document
koel-data.js             the transcription: every node, edge and label
koel-scene.js            the 3D engine, including the globe
koel-envs.js             one scene builder per explorable level
koel-app.js              the explorer: levels, panel, tour, search, 2D index
koel-page.js             the document: sections and page behaviour
test_koel.js             scene + transcription suite
test_explorer.js         explorer page suite
```

All of them must stay in the same folder. `docs/koel-docs/` is the shareable
copy of the same thing, with the modules moved into `interactive/`.

## Tests

```
node test_koel.js        65 checks — the transcription, the 3D levels and the globe
node test_explorer.js    90 checks — the explorer page, its chrome and its legibility
```

Between them: the transcription is complete and internally consistent; every
level builds, is interactive, and has a composition unlike every other level;
every level is viewed broadside rather than down its own length; every
connection carries a caption and an arrowhead; no count is written out by hand
where the data owns it; every object reaches both the panel and the 2D index and
is findable by its exact name; all ten tour chapters run without error; the
explorer kept every control the ACTMON explorer it was derived from has; and no
address or credential was invented.

Both suites need `jsdom`, resolved from `../../frontend/node_modules`.
