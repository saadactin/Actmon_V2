import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useResources } from '../hooks/useResources';

interface Props {
  accountId: string | null;
}

const TYPE_META: Record<string, { icon: string; color: string; bg: string }> = {
  EC2Instance:          { icon: '🖥️',  color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  S3Bucket:             { icon: '🪣',  color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
  LambdaFunction:       { icon: 'λ',   color: '#a855f7', bg: 'rgba(168,85,247,0.12)' },
  DynamoDBTable:        { icon: '🗄️',  color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  RDSInstance:          { icon: '💾',  color: '#06b6d4', bg: 'rgba(6,182,212,0.12)'  },
  EKSCluster:           { icon: '⚓',  color: '#6366f1', bg: 'rgba(99,102,241,0.12)' },
  LoadBalancer:         { icon: '⚖️',  color: '#ec4899', bg: 'rgba(236,72,153,0.12)' },
  SQSQueue:             { icon: '📬',  color: '#f97316', bg: 'rgba(249,115,22,0.12)' },
  SNSTopic:             { icon: '📢',  color: '#eab308', bg: 'rgba(234,179,8,0.12)'  },
  CloudFront:           { icon: '🌐',  color: '#14b8a6', bg: 'rgba(20,184,166,0.12)' },
  VPC:                  { icon: '🔒',  color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
  SecurityGroup:        { icon: '🛡️',  color: '#64748b', bg: 'rgba(100,116,139,0.12)'},
  IAMRole:              { icon: '👤',  color: '#ef4444', bg: 'rgba(239,68,68,0.12)'  },
  APIGateway:           { icon: '🌐',  color: '#ec4899', bg: 'rgba(236,72,153,0.12)' },
  BedrockModel:         { icon: '🤖',  color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  BedrockAgent:         { icon: '🧠',  color: '#ec4899', bg: 'rgba(236,72,153,0.12)' },
  BedrockKnowledgeBase: { icon: '📚',  color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
};

function getMeta(type: string) {
  return TYPE_META[type] || { icon: '☁️', color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' };
}

function statusColor(status?: string | null): { bg: string; fg: string; dot: string } {
  const s = (status || '').toLowerCase();
  if (['running', 'active', 'available', 'active'].includes(s))
    return { bg: 'rgba(34,197,94,0.15)', fg: '#4ade80', dot: '#22c55e' };
  if (['pending', 'starting'].includes(s))
    return { bg: 'rgba(234,179,8,0.15)', fg: '#facc15', dot: '#eab308' };
  return { bg: 'rgba(239,68,68,0.15)', fg: '#f87171', dot: '#ef4444' };
}

export const ResourceTable: React.FC<Props> = ({ accountId }) => {
  const { data: resources, isLoading } = useResources(accountId);
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('All');
  const [sortKey, setSortKey] = useState<'resource_name' | 'resource_type' | 'region_or_zone' | 'status'>('resource_type');
  const [sortAsc, setSortAsc] = useState(true);

  if (!accountId) return null;

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 12 }}>
        <div style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid rgba(96,165,250,0.2)', borderTopColor: '#60a5fa', animation: 'spin 0.8s linear infinite' }} />
        <span style={{ color: '#64748b', fontSize: 14 }}>Loading resources…</span>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  const allTypes = ['All', ...Array.from(new Set((resources || []).map(r => r.resource_type))).sort()];

  const filtered = (resources || [])
    .filter(r => typeFilter === 'All' || r.resource_type === typeFilter)
    .filter(r => !search || r.resource_name.toLowerCase().includes(search.toLowerCase()) || r.resource_type.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const av = (a as any)[sortKey] || '';
      const bv = (b as any)[sortKey] || '';
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    });

  const toggle = (key: typeof sortKey) => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(true); }
  };

  const thStyle = (key: typeof sortKey): React.CSSProperties => ({
    padding: '12px 16px',
    textAlign: 'left',
    fontSize: 11,
    fontWeight: 700,
    color: sortKey === key ? '#60a5fa' : '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    borderBottom: '1px solid #e2e8f0',
    background: '#f1f5f9',
    transition: 'color 0.15s',
  });

  // Summary chips
  const typeCounts = (resources || []).reduce<Record<string, number>>((acc, r) => {
    acc[r.resource_type] = (acc[r.resource_type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Summary bar */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {Object.entries(typeCounts).map(([type, count]) => {
          const m = getMeta(type);
          return (
            <button
              key={type}
              onClick={() => setTypeFilter(typeFilter === type ? 'All' : type)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                padding: '6px 14px', borderRadius: 10, cursor: 'pointer',
                border: `1px solid ${typeFilter === type ? m.color : '#e2e8f0'}`,
                background: typeFilter === type ? m.bg : '#eef2f6',
                color: typeFilter === type ? m.color : '#94a3b8',
                fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                transition: 'all 0.15s',
              }}
            >
              <span>{m.icon}</span>
              <span>{type}</span>
              <span style={{
                background: typeFilter === type ? m.color : '#e2e8f0',
                color: typeFilter === type ? '#000' : '#94a3b8',
                borderRadius: 20, padding: '0 6px', fontSize: 11, fontWeight: 700,
              }}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Search bar */}
      <div style={{ position: 'relative' }}>
        <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', fontSize: 16, color: '#64748b' }}>🔍</span>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={`Search ${filtered.length} resources…`}
          style={{
            width: '100%', padding: '10px 14px 10px 40px',
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: 10, color: '#334155', fontSize: 14,
            fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Table */}
      <div style={{
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: 16,
        overflow: 'hidden',
        backdropFilter: 'blur(10px)',
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle('resource_name')} onClick={() => toggle('resource_name')}>
                Resource Name {sortKey === 'resource_name' ? (sortAsc ? ' ↑' : ' ↓') : ''}
              </th>
              <th style={thStyle('resource_type')} onClick={() => toggle('resource_type')}>
                Type {sortKey === 'resource_type' ? (sortAsc ? ' ↑' : ' ↓') : ''}
              </th>
              <th style={thStyle('region_or_zone')} onClick={() => toggle('region_or_zone')}>
                Region {sortKey === 'region_or_zone' ? (sortAsc ? ' ↑' : ' ↓') : ''}
              </th>
              <th style={thStyle('status')} onClick={() => toggle('status')}>
                Status {sortKey === 'status' ? (sortAsc ? ' ↑' : ' ↓') : ''}
              </th>
              <th style={{ ...thStyle('resource_name'), cursor: 'default', color: '#64748b' }}>Details</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: '48px 0', textAlign: 'center', color: '#64748b', fontSize: 14 }}>
                  No resources found. Try adjusting your filters.
                </td>
              </tr>
            ) : (
              filtered.map((item, i) => {
                const isDefault = item.is_default || item.resource_name.toLowerCase() === 'default' || item.config?.is_default === true;
                const baseMeta = getMeta(item.resource_type);
                const meta = isDefault
                  ? { icon: baseMeta.icon, color: '#64748b', bg: 'rgba(100,116,139,0.06)' }
                  : baseMeta;
                const sc = statusColor(item.status);
                return (
                  <tr
                    key={item.id}
                    onClick={() => navigate(`/cloud/resources/${item.id}`)}
                    style={{
                      cursor: 'pointer',
                      background: i % 2 === 0 ? 'transparent' : '#eef2f6',
                      borderBottom: '1px solid #e2e8f0',
                      transition: 'background 0.12s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(96,165,250,0.08)')}
                    onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : '#eef2f6')}
                  >
                    {/* Name */}
                    <td style={{ padding: '14px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{
                          width: 32, height: 32, borderRadius: 8,
                          background: meta.bg, border: `1px solid ${meta.color}33`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 15, flexShrink: 0,
                        }}>{meta.icon}</div>
                        <span style={{ color: isDefault ? '#94a3b8' : '#e2e8f0', fontWeight: 600, fontSize: 14 }}>
                          {item.resource_name}
                        </span>
                        {isDefault && (
                          <span style={{
                            fontSize: 9,
                            fontWeight: 700,
                            padding: '1px 5px',
                            borderRadius: 4,
                            background: 'rgba(100,116,139,0.15)',
                            color: '#94a3b8',
                            textTransform: 'uppercase',
                            letterSpacing: 0.5
                          }}>
                            default
                          </span>
                        )}
                      </div>
                    </td>
                    {/* Type */}
                    <td style={{ padding: '14px 16px' }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '3px 10px',
                        borderRadius: 6, border: `1px solid ${meta.color}44`,
                        background: meta.bg, color: meta.color, letterSpacing: 0.3,
                      }}>
                        {item.resource_type}
                      </span>
                    </td>
                    {/* Region */}
                    <td style={{ padding: '14px 16px', color: '#94a3b8', fontSize: 13 }}>
                      📍 {item.region_or_zone}
                    </td>
                    {/* Status */}
                    <td style={{ padding: '14px 16px' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        fontSize: 12, fontWeight: 700, padding: '3px 10px',
                        borderRadius: 20, background: sc.bg, color: sc.fg,
                      }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: sc.dot, display: 'inline-block' }} />
                        {(item.status || 'UNKNOWN').toUpperCase()}
                      </span>
                    </td>
                    {/* Arrow */}
                    <td style={{ padding: '14px 16px', color: '#475569', fontSize: 16, textAlign: 'center' }}>→</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {/* Footer */}
        <div style={{
          padding: '10px 16px',
          borderTop: '1px solid #e2e8f0',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: '#f1f5f9',
        }}>
          <span style={{ color: '#64748b', fontSize: 12 }}>
            Showing <strong style={{ color: '#94a3b8' }}>{filtered.length}</strong> of <strong style={{ color: '#94a3b8' }}>{(resources || []).length}</strong> resources
          </span>
          {search || typeFilter !== 'All' ? (
            <button
              onClick={() => { setSearch(''); setTypeFilter('All'); }}
              style={{ background: 'none', border: 'none', color: '#60a5fa', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};
