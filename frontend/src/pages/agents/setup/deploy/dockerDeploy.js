// Docker deployment templates for the Deploy Agent wizard's "Instruction"
// step (method: 'docker'). Same security model as ansiblePlaybook.js/
// chefRecipe.js/puppetManifest.js, plus one Docker-specific concern:
//
//  - The IMAGE BUILD never sees a secret. The Dockerfile downloads the real
//    Linux agent script (Backend/agent/linux/common/actmon-agent.sh, a pure
//    bash script — no agent-install logic is reimplemented here) from
//    GET /agents/install/actmon-agent.sh, a plain, unparameterized route with
//    no token involved at all — so the built image is generic and safe to
//    keep or push to a registry. Only apiBase (not a secret — it's already
//    visible in the browser's own address bar) is baked in as a build ARG.
//  - The TOKEN is only ever supplied at `docker run` time via an env var —
//    never baked into the image. The agent script already requires
//    ACTMON_ACCESS_TOKEN/ACTMON_URL from the environment
//    (`: "${ACTMON_ACCESS_TOKEN:?...}"` in actmon-agent.sh), so no code
//    change was needed to support this.
//  - A token passed via `docker run -e` lands in shell history and is
//    readable via `docker inspect`/`/proc/<pid>/environ` to anyone with
//    docker socket access — buildDockerEnvFile()/the --env-file run command
//    are the safer alternative this module offers alongside the inline form,
//    mirroring Ansible's Vault-over-inline guidance.
//  - Real host visibility (not just the container's own isolated view) comes
//    from nsenter re-executing the UNMODIFIED agent script inside the host's
//    own namespaces — zero agent-code changes, just a different execution
//    environment. This requires --pid=host and --privileged at `docker run`
//    time, a real, broad privilege grant — disclosed prominently in the UI,
//    not hidden in fine print.

import { sanitizeToken, sanitizeApiBase } from './deploySecurity';

// Container base image per target distro flavor — mirrors
// Backend/database/app/services/agent/agent_install_service.py's
// DOCKER_OS_FLAVORS exactly (keep both in sync). The agent script itself is
// plain, distro-agnostic bash, so the only real difference between flavors
// is which base image/package manager installs the same handful of tools.
export const DOCKER_OS_FLAVORS = {
  debian: { label: 'Linux (Debian-based)', image: 'debian:bookworm-slim',
    install: 'apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates iproute2 procps util-linux && rm -rf /var/lib/apt/lists/*' },
  ubuntu: { label: 'Ubuntu', image: 'ubuntu:22.04',
    install: 'apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates iproute2 procps util-linux && rm -rf /var/lib/apt/lists/*' },
  oracle: { label: 'Oracle Linux', image: 'oraclelinux:9-slim',
    install: 'dnf install -y bash curl ca-certificates iproute procps-ng util-linux && dnf clean all' },
};
export const DEFAULT_DOCKER_OS_FLAVOR = 'debian';

function escapeDockerfileValue(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Returns '' if apiBase doesn't validate — callers must treat that as
 * "cannot generate yet", never render an empty result as if it were real. */
export function buildDockerfile({ apiBase, osFlavor = DEFAULT_DOCKER_OS_FLAVOR }) {
  const safeBase = sanitizeApiBase(apiBase);
  if (!safeBase) return '';
  const argValue = escapeDockerfileValue(safeBase);
  const flavor = DOCKER_OS_FLAVORS[osFlavor] || DOCKER_OS_FLAVORS[DEFAULT_DOCKER_OS_FLAVOR];
  return `FROM ${flavor.image}

# curl for the agent's own runtime infra-push; ss/ip + free/ps/top + nsenter
# for the container's ENTRYPOINT and the commands the agent shells out to.
RUN ${flavor.install}

WORKDIR /usr/lib/actmon

# Build-time download of the agent script ONLY — a plain, unparameterized GET
# with no credentials involved (see this file's own header comment). apiBase
# is not a secret; it is safe to bake into the image as a build argument.
ARG ACTMON_BUILD_URL="${argValue}"
RUN curl -fsSL "\${ACTMON_BUILD_URL}/agents/install/actmon-agent.sh" -o actmon-agent.sh \\
    && chmod 755 actmon-agent.sh

# ACTMON_ACCESS_TOKEN / ACTMON_URL are supplied at \`docker run\` time via -e or
# --env-file — never baked into this image (see the security note above).
#
# nsenter re-executes the UNMODIFIED agent script inside the HOST's own
# mount/uts/ipc/net/pid namespaces (targeting PID 1, which is only the real
# host's init when the container is run with --pid=host), so every
# ss/free/df/ps/ip call the script shells out to sees the real host, not this
# container's own isolated view. Requires --pid=host --privileged at
# \`docker run\` time — see the wizard's own warning before running this.
ENTRYPOINT ["nsenter", "--target", "1", "--mount", "--uts", "--ipc", "--net", "--pid", "--", \\
            "bash", "/usr/lib/actmon/actmon-agent.sh"]
`;
}

/** Docker's own official convenience script — works across Debian/Ubuntu/
 * Oracle Linux/RHEL-family (get.docker.com auto-detects the distro). Nothing
 * ActMon-specific — shown as its own step so Docker can be installed (or
 * confirmed already present) before the main script, not just silently
 * inside it. The main one-shot install script also runs this same command
 * automatically if docker is missing — this is the same step, just visible
 * and runnable on its own. */
export function dockerInstallCommandLinux() {
  return 'curl -fsSL https://get.docker.com | sudo sh';
}

/** Docker Desktop's own documented silent-install flags + the bundled
 * DockerCli.exe engine-switch tool — no ActMon-specific content. Static (no
 * token/apiBase involved), same reasoning as the Linux command above: a
 * separate, visible "install Docker first" step, even though the main
 * Windows one-shot script also attempts this automatically. */
export function buildDockerDesktopInstallScript() {
  return `# Installs Docker Desktop for Windows (silent) and switches it to Windows
# containers mode. Nothing ActMon-specific here -- just Docker's own
# documented silent-install flags.
$ErrorActionPreference = 'Stop'

if (Get-Command docker -ErrorAction SilentlyContinue) {
    Write-Host 'Docker is already installed.'
} else {
    Write-Host 'Installing Docker Desktop (silent)...'
    $installer = Join-Path $env:TEMP ('DockerDesktopInstaller-' + [guid]::NewGuid() + '.exe')
    Invoke-WebRequest -Uri 'https://desktop.docker.com/win/main/amd64/Docker Desktop Installer.exe' -OutFile $installer
    Start-Process -FilePath $installer -ArgumentList 'install', '--quiet', '--accept-license' -Wait
    Remove-Item $installer -Force -ErrorAction SilentlyContinue
    Write-Host 'Docker Desktop installed. Windows usually needs a RESTART the first time before Docker will actually run -- restart this machine now, then re-run this script to switch engines.'
}

$dockerCli = Join-Path $env:ProgramFiles 'Docker\\Docker\\DockerCli.exe'
if (Test-Path $dockerCli) {
    Write-Host 'Switching Docker Desktop to Windows containers mode...'
    & $dockerCli -SwitchWindowsEngine
} else {
    Write-Host 'DockerCli.exe not found yet -- if this ran right after a fresh install, restart and re-run this script.'
}
`;
}

export function buildDockerBuildCommand({ apiBase }) {
  const safeBase = sanitizeApiBase(apiBase);
  return safeBase ? `docker build --build-arg ACTMON_BUILD_URL="${safeBase}" -t actmon-agent:latest .` : '';
}

/** Inline form — simplest to run, but the token is visible in shell history
 * and via `docker inspect`. buildDockerEnvFile()'s form is safer. */
export function buildDockerRunCommand({ token, apiBase }) {
  const safeToken = sanitizeToken(token);
  const safeBase = sanitizeApiBase(apiBase);
  if (!safeToken || !safeBase) return '';
  return `docker run -d --name actmon-agent --restart=always \\
  --pid=host --privileged \\
  -e ACTMON_ACCESS_TOKEN='${safeToken}' \\
  -e ACTMON_URL='${safeBase}' \\
  actmon-agent:latest`;
}

/** The recommended alternative: token lives in a local, chmod-600 file
 * instead of the command line / shell history. */
export function buildDockerEnvFile({ token, apiBase }) {
  const safeToken = sanitizeToken(token);
  const safeBase = sanitizeApiBase(apiBase);
  if (!safeToken || !safeBase) return '';
  return `ACTMON_ACCESS_TOKEN=${safeToken}\nACTMON_URL=${safeBase}\n`;
}

export function buildDockerRunWithEnvFileCommand() {
  return `chmod 600 actmon.env
docker run -d --name actmon-agent --restart=always \\
  --pid=host --privileged \\
  --env-file actmon.env \\
  actmon-agent:latest`;
}

/** One self-contained script: installs Docker if missing, writes the
 * Dockerfile (embedded via a QUOTED heredoc — <<'EOF', not <<EOF — so bash
 * never expands anything inside it; Docker itself resolves ${ACTMON_BUILD_URL}
 * at build time), builds the image, and runs the container — the same
 * "download one file, run one command" experience the .bat/.sh installers
 * already give for the other methods. Returns '' if token/apiBase don't
 * validate, same contract as every other builder here. */
export function buildDockerInstallScript({ token, apiBase, osFlavor = DEFAULT_DOCKER_OS_FLAVOR }) {
  const safeToken = sanitizeToken(token);
  const safeBase = sanitizeApiBase(apiBase);
  if (!safeToken || !safeBase) return '';
  const dockerfile = buildDockerfile({ apiBase: safeBase, osFlavor });
  if (!dockerfile) return '';

  return `#!/usr/bin/env bash
# ActMon Docker Agent installer — builds and runs the ActMon agent as a
# container with real host visibility (see the Dockerfile embedded below).
#
# WARNING: this script embeds your ActMon registration token. Treat it as a
# secret: do not commit it to version control, do not share it, and delete
# it once the container is confirmed running (see step 4 below).
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found — installing via get.docker.com ..."
  curl -fsSL https://get.docker.com | sh
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cat > "$WORKDIR/Dockerfile" <<'ACTMON_DOCKERFILE_EOF'
${dockerfile}ACTMON_DOCKERFILE_EOF

echo "Building the actmon-agent image..."
docker build --build-arg ACTMON_BUILD_URL="${safeBase}" -t actmon-agent:latest "$WORKDIR"

docker rm -f actmon-agent >/dev/null 2>&1 || true

echo "Starting the ActMon agent container..."
docker run -d --name actmon-agent --restart=always \\
  --pid=host --privileged \\
  -e ACTMON_ACCESS_TOKEN='${safeToken}' \\
  -e ACTMON_URL='${safeBase}' \\
  actmon-agent:latest

echo "Done — check 'docker logs -f actmon-agent' and the Agents page in ActMon."
echo "Delete this script now that the container is running — it contains your token."
`;
}
