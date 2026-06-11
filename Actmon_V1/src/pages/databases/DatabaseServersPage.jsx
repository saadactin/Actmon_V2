import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  Server,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Database,
  Cpu,
  HardDrive,
  Monitor,
  Terminal,
  ArrowRight,
  GitBranch,
  ShieldCheck,
} from 'lucide-react';


const clusterServers = [
  {
    id: 1,
    cluster_name: 'PROD-CLUSTER-01',
    db_type: 'PostgreSQL Cluster',
    status: 'HEALTHY',
    environment: 'Production',
    nodes: 3,
    version: 'PostgreSQL 15',
    network: '192.168.1.10/24',
    replication: 'Streaming Replication',
    metrics: {
      cpu: '28%',
      ram: '45%',
      disk: '62%',
      connections: '126',
      lag: '2.3 MB',
    },
    servers: [
      {
        name: 'DB-OS-PROD-01',
        ip: '192.168.1.10',
        role: 'MASTER',
        status: 'CONNECTED',
        uptime: '18 Days',
      },
      {
        name: 'DB-OS-PROD-02',
        ip: '192.168.1.11',
        role: 'SLAVE',
        status: 'CONNECTED',
        uptime: '15 Days',
      },
      {
        name: 'DB-OS-PROD-03',
        ip: '192.168.1.12',
        role: 'SLAVE',
        status: 'CONNECTED',
        uptime: '12 Days',
      },
    ],
  },

  {
    id: 2,
    cluster_name: 'UAT-CLUSTER-01',
    db_type: 'MySQL Cluster',
    status: 'WARNING',
    environment: 'UAT',
    nodes: 2,
    version: 'MySQL 8.0',
    network: '192.168.2.20/24',
    replication: 'Async Replication',
    metrics: {
      cpu: '52%',
      ram: '68%',
      disk: '74%',
      connections: '89',
      lag: '15.8 MB',
    },
    servers: [
      {
        name: 'DB-OS-UAT-01',
        ip: '192.168.2.20',
        role: 'MASTER',
        status: 'CONNECTED',
        uptime: '5 Days',
      },
      {
        name: 'DB-OS-UAT-02',
        ip: '192.168.2.21',
        role: 'SLAVE',
        status: 'WARNING',
        uptime: '5 Days',
      },
    ],
  },
];


const standaloneServers = [
  {
    id: 101,
    name: 'DB-OS-STANDALONE-01',
    environment: 'Production',
    db_type: 'Oracle 19c',
    ip: '192.168.1.50',
    uptime: '22 Days',
    cpu: '31%',
    ram: '48%',
    disk: '59%',
    connections: '64',
    status: 'CONNECTED',
  },

  {
    id: 102,
    name: 'DB-OS-STANDALONE-02',
    environment: 'UAT',
    db_type: 'MSSQL 2019',
    ip: '192.168.2.60',
    uptime: '8 Days',
    cpu: '43%',
    ram: '56%',
    disk: '67%',
    connections: '72',
    status: 'CONNECTED',
  },

  {
    id: 103,
    name: 'DB-OS-STANDALONE-03',
    environment: 'Development',
    db_type: 'MongoDB 6.0',
    ip: '192.168.3.70',
    uptime: '3 Days',
    cpu: '71%',
    ram: '74%',
    disk: '81%',
    connections: '38',
    status: 'WARNING',
  },

  {
    id: 104,
    name: 'DB-OS-STANDALONE-04',
    environment: 'Development',
    db_type: 'ClickHouse 23.8',
    ip: '192.168.3.80',
    uptime: '-',
    cpu: '-',
    ram: '-',
    disk: '-',
    connections: '0',
    status: 'DISCONNECTED',
  },
];


export default function DatabaseServersPage() {

  const navigate = useNavigate();


  const handleOpenServer = (serverId) => {
    // Open the Database Connections page and include serverId as a query parameter
    navigate(`/connections?serverId=${serverId}`);
  };

  const handleOpenTerminal = (server) => {

  setSelectedServer(server);

  setTerminalOpen(true);

};

const handleTerminalCommand = (e) => {

  if (e.key !== 'Enter') return;

  const cmd = command.trim();

  if (!cmd) return;
let output = [];

window.mysqlServiceState =
  window.mysqlServiceState || 'running';

const mysqlState = window.mysqlServiceState;

switch (cmd) {

  case 'systemctl status mysql':

    output = [

`● mysql.service - MySQL Community Server`,
`     Loaded: loaded (/usr/lib/systemd/system/mysql.service; enabled; vendor preset: disabled)`,

mysqlState === 'running'
? `     Active: active (running) since Thu 2026-05-28 14:15:22 IST; 2h 18min ago`
: `     Active: inactive (dead) since Thu 2026-05-28 16:42:11 IST; 15s ago`,

`    Process: 1023 ExecStartPre=/usr/bin/mysqld_pre_systemd (code=exited, status=0/SUCCESS)`,

mysqlState === 'running'
? `   Main PID: 1087 (mysqld)`
: `   Main PID: 0`,

mysqlState === 'running'
? `     Status: "Server is operational"`
: `     Status: "Server is stopped"`,

mysqlState === 'running'
? `      Tasks: 38 (limit: 4915)`
: `      Tasks: 0 (limit: 4915)`,

mysqlState === 'running'
? `     Memory: 512.4M`
: `     Memory: 0B`,

mysqlState === 'running'
? `        CPU: 1min 42.531s`
: `        CPU: 0`,

`     CGroup: /system.slice/mysql.service`,

mysqlState === 'running'
? `             └─1087 /usr/sbin/mysqld`
: `             └─ Service stopped`,

``,

mysqlState === 'running'
? `May 28 14:15:22 db-server systemd[1]: Started MySQL Community Server.`
: `May 28 16:42:11 db-server systemd[1]: Stopped MySQL Community Server.`,

mysqlState === 'running'
? `May 28 14:15:25 db-server mysqld[1087]: ready for connections.`
: `May 28 16:42:11 db-server systemd[1]: mysql.service entered dead state.`

    ];

    break;


  case 'systemctl start mysql':

    if (mysqlState === 'running') {

      output = [
        `Job for mysql.service failed because the control process exited.`,
        ``,
        `mysql.service is already running.`
      ];

    } else {

      window.mysqlServiceState = 'running';

      output = [

`Starting MySQL Community Server...`,
``,
`[  OK  ] Started MySQL Community Server.`,
``,
`mysql.service is now active (running).`

      ];

    }

    break;


  case 'systemctl stop mysql':

    if (mysqlState === 'stopped') {

      output = [
        `mysql.service is already stopped.`
      ];

    } else {

      window.mysqlServiceState = 'stopped';

      output = [

`Stopping MySQL Community Server...`,
``,
`[  OK  ] Stopped MySQL Community Server.`,
``,
`mysql.service stopped successfully.`

      ];

    }

    break;


  case 'systemctl restart mysql':

    window.mysqlServiceState = 'running';

    output = [

`Stopping MySQL Community Server...`,
`[  OK  ] Stopped MySQL Community Server.`,
``,
`Starting MySQL Community Server...`,
`[  OK  ] Started MySQL Community Server.`,
``,
`mysql.service restarted successfully.`

    ];

    break;


  case 'netstat -tulnp | grep 3306':

    output = mysqlState === 'running'
      ? [
`tcp6       0      0 :::3306 :::* LISTEN 1087/mysqld`,
``,
`MySQL is listening on port 3306`
        ]
      : [
`No process is listening on port 3306`
        ];

    break;


  case 'ss -tulnp | grep mysql':

    output = mysqlState === 'running'
      ? [
`tcp LISTEN 0 70 *:3306 *:* users:(("mysqld",pid=1087,fd=21))`
        ]
      : [
`No active MySQL socket found`
        ];

    break;


  case 'ps -ef | grep mysql':

    output = mysqlState === 'running'
      ? [
`mysql 1087 1 2 14:15 ? 00:01:42 /usr/sbin/mysqld`,
`root 2211 2144 0 16:12 pts/0 00:00:00 grep --color=auto mysql`
        ]
      : [
`root 2211 2144 0 16:12 pts/0 00:00:00 grep --color=auto mysql`
        ];

    break;


  case 'mysql --version':

    output = [
      `mysql Ver 8.0.36 for Linux on x86_64 (MySQL Community Server - GPL)`
    ];

    break;


  case 'free -m':

    output = [

`               total        used        free      shared  buff/cache   available`,
`Mem:            8192        4210        2100         120        1882        3520`,
`Swap:           2048         180        1868`

    ];

    break;


  case 'df -h':

    output = [

`Filesystem      Size  Used Avail Use% Mounted on`,
`/dev/sda1       120G   78G   42G  64% /`,
`tmpfs           3.9G     0  3.9G   0% /dev/shm`

    ];

    break;


  case 'uptime':

    output = [
`16:14:28 up 18 days, 2:41, 3 users, load average: 0.42, 0.31, 0.28`
    ];

    break;


  case 'ping google.com':

    output = [

`PING google.com (142.250.183.14) 56(84) bytes of data.`,
`64 bytes from google.com: icmp_seq=1 ttl=117 time=18.4 ms`,
`64 bytes from google.com: icmp_seq=2 ttl=117 time=17.1 ms`,
`64 bytes from google.com: icmp_seq=3 ttl=117 time=16.9 ms`

    ];

    break;


  case 'clear':

    setTerminalLines([]);
    setCommand('');
    return;


  default:

    output = [
      `bash: ${cmd}: command not found`
    ];
}
  setTerminalLines((prev) => [
    ...prev,
    '',
    `root@${selectedServer?.name}:~# ${cmd}`,
    ...output,
  ]);

  setCommand('');
};

const [command, setCommand] = useState('');

const [terminalLines, setTerminalLines] = useState([
  'root@server:~# hostname',
  'DB-OS-PROD-01',
  '',
  'root@server:~# ping google.com',
  '64 bytes from google.com: icmp_seq=1 ttl=117 time=18.4 ms',
  '64 bytes from google.com: icmp_seq=2 ttl=117 time=17.1 ms',
]);

const [terminalOpen, setTerminalOpen] = useState(false);

const [selectedServer, setSelectedServer] = useState(null);


  return (

    <div className="min-h-screen bg-[#f5f7fb] p-6">

      <div className="max-w-[1700px] mx-auto">

        {/* TOP */}

        <div className="flex items-center gap-3 text-slate-500 text-sm mb-5">
          <span>ActMon</span>
          <span>/</span>
          <span className="font-semibold text-slate-700">
            databases
          </span>
        </div>


        {/* HEADER */}

       <div className="flex flex-col gap-6 mb-8">
          <div>

            <h1 className="text-5xl font-bold text-slate-900 mb-3">
              Database OS Servers
            </h1>

            <p className="text-slate-500 max-w-5xl text-lg">
              Manage and monitor database operating system servers.
              Connect to OS servers, detect installed database services,
              monitor infrastructure health, and access database
              dashboards dynamically.
            </p>

          </div>


         <div className="flex flex-wrap items-center justify-between gap-4">
  {/* FILTERS */}

  <div className="flex flex-wrap gap-3">

    <button className="px-5 h-12 rounded-2xl bg-slate-900 text-white font-semibold">
      All
    </button>

    <button className="px-5 h-12 rounded-2xl border border-slate-200 bg-white font-medium">
      Production
    </button>

    <button className="px-5 h-12 rounded-2xl border border-slate-200 bg-white font-medium">
      UAT
    </button>

    <button className="px-5 h-12 rounded-2xl border border-slate-200 bg-white font-medium">
      Development
    </button>

    <button className="px-5 h-12 rounded-2xl border border-slate-200 bg-white font-medium">
      All OS
    </button>

  </div>


  {/* RIGHT SIDE BUTTON */}

 <div>

    <button
      onClick={() => navigate('/databases/add-os-server')}
      className="px-6 h-12 rounded-2xl bg-slate-900 text-white font-semibold flex items-center gap-2 hover:bg-slate-800 transition-all shadow-lg"
    >

      + Add OS Server

    </button>

  </div>

</div>

        </div>


        {/* KPI */}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-5 mb-8">

          <KpiCard
            icon={<Database className="text-blue-500" size={30} />}
            title="Total OS Servers"
            value="8"
            subtitle="All registered OS servers"
          />

          <KpiCard
            icon={<CheckCircle2 className="text-green-500" size={30} />}
            title="Connected"
            value="6"
            subtitle="Successfully connected"
          />

          <KpiCard
            icon={<AlertTriangle className="text-yellow-500" size={30} />}
            title="Warning"
            value="1"
            subtitle="Issues detected"
          />

          <KpiCard
            icon={<XCircle className="text-red-500" size={30} />}
            title="Disconnected"
            value="1"
            subtitle="Not reachable"
          />

          <KpiCard
            icon={<GitBranch className="text-purple-500" size={30} />}
            title="Clusters"
            value="2"
            subtitle="Clustered environments"
          />

        </div>


        {/* CLUSTER CARDS */}

        <div className="space-y-7 mb-8">

          {clusterServers.map((cluster) => (

            <div
              key={cluster.id}
              className="bg-white rounded-3xl border border-slate-200 p-6"
            >

              {/* TOP */}

              <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-5 mb-8">

                <div>

                  <div className="flex items-center gap-3 mb-2 flex-wrap">

                    <h2 className="text-3xl font-bold text-slate-900">
                      {cluster.cluster_name}
                    </h2>

                    <span className="px-3 py-1 rounded-full bg-purple-100 text-purple-700 text-sm font-semibold">
                      Cluster
                    </span>

                  </div>

                  <div className="flex flex-wrap items-center gap-5 text-slate-500 text-sm">

                    <span>
                      ● {cluster.environment}
                    </span>

                    <span>
                      {cluster.nodes} Nodes
                    </span>

                    <span>
                      {cluster.version}
                    </span>

                    <span>
                      {cluster.network}
                    </span>

                  </div>

                </div>


                <div>

                  <span className={`px-5 py-2 rounded-full text-sm font-bold ${
                    cluster.status === 'HEALTHY'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-yellow-100 text-yellow-700'
                  }`}>

                    {cluster.status}

                  </span>

                </div>

              </div>


              {/* TOPOLOGY */}

              <div className="flex flex-col xl:flex-row items-center justify-center gap-10 mb-8">

                {cluster.servers.map((server, index) => (

                  <React.Fragment key={server.name}>

                   <div
  className={`group relative w-[280px] rounded-3xl border p-5 cursor-default hover:shadow-2xl hover:scale-[1.03] transition-all duration-300 ${
    server.role === 'MASTER'
      ? 'border-green-200 bg-green-50'
      : 'border-slate-200 bg-white'
  }`}
>
                      <div className="flex items-center justify-between mb-4">

                        <div className={`text-sm font-bold ${
                          server.role === 'MASTER'
                            ? 'text-green-700'
                            : 'text-blue-700'
                        }`}>

                          {server.role}

                        </div>

                        <Server size={18} className="text-slate-500" />

                      </div>


                      <h3 className="text-2xl font-bold text-slate-900 mb-2">
                        {server.name}
                      </h3>

                      <p className="text-slate-500 mb-4">
                        {server.ip}
                      </p>


                      <div className={`inline-flex px-3 py-1 rounded-full text-sm font-semibold mb-3 ${
                        server.status === 'CONNECTED'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-yellow-100 text-yellow-700'
                      }`}>

                        {server.status}

                      </div>


                      <p className="text-slate-500 text-sm">
                        Uptime: {server.uptime}
                      </p>
                      

                      {/* MINI FLOATING METRICS */}

<div className="absolute opacity-0 invisible group-hover:visible group-hover:opacity-100 transition-all duration-300 right-2 top-2 z-50 flex flex-col gap-2">

  <MiniFancyCard
    label="CPU"
    value="38%"
    glow="bg-orange-400"
  />

  <MiniFancyCard
    label="RAM"
    value="52%"
    glow="bg-purple-400"
  />

  <MiniFancyCard
    label="Disk"
    value="64%"
    glow="bg-blue-400"
  />

</div>

                      <div className="flex gap-3 mt-5">

  <button
    onClick={() => handleOpenServer(server.id)}
    className="flex-1 h-11 rounded-2xl bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-all"
  >
    Open Server
  </button>

  <button
  onClick={() => handleOpenTerminal(server)}
  className="w-12 h-11 rounded-2xl border border-slate-200 flex items-center justify-center hover:bg-slate-50"
>
  <Terminal size={16} />
</button>

</div>

                    </div>


                    {index !== cluster.servers.length - 1 && (

                      <div className="flex flex-col items-center text-slate-500">

                        <ArrowRight size={28} />

                        <span className="text-sm mt-2 text-center">
                          {cluster.replication}
                        </span>

                      </div>

                    )}

                  </React.Fragment>

                ))}

              </div>


              {/* METRICS */}

              <div className="grid grid-cols-2 xl:grid-cols-5 gap-5">

                <MetricCard title="CPU Avg" value={cluster.metrics.cpu} />
                <MetricCard title="RAM Avg" value={cluster.metrics.ram} />
                <MetricCard title="Disk Avg" value={cluster.metrics.disk} />
                <MetricCard title="Connections" value={cluster.metrics.connections} />
                <MetricCard title="Replication Lag" value={cluster.metrics.lag} />

              </div>

            </div>

          ))}

        </div>


        {/* STANDALONE */}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 mb-8">

          {standaloneServers.map((server) => (

            <div
              key={server.id}
              className="bg-white rounded-3xl border border-slate-200 p-6"
            >

              <div className="flex items-start justify-between mb-5">

                <div>

                  <h3 className="text-xl font-bold text-slate-900 mb-2">
                    {server.name}
                  </h3>

                  <div className="flex flex-wrap gap-2 text-sm text-slate-500 mb-2">

                    <span>{server.environment}</span>
                    <span>•</span>
                    <span>{server.db_type}</span>

                  </div>

                  <p className="text-slate-500 text-sm">
                    {server.ip}
                  </p>

                </div>


                <span className={`px-3 py-1 rounded-full text-xs font-bold ${
                  server.status === 'CONNECTED'
                    ? 'bg-green-100 text-green-700'
                    : server.status === 'WARNING'
                    ? 'bg-yellow-100 text-yellow-700'
                    : 'bg-red-100 text-red-700'
                }`}>

                  {server.status}

                </span>

              </div>


              <div className="space-y-4 mb-6">

                <ServerMetric label="CPU Usage" value={server.cpu} />
                <ServerMetric label="RAM Usage" value={server.ram} />
                <ServerMetric label="Disk Usage" value={server.disk} />
                <ServerMetric label="Connections" value={server.connections} />

              </div>


              <div className="flex gap-3">

                <button
                  onClick={() => handleOpenServer(server.id)}
                  className="flex-1 h-12 rounded-2xl border border-slate-200 font-semibold hover:bg-slate-50"
                >

                  Open Server

                </button>


               <button
  onClick={() => handleOpenTerminal(server)}
  className="w-14 h-12 rounded-2xl border border-slate-200 flex items-center justify-center hover:bg-slate-50"
>
  <Terminal size={18} />
</button>

              </div>

            </div>

          ))}

        </div>


        {/* LEGEND */}

        <div className="bg-white rounded-3xl border border-slate-200 p-6 flex flex-wrap gap-8 text-sm text-slate-600">

          <div className="flex items-center gap-2">
            <ShieldCheck className="text-green-600" size={18} />
            MASTER
          </div>

          <div className="flex items-center gap-2">
            <GitBranch className="text-blue-600" size={18} />
            SLAVE
          </div>

          <div className="flex items-center gap-2">
            <CheckCircle2 className="text-green-600" size={18} />
            Connected
          </div>

          <div className="flex items-center gap-2">
            <AlertTriangle className="text-yellow-600" size={18} />
            Warning
          </div>

          <div className="flex items-center gap-2">
            <XCircle className="text-red-600" size={18} />
            Disconnected
          </div>

        </div>

            </div>

      {/* FULL TERMINAL */}

      {terminalOpen && (

        <div className="fixed inset-0 z-[99999] bg-black flex flex-col">

          {/* TERMINAL HEADER */}

          <div className="h-14 bg-[#111827] border-b border-slate-800 flex items-center justify-between px-5">

            <div className="flex items-center gap-4">

              <div className="flex gap-2">

                <div className="w-3 h-3 rounded-full bg-red-500" />

                <div className="w-3 h-3 rounded-full bg-yellow-500" />

                <div className="w-3 h-3 rounded-full bg-green-500" />

              </div>

              <div className="text-sm">

                <p className="text-white font-semibold">
                  {selectedServer?.name}
                </p>

                <p className="text-slate-400 text-xs">
                  root@{selectedServer?.ip}
                </p>

              </div>

            </div>

            <button
              onClick={() => setTerminalOpen(false)}
              className="text-slate-400 hover:text-white text-2xl"
            >
              ×
            </button>

          </div>
{/* TERMINAL BODY */}

<div className="flex-1 bg-black overflow-auto px-5 py-4 font-mono text-[15px]">

  <div className="space-y-2">

    {terminalLines.map((line, index) => (

      <div
        key={index}
        className={`whitespace-pre-wrap ${
          line.includes('Active:')
            ? 'text-green-400'
            : line.includes('google.com')
            ? 'text-yellow-400'
            : line.includes('CPU:')
            ? 'text-pink-400'
            : line.includes('/dev/')
            ? 'text-orange-400'
            : line.includes('Mem:')
            ? 'text-cyan-400'
            : line.includes('not found')
            ? 'text-red-400'
            : 'text-green-400'
        }`}
      >
        {line}
      </div>

    ))}


    {/* INPUT LINE */}

    <div className="flex items-center text-green-400">

      <span className="mr-2 whitespace-nowrap">
        root@{selectedServer?.name}:~#
      </span>

      <input
        autoFocus
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={handleTerminalCommand}
        className="flex-1 bg-transparent outline-none border-none text-green-400"
      />

    </div>

  </div>

</div>

        </div>

      )}

    </div>

  );

}


function KpiCard({
  icon,
  title,
  value,
  subtitle,
}) {

  return (

    <div className="bg-white rounded-3xl border border-slate-200 p-6">

      <div className="flex items-center gap-5">

        <div className="w-16 h-16 rounded-2xl bg-slate-50 flex items-center justify-center">
          {icon}
        </div>

        <div>

          <p className="text-slate-500 text-sm">
            {title}
          </p>

          <h2 className="text-4xl font-bold text-slate-900 mt-1">
            {value}
          </h2>

          <p className="text-slate-400 text-sm mt-1">
            {subtitle}
          </p>

        </div>

      </div>

    </div>

  );

}


function MetricCard({
  title,
  value,
}) {

  return (

    <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5">

      <p className="text-slate-500 text-sm mb-2">
        {title}
      </p>

      <h3 className="text-3xl font-bold text-slate-900">
        {value}
      </h3>

    </div>

  );

}


function ServerMetric({
  label,
  value,
}) {

  return (

    <div>

      <div className="flex items-center justify-between text-sm mb-2">

        <span className="text-slate-500">
          {label}
        </span>

        <span className="font-semibold text-slate-900">
          {value}
        </span>

      </div>


      <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">

        <div
          className="h-full rounded-full bg-slate-700"
          style={{
            width:
              value === '-'
                ? '0%'
                : value,
          }}
        />

      </div>

    </div>

  );

}

function MiniFancyCard({
  label,
  value,
  glow,
}) {

  return (

    <div className="backdrop-blur-xl bg-white/80 border border-white/60 shadow-xl rounded-full px-3 py-2 flex items-center gap-2 min-w-[92px]">

      <div className={`w-2.5 h-2.5 rounded-full ${glow}`} />

      <div>

        <p className="text-[9px] text-slate-500 leading-none">
          {label}
        </p>

        <p className="text-xs font-bold text-slate-900 mt-1">
          {value}
        </p>

      </div>

    </div>


  );

}