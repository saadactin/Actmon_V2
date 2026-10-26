/**
 * What an execution plan actually says about a query.
 *
 * The "Quick insights" strip is four confident numbers, which makes it exactly
 * the place to be careful: a count of full table scans that is really a count
 * of plan rows, or a "missing indexes: 1" produced because the word INDEX did
 * not appear, is worse than no strip at all. Each figure here is derived from
 * named plan columns and returns null when the plan cannot support it, so the
 * card shows "Not available" rather than a zero that reads as "none found".
 *
 * Everything is pure, over the Oracle `v$sql_plan` row shape that
 * oracle_sql_plan() returns. Other engines return a different shape and get
 * null, which the caller renders as unavailable — deliberately, rather than
 * guessing at a MySQL EXPLAIN's columns with Oracle's rules.
 */

const n = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/** Does this look like a row from v$sql_plan? */
export function isOraclePlan(rows) {
  return Array.isArray(rows) && rows.length > 0 && typeof rows[0] === 'object'
    && rows[0] !== null && 'operation' in rows[0];
}

/** The steps that read a whole table. */
export function fullTableScans(rows) {
  if (!isOraclePlan(rows)) return null;
  return rows.filter((r) => /TABLE ACCESS/i.test(r.operation || '') && /FULL/i.test(r.options || ''));
}

/** Steps that combine two row sources. */
export function joinOperations(rows) {
  if (!isOraclePlan(rows)) return null;
  return rows.filter((r) => /(JOIN|NESTED LOOPS|MERGE JOIN)/i.test(
    [r.operation, r.options].filter(Boolean).join(' '),
  ));
}

/**
 * Tables this plan scans in full that no index step touches.
 *
 * This is a plan-shaped signal, not a schema fact: a table can have indexes
 * the optimizer chose not to use, and this cannot tell the two apart. The card
 * that shows it says "potential improvement" for that reason, and the number
 * is deliberately of DISTINCT tables, so one table scanned twice is one
 * candidate rather than two.
 */
export function missingIndexCandidates(rows) {
  if (!isOraclePlan(rows)) return null;
  const indexed = new Set(
    rows.filter((r) => /INDEX/i.test(r.operation || ''))
      .map((r) => `${r.object_owner || ''}.${r.object_name || ''}`.toUpperCase()),
  );
  const scanned = new Map();
  (fullTableScans(rows) || []).forEach((r) => {
    if (!r.object_name) return;
    const key = `${r.object_owner || ''}.${r.object_name}`.toUpperCase();
    if (!scanned.has(key)) scanned.set(key, r);
  });
  // An index step names the INDEX, not the table, so a name match is only a
  // hint. Owner+table prefixes are compared instead of exact names.
  return [...scanned.entries()]
    .filter(([key]) => ![...indexed].some((ix) => ix.startsWith(key.split('.')[0] + '.')
      && ix.includes(key.split('.')[1]?.slice(0, 4) || '\u0000'))
      && !indexed.has(key))
    .map(([, r]) => r);
}

/** The optimizer's estimate for the whole plan: the largest step cost, which
 *  in Oracle is the root's and already contains every descendant. */
export function estimatedCost(rows) {
  if (!isOraclePlan(rows)) return null;
  const costs = rows.map((r) => n(r.cost)).filter((c) => c !== null);
  return costs.length ? Math.max(...costs) : null;
}

/** Distinct objects the plan touches, by type. */
export function planObjects(rows) {
  if (!isOraclePlan(rows)) return null;
  const byName = new Map();
  rows.forEach((r) => {
    if (!r.object_name) return;
    const key = `${r.object_owner || ''}.${r.object_name}`;
    if (!byName.has(key)) {
      byName.set(key, { owner: r.object_owner || null, name: r.object_name, type: r.object_type || null });
    }
  });
  const list = [...byName.values()];
  return {
    all: list,
    tables: list.filter((o) => /TABLE/i.test(o.type || '')),
    types: [...new Set(list.map((o) => o.type).filter(Boolean))],
  };
}

/**
 * The four Quick-insight figures.
 *
 * `null` for any figure the plan cannot support, so the card can say so. A
 * plan that genuinely contains no full scan returns 0, which is a finding;
 * a plan that could not be read returns null, which is not.
 */
export function quickInsights(rows) {
  const scans = fullTableScans(rows);
  const joins = joinOperations(rows);
  const missing = missingIndexCandidates(rows);
  const cost = estimatedCost(rows);
  return {
    fullTableScans: scans ? scans.length : null,
    joinOperations: joins ? joins.length : null,
    missingIndexes: missing ? missing.length : null,
    estimatedCost: cost,
  };
}

/**
 * One warning per full-scanned TABLE, not per plan step.
 *
 * A table read twice in a plan is one problem described twice; collapsing by
 * object keeps that honest without merging two DIFFERENT tables, which is why
 * the key is owner+name and the step ids are carried along.
 */
export function fullScanWarnings(rows) {
  const scans = fullTableScans(rows);
  if (!scans) return [];
  const byObject = new Map();
  scans.forEach((r) => {
    const key = `${r.object_owner || ''}.${r.object_name || `step ${r.id}`}`;
    const existing = byObject.get(key);
    if (existing) {
      existing.steps.push(n(r.id));
      // The worst estimate across the repeats is the one worth showing.
      if ((n(r.cardinality) ?? 0) > (existing.rows ?? 0)) existing.rows = n(r.cardinality);
      if ((n(r.cost) ?? 0) > (existing.cost ?? 0)) existing.cost = n(r.cost);
      return;
    }
    byObject.set(key, {
      key,
      owner: r.object_owner || null,
      object: r.object_name || null,
      steps: [n(r.id)],
      rows: n(r.cardinality),
      cost: n(r.cost),
    });
  });
  return [...byObject.values()].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
}
