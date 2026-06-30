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
import { ChevronDown, Cloud, Plus, Search } from 'lucide-react';
import { CloudAccount } from '../types/cloud';

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
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {/* ── Trigger Button ── */}
      <div ref={ref} style={{ position: 'relative' }}>
        <button
          onClick={() => setOpen(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '9px 16px',
            background: open ? '#e2e8f0' : '#e2e8f0',
            border: `1.5px solid ${open ? 'rgba(255,255,255,0.2)' : '#e2e8f0'}`,
            borderRadius: 12,
            color: '#334155',
            fontSize: 13, fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit',
            transition: 'all 0.15s',
            minWidth: 200,
            whiteSpace: 'nowrap',
          }}
        >
          {triggerProvider ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, borderRadius: 6,
              background: PROVIDER_META[triggerProvider]?.accent,
              fontSize: 13,
            }}>
              {getProviderDot(triggerProvider)}
            </span>
          ) : (
            <Cloud size={15} style={{ color: '#64748b' }} />
          )}
          <span style={{ flex: 1, textAlign: 'left' }}>{triggerLabel}</span>
          {triggerProvider && (
            <span style={{
              fontSize: 10, fontWeight: 700,
              padding: '2px 7px', borderRadius: 8,
              background: PROVIDER_META[triggerProvider]?.accent,
              color: PROVIDER_META[triggerProvider]?.color,
              letterSpacing: 0.5,
            }}>
              {triggerProvider}
            </span>
          )}
          <ChevronDown size={14} style={{
            color: '#64748b',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s',
          }} />
        </button>

        {/* ── Dropdown Panel ── */}
        {open && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 9999,
            minWidth: 320,
            background: '#f1f5f9',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 16,
            boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
            overflow: 'hidden',
            animation: 'fadeSlideDown 0.15s ease',
          }}>
            {/* Search */}
            <div style={{ padding: '12px 14px', borderBottom: '1px solid #e2e8f0' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 8, padding: '7px 12px',
              }}>
                <Search size={13} style={{ color: '#64748b', flexShrink: 0 }} />
                <input
                  autoFocus
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search accounts..."
                  style={{
                    background: 'none', border: 'none', outline: 'none',
                    color: '#334155', fontSize: 13, fontFamily: 'inherit', width: '100%',
                  }}
                />
              </div>
            </div>

            <div style={{ maxHeight: 380, overflowY: 'auto', padding: '8px 0' }}>
              {/* ALL option (only in multi mode) */}
              {mode === 'multi' && (
                <button
                  onClick={() => { onSelect('ALL'); setOpen(false); setSearch(''); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    width: '100%', padding: '10px 16px',
                    background: selected === 'ALL' ? 'rgba(96,165,250,0.1)' : 'transparent',
                    border: 'none',
                    color: selected === 'ALL' ? '#60a5fa' : '#94a3b8',
                    fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', fontFamily: 'inherit',
                    textAlign: 'left', transition: 'background 0.1s',
                  }}
                >
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 28, height: 28, borderRadius: 8,
                    background: 'rgba(96,165,250,0.12)', fontSize: 16,
                  }}>🌐</span>
                  <div>
                    <div style={{ fontWeight: 700 }}>All Providers</div>
                    <div style={{ fontSize: 11, color: '#475569', marginTop: 1 }}>{accounts.length} accounts total</div>
                  </div>
                  {selected === 'ALL' && (
                    <span style={{ marginLeft: 'auto', width: 8, height: 8, borderRadius: '50%', background: '#60a5fa' }} />
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
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '8px 16px 4px',
                      marginTop: 4,
                    }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 20, height: 20, borderRadius: 5,
                        background: meta.accent, fontSize: 12,
                      }}>{meta.logo}</span>
                      <span style={{
                        fontSize: 10, fontWeight: 800, textTransform: 'uppercase',
                        letterSpacing: 1, color: meta.color,
                      }}>{meta.label}</span>
                      <span style={{
                        marginLeft: 'auto', fontSize: 10, fontWeight: 700,
                        color: '#475569',
                      }}>{provAccounts.length} acct{provAccounts.length !== 1 ? 's' : ''}</span>
                    </div>

                    {/* Account chips */}
                    {provAccounts.map(acc => {
                      const isSelected = selected === acc.id;
                      return (
                        <button
                          key={acc.id}
                          onClick={() => { onSelect(acc.id); setOpen(false); setSearch(''); }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            width: '100%', padding: '9px 16px 9px 36px',
                            background: isSelected ? meta.accent : 'transparent',
                            border: 'none',
                            color: isSelected ? meta.color : '#94a3b8',
                            fontSize: 13, fontWeight: isSelected ? 700 : 500,
                            cursor: 'pointer', fontFamily: 'inherit',
                            textAlign: 'left', transition: 'background 0.1s',
                          }}
                        >
                          <div style={{
                            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                            background: isSelected ? meta.color : '#334155',
                          }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontWeight: 600, color: isSelected ? '#f1f5f9' : '#cbd5e1',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {acc.account_name}
                            </div>
                            <div style={{ fontSize: 11, color: '#475569', marginTop: 1 }}>
                              {acc.environment || 'production'} · {acc.tenant_or_region || 'multi-region'}
                            </div>
                          </div>
                          {isSelected && (
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}

              {!hasResults && (
                <div style={{ padding: '24px 16px', textAlign: 'center', color: '#475569', fontSize: 13 }}>
                  No accounts match "{search}"
                </div>
              )}
            </div>

            {/* Footer: add account */}
            {onAddAccount && (
              <div style={{ borderTop: '1px solid #e2e8f0', padding: '8px 0' }}>
                <button
                  onClick={() => { onAddAccount(); setOpen(false); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    width: '100%', padding: '10px 16px',
                    background: 'transparent', border: 'none',
                    color: '#60a5fa', fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', fontFamily: 'inherit',
                    textAlign: 'left',
                  }}
                >
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 28, height: 28, borderRadius: 8,
                    background: 'rgba(96,165,250,0.12)', flexShrink: 0,
                  }}>
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

      {/* Animation keyframe (injected once) */}
      <style>{`
        @keyframes fadeSlideDown {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
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
    <div style={{
      display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 24,
    }}>
      {/* All */}
      <button
        onClick={() => onSelectProvider(null)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 18px',
          background: !selectedProvider ? 'rgba(96,165,250,0.1)' : '#eef2f6',
          border: `1.5px solid ${!selectedProvider ? '#60a5fa' : '#e2e8f0'}`,
          borderRadius: 14,
          cursor: 'pointer', fontFamily: 'inherit',
          transition: 'all 0.15s',
        }}
      >
        <span style={{ fontSize: 18 }}>🌐</span>
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: !selectedProvider ? '#60a5fa' : '#e2e8f0', letterSpacing: 0.3 }}>
            All Clouds
          </div>
          <div style={{ fontSize: 11, color: '#475569', marginTop: 1 }}>
            {accounts.length} accounts
          </div>
        </div>
      </button>

      {providers.map(provider => {
        const meta = PROVIDER_META[provider];
        const count = accounts.filter(a => a.provider === provider).length;
        const isActive = selectedProvider === provider;

        return (
          <button
            key={provider}
            onClick={() => onSelectProvider(provider === selectedProvider ? null : provider)}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 18px',
              background: isActive ? meta.accent : '#eef2f6',
              border: `1.5px solid ${isActive ? meta.color : '#e2e8f0'}`,
              borderRadius: 14,
              cursor: 'pointer', fontFamily: 'inherit',
              transition: 'all 0.15s',
              opacity: count === 0 ? 0.4 : 1,
            }}
            disabled={count === 0}
          >
            {/* Provider logo */}
            <span style={{
              width: 36, height: 36, borderRadius: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: meta.bg, fontSize: 20, flexShrink: 0,
            }}>
              {meta.logo}
            </span>

            <div style={{ textAlign: 'left' }}>
              <div style={{
                fontSize: 13, fontWeight: 800,
                color: isActive ? meta.color : '#e2e8f0',
                letterSpacing: 0.3,
              }}>
                {provider}
              </div>
              <div style={{ fontSize: 11, color: '#475569', marginTop: 1 }}>
                {count} account{count !== 1 ? 's' : ''}
              </div>
            </div>

            {/* Account count badge */}
            {count > 0 && (
              <span style={{
                marginLeft: 4,
                width: 22, height: 22, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: isActive ? meta.color : '#e2e8f0',
                color: isActive ? '#fff' : '#94a3b8',
                fontSize: 11, fontWeight: 800,
                flexShrink: 0,
              }}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
