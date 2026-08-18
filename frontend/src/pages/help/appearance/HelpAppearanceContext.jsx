import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import client from '@/api/client';
import { DEFAULT_CONFIG, resolveConfig } from './helpAppearanceConfig';

const HelpAppearanceCtx = createContext({
  config: DEFAULT_CONFIG,
  loading: true,
  saving: false,
  save: () => Promise.resolve(DEFAULT_CONFIG),
  reset: () => Promise.resolve(DEFAULT_CONFIG),
});

/**
 * Help Center Appearance — singleton (org-wide, not per-user/per-scope)
 * config, modeled on DashboardAppearanceContext.jsx but without a scope map:
 * there is exactly one row on the backend, so `config` is always the single
 * resolved object (DEFAULT_CONFIG, the active preset's overrides, then the
 * server's own saved fields, in that priority — see resolveConfig()).
 */
export function HelpAppearanceProvider({ children }) {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let token = null;
    try { token = localStorage.getItem('actmon_token'); } catch { /* private mode */ }
    if (!token) { setLoading(false); return; }

    client.get('/settings/help-center-appearance')
      .then((r) => setConfig(resolveConfig(r.data?.config)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = useCallback((patch) => {
    setSaving(true);
    return client.put('/settings/help-center-appearance', patch)
      .then((r) => { const next = resolveConfig(r.data?.config); setConfig(next); return next; })
      .finally(() => setSaving(false));
  }, []);

  const reset = useCallback(() => {
    setSaving(true);
    return client.delete('/settings/help-center-appearance')
      .then((r) => { const next = resolveConfig(r.data?.config); setConfig(next); return next; })
      .finally(() => setSaving(false));
  }, []);

  return (
    <HelpAppearanceCtx.Provider value={{ config, loading, saving, save, reset }}>
      {children}
    </HelpAppearanceCtx.Provider>
  );
}

export function useHelpAppearance() {
  return useContext(HelpAppearanceCtx);
}
