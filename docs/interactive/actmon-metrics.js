/* ===========================================================================
   DASHBOARD METRIC DICTIONARY — traced from the UI label to the calculation
   to the data source, with the file and line for every claim.

   Method: each metric was followed from its JSX in Dashboard.jsx, through
   useDashboardData.js, to the API call, to the backend field. Nothing here is
   inferred from a label. Where the trace stopped, `status: 'unverified'` says
   where it stopped and what to read next.

   The `findings` on several metrics are real discrepancies found during the
   trace, not hypotheticals. They are stated because a dashboard number that
   means something slightly different from its label is exactly what causes an
   operator to make a wrong call at 3am.

   Status values:
     verified    traced end to end in the source
     partial     traced to the frontend, backend write path not fully followed
     unverified  could not establish; the file to read is named
   =========================================================================== */

const METRIC_SOURCES = {
  dashboard: 'frontend/src/pages/Dashboard.jsx',
  hook: 'frontend/src/hooks/useDashboardData.js',
  serversApi: 'frontend/src/api/servers.js',
  infraDetail: 'Backend/database/app/services/os_server/infra_detail_service.py',
  agentService: 'Backend/database/app/services/agent/agent_service.py',
};

/** Shared by the three gauges — they differ only in which column they read. */
function resourceGauge(label, field, column, extra) {
  return Object.assign({
    id: 'avg-' + field,
    label: label,
    group: 'resources',
    status: 'verified',

    business:
      'How hard the monitored host estate is working right now, as one number. It answers "is anything '
      + 'under strain" at a glance, before anyone opens a specific host.',

    technical:
      'The unweighted arithmetic mean of the latest ' + column + ' reading of every host in the host list '
      + 'whose reading parses to a number greater than zero.',

    scope:
      'Operating-system hosts from GET /os-servers/ — the same list the Infrastructure page shows. It is '
      + 'a HOST metric, not a database metric and not a cloud metric. A database server appears here only '
      + 'because its host is registered as an OS host; the database engine\'s own CPU is not what is measured.',

    source: 'os_servers.' + column + ', served by GET /os-servers/ (' + METRIC_SOURCES.serversApi + ':17).',

    collection:
      'The agent (or the SSH collector, which runs the same commands) pushes a host snapshot. '
      + '_live_cols_from_snapshot() derives the column from it and writes it back onto the OsServer row '
      + '(' + METRIC_SOURCES.infraDetail + ':601-613).',

    formula:
      'mean( hosts.map(h => parseFloat(h.' + column + ')).filter(v => v > 0) )\n'
      + '  where mean(a) = Math.round( sum(a) / a.length )',

    formulaRef: METRIC_SOURCES.hook + ':141-144, with mean() at :23 and the parse at :19',

    units: 'Percent, integer, 0-100.',

    window:
      'None. This is the latest stored reading per host, not an average over time. The dashboard re-reads '
      + 'the host list every 60 s; the reading itself is refreshed whenever the agent pushes (roughly every '
      + '15-30 s per the note at ' + METRIC_SOURCES.agentService + ':307).',

    aggregation: 'Simple arithmetic mean across hosts. Not weighted by core count, memory size or disk size.',

    interpretation: [
      ['Normal', 'Depends entirely on the estate. A fleet of application servers sitting at 20-40 % is ordinary.'],
      ['Elevated', 'A rising trend matters more than any single value. One busy host can move a small fleet\'s mean a long way.'],
      ['0 %', 'Means NO host reported a usable reading — not that the fleet is idle. A genuinely idle host is excluded by the > 0 filter, so it cannot pull the mean down.'],
      ['Unavailable', 'The gauge shows 0 when the host list is empty or every reading failed to parse. It does not distinguish the two.'],
    ],

    example:
      'ILLUSTRATIVE. Three hosts report "20%", "40%" and "60%"; a fourth reports "N/A" and a fifth "0%".\n'
      + '  parseFloat gives 20, 40, 60, 0 (N/A is not finite, so num() returns 0), 0\n'
      + '  the > 0 filter keeps  20, 40, 60       — the two zeros are dropped\n'
      + '  mean = round((20 + 40 + 60) / 3) = 40\n'
      + 'The gauge shows 40 %. Note the denominator is 3, not 5.',

    verify:
      'Open Infrastructure, read the CPU column for every host, drop any that are blank, "N/A" or 0, and '
      + 'average what remains. Or call GET /os-servers/ and compute it from the JSON — the field is a string '
      + 'with a percent sign, so strip it before averaging.',

    troubleshooting: [
      'Gauge reads 0 with hosts present — check that the agent is pushing infra snapshots, not only database metrics. The column is written by the infra push path, not by the DB collector.',
      'Gauge looks too high — check for offline hosts. Their last reading is still counted (see the finding below).',
      'Gauge does not change — the host list is cached for 60 s; the Refresh control in the page header invalidates it immediately.',
      'One host missing from the average — its reading is 0, "N/A", null, or a string parseFloat cannot read.',
    ],

    evidence: [
      METRIC_SOURCES.dashboard + ':265-267 — the three GaugeCards',
      METRIC_SOURCES.hook + ':140-145 — the resources object',
      METRIC_SOURCES.hook + ':19-23 — num() and mean()',
      METRIC_SOURCES.infraDetail + ':601-613 — _live_cols_from_snapshot',
    ],
  }, extra || {});
}

const AVG_CPU_FINDINGS = [
  {
    severity: 'high',
    title: 'Offline hosts are included in the average, but excluded from the chart beside it',
    detail:
      'The "busiest hosts by CPU" list filters to hosts whose status is good or warning, with an explicit '
      + 'comment that an offline host\'s cpu_usage is "whatever was last reported before they stopped '
      + 'reporting — frozen, not live". The three gauges apply NO status filter at all. A host that went '
      + 'offline last week at 95 % still contributes 95 % to Avg. CPU Usage, while being deliberately kept '
      + 'out of the list immediately below it.',
    evidence: METRIC_SOURCES.hook + ':158 (filtered) versus :141-143 (not filtered)',
    impact: 'The headline gauge can read higher than the live fleet actually is, and the two panels disagree.',
  },
  {
    severity: 'medium',
    title: 'A genuinely idle host is dropped, which biases the mean upward',
    detail:
      'The > 0 filter exists to exclude hosts that never reported. It cannot tell those apart from a host '
      + 'that correctly reported 0 %. Both are removed from numerator and denominator alike.',
    evidence: METRIC_SOURCES.hook + ':141-143',
    impact: 'On an estate with idle hosts, the average is higher than the true fleet mean.',
  },
  {
    severity: 'low',
    title: 'The value is rounded twice',
    detail:
      'The backend rounds to a whole percent before storing it as a string ("76%"), and mean() rounds '
      + 'again after averaging. Sub-percent precision is gone before the average is taken.',
    evidence: METRIC_SOURCES.infraDetail + ':609 and ' + METRIC_SOURCES.hook + ':23',
    impact: 'Negligible operationally; worth knowing if the number is being reconciled against another tool.',
  },
  {
    severity: 'low',
    title: 'The mean is unweighted',
    detail: 'A 2-core host and a 64-core host contribute equally. This is an average of percentages, not of capacity.',
    evidence: METRIC_SOURCES.hook + ':23',
    impact: 'On a mixed estate the number describes "how loaded is a typical host", not "how loaded is the fleet".',
  },
];

const METRICS = [
  /* ── headline counts ──────────────────────────────────────────────────── */
  {
    id: 'database-server', label: 'Database Server', group: 'counts', status: 'verified',
    business: 'How many monitored hosts are running a database engine, and how many of those engines are actually up.',
    technical:
      'A count of HOSTS that run at least one recognised database engine, bucketed by that host\'s rolled-up '
      + 'database service status rather than by its network reachability.',
    scope:
      'Hosts, not database connections and not database instances. A host running three MySQL instances '
      + 'counts once. The tile\'s label says "Server", and that is accurate — but it is easy to read as '
      + '"databases".',
    source: 'GET /os-servers/ — each host carries db_instances[] and a rolled-up db_status.',
    collection: 'Host records are maintained by the agent or SSH collector; db_status is the backend\'s own blend of the host\'s instance statuses (Running / Degraded / Stopped / Unknown).',
    formula:
      'dbHosts = hosts.filter(h => any DB_TECH runs on h)\n'
      + 'databases = tallyBy(dbHosts, h => h.db_status)\n'
      + '  total   = dbHosts.length\n'
      + '  Online  = the "good" bucket\n'
      + '  Offline = the "critical" bucket',
    formulaRef: METRIC_SOURCES.hook + ':131-137',
    units: 'Count of hosts.',
    window: 'Latest state. Host list refreshed every 60 s.',
    aggregation: 'Bucketed by db_status, not by host connectivity.',
    interpretation: [
      ['Online', 'The database service on that host is running.'],
      ['Offline', 'The service is stopped — note the HOST may still be perfectly reachable.'],
      ['0 total', 'No registered host has a recognised database engine on it.'],
    ],
    example:
      'ILLUSTRATIVE. Four hosts run MySQL. Three report Running, one reports Stopped. The tile shows 4, '
      + 'with "3 Online   1 Offline". The stopped one may still answer a ping — host reachability and '
      + 'service state are different things, and this tile tracks the service.',
    verify: 'Open Database, count the hosts, and check each engine\'s service state on the host itself (systemctl status, SC query).',
    troubleshooting: [
      'A host you expect is missing — ACTMON did not recognise an engine on it. Check db_instances on that host record.',
      'Counts disagree with the Database page — that page may list connections rather than hosts.',
    ],
    evidence: [METRIC_SOURCES.dashboard + ':226-230', METRIC_SOURCES.hook + ':131-137'],
    findings: [{
      severity: 'medium',
      title: 'The tile counts hosts, while the word "Server" invites reading it as databases',
      detail: 'A host with three database instances contributes 1, not 3. Operators comparing this against an inventory of database instances will find a mismatch that is not a fault.',
      evidence: METRIC_SOURCES.hook + ':136-137',
      impact: 'Mis-set expectations when reconciling against a CMDB.',
    }],
  },

  {
    id: 'infra-hosts', label: 'Infra Hosts', group: 'counts', status: 'verified',
    business: 'How many operating-system hosts are registered, and what share of them are healthy.',
    technical: 'Total host count with a health percentage derived from the connected share.',
    scope: 'All registered OS hosts, whichever way they are collected — agent or SSH.',
    source:
      'Two sources, in order of preference: GET /os-servers/summary when it answers, falling back to a '
      + 'local tally of GET /os-servers/. The comment is explicit that the summary endpoint is authoritative '
      + 'and the list is the fallback "so the tiles still populate if only one of the two answers".',
    collection: 'Host status is maintained by the collector heartbeat.',
    formula:
      'total    = summary.total      ?? localTally.total\n'
      + 'good     = summary.connected  ?? localTally.good\n'
      + 'warning  = summary.warning    ?? localTally.warning\n'
      + 'critical = summary.disconnected ?? (localTally.critical + localTally.unknown)\n'
      + 'health   = total ? round(good / total * 100) : 0',
    formulaRef: METRIC_SOURCES.hook + ':115-124',
    units: 'Count, plus a percentage.',
    window: 'Latest state. Summary refreshed every 30 s, host list every 60 s.',
    aggregation: 'Share of hosts in the connected bucket.',
    interpretation: [
      ['100 %', 'Every host is connected.'],
      ['Below 90 %', 'The tile turns amber.'],
      ['Below 60 %', 'The tile turns red.'],
      ['0 with hosts present', 'No host is connected — usually a network or credential problem affecting all of them.'],
    ],
    example: 'ILLUSTRATIVE. 10 hosts, 9 connected → 90 % Healthy, and the tile is still green at exactly 90.',
    verify: 'Open Infrastructure and count hosts by status.',
    troubleshooting: [
      'Percentage disagrees with the host list — the summary endpoint answered and the list did not, or they are refreshed on different intervals (30 s vs 60 s) and you caught them mid-cycle.',
    ],
    evidence: [METRIC_SOURCES.dashboard + ':231-235', METRIC_SOURCES.hook + ':112-125'],
    findings: [{
      severity: 'low',
      title: 'Two sources on different refresh intervals can disagree briefly',
      detail: 'The summary endpoint refreshes every 30 s and the host list every 60 s. Between the two, the tile\'s total can momentarily disagree with the Infrastructure page.',
      evidence: METRIC_SOURCES.hook + ':54',
      impact: 'Transient and self-correcting; worth knowing before chasing it as a bug.',
    }],
  },

  {
    id: 'cloud-accounts', label: 'Cloud Accounts', group: 'counts', status: 'verified',
    business: 'How many cloud accounts are registered for discovery.',
    technical: 'The length of the cloud account list, with providers summarised beneath.',
    scope:
      'Registered ACCOUNTS. Not resources, not monitored resources, not active resources. An account with '
      + 'ten thousand discovered resources counts as one.',
    source: 'The cloud microservice, via listCloudAccounts.',
    collection: 'Accounts are registered by a user with credentials; the scanner then walks their regions.',
    formula: 'total = cloud.length\nbyProvider = count of accounts grouped by provider, descending',
    formulaRef: METRIC_SOURCES.hook + ':228-239',
    units: 'Count of accounts.',
    window: 'Latest state. Refreshed every 60 s.',
    aggregation: 'Count and group-by.',
    interpretation: [
      ['A number', 'That many accounts are registered.'],
      ['None connected', 'Genuinely zero accounts registered.'],
      ['Cloud service unavailable', 'The cloud microservice did not answer. This is deliberately NOT shown as zero — the code comments that a failure "must never render identically to genuinely zero cloud accounts".'],
      ['—', 'Shown in place of a count when the service is unreachable.'],
    ],
    example: 'ILLUSTRATIVE. Two AWS accounts and one Azure → tile reads 3, subtitle "AWS AZURE".',
    verify: 'Open Cloud and count the registered accounts.',
    troubleshooting: [
      'Tile shows "Cloud service unavailable" — the cloud microservice is down or unreachable. The rest of the dashboard is unaffected; the hook treats cloud as non-essential (hasCoreData ignores it).',
    ],
    evidence: [METRIC_SOURCES.dashboard + ':236-240', METRIC_SOURCES.hook + ':228-239, :258-262'],
  },

  {
    id: 'agents', label: 'Agents', group: 'counts', status: 'verified',
    business: 'How many real agent processes are installed on monitored hosts.',
    technical: 'Hosts whose collector field is exactly "agent", tallied by status.',
    scope:
      'Installed agent processes — one per host. NOT database connections. The code carries an explicit '
      + 'note that the /agents/ endpoint returns one row per connection, so an org monitoring six hosts over '
      + 'SSH plus one real agent install "showed 13 agents instead of the 1 that\'s real". The tile '
      + 'deliberately uses os_servers.collector instead.',
    source: 'GET /os-servers/, field `collector`.',
    collection: 'Set when the host is enrolled.',
    formula: 'tally( hosts.filter(h => h.collector === "agent") )',
    formulaRef: METRIC_SOURCES.hook + ':198',
    units: 'Count of hosts.',
    window: 'Latest state. Refreshed every 60 s with the host list.',
    aggregation: 'Count by status bucket.',
    interpretation: [
      ['Online', 'The agent is reporting.'],
      ['Tile amber', 'At least one agent is in the critical bucket.'],
      ['0', 'No host uses agent collection — the estate may be entirely SSH or direct.'],
    ],
    example: 'ILLUSTRATIVE. Seven hosts registered, one with an installed agent → tile reads 1, not 7.',
    verify: 'Open Agents; or check the collector column on each host in Infrastructure.',
    troubleshooting: [
      'Count differs from the Agents page — that page lists one row per connection; this tile counts installed agents. They answer different questions and are both right.',
    ],
    evidence: [METRIC_SOURCES.dashboard + ':241-245', METRIC_SOURCES.hook + ':193-198'],
  },

  {
    id: 'ssh-hosts', label: 'SSH Hosts', group: 'counts', status: 'verified',
    business: 'How many hosts are collected over SSH rather than by an installed agent.',
    technical: 'Hosts whose collector field is exactly "ssh", tallied by status.',
    scope: 'OS hosts only.',
    source: 'GET /os-servers/, field `collector`.',
    collection: 'Set when the host is registered with SSH credentials.',
    formula: 'tally( hosts.filter(h => h.collector === "ssh") )',
    formulaRef: METRIC_SOURCES.hook + ':200',
    units: 'Count of hosts.',
    window: 'Latest state, refreshed every 60 s.',
    aggregation: 'Count by status bucket.',
    interpretation: [['Online', 'The SSH collection succeeded most recently.'], ['0', 'No host uses SSH collection.']],
    example: 'ILLUSTRATIVE. Six SSH hosts, all reachable → tile reads 6, "6 Online".',
    verify: 'Check the collector column in Infrastructure.',
    troubleshooting: ['A host counted in neither Agents nor SSH Hosts has a collector value that is neither — check the host record.'],
    evidence: [METRIC_SOURCES.dashboard + ':246-250', METRIC_SOURCES.hook + ':200'],
  },

  {
    id: 'active-alerts', label: 'Active Alerts', group: 'counts', status: 'verified',
    business: 'How many alerts are firing right now, split by how serious they are.',
    technical: 'The length of the active-alert list, with a per-severity tally.',
    scope: 'Currently active alerts across every monitored resource.',
    source: 'listActiveAlerts.',
    collection: 'The alert engine evaluates rules against collected data. Whether a given rule CAN fire depends on its evaluation tier — see the Alerts domain.',
    formula:
      'total = alerts.length\n'
      + 'bySeverity = count grouped by severityOf(a.severity) into critical / warning / info',
    formulaRef: METRIC_SOURCES.hook + ':202-226',
    units: 'Count.',
    window: 'Current. Refreshed every 15 s — the fastest feed on the dashboard.',
    aggregation: 'Count and group-by severity.',
    interpretation: [
      ['Red tile', 'At least one critical alert.'],
      ['Amber tile', 'Warnings but no criticals.'],
      ['0', 'Nothing is firing — which is not the same as nothing being wrong. 25 of 43 rule types have no data source yet and cannot fire at all.'],
    ],
    example: 'ILLUSTRATIVE. 3 alerts: 1 critical, 2 warning → tile reads 3, "1 Critical   2 Warning".',
    verify: 'Open Alerts and count.',
    troubleshooting: [
      'An expected alert never fires — check its evaluation tier. A rule in the "no data source yet" tier is saved and looks configured but the backend cannot raise it.',
    ],
    evidence: [METRIC_SOURCES.dashboard + ':251-258', METRIC_SOURCES.hook + ':202-226'],
    findings: [{
      severity: 'high',
      title: 'Zero active alerts does not mean everything is covered',
      detail:
        'Of 43 rule types in the catalogue, 5 are checked live, 13 are agent-reported and 25 have no data '
        + 'source yet. A rule in that last tier can be created, saved and shown as configured, and will '
        + 'never fire. The product surfaces this tier in its own UI for exactly this reason.',
      evidence: 'frontend/src/config/alertCatalog.js — EVALUATION and the per-rule evaluation field',
      impact: 'An empty Active Alerts tile can reflect missing coverage rather than a healthy estate.',
    }],
  },

  /* ── gauges ───────────────────────────────────────────────────────────── */
  resourceGauge('Avg. CPU Usage', 'cpu', 'cpu_usage', { findings: AVG_CPU_FINDINGS }),
  resourceGauge('Avg. Memory Usage', 'ram', 'ram_usage', {
    business: 'How much of the monitored hosts\' memory is in use, averaged across the estate.',
    findings: [AVG_CPU_FINDINGS[0], AVG_CPU_FINDINGS[1], AVG_CPU_FINDINGS[3]],
    note: 'Memory pressure behaves differently from CPU: a host at 90 % memory is usually closer to trouble than a host at 90 % CPU, because the consequence is swapping or an OOM kill rather than queueing.',
  }),
  resourceGauge('Avg. Disk Usage', 'disk', 'disk_usage', {
    business: 'How full the monitored hosts\' disks are, averaged across the estate.',
    findings: [AVG_CPU_FINDINGS[0], AVG_CPU_FINDINGS[1], AVG_CPU_FINDINGS[3], {
      severity: 'medium',
      title: 'Per host, disk is the WORST filesystem, not the overall used share',
      detail:
        'The backend takes max(use_pct) across the host\'s filesystems, so a host with a 10 %-full root and '
        + 'a 97 %-full data volume reports 97. Averaging that across hosts is an average of worst-cases, '
        + 'which is the right choice for a warning signal but is not "how full is the estate".',
      evidence: METRIC_SOURCES.infraDetail + ':606-607 — disk = max(f.use_pct for f in filesystems)',
      impact: 'The gauge is deliberately pessimistic. Read it as "how close is a typical host to its fullest volume filling up".',
    }],
    note: 'Unlike CPU and memory, a full disk is not a performance problem — it is an outage. Treat a high reading here as more urgent than the same number on the other two gauges.',
  }),

  /* ── charts ───────────────────────────────────────────────────────────── */
  {
    id: 'fleet-health', label: 'Fleet Health', group: 'charts', status: 'verified',
    business: 'The shape of the host estate by status, as a donut.',
    technical: 'The same infra tally that drives the Infra Hosts tile, rendered as proportions.',
    scope: 'All registered OS hosts.',
    source: 'Same as Infra Hosts — the summary endpoint when it answers, else a local tally.',
    collection: 'Collector heartbeat.',
    formula: 'The good / warning / critical buckets from the infra object.',
    formulaRef: METRIC_SOURCES.hook + ':115-124, rendered at ' + METRIC_SOURCES.dashboard + ':271-284',
    units: 'Counts, displayed as shares.',
    window: 'Latest state.',
    aggregation: 'Count by status bucket.',
    interpretation: [['Mostly green', 'Most hosts are connected.'], ['Growing red segment', 'Hosts are losing their collector.']],
    example: 'ILLUSTRATIVE. 9 connected, 1 disconnected → a donut that is 90 % green.',
    verify: 'Compare against the Infrastructure page status column.',
    troubleshooting: ['Disagrees with the Infra Hosts tile — they share a source, so a difference means you caught a refresh mid-cycle.'],
    evidence: [METRIC_SOURCES.dashboard + ':271-284'],
  },

  {
    id: 'hosts-by-os', label: 'Hosts by OS', group: 'charts', status: 'verified',
    business: 'What operating systems the estate runs.',
    technical: 'A count of hosts grouped by their os_type field.',
    scope: 'All registered OS hosts, including those currently offline.',
    source: 'GET /os-servers/, field `os_type`.',
    collection: 'Recorded at registration and refreshed by the collector.',
    formula: 'count of hosts grouped by (h.os_type || "Unspecified"), sorted descending',
    formulaRef: METRIC_SOURCES.hook + ':177-181',
    units: 'Count of hosts.',
    window: 'Latest state.',
    aggregation: 'Group-by with an explicit "Unspecified" bucket for hosts with no os_type.',
    interpretation: [['Unspecified present', 'Those hosts have no os_type recorded — usually a registration that never completed its first collection.']],
    example: 'ILLUSTRATIVE. 6 Linux, 3 Windows, 1 with no value → three slices, the last labelled Unspecified.',
    verify: 'Group the Infrastructure list by its OS column.',
    troubleshooting: ['A large Unspecified slice — check whether those hosts have ever successfully collected.'],
    evidence: [METRIC_SOURCES.dashboard + ':286-292', METRIC_SOURCES.hook + ':177-181'],
  },

  {
    id: 'engine-distribution', label: 'Engine Distribution', group: 'charts', status: 'verified',
    business: 'Which database engines the estate runs, and how many hosts run each.',
    technical: 'Per recognised engine, a tally of hosts running it, bucketed by that ENGINE\'s instance status.',
    scope:
      'Hosts per engine. A host running both MySQL and PostgreSQL is counted under both — the shares '
      + 'therefore need not sum to the host count.',
    source: 'GET /os-servers/, field db_instances[].',
    collection: 'Engine detection during host collection.',
    formula:
      'for each known engine:\n'
      + '  tallyBy( hosts running that engine, h => that engine\'s instance status on h )',
    formulaRef: METRIC_SOURCES.hook + ':126-130',
    units: 'Count of hosts per engine.',
    window: 'Latest state.',
    aggregation: 'Per-engine bucket by instance status, explicitly NOT by host connectivity — the comment notes that "a host stays reachable even after its MySQL service is stopped, so tallying by host.status never reflected that the service itself went down".',
    interpretation: [['A slice', 'That many hosts run that engine.'], ['MariaDB', 'Reports inside the MySQL bucket, as it does everywhere else in the product.']],
    example: 'ILLUSTRATIVE. 4 hosts run MySQL, 2 run PostgreSQL, 1 runs both → MySQL 4, PostgreSQL 2, total slices 6 across 5 hosts.',
    verify: 'Open Database and group by engine.',
    troubleshooting: ['Slices sum to more than the host count — expected, when a host runs more than one engine.'],
    evidence: [METRIC_SOURCES.dashboard + ':294-306', METRIC_SOURCES.hook + ':126-130'],
  },

  {
    id: 'cloud-by-provider', label: 'Cloud by Provider', group: 'charts', status: 'verified',
    business: 'How the registered cloud accounts split across providers.',
    technical: 'Accounts grouped by provider, uppercased.',
    scope: 'Registered accounts, not resources.',
    source: 'The cloud microservice account list.',
    collection: 'Account registration.',
    formula: 'count of accounts grouped by (acct.provider || acct.cloud_provider || "Other").toUpperCase()',
    formulaRef: METRIC_SOURCES.hook + ':229-235',
    units: 'Count of accounts.',
    window: 'Latest state, refreshed every 60 s.',
    aggregation: 'Group-by with an "Other" bucket.',
    interpretation: [['Only AWS, AZURE, OCI appear', 'Those are the three implemented providers. There is no GCP provider module.']],
    example: 'ILLUSTRATIVE. 2 AWS, 1 Azure → AWS 2, AZURE 1.',
    verify: 'Open Cloud and group by provider.',
    troubleshooting: ['An "Other" bucket appears — an account row has a provider value the grouping does not recognise.'],
    evidence: [METRIC_SOURCES.dashboard + ':308-320 area', METRIC_SOURCES.hook + ':228-239'],
  },

  {
    id: 'recent-alerts', label: 'Recent Alerts', group: 'charts', status: 'verified',
    business: 'The live alert feed, newest first, filterable by severity.',
    technical: 'Every active alert, sorted by timestamp descending. Not a top-N slice.',
    scope: 'All currently active alerts.',
    source: 'listActiveAlerts.',
    collection: 'The alert engine.',
    formula:
      'sorted = alerts sorted by (timestamp || created_at) descending\n'
      + 'list   = sorted            (the panel scrolls and filters, so it needs all of them)\n'
      + 'recent = sorted.slice(0, 8)  (kept for callers that want only a few)',
    formulaRef: METRIC_SOURCES.hook + ':207-212',
    units: 'Alert records.',
    window: 'Current. Refreshed every 15 s.',
    aggregation: 'Sort only.',
    interpretation: [['All / Critical / Warning', 'Client-side filters over the same list.'], ['Empty', 'Nothing active — subject to the coverage caveat on Active Alerts.']],
    example: 'ILLUSTRATIVE. A disk alert at 09:14 and a slow-query alert at 09:02 appear in that order.',
    verify: 'Compare with the Alerts page.',
    troubleshooting: ['An alert shows "Unknown host" — its record has none of source, agent_name or server_name. The same fallback chain is used by the alert row itself, so the two never disagree.'],
    evidence: [METRIC_SOURCES.dashboard + ':326 area', METRIC_SOURCES.hook + ':207-224'],
  },

  {
    id: 'refresh-behaviour', label: 'Refresh intervals', group: 'behaviour', status: 'verified',
    business: 'How current each number on the dashboard is.',
    technical: 'Five independent polls, each on its own interval, sharing one loading and one error surface.',
    scope: 'The whole dashboard.',
    source: 'useQueries with five queries.',
    collection: 'React Query polling.',
    formula:
      'hosts   60 s      (drives the three gauges, Fleet Health, Hosts by OS, Engine Distribution,\n'
      + '                  Database Server, Agents, SSH Hosts)\n'
      + 'summary 30 s     (Infra Hosts totals when it answers)\n'
      + 'agents  30 s\n'
      + 'alerts  15 s     (Active Alerts and the feed)\n'
      + 'cloud   60 s',
    formulaRef: METRIC_SOURCES.hook + ':54, :76-82',
    units: 'Seconds.',
    window: 'n/a',
    aggregation: 'n/a',
    interpretation: [
      ['Numbers disagree briefly', 'Expected — the feeds poll on different intervals and are not synchronised.'],
      ['retry: false', 'A 401 or a missing microservice shows an empty state immediately rather than retrying for 30 s.'],
    ],
    example: 'ILLUSTRATIVE. An alert raised at 10:00:05 appears by 10:00:15; a host that went offline at 10:00:05 may not be reflected in the gauges until 10:01:00.',
    verify: 'Watch the countdown in the page header, or use its Refresh control to invalidate everything at once.',
    troubleshooting: ['A number looks stale — press Refresh; it invalidates all five query keys explicitly.'],
    evidence: [METRIC_SOURCES.hook + ':54, :70-82, :273-280'],
  },
];

/* Anything the trace could not establish goes here rather than being guessed. */
const UNVERIFIED = [
  {
    item: 'Whether os_servers.cpu_usage is ever written by a path other than the agent/SSH infra push',
    why: 'Only _live_cols_from_snapshot() and one mirror in the agent ingest were followed. A second writer would change what the gauge includes.',
    read: 'Backend/database/app/services/os_server/ — search for assignments to cpu_usage',
  },
  {
    item: 'The exact sampling interval of the agent infra push',
    why: 'A code comment says "roughly every 15-30 s"; the scheduling itself was not traced to a configured interval.',
    read: 'the agent collector\'s own scheduling, plus any interval setting on the host record',
  },
  {
    item: 'Whether GET /os-servers/summary and GET /os-servers/ can disagree on totals beyond refresh timing',
    why: 'Both were read; whether they apply the same filters (deleted, inactive, org scope) was not confirmed.',
    read: 'Backend/database/app/services/os_server/os_server_service.py — the summary builder versus the list builder',
  },
];

window.ACTMON_METRICS = { METRICS, UNVERIFIED, METRIC_SOURCES };
