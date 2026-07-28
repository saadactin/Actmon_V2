import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import client from '../api/client';

export const INDICATOR_STYLES = ['ring', 'stat', 'donut', 'minimal'];
export const CHART_STYLES = ['area', 'line', 'bar', 'barh', 'spark', 'pie', 'donut', 'scatter', 'gauge', 'bubble', 'gantt'];
export const DISPLAY_MODES = ['gauge', 'graph'];

export const SCOPES = [
  { key: 'all',        label: 'All technologies' },
  { key: 'mysql',      label: 'MySQL' },
  { key: 'mssql',      label: 'SQL Server' },
  { key: 'oracle',     label: 'Oracle' },
  { key: 'postgresql', label: 'PostgreSQL' },
  { key: 'mongodb',    label: 'MongoDB' },
  { key: 'clickhouse', label: 'ClickHouse' },
  { key: 'infra',      label: 'Infra Hosts' },
  { key: 'cosmosdb',   label: 'Azure Cosmos DB' },
];

const DEFAULTS = { indicator_style: 'ring', chart_style: 'area', display_mode: 'gauge' };

/* Ambient "which dashboard am I on" scope — each engine dashboard page wraps
   itself in <DashboardScopeProvider tech="mysql">, so every <Gauge>/<TrendChart>
   underneath automatically resolves that technology's saved style without
   threading a scope prop through every call site. Defaults to 'all' when no
   provider is present (e.g. the Settings page itself). */
const DashboardScopeContext = createContext('all');
export function DashboardScopeProvider({ tech, children }) {
  return <DashboardScopeContext.Provider value={tech || 'all'}>{children}</DashboardScopeContext.Provider>;
}

const DashboardAppearanceMapContext = createContext({
  map: { all: DEFAULTS },
  loading: true,
  saving: false,
  saveScope: () => Promise.resolve({}),
  deleteScope: () => Promise.resolve({}),
});

export function DashboardAppearanceProvider({ children }) {
  const [map, setMap] = useState({ all: DEFAULTS });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    client.get('/settings/dashboard-appearance')
      .then((r) => setMap(r.data && Object.keys(r.data).length ? r.data : { all: DEFAULTS }))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const saveScope = useCallback((scope, next) => {
    const body = {
      indicator_style: next.indicatorStyle,
      chart_style: next.chartStyle,
      display_mode: next.displayMode || 'gauge',
    };
    setSaving(true);
    return client.put(`/settings/dashboard-appearance?scope=${encodeURIComponent(scope)}`, body)
      .then((r) => { setMap(r.data); return r.data; })
      .finally(() => setSaving(false));
  }, []);

  const deleteScope = useCallback((scope) => {
    setSaving(true);
    return client.delete(`/settings/dashboard-appearance?scope=${encodeURIComponent(scope)}`)
      .then((r) => { setMap(r.data); return r.data; })
      .finally(() => setSaving(false));
  }, []);

  return (
    <DashboardAppearanceMapContext.Provider value={{ map, loading, saving, saveScope, deleteScope }}>
      {children}
    </DashboardAppearanceMapContext.Provider>
  );
}

/**
 * Resolves the active gauge/chart/display-mode style. With no argument, reads
 * the ambient DashboardScopeProvider scope (falling back to 'all' if that
 * technology has no override saved). Pass an explicit scope (used by the
 * Settings page) to inspect/edit any scope regardless of the current page.
 */
export function useDashboardAppearance(scopeOverride) {
  const { map, loading, saving, saveScope, deleteScope } = useContext(DashboardAppearanceMapContext);
  const ambientScope = useContext(DashboardScopeContext);
  const scope = scopeOverride || ambientScope || 'all';
  const resolved = map[scope] || map.all || DEFAULTS;

  return {
    scope,
    indicatorStyle: resolved.indicator_style,
    chartStyle: resolved.chart_style,
    displayMode: resolved.display_mode,
    isOverridden: scope !== 'all' && Boolean(map[scope]),
    loading,
    saving,
    map,
    save: (next) => saveScope(scope, next),
    saveScope,
    resetScope: deleteScope,
  };
}
