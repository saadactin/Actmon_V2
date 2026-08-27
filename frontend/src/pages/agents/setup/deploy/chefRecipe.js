// Chef recipe/cookbook templates for the Deploy Agent wizard's "Instruction"
// step (method: 'chef'). Same security model as ansiblePlaybook.js:
//  - token/apiBase are validated by the SHARED sanitizers (deploySecurity.js)
//    before they ever reach a template; an invalid value means "refuse to
//    generate", never "generate something broken".
//  - Ruby double-quoted strings interpolate `#{...}` — on top of escaping
//    backslash and double-quote, this file ALSO neutralizes a bare `#` so a
//    malicious value could never smuggle in Ruby interpolation. In practice
//    the validated token/apiBase charset can never contain any of these
//    characters anyway; this is defense in depth, not the only guard.
//  - The recipe only downloads and runs ActMon's existing install script —
//    no agent-install logic is reimplemented here.
//  - Chef normally runs client-side (pulled by chef-client), not pushed out
//    to many hosts from one control node the way Ansible is — the run
//    instructions reflect that (copy the cookbook to each target and run
//    chef-client --local-mode there, or use knife/Chef Server if you have
//    one), rather than pretending Chef has an Ansible-style inventory.

import { sanitizeToken, sanitizeApiBase, sanitizeTargetOs } from './deploySecurity';

function escapeRubyDoubleQuoted(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/#/g, '\\#');
}

function scriptUrl(apiBase, token, scriptName) {
  const safeBase = escapeRubyDoubleQuoted(apiBase);
  const safeToken = escapeRubyDoubleQuoted(token);
  return `${safeBase}/agents/install/${scriptName}?token=${safeToken}&url=${encodeURIComponent(apiBase)}&arch=amd64`;
}

function linuxRecipe(token, apiBase) {
  const url = scriptUrl(apiBase, token, 'actmon-setup.sh');
  return `# WARNING: this file embeds your ActMon registration token (see the "token="
# query parameter below). Treat it as a secret — do not commit it to
# version control, do not share it, and delete it once every target host has
# been enrolled.

remote_file '/tmp/actmon-setup.sh' do
  source "${url}"
  mode '0700'
  action :create
end

execute 'run-actmon-setup' do
  command '/tmp/actmon-setup.sh'
  user 'root'
  not_if { ::File.exist?('/etc/systemd/system/actmon-agent.service') }
end
`;
}

function windowsRecipe(token, apiBase) {
  const url = scriptUrl(apiBase, token, 'actmon-setup.ps1');
  return `# WARNING: this file embeds your ActMon registration token (see the "token="
# query parameter below). Treat it as a secret — do not commit it to
# version control, do not share it, and delete it once every target host has
# been enrolled.

remote_file 'C:\\Windows\\Temp\\actmon-setup.ps1' do
  source "${url}"
  action :create
end

powershell_script 'run-actmon-setup' do
  code 'C:\\Windows\\Temp\\actmon-setup.ps1'
end
`;
}

/** targetOs: 'linux' | 'windows'. Returns '' if token/apiBase don't validate —
 * callers must treat that as "cannot generate yet", never render an empty
 * result as if it were a real recipe. */
export function buildChefRecipe({ token, apiBase, targetOs }) {
  const safeToken = sanitizeToken(token);
  const safeBase = sanitizeApiBase(apiBase);
  if (!safeToken || !safeBase) return '';
  return sanitizeTargetOs(targetOs) === 'windows'
    ? windowsRecipe(safeToken, safeBase)
    : linuxRecipe(safeToken, safeBase);
}

export function buildChefMetadata() {
  return `name 'deploy_actmon_agent'
maintainer 'ActMon'
maintainer_email 'noreply@actmon.local'
license 'Apache-2.0'
description 'Installs the ActMon Agent by running its own install script'
version '1.0.0'
`;
}

/** cookbook_path config for a self-contained local run — no Chef Server
 * required, matching the plain `puppet apply` / `ansible-playbook` model. */
export function buildChefSoloRb() {
  return `cookbook_path ['./cookbooks']
`;
}

export function chefRunCommand() {
  return 'sudo chef-client --local-mode --config solo.rb --runlist \'recipe[deploy_actmon_agent]\'';
}
