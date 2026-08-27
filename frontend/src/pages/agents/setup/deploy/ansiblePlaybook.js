// Ansible playbook / inventory templates for the Deploy Agent wizard's
// "Instruction" step (method: 'ansible').
//
// SECURITY MODEL — read before changing this file:
//  - The playbook is a thin wrapper around ActMon's own existing one-shot
//    install scripts (actmon-setup.sh / actmon-setup.ps1) — it never
//    reimplements install logic, and never builds a shell command by
//    concatenating a value into a string that gets interpreted as shell.
//    The `shell`/`win_shell` tasks below run a FIXED, literal, hardcoded
//    path with no interpolated value in them at all — the only place
//    token/apiBase are ever interpolated is as a `get_url`/`win_get_url`
//    `url:` argument, a plain HTTP GET, not a command line.
//  - Every value that reaches the YAML template is validated first
//    (sanitizeToken/sanitizeApiBase/sanitizeTargetOs) and then YAML-escaped
//    (escapeYamlDoubleQuoted) before interpolation — defense in depth, so a
//    malformed/malicious token or apiBase can neither break the YAML nor
//    smuggle anything into the eventual shell invocation.
//  - Nothing here ever accepts or embeds a target-host SSH/WinRM password —
//    that's the user's own inventory/Vault, entirely outside what this file
//    generates. The example inventory below deliberately does not contain a
//    plaintext password field.

import { sanitizeToken, sanitizeApiBase, sanitizeTargetOs } from './deploySecurity';

export { sanitizeToken, sanitizeApiBase, sanitizeTargetOs };

/** Escapes a value for safe placement inside a YAML DOUBLE-quoted scalar
 * (backslash and double-quote are the only two characters that are special
 * inside one — see the YAML 1.1/1.2 spec's double-quoted flow scalar rules).
 * Applied even though sanitizeToken/sanitizeApiBase already restrict the
 * input charset — this is the second, independent layer, not a replacement
 * for validation. */
function escapeYamlDoubleQuoted(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function scriptUrl(apiBase, token, scriptName) {
  const safeBase = escapeYamlDoubleQuoted(apiBase);
  const safeToken = escapeYamlDoubleQuoted(token);
  // apiBase is used both as the download host AND as the ?url= the script
  // reports itself back to — encodeURIComponent here is query-string
  // encoding (unrelated to the YAML escaping above; both are needed).
  return `${safeBase}/agents/install/${scriptName}?token=${safeToken}&url=${encodeURIComponent(apiBase)}&arch=amd64`;
}

function linuxPlaybook(token, apiBase) {
  const url = scriptUrl(apiBase, token, 'actmon-setup.sh');
  return `---
# WARNING: this file embeds your ActMon registration token (see the "token="
# query parameter below). Treat it as a secret — do not commit it to
# version control, do not share it, and delete it once every target host has
# been enrolled.
- name: Deploy ActMon Agent (Linux)
  hosts: actmon_targets
  tasks:
    - name: Download the ActMon install script
      ansible.builtin.get_url:
        url: "${url}"
        dest: /tmp/actmon-setup.sh
        mode: '0700'
        validate_certs: true

    - name: Run the ActMon install script
      ansible.builtin.shell: /tmp/actmon-setup.sh
      become: true
      args:
        creates: /etc/systemd/system/actmon-agent.service
`;
}

function windowsPlaybook(token, apiBase) {
  const url = scriptUrl(apiBase, token, 'actmon-setup.ps1');
  return `---
# WARNING: this file embeds your ActMon registration token (see the "token="
# query parameter below). Treat it as a secret — do not commit it to
# version control, do not share it, and delete it once every target host has
# been enrolled.
- name: Deploy ActMon Agent (Windows)
  hosts: actmon_targets
  tasks:
    - name: Download the ActMon install script
      ansible.windows.win_get_url:
        url: "${url}"
        dest: C:\\Windows\\Temp\\actmon-setup.ps1
        validate_certs: true

    - name: Run the ActMon install script
      ansible.windows.win_shell: C:\\Windows\\Temp\\actmon-setup.ps1
`;
}

/** targetOs: 'linux' | 'windows'. Returns '' (never a partially-built
 * playbook) if token/apiBase fail validation — callers must treat '' as
 * "cannot generate yet", not render it. */
export function buildAnsiblePlaybook({ token, apiBase, targetOs }) {
  const safeToken = sanitizeToken(token);
  const safeBase = sanitizeApiBase(apiBase);
  if (!safeToken || !safeBase) return '';
  return sanitizeTargetOs(targetOs) === 'windows'
    ? windowsPlaybook(safeToken, safeBase)
    : linuxPlaybook(safeToken, safeBase);
}

/** No password field — SSH/WinRM credentials are the user's own
 * inventory/Vault, never something this generator should propose in
 * plaintext. Points at ansible-vault / SSH keys instead. */
export function buildInventoryExample({ targetOs }) {
  if (sanitizeTargetOs(targetOs) === 'windows') {
    return `[actmon_targets]
win-host-01 ansible_host=10.0.0.11
win-host-02 ansible_host=10.0.0.12

[actmon_targets:vars]
ansible_connection=winrm
ansible_winrm_transport=ntlm
ansible_port=5985
ansible_user=actmon_svc
# Never put a real password here in plaintext. Store it in an Ansible Vault
# and reference it, e.g.:
#   ansible_password: "{{ vault_winrm_password }}"
# then: ansible-vault create group_vars/actmon_targets/vault.yml
#       ansible-playbook --ask-vault-pass -i inventory.ini deploy-actmon-agent-windows.yml
# A dedicated least-privilege service account is preferred over Administrator.
`;
  }
  return `[actmon_targets]
linux-host-01 ansible_host=10.0.0.21
linux-host-02 ansible_host=10.0.0.22

[actmon_targets:vars]
ansible_user=actmon_svc
# Prefer an SSH key over a password:
ansible_ssh_private_key_file=~/.ssh/id_actmon
# If you must use a password, keep it in Ansible Vault, never in plaintext:
#   ansible_password: "{{ vault_ssh_password }}"
#   ansible-vault create group_vars/actmon_targets/vault.yml
#   ansible-playbook --ask-vault-pass -i inventory.ini deploy-actmon-agent-linux.yml
`;
}

export function ansiblePlaybookRunCommand(targetOs) {
  return `ansible-playbook -i inventory.ini deploy-actmon-agent-${sanitizeTargetOs(targetOs)}.yml`;
}
