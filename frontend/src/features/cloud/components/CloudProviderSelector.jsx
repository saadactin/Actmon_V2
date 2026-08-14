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
import { usePermissions } from '@/hooks/usePermissions';

// ─── Provider metadata ────────────────────────────────────────────────────────
// Brand colours are pinned (not theme tokens) — external provider identity,
// same rationale as the Agents module's pinned --agent-* palette.

export const PROVIDER_META = {
  AWS: {
    label: 'Amazon Web Services',
    color: '#FF9900',
    accent: 'rgba(255,153,0,0.18)',
    bg: 'rgba(255,153,0,0.07)',
    logo: '🟡',
  },
  Azure: {
    label: 'Microsoft Azure',
    color: '#0078D4',
    accent: 'rgba(0,120,212,0.18)',
    bg: 'rgba(0,120,212,0.07)',
    logo: '🔵',
  },
  OCI: {
    label: 'Oracle Cloud',
    color: '#C74634',
    accent: 'rgba(199,70,52,0.18)',
    bg: 'rgba(199,70,52,0.07)',
    logo: '🔴',
  },
};

// ─── Helper ───────────────────────────────────────────────────────────────────

export function getProviderColor(provider) {
  return PROVIDER_META[provider]?.color ?? '#94a3b8';
}

export function getProviderDot(provider) {
  return PROVIDER_META[provider]?.logo ?? '⚪';
}

// ─── Presentation-only styling maps (pinned brand colours) ────────────────────

const BADGE_BASE = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold border';

const PROVIDER_BADGE_CLASS = {
  AWS: 'bg-orange-50 text-orange-700 border-orange-200',
  Azure: 'bg-sky-50 text-sky-700 border-sky-200',
  OCI: 'bg-red-50 text-red-700 border-red-200',
};

const PROVIDER_HEADER_TEXT = {
  AWS: 'text-orange-700',
  Azure: 'text-sky-700',
  OCI: 'text-red-700',
};

const PROVIDER_ACTIVE_PILL = {
  AWS: 'border-orange-300 bg-orange-50',
  Azure: 'border-sky-300 bg-sky-50',
  OCI: 'border-red-300 bg-red-50',
};

const PROVIDER_COUNT_ACTIVE = {
  AWS: 'bg-orange-100 text-orange-700',
  Azure: 'bg-sky-100 text-sky-700',
  OCI: 'bg-red-100 text-red-700',
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
            <span className={`${BADGE_BASE} ${PROVIDER_BADGE_CLASS[triggerProvider] ?? 'border-border bg-sunken text-muted'}`}>
              {triggerProvider}
            </span>
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
                      <span className={`${BADGE_BASE} ${PROVIDER_BADGE_CLASS[provider]}`}>
                        {provider}
                      </span>
                      <span className={`text-[10px] font-bold uppercase tracking-wider ${PROVIDER_HEADER_TEXT[provider]}`}>
                        {meta.label}
                      </span>
                      <span className="ml-auto text-[10px] font-semibold text-subtle">
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
          <div className="mt-0.5 text-[11px] text-muted">
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
              isActive
                ? PROVIDER_ACTIVE_PILL[provider]
                : 'border-border bg-surface hover:bg-sunken'
            }`}
            disabled={count === 0}
          >
            {/* Provider badge */}
            <span className={`${BADGE_BASE} ${PROVIDER_BADGE_CLASS[provider]}`}>
              {provider}
            </span>

            <div className="text-left">
              <div className={`text-[13px] font-bold tracking-wide ${isActive ? PROVIDER_HEADER_TEXT[provider] : 'text-fg'}`}>
                {provider}
              </div>
              <div className="mt-0.5 text-[11px] text-muted">
                {count} account{count !== 1 ? 's' : ''}
              </div>
            </div>

            {/* Account count badge */}
            {count > 0 && (
              <span className={`ml-1 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                isActive ? PROVIDER_COUNT_ACTIVE[provider] : 'bg-sunken text-muted'
              }`}
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
