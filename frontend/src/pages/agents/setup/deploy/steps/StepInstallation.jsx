import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Copy, Check, Info, Loader2, CheckCircle2, Globe, Download } from 'lucide-react';
import { createInstallToken, listAgents, getHostIps } from '@/api/agents';

const ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';
const IS_LOCAL = /^(localhost|127\.)/i.test(typeof window !== 'undefined' ? window.location.hostname : '');

// Build the ActMon Agent install command for the chosen OS + method.
// `url` is the /api/v1 base as reachable FROM THE TARGET HOST (never localhost).
// Commands don't use sudo — the warning instructs running as root/Administrator
// (minimal Debian/RHEL images often don't ship sudo at all).
function buildScript(data, url) {
  const token = data.token || 'actmon-<token>';
  const meta = `role:host-monitoring,os:${data.os},hostMonitoring:${data.enableHostMonitoring !== false},installationSessionId:${data.sessionId || ''}`;

  const arch = data.arch || 'amd64';
  if (data.os === 'windows') {
    if (data.method === 'installer') {
      // One elevated step (UAC): downloads a self-configured MSI (token/URL
      // already baked in server-side) and installs it via msiexec — a Windows
      // SERVICE, the same mechanism every other always-on Windows application
      // uses. This used to download+run actmon-setup.ps1, which installed a
      // SCHEDULED TASK instead: that path's only defence against the task
      // manager giving up after repeated failures was a hand-rolled recheck
      // trigger, which had a real bug (an out-of-range duration) that meant it
      // was never actually registered on any host — confirmed live, an agent
      // went dark for 46 minutes, then again overnight, before that was found.
      // A Service's restart-on-failure is a mature primitive with no such cap.
      //
      // Single quotes only inside `inner` — it gets wrapped in the OUTER
      // double-quoted -Command argument below, and PowerShell nests a single-
      // quoted string inside a double-quoted one with no escaping required;
      // a double quote in here would collide with that wrapper and truncate
      // the command silently. `$env:TEMP` is a bare variable reference (no
      // quotes needed) concatenated with a single-quoted literal suffix.
      const msi = `${url}/agents/install/actmon-agent.msi?token=${token}&url=${encodeURIComponent(url)}`;
      const inner = `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $m=$env:TEMP+'\\actmon-agent.msi'; Invoke-WebRequest -Uri '${msi}' -OutFile $m -UseBasicParsing; Start-Process msiexec.exe -ArgumentList @('/i',$m,'/qn','/norestart') -Wait; Remove-Item $m -Force -ErrorAction SilentlyContinue`;
      return `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',"${inner}"`;
    }
    return `$env:ACTMON_ACCESS_TOKEN="${token}"; $env:ACTMON_METADATA="${meta}"; $env:ACTMON_URL="${url}"; iex ((New-Object System.Net.WebClient).DownloadString('${url}/agents/install/actmon-agent.ps1'))`;
  }

  // Linux — package install. The command AUTO-DETECTS the host's package family
  // (dpkg vs rpm) so it installs correctly even if the wrong distribution was
  // picked on the Distribution step (e.g. RPM chosen for a Debian host).
  // Downloads work with curl OR wget; the package post-install reads
  // ACTMON_ACCESS_TOKEN / ACTMON_URL from the environment.
  if (data.distro) {
    return (
      `sh -c 'dl(){ command -v curl >/dev/null 2>&1 && curl -fsSLo "$1" "$2" || wget -qO "$1" "$2"; }; ` +
      `if command -v dpkg >/dev/null 2>&1; then ` +
      `apt-get update -qq || true; apt-get install -y python3 python3-pymysql python3-psycopg2 python3-cryptography python3-pymongo || true; ` +
      `apt-get install -y python3-oracledb 2>/dev/null || python3 -m pip install --break-system-packages oracledb 2>/dev/null || true; ` +
      `python3 -m pip install --break-system-packages clickhouse-driver 2>/dev/null || python3 -m pip install clickhouse-driver 2>/dev/null || true; ` +
      `dl actmon-agent.deb "${url}/agents/download/linux?fmt=deb" && ` +
      `ACTMON_ACCESS_TOKEN="${token}" ACTMON_URL="${url}" dpkg -i actmon-agent.deb || apt-get install -f -y; ` +
      `elif command -v rpm >/dev/null 2>&1; then ` +
      `(command -v dnf >/dev/null 2>&1 && dnf install -y python3 python3-PyMySQL python3-psycopg2 python3-cryptography python3-pymongo || yum install -y python3 python3-PyMySQL python3-psycopg2 python3-cryptography python3-pymongo) || true; ` +
      `python3 -m pip install --only-binary=:all: "oracledb<2" clickhouse-driver 2>/dev/null || true; ` +
      `dl actmon-agent.rpm "${url}/agents/download/linux?fmt=rpm" && ` +
      `ACTMON_ACCESS_TOKEN="${token}" ACTMON_URL="${url}" rpm -Uvh --replacepkgs actmon-agent.rpm; ` +
      `else echo "ERROR: neither dpkg nor rpm found on this host"; exit 1; fi'`
    );
  }
  // Fallback — universal systemd installer (Debian/Ubuntu AND RHEL/CentOS/Oracle/Fedora).
  if (data.method === 'installer') {
    const setup = `${url}/agents/install/actmon-setup.sh?token=${token}&url=${encodeURIComponent(url)}&arch=${arch}`;
    return `(command -v curl >/dev/null && curl -sSL "${setup}" || wget -qO- "${setup}") | bash`;
  }
  return `env ACTMON_ACCESS_TOKEN="${token}" ACTMON_METADATA="${meta}" ACTMON_URL="${url}" bash -c "$( (command -v curl >/dev/null && curl -sSL ${url}/agents/install/actmon-agent.sh || wget -qO- ${url}/agents/install/actmon-agent.sh) )"`;
}

// Step 4 (manual flow) — copy the ActMon Agent install command and run it on the host.
export default function StepInstallation({ data, onInstalled }) {
  const [copied, setCopied] = useState(false);
  const [installed, setInstalled] = useState(false);
  const agentNameRef = useRef(null);
  const isWin = data.os === 'windows';

  // Server URL as reachable from the TARGET host. Browsing on localhost, the origin
  // is useless to a remote VM — auto-detect this machine's LAN IP and let the user
  // pick/edit (VMware/Hyper-V hosts have several adapters).
  // The server URL is auto-detected from how you opened ActMon (window.origin) —
  // the installer is downloaded FROM this server, so it already knows the address.
  // You normally never touch this. Only when browsing on localhost do we offer the
  // machine's LAN IPs, because 'localhost' isn't reachable from a *different* target.
  const [serverBase, setServerBase] = useState(ORIGIN);
  const [candidates, setCandidates] = useState([]);
  useEffect(() => {
    if (!IS_LOCAL) return;   // browsing via a real IP/hostname → origin is already correct
    getHostIps().then(({ primary, ips }) => {
      const port = window.location.port ? `:${window.location.port}` : '';
      const proto = window.location.protocol;
      const list = (ips || []).map((ip) => `${proto}//${ip}${port}`);
      setCandidates(list);
      // Prefer a LAN IP over 'localhost' so a remote target can reach it.
      if (primary) setServerBase(`${proto}//${primary}${port}`);
    }).catch(() => {});
  }, []);

  const apiBase = `${serverBase.replace(/\/+$/, '')}/api/v1`;
  const script = buildScript(data, apiBase);

  const copy = () => { navigator.clipboard?.writeText(script); setCopied(true); setTimeout(() => setCopied(false), 1600); };

  // Persist the token so the running agent can enroll against it.
  useEffect(() => {
    if (!data.token) return;
    createInstallToken({ token: data.token, token_name: data.tokenName || 'actmon-agent', os_type: data.os })
      .then((r) => { agentNameRef.current = r?.agent_name || data.tokenName; })
      .catch(() => {});
  }, [data.token, data.tokenName, data.os]);

  // Poll for the agent coming online. Flip when EITHER a host matching this token's
  // name appears, OR any brand-new online host shows up (the universal MSI self-names
  // by hostname, so we detect it as "new since this page loaded").
  const seenAgentsRef = useRef(null);
  useEffect(() => {
    if (installed) return undefined;
    const timer = setInterval(async () => {
      try {
        const agents = await listAgents();
        const online = agents.filter((a) => a.status === 'online').map((a) => (a.name || ''));
        if (seenAgentsRef.current === null) { seenAgentsRef.current = new Set(online); return; }
        const base = (agentNameRef.current || data.tokenName || '').toLowerCase();
        const hitByName = base && agents.find((a) => a.status === 'online' && (a.name || '').toLowerCase().startsWith(base));
        const hitNew = online.find((n) => !seenAgentsRef.current.has(n));
        if (hitByName || hitNew) { setInstalled(true); onInstalled?.(true); clearInterval(timer); }
      } catch { /* ignore polling errors */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [installed, data.tokenName, onInstalled]);

  return (
    <div className="max-w-4xl">
      <h3 className="text-[19px] font-black text-slate-800">Install the Agent on the target host.</h3>
      <p className="text-[15px] text-slate-600 mt-2 leading-relaxed">
        {isWin
          ? 'The command downloads and runs the ActMon Agent on Windows. It already includes all necessary parameters. For details on used parameters, see '
          : data.distro
            ? `Download the ${data.distro.fmt === 'deb' ? 'Debian' : 'RPM'} package for ${data.distro.name} to the target host and run the installation command. The command already includes all necessary parameters. For details on used parameters, see `
            : 'The script detects your Linux distribution and selects an appropriate package manager. The script already includes all necessary parameters. For details on used parameters, see '}
        <a href="#" onClick={(e) => e.preventDefault()} className="text-blue-600 font-semibold hover:underline">Agent installation parameters</a>.
      </p>

      {/* Server URL is fully automatic (window.origin, with a LAN-IP fallback when on
          localhost) — the installer is downloaded from this server and points back to
          it, so there's nothing to configure. */}
      <div className="mt-4 flex items-center gap-2 text-[13px] text-slate-500">
        <Globe size={14} className="text-slate-400" />
        <span>Agent reports to <span className="font-mono font-semibold text-slate-600">{serverBase}</span> — detected automatically from this server.</span>
      </div>

      {/* Package download link (distro chosen on the Distribution step) */}
      {!isWin && data.distro && (
        <a href={`${apiBase}/agents/download/linux?fmt=${data.distro.fmt}`}
          className="inline-block mt-4 text-[15px] font-semibold text-blue-600 hover:underline break-all">
          {`${apiBase}/agents/download/linux?fmt=${data.distro.fmt}`}
        </a>
      )}

      {/* Windows downloads. .bat and .msi both resolve to the SAME server route
          (/agents/install/actmon-agent.msi) — it builds a fresh MSI per request
          with THIS wizard's token/URL baked in as its defaults, so either one is
          a real double-click install with nothing to type. (There's also a
          generic, unconfigured MSI at /agents/download/windows?fmt=msi for
          scripted mass-deployment where the caller supplies its own per-host
          token — that one is deliberately NOT used here, since this wizard
          already has a concrete token in hand and serving the blank one would
          just be confusing.) Only the raw .exe has no installer wrapper to carry
          a default into, so it still needs the token/URL supplied manually —
          called out below rather than hidden. */}
      {isWin && (
        <div className="mt-4">
          <div className="flex flex-wrap items-stretch gap-3">
            <div>
              <a href={`${apiBase}/agents/install/actmon-install.bat?token=${data.token}&url=${encodeURIComponent(apiBase)}`} download
                className="inline-flex items-center gap-2 h-11 px-5 rounded-lg bg-emerald-600 text-white text-[15px] font-black hover:bg-emerald-700 shadow-sm">
                <Download size={16} /> Download ActMon Agent Installer (.bat)
              </a>
              <p className="text-[12px] text-emerald-700 font-semibold mt-1.5">Recommended — nothing to type, double-click and click Yes.</p>
            </div>
            <div>
              <a href={`${apiBase}/agents/install/actmon-agent.msi?token=${data.token}&url=${encodeURIComponent(apiBase)}`} download
                className="inline-flex items-center gap-2 h-11 px-5 rounded-lg bg-emerald-600 text-white text-[15px] font-black hover:bg-emerald-700 shadow-sm">
                <Download size={16} /> Download Agent .msi
              </a>
              <p className="text-[12px] text-emerald-700 font-semibold mt-1.5">Also pre-configured — same token/URL baked in.</p>
            </div>
            <div>
              <a href={`${apiBase}/agents/download/windows?fmt=exe`} download
                className="inline-flex items-center gap-2 h-11 px-5 rounded-lg bg-emerald-600 text-white text-[15px] font-black hover:bg-emerald-700 shadow-sm">
                <Download size={16} /> Download Agent .exe
              </a>
              <p className="text-[12px] text-slate-500 mt-1.5">Needs the token/URL typed in — see below.</p>
            </div>
          </div>

          <p className="text-[13px] text-slate-500 mt-3">
            <b>.bat / .msi:</b> download, then on the target machine double-click it and click Yes on the admin prompt (if SmartScreen appears: <b>More info → Run anyway</b>) —
            it installs and configures itself automatically, and the host appears in <b>Agents</b> under its own name. (Not code-signed, so "unknown publisher" is expected.)
          </p>
          <p className="text-[13px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2.5">
            <b>.exe is NOT pre-configured with this token</b> — a raw executable has no installer wrapper to carry a default into. Double-clicking it on its own
            installs with a blank server URL/token, and the host won't appear in Agents until that's fixed. Set{' '}
            <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">ACTMON_ACCESS_TOKEN</code> / <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">ACTMON_URL</code>{' '}
            as environment variables before running it.
          </p>
        </div>
      )}

      {/* Warning */}
      <div className="mt-5 rounded-lg bg-amber-50 border border-amber-200 p-3.5 flex items-center gap-3">
        <AlertTriangle size={18} className="text-amber-500 flex-shrink-0" />
        <p className="text-[15px] text-slate-700">Copy the script and execute it on the target host with <span className="font-black">{isWin ? 'Administrator' : 'root'}</span> privileges.</p>
      </div>

      {/* Script block */}
      <div className="mt-4 relative rounded-lg border border-slate-200 bg-slate-50">
        <button onClick={copy} className="absolute top-2.5 right-2.5 text-slate-500 hover:text-blue-600" title="Copy">
          {copied ? <Check size={17} className="text-emerald-600" /> : <Copy size={17} />}
        </button>
        <pre className="p-4 pr-12 text-[14px] leading-relaxed font-mono text-slate-800 whitespace-pre-wrap break-all">{script}</pre>
      </div>

      {/* Status */}
      <div className="mt-6 flex items-center gap-2.5">
        <span className="text-[15px] font-bold text-slate-700">Status:</span>
        {installed ? (
          <>
            <CheckCircle2 size={17} className="text-emerald-600" />
            <span className="text-[15px] font-bold text-emerald-600">Agent installed and reporting</span>
          </>
        ) : (
          <>
            <Loader2 size={16} className="text-blue-500 animate-spin" />
            <Info size={15} className="text-blue-500" />
            <span className="text-[15px] font-bold text-blue-600">Waiting for Agent installation</span>
          </>
        )}
      </div>
      <p className="text-[14px] text-slate-500 mt-1.5">
        {installed ? 'The Agent is online. Click Next to continue.' : 'When the Agent is successfully installed, this status will update automatically.'}
      </p>
    </div>
  );
}
