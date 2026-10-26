/* ===========================================================================
   KOEL — Enterprise Oracle ERP & Siebel Hybrid Cloud Architecture
   Content model, transcribed from the architecture diagram.

   PROVENANCE, AND IT MATTERS MORE HERE THAN USUAL.

   The ACTMON documentation this is modelled on was built by reading a
   codebase. This one has exactly ONE source: the draw.io diagram
   KOEL_ARCHITECTURE1.1. No repository, no configuration, no running system
   was inspected.

   So every node below carries its label EXACTLY as the diagram writes it,
   and every claim is classified:

     diagram   stated on the diagram — the node, its label, its connection
     implied   follows necessarily from what the diagram shows (e.g. an SFTP
               feed must reach the SFTP mount point, because that is the only
               thing it is drawn connecting to)
     context   general knowledge about the named technology, true of Oracle
               ERP or Siebel in general, NOT a statement about this estate
     unknown   a question the diagram does not answer, listed so it can be
               asked rather than guessed

   Nothing is marked `diagram` unless it is literally in the XML. Where this
   document explains what a component is FOR, that is `context` and is
   labelled as such — it describes the product, not KOEL's configuration.
   =========================================================================== */

const META = {
  title: 'KOEL',
  subtitle: 'Enterprise Oracle ERP & Siebel hybrid cloud architecture',
  source: 'Transcribed from KOEL_ARCHITECTURE1.1 (draw.io)',
  disclaimer:
    'Built from one architecture diagram. No codebase, configuration or running system was inspected. '
    + 'Every component name is reproduced exactly as the diagram writes it; anything beyond that is '
    + 'labelled by how it is known.',
};

const CLASS = {
  diagram: { label: 'On the diagram', cls: 'ok' },
  implied: { label: 'Implied by the diagram', cls: 'info' },
  context: { label: 'Product knowledge, not KOEL-specific', cls: 'warn' },
  unknown: { label: 'Not answered by the diagram', cls: 'grey' },
};

/* ── the three zones ─────────────────────────────────────────────────── */
const ZONES = [
  {
    id: 'thirdparty',
    label: 'Third-Party Integration Ecosystem',
    diagramLabel: 'THIRD-PARTY INTEGRATION ECOSYSTEM\n18 External Data Ingestion & Processing Feeds',
    color: 0x3b82f6,
    angle: 180,
    what: 'Eighteen external systems that send data into KOEL — banks, tax gateways, logistics, '
        + 'expense and reconciliation platforms.',
    why: 'This is the estate\'s attack surface and its most common source of operational incidents: '
       + 'every one of these is a third party whose availability and format changes KOEL does not control.',
    cls: 'diagram',
  },
  {
    id: 'onprem',
    label: 'On-Premises Data Centre',
    diagramLabel: 'ON-PREMISES DATA CENTER\nKOEL Internal Network',
    color: 0x64748b,
    angle: 300,
    what: 'KOEL\'s own network: identity, edge security, the integration landing zone, and two '
        + 'databases that stayed on site.',
    why: 'The hybrid half. Everything arriving from outside lands here first, and two systems — SQL Server '
       + 'and the PLM database — were not moved to the cloud.',
    cls: 'diagram',
  },
  {
    id: 'oci',
    label: 'Oracle Cloud Infrastructure',
    diagramLabel: 'ORACLE CLOUD INFRASTRUCTURE (OCI REGION)\nProduction Cloud Workloads',
    color: 0xc74634,
    angle: 60,
    what: 'One OCI region holding the production workloads: Oracle ERP, the Siebel CRM stack, '
        + 'the analytics warehouse and the integration tooling, inside a single VCN.',
    why: 'This is where the business actually runs. The subnet split is the security boundary.',
    cls: 'diagram',
  },
];

/* ── 18 third-party feeds, exactly as labelled ───────────────────────── */
const FEEDS = [
  { n: 'YesBankPayment', p: 'HTTP/s', kind: 'bank' },
  { n: 'Axis Bank', p: 'HTTP/s', kind: 'bank' },
  { n: 'Taxilla Tax Gateway', p: 'HTTP/s', kind: 'tax' },
  { n: 'Arka Webhooks', p: 'Webhook', kind: 'event' },
  { n: 'CASHFLO AP Automation', p: 'HTTP/s', kind: 'finance' },
  { n: 'Locus Logistics', p: 'API / SFTP', kind: 'logistics' },
  { n: 'Cyronic Data Feed', p: 'SFTP', kind: 'data' },
  { n: 'MRC Dispatch', p: 'Locus SFTP', kind: 'logistics' },
  { n: 'SBI Bank Gateway', p: 'SFTP', kind: 'bank' },
  { n: 'TaxillaLgm Portal', p: 'SFTP', kind: 'tax' },
  { n: 'UGC Integration', p: 'SFTP', kind: 'data' },
  { n: 'Federal Bank Gateway', p: 'SFTP', kind: 'bank' },
  { n: 'YES Bank Bulk Sync', p: 'SFTP', kind: 'bank' },
  { n: 'FantailP Setup Engine', p: 'SFTP', kind: 'data' },
  { n: 'ICICI Bank API', p: 'HTTP/s', kind: 'bank' },
  { n: 'Q2T Reconciliation', p: 'SFTP', kind: 'finance' },
  { n: 'Happay Expense Management', p: 'SFTP', kind: 'finance' },
  { n: 'KPQSUM Ledger Sync', p: 'SFTP', kind: 'finance' },
];

const FEED_KINDS = {
  bank: { label: 'Banking', color: 0x2563eb, note: 'Six of the eighteen feeds are banks — the single largest category.' },
  tax: { label: 'Tax & statutory', color: 0x7c3aed, note: 'Taxilla appears twice: once over HTTP/s and once as an SFTP portal.' },
  finance: { label: 'Finance operations', color: 0x0891b2, note: 'Payables, expenses, reconciliation and ledger synchronisation.' },
  logistics: { label: 'Logistics', color: 0xea580c, note: 'Locus appears twice — directly, and behind MRC Dispatch.' },
  event: { label: 'Event-driven', color: 0xdb2777, note: 'Arka is the only webhook: it pushes, where everything else is fetched or dropped.' },
  data: { label: 'Data feeds', color: 0x059669, note: 'General data ingestion over SFTP.' },
};

/* ── on-premises components ──────────────────────────────────────────── */
const ONPREM = [
  {
    id: 'ad', label: 'Internal AD', sub: 'Identity & Access Manager', geo: 'shield', color: 0x64748b,
    what: 'Active Directory, named on the diagram as the identity and access manager for the internal network.',
    why: 'Whatever authenticates to the on-prem side authenticates here.',
    cls: 'diagram',
    unknown: ['Whether OCI workloads federate to this AD, or OCI IAM is separate — the diagram draws no link between them.'],
  },
  {
    id: 'firewall', label: 'Edge Firewall', sub: 'Inspection & Security Rules', geo: 'wall', color: 0xdc2626,
    what: 'The inspection and rule-enforcement point at the network edge.',
    why: 'Sits between the outside world and everything internal.',
    cls: 'diagram',
    unknown: ['Whether the 18 third-party feeds traverse this firewall before reaching the Integration Server. '
            + 'The diagram draws the feeds straight to the Integration Server and does not route them through it.'],
  },
  {
    id: 'onprem_vpn', label: 'On-Prem VPN Gateway', sub: 'IPsec / MACsec Encrypted Tunnel', geo: 'gateway', color: 0xf59e0b,
    what: 'The on-premises end of the encrypted tunnel to OCI.',
    why: 'This is the single link between KOEL\'s data centre and its cloud region. It carries everything '
       + 'that crosses between them.',
    cls: 'diagram',
    critical: 'Drawn as one tunnel between one on-prem gateway and one OCI gateway. The diagram shows no '
            + 'second path, so on this picture it is a single point of failure for all hybrid traffic.',
  },
  {
    id: 'sftp', label: 'Integration Server — SFTP Mount Point', geo: 'hub', color: 0x0284c7,
    sub: 'Mounted via SFTP to Oracle ERP App Node · Central Ingestion Hub for All 18 Feeds',
    what: 'The landing zone. The diagram calls it the central ingestion hub for all eighteen feeds, and says '
        + 'it is mounted via SFTP to the Oracle ERP application node.',
    why: 'Every external feed converges here, and from here one bridge carries them into the ERP. It is the '
       + 'busiest junction on the diagram.',
    cls: 'diagram',
    critical: 'Eighteen inbound feeds and one outbound bridge. Everything external enters the estate through '
            + 'this one component — which makes it both the natural place to monitor ingestion and the place '
            + 'where a failure stops all eighteen at once.',
  },
  {
    id: 'sqlserver', label: 'SQL Server Cluster', sub: 'Internal DB (HA)', geo: 'database', color: 0x64748b,
    what: 'An internal SQL Server cluster, marked HA on the diagram.',
    why: 'One of two databases that remained on premises.',
    cls: 'diagram',
    unknown: ['What it holds, and what reads it. The diagram draws no connection from it to anything else.'],
  },
  {
    id: 'discoverer', label: 'Discoverer Engine', sub: 'Legacy BI & Reporting', geo: 'rack', color: 0x64748b,
    what: 'Oracle Discoverer, labelled on the diagram as legacy BI and reporting.',
    why: 'The diagram\'s own word is "legacy". Oracle Discoverer has been out of premier support for years, '
       + 'so its presence alongside a modern ADW suggests reporting that has not yet been migrated.',
    cls: 'diagram',
    contextNote: 'That Discoverer is an end-of-life Oracle product is general knowledge, not something the '
               + 'diagram states. The diagram says only "Legacy BI & Reporting".',
    unknown: ['What it reports against, and whether it is still in active use.'],
  },
  {
    id: 'plm', label: 'PLM Database', sub: 'Product Lifecycle Management On-Premises DB', geo: 'database', color: 0x9333ea,
    what: 'The product lifecycle management database, kept on premises.',
    why: 'For an engine manufacturer, PLM holds the design and engineering record — often the hardest system '
       + 'to move because of its integrations with CAD and shop-floor tooling.',
    cls: 'diagram',
    contextNote: 'The reason PLM systems typically stay on premises is context, not a KOEL statement.',
    unknown: ['Whether PLM exchanges data with the ERP. The diagram draws no edge from it.'],
  },
];

/* ── OCI: public subnet ──────────────────────────────────────────────── */
const PUBLIC_SUBNET = [
  {
    id: 'oci_vpn', label: 'OCI DRG / VPN Gateway', geo: 'gateway', color: 0xf59e0b,
    what: 'The cloud end of the encrypted tunnel. DRG is OCI\'s Dynamic Routing Gateway.',
    why: 'Pairs with the on-prem VPN gateway to form the hybrid link.',
    cls: 'diagram',
  },
  {
    id: 'lb', label: 'OCI Public Load Balancer', geo: 'lb', color: 0x0284c7,
    what: 'A public load balancer in the DMZ edge tier.',
    why: 'The only component the diagram places on the public side besides the gateway, so it is the '
       + 'intended entry point for anything reaching the estate from the internet.',
    cls: 'diagram',
    unknown: ['What it fronts. The diagram draws no edge from the load balancer to any backend — a notable '
            + 'gap, because that edge is what would tell you whether it serves ERP, Siebel, or both.'],
  },
];

/* ── OCI: private subnet ─────────────────────────────────────────────── */
const PRIVATE_SUBNET = [
  {
    id: 'erp_app', label: 'Oracle ERP Application Server', sub: '(Single Compute Node)', geo: 'rack', color: 0x16a34a,
    what: 'The ERP application tier, drawn as a single compute node.',
    why: 'This is the system of record\'s front half, and it is the component the SFTP mount bridges into.',
    cls: 'diagram',
    critical: 'The diagram says "Single Compute Node" explicitly. Beside it, the database is a 2-node RAC and '
            + 'Siebel runs 3 gateways, 2 web and 4 app servers. The application tier of the ERP is the one '
            + 'production component drawn without redundancy.',
  },
  {
    id: 'erp_db', label: 'Oracle ERP Database System', sub: '(2-Node RAC + DBCLI)', geo: 'database', color: 0x16a34a,
    what: 'The ERP database, drawn as a two-node Real Application Clusters configuration, with RAC 1 and '
        + 'RAC 2 shown as separate nodes.',
    why: 'RAC gives the database tier both high availability and horizontal scale within the cluster.',
    cls: 'diagram',
    nodes: ['RAC 1', 'RAC 2'],
    contextNote: 'What RAC provides is context. The diagram states the topology, not its behaviour.',
  },
  {
    id: 'apex', label: 'Oracle APEX Extensions', geo: 'slab', color: 0x0284c7,
    what: 'Oracle Application Express, labelled as extensions.',
    why: 'APEX is typically where bespoke screens and small applications are built alongside a packaged ERP '
       + 'without modifying it.',
    cls: 'diagram',
    contextNote: 'The role of APEX is context; the diagram gives only the name.',
  },
  {
    id: 'bip', label: 'Oracle BI Publisher (BIP)', geo: 'slab', color: 0x0284c7,
    what: 'Oracle BI Publisher — the ERP\'s reporting and document generation engine.',
    why: 'Generates the formatted output of the ERP: invoices, statements, statutory documents.',
    cls: 'diagram',
    contextNote: 'What BIP does is context. Note there is a second BIP inside the Siebel stack.',
  },
  {
    id: 'lgm', label: 'LGM Webtel Digital Signature', sub: 'HSM Security Module', geo: 'shield', color: 0x9333ea,
    what: 'A digital signature module, identified on the diagram as an HSM.',
    why: 'An HSM holds signing keys in tamper-resistant hardware. Drawn spanning the full width of the private '
       + 'subnet, which suggests it is available to the tier rather than bound to one application.',
    cls: 'diagram',
    contextNote: 'That an HSM protects keys in hardware is context. Its full-width placement is on the diagram; '
               + 'what consumes it is not drawn.',
    unknown: ['Which systems call it. No edges are drawn to or from it.'],
  },
  {
    id: 'odi', label: 'Oracle Data Integrator (ODI)', geo: 'hub', color: 0xea580c,
    what: 'Oracle\'s ETL and data integration platform.',
    why: 'The diagram gives it two roles: it runs the ETL pipeline into the warehouse, and the Siebel-to-ADW '
       + 'sync is labelled as going via ODI.',
    cls: 'diagram',
  },
  {
    id: 'adw', label: 'Autonomous Data Warehouse (ADW)', geo: 'database', color: 0x9333ea,
    what: 'Oracle\'s managed analytics warehouse.',
    why: 'The analytical destination. Two arrows feed it — the ODI ETL pipeline and the Siebel sync — and one '
       + 'leaves it, to its own APEX layer.',
    cls: 'diagram',
  },
  {
    id: 'adw_apex', label: 'ADW Analytics APEX', geo: 'slab', color: 0x9333ea,
    what: 'An APEX layer sitting on the warehouse.',
    why: 'The presentation end of the analytics path: the diagram\'s only component downstream of the ADW.',
    cls: 'diagram',
  },
];

/* ── Siebel stack ────────────────────────────────────────────────────── */
const SIEBEL = [
  { id: 'siebel_gtw', label: '3x Siebel Gateway', count: 3, geo: 'gateway', color: 0xd97706,
    what: 'Three Siebel gateway servers.',
    why: 'The gateway holds the enterprise configuration and name server for the Siebel deployment.',
    cls: 'diagram', contextNote: 'The gateway\'s role is context; the count of three is on the diagram.' },
  { id: 'siebel_web', label: '2x Siebel Web Server', count: 2, geo: 'rack', color: 0xd97706,
    what: 'Two Siebel web servers.',
    why: 'The web tier serving the Siebel UI.',
    cls: 'diagram' },
  { id: 'siebel_app', label: '4x Siebel App Server', count: 4, geo: 'rack', color: 0xd97706,
    what: 'Four Siebel application servers — the largest component count in the estate.',
    why: 'The object managers and business logic run here. Four of them is where the CRM workload sits.',
    cls: 'diagram' },
  { id: 'siebel_bip', label: '1x Siebel BIP Server', count: 1, geo: 'slab', color: 0xd97706,
    what: 'A BI Publisher server dedicated to Siebel.',
    why: 'Siebel\'s own reporting, separate from the ERP\'s BIP.',
    cls: 'diagram',
    note: 'This is the second BI Publisher on the diagram. The ERP has its own. Two BIP installations means '
        + 'two report estates to maintain and patch.' },
  { id: 'siebel_db', label: '2x Siebel Dedicated Database System', sub: '(OCI Instance)', count: 2,
    geo: 'database', color: 0x16a34a,
    what: 'Two dedicated database systems for Siebel, on OCI instances.',
    why: 'Siebel keeps its own database rather than sharing the ERP\'s — and the diagram draws a direct '
       + 'link between the two.',
    cls: 'diagram' },
];

/* ── the edges, exactly as drawn ─────────────────────────────────────── */
const FLOWS = [
  {
    id: 'ingest', label: '18 Ingestion Feeds Stream',
    from: 'Third-Party Integration Ecosystem', to: 'Integration Server (SFTP Mount Point)',
    dir: 'one-way', style: 'animated', cls: 'diagram',
    what: 'All eighteen external feeds converge on the integration server.',
    why: 'This is the estate\'s front door. Mixed protocols — HTTP/s, SFTP and one webhook — all terminate '
       + 'at a single component.',
  },
  {
    id: 'tunnel', label: 'Encrypted IPsec / MACsec Backbone',
    from: 'On-Prem VPN Gateway', to: 'OCI DRG / VPN Gateway',
    dir: 'bidirectional', style: 'animated', cls: 'diagram',
    what: 'The hybrid link, drawn with arrows at both ends.',
    why: 'Everything that crosses between the data centre and the cloud uses this one tunnel.',
    critical: true,
  },
  {
    id: 'sftp_bridge', label: 'Direct SFTP Mount Bridge',
    from: 'Integration Server (SFTP Mount Point)', to: 'Oracle ERP Application Server',
    dir: 'one-way', style: 'animated', cls: 'diagram',
    what: 'The integration server is mounted into the ERP application node over SFTP.',
    why: 'This is how external data gets from the landing zone into the ERP — and the diagram draws it as a '
       + 'mount, not a message queue or an API.',
    note: 'Drawn as crossing from the on-premises column to the OCI private subnet. The diagram does not show '
        + 'it routed through the VPN tunnel, though physically it would have to traverse the hybrid link.',
  },
  {
    id: 'app_db', label: 'App-DB Connection',
    from: 'Oracle ERP Application Server', to: 'Oracle ERP Database System',
    dir: 'bidirectional', style: 'animated', cls: 'diagram',
    what: 'The ERP application tier to its database.',
    why: 'The hottest path in the estate — every ERP transaction uses it.',
  },
  {
    id: 'erp_siebel', label: 'Cross-System Inter-DB Connectivity',
    from: 'Oracle ERP Database System', to: '2x Siebel Dedicated Database System',
    dir: 'bidirectional', style: 'animated', cls: 'diagram',
    what: 'A direct, two-way link between the ERP database and the Siebel database.',
    why: 'ERP and CRM share data at the database layer rather than only through an integration tier.',
    note: 'Database-to-database coupling between two packaged applications is worth understanding carefully: '
        + 'it creates a dependency that neither product\'s upgrade process accounts for. The diagram states the '
        + 'link exists; it does not say what crosses it or in which direction each dataset flows.',
  },
  {
    id: 'odi_adw', label: 'ETL Pipeline',
    from: 'Oracle Data Integrator (ODI)', to: 'Autonomous Data Warehouse (ADW)',
    dir: 'one-way', style: 'animated', cls: 'diagram',
    what: 'ODI loads the warehouse.',
    why: 'The main analytical load path.',
  },
  {
    id: 'siebel_adw', label: 'Siebel to ADW Sync (via ODI)',
    from: '2x Siebel Dedicated Database System', to: 'Autonomous Data Warehouse (ADW)',
    dir: 'one-way', style: 'animated', cls: 'diagram',
    what: 'CRM data reaching the warehouse, routed through ODI.',
    why: 'Puts Siebel data alongside ERP data for analysis.',
  },
  {
    id: 'adw_apex_edge', label: 'ADW to Analytics APEX',
    from: 'Autonomous Data Warehouse (ADW)', to: 'ADW Analytics APEX',
    dir: 'one-way', style: 'animated', cls: 'diagram',
    what: 'The warehouse feeding its APEX presentation layer.',
    why: 'Where analytical output is surfaced to users.',
  },
];

/* ── what the diagram does not say ───────────────────────────────────── */
const OPEN_QUESTIONS = [
  { q: 'What does the public load balancer front?',
    why: 'No edge leaves it. Without that, the diagram does not show how users reach either ERP or Siebel.',
    ask: 'Whoever owns the OCI networking configuration.' },
  { q: 'Do the 18 third-party feeds pass through the edge firewall?',
    why: 'They are drawn straight to the Integration Server, bypassing the firewall on the picture.',
    ask: 'Network security — this is either a drawing simplification or a real gap.' },
  { q: 'Is the ERP application tier really a single node?',
    why: 'The diagram says "Single Compute Node" while every neighbouring tier is redundant.',
    ask: 'Infrastructure owner — confirm whether this is current and intended.' },
  { q: 'What reads the on-prem SQL Server cluster and the PLM database?',
    why: 'Neither has a single edge drawn to it, yet both are production systems.',
    ask: 'Application owners for each.' },
  { q: 'What calls the LGM Webtel HSM?',
    why: 'Drawn spanning the private subnet but with no connections.',
    ask: 'Whoever owns digital signing — likely finance or statutory reporting.' },
  { q: 'Does the SFTP mount bridge traverse the VPN tunnel?',
    why: 'It is drawn crossing directly from on-prem to the OCI private subnet without passing through either gateway.',
    ask: 'Network owner — the physical path matters for both latency and failure modes.' },
  { q: 'Is the AD federated to OCI IAM?',
    why: 'Internal AD is drawn on-premises with no link to anything in OCI.',
    ask: 'Identity owner.' },
  { q: 'What is the recovery position?',
    why: 'The diagram shows one OCI region and no standby, backup or DR target anywhere.',
    ask: 'Whoever owns business continuity.' },
];

/* ── observations that follow from the diagram itself ────────────────── */
const OBSERVATIONS = [
  { sev: 'high', title: 'One tunnel joins the two halves of the estate',
    detail: 'The on-prem VPN gateway and the OCI DRG are drawn as a single encrypted path with no second '
          + 'route beside it. On this picture, everything hybrid stops if that tunnel stops.',
    evidence: 'Edge "Encrypted IPsec / MACsec Backbone", drawn once between two gateways.',
    cls: 'implied' },
  { sev: 'high', title: 'The ERP application tier is the one component drawn without redundancy',
    detail: 'Its own label says "Single Compute Node". The ERP database beside it is 2-node RAC, Siebel runs '
          + '3 gateways, 2 web servers and 4 app servers, and the Siebel database is doubled.',
    evidence: 'Node label "Oracle ERP Application Server (Single Compute Node)".',
    cls: 'diagram' },
  { sev: 'high', title: 'Eighteen feeds converge on one integration server',
    detail: 'The diagram calls it the central ingestion hub for all eighteen. It is the right place to '
          + 'instrument ingestion, and also the place where one failure stops every feed at once.',
    evidence: 'Node label, plus the single "18 Ingestion Feeds Stream" edge into it.',
    cls: 'diagram' },
  { sev: 'medium', title: 'ERP and Siebel are coupled at the database layer',
    detail: 'A direct two-way link between the two product databases, rather than integration through an '
          + 'application or messaging tier. Upgrades to either product have to account for the other.',
    evidence: 'Edge "Cross-System Inter-DB Connectivity".',
    cls: 'diagram' },
  { sev: 'medium', title: 'Two separate BI Publisher installations',
    detail: 'One in the ERP tier, one inside the Siebel stack. Two report estates, two patch cycles, two '
          + 'sets of templates.',
    evidence: 'Nodes "Oracle BI Publisher (BIP)" and "1x Siebel BIP Server".',
    cls: 'diagram' },
  { sev: 'medium', title: 'Legacy reporting still on premises alongside a modern warehouse',
    detail: 'Discoverer is labelled "Legacy BI & Reporting" and sits in the data centre while an Autonomous '
          + 'Data Warehouse with its own APEX layer runs in OCI. That is two reporting worlds at once.',
    evidence: 'Node "Discoverer Engine — Legacy BI & Reporting".',
    cls: 'diagram' },
  { sev: 'low', title: 'Three isolated components',
    detail: 'The SQL Server cluster, the PLM database and the LGM HSM have no edges drawn at all, and the '
          + 'public load balancer has none leaving it. Four components whose place in the flow is undrawn.',
    evidence: 'Absence of edges in the diagram XML.',
    cls: 'implied' },
  { sev: 'low', title: 'Six of eighteen feeds are banks',
    detail: 'YesBank, Axis, SBI, Federal, YES Bulk Sync and ICICI. Banking is the largest single feed '
          + 'category, and the one with the least tolerance for a missed file.',
    evidence: 'Feed labels in the third-party column.',
    cls: 'diagram' },
];

window.KOEL = {
  META, CLASS, ZONES, FEEDS, FEED_KINDS, ONPREM,
  PUBLIC_SUBNET, PRIVATE_SUBNET, SIEBEL, FLOWS, OPEN_QUESTIONS, OBSERVATIONS,
};
