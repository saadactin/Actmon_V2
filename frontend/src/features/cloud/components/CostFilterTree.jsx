import { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Server, Cloud, MapPin, Package, Layers } from 'lucide-react';

export const EMPTY_TREE_SELECTION = {
  provider: null,
  account: null,
  region: null,
  service: null,
  type: null,
};

const symbolFor = (code) => (code
  ? ({ USD: '$', INR: '₹', EUR: '€', GBP: '£' }[code] ?? `${code} `)
  : '');

// Same abbreviation used for the trend chart's Y-axis (CostPage.jsx) — a raw
// 6+ digit amount doesn't fit a tree row's badge.
const formatCompact = (value, currency) => {
  const abs = Math.abs(value);
  const sym = symbolFor(currency);
  if (abs >= 1_000_000_000) return `${sym}${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sym}${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sym}${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return `${sym}${value.toFixed(value ? 2 : 0)}`;
};

// Provider -> Account -> Region -> Service -> Resource Type, each level
// carrying the match count AND the real cost total beneath it, so the tree
// shows impact (not just row count) before drilling in.
function buildTree(items) {
  const providers = new Map();
  let currency = null;

  for (const item of items) {
    currency = currency || item.currency || null;
    const p = item.provider || 'Unknown';
    const a = item.account_name || 'Unknown';
    const r = item.region || 'Unknown';
    const s = item.service || 'Unknown';
    const t = item.resource_type || 'Unknown';
    const cost = Number(item.cost) || 0;

    if (!providers.has(p)) providers.set(p, new Map());
    const accounts = providers.get(p);
    if (!accounts.has(a)) accounts.set(a, new Map());
    const regions = accounts.get(a);
    if (!regions.has(r)) regions.set(r, new Map());
    const services = regions.get(r);
    if (!services.has(s)) services.set(s, new Map());
    const types = services.get(s);
    const prev = types.get(t) || { count: 0, cost: 0 };
    types.set(t, { count: prev.count + 1, cost: prev.cost + cost });
  }

  const tree = Array.from(providers.entries()).map(([pName, accounts]) => {
    const accountNodes = Array.from(accounts.entries()).map(([aName, regions]) => {
      const regionNodes = Array.from(regions.entries()).map(([rName, services]) => {
        const serviceNodes = Array.from(services.entries()).map(([sName, types]) => {
          const typeNodes = Array.from(types.entries()).map(([tName, agg]) => ({
            name: tName, count: agg.count, cost: agg.cost,
          }));
          const serviceCount = typeNodes.reduce((sum, t) => sum + t.count, 0);
          const serviceCost = typeNodes.reduce((sum, t) => sum + t.cost, 0);
          return { name: sName, count: serviceCount, cost: serviceCost, types: typeNodes };
        });
        const regionCount = serviceNodes.reduce((sum, s) => sum + s.count, 0);
        const regionCost = serviceNodes.reduce((sum, s) => sum + s.cost, 0);
        return { name: rName, count: regionCount, cost: regionCost, services: serviceNodes };
      });
      const accountCount = regionNodes.reduce((sum, r) => sum + r.count, 0);
      const accountCost = regionNodes.reduce((sum, r) => sum + r.cost, 0);
      return { name: aName, count: accountCount, cost: accountCost, regions: regionNodes };
    });
    const providerCount = accountNodes.reduce((sum, a) => sum + a.count, 0);
    const providerCost = accountNodes.reduce((sum, a) => sum + a.cost, 0);
    return { name: pName, count: providerCount, cost: providerCost, accounts: accountNodes };
  });

  return { tree, currency };
}

const rowClass = (active) => `w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-control text-xs text-left transition-colors ${
  active ? 'bg-accent-soft text-accent-text font-semibold' : 'text-muted hover:bg-sunken'
}`;

const CountBadge = ({ count, cost, currency }) => (
  <span className="flex items-center gap-1.5 shrink-0">
    <span className="text-[10px] text-subtle font-bold">{count}</span>
    <span className="text-[10px] text-subtle">{formatCompact(cost, currency)}</span>
  </span>
);

export const CostFilterTree = ({ items, selection, onChange, emptyLabel = 'No matching cost rows to filter.' }) => {
  const { tree, currency } = useMemo(() => buildTree(items), [items]);
  const [expanded, setExpanded] = useState({});

  const toggleExpand = (key) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const selectProvider = (name) => onChange(selection.provider === name ? EMPTY_TREE_SELECTION : { ...EMPTY_TREE_SELECTION, provider: name });
  const selectAccount = (provider, name) => onChange(selection.account === name
    ? { ...selection, account: null, region: null, service: null, type: null }
    : { provider, account: name, region: null, service: null, type: null });
  const selectRegion = (provider, account, name) => onChange(selection.region === name
    ? { ...selection, region: null, service: null, type: null }
    : { provider, account, region: name, service: null, type: null });
  const selectService = (provider, account, region, name) => onChange(selection.service === name
    ? { ...selection, service: null, type: null }
    : { provider, account, region, service: name, type: null });
  const selectType = (provider, account, region, service, name) => onChange(selection.type === name
    ? { ...selection, type: null }
    : { provider, account, region, service, type: name });

  if (items.length === 0) {
    return (
      <div className="text-xs text-subtle px-2 py-4 text-center">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {selection.provider && (
        <button
          onClick={() => onChange(EMPTY_TREE_SELECTION)}
          className="text-[11px] font-semibold text-accent-text hover:opacity-80 px-2 pb-1.5"
        >
          Clear drill-down
        </button>
      )}
      {tree.map((p) => {
        const pKey = `p:${p.name}`;
        const pExpanded = expanded[pKey] ?? true;
        return (
          <div key={pKey}>
            <div className="flex items-center gap-0.5">
              <button onClick={() => toggleExpand(pKey)} className="shrink-0 text-subtle hover:text-fg p-0.5">
                {pExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
              <button onClick={() => selectProvider(p.name)} className={rowClass(selection.provider === p.name && !selection.account)}>
                <span className="flex items-center gap-1.5 truncate"><Cloud className="h-3.5 w-3.5 shrink-0" />{p.name}</span>
                <CountBadge count={p.count} cost={p.cost} currency={currency} />
              </button>
            </div>

            {pExpanded && p.accounts.map((a) => {
              const aKey = `${pKey}/a:${a.name}`;
              const aExpanded = expanded[aKey] ?? true;
              const aActive = selection.account === a.name;
              return (
                <div key={aKey} className="ml-3.5">
                  <div className="flex items-center gap-0.5">
                    <button onClick={() => toggleExpand(aKey)} className="shrink-0 text-subtle hover:text-fg p-0.5">
                      {aExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    </button>
                    <button onClick={() => selectAccount(p.name, a.name)} className={rowClass(aActive && !selection.region)}>
                      <span className="flex items-center gap-1.5 truncate"><Server className="h-3.5 w-3.5 shrink-0" />{a.name}</span>
                      <CountBadge count={a.count} cost={a.cost} currency={currency} />
                    </button>
                  </div>

                  {aExpanded && a.regions.map((r) => {
                    const rKey = `${aKey}/r:${r.name}`;
                    const rExpanded = expanded[rKey] ?? false;
                    const rActive = selection.region === r.name && aActive;
                    return (
                      <div key={rKey} className="ml-3.5">
                        <div className="flex items-center gap-0.5">
                          <button onClick={() => toggleExpand(rKey)} className="shrink-0 text-subtle hover:text-fg p-0.5">
                            {rExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                          </button>
                          <button onClick={() => selectRegion(p.name, a.name, r.name)} className={rowClass(rActive && !selection.service)}>
                            <span className="flex items-center gap-1.5 truncate"><MapPin className="h-3.5 w-3.5 shrink-0" />{r.name}</span>
                            <CountBadge count={r.count} cost={r.cost} currency={currency} />
                          </button>
                        </div>

                        {rExpanded && r.services.map((s) => {
                          const sKey = `${rKey}/s:${s.name}`;
                          const sExpanded = expanded[sKey] ?? false;
                          const sActive = selection.service === s.name && rActive;
                          return (
                            <div key={sKey} className="ml-3.5">
                              <div className="flex items-center gap-0.5">
                                <button onClick={() => toggleExpand(sKey)} className="shrink-0 text-subtle hover:text-fg p-0.5">
                                  {sExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                </button>
                                <button onClick={() => selectService(p.name, a.name, r.name, s.name)} className={rowClass(sActive && !selection.type)}>
                                  <span className="flex items-center gap-1.5 truncate"><Package className="h-3.5 w-3.5 shrink-0" />{s.name}</span>
                                  <CountBadge count={s.count} cost={s.cost} currency={currency} />
                                </button>
                              </div>

                              {sExpanded && s.types.map((t) => {
                                const tActive = sActive && selection.type === t.name;
                                return (
                                  <div key={`${sKey}/t:${t.name}`} className="ml-7">
                                    <button onClick={() => selectType(p.name, a.name, r.name, s.name, t.name)} className={rowClass(tActive)}>
                                      <span className="flex items-center gap-1.5 truncate"><Layers className="h-3.5 w-3.5 shrink-0" />{t.name}</span>
                                      <CountBadge count={t.count} cost={t.cost} currency={currency} />
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

// buildTree buckets a missing field under the literal display label
// 'Unknown' (e.g. AWS rows always have region: null). Clicking that node sets
// selection.region = 'Unknown' — comparing it against the RAW item.region
// (null) would never match, silently emptying the table for every row the
// tree just counted right in front of the user. Normalizing both sides the
// same way buildTree does is what actually fixes that, not a data problem.
const norm = (v) => v || 'Unknown';

export function matchesTreeSelection(item, selection) {
  if (selection.provider && norm(item.provider) !== selection.provider) return false;
  if (selection.account && norm(item.account_name) !== selection.account) return false;
  if (selection.region && norm(item.region) !== selection.region) return false;
  if (selection.service && norm(item.service) !== selection.service) return false;
  if (selection.type && norm(item.resource_type) !== selection.type) return false;
  return true;
}
