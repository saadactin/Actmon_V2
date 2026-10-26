# KOEL — interactive architecture documentation

Two views of the same content. Double-click either; no server, no build step,
no install.

| File | What it is |
|---|---|
| **`koel-3d-explorer.html`** | An explorable 3D model of the estate. Start here. |
| `koel-doc.html` | The same content as a document you scroll, with the 3D as a header. |

Both load their modules from `interactive/`, so keep the folder together.

---

## The explorer

Six levels. Each is a different scene, because the estate really does nest
that way.

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

**Controls**

| | |
|---|---|
| Drag / scroll / shift-drag | Look around · zoom · pan |
| Click | Select — detail opens in the right-hand panel |
| <kbd>Enter</kbd> | Descend into the selection |
| <kbd>Backspace</kbd> | Back up a level |
| <kbd>T</kbd> | Guided tour — ten chapters, pausable, leave at any point |
| <kbd>F</kbd> | 2D index: every object as a flat list, no WebGL required |
| <kbd>/</kbd> | Search |
| <kbd>M</kbd> · <kbd>0</kbd> · <kbd>?</kbd> | Reduce motion · reset · key list |

Without WebGL the page switches to the 2D index by itself and says so. Nothing
in the content depends on the 3D working.

---

## What the estate contains

**Third-party ecosystem — 18 feeds.** Six are banks (YesBankPayment, Axis, SBI,
Federal, YES Bank Bulk Sync, ICICI), the largest single category and the one
with the least tolerance for a missed file. Five transport shapes in all:
HTTP/s, SFTP, API/SFTP, "Locus SFTP", and one webhook. Two vendors appear twice
— Taxilla over both HTTP/s and SFTP, Locus directly and again behind MRC
Dispatch — so counting vendors rather than feeds gives sixteen.

**On-premises data centre — 7 components.** Internal AD, the edge firewall, the
VPN gateway, the Integration Server (the SFTP mount point every feed lands on),
a SQL Server cluster, the Discoverer legacy BI engine, and the PLM database.

**Oracle Cloud Infrastructure — 10 components in one VCN.** Public subnet: the
DRG/VPN gateway and a public load balancer. Private subnet: the Oracle ERP
application server, the 2-node RAC database, APEX Extensions, BI Publisher, the
LGM Webtel HSM, Oracle Data Integrator, the Autonomous Data Warehouse and its
APEX analytics layer.

**Siebel Cloud CRM stack — 12 servers.** 3 gateways, 2 web servers, 4 app
servers, 1 BIP server and 2 dedicated database systems, drawn as a block inside
the private subnet.

**Eight connections**, including the single encrypted IPsec/MACsec tunnel that
joins the data centre to the cloud.

---

## Provenance — read this before quoting anything

This documentation has exactly **one source**: the draw.io diagram
`KOEL_ARCHITECTURE1.1`. No repository, configuration file or running system was
inspected. Component names are reproduced exactly as that diagram writes them.

Every statement therefore carries one of four labels, shown in the explorer's
legend:

| Label | Meaning |
|---|---|
| **On the diagram** | Literally in the file — a node, a label, or an edge |
| **Implied by the diagram** | Follows necessarily from what is drawn |
| **Product knowledge, not KOEL-specific** | True of Oracle ERP, Siebel or an HSM in general; **not** a statement about KOEL's configuration |
| **Not answered by the diagram** | A gap, listed so it can be asked rather than guessed |

**"What the diagram does not say"** collects eight such gaps with who could
close each one — what the public load balancer fronts, whether the 18 feeds
traverse the edge firewall, whether the ERP application tier really is a single
node, what reads the SQL Server cluster and the PLM database, what calls the
HSM, whether the SFTP bridge crosses the VPN tunnel, whether AD is federated to
OCI IAM, and what the recovery position is.

**"Where monitoring would go"** is the only opinion in the document, and is
marked as a proposal everywhere it appears.

No IP address, hostname, credential or connection string appears anywhere in
these files. None was available, and none was invented — the test suite checks
this on every run.

---

## Verification

The working copy of these files (`docs/koel/`) carries two suites:

```
node test_koel.js        65 checks — the transcription, the 3D levels and the globe
node test_explorer.js    90 checks — the explorer page, its chrome and its legibility
```

Between them they prove: the transcription is complete and internally
consistent; every level builds, is interactive, and has a composition unlike
every other level; every object in the data reaches both the panel and the 2D
index; every object is findable by its exact name in search; all ten tour
chapters run without error; this page kept every control the ACTMON explorer it
was derived from has; and no address or credential was introduced.

Both suites need `jsdom`, resolved from the project's `frontend/node_modules`.
