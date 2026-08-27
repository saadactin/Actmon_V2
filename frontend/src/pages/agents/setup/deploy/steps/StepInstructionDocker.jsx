import React, { useEffect, useState } from 'react';
import { Copy, Check, Download, Globe, Info, ShieldAlert, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { getHostIps } from '@/api/agents';
import { copyText } from '@/lib/clipboard';
import {
  buildDockerInstallScript, buildDockerfile, buildDockerBuildCommand, buildDockerRunCommand,
  buildDockerEnvFile, buildDockerRunWithEnvFileCommand, DOCKER_OS_FLAVORS, DEFAULT_DOCKER_OS_FLAVOR,
  dockerInstallCommandLinux, buildDockerDesktopInstallScript,
} from '../dockerDeploy';
import { sanitizeToken, sanitizeApiBase } from '../deploySecurity';

// 'windows' is a genuinely lesser option — Windows containers have no
// equivalent of nsenter/--pid=host, so a Windows container only ever sees
// its OWN isolated process/network view, never the true host's the way the
// Linux flavors do. Still offered (disclosed clearly below), since the agent
// itself already runs fine standalone in a container with no code changes.
const OS_CHOICES = [
  { id: 'debian', label: 'Linux' },
  { id: 'ubuntu', label: 'Ubuntu' },
  { id: 'oracle', label: 'Oracle Linux' },
  { id: 'windows', label: 'Windows' },
];

const ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';
const IS_LOCAL = /^(localhost|127\.)/i.test(typeof window !== 'undefined' ? window.location.hostname : '');

function dl(name, content) {
  const b = new Blob([content], { type: 'text/plain' });
  const u = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = u; a.download = name; a.click();
  URL.revokeObjectURL(u);
}

function CodeBox({ text, onCopy, copied }) {
  return (
    <div className="mt-3 relative rounded-lg border border-slate-200 bg-slate-50">
      <button onClick={onCopy} className="absolute top-2.5 right-2.5 text-slate-500 hover:text-blue-600" title="Copy">
        {copied ? <Check size={17} className="text-emerald-600" /> : <Copy size={17} />}
      </button>
      <pre className="p-4 pr-12 text-[13px] leading-relaxed font-mono text-slate-800 whitespace-pre-wrap break-all">{text}</pre>
    </div>
  );
}

// Real "Instruction" step for the Docker automated-deployment method — a
// generated Dockerfile that downloads and runs ActMon's own existing
// actmon-agent.sh at container startup (see dockerDeploy.js). Unlike
// Ansible/Chef/Puppet, this runs the agent INSIDE a container rather than
// directly on a host, so getting real host metrics (not just the container's
// own isolated view) needs nsenter + --pid=host --privileged — a genuine,
// broad privilege grant, disclosed here rather than hidden in fine print.
//
// Primary path is ONE downloadable script (install/build/run in one go),
// same "download one file, run one command" shape as the .bat/.sh installers
// already offer for the manual method — the Dockerfile/build/run breakdown
// underneath is for anyone who wants to inspect or customize it by hand.
export default function StepInstructionDocker({ data }) {
  const [copiedWhich, setCopiedWhich] = useState(null);
  const [runForm, setRunForm] = useState('inline'); // 'inline' | 'envfile'
  const [showManual, setShowManual] = useState(false);
  const [osFlavor, setOsFlavor] = useState(DEFAULT_DOCKER_OS_FLAVOR);
  const isWindows = osFlavor === 'windows';

  const [serverBase, setServerBase] = useState(ORIGIN);
  useEffect(() => {
    if (!IS_LOCAL) return;
    getHostIps().then(({ primary }) => {
      const port = window.location.port ? `:${window.location.port}` : '';
      const proto = window.location.protocol;
      if (primary) setServerBase(`${proto}//${primary}${port}`);
    }).catch(() => {});
  }, []);

  const apiBase = `${serverBase.replace(/\/+$/, '')}/api/v1`;
  const isHttps = /^https:/i.test(serverBase);
  const safeToken = sanitizeToken(data.token);
  const safeBase = sanitizeApiBase(apiBase);
  const curlCmd = !isWindows && safeToken && safeBase
    ? `curl -fsSL "${safeBase}/agents/install/actmon-docker-setup.sh?token=${safeToken}&url=${encodeURIComponent(safeBase)}&os=${osFlavor}" | sudo bash`
    : '';
  const windowsScriptUrl = isWindows && safeToken && safeBase
    ? `${safeBase}/agents/install/actmon-docker-setup.ps1?token=${safeToken}&url=${encodeURIComponent(safeBase)}`
    : '';
  // Primary Windows path: a double-clickable .bat (self-elevating wrapper
  // around the .ps1 above) — download, double-click, click Yes, done. Same
  // "no terminal, no folder, no flags" shape as the existing Agent .bat.
  const windowsBatUrl = isWindows && safeToken && safeBase
    ? `${safeBase}/agents/install/actmon-docker-setup.bat?token=${safeToken}&url=${encodeURIComponent(safeBase)}`
    : '';
  const windowsRunCmd = 'Unblock-File .\\deploy-actmon-docker.ps1\npowershell -ExecutionPolicy Bypass -File .\\deploy-actmon-docker.ps1';
  const dockerInstallCmd = dockerInstallCommandLinux();
  const dockerDesktopScript = buildDockerDesktopInstallScript();
  const installScript = !isWindows && data.token ? buildDockerInstallScript({ token: data.token, apiBase, osFlavor }) : '';
  const dockerfile = !isWindows ? buildDockerfile({ apiBase, osFlavor }) : '';
  const buildCmd = !isWindows ? buildDockerBuildCommand({ apiBase }) : '';
  const runInline = !isWindows && data.token ? buildDockerRunCommand({ token: data.token, apiBase }) : '';
  const envFile = !isWindows && data.token ? buildDockerEnvFile({ token: data.token, apiBase }) : '';
  const runEnvFile = buildDockerRunWithEnvFileCommand();

  const copy = async (which, text) => {
    if (await copyText(text)) { setCopiedWhich(which); setTimeout(() => setCopiedWhich(null), 1600); }
  };

  return (
    <div className="max-w-4xl">
      <h3 className="text-[19px] font-black text-slate-800">Deploy as a Docker Image</h3>
      <p className="text-[15px] text-slate-600 mt-2 leading-relaxed">
        One script builds and runs the ActMon agent as a container — the same agent script the manual
        method uses, just running inside a container instead of directly on the host.
      </p>

      <h4 className="mt-5 text-[13px] font-black text-slate-800 uppercase tracking-wide">Target OS</h4>
      <div className="mt-2 flex flex-wrap gap-2">
        {OS_CHOICES.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => setOsFlavor(o.id)}
            className={`h-9 px-4 rounded-lg text-[13px] font-bold border ${
              osFlavor === o.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}
          >
            {o.label}
          </button>
        ))}
      </div>

      {isWindows ? (
        <>
          <div className="mt-4 rounded-lg bg-orange-50 border border-orange-200 p-3.5 flex items-start gap-3">
            <ShieldAlert size={18} className="text-orange-500 flex-shrink-0 mt-0.5" />
            <p className="text-[13px] text-slate-700 leading-relaxed">
              <b>This is a genuinely lesser option than the Linux flavors.</b> There's no Windows equivalent
              of <code className="font-mono">nsenter</code>/<code className="font-mono">--pid=host</code>,
              so this container only ever sees <b>its own isolated</b> process/network view — not the real
              host's. CPU/RAM tend to track the host closely (process-isolated containers share the host's
              scheduler), but the process list and network stats are container-scoped only. For full,
              accurate host visibility on Windows, prefer <b>WinRM</b> or the <b>Agent installer</b> instead.
            </p>
          </div>

          <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3.5 flex items-start gap-3">
            <AlertTriangle size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-[13px] text-slate-700 leading-relaxed">
              Requires a <b>Windows Server</b> host with Docker set to <b>Windows containers</b> mode (not
              Linux/WSL2), and <code className="font-mono">--isolation=process</code> — which only works
              when the container's Windows build matches the host's. This script defaults to{' '}
              <span className="font-mono">ltsc2022</span>; if it fails with a build-mismatch error, edit the
              downloaded script's <span className="font-mono">FROM</span> line to match your host (check
              your host's build with <span className="font-mono">winver</span>).
            </p>
          </div>

          {!isHttps && (
            <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3 flex items-start gap-2.5">
              <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-[12.5px] text-slate-700 leading-relaxed">
                This ActMon server is reachable over <b>HTTP</b>, not HTTPS — the token below travels
                unencrypted during install. Use HTTPS for this server if at all possible.
              </p>
            </div>
          )}

          <div className="mt-3 rounded-lg bg-red-50 border border-red-200 p-3.5 flex items-start gap-3">
            <ShieldAlert size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-[13px] text-slate-700 leading-relaxed">
              <b>The downloaded script contains your ActMon registration token.</b> Treat it as a secret —
              do not commit it to version control, do not share it, and delete it once the container is
              confirmed running.
            </p>
          </div>

          <h4 className="mt-6 text-[15px] font-black text-slate-800">Run this on the target Windows server</h4>
          {windowsBatUrl ? (
            <>
              <div className="mt-1 flex items-center justify-between gap-3">
                <p className="text-[13px] text-slate-500">
                  Download, copy it to the server, then just <b>double-click it and click Yes</b> on the
                  admin prompt. It installs Docker if needed, builds the image, and starts the container —
                  nothing to type.
                </p>
                <a
                  href={windowsBatUrl}
                  download="deploy-actmon-docker.bat"
                  className="inline-flex shrink-0 items-center gap-1.5 h-9 px-4 rounded-lg bg-emerald-600 text-white text-[13px] font-black hover:bg-emerald-700 shadow-sm"
                >
                  <Download size={14} /> Download
                </a>
              </div>
              <p className="mt-2 text-[12px] text-slate-500">
                (Not code-signed, so "unknown publisher" is expected — click <b>More info → Run anyway</b> if
                SmartScreen appears.)
              </p>
              <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 p-3.5 text-[13px] text-slate-600 leading-relaxed">
                If Docker needs installing, this restarts the machine <b>once</b> and picks back up
                automatically the next time you log in — no need to re-download or re-run anything
                yourself. If Docker is already installed, it goes straight to building and starting the
                container.
              </div>
            </>
          ) : (
            <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 p-3.5 flex items-start gap-3">
              <AlertTriangle size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-[13px] text-slate-700 leading-relaxed">
                Couldn't generate the download link — the registration token or the detected server URL
                didn't pass validation. Go back to the Ingestion Token step and confirm a token exists.
              </p>
            </div>
          )}

          <div className="mt-5 rounded-lg bg-blue-50 border border-blue-200 p-3.5 flex items-start gap-3">
            <Info size={18} className="text-blue-500 flex-shrink-0 mt-0.5" />
            <p className="text-[13px] text-slate-700 leading-relaxed">
              Run this on the Windows Docker host itself — not on your own machine unless that's literally
              the host you're monitoring. The host appears under <b>Agents</b> as soon as the container
              starts reporting.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setShowManual((v) => !v)}
            className="mt-6 flex items-center gap-1.5 text-[13px] font-bold text-slate-500 hover:text-slate-700"
          >
            {showManual ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            Prefer to install Docker and run this yourself, step by step?
          </button>

          {showManual && (
            <div className="mt-3 border-t border-slate-200 pt-5">
              <h4 className="text-[15px] font-black text-slate-800">1. Install Docker (skip if already installed)</h4>
              <div className="mt-1 flex items-center justify-between gap-3">
                <p className="text-[13px] text-slate-500">Downloads Docker Desktop, installs it silently, and switches it to Windows containers mode.</p>
                <button
                  onClick={() => dl('install-docker-windows.ps1', dockerDesktopScript)}
                  className="inline-flex shrink-0 items-center gap-1.5 h-8 px-3 rounded-lg border border-slate-200 text-[12px] font-bold text-slate-600 hover:border-slate-300"
                >
                  <Download size={13} /> Download
                </button>
              </div>
              <CodeBox text={dockerDesktopScript} onCopy={() => copy('dockerdesktop', dockerDesktopScript)} copied={copiedWhich === 'dockerdesktop'} />

              <h4 className="mt-6 text-[15px] font-black text-slate-800">2. Build + run the agent container</h4>
              {windowsScriptUrl ? (
                <>
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <p className="text-[13px] text-slate-500">Save as <span className="font-mono">deploy-actmon-docker.ps1</span>.</p>
                    <a
                      href={windowsScriptUrl}
                      download="deploy-actmon-docker.ps1"
                      className="inline-flex shrink-0 items-center gap-1.5 h-8 px-3 rounded-lg border border-slate-200 text-[12px] font-bold text-slate-600 hover:border-slate-300"
                    >
                      <Download size={13} /> Download
                    </a>
                  </div>
                  <p className="mt-3 text-[13px] text-slate-500">Then, in PowerShell on that server:</p>
                  <CodeBox text={windowsRunCmd} onCopy={() => copy('winrun', windowsRunCmd)} copied={copiedWhich === 'winrun'} />
                  <p className="mt-2 text-[12px] text-slate-500">
                    <span className="font-mono">Unblock-File</span> clears the "downloaded from the internet"
                    flag Windows puts on the file — without it, PowerShell's default execution policy refuses
                    to run it.
                  </p>
                </>
              ) : (
                <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 p-3.5 flex items-start gap-3">
                  <AlertTriangle size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
                  <p className="text-[13px] text-slate-700 leading-relaxed">
                    Couldn't generate the download link — the registration token or the detected server URL
                    didn't pass validation.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
      <>
      <div className="mt-4 flex items-center gap-2 text-[13px] text-slate-500">
        <Globe size={14} className="text-slate-400" />
        <span>Agent reports to <span className="font-mono font-semibold text-slate-600">{serverBase}</span> — detected automatically from this server.</span>
      </div>

      {!isHttps && (
        <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3 flex items-start gap-2.5">
          <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-[12.5px] text-slate-700 leading-relaxed">
            This ActMon server is reachable over <b>HTTP</b>, not HTTPS — the token below travels
            unencrypted between the container and ActMon during install. Use HTTPS for this server if
            at all possible.
          </p>
        </div>
      )}

      <div className="mt-5 rounded-lg bg-red-50 border border-red-200 p-3.5 flex items-start gap-3">
        <ShieldAlert size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
        <p className="text-[13px] text-slate-700 leading-relaxed">
          <b>The script below contains your ActMon registration token.</b> Treat it as a secret — do not
          commit it to version control, do not share it, and delete it once the container is confirmed
          running.
        </p>
      </div>

      <div className="mt-3 rounded-lg bg-orange-50 border border-orange-200 p-3.5 flex items-start gap-3">
        <ShieldAlert size={18} className="text-orange-500 flex-shrink-0 mt-0.5" />
        <p className="text-[13px] text-slate-700 leading-relaxed">
          <b>This container runs with <code className="font-mono">--pid=host --privileged</code>.</b> That's
          real, broad access to the host — it's what lets the agent see the host's true CPU/RAM/disk/
          process/network stats instead of just the container's own isolated view (the same tradeoff
          every host-monitoring Docker agent makes). Only run this on hosts where that level of trust is
          acceptable.
        </p>
      </div>

      <h4 className="mt-6 text-[15px] font-black text-slate-800">0. Install Docker (skip if already installed)</h4>
      <p className="mt-1 text-[13px] text-slate-500">
        Docker's own official install script — works on Debian, Ubuntu, and Oracle Linux/RHEL-family
        alike. The main command below also runs this automatically if Docker isn't found — this is only
        for installing it ahead of time or on its own.
      </p>
      <CodeBox text={dockerInstallCmd} onCopy={() => copy('dockerinstall', dockerInstallCmd)} copied={copiedWhich === 'dockerinstall'} />

      <h4 className="mt-6 text-[15px] font-black text-slate-800">1. Run this on the target Linux server</h4>
      <p className="mt-1 text-[13px] text-slate-500">
        SSH into the Linux host you want monitored, then paste this one line. It installs Docker if
        needed, builds the image, and starts the container — nothing else to type.
      </p>
      {curlCmd ? (
        <CodeBox text={curlCmd} onCopy={() => copy('curl', curlCmd)} copied={copiedWhich === 'curl'} />
      ) : (
        <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 p-3.5 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-[13px] text-slate-700 leading-relaxed">
            Couldn't generate the command — the registration token or the detected server URL didn't pass
            validation. Go back to the Ingestion Token step and confirm a token exists, then return here.
          </p>
        </div>
      )}

      <div className="mt-5 rounded-lg bg-blue-50 border border-blue-200 p-3.5 flex items-start gap-3">
        <Info size={18} className="text-blue-500 flex-shrink-0 mt-0.5" />
        <p className="text-[13px] text-slate-700 leading-relaxed">
          Run this on the Docker host itself over SSH — not on your own Windows/Mac machine unless that's
          literally the host you're monitoring. The host appears under <b>Agents</b> as soon as the
          container starts reporting.
        </p>
      </div>

      {installScript && (
        <>
          <h4 className="mt-6 text-[15px] font-black text-slate-800">No direct internet access from that server?</h4>
          <div className="mt-1 flex items-center justify-between gap-3">
            <p className="text-[13px] text-slate-500">
              Download this instead, copy it over (e.g. <span className="font-mono">scp</span>), then run{' '}
              <span className="font-mono">bash deploy-actmon-docker.sh</span> there — same result as the
              command above, just transferred by hand instead of curled directly.
            </p>
            <button
              onClick={() => dl('deploy-actmon-docker.sh', installScript)}
              className="inline-flex shrink-0 items-center gap-1.5 h-9 px-4 rounded-lg border border-slate-200 text-[13px] font-bold text-slate-600 hover:border-slate-300"
            >
              <Download size={14} /> Download
            </button>
          </div>
          <CodeBox text={installScript} onCopy={() => copy('script', installScript)} copied={copiedWhich === 'script'} />
        </>
      )}

      <button
        type="button"
        onClick={() => setShowManual((v) => !v)}
        className="mt-6 flex items-center gap-1.5 text-[13px] font-bold text-slate-500 hover:text-slate-700"
      >
        {showManual ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        Prefer to build and run it yourself, step by step?
      </button>

      {showManual && (
        <div className="mt-3 border-t border-slate-200 pt-5">
          <h4 className="text-[15px] font-black text-slate-800">1. Dockerfile</h4>
          <div className="mt-1 flex items-center justify-between gap-3">
            <p className="text-[13px] text-slate-500">Save as <span className="font-mono">Dockerfile</span> and build it in that directory.</p>
            <button
              onClick={() => dl('Dockerfile', dockerfile)}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-slate-200 text-[12px] font-bold text-slate-600 hover:border-slate-300"
            >
              <Download size={13} /> Download
            </button>
          </div>
          <CodeBox text={dockerfile} onCopy={() => copy('dockerfile', dockerfile)} copied={copiedWhich === 'dockerfile'} />

          <h4 className="mt-6 text-[15px] font-black text-slate-800">2. Build</h4>
          <CodeBox text={buildCmd} onCopy={() => copy('build', buildCmd)} copied={copiedWhich === 'build'} />

          <h4 className="mt-6 text-[15px] font-black text-slate-800">3. Run</h4>
          <div className="mt-2 flex gap-2">
            {[{ id: 'inline', label: 'Inline (simplest)' }, { id: 'envfile', label: 'Env file (recommended)' }].map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => setRunForm(o.id)}
                className={`h-8 px-3 rounded-lg text-[12px] font-bold border ${
                  runForm === o.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}
              >
                {o.label}
              </button>
            ))}
          </div>

          {runForm === 'inline' ? (
            runInline && <CodeBox text={runInline} onCopy={() => copy('run', runInline)} copied={copiedWhich === 'run'} />
          ) : (
            <>
              <p className="mt-2 text-[13px] text-slate-500">Save as <span className="font-mono">actmon.env</span> in the same directory:</p>
              {envFile && <CodeBox text={envFile} onCopy={() => copy('envfile', envFile)} copied={copiedWhich === 'envfile'} />}
              <CodeBox text={runEnvFile} onCopy={() => copy('runenv', runEnvFile)} copied={copiedWhich === 'runenv'} />
            </>
          )}
        </div>
      )}
      </>
      )}
    </div>
  );
}
