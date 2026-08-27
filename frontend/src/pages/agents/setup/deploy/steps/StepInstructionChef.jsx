import React, { useEffect, useState } from 'react';
import { Copy, Check, Download, Globe, Info, ShieldAlert, AlertTriangle } from 'lucide-react';
import { getHostIps } from '@/api/agents';
import { copyText } from '@/lib/clipboard';
import { buildChefRecipe, buildChefMetadata, buildChefSoloRb, chefRunCommand } from '../chefRecipe';

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

// Real "Instruction" step for the Chef automated-deployment method — a
// generated recipe that downloads and runs ActMon's own existing
// actmon-setup.sh/.ps1 on the target host, same install path the manual
// "Script-based installation" method uses (see chefRecipe.js). Chef normally
// runs client-side (pulled by chef-client) rather than pushed to many hosts
// from one control node the way Ansible is — the instructions reflect that:
// copy the cookbook to each target and run chef-client --local-mode there.
export default function StepInstructionChef({ data, setData }) {
  const targetOs = data.os === 'windows' ? 'windows' : 'linux';
  const [copiedWhich, setCopiedWhich] = useState(null);

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
  const recipe = data.token ? buildChefRecipe({ token: data.token, apiBase, targetOs }) : '';
  const metadata = buildChefMetadata();
  const soloRb = buildChefSoloRb();
  const runCmd = chefRunCommand();

  const copy = async (which, text) => {
    if (await copyText(text)) { setCopiedWhich(which); setTimeout(() => setCopiedWhich(null), 1600); }
  };

  return (
    <div className="max-w-4xl">
      <h3 className="text-[19px] font-black text-slate-800">Deploy with Chef</h3>
      <p className="text-[15px] text-slate-600 mt-2 leading-relaxed">
        This generates a minimal cookbook that installs the ActMon Agent — it downloads and runs the
        same install script the manual method uses. No agent-install logic is reimplemented in the recipe.
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

      <div className="mt-5 rounded-lg bg-red-50 border border-red-200 p-3.5 flex items-start gap-3">
        <ShieldAlert size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
        <p className="text-[13px] text-slate-700 leading-relaxed">
          <b>The generated recipe contains your ActMon registration token.</b> Treat it as a secret: do
          not commit it to source control, do not share it, and delete or otherwise protect the file
          once every target host has been enrolled.
        </p>
      </div>

      <h4 className="mt-6 text-[15px] font-black text-slate-800">1. Recipe</h4>
      {recipe ? (
        <>
          <div className="mt-1 flex items-center justify-between gap-3">
            <p className="text-[13px] text-slate-500">Save as <span className="font-mono">cookbooks/deploy_actmon_agent/recipes/default.rb</span>.</p>
            <button
              onClick={() => dl('default.rb', recipe)}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-slate-200 text-[12px] font-bold text-slate-600 hover:border-slate-300"
            >
              <Download size={13} /> Download
            </button>
          </div>
          <CodeBox text={recipe} onCopy={() => copy('recipe', recipe)} copied={copiedWhich === 'recipe'} />

          <h4 className="mt-6 text-[15px] font-black text-slate-800">2. Cookbook metadata</h4>
          <p className="mt-1 text-[13px] text-slate-500">Save as <span className="font-mono">cookbooks/deploy_actmon_agent/metadata.rb</span>.</p>
          <CodeBox text={metadata} onCopy={() => copy('metadata', metadata)} copied={copiedWhich === 'metadata'} />

          <h4 className="mt-6 text-[15px] font-black text-slate-800">3. Local-mode config</h4>
          <p className="mt-1 text-[13px] text-slate-500">
            Save as <span className="font-mono">solo.rb</span> next to the <span className="font-mono">cookbooks/</span> folder — lets this run
            with no Chef Server.
          </p>
          <CodeBox text={soloRb} onCopy={() => copy('solo', soloRb)} copied={copiedWhich === 'solo'} />

          <h4 className="mt-6 text-[15px] font-black text-slate-800">4. Run it (on each target host)</h4>
          <CodeBox text={runCmd} onCopy={() => copy('run', runCmd)} copied={copiedWhich === 'run'} />
        </>
      ) : (
        <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 p-3.5 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-[13px] text-slate-700 leading-relaxed">
            Couldn't generate a recipe — the registration token or the detected server URL didn't pass
            validation. Go back to the Ingestion Token step and confirm a token exists, then return here.
          </p>
        </div>
      )}

      <div className="mt-5 rounded-lg bg-blue-50 border border-blue-200 p-3.5 flex items-start gap-3">
        <Info size={18} className="text-blue-500 flex-shrink-0 mt-0.5" />
        <p className="text-[13px] text-slate-700 leading-relaxed">
          Chef normally runs on each node itself (pulled by chef-client), unlike Ansible's push model —
          copy the cookbook to each target host (e.g. via <code className="font-mono">scp</code> or your
          existing bootstrap process) and run the command above there. If you have a Chef Server, upload
          this cookbook and add it to each node's run-list instead. Each host appears under{' '}
          <b>Agents</b> as soon as it checks in.
        </p>
      </div>
    </div>
  );
}
