// Puppet manifest templates for the Deploy Agent wizard's "Instruction" step
// (method: 'puppet'). Same security model as ansiblePlaybook.js/chefRecipe.js:
//  - token/apiBase are validated by the SHARED sanitizers (deploySecurity.js)
//    before they ever reach a template — an invalid value means "refuse to
//    generate", never "generate something broken".
//  - Puppet single-quoted strings only treat `\\` and `\'` as escapes (same
//    rule as Ruby's), so escapeSingleQuoted below covers both.
//  - Puppet's core `exec` resource has no built-in "download a URL" module
//    (unlike Ansible's get_url or Chef's remote_file) without adding the
//    third-party archive module — using curl/Invoke-WebRequest via `exec`
//    avoids that extra dependency. The command is a FIXED literal with only
//    the (already validated + escaped) URL interpolated — never built by
//    concatenating anything else user-controlled.
//  - The manifest only downloads and runs ActMon's existing install script —
//    no agent-install logic is reimplemented here.
//  - Puppet normally runs pulled by a puppet agent from a Puppet Server, not
//    pushed out from one control node — `puppet apply` (used here) is the
//    one Puppet mode that genuinely needs no server at all, so the run
//    instructions apply the manifest locally on each target rather than
//    assuming Puppet Server/Bolt infrastructure the user may not have.

import { sanitizeToken, sanitizeApiBase, sanitizeTargetOs } from './deploySecurity';

function escapePuppetSingleQuoted(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function scriptUrl(apiBase, token, scriptName) {
  const safeBase = escapePuppetSingleQuoted(apiBase);
  const safeToken = escapePuppetSingleQuoted(token);
  return `${safeBase}/agents/install/${scriptName}?token=${safeToken}&url=${encodeURIComponent(apiBase)}&arch=amd64`;
}

function linuxManifest(token, apiBase) {
  const url = scriptUrl(apiBase, token, 'actmon-setup.sh');
  return `# WARNING: this file embeds your ActMon registration token (see the "token="
# query parameter below). Treat it as a secret — do not commit it to
# version control, do not share it, and delete it once every target host has
# been enrolled.

exec { 'download-actmon-setup':
  command => "curl -fsSL -o /tmp/actmon-setup.sh '${url}'",
  path    => ['/usr/bin', '/bin'],
  creates => '/tmp/actmon-setup.sh',
}

exec { 'run-actmon-setup':
  command => '/bin/sh /tmp/actmon-setup.sh',
  path    => ['/usr/bin', '/bin'],
  creates => '/etc/systemd/system/actmon-agent.service',
  require => Exec['download-actmon-setup'],
}
`;
}

function windowsManifest(token, apiBase) {
  const url = scriptUrl(apiBase, token, 'actmon-setup.ps1');
  return `# WARNING: this file embeds your ActMon registration token (see the "token="
# query parameter below). Treat it as a secret — do not commit it to
# version control, do not share it, and delete it once every target host has
# been enrolled.

exec { 'download-actmon-setup':
  command => "powershell.exe -NoProfile -Command \\"Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile 'C:\\\\Windows\\\\Temp\\\\actmon-setup.ps1'\\"",
  creates => 'C:\\\\Windows\\\\Temp\\\\actmon-setup.ps1',
}

exec { 'run-actmon-setup':
  command => 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\\\Windows\\\\Temp\\\\actmon-setup.ps1',
  require => Exec['download-actmon-setup'],
}
`;
}

/** targetOs: 'linux' | 'windows'. Returns '' if token/apiBase don't validate —
 * callers must treat that as "cannot generate yet", never render an empty
 * result as if it were a real manifest. */
export function buildPuppetManifest({ token, apiBase, targetOs }) {
  const safeToken = sanitizeToken(token);
  const safeBase = sanitizeApiBase(apiBase);
  if (!safeToken || !safeBase) return '';
  return sanitizeTargetOs(targetOs) === 'windows'
    ? windowsManifest(safeToken, safeBase)
    : linuxManifest(safeToken, safeBase);
}

export function puppetRunCommand(targetOs) {
  return `sudo puppet apply deploy-actmon-agent-${sanitizeTargetOs(targetOs)}.pp`;
}
