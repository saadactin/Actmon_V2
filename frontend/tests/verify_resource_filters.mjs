// The filter wire format, in both directions.
//
// This exists because of saved views. A view is stored in the backend's
// vocabulary and reopened in the UI's, so if `toParams` and `fromParams` ever
// disagree, a saved view silently reopens as a DIFFERENT query — same name,
// same description, different rows. Nothing about the UI would look wrong.
import { fromParams, toParams } from '../src/features/cloud/api/resources.api.js';
import { EMPTY_FILTERS } from '../src/features/cloud/utils/resourceModel.js';

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

console.log('\n1. A saved view round-trips through the wire format');
const original = {
  ...EMPTY_FILTERS,
  q: 'prod',
  providers: ['AWS', 'Azure'],
  types: ['EC2Instance'],
  categories: ['COMPUTE', 'STORAGE'],
  regions: ['ap-mumbai-1'],
  statuses: ['STOPPED'],
  risk: ['CRITICAL', 'HIGH'],
  environments: ['prod'],
  owners: ['platform'],
  resourceGroups: ['rg-1'],
  compartments: ['cmp-1'],
  attachment: 'UNATTACHED',
  tagKey: 'Owner',
  tagValue: 'platform',
  missingTag: 'CostCenter',
  hasTags: false,
  hasCost: true,
  hasFindings: true,
  stale: true,
  costMin: 10,
  costMax: 900,
  includeDefaults: false,
};

const wire = toParams(original);
const back = { ...EMPTY_FILTERS, ...fromParams(wire) };

Object.keys(EMPTY_FILTERS).forEach((key) => {
  const a = JSON.stringify(original[key]);
  const b = JSON.stringify(back[key]);
  check(`${key} survives the round trip`, a === b, a === b ? '' : `${a} -> ${b}`);
});

console.log('\n2. The wire format uses the backend\'s own parameter names');
check('providers -> provider', JSON.stringify(wire.provider) === '["AWS","Azure"]');
check('statuses -> status', JSON.stringify(wire.status) === '["STOPPED"]');
check('resourceGroups -> resource_group', JSON.stringify(wire.resource_group) === '["rg-1"]');
check('hasTags -> has_tags', wire.has_tags === false);
check('costMin -> cost_min', wire.cost_min === 10);
check('includeDefaults=false -> include_defaults=false', wire.include_defaults === false);

console.log('\n3. Absent is absent, not a value');
const empty = toParams(EMPTY_FILTERS);
const sent = Object.entries(empty).filter(([, v]) => v !== undefined);
check('an unfiltered view sends nothing at all', sent.length === 0, JSON.stringify(sent));
check('and reading nothing back yields no filters',
  JSON.stringify(fromParams({})) === '{}');

console.log('\n4. false is carried, never dropped as falsy');
check('has_tags=false is sent', toParams({ ...EMPTY_FILTERS, hasTags: false }).has_tags === false);
check('has_cost=false is sent', toParams({ ...EMPTY_FILTERS, hasCost: false }).has_cost === false);
check('has_tags=false is read back', fromParams({ has_tags: false }).hasTags === false);
check('absent has_tags stays absent',
  !Object.prototype.hasOwnProperty.call(fromParams({}), 'hasTags'));

console.log('\n5. A single wire value is read back as a list');
// FastAPI returns one value for a single-element repeated param; reading that
// as the string "AWS" would make `filters.providers.includes(...)` iterate
// characters and match nothing.
check('a bare string becomes a one-element array',
  JSON.stringify(fromParams({ provider: 'AWS' }).providers) === '["AWS"]');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
