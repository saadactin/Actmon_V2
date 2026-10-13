/**
 * CloudProviderSelector — standardized multi-cloud account picker.
 * Groups accounts under their cloud provider (AWS / Azure / OCI) with
 * individual account chips inside each provider panel.
 *
 * Supports two modes:
 *   mode="single"  → one account selected at a time (Resources, Security, Cost)
 *   mode="multi"   → "ALL" + per-account selection (Dashboard)
 */
import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Cloud, Globe, Plus, Search } from 'lucide-react';
import ProviderLogo from './ProviderLogo';
import { providerBadgeStyle, providerColor, providerInkStyle, providerTileStyle } from '../utils/providerTheme';
import { usePermissions } from '@/hooks/usePermissions';

// ─── Provider metadata ────────────────────────────────────────────────────────
// Brand hues stay pinned — external provider identity, the same rationale as the
// Agents module's pinned --agent-* palette — but they now come from the one
// brand registry (`utils/providerTheme`) and are applied as theme-mixed tints.
// The four class maps that used to live here (badge, header ink, active pill,
// count chip) were fixed light-palette swatches, so every one of them painted a
// near-white block on the dim / dark / midnight themes.

export const PROVIDER_META = {
  AWS: { label: 'Amazon Web Services', color: providerColor('AWS') },
  Azure: { label: 'Microsoft Azure', color: providerColor('Azure') },
  OCI: { label: 'Oracle Cloud', color: providerColor('OCI') },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getProviderColor(provider) {
  return providerColor(provider);
}

// ─── Presentation-only styling (brand hue, theme-mixed surfaces) ──────────────

const BADGE_BASE = 'inline-flex items-center px-2 py-0.5 rounded-full text-meta font-bold border';

/** The selected provider pill — a wash of its own hue instead of `bg-sky-50`. */
const providerPillStyle = (provider) => {
  const color = providerColor(provider);
  return {
    backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
    borderColor: `color-mix(in srgb, ${color} 38%, transparent)`,
  };
};

/** The count chip on an active pill — a touch stronger than the pill behind it. */
const providerCountStyle = (provider) => {
  const color = providerColor(provider);
  return {
    backgroundColor: `color-mix(in srgb, ${color} 22%, transparent)`,
    color: `color-mix(in srgb, ${color} 72%, var(--fg))`,
  };
};

// ─── Component ────────────────────────────────────────────────────────────────

export const CloudProviderSelector = ({
  accounts = [],
  mode = 'single',
  selected,
  onSelect,
  onAddAccount,
  ScanButton,
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);
  const { canHere } = usePermissions();

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Group accounts by provider
  const providers = ['AWS', 'Azure', 'OCI'];
  const grouped = providers.reduce((acc, p) => {
    acc[p] = accounts.filter((a) => a.provider === p);
    return acc;
  }, {});

  // Resolve display label for the trigger button
  const triggerLabel = (() => {
    if (!selected || selected === 'ALL') return 'All Providers';
    const acc = accounts.find((a) => a.id === selected);
    if (!acc) return 'Select Account';
    return acc.account_name;
  })();

  const triggerProvider = (() => {
    if (!selected || selected === 'ALL') return null;
    return accounts.find((a) => a.id === selected)?.provider ?? null;
  })();

  const filteredGrouped = providers.reduce((acc, p) => {
    acc[p] = grouped[p].filter((a) => a.account_name.toLowerCase().includes(search.toLowerCase()));
    return acc;
  }, {});

  const hasResults = providers.some((p) => filteredGrouped[p].length > 0);

  return (
    <div className="flex items-center gap-2.5">
      {/* ── Trigger Button ── */}
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-control min-w-[200px] items-center gap-2 whitespace-nowrap rounded-control border border-border bg-surface px-3 text-[13px] font-medium text-fg transition-colors hover:border-strong"
        >
          {triggerProvider ? (
            <ProviderLogo provider={triggerProvider} size={18} />
          ) : (
            <Cloud size={15} className="text-subtle" />
          )}
          <span className="flex-1 truncate text-left">{triggerLabel}</span>
          <ChevronDown
            size={14}
            className={`text-subtle transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        </button>

        {/* ── Dropdown Panel ── */}
        {open && (
          <div className="absolute left-0 top-full z-[9999] mt-2 min-w-[320px] overflow-hidden rounded-card border border-border bg-surface shadow-lg">
            {/* Search */}
            <div className="border-b border-border px-3 py-3">
              <div className="flex items-center gap-2 rounded-control border border-border bg-sunken px-3 py-1.5">
                <Search size={13} className="shrink-0 text-subtle" />
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search accounts..."
                  className="w-full border-none bg-transparent text-[13px] text-fg outline-none placeholder:text-subtle"
                />
              </div>
            </div>

            <div className="max-h-[380px] overflow-y-auto py-2">
              {/* ALL option (only in multi mode) */}
              {mode === 'multi' && (
                <button
                  onClick={() => { onSelect('ALL'); setOpen(false); setSearch(''); }}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors ${
                    selected === 'ALL'
                      ? 'bg-accent-soft font-semibold text-accent-text'
                      : 'text-fg hover:bg-sunken'
                  }`}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-text">
                    <Globe size={14} />
                  </span>
                  <div>
                    <div className={selected === 'ALL' ? 'font-semibold text-accent-text' : 'font-medium text-fg'}>
                      All Providers
                    </div>
                    <div className="mt-0.5 text-xs text-muted">{accounts.length} accounts total</div>
                  </div>
                  {selected === 'ALL' && (
                    <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-accent" />
                  )}
                </button>
              )}

              {/* Provider Groups */}
              {providers.map((provider) => {
                const provAccounts = filteredGrouped[provider];
                if (provAccounts.length === 0) return null;
                const meta = PROVIDER_META[provider];
                return (
                  <div key={provider}>
                    {/* Provider header */}
                    <div className="flex items-center gap-2 px-3 pt-3 pb-1">
                      <ProviderLogo provider={provider} size={16} />
                      <span className={BADGE_BASE} style={providerBadgeStyle(provider)}>
                        {provider}
                      </span>
                      <span className="text-micro font-bold uppercase tracking-wider" style={providerInkStyle(provider)}>
                        {meta.label}
                      </span>
                      <span className="ml-auto text-micro font-semibold text-subtle">
                        {provAccounts.length} acct{provAccounts.length !== 1 ? 's' : ''}
                      </span>
                    </div>

                    {/* Account chips */}
                    {provAccounts.map((acc) => {
                      const isSelected = selected === acc.id;
                      return (
                        <button
                          key={acc.id}
                          onClick={() => { onSelect(acc.id); setOpen(false); setSearch(''); }}
                          className={`flex w-full items-center gap-2.5 px-3 py-2 pl-6 text-left text-[13px] transition-colors ${
                            isSelected
                              ? 'bg-accent-soft font-semibold text-accent-text'
                              : 'text-fg hover:bg-sunken'
                          }`}
                        >
                          <span className={`h-2 w-2 shrink-0 rounded-full ${isSelected ? 'bg-accent' : 'bg-border'}`} />
                          <div className="min-w-0 flex-1">
                            <div className={`truncate ${isSelected ? 'font-semibold text-accent-text' : 'font-medium text-fg'}`}>
                              {acc.account_name}
                            </div>
                            <div className="mt-0.5 text-xs text-muted">
                              {acc.environment || 'NA'} · {acc.tenant_or_region || 'NA'}
                            </div>
                          </div>
                          {isSelected && (
                            <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-accent" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}

              {!hasResults && (
                <div className="px-4 py-6 text-center text-[13px] text-muted">
                  No accounts match &quot;{search}&quot;
                </div>
              )}
            </div>

            {/* Footer: add account (gated by Add permission) */}
            {onAddAccount && canHere('add') && (
              <div className="border-t border-border py-2">
                <button
                  onClick={() => { onAddAccount(); setOpen(false); }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium text-accent-text transition-colors hover:bg-accent-soft"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-text">
                    <Plus size={14} />
                  </span>
                  Connect New Cloud Account
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Inline scan / action button beside selector ── */}
      {ScanButton}
    </div>
  );
};

// ─── Provider Summary Bar (used on Dashboard) ─────────────────────────────────

export const ProviderSummaryBar = ({
  accounts,
  selectedProvider,
  onSelectProvider,
}) => {
  const providers = ['AWS', 'Azure', 'OCI'];

  return (
    <div className="mb-6 flex flex-wrap gap-3">
      {/* All */}
      <button
        onClick={() => onSelectProvider(null)}
        className={`flex items-center gap-2.5 rounded-card border px-4 py-2.5 transition-colors ${
          !selectedProvider
            ? 'border-accent bg-accent-soft'
            : 'border-border bg-surface hover:bg-sunken'
        }`}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-text">
          <Globe size={18} />
        </span>
        <div className="text-left">
          <div className={`text-xs font-bold tracking-wide ${!selectedProvider ? 'text-accent-text' : 'text-fg'}`}>
            All Clouds
          </div>
          <div className="mt-0.5 text-meta text-muted">
            {accounts.length} accounts
          </div>
        </div>
      </button>

      {providers.map((provider) => {
        const count = accounts.filter((a) => a.provider === provider).length;
        const isActive = selectedProvider === provider;

        return (
          <button
            key={provider}
            onClick={() => onSelectProvider(provider === selectedProvider ? null : provider)}
            className={`flex items-center gap-3 rounded-card border px-4 py-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              isActive ? '' : 'border-border bg-surface hover:bg-sunken'
            }`}
            style={isActive ? providerPillStyle(provider) : undefined}
            disabled={count === 0}
          >
            {/* Brand mark on a plate tinted with its own hue. It used to be a
                pinned white plate, which was the one shape still glowing on a
                midnight page; it replaces a text badge that just repeated the
                provider name shown immediately to its right. */}
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control border"
              style={providerTileStyle(provider)}
            >
              <ProviderLogo provider={provider} size={24} />
            </span>

            <div className="text-left">
              <div
                className={`text-[13px] font-bold tracking-wide ${isActive ? '' : 'text-fg'}`}
                style={isActive ? providerInkStyle(provider) : undefined}
              >
                {provider}
              </div>
              <div className="mt-0.5 text-meta text-muted">
                {count} account{count !== 1 ? 's' : ''}
              </div>
            </div>

            {/* Account count badge */}
            {count > 0 && (
              <span
                className={`ml-1 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-meta font-bold ${
                  isActive ? '' : 'bg-sunken text-muted'
                }`}
                style={isActive ? providerCountStyle(provider) : undefined}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
