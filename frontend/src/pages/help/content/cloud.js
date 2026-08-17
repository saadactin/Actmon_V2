/**
 * Cloud Monitoring chapter. Grounded in features/cloud/* and pages/cosmosdb/*.
 * AWS, Azure, and OCI are all real, fully-wired providers — not stubs. GCP is
 * genuinely absent (no schema fields, no SDK, no UI) and is documented as such.
 */
import { DOCS, icon } from '../helpContent';

export const CLOUD_TOPICS = [
  ['cld-overview', 'Cloud Overview'],
  ['cld-providers', 'Supported Providers'],
  ['cld-add-account', 'Adding a Cloud Account'],
  ['cld-dashboard-tabs', 'Cloud Account Dashboard'],
  ['cld-cost', 'Cost Monitoring'],
  ['cld-cosmosdb', 'Cosmos DB'],
  ['cld-permissions', 'Permissions'],
  ['cld-troubleshooting', 'Troubleshooting'],
  ['cld-reference', 'Cloud Reference'],
];

DOCS['cld-overview'] = {
  title: 'Cloud Overview',
  dek: 'What the Cloud module monitors, and which providers are actually implemented.',
  crumbs: ['ActMon Documentation', 'Cloud', 'Overview'],
  module: 'Cloud', status: 'Complete',
  body: `
    <p>The Cloud module discovers and monitors resources across public cloud provider accounts you connect —
    compute, storage, databases, networking, and more — plus their cost, security posture, topology, and
    compliance mapping. It is reached from the top navigation bar's <b>Cloud</b> item, routed to
    <code>/cloud</code>.</p>
    <div class="tip"><b>What's actually implemented</b>${icon('tip', 14)}<span><b>AWS</b>, <b>Azure</b>, and
    <b>OCI</b> (Oracle Cloud Infrastructure) are all real, fully-wired providers — genuine discovery, resource
    inventory, cost data, security findings, and topology graphs, not placeholders. <b>GCP is not implemented</b>
    anywhere in the codebase — no schema field, no SDK usage, no form. If you're looking for GCP monitoring, it
    does not currently exist in ActMon.</span></div>
    <p>Azure Cosmos DB is monitored as its own separate module (not through a Cloud provider account) — see
    <button onclick="go('cld-cosmosdb')" style="all:unset;cursor:pointer;color:var(--accent-ink);text-decoration:underline">Cosmos DB</button>
    below.</p>
    <h2>Key facts</h2>
    <ul>
      <li>Adding an account does <em>not</em> require a separate "Test Connection" step — credentials are
      validated live against the provider when the account is created.</li>
      <li>Discovery is a distinct, explicitly-triggered step from connecting the account — connecting an account
      does not automatically scan it unless you check "Enable Auto-Discovery."</li>
      <li>Cost data distinguishes real billed spend from an estimate, and says so on screen — it never silently
      presents an estimate as a real bill.</li>
      <li>There is no AI/LLM integration anywhere in the Cloud module — its "Diagnostics" explainer is a static,
      rule-based lookup table, not an AI call.</li>
    </ul>
  `,
};

DOCS['cld-providers'] = {
  title: 'Supported Providers',
  dek: 'AWS, Azure, and OCI resource types actually discovered and shown.',
  crumbs: ['ActMon Documentation', 'Cloud', 'Supported Providers'],
  module: 'Cloud', status: 'Complete',
  body: `
    <p>Every provider account flows through the same discovery → resources → cost → security → topology →
    compliance → alerts pipeline. Resource-type coverage is genuinely broad, not a token handful of types:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Provider</th><th>Representative resource types actually modeled</th></tr>
      <tr><td>AWS</td><td>EC2 Instance, S3 Bucket, Lambda Function, DynamoDB Table, RDS Instance, EKS Cluster, Load Balancer, Security Group, VPC, IAM Role, API Gateway, Bedrock Model/Agent/Knowledge Base</td></tr>
      <tr><td>Azure</td><td>Virtual Machine, Storage Account, SQL Database/Server, AKS Cluster, App Service, Function App, Virtual Network, NSG, Public IP, Resource Group, Managed Disk, Key Vault, Cosmos DB, Redis Cache, MySQL/PostgreSQL Server, Container Registry, Application Gateway, Log Analytics, App Insights, Logic App, Event Hub, Service Bus, API Management, VM Scale Set, Recovery Vault, and more</td></tr>
      <tr><td>OCI</td><td>Compute Instance, Block Volume, Object Storage Bucket, Autonomous Database, VCN, Function, OKE Cluster, IAM Group/Policy, Compartment</td></tr>
    </table></div>
    <p>Resources with a dedicated detail layout (Instance Type, AMI, Billing Mode, Item Count, Engine/Version,
    Multi-AZ, Kubernetes version, and similar type-specific fields) include EC2 Instance, S3 Bucket, Lambda
    Function, DynamoDB Table, RDS Instance, EKS Cluster, and Load Balancer — anything else falls back to a
    generic configuration dump so it's still viewable, just less curated.</p>
  `,
};

DOCS['cld-add-account'] = {
  title: 'Adding a Cloud Account',
  dek: 'The credential fields per provider, and every button on the account-list page.',
  crumbs: ['ActMon Documentation', 'Cloud', 'Adding a Cloud Account'],
  module: 'Cloud', status: 'Complete',
  body: `
    <h2>Add Account form</h2>
    <p>Choose a provider (AWS / Azure / OCI), then fill in: Profile Name (Alias), Environment
    (Production/Staging/Development), a region/tenant field (label varies by provider), the provider's own
    credential fields, and an <b>"Enable Auto-Discovery after connecting"</b> checkbox.</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Provider</th><th>Credential fields</th></tr>
      <tr><td>AWS</td><td>Access Key ID, Secret Access Key</td></tr>
      <tr><td>Azure</td><td>Tenant ID, Client ID, Client Secret, Subscription ID</td></tr>
      <tr><td>OCI</td><td>Tenancy OCID, User OCID, Fingerprint, Private Key Content (pasted), optional Passphrase</td></tr>
    </table></div>
    <p>Submitting reads <b>"Add Account"</b> (becomes "Connecting…" while pending). On success, a toast confirms
    "Cloud account added successfully" and you land on the new account's dashboard.</p>
    <div class="tip"><b>No separate Test Connection button</b>${icon('tip', 14)}<span>Unlike a database
    connection form, credentials are validated by actually attempting to use them when the account is created —
    there's no dedicated Test step first. If the credentials are invalid, account creation itself fails.</span></div>

    <h2>Account list actions</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Button</th><th>What it does</th></tr>
      <tr><td>Run discovery scan (refresh icon)</td><td>Triggers a fresh resource-discovery job for that account.</td></tr>
      <tr><td>Delete account (trash icon)</td><td>Removes the account immediately — no confirm dialog before the delete fires.</td></tr>
    </table></div>
    <p>Status badges are computed server-side from the last scan: <span class="pill good">Online</span>,
    <span class="pill neutral">Scanning</span>, <span class="pill neutral">Not Scanned</span>,
    <span class="pill crit">Offline</span>. A <b>"Why?"</b> link opens a diagnostics popup categorizing common
    scan failures (Credentials Issue, Permission Denied, Network Error, No Data From Provider, Never Scanned,
    Scan Failed) with a concrete suggested fix for each — for example, a credentials issue suggests deleting and
    re-adding the account with fresh, valid credentials.</p>
    <div class="imp"><b>Delete has no confirmation</b>${icon('alerts', 14)}<span>Clicking the trash icon on the
    account list removes the account immediately — there is no "are you sure?" dialog. Make sure you mean it
    before clicking.</span></div>
  `,
};

DOCS['cld-dashboard-tabs'] = {
  title: 'Cloud Account Dashboard',
  dek: 'The seven real tabs on a connected cloud account\'s dashboard.',
  crumbs: ['ActMon Documentation', 'Cloud', 'Cloud Account Dashboard'],
  module: 'Cloud', status: 'Complete',
  body: `
    <p>Every connected account (AWS/Azure/OCI) opens a dashboard with seven tabs — all real, none a "coming
    soon" placeholder:</p>
    <div class="tblwrap"><table class="doc">
      <tr><th>Tab</th><th>What it shows</th></tr>
      <tr><td>Overview</td><td>Stat cards (Total Resources, Monthly Cost, Security Health, Last Scan), a resource-type pie chart, a region breakdown bar chart, account health, and recently-discovered resources.</td></tr>
      <tr><td>Resources</td><td>Full resource inventory table, a "Run Discovery Scan" trigger (button reads "Scan Running…" while active), and an account summary.</td></tr>
      <tr><td>Cost</td><td>Real spend data — see <button onclick="go('cld-cost')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Cost Monitoring</button>.</td></tr>
      <tr><td>Security</td><td>A findings list plus a severity gauge, with a "Scan Now" button to re-run the posture read.</td></tr>
      <tr><td>Topology</td><td>An interactive, pan/zoomable SVG dependency graph of discovered resources.</td></tr>
      <tr><td>Compliance</td><td>Control-violation mapping against SOC 2, HIPAA, and PCI-DSS frameworks.</td></tr>
      <tr><td>Alerts</td><td>Polls the cloud alerts feed every 10 seconds.</td></tr>
    </table></div>
    <p>Every tab has a genuine empty state (e.g. <em>"No resources discovered yet. Run a discovery scan
    first."</em>) rather than stub content — a tab with nothing in it is telling you to run discovery, not
    telling you the feature doesn't exist.</p>
    <div class="warnbox"><b>No AI in the Cloud module</b>${icon('alerts', 14)}<span>There is no AI/LLM-backed
    feature anywhere in Cloud — the account-level "Why?" diagnostics popup is a static, hardcoded lookup table of
    category → suggested fix, not an AI call. If you're looking for an AI explanation of a cloud finding, it does
    not exist here (compare to Cosmos DB's "Actmon AI" tab, which is a genuine AI feature — see
    <button onclick="go('cld-cosmosdb')" style="all:unset;cursor:pointer;color:var(--fg)">Cosmos DB</button>).</span></div>
  `,
};

DOCS['cld-cost'] = {
  title: 'Cost Monitoring',
  dek: 'Real billed spend vs. an estimate — and why ActMon is explicit about which one you\'re looking at.',
  crumbs: ['ActMon Documentation', 'Cloud', 'Cost Monitoring'],
  module: 'Cloud', status: 'Complete',
  body: `
    <p>Cost is genuine, provider-sourced data, not a flat placeholder — but ActMon is deliberately explicit about
    <em>which kind</em> of number you're looking at:</p>
    <ul>
      <li>When the provider's billing API genuinely returned data, the header reads <b>"Billed Spend (Last 30
      Days)"</b>.</li>
      <li>When it didn't (billing API unavailable, insufficient permission, etc.), the header instead reads
      <b>"Monthly Spend"</b> with the note <em>"No billing data is available for this account"</em> and a
      <b>"Why?"</b> diagnostic link explaining the gap.</li>
    </ul>
    <p>Shown metrics: Projected/Billed Spend, Potential Savings, Optimized Net Spend, a 30-day spend trend chart,
    a <b>"Stopped Instances — Last 30 Days Billing"</b> table (breaking out the instance's own cost from its
    attached-storage cost), and <b>"Actionable Cost Optimization Recommendations"</b> — rule-based findings such
    as stopped compute or databases still incurring storage cost, idle clusters, and unattached load balancers,
    each linking to the specific resource.</p>
    <div class="tip"><b>Explicit self-disclosure of scope</b>${icon('tip', 14)}<span>The page states directly:
    <em>"This is a configuration-based check, not a guarantee of full optimization: usage-based rightsizing and
    rupee savings estimates are not yet wired up."</em> Treat recommendations as a starting list to investigate,
    not a guaranteed savings figure.</span></div>
    <p>A <b>"Download Report"</b> button opens a cross-provider, per-service, up-to-365-day cost report. No
    currency is ever guessed — if the provider doesn't supply one, the report shows <code>currency: NA</code>
    rather than assuming a symbol.</p>
  `,
};

DOCS['cld-cosmosdb'] = {
  title: 'Cosmos DB',
  dek: 'What ActMon can and cannot see for Azure Cosmos DB without Azure Monitor.',
  crumbs: ['ActMon Documentation', 'Cloud', 'Cosmos DB'],
  module: 'Cloud', status: 'Complete',
  body: `
    <p>Cosmos DB is monitored as its own module — reached via <code>/cosmosdb-servers</code> →
    <code>/cosmosdb-dashboard/:id</code> — not as a resource type inside a Cloud provider account. It has eight
    tabs: <b>Overview, Databases, Containers, Documents, Indexing, Slow Calls, Errors, Actmon AI</b>.</p>
    <h2>What's genuinely real</h2>
    <div class="tblwrap"><table class="doc">
      <tr><th>Area</th><th>What's real</th></tr>
      <tr><td>Connection</td><td>Real Test/Edit buttons; a live "Test connection" + "Save changes" edit page.</td></tr>
      <tr><td>Databases / Containers</td><td>Real listing with per-database rollups (container count, document count, storage, throughput); a container's storage/doc-count is only read once you open it, since every read costs Request Units (RU).</td></tr>
      <tr><td>Documents</td><td>Real browsing with continuation-token paging (Cosmos has no page numbers), JSON/CSV export, an ad-hoc WHERE filter, and a click-only "Count now" button — a cross-partition COUNT has a real RU cost, so it never runs automatically.</td></tr>
      <tr><td>Partition key / Indexing policy</td><td>Real, read from container metadata — mode, automatic on/off, included/excluded paths, composite/spatial/vector indexes, unique keys, each annotated with a plain-English "Buys you:" / "Costs you:" line.</td></tr>
      <tr><td>RU consumption</td><td>Real — every logged call's actual Request Charge, plus a per-call RU trend chart.</td></tr>
      <tr><td>Throughput</td><td>Real, or an explicit "Serverless" label when the account has no provisioned floor.</td></tr>
    </table></div>
    <h2>Available through ActMon vs. requires external configuration</h2>
    <div class="warnbox"><b>Everything shown is ActMon's own call log</b>${icon('alerts', 14)}<span>The Overview
    tab states this directly: <em>"These trends are ActMon's own calls, not your application's traffic. Cosmos
    exposes no free server-side metrics, so every line below is derived from the calls ActMon itself made to this
    account."</em> ActMon does not currently integrate with Azure Monitor.</span></div>
    <p>Several metrics are explicitly marked <b>"Not available from this connection"</b> rather than faked, each
    with the real reason and what would be needed:</p>
    <ul>
      <li><b>Average / largest document size</b> — would require a full container scan (real RU cost).</li>
      <li><b>Per-partition distribution</b> — the public SDK doesn't expose physical partition key ranges; needs
      Azure Monitor or the Azure portal's own partition-key statistics.</li>
      <li><b>Write counts (inserts/updates/deletes)</b> — ActMon only ever reads; needs the change feed or Azure
      Monitor.</li>
      <li><b>Index utilization, RU savings estimate, missing/unused indexes, retrieved-vs-returned ratio, retry
      count</b> — need query-level diagnostics or Azure Monitor.</li>
    </ul>
    <h2>Actmon AI tab — genuinely real</h2>
    <p>Unlike the rest of the Cloud module, Cosmos DB does have a real AI feature. The <b>Actmon AI</b> tab reads
    real data (the container's health/policies, sibling containers, a bounded sample of actual documents, the RU
    and latency history, and recent errors) and produces an analysis. The Indexing tab has its own scoped
    "Analyse indexing" version, and Slow Calls / Errors rows each have a per-row <b>"Explain"</b> button — "Why
    this call was slow" / "What went wrong."</p>
  `,
};

DOCS['cld-permissions'] = {
  title: 'Permissions',
  dek: 'What access is actually checked before a Cloud module action runs.',
  crumbs: ['ActMon Documentation', 'Cloud', 'Permissions'],
  module: 'Cloud', status: 'Complete',
  body: `
    <p>Account-list row actions (Run discovery scan, Delete account) are gated client-side by the standard
    <code>view</code>/<code>execute</code> permission check (<code>canHere</code>), same pattern as the rest of
    the app. The Resources tab's own "Run Discovery Scan" trigger requires the <code>execute</code> permission.</p>
    <div class="warnbox"><b>Verify, don't assume</b>${icon('alerts', 14)}<span>As with several other modules in
    this documentation, frontend permission gating controls what's <em>shown</em>, not necessarily what the
    backend will accept — always confirm real access requirements against your own role assignment rather than
    assuming a hidden button also means a blocked API call.</span></div>
  `,
};

DOCS['cld-troubleshooting'] = {
  title: 'Troubleshooting',
  dek: 'Practical answers for common Cloud module problems.',
  crumbs: ['ActMon Documentation', 'Cloud', 'Troubleshooting'],
  module: 'Cloud', status: 'Complete',
  body: `
    <h2>Account shows "Offline" / scan keeps failing</h2>
    <p><b>Symptoms:</b> Account status badge reads <span class="pill crit">Offline</span>, or a discovery scan
    consistently fails.</p>
    <p><b>How to verify:</b> Click the account's <b>"Why?"</b> link — the diagnostics popup names the actual
    category (Credentials Issue, Permission Denied, Network Error, No Data From Provider, Never Scanned, Scan
    Failed).</p>
    <p><b>Resolution:</b> For a Credentials Issue specifically, the recommended fix is to delete the account and
    re-add it with fresh, valid credentials rather than trying to edit in place (there is currently no in-place
    credential-update flow for a cloud account). For Permission Denied, check that the IAM role/service
    principal/policy attached to those credentials actually grants read access to the resource types you expect
    to see.</p>

    <h2>Cost tab shows "No billing data is available"</h2>
    <p><b>Cause:</b> The provider's billing API didn't return data for this account — usually a permissions gap
    (the credentials can list resources but can't read cost/billing data) or a genuinely new account with no
    billing history yet.</p>
    <p><b>Resolution:</b> Grant the credentials billing-read access at the provider (e.g. AWS Cost Explorer
    permissions, Azure Cost Management Reader role), then revisit the Cost tab — it will switch to "Billed Spend"
    automatically once real data is available.</p>

    <h2>Resources tab is empty after adding an account</h2>
    <p><b>Cause:</b> Connecting an account does not automatically scan it unless "Enable Auto-Discovery" was
    checked at creation time.</p>
    <p><b>Resolution:</b> Run a discovery scan manually — either the refresh icon on the account list, or the
    "Run Discovery Scan" button on the Resources tab itself.</p>
  `,
};

DOCS['cld-reference'] = {
  title: 'Cloud Reference',
  dek: 'Consolidated reference — routes, providers, and tab structure.',
  crumbs: ['ActMon Documentation', 'Cloud', 'Reference'],
  module: 'Cloud', status: 'Complete',
  body: `
    <div class="tblwrap"><table class="doc">
      <tr><th>Route</th><th>What it renders</th></tr>
      <tr><td><code>/cloud</code></td><td>Provider chooser / accounts overview</td></tr>
      <tr><td><code>/cloud/accounts</code></td><td>Cloud accounts list</td></tr>
      <tr><td><code>/cloud/{provider}-accounts</code></td><td>Per-provider accounts list (aws / azure / oci)</td></tr>
      <tr><td><code>/cloud/{provider}-accounts/:accountId[/:tab]</code></td><td>Account dashboard — 7 tabs, see <button onclick="go('cld-dashboard-tabs')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Cloud Account Dashboard</button></td></tr>
      <tr><td><code>/cloud/resources/:resourceId[/:tab]</code></td><td>A single discovered resource's detail page</td></tr>
      <tr><td><code>/cosmosdb-servers</code></td><td>Cosmos DB connections list</td></tr>
      <tr><td><code>/cosmosdb-dashboard/:id[/:tab]</code></td><td>Cosmos DB dashboard — 8 tabs</td></tr>
      <tr><td><code>/cosmosdb-edit/:id</code></td><td>Edit a Cosmos DB connection</td></tr>
    </table></div>
    <p>Providers: AWS, Azure, OCI — real. GCP — not implemented. Cross-references:
    <button onclick="go('dbm-cosmosdb')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Cosmos DB (Database module entry)</button>,
    <button onclick="go('cld-troubleshooting')" style="all:unset;cursor:pointer;color:var(--accent-ink)">Troubleshooting</button>.</p>
  `,
};
