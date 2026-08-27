import React, { useEffect, useState } from 'react';
import { Copy, Check, Download, Globe, Info, ShieldAlert, AlertTriangle } from 'lucide-react';
import { getHostIps } from '@/api/agents';
import { copyText } from '@/lib/clipboard';
import { buildAnsiblePlaybook, buildInventoryExample, ansiblePlaybookRunCommand } from '../ansiblePlaybook';

const ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';
const IS_LOCAL = /^(localhost|127\.)/i.test(typeof window !== 'undefined' ? window.location.hostname : '');

function dl(name, content) {
  const b = new Blob([content], { type: 'text/yaml' });
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

// Real "Instruction" step for the Ansible automated-deployment method — a
// generated playbook that downloads and runs ActMon's own existing
// actmon-setup.sh/.ps1 on every target host, same install path the manual
// "Script-based installation" method uses (see ansiblePlaybook.js, which owns
// all input validation/escaping — this component never interpolates
// token/apiBase into anything itself).
export default function StepInstructionAnsible({ data, setData }) {
  const targetOs = data.os === 'windows' ? 'windows' : 'linux';
  const [copiedWhich, setCopiedWhich] = useState(null);

  // Server URL as reachable FROM THE TARGET HOSTS — same auto-detect
  // StepInstallation.jsx already does (window.origin, with a LAN-IP fallback
  // when browsing on localhost, since 'localhost' means nothing to a remote VM).
  const [serverBase, setServerBase] = useState(ORIGIN);
  useEffect(() => {
    if (!IS_LOCAL) return;
    getHostIps().then(({ primary, ips }) => {
      const port = window.location.port ? `:${window.location.port}` : '';
      const proto = window.location.protocol;
      if (primary) setServerBase(`${proto}//${primary}${port}`);
    }).catch(() => {});
  }, []);

  const apiBase = `${serverBase.replace(/\/+$/, '')}/api/v1`;
  const isHttps = /^https:/i.test(serverBase);
  // No fallback placeholder token — a fake one would either look like a real
  // secret or (correctly) get rejected by sanitizeToken() anyway. If there's
  // genuinely no token yet, the generator below refuses instead of emitting
  // something misleading.
  const playbook = data.token ? buildAnsiblePlaybook({ token: data.token, apiBase, targetOs }) : '';
  const inventory = buildInventoryExample({ targetOs });
  const runCmd = ansiblePlaybookRunCommand(targetOs);
  const playbookFile = `deploy-actmon-agent-${targetOs}.yml`;

  const copy = async (which, text) => {
    if (await copyText(text)) { setCopiedWhich(which); setTimeout(() => setCopiedWhich(null), 1600); }
  };

  return (
    <div className="max-w-4xl">
      <h3 className="text-[19px] font-black text-slate-800">Deploy with Ansible</h3>
      <p className="text-[15px] text-slate-600 mt-2 leading-relaxed">
        This generates a ready-to-run playbook that installs the ActMon Agent on every host in your
        inventory — it downloads and runs the same install script the manual method uses, just driven
        by Ansible instead of pasted by hand. No agent-install logic lives in the playbook itself.
      </p>

      <div className="mt-4 flex items-center gap-2 text-[13px] text-slate-500">
        <Globe size={14} className="text-slate-400" />
        <span>Agent reports to <span className="font-mono font-semibold text-slate-600">{serverBase}</span> — detected automatically from this server.</span>
      </div>

      {!isHttps && (
        <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3 flex items-start gap-2.5">
          <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-[12.5px] text-slate-700 leading-relaxed">
            This ActMon server is reachable over <b>HTTP</b>, not HTTPS — the token below travels
            unencrypted between the target host and ActMon during install. Use HTTPS for this server if
            at all possible.
          </p>
        </div>
      )}

      <div className="mt-5 flex gap-2">
        {['linux', 'windows'].map((os) => (
          <button
            key={os}
            type="button"
            onClick={() => setData({ os })}
            className={`h-9 px-4 rounded-lg text-[13px] font-bold border ${
              targetOs === os ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}
          >
            {os === 'linux' ? 'Linux targets' : 'Windows targets'}
          </button>
        ))}
      </div>

      {/* Required security notice — the playbook embeds a real registration
          token (see ansiblePlaybook.js's own in-file warning comment too). */}
      <div className="mt-5 rounded-lg bg-red-50 border border-red-200 p-3.5 flex items-start gap-3">
        <ShieldAlert size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
        <p className="text-[13px] text-slate-700 leading-relaxed">
          <b>The generated playbook contains your ActMon registration token.</b> Treat it as a secret:
          do not commit it to source control, do not share it, and delete or otherwise protect the file
          once every target host has been enrolled.
        </p>
      </div>

      <h4 className="mt-6 text-[15px] font-black text-slate-800">1. Playbook</h4>
      {playbook ? (
        <>
          <div className="mt-1 flex items-center justify-between gap-3">
            <p className="text-[13px] text-slate-500">Save this as <span className="font-mono">{playbookFile}</span>.</p>
            <button
              onClick={() => dl(playbookFile, playbook)}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-slate-200 text-[12px] font-bold text-slate-600 hover:border-slate-300"
            >
              <Download size={13} /> Download
            </button>
          </div>
          <CodeBox text={playbook} onCopy={() => copy('playbook', playbook)} copied={copiedWhich === 'playbook'} />
        </>
      ) : (
        <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 p-3.5 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-[13px] text-slate-700 leading-relaxed">
            Couldn't generate a playbook — the registration token or the detected server URL didn't pass
            validation. Go back to the Ingestion Token step and confirm a token exists, then return here.
          </p>
        </div>
      )}

      <h4 className="mt-6 text-[15px] font-black text-slate-800">2. Inventory</h4>
      <p className="mt-1 text-[13px] text-slate-500">
        Example <span className="font-mono">inventory.ini</span> — replace the hosts with your own. Store
        real SSH/WinRM credentials in Ansible Vault (or SSH keys), never in plaintext here.
      </p>
      <CodeBox text={inventory} onCopy={() => copy('inventory', inventory)} copied={copiedWhich === 'inventory'} />

      <h4 className="mt-6 text-[15px] font-black text-slate-800">3. Run it</h4>
      <CodeBox text={runCmd} onCopy={() => copy('run', runCmd)} copied={copiedWhich === 'run'} />

      <div className="mt-5 rounded-lg bg-blue-50 border border-blue-200 p-3.5 flex items-start gap-3">
        <Info size={18} className="text-blue-500 flex-shrink-0 mt-0.5" />
        <p className="text-[13px] text-slate-700 leading-relaxed">
          Run this from a machine with Ansible installed and SSH ({targetOs === 'windows' ? 'or WinRM ' : ''})
          access to your targets. Each host appears under <b>Agents</b> as soon as it checks in.
        </p>
      </div>
    </div>
  );
}
