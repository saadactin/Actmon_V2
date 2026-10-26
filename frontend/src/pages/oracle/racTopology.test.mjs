/* The topology view draws a picture of the cluster, and a picture is exactly
   the place a missing reading turns into a confident claim. These tests pin
   the two rules that matter: a reading the collector never made is never
   rendered as a number, and a genuine zero still is. */

import { readFileSync } from 'node:fs';

const FILE = 'E:/ACTMON V1/frontend/src/pages/oracle/RacTopology.jsx';
const SRC = readFileSync(FILE, 'utf8');

// The reading rules live in a plain module so they can run without a DOM.
const { pct, toneFor, clusterHealth } = await import(
  'file:///E:/ACTMON%20V1/frontend/src/pages/oracle/racTopologyUtils.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ', m); } else { fail++; console.log('  FAIL ', m); } };

console.log('=== a reading that was never taken is not a number ===');
ok(pct(null) === null, 'null is not a reading');
ok(pct(undefined) === null, 'undefined is not a reading');
ok(pct('') === null, 'an empty string is not a reading');
ok(pct('n/a') === null, 'unparseable text is not a reading');
ok(pct('Awaiting metrics') === null, 'a status word is not a reading');

console.log('\n=== a genuine zero IS a reading ===');
ok(pct(0) === 0, 'a host that reported 0% is at 0%, not unknown');
ok(pct('0%') === 0, 'and the same when the collector sent it as a string');

console.log('\n=== the collector\'s string forms are understood ===');
ok(pct('8%') === 8, 'a percent sign is stripped');
ok(pct(' 68 ') === 68, 'surrounding whitespace is ignored');
ok(pct(88) === 88, 'a plain number passes through');
ok(pct('12.5%') === 12.5, 'a fractional reading keeps its fraction');

console.log('\n=== instance state maps to meaning, not to position ===');
ok(toneFor('OPEN') === 'ok', 'OPEN is healthy');
ok(toneFor('ACTIVE') === 'ok', 'ACTIVE is healthy');
ok(toneFor('STARTED') === 'warn', 'STARTED is not serving yet');
ok(toneFor('') === 'unknown', 'no status is unknown, not bad');
ok(toneFor(null) === 'unknown', 'a missing status is unknown');
ok(toneFor('SHUTDOWN') === 'bad', 'an unrecognised state is not quietly green');

console.log('\n=== the source makes no claims of its own ===');
// Everything on screen must come from a prop. A literal percentage, hostname,
// disk-group name or node count in the source would survive a backend that
// returned nothing — which is precisely the failure this view must not have.
const stripped = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')          // block comments
  .replace(/^\s*\/\/.*$/gm, '')              // line comments
  .replace(/className="[^"]*"/g, '')         // tailwind sizes/colours
  .replace(/style=\{\{[^}]*\}\}/g, '');
ok(!/\+(DATA|RECO|ARCH|FRA)\b/.test(stripped), 'no disk-group name is written into the view');
ok(!/KCDB|koebomebspat/i.test(stripped), 'no instance or host name is written into the view');
ok(!/\b\d+%/.test(stripped.replace(/\$\{[^}]*\}%/g, '')), 'no literal percentage is rendered');
ok(!/10\.240\./.test(stripped), 'no IP address is written into the view');

console.log('\n=== the absent-data wording is present ===');
ok(SRC.includes('Metrics unavailable'), 'a node with no host reading says "Metrics unavailable"');
ok(SRC.includes('Data unavailable'), 'unreadable disk groups say "Data unavailable"');
ok(SRC.includes("'Unknown'"), 'an unread state says "Unknown"');
ok(SRC.includes("'Unreachable'"), 'a host that could not be reached says so, rather than showing blanks');
ok(SRC.includes('Usage unknown'), 'a disk group with no usage figure says so instead of showing 0%');
ok(SRC.includes('has not been collected yet'),
   'a node with no host record at all explains the gap');

console.log('\n=== the status frame can never contradict the status dots ===');
// The node's identity colour (green for node 1, blue for node 2) is decoration.
// A card wearing a green frame around a MOUNTED instance would be the exact
// false-healthy signal this view must not produce.
ok(/states\.includes\('bad'\)/.test(SRC) && /states\.includes\('warn'\)/.test(SRC),
   'an unhealthy node takes its status colour, not its identity colour');
ok(/states\.every\(\(t\) => t === 'unknown'\)/.test(SRC),
   'a node with nothing known wears the unknown colour, not a healthy one');

console.log('\n=== the animation is decoration, and says so ===');
const CSS = readFileSync('E:/ACTMON V1/frontend/src/pages/oracle/racTopology.css', 'utf8');
ok(CSS.includes('prefers-reduced-motion'), 'motion preference is honoured');
ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.rac-rail-dot\s*\{\s*display:\s*none/.test(CSS),
   'the travelling dots are removed, not frozen mid-track');
ok(/@keyframes rac-rail-flow/.test(CSS), 'the interconnect dots are animated');
ok(/@keyframes rac-dash-(down|right|left)/.test(CSS), 'the storage connectors are animated');
ok(!/traffic|throughput|replication|bytes|packets/i.test(
     SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
   'nothing on screen claims to show traffic, throughput or replication');

console.log('\n=== node count and health are derived, not asserted ===');
ok(/nodes\.length/.test(SRC), 'the node count comes from the payload');
ok(/clusterHealth\(nodes\)/.test(SRC), 'cluster health is computed, not written in');
ok(clusterHealth([{ instance_status: 'OPEN' }, { instance_status: 'OPEN' }]).label === 'Cluster Healthy',
   'two open instances are a healthy cluster');
ok(clusterHealth([{ instance_status: 'OPEN' }, { instance_status: 'MOUNTED' }]).label
     === '1 instance(s) not open',
   'one instance short of open is NOT reported as healthy');
ok(clusterHealth([{ instance_status: 'MOUNTED' }]).tone === 'danger',
   'no open instance is a danger, not a warning');
ok(clusterHealth([]).label === 'Unknown',
   'an empty cluster is unknown, not healthy');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
