/**
 * CloudProviderSelector — standardized multi-cloud account picker.
 * Groups accounts under their cloud provider (AWS / Azure / OCI) with
 * individual account chips inside each provider panel.
 *
 * Supports two modes:
 *   mode="single"  → one account selected at a time (Resources, Security, Cost)
 *   mode="multi"   → "ALL" + per-account selection (Dashboard)
 */
import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Cloud, Globe, Plus, Search } from 'lucide-react';
import { CloudAccount } from '../types/cloud';
import { usePermissions } from '../../../hooks/usePermissions';

// ─── Provider metadata ────────────────────────────────────────────────────────

export const PROVIDER_META: Record<string, { label: string; color: string; accent: string; bg: string; logo: string }> = {
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

export function getProviderColor(provider: string): string {
  return PROVIDER_META[provider]?.color ?? '#94a3b8';
}

export function getProviderDot(provider: string): string {
  return PROVIDER_META[provider]?.logo ?? '⚪';
}

// ─── Presentation-only styling maps (light theme) ─────────────────────────────

const BADGE_BASE = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold border';

const PROVIDER_BADGE_CLASS: Record<string, string> = {
  AWS: 'bg-orange-50 text-orange-700 border-orange-200',
  Azure: 'bg-sky-50 text-sky-700 border-sky-200',
  OCI: 'bg-red-50 text-red-700 border-red-200',
};

const PROVIDER_HEADER_TEXT: Record<string, string> = {
  AWS: 'text-orange-700',
  Azure: 'text-sky-700',
  OCI: 'text-red-700',
};

const PROVIDER_ACTIVE_PILL: Record<string, string> = {
  AWS: 'border-orange-300 bg-orange-50',
  Azure: 'border-sky-300 bg-sky-50',
  OCI: 'border-red-300 bg-red-50',
};

const PROVIDER_COUNT_ACTIVE: Record<string, string> = {
  AWS: 'bg-orange-100 text-orange-700',
  Azure: 'bg-sky-100 text-sky-700',
  OCI: 'bg-red-100 text-red-700',
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  accounts: CloudAccount[];
  /** "single": one accountId or null; "multi": accountId | "ALL" */
  mode?: 'single' | 'multi';
  selected: string | null;
  onSelect: (value: string | null) => void;
  onAddAccount?: () => void;
  /** if provided, shows scan button beside selected account chip */
  ScanButton?: React.ReactNode;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const CloudProviderSelector: React.FC<Props> = ({
  accounts = [],
  mode = 'single',
  selected,
  onSelect,
  onAddAccount,
  ScanButton,
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const { canHere } = usePermissions();

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Group accounts by provider
  const providers = ['AWS', 'Azure', 'OCI'] as const;
  const grouped = providers.reduce((acc, p) => {
    acc[p] = accounts.filter(a => a.provider === p);
    return acc;
  }, {} as Record<string, CloudAccount[]>);

  // Resolve display label for the trigger button
  const triggerLabel = (() => {
    if (!selected || selected === 'ALL') return 'All Providers';
    const acc = accounts.find(a => a.id === selected);
    if (!acc) return 'Select Account';
    return acc.account_name;
  })();

  const triggerProvider = (() => {
    if (!selected || selected === 'ALL') return null;
    return accounts.find(a => a.id === selected)?.provider ?? null;
  })();

  const filteredGrouped = providers.reduce((acc, p) => {
    acc[p] = grouped[p].filter(a =>
      a.account_name.toLowerCase().includes(search.toLowerCase())
    );
    return acc;
  }, {} as Record<string, CloudAccount[]>);

  const hasResults = providers.some(p => filteredGrouped[p].length > 0);

  return (
    <div className="flex items-center gap-2.5">
      {/* ── Trigger Button ── */}
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen(v => !v)}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[200px] whitespace-nowrap transition-colors"
        >
          {triggerProvider ? (
            <span className={`${BADGE_BASE} ${PROVIDER_BADGE_CLASS[triggerProvider] ?? 'bg-gray-50 text-gray-700 border-gray-200'}`}>
              {triggerProvider}
            </span>
          ) : (
            <Cloud size={15} className="text-gray-500" />
          )}
          <span className="flex-1 text-left truncate">{triggerLabel}</span>
          <ChevronDown
            size={14}
            className={`text-gray-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        </button>

        {/* ── Dropdown Panel ── */}
        {open && (
          <div className="absolute left-0 top-full mt-2 z-[9999] min-w-[320px] bg-white rounded-xl border border-gray-200 shadow-lg overflow-hidden">
            {/* Search */}
            <div className="px-3 py-3 border-b border-gray-200">
              <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5">
                <Search size={13} className="shrink-0 text-gray-400" />
                <input
                  autoFocus
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search accounts..."
                  className="w-full bg-transparent border-none outline-none text-sm text-gray-700 placeholder:text-gray-400"
                />
              </div>
            </div>

            <div className="max-h-[380px] overflow-y-auto py-2">
              {/* ALL option (only in multi mode) */}
              {mode === 'multi' && (
                <button
                  onClick={() => { onSelect('ALL'); setOpen(false); setSearch(''); }}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                    selected === 'ALL'
                      ? 'bg-blue-50 text-blue-700 font-semibold'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                    <Globe size={14} />
                  </span>
                  <div>
                    <div className={selected === 'ALL' ? 'font-semibold text-blue-700' : 'font-medium text-gray-900'}>
                      All Providers
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{accounts.length} accounts total</div>
                  </div>
                  {selected === 'ALL' && (
                    <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-blue-600" />
                  )}
                </button>
              )}

              {/* Provider Groups */}
              {providers.map(provider => {
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
                      <span className="ml-auto text-[10px] font-semibold text-gray-400">
                        {provAccounts.length} acct{provAccounts.length !== 1 ? 's' : ''}
                      </span>
                    </div>

                    {/* Account chips */}
                    {provAccounts.map(acc => {
                      const isSelected = selected === acc.id;
                      return (
                        <button
                          key={acc.id}
                          onClick={() => { onSelect(acc.id); setOpen(false); setSearch(''); }}
                          className={`flex w-full items-center gap-2.5 px-3 py-2 pl-6 text-left text-sm transition-colors ${
                            isSelected
                              ? 'bg-blue-50 text-blue-700 font-semibold'
                              : 'text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          <span className={`h-2 w-2 shrink-0 rounded-full ${isSelected ? 'bg-blue-600' : 'bg-gray-300'}`} />
                          <div className="min-w-0 flex-1">
                            <div className={`truncate ${isSelected ? 'font-semibold text-blue-700' : 'font-medium text-gray-900'}`}>
                              {acc.account_name}
                            </div>
                            <div className="text-xs text-gray-500 mt-0.5">
                              {acc.environment || 'NA'} · {acc.tenant_or_region || 'NA'}
                            </div>
                          </div>
                          {isSelected && (
                            <span className="h-2 w-2 shrink-0 rounded-full bg-blue-600" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}

              {!hasResults && (
                <div className="px-4 py-6 text-center text-sm text-gray-500">
                  No accounts match "{search}"
                </div>
              )}
            </div>

            {/* Footer: add account (gated by Add permission) */}
            {onAddAccount && canHere('add') && (
              <div className="border-t border-gray-200 py-2">
                <button
                  onClick={() => { onAddAccount(); setOpen(false); }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-medium text-blue-600 hover:bg-blue-50 transition-colors"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
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

interface ProviderSummaryBarProps {
  accounts: CloudAccount[];
  selectedProvider: string | null; // null = ALL
  onSelectProvider: (p: string | null) => void;
}

export const ProviderSummaryBar: React.FC<ProviderSummaryBarProps> = ({
  accounts,
  selectedProvider,
  onSelectProvider,
}) => {
  const providers = ['AWS', 'Azure', 'OCI'] as const;

  return (
    <div className="mb-6 flex flex-wrap gap-3">
      {/* All */}
      <button
        onClick={() => onSelectProvider(null)}
        className={`flex items-center gap-2.5 rounded-xl border px-4 py-2.5 transition-colors ${
          !selectedProvider
            ? 'border-blue-500 bg-blue-50'
            : 'border-gray-200 bg-white hover:bg-gray-50'
        }`}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
          <Globe size={18} />
        </span>
        <div className="text-left">
          <div className={`text-xs font-bold tracking-wide ${!selectedProvider ? 'text-blue-700' : 'text-gray-700'}`}>
            All Clouds
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            {accounts.length} accounts
          </div>
        </div>
      </button>

      {providers.map(provider => {
        const count = accounts.filter(a => a.provider === provider).length;
        const isActive = selectedProvider === provider;

        return (
          <button
            key={provider}
            onClick={() => onSelectProvider(provider === selectedProvider ? null : provider)}
            className={`flex items-center gap-3 rounded-xl border px-4 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              isActive
                ? PROVIDER_ACTIVE_PILL[provider]
                : 'border-gray-200 bg-white hover:bg-gray-50'
            }`}
            disabled={count === 0}
          >
            {/* Provider badge */}
            <span className={`${BADGE_BASE} ${PROVIDER_BADGE_CLASS[provider]}`}>
              {provider}
            </span>

            <div className="text-left">
              <div className={`text-[13px] font-bold tracking-wide ${isActive ? PROVIDER_HEADER_TEXT[provider] : 'text-gray-700'}`}>
                {provider}
              </div>
              <div className="text-[11px] text-gray-500 mt-0.5">
                {count} account{count !== 1 ? 's' : ''}
              </div>
            </div>

            {/* Account count badge */}
            {count > 0 && (
              <span className={`ml-1 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                isActive ? PROVIDER_COUNT_ACTIVE[provider] : 'bg-gray-100 text-gray-600'
              }`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
