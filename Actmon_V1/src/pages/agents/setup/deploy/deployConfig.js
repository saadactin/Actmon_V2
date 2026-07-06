// Add-Agent (deploy) wizard configuration — ActMon-style flow.
// The step list is DYNAMIC: it depends on the chosen deployment method.

// Manual host install (script / installer) → full 7-step flow.
const MANUAL_STEPS = ['Deployment', 'Ingestion Token', 'Configuration', 'Installation', 'Logs', 'Suggested Alerts', 'Summary'];
// Linux targets get a Distribution picker between Configuration and Installation.
const MANUAL_STEPS_LINUX = ['Deployment', 'Ingestion Token', 'Configuration', 'Distribution', 'Installation', 'Logs', 'Suggested Alerts', 'Summary'];
// Automated / container methods (ansible, chef, puppet, saltstack, docker, k8s) → compact 4-step flow.
const AUTOMATED_STEPS = ['Deployment', 'Ingestion Token', 'Instruction', 'Suggested Alerts'];

export const MANUAL_METHODS = ['script', 'installer'];

// Returns the ordered step list for a given deployment method + target OS.
export function stepsForMethod(method, os) {
  if (!MANUAL_METHODS.includes(method)) return AUTOMATED_STEPS;
  return os === 'linux' ? MANUAL_STEPS_LINUX : MANUAL_STEPS;
}

// Linux distribution catalog for the Distribution step. Each entry maps to the
// package format we serve (deb|rpm) and the package-manager install program.
export const DISTRO_GROUPS = [
  {
    title: 'Supported Distributions',
    items: [
      { id: 'amazon',  name: 'Amazon Linux 2+',                  fmt: 'rpm', pm: 'yum' },
      { id: 'centos',  name: 'CentOS 7+',                        fmt: 'rpm', pm: 'yum' },
      { id: 'debian',  name: 'Debian 10+',                       fmt: 'deb', pm: 'dpkg' },
      { id: 'fedora',  name: 'Fedora 32+',                       fmt: 'rpm', pm: 'dnf' },
      { id: 'kali',    name: 'Kali 2021+',                       fmt: 'deb', pm: 'dpkg' },
      { id: 'opensuse', name: 'OpenSUSE 15+',                    fmt: 'rpm', pm: 'zypper' },
      { id: 'oracle',  name: 'Oracle Linux 8+',                  fmt: 'rpm', pm: 'dnf' },
      { id: 'redhat',  name: 'RedHat 7.1+',                      fmt: 'rpm', pm: 'yum' },
      { id: 'rocky',   name: 'Rocky 8+',                         fmt: 'rpm', pm: 'dnf' },
      { id: 'suse',    name: 'SUSE Linux Enterprise Server 15+', fmt: 'rpm', pm: 'zypper' },
      { id: 'ubuntu',  name: 'Ubuntu 18.04+',                    fmt: 'deb', pm: 'dpkg' },
    ],
  },
  {
    title: 'Package Managers',
    items: [
      { id: 'dpkg',   name: 'DPKG',   fmt: 'deb', pm: 'dpkg' },
      { id: 'dnf',    name: 'DNF',    fmt: 'rpm', pm: 'dnf' },
      { id: 'rpm',    name: 'RPM',    fmt: 'rpm', pm: 'rpm' },
      { id: 'yum',    name: 'YUM',    fmt: 'rpm', pm: 'yum' },
      { id: 'zypper', name: 'ZYPPER', fmt: 'rpm', pm: 'zypper' },
    ],
  },
  {
    title: 'Legacy Distributions',
    items: [
      { id: 'centos6', name: 'CentOS 6', fmt: 'rpm', pm: 'yum' },
      { id: 'redhat6', name: 'RedHat 6', fmt: 'rpm', pm: 'yum' },
    ],
  },
];

// Install command for a package file, per package manager.
export function pmInstallCmd(pm, file) {
  switch (pm) {
    case 'dpkg':   return `dpkg -i ${file}`;
    case 'dnf':    return `dnf install -y ./${file}`;
    case 'yum':    return `yum localinstall -y ./${file}`;
    case 'zypper': return `zypper --non-interactive install --allow-unsigned-rpm ./${file}`;
    case 'rpm':    return `rpm -Uvh ./${file}`;
    default:       return `dpkg -i ${file}`;
  }
}

// Kept for reference / default.
export const DEPLOY_STEPS = MANUAL_STEPS;

// Deployment methods, grouped exactly like the ActMon "Add Agent" screen.
export const DEPLOY_GROUPS = [
  {
    title: 'Install Agent manually on the host (Linux, Windows)',
    methods: [
      { id: 'script', name: 'Script-based installation', recommended: true, desc: 'Automatically validates the OS version and installs Agent via provided script.' },
      { id: 'installer', name: 'Installer', desc: 'Manually download and run the installer with the provided command.' },
    ],
  },
  {
    title: 'Use an automated deployment method',
    methods: [
      { id: 'ansible', name: 'Ansible', desc: 'Use Ansible for automated agent deployment and system management.' },
      { id: 'chef', name: 'Chef', desc: 'Use Chef for automated agent deployment and system management.' },
      { id: 'puppet', name: 'Puppet', desc: 'Use Puppet for automated agent deployment and system management.' },
      { id: 'saltstack', name: 'SaltStack', desc: 'Use SaltStack for automated agent deployment and system management.' },
    ],
  },
  {
    title: 'Use Docker image with ActMon Agent',
    methods: [
      { id: 'docker', name: 'Docker Image', desc: 'Deploy the Agent as a Docker image.' },
      { id: 'k8s', name: 'Inside Kubernetes Cluster', desc: 'Deploy the Agent on the Kubernetes platform.' },
    ],
  },
];
