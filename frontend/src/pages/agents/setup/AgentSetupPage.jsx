import React, { useState } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { Globe, Server, Database, Cloud, Network, Activity, ScrollText, Boxes, Repeat, Gauge, Eye, Plug, Radio, Settings2, FileText } from 'lucide-react';
import { TECHS } from './techConfig';
import { TechLogo } from './logos';
import WizardShell from './components/WizardShell';
import { LangLogo } from './langIcons';
import { InfraLogo } from './infraIcons';
import { NetLogo } from './networkIcons';
import { IntegLogo } from './integIcons';

const TABS = ['Intro', 'Digital Experience', 'APM', 'Databases', 'Infrastructure', 'Network', 'Logs', 'Integrations'];

// Cloud-drops-onto-platform illustration (Databases tab).
function DpmArt() {
  return (
    <svg viewBox="0 0 220 250" className="w-full max-w-[220px]" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="cloudG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#cbbdf0" /><stop offset="1" stopColor="#a88fe0" /></linearGradient>
        <linearGradient id="goldTop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffd77a" /><stop offset="1" stopColor="#f6b64a" /></linearGradient>
      </defs>
      <g>
        <ellipse cx="72" cy="58" rx="40" ry="28" fill="#c3b2ee" />
        <ellipse cx="118" cy="48" rx="34" ry="26" fill="url(#cloudG)" />
        <ellipse cx="146" cy="66" rx="28" ry="21" fill="#a88fe0" />
        <ellipse cx="60" cy="72" rx="26" ry="19" fill="#bda9ec" />
      </g>
      <line x1="110" y1="92" x2="110" y2="146" stroke="#b9a7e0" strokeWidth="3" strokeDasharray="1 9" strokeLinecap="round" />
      <path d="M110 172 L168 200 L110 228 L52 200 Z" fill="#e8a13c" />
      <path d="M52 200 L110 228 L110 238 L52 210 Z" fill="#d98f2e" />
      <path d="M168 200 L110 228 L110 238 L168 210 Z" fill="#c47f28" />
      <path d="M110 146 L168 174 L110 202 L52 174 Z" fill="url(#goldTop)" />
      <path d="M52 174 L110 202 L110 212 L52 184 Z" fill="#e8a13c" />
      <path d="M168 174 L110 202 L110 212 L168 184 Z" fill="#d98f2e" />
    </svg>
  );
}

// Isometric-cubes cluster (Intro tab — "Observability").
const Cube = ({ x, y, s = 20, d = 20, t, l, r }) => (
  <g>
    <path d={`M${x},${y} L${x + s},${y + s * 0.5} L${x},${y + s} L${x - s},${y + s * 0.5} Z`} fill={t} />
    <path d={`M${x - s},${y + s * 0.5} L${x},${y + s} L${x},${y + s + d} L${x - s},${y + s * 0.5 + d} Z`} fill={l} />
    <path d={`M${x + s},${y + s * 0.5} L${x},${y + s} L${x},${y + s + d} L${x + s},${y + s * 0.5 + d} Z`} fill={r} />
  </g>
);
const P = ['#cbbdf0', '#a88fe0', '#8f74d0'];   // purple top/left/right
const A = ['#ffd77a', '#f6b64a', '#e09a2e'];   // amber top/left/right
function IntroArt() {
  return (
    <svg viewBox="0 0 220 210" className="w-full max-w-[220px]" fill="none" xmlns="http://www.w3.org/2000/svg">
      <Cube x={110} y={20} s={34} d={34} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={64} y={78} s={22} d={22} t={A[0]} l={A[1]} r={A[2]} />
      <Cube x={150} y={72} s={20} d={20} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={102} y={104} s={26} d={26} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={158} y={126} s={18} d={18} t={A[0]} l={A[1]} r={A[2]} />
      <Cube x={70} y={140} s={16} d={16} t={P[0]} l={P[1]} r={P[2]} />
    </svg>
  );
}

// Stacked-discs illustration (Digital Experience tab).
function StackArt() {
  return (
    <svg viewBox="0 0 220 210" className="w-full max-w-[220px]" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* bottom disc (purple) */}
      <ellipse cx="110" cy="150" rx="96" ry="34" fill="#cbbdf0" />
      <ellipse cx="110" cy="142" rx="96" ry="34" fill="#b9a7e8" />
      {/* middle disc (amber) */}
      <ellipse cx="110" cy="110" rx="70" ry="26" fill="#f6b64a" />
      <ellipse cx="110" cy="103" rx="70" ry="26" fill="#ffcf6b" />
      {/* top disc (purple) */}
      <ellipse cx="110" cy="70" rx="46" ry="18" fill="#a88fe0" />
      <ellipse cx="110" cy="64" rx="46" ry="18" fill="#cbbdf0" />
      {/* dotted orbit */}
      <ellipse cx="110" cy="96" rx="120" ry="44" stroke="#f0a93c" strokeWidth="2.5" strokeDasharray="1 10" strokeLinecap="round" fill="none" opacity="0.7" />
    </svg>
  );
}

// Isometric flat-slabs illustration (APM tab).
function ApmArt() {
  return (
    <svg viewBox="0 0 220 200" className="w-full max-w-[220px]" fill="none" xmlns="http://www.w3.org/2000/svg">
      <Cube x={68} y={26} s={26} d={8} t={A[0]} l={A[1]} r={A[2]} />
      <Cube x={150} y={40} s={30} d={8} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={58} y={90} s={34} d={8} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={152} y={104} s={26} d={8} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={96} y={142} s={26} d={8} t={A[0]} l={A[1]} r={A[2]} />
    </svg>
  );
}

// Slabs with tools (wrench + gear) illustration (Logs tab).
function LogsArt() {
  return (
    <svg viewBox="0 0 220 200" className="w-full max-w-[220px]" fill="none" xmlns="http://www.w3.org/2000/svg">
      <Cube x={72} y={38} s={24} d={12} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={120} y={28} s={32} d={14} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={56} y={98} s={26} d={12} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={142} y={104} s={30} d={14} t={A[0]} l={A[1]} r={A[2]} />
      {/* wrench on the big purple slab */}
      <g transform="rotate(-40 120 44)"><rect x="112" y="40" width="20" height="6" rx="3" fill="#fff" /><circle cx="112" cy="43" r="5" fill="#fff" /><circle cx="112" cy="43" r="2.2" fill={P[1]} /></g>
      {/* gear on the amber slab */}
      <g transform="translate(142,104)" fill="#fff">
        <circle r="8" /><circle r="3.2" fill={A[1]} />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((d) => <rect key={d} x="-1.6" y="-11" width="3.2" height="4" rx="1" transform={`rotate(${d})`} />)}
      </g>
    </svg>
  );
}

// "Add Data → Logs" catalog.
const LOG_SERVICES = [
  { title: 'Manual Configuration', icon: Settings2, color: 'bg-indigo-100 text-indigo-600', to: '/logs',
    desc: 'Send logs directly from your system or application.' },
  { title: 'Agent-based', icon: FileText, color: 'bg-blue-100 text-blue-600', to: '/agents/deploy',
    desc: 'Collect logs using an installed ActMon Observability Agent.' },
];

// Dotted cloud-loop with flat slabs illustration (Infrastructure tab).
function CloudArt() {
  return (
    <svg viewBox="0 0 220 200" className="w-full max-w-[220px]" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="110" cy="96" rx="92" ry="62" stroke="#f0a93c" strokeWidth="2.5" strokeDasharray="1 9" strokeLinecap="round" fill="none" />
      <Cube x={110} y={26} s={26} d={8} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={48} y={78} s={22} d={8} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={170} y={78} s={22} d={8} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={110} y={118} s={26} d={8} t={P[0]} l={P[1]} r={P[2]} />
    </svg>
  );
}

// Flat slabs connected by orange paths (Network tab).
function NetArt() {
  return (
    <svg viewBox="0 0 220 200" className="w-full max-w-[220px]" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M60 60 C110 40 130 70 160 60 M60 110 C100 130 120 100 160 120 M70 80 C60 100 66 100 66 108" stroke="#f0a93c" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      <Cube x={58} y={30} s={24} d={8} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={158} y={44} s={24} d={8} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={54} y={96} s={26} d={8} t={P[0]} l={P[1]} r={P[2]} />
      <Cube x={158} y={110} s={24} d={8} t={P[0]} l={P[1]} r={P[2]} />
    </svg>
  );
}

// "Add Data → Network" catalog.
const SDWAN = 'Monitor the health, performance, and statistics of SD-WAN orchestrators, wireless controllers, and edge devices.';
const WLC = 'Monitor the health, performance, and statistics of wireless controllers.';
const NET_SERVICES = [
  { id: 'netdevice', name: 'Network Device', to: '/infra', desc: 'Add a single network device. Provide a hostname/IP address, select the polling method, and specify what to monitor.' },
  { id: 'discover', name: 'Discover Network Devices', to: '/infra', desc: 'Scan your network, discover devices on the network, and select the devices for monitoring.' },
  { id: 'netpath', name: 'NetPath Endpoints', desc: 'Visualize and monitor the end-to-end service delivery path across private and public networks.' },
  { id: 'aruba', name: 'Aruba Orchestrators and Edges', desc: SDWAN },
  { id: 'meraki', name: 'Meraki Orchestrators and Edges', desc: SDWAN },
  { id: 'prisma', name: 'Prisma Orchestrators and Edges', desc: SDWAN },
  { id: 'fortinet', name: 'Fortinet Orchestrators and Edges', desc: SDWAN },
  { id: 'extreme', name: 'ExtremeCloud IQ Wireless Controllers', desc: WLC },
  { id: 'arista', name: 'Arista Wireless Manager Wireless Controllers', desc: WLC },
  { id: 'juniper', name: 'Juniper Mist Wireless Controllers', desc: WLC },
  { id: 'ruckus', name: 'Ruckus Wireless Controllers', desc: WLC },
  { id: 'velocloud', name: 'VeloCloud Orchestrators and Edges', desc: SDWAN },
  { id: 'viptela', name: 'Viptela Orchestrators and Edges', desc: SDWAN },
  { id: 'ups', name: 'UPS Device', desc: 'Monitor the health, performance and statistics of your Uninterruptible Power Supply (UPS) devices.' },
  { id: 'dhcp', name: 'DHCP Server Monitoring', desc: 'Monitor the health, performance, and usage statistics of your DHCP servers.' },
  { id: 'paloalto', name: 'Palo Alto Firewalls', desc: 'Monitor the health, performance, and statistics of your Palo Alto firewalls.' },
  { id: 'f5', name: 'F5 Load Balancers', desc: 'Monitor the health, performance, and statistics of your F5 load balancers.' },
  { id: 'ciscoasa', name: 'Cisco ASA Devices', desc: 'Monitor the health, performance, and statistics of your Cisco ASA devices.' },
  { id: 'ciscoucs', name: 'Cisco UCS Devices', desc: 'Monitor the health, performance, and statistics of your Cisco UCS devices.' },
  { id: 'ciscoaci', name: 'Cisco ACI Devices', desc: 'Monitor the health, performance, and statistics of your Cisco ACI fabric.' },
];

// "Add Data → Infrastructure" catalog.
const INFRA_SERVICES = [
  { id: 'k8s', name: 'Kubernetes Cluster', desc: 'Monitor the health and performance of clusters, namespaces, and nodes. Auto-discover workloads, services, and topology.' },
  { id: 'hosts', name: 'Hosts', to: '/agents/deploy', desc: 'Observe the performance, stability, and health of hosts through multiple monitoring channels.' },
  { id: 'aws', name: 'AWS Services', to: '/cloud', desc: 'Insights into the health and performance of key services such as EC2, EBS, Lambda, S3, and RDS, among others.' },
  { id: 'azure', name: 'Azure Resources', to: '/cloud', desc: 'Monitor the health and performance of key resources such as Azure VM, CDN, Blob Storage, and VPN, among others.' },
  { id: 'gcp', name: 'Google Cloud Platform', to: '/cloud', desc: 'Monitor the health and performance of key resources such as Compute Engine, Cloud Storage among others.' },
  { id: 'discover', name: 'Discover On-Prem Hosts', to: '/infra', desc: 'Scan your network for on-prem hosts you want to monitor.' },
  { id: 'hyperv', name: 'Hyper-V Host', desc: 'Add a Hyper-V individually to monitor the host and the associated VMs, Storages, Clusters, and cluster-shared volumes.' },
  { id: 'vmware', name: 'VMware Resources', desc: 'Add a VMware vCenter or VMware ESXi host individually to monitor the host and associated VMs and datastores.' },
  { id: 'nutanix', name: 'Nutanix Resources', desc: 'Add a Nutanix cluster to monitor hosts, VMs, and storage via Prism Element, or use Prism Central to add multiple clusters.' },
  { id: 'storage', name: 'Storage Array', desc: "Observe the health and performance of Storage arrays using the Network Collector's capabilities." },
  { id: 'otel', name: 'ActMon OTel Collector', desc: 'Install the ActMon OTel Collector to get the full-blown custom OTel experience tailored to the ActMon platform.' },
];

// "Add Data → APM" language catalog.
const APM_SERVICES = [
  { id: 'java', name: 'Java', desc: 'Available for Linux, Windows, AWS Lambda, and Kubernetes.' },
  { id: 'python', name: 'Python', desc: 'Available for Linux, Windows, AWS Lambda, and Kubernetes.' },
  { id: 'nodejs', name: 'NodeJS', desc: 'Available for Linux, Windows, and AWS Lambda.' },
  { id: 'php', name: 'PHP', desc: 'Available for Linux and Windows.' },
  { id: 'dotnet', name: '.Net', desc: 'Available for Linux and Windows.' },
  { id: 'ruby', name: 'Ruby', desc: 'Available for Linux, Windows, and AWS Lambda.' },
  { id: 'go', name: 'Go', desc: 'Available for Linux, Windows, and AWS Lambda.' },
];

// "Add Data → Digital Experience" catalog (website / synthetic monitoring).
const DX_SERVICES = [
  { title: 'Website Availability', icon: Globe, color: 'bg-indigo-100 text-indigo-600', to: '/agents/setup/website',
    desc: 'Test website and URL availability from multiple locations using HTTP and HTTPs protocols.' },
  { title: 'Synthetic Transaction', icon: Repeat, color: 'bg-purple-100 text-purple-600', soon: true,
    desc: 'Test website flows to identify broken links, latency, and availability issues before your users do.' },
  { title: 'Page Speed', icon: Gauge, color: 'bg-sky-100 text-sky-600', soon: true,
    desc: 'Get insights into your websites performance.' },
  { title: 'RUM', icon: Eye, color: 'bg-cyan-100 text-cyan-600', soon: true,
    desc: 'Understand how users experience your site based on browser, device, and geographic location.' },
  { title: 'TCP Port', icon: Plug, color: 'bg-amber-100 text-amber-600', to: '/agents/setup/network-check?type=tcp_port',
    desc: 'Check the availability of your hostname and a specified port.' },
  { title: 'Ping', icon: Radio, color: 'bg-blue-100 text-blue-600', to: '/agents/setup/network-check?type=ping',
    desc: 'Check the availability of a specified IP and domain address.' },
  { title: 'DNS', icon: Network, color: 'bg-blue-100 text-blue-600', to: '/agents/setup/network-check?type=dns',
    desc: 'Check the functionality of your DNS server.' },
  { title: 'UDP Port', icon: Plug, color: 'bg-teal-100 text-teal-600', to: '/agents/setup/network-check?type=udp_port',
    desc: 'Check the availability of your hostname and a specified port.' },
];

// "Add Data → Intro" service catalog (ActMon Observability).
const SERVICES = [
  { title: 'Monitor my website', icon: Globe, color: 'bg-indigo-100 text-indigo-600', tab: 'Digital Experience',
    desc: 'Measure the availability and real user experience to improve performance and identify issues before your users do.' },
  { title: 'Monitor my Kubernetes cluster', icon: Boxes, color: 'bg-sky-100 text-sky-600', tab: 'Infrastructure',
    desc: 'Monitor the health and performance of clusters, namespaces, and nodes. Auto-discover workloads, services, and topology.' },
  { title: 'Monitor my application performance', icon: Activity, color: 'bg-purple-100 text-purple-600', tab: 'APM',
    desc: 'Assess the performance of business-critical applications with code-level insights.' },
  { title: 'Monitor my hosts', icon: Server, color: 'bg-teal-100 text-teal-600', tab: 'Infrastructure',
    desc: 'Observe my hosts and virtualization infrastructure.' },
  { title: 'Monitor my database performance', icon: Database, color: 'bg-orange-100 text-orange-600', tab: 'Databases',
    desc: 'Monitor database reliability, availability, and performance, including query optimization.' },
  { title: 'Monitor my on-premise network and infrastructure', icon: Network, color: 'bg-blue-100 text-blue-600', tab: 'Network',
    desc: 'Discover, manage, and monitor on-premise infrastructure, including network devices and hosts.' },
  { title: 'Monitor my cloud infrastructure', icon: Cloud, color: 'bg-cyan-100 text-cyan-600', tab: 'Infrastructure',
    desc: 'Observe cloud infrastructure services running in AWS, Azure, and Google Cloud (GCP).' },
  { title: 'Collect and analyze my logs', icon: ScrollText, color: 'bg-violet-100 text-violet-600', tab: 'Logs',
    desc: 'Collect system and application logs for analysis and troubleshooting.' },
];

// Two interlocking 3D gears illustration (Integrations tab).
function Gear({ cx, cy, r, fill, side, teeth = 9 }) {
  const th = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    th.push(<rect key={i} x={cx - 2.5} y={cy - r - 7} width="5" height="9" rx="1.5" fill={fill}
      transform={`rotate(${(a * 180) / Math.PI} ${cx} ${cy})`} />);
  }
  return (
    <g>
      {/* depth */}
      <ellipse cx={cx} cy={cy + 8} rx={r + 6} ry={r + 4} fill={side} />
      {th}
      <circle cx={cx} cy={cy} r={r} fill={fill} />
      <circle cx={cx} cy={cy} r={r * 0.42} fill={side} />
    </g>
  );
}
function GearsArt() {
  return (
    <svg viewBox="0 0 220 210" className="w-full max-w-[220px]" fill="none" xmlns="http://www.w3.org/2000/svg">
      <Gear cx={92} cy={128} r={54} teeth={11} fill="#cbbdf0" side="#a88fe0" />
      <Gear cx={150} cy={70} r={34} teeth={9} fill="#ffcf6b" side="#f0a93c" />
    </svg>
  );
}

// "Add Data → Integrations" catalog (OpenTelemetry / third-party receivers).
const DB_STATS = 'metrics, including connections, operations, memory usage and network statistics.';
const INTEG_SERVICES = [
  { id: 'apache', name: 'Apache', desc: 'Fetch stats from an Apache Web Server instance.' },
  { id: 'confluent', name: 'Confluent Cloud', desc: 'Monitor Confluent Cloud metrics from a Kafka cluster/connector, ksqlDB, schema registry, compute pool, or connector.' },
  { id: 'dnsquery', name: 'DNS Query', desc: 'Monitor your DNS records to ensure that the Domain Name System continues to route traffic to your websites properly.' },
  { id: 'docker', name: 'Docker', desc: 'Query the local Docker daemon for container stats on container resource usage of CPU, memory, network, and the block IO.' },
  { id: 'elasticsearch', name: 'Elasticsearch', desc: 'Collect and analyze trace and metric telemetry data from Elasticsearch to monitor your services.' },
  { id: 'exec', name: 'Exec', desc: 'Execute commands at regular intervals and parse metrics from their output in any of the supported formats.' },
  { id: 'fluentd', name: 'Fluentd', desc: 'Collect metrics from various sources to create a unified Fluent Bit and OTEL data pipeline.' },
  { id: 'haproxy', name: 'HAProxy', desc: 'Gain visibility into HAProxy request processing, traffic patterns, and metrics related to connections, requests, and responses.' },
  { id: 'iis', name: 'IIS', desc: 'Monitor IIS web server metrics related to uptime, data flow, and requests commonly monitored for IIS.' },
  { id: 'kafka', name: 'Kafka', desc: 'Monitor traces, metrics, and logs from Kafka.' },
  { id: 'memcached', name: 'Memcached', desc: 'Monitor Memcached clusters and reads and writes of their nodes.' },
  { id: 'mongodb', name: 'MongoDB', desc: `Collect real-time MongoDB ${DB_STATS}` },
  { id: 'mysql', name: 'MySQL', desc: 'Collect real-time MySQL metrics, including connections, operations, memory usage, and network statistics.' },
  { id: 'nginx', name: 'NGINX', desc: 'Monitor stats and metrics from an NGINX instance.' },
  { id: 'nginxplus', name: 'NGINX Plus API', desc: 'Monitor stats and metrics from an NGINX Plus instance.' },
  { id: 'ntpq', name: 'NTPQ', desc: 'Collect metrics from NTPQ to enhance observability and telemetry.' },
  { id: 'oracle', name: 'Oracle DB', desc: 'Gain visibility into Oracle DB request processing, traffic patterns, latency metrics, requests, and connections.' },
  { id: 'otlp', name: 'OTLP', desc: 'Collect OTLP metrics from gRPC and HTTP endpoints.' },
  { id: 'phpfpm', name: 'PHP-FPM', desc: 'Get PHP-FPM statistics using either HTTP status page or FPM socket.' },
  { id: 'postgresql', name: 'PostgreSQL', desc: `Collect real-time PostgreSQL ${DB_STATS}` },
  { id: 'prometheus', name: 'Prometheus', desc: 'Collect metrics from a Prometheus endpoint.' },
  { id: 'rabbitmq', name: 'RabbitMQ', desc: 'Fetch stats from a RabbitMQ node to enhance monitoring and ensure efficient message handling.' },
  { id: 'redis', name: 'Redis', desc: 'Collect metrics related to performance, memory usage, blocked clients, secondary connections, and more.' },
  { id: 'snowflake', name: 'Snowflake', desc: 'Collect metrics from the Snowflake cloud platform.' },
  { id: 'sqlserver', name: 'SQL Server', desc: 'Collect real-time SQL Server metrics, including connections, operations, memory usage and network statistics.' },
  { id: 'statsd', name: 'StatsD', desc: 'Collect and aggregate custom application metrics with the StatsD lightweight network daemon.' },
  { id: 'varnish', name: 'Varnish', desc: 'Collect stats from a Varnish HTTP Cache.' },
  { id: 'zookeeper', name: 'ZooKeeper', desc: 'Collect metrics to gain visibility into ZooKeeper request processing, traffic patterns, latency, and active connections.' },
];

export default function AgentSetupPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  // In "databases" context (reached from the Databases menu) the sidebar stays on
  // Databases and this catalog opens straight on the DATABASES tab.
  const inDb = location.pathname.startsWith('/databases');
  const reqTab = params.get('tab');
  const [tab, setTab] = useState(TABS.includes(reqTab) ? reqTab : (inDb ? 'Databases' : 'Intro'));
  const closeTo = inDb ? '/databases' : '/agents';
  const setupBase = inDb ? '/databases/setup' : '/agents/setup';
  // Deep link from the deploy-wizard Summary ("Monitor database performance"):
  // carry the just-deployed agent into the tech wizard so it's pre-selected.
  // Prefers router state (never touches the URL/history) over the legacy
  // query-string param, which is kept only as a fallback for a hard refresh
  // of this page (state doesn't survive that, the query string does).
  const agentParam = location.state?.agent ?? params.get('agent');
  const tokenParam = location.state?.token ?? params.get('token');
  const agentQS = agentParam ? `?agent=${encodeURIComponent(agentParam)}${tokenParam ? `&token=${encodeURIComponent(tokenParam)}` : ''}` : '';

  const isIntro = tab === 'Intro';
  const isDX = tab === 'Digital Experience';
  const isAPM = tab === 'APM';
  const isInfra = tab === 'Infrastructure';
  const isNetwork = tab === 'Network';
  const isLogs = tab === 'Logs';
  const isInteg = tab === 'Integrations';

  const renderGrid = (list) => (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 max-w-[1100px]">
      {list.map((s) => {
        const Icon = s.icon;
        const go = () => { if (s.tab) setTab(s.tab); else if (s.to) navigate(s.to); };
        return (
          <button key={s.title} onClick={go}
            className="text-left rounded-xl border border-slate-200 bg-white p-6 min-h-[132px] flex items-start gap-5 hover:border-blue-400 hover:shadow-[0_4px_22px_-6px_rgba(37,99,235,0.28)] transition-all">
            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 ${s.color}`}><Icon size={30} /></div>
            <div className="flex-1 min-w-0">
              <p className="font-black text-slate-800 text-[17px] leading-snug">{s.title}</p>
              <p className="text-[15px] text-slate-500 mt-2 leading-relaxed">{s.desc}</p>
            </div>
          </button>
        );
      })}
    </div>
  );

  return (
    <WizardShell title="Add Data" onClose={() => navigate(closeTo)} aside={(
      <>
          {isIntro && (
            <>
              <div className="flex justify-center pt-2"><IntroArt /></div>
              <h2 className="text-[26px] leading-tight font-black text-slate-800 mt-10">ActMon Observability</h2>
              <p className="text-slate-500 mt-3 leading-relaxed">Select from one of the services to get started. You can always come back here to enable more services and realize the power of full observability.</p>
              <p className="text-slate-500 mt-4 leading-relaxed">Not ready to start? Explore the interactive demo.</p>
              <button className="mt-4 self-start h-9 px-4 rounded-lg border border-slate-300 text-slate-700 text-[12px] font-black uppercase tracking-wide hover:bg-slate-50">
                Interactive Demo
              </button>
            </>
          )}
          {isDX && (
            <>
              <div className="flex justify-center pt-2"><StackArt /></div>
              <h2 className="text-[26px] leading-tight font-black text-slate-800 mt-10">Digital Experience</h2>
              <p className="text-slate-500 mt-3 leading-relaxed">Improve your users' digital experience by tracking and monitoring the performance, availability, and user interaction of your website.</p>
            </>
          )}
          {isAPM && (
            <>
              <div className="flex justify-center pt-2"><ApmArt /></div>
              <h2 className="text-[26px] leading-tight font-black text-slate-800 mt-8">Application Performance Monitoring</h2>
              <p className="text-slate-500 mt-3 leading-relaxed">Monitor the performance of business-critical applications with code-level insights. Capture real-time telemetry data, follow the path of distributed traces, identify root causes with code profiling, use backtraces to investigate errors, and correlate traces with logs and databases.</p>
            </>
          )}
          {isInfra && (
            <>
              <div className="flex justify-center pt-2"><CloudArt /></div>
              <h2 className="text-[26px] leading-tight font-black text-slate-800 mt-8">Infrastructure Monitoring</h2>
              <p className="text-slate-500 mt-3 leading-relaxed">Monitor your cloud infrastructure and services, your Kubernetes cluster, or your servers and hosts.</p>
            </>
          )}
          {isNetwork && (
            <>
              <div className="flex justify-center pt-2"><NetArt /></div>
              <h2 className="text-[26px] leading-tight font-black text-slate-800 mt-8">Network Device Monitoring</h2>
              <p className="text-slate-500 mt-3 leading-relaxed">Monitor the health and performance of your on-premise devices such as routers, switches, and firewalls. Visualize end-to-end service delivery paths.</p>
            </>
          )}
          {isLogs && (
            <>
              <div className="flex justify-center pt-2"><LogsArt /></div>
              <h2 className="text-[26px] leading-tight font-black text-slate-800 mt-8">Logs</h2>
              <p className="text-slate-500 mt-3 leading-relaxed">Collect logs with an installed agent or by manually configuring your system or application. Logs can be monitored to track activity, analyze trends, troubleshoot, and alert you to problems with the host or device from which the logs came.</p>
            </>
          )}
          {isInteg && (
            <>
              <div className="flex justify-center pt-2"><GearsArt /></div>
              <h2 className="text-[26px] leading-tight font-black text-slate-800 mt-8">Integrations</h2>
              <p className="text-slate-500 mt-3 leading-relaxed">Extend ActMon Observability through a native open-source (OpenTelemetry) framework as well as third party integrations using our agent. If a native integration isn't available for your framework, you can still send data directly.</p>
            </>
          )}
          {tab === 'Databases' && (
            <>
              <div className="flex justify-center"><DpmArt /></div>
              <h2 className="text-[26px] leading-tight font-black text-slate-800 mt-8">Database Performance Monitoring</h2>
              <p className="text-slate-500 mt-3 leading-relaxed">Monitor the performance of your database including query execution.</p>
            </>
          )}
          {!isIntro && !isDX && !isAPM && !isInfra && !isNetwork && !isLogs && !isInteg && tab !== 'Databases' && (
            <div className="flex-1 flex items-center justify-center text-center">
              <p className="text-slate-300 font-black text-2xl">{tab}</p>
            </div>
          )}
      </>
    )}>
          {/* Tabs */}
          <div className="flex items-center gap-6 px-8 pt-5 border-b border-slate-200 overflow-x-auto flex-shrink-0">
            {TABS.map((t) => {
              const active = t === tab;
              return (
                <button key={t} onClick={() => setTab(t)}
                  className={`text-[13px] font-bold uppercase tracking-wide pb-3 whitespace-nowrap border-b-2 transition-colors ${
                    active ? 'text-rose-800 border-rose-800' : 'text-slate-400 border-transparent hover:text-slate-600'}`}>
                  {t}
                </button>
              );
            })}
          </div>

          {/* Panel */}
          <div className="flex-1 overflow-y-auto px-8 py-6">
            {isIntro && renderGrid(SERVICES)}
            {isDX && (
              <>
                <div className="max-w-[1100px] mb-5 flex justify-end">
                  <button onClick={() => navigate('/digital-experience')}
                    className="text-[13px] font-bold text-blue-600 hover:underline">View existing monitors →</button>
                </div>
                {renderGrid(DX_SERVICES)}
              </>
            )}
            {isLogs && renderGrid(LOG_SERVICES)}

            {isAPM && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 max-w-[1100px]">
                {APM_SERVICES.map((a) => (
                  <div key={a.id} className="rounded-xl border border-slate-200 bg-white p-6 min-h-[132px] flex items-start gap-5">
                    <LangLogo id={a.id} size={54} />
                    <div className="flex-1 min-w-0">
                      <p className="font-black text-slate-800 text-[17px] leading-snug">{a.name}</p>
                      <p className="text-[15px] text-slate-500 mt-2 leading-relaxed">{a.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {isInfra && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 max-w-[1100px]">
                {INFRA_SERVICES.map((a) => {
                  const go = () => { if (a.to) navigate(a.to); };
                  return (
                    <button key={a.id} onClick={go} disabled={!a.to}
                      className={`text-left rounded-xl border border-slate-200 bg-white p-6 min-h-[132px] flex items-start gap-5 transition-all ${
                        a.to ? 'hover:border-blue-400 hover:shadow-[0_4px_22px_-6px_rgba(37,99,235,0.28)]' : 'cursor-default'}`}>
                      <InfraLogo id={a.id} size={54} />
                      <div className="flex-1 min-w-0">
                        <p className="font-black text-slate-800 text-[17px] leading-snug">{a.name}</p>
                        <p className="text-[15px] text-slate-500 mt-2 leading-relaxed">{a.desc}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {isNetwork && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 max-w-[1100px]">
                {NET_SERVICES.map((a) => {
                  const go = () => { if (a.to) navigate(a.to); };
                  return (
                    <button key={a.id} onClick={go} disabled={!a.to}
                      className={`text-left rounded-xl border border-slate-200 bg-white p-6 min-h-[132px] flex items-start gap-5 transition-all ${
                        a.to ? 'hover:border-blue-400 hover:shadow-[0_4px_22px_-6px_rgba(37,99,235,0.28)]' : 'cursor-default'}`}>
                      <NetLogo id={a.id} size={54} />
                      <div className="flex-1 min-w-0">
                        <p className="font-black text-slate-800 text-[17px] leading-snug">{a.name}</p>
                        <p className="text-[15px] text-slate-500 mt-2 leading-relaxed">{a.desc}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {tab === 'Databases' && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 max-w-[1100px]">
                {TECHS.map((t) => (
                  <button key={t.id} onClick={() => navigate(`${setupBase}/${t.id}${agentQS}`)}
                    className="group text-left rounded-xl border border-slate-200 bg-white p-6 min-h-[132px] hover:border-blue-400 hover:shadow-[0_4px_22px_-6px_rgba(37,99,235,0.28)] transition-all flex items-start gap-5">
                    <TechLogo id={t.id} size={56} />
                    <div className="flex-1 min-w-0">
                      <p className="font-black text-slate-800 text-[17px] leading-snug">{t.name}</p>
                      <p className="text-[15px] text-slate-500 mt-2 leading-relaxed">{t.desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {isInteg && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 max-w-[1100px]">
                {INTEG_SERVICES.map((a) => (
                  <div key={a.id} className="rounded-xl border border-slate-200 bg-white p-6 min-h-[132px] flex items-start gap-5 hover:border-blue-400 hover:shadow-[0_4px_22px_-6px_rgba(37,99,235,0.28)] transition-all">
                    <IntegLogo id={a.id} size={54} />
                    <div className="flex-1 min-w-0">
                      <p className="font-black text-slate-800 text-[17px] leading-snug">{a.name}</p>
                      <p className="text-[15px] text-slate-500 mt-2 leading-relaxed">{a.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!isIntro && !isDX && !isAPM && !isInfra && !isNetwork && !isLogs && !isInteg && tab !== 'Databases' && (
              <div className="h-full flex flex-col items-center justify-center text-center py-20">
                <p className="text-slate-700 font-black text-lg">{tab}</p>
                <p className="text-slate-400 mt-1 max-w-sm">No {tab.toLowerCase()} integrations are available in this category yet.</p>
              </div>
            )}
          </div>
    </WizardShell>
  );
}
