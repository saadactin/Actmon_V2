import { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Server, Cloud, MapPin, Layers } from 'lucide-react';

export const EMPTY_TREE_SELECTION = {
  provider: null,
  account: null,
  region: null,
  type: null,
};

// Provider -> Account -> Region -> Resource Type, each level carrying a count
// of matching rows so you can see the drill-down's impact before clicking in.
function buildTree(items) {
  const providers = new Map();

  for (const item of items) {
    const p = item.provider || 'Unknown';
    const a = item.account_name || 'Unknown';
    const r = item.region || 'Unknown';
    const t = item.resource_type || 'Unknown';

    if (!providers.has(p)) providers.set(p, new Map());
    const accounts = providers.get(p);
    if (!accounts.has(a)) accounts.set(a, new Map());
    const regions = accounts.get(a);
    if (!regions.has(r)) regions.set(r, new Map());
    const types = regions.get(r);
    types.set(t, (types.get(t) || 0) + 1);
  }

  return Array.from(providers.entries()).map(([pName, accounts]) => {
    const accountNodes = Array.from(accounts.entries()).map(([aName, regions]) => {
      const regionNodes = Array.from(regions.entries()).map(([rName, types]) => {
        const typeNodes = Array.from(types.entries()).map(([tName, count]) => ({ name: tName, count }));
        const regionCount = typeNodes.reduce((sum, t) => sum + t.count, 0);
        return { name: rName, count: regionCount, types: typeNodes };
      });
      const accountCount = regionNodes.reduce((sum, r) => sum + r.count, 0);
      return { name: aName, count: accountCount, regions: regionNodes };
    });
    const providerCount = accountNodes.reduce((sum, a) => sum + a.count, 0);
    return { name: pName, count: providerCount, accounts: accountNodes };
  });
}

const rowClass = (active) => `w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-xs text-left transition-colors ${
  active ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-gray-600 hover:bg-gray-50'
}`;

export const CostFilterTree = ({ items, selection, onChange }) => {
  const tree = useMemo(() => buildTree(items), [items]);
  const [expanded, setExpanded] = useState({});

  const toggleExpand = (key) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const selectProvider = (name) => onChange(selection.provider === name ? EMPTY_TREE_SELECTION : { provider: name, account: null, region: null, type: null });
  const selectAccount = (provider, name) => onChange(selection.account === name
    ? { ...selection, account: null, region: null, type: null }
    : { provider, account: name, region: null, type: null });
  const selectRegion = (provider, account, name) => onChange(selection.region === name
    ? { ...selection, region: null, type: null }
    : { provider, account, region: name, type: null });
  const selectType = (provider, account, region, name) => onChange(selection.type === name
    ? { ...selection, type: null }
    : { provider, account, region, type: name });

  if (items.length === 0) {
    return (
      <div className="text-xs text-gray-400 px-2 py-4 text-center">
        No stopped instances to filter.
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {selection.provider && (
        <button
          onClick={() => onChange(EMPTY_TREE_SELECTION)}
          className="text-[11px] font-semibold text-blue-600 hover:text-blue-700 px-2 pb-1.5"
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
              <button onClick={() => toggleExpand(pKey)} className="shrink-0 text-gray-400 hover:text-gray-600 p-0.5">
                {pExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
              <button onClick={() => selectProvider(p.name)} className={rowClass(selection.provider === p.name && !selection.account)}>
                <span className="flex items-center gap-1.5 truncate"><Cloud className="h-3.5 w-3.5 shrink-0" />{p.name}</span>
                <span className="text-[10px] text-gray-400 font-bold shrink-0">{p.count}</span>
              </button>
            </div>

            {pExpanded && p.accounts.map((a) => {
              const aKey = `${pKey}/a:${a.name}`;
              const aExpanded = expanded[aKey] ?? true;
              const aActive = selection.account === a.name;
              return (
                <div key={aKey} className="ml-3.5">
                  <div className="flex items-center gap-0.5">
                    <button onClick={() => toggleExpand(aKey)} className="shrink-0 text-gray-400 hover:text-gray-600 p-0.5">
                      {aExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    </button>
                    <button onClick={() => selectAccount(p.name, a.name)} className={rowClass(aActive && !selection.region)}>
                      <span className="flex items-center gap-1.5 truncate"><Server className="h-3.5 w-3.5 shrink-0" />{a.name}</span>
                      <span className="text-[10px] text-gray-400 font-bold shrink-0">{a.count}</span>
                    </button>
                  </div>

                  {aExpanded && a.regions.map((r) => {
                    const rKey = `${aKey}/r:${r.name}`;
                    const rExpanded = expanded[rKey] ?? false;
                    const rActive = selection.region === r.name && aActive;
                    return (
                      <div key={rKey} className="ml-3.5">
                        <div className="flex items-center gap-0.5">
                          <button onClick={() => toggleExpand(rKey)} className="shrink-0 text-gray-400 hover:text-gray-600 p-0.5">
                            {rExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                          </button>
                          <button onClick={() => selectRegion(p.name, a.name, r.name)} className={rowClass(rActive && !selection.type)}>
                            <span className="flex items-center gap-1.5 truncate"><MapPin className="h-3.5 w-3.5 shrink-0" />{r.name}</span>
                            <span className="text-[10px] text-gray-400 font-bold shrink-0">{r.count}</span>
                          </button>
                        </div>

                        {rExpanded && r.types.map((t) => {
                          const tActive = rActive && selection.type === t.name;
                          return (
                            <div key={`${rKey}/t:${t.name}`} className="ml-7">
                              <button onClick={() => selectType(p.name, a.name, r.name, t.name)} className={rowClass(tActive)}>
                                <span className="flex items-center gap-1.5 truncate"><Layers className="h-3.5 w-3.5 shrink-0" />{t.name}</span>
                                <span className="text-[10px] text-gray-400 font-bold shrink-0">{t.count}</span>
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
};

export function matchesTreeSelection(item, selection) {
  if (selection.provider && item.provider !== selection.provider) return false;
  if (selection.account && item.account_name !== selection.account) return false;
  if (selection.region && item.region !== selection.region) return false;
  if (selection.type && item.resource_type !== selection.type) return false;
  return true;
}
