import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Copy, Check, Info, Loader2, CheckCircle2, Globe } from 'lucide-react';
import { createInstallToken, listAgents, getHostIps } from '../../../../../api/agents';

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
      // One elevated step (UAC): installs the MSI, writes the token, and creates
      // a boot-time SYSTEM service task that starts the agent immediately.
      const setup = `${url}/agents/install/actmon-setup.ps1?token=${token}&url=${encodeURIComponent(url)}&arch=${arch}`;
      return `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',"iex ((New-Object Net.WebClient).DownloadString('${setup}'))"`;
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
      `if command -v dpkg >/dev/null 2>&1; then dl actmon-agent.deb "${url}/agents/download/linux?fmt=deb" && ` +
      `ACTMON_ACCESS_TOKEN="${token}" ACTMON_URL="${url}" dpkg -i actmon-agent.deb; ` +
      `elif command -v rpm >/dev/null 2>&1; then dl actmon-agent.rpm "${url}/agents/download/linux?fmt=rpm" && ` +
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
  const [serverBase, setServerBase] = useState(ORIGIN);
  const [candidates, setCandidates] = useState([]);
  useEffect(() => {
    if (!IS_LOCAL) return;
    getHostIps().then(({ primary, ips }) => {
      const port = window.location.port ? `:${window.location.port}` : '';
      const proto = window.location.protocol;
      setCandidates((ips || []).map((ip) => `${proto}//${ip}${port}`));
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

  // Poll for the agent coming online after the script is executed on the host.
  useEffect(() => {
    if (installed) return undefined;
    const timer = setInterval(async () => {
      try {
        const agents = await listAgents();
        const base = (agentNameRef.current || data.tokenName || '').toLowerCase();
        const hit = agents.find((a) => a.status === 'online' && base && (a.name || '').toLowerCase().startsWith(base));
        if (hit) { setInstalled(true); onInstalled?.(true); clearInterval(timer); }
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

      {/* Server URL as reachable from the target host (editable — pick the right adapter) */}
      <div className="mt-5 max-w-xl">
        <label className="flex items-center gap-1.5 text-[15px] font-black text-slate-800 mb-1.5">
          <Globe size={15} className="text-slate-400" /> ActMon Server URL
        </label>
        <input value={serverBase} onChange={(e) => setServerBase(e.target.value)} list="server-base-options" spellCheck={false}
          className="w-full h-11 px-3.5 rounded-lg border border-slate-300 text-[15px] font-mono outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-50" />
        <datalist id="server-base-options">{candidates.map((c) => <option key={c} value={c} />)}</datalist>
        <p className="text-[13px] text-slate-500 mt-1.5">
          Must be reachable <span className="font-bold">from the target host</span> — not <span className="font-mono">localhost</span>.
          {candidates.length > 1 && ' Multiple network adapters detected; pick the one on the same network as the target (e.g. the VMware host-only adapter).'}
        </p>
      </div>

      {/* Package download link (distro chosen on the Distribution step) */}
      {!isWin && data.distro && (
        <a href={`${apiBase}/agents/download/linux?fmt=${data.distro.fmt}`}
          className="inline-block mt-4 text-[15px] font-semibold text-blue-600 hover:underline break-all">
          {`${apiBase}/agents/download/linux?fmt=${data.distro.fmt}`}
        </a>
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
