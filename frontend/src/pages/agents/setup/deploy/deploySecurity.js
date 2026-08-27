// Shared input validation for every "automated deployment method" template
// generator (Ansible, Chef, Puppet, ...). Each tool's own template file
// (ansiblePlaybook.js, chefRecipe.js, puppetManifest.js) still owns its OWN
// escaping for its OWN DSL's string-literal rules (YAML, Ruby, Puppet each
// treat quotes/backslashes differently) — this file only owns the one thing
// they all share: deciding whether a token/apiBase/OS is safe to use at all.

const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Only the exact charset ActMon's own makeToken() ever produces
 * ('actmon-' + hex, see DeployAgentWizard.jsx) is accepted — anything else
 * (whitespace, quotes, backslashes, DSL/shell metacharacters) is rejected
 * rather than silently interpolated into a generated file. */
export function sanitizeToken(token) {
  const t = String(token || '');
  return TOKEN_RE.test(t) ? t : '';
}

// Valid DNS hostname/IPv4 charset only — the WHATWG URL parser is lenient
// enough to accept some hostnames containing characters (e.g. a literal
// double-quote) that have no business in a real one; this is an independent,
// explicit allow-list rather than trusting URL parsing alone to reject them.
const HOSTNAME_RE = /^[a-zA-Z0-9.-]+$/;

/** Must be a well-formed absolute http(s) URL with no embedded userinfo
 * (http://user:pass@host is never something this app generates and must
 * never be trusted from elsewhere either). Returns '' if invalid so callers
 * can refuse to generate a file rather than embed a bad URL. */
export function sanitizeApiBase(apiBase) {
  let u;
  try {
    u = new URL(String(apiBase || ''));
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(u.protocol)) return '';
  if (u.username || u.password) return '';
  if (!HOSTNAME_RE.test(u.hostname)) return '';
  return u.toString().replace(/\/+$/, '');
}

export function sanitizeTargetOs(os) {
  return os === 'windows' ? 'windows' : 'linux';
}
