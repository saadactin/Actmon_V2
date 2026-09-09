/**
 * Per-engine execution-plan tree adapters — each converts that engine's own
 * EXPLAIN response shape into one normalized node shape for <PlanDiagram>:
 *
 *   { id, label, sublabel, rows, costLabel, flagged, children: [] }
 *
 * These are pure functions (no fetching, no state) — SlowQueryDetailPage.jsx
 * calls the right one based on which response shape actually came back, the
 * same way PlanResult() already branches for the table view.
 */

let _autoId = 0;
function nextId() {
  _autoId += 1;
  return `n${_autoId}`;
}

function fmtNum(n) {
  if (n == null) return null;
  const num = Number(n);
  return Number.isFinite(num) ? num.toLocaleString() : null;
}

/** PostgreSQL — walks the untouched nested EXPLAIN (FORMAT JSON) tree
 * (`data.raw`, e.g. `{"Plan": {"Node Type": "...", "Plans": [...]}}` or a
 * bare top-level plan node). */
export function pgTree(raw) {
  if (!raw) return null;
  const root = raw.Plan || (Array.isArray(raw) ? raw[0]?.Plan : null) || raw;
  if (!root || typeof root !== 'object') return null;

  function walk(node) {
    const nodeType = node['Node Type'] || 'Node';
    const isSeqScan = String(nodeType).includes('Seq Scan');
    const rows = node['Actual Rows'] ?? node['Plan Rows'];
    const cost = node['Actual Total Time'] != null
      ? `${Number(node['Actual Total Time']).toFixed(2)} ms`
      : (node['Total Cost'] != null ? `cost ${Number(node['Total Cost']).toFixed(1)}` : null);
    return {
      id: nextId(),
      label: nodeType,
      sublabel: node['Relation Name'] || node['Alias'] || node['Index Name'] || null,
      rows: fmtNum(rows),
      costLabel: cost,
      flagged: isSeqScan,
      children: (node['Plans'] || []).map(walk),
    };
  }
  return walk(root);
}

/** MySQL — walks the untouched nested EXPLAIN FORMAT=JSON tree (`data.raw`),
 * same "no fixed schema, find every 'table' dict" shape
 * mysql_slow_query_service.py's _flatten_mysql_plan already documents. */
export function mysqlTree(raw) {
  if (!raw || typeof raw !== 'object') return null;

  function walk(node) {
    if (Array.isArray(node)) {
      // A bare list (e.g. nested_loop) has no node of its own — the caller
      // already flattens these into sibling children, see collectChildren().
      return null;
    }
    if (typeof node !== 'object' || node === null) return null;
    const t = node.table;
    let selfNode = null;
    if (t && typeof t === 'object') {
      const at = String(t.access_type || '').toUpperCase();
      const costInfo = t.cost_info || {};
      const cost = costInfo.prefix_cost || costInfo.read_cost;
      selfNode = {
        id: nextId(),
        label: t.access_type ? `${t.access_type.toUpperCase()} access` : 'Table Access',
        sublabel: t.table_name || null,
        rows: fmtNum(t.rows_examined_per_scan),
        costLabel: cost != null ? `cost ${Number(cost).toFixed(2)}` : null,
        flagged: at === 'ALL',
        children: [],
      };
      for (const key of ['materialized_from_subquery', 'attached_subqueries']) {
        if (t[key]) selfNode.children.push(...collectChildren(t[key]));
      }
    }
    const childNodes = [];
    for (const [k, v] of Object.entries(node)) {
      if (k === 'table') continue;
      childNodes.push(...collectChildren(v));
    }
    if (selfNode) {
      selfNode.children.push(...childNodes);
      return selfNode;
    }
    // No "table" at this level (e.g. the top-level query_block wrapper, or a
    // leaf branch like cost_info that recurses into nothing but scalars) —
    // contribute nothing if there's nothing real below, splice a single real
    // child straight in, or wrap only when there are genuinely 2+ to group.
    if (childNodes.length === 0) return null;
    return childNodes.length === 1 ? childNodes[0] : { id: nextId(), label: 'Query', sublabel: null, rows: null, costLabel: null, flagged: false, children: childNodes };
  }

  function collectChildren(node) {
    if (Array.isArray(node)) return node.map(walk).filter(Boolean);
    const n = walk(node);
    return n ? [n] : [];
  }

  return walk(raw.query_block ? { query_block: raw.query_block } : raw);
}

/** Oracle — v$sql_plan rows, already flat with real id/parent_id/depth.
 * id=0 is ALWAYS the root (the statement itself) by Oracle's own convention —
 * its parent_id is NULL in v$sql_plan, which the backend's _safe_int(None)
 * turns into 0, the exact same value a genuine child of the root also
 * carries in its own parent_id. So "parent_id === 0" can't be used to detect
 * the root — only "id === 0" can. */
export function oracleTree(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const byId = new Map();
  rows.forEach((r) => byId.set(r.id, {
    id: `o${r.id}`,
    label: [r.operation, r.options].filter(Boolean).join(' '),
    sublabel: r.object_name ? `${r.object_owner ? r.object_owner + '.' : ''}${r.object_name}` : null,
    rows: fmtNum(r.cardinality),
    costLabel: r.cost != null ? `cost ${fmtNum(r.cost)}` : null,
    flagged: /TABLE ACCESS/i.test(r.operation || '') && /FULL/i.test(r.options || ''),
    children: [],
  }));
  let root = byId.get(0) || byId.get(rows[0].id) || null;
  for (const r of rows) {
    if (r.id === 0) continue; // the root itself, never anyone's child
    const node = byId.get(r.id);
    const parent = byId.get(r.parent_id);
    if (parent && parent !== node) parent.children.push(node);
    else if (!root) root = node; // orphaned row with no resolvable parent — show it anyway
  }
  return root;
}

/** MongoDB — query_planner.winningPlan, recursing through both the
 * single-child (inputStage) and multi-child (inputStages, e.g. SORT_MERGE/OR)
 * shapes Mongo's planner uses. */
export function mongoTree(queryPlanner) {
  const winning = queryPlanner?.winningPlan;
  if (!winning) return null;

  function walk(stage) {
    if (!stage || typeof stage !== 'object') return null;
    const children = [];
    if (stage.inputStage) {
      const c = walk(stage.inputStage);
      if (c) children.push(c);
    }
    if (Array.isArray(stage.inputStages)) {
      for (const s of stage.inputStages) {
        const c = walk(s);
        if (c) children.push(c);
      }
    }
    return {
      id: nextId(),
      label: stage.stage || 'Stage',
      sublabel: stage.indexName || stage.docsExamined != null ? (stage.indexName || null) : null,
      rows: fmtNum(stage.nReturned ?? stage.docsExamined ?? stage.keysExamined),
      costLabel: null,
      flagged: stage.stage === 'COLLSCAN',
      children,
    };
  }
  return walk(winning);
}
