// utils/providerScope.js + utils/regions.js + utils/formatters.js —
// "which account, where is it, what do we call it".
//
// Three small modules, one suite, because they answer one question between
// them and their bugs compose: a provider that normalises inconsistently
// produces a route that 404s, an account that filters to nothing, or a
// tenant GUID displayed under a heading that says "Region".
//
// The load-bearing rules:
//   * Oracle and OCI are the same provider. Every comparison must go through
//     providerKeyOf, and slugForProvider('Oracle') must be 'oci' — there is
//     no /cloud/oracle-accounts route.
//   * A null provider key means NO FILTER, not "match nothing". Getting this
//     backwards empties the unfiltered view.
//   * An availability zone or domain is not a region. Three OCI ADs collapse
//     to one region — the bug that showed five "regions" for a two-region
//     tenancy.
import {
  KEY_TO_SLUG, SLUG_TO_KEY, accountInProvider, keyFromSlug, providerKeyOf,
  slugForProvider,
} from '../src/features/cloud/utils/providerScope.js';
import {
  GLOBAL, accountLocation, normalizeRegion, regionBreakdown, regionLabel,
} from '../src/features/cloud/utils/regions.js';
import {
  formatDate as legacyFormatDate, getProviderIcon,
} from '../src/features/cloud/utils/formatters.js';

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};

console.log('\n1. The slug maps are exact inverses');
{
  for (const [slug, key] of Object.entries(SLUG_TO_KEY)) {
    check(`SLUG_TO_KEY.${slug} -> ${key} -> back to ${slug}`,
      KEY_TO_SLUG[key] === slug, `${key} -> ${KEY_TO_SLUG[key]}`);
  }
  for (const [key, slug] of Object.entries(KEY_TO_SLUG)) {
    check(`KEY_TO_SLUG.${key} -> ${slug} -> back to ${key}`,
      SLUG_TO_KEY[slug] === key, `${slug} -> ${SLUG_TO_KEY[slug]}`);
  }
  check('the two maps are the same size — a provider added to one and not the '
    + 'other resolves its route but filters to zero accounts',
    Object.keys(SLUG_TO_KEY).length === Object.keys(KEY_TO_SLUG).length);
}

console.log('\n2. Oracle and OCI are one provider');
{
  check('providerKeyOf("Oracle") is "OCI"', providerKeyOf('Oracle') === 'OCI');
  check('providerKeyOf("OCI") is "OCI"', providerKeyOf('OCI') === 'OCI');
  check('providerKeyOf("AWS") passes through', providerKeyOf('AWS') === 'AWS');
  check('providerKeyOf(null) is an EMPTY STRING, not null — callers concatenate it',
    providerKeyOf(null) === '', JSON.stringify(providerKeyOf(null)));
  check('providerKeyOf(undefined) is likewise an empty string',
    providerKeyOf(undefined) === '');

  check('slugForProvider("Oracle") is "oci", NOT "oracle" — '
    + '/cloud/oracle-accounts is a route that does not exist',
    slugForProvider('Oracle') === 'oci', slugForProvider('Oracle'));
  check('slugForProvider("OCI") is "oci"', slugForProvider('OCI') === 'oci');
  check('slugForProvider("AWS") is "aws"', slugForProvider('AWS') === 'aws');
  check('slugForProvider of an unknown provider lowercases rather than '
    + 'returning undefined (an undefined segment builds "/cloud/undefined-accounts")',
    slugForProvider('Something') === 'something', slugForProvider('Something'));
  check('slugForProvider(null) is an empty string, not "undefined"',
    slugForProvider(null) === '', JSON.stringify(slugForProvider(null)));
}

console.log('\n3. keyFromSlug accepts a slug, a raw provider value, or either case');
{
  check('keyFromSlug("aws") is "AWS"', keyFromSlug('aws') === 'AWS');
  check('keyFromSlug("AWS") is "AWS" (a capitalised URL segment still resolves)',
    keyFromSlug('AWS') === 'AWS');
  check('keyFromSlug("oci") is "OCI"', keyFromSlug('oci') === 'OCI');
  check('keyFromSlug("Oracle") is "OCI" — a RAW provider value passed where a '
    + 'slug was expected must still resolve, not fall through to null',
    keyFromSlug('Oracle') === 'OCI', keyFromSlug('Oracle'));
  check('keyFromSlug("") is null', keyFromSlug('') === null);
  check('keyFromSlug(undefined) is null', keyFromSlug(undefined) === null);
  check('keyFromSlug(null) is null', keyFromSlug(null) === null);
}

console.log('\n4. accountInProvider: a null key means NO FILTER');
{
  check('a null provider key matches ANY account — this is the unfiltered '
    + 'view, and getting it backwards shows an empty list',
    accountInProvider({ provider: 'AWS' }, null) === true);
  check('a null key matches even a null account', accountInProvider(null, null) === true);
  check('an undefined key means no filter too', accountInProvider({ provider: 'AWS' }, undefined) === true);

  check('an Oracle account matches the OCI key',
    accountInProvider({ provider: 'Oracle' }, 'OCI') === true);
  check('an OCI account matches the OCI key',
    accountInProvider({ provider: 'OCI' }, 'OCI') === true);
  check('an AWS account does NOT match the OCI key',
    accountInProvider({ provider: 'AWS' }, 'OCI') === false);
  check('a null account does not match a real key (the ?. is load-bearing — '
    + 'this must not throw)', accountInProvider(null, 'AWS') === false);
  check('an account with no provider does not match a real key',
    accountInProvider({}, 'AWS') === false);
}

console.log('\n5. The composite property: chooser -> accounts list -> dashboard loses nobody');
{
  for (const provider of ['AWS', 'Azure', 'OCI', 'Oracle']) {
    const slug = slugForProvider(provider);
    const key = keyFromSlug(slug);
    check(`${provider}: slug "${slug}" round-trips to the same key providerKeyOf gives`,
      key === providerKeyOf(provider), `${key} vs ${providerKeyOf(provider)}`);
    check(`${provider}: an account of this provider survives its own round trip`,
      accountInProvider({ provider }, keyFromSlug(slugForProvider(provider))) === true);
  }
}

console.log('\n6. An availability zone or domain is NOT a region');
{
  // The original bug: five "regions" shown for a tenancy that has two.
  const ads = ['abcd:AP-MUMBAI-1-AD-1', 'abcd:AP-MUMBAI-1-AD-2', 'abcd:AP-MUMBAI-1-AD-3'];
  const normalised = ads.map(normalizeRegion);
  check('three OCI availability domains collapse to ONE region',
    new Set(normalised).size === 1, JSON.stringify(normalised));
  check('and that region is the real region name',
    normalised[0] === 'ap-mumbai-1', normalised[0]);

  check('an AWS availability zone drops its trailing letter',
    normalizeRegion('ap-south-1b') === 'ap-south-1', normalizeRegion('ap-south-1b'));
  check('a bare AWS region is NOT stripped (the regex must not eat a real '
    + 'region\'s trailing character)',
    normalizeRegion('ap-south-1') === 'ap-south-1', normalizeRegion('ap-south-1'));
  check('an AZ and its own region normalise to the same bucket',
    normalizeRegion('ap-south-1a') === normalizeRegion('ap-south-1'));
}

console.log('\n7. normalizeRegion: case folding, whitespace, and the global marker');
{
  check('"GLOBAL" folds to "global"', normalizeRegion('GLOBAL') === GLOBAL);
  check('"global" stays "global"', normalizeRegion('global') === GLOBAL);
  check('an ALL-UPPERCASE region lowercases', normalizeRegion('EASTUS') === 'eastus');
  check('a MIXED-case value is preserved as-is — the `v === v.toUpperCase()` '
    + 'branch is deliberately asymmetric, and "simplifying" it to an '
    + 'unconditional toLowerCase() would mangle a mixed-case provider value',
    normalizeRegion('eastUS') === 'eastUS', normalizeRegion('eastUS'));
  check('a lowercase region passes through', normalizeRegion('eastus') === 'eastus');

  check('null is null', normalizeRegion(null) === null);
  check('an empty string is null', normalizeRegion('') === null);
  check('a whitespace-only string is null, not a " " bucket',
    normalizeRegion('   ') === null, JSON.stringify(normalizeRegion('   ')));
  check('surrounding whitespace is trimmed', normalizeRegion('  eastus  ') === 'eastus');
}

console.log('\n8. regionLabel says what "global" actually means');
{
  check('an unknown region reads "Unknown"', regionLabel(null) === 'Unknown');
  check('"global" reads "Global (no region)" — never listed as if the customer '
    + 'had a region named "global"',
    regionLabel('global') === 'Global (no region)', regionLabel('global'));
  check('a real region is labelled with its own name', regionLabel('ap-south-1') === 'ap-south-1');
  check('an AZ is labelled with its REGION, not the zone',
    regionLabel('ap-south-1b') === 'ap-south-1', regionLabel('ap-south-1b'));
}

console.log('\n9. accountLocation tells a tenant GUID from a region');
{
  const guid = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
  const tenant = accountLocation({ tenant_or_region: guid });
  check('an Azure tenant GUID is labelled as a TENANT, not a region',
    tenant.kind === 'tenant', tenant.kind);
  check('the tenant text is truncated and marked',
    tenant.text.startsWith('Tenant ') && tenant.text.endsWith('…'), tenant.text);
  check('the full GUID is preserved in the hover title',
    tenant.title.includes(guid), tenant.title);
  check('the title says what the value actually is',
    /Azure tenant/i.test(tenant.title), tenant.title);

  const region = accountLocation({ tenant_or_region: 'ap-south-1' });
  check('a real region is labelled as a region', region.kind === 'region');
  check('a region needs no explanatory title', region.title === null);
  check('the region text is the region itself', region.text === 'ap-south-1');

  check('an account with no location reads NA', accountLocation({}).text === 'NA');
  check('an account with no location has kind "none"', accountLocation({}).kind === 'none');
  check('a null account does not throw', accountLocation(null).text === 'NA');
  check('surrounding whitespace is trimmed off a stored value',
    accountLocation({ tenant_or_region: '  eastus  ' }).text === 'eastus');
}

console.log('\n10. regionBreakdown: global sorts LAST, whatever its size');
{
  const resources = [
    ...Array.from({ length: 50 }, () => ({ region_or_zone: 'global' })),
    ...Array.from({ length: 5 }, () => ({ region_or_zone: 'ap-south-1a' })),
    ...Array.from({ length: 3 }, () => ({ region_or_zone: 'eastus' })),
  ];
  const breakdown = regionBreakdown(resources);
  check('global sorts LAST even when it is by far the largest bucket — '
    + '"not a place" must never lead the region chart',
    breakdown[breakdown.length - 1].key === GLOBAL,
    breakdown.map((b) => `${b.key}:${b.value}`).join(' '));
  check('real regions are ordered by count, descending',
    breakdown[0].key === 'ap-south-1' && breakdown[0].value === 5,
    JSON.stringify(breakdown[0]));
  check('availability zones are folded into their region before counting',
    breakdown.find((b) => b.key === 'ap-south-1').value === 5);

  const unregioned = regionBreakdown([{ region_or_zone: null }, { region_or_zone: '' }]);
  check('resources with no region land in an "unknown" bucket, distinct from global',
    unregioned[0].key === 'unknown' && unregioned[0].value === 2,
    JSON.stringify(unregioned));

  check('an empty list gives an empty breakdown', regionBreakdown([]).length === 0);
  check('a null list gives an empty breakdown, not a crash '
    + '(this is the not-yet-loaded state)', regionBreakdown(null).length === 0);
  check('every bucket carries a human label',
    regionBreakdown(resources).every((b) => typeof b.name === 'string' && b.name.length > 0));
}

console.log('\n11. The legacy formatters module — current behaviour, divergence documented');
{
  check('getProviderIcon folds Oracle and OCI to one icon, in either case',
    getProviderIcon('oracle') === 'oci-icon' && getProviderIcon('Oracle') === 'oci-icon'
    && getProviderIcon('OCI') === 'oci-icon' && getProviderIcon('oci') === 'oci-icon');
  check('getProviderIcon knows aws and azure',
    getProviderIcon('aws') === 'aws-icon' && getProviderIcon('AZURE') === 'azure-icon');
  check('an unknown provider gets the generic cloud icon, never undefined',
    getProviderIcon('nope') === 'cloud-icon' && getProviderIcon(null) === 'cloud-icon');

  // Documented divergence, asserted so it is visible rather than latent:
  // this legacy module and costFormat.js both export `formatDate` and they
  // disagree about the missing-value sentinel. Neither is wrong on its own;
  // having two is the problem, and this is the consolidation candidate.
  check('legacy formatters.formatDate returns "-" for a missing date, where '
    + 'costFormat.formatDate returns "NA" — two modules, two sentinels, '
    + 'asserted here so the divergence stays visible',
    legacyFormatDate(null) === '-' && legacyFormatDate('') === '-',
    JSON.stringify(legacyFormatDate(null)));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
