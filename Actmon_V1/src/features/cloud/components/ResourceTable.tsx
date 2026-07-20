import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useResources } from '../hooks/useResources';
import {
  Server, HardDrive, SquareFunction, Database, Container, Scale, Inbox,
  Megaphone, Globe, Lock, Shield, User, Bot, Brain, BookOpen, Cloud,
  Search, MapPin, ChevronUp, ChevronDown, ChevronRight, Loader2,
} from 'lucide-react';

interface Props {
  accountId: string | null;
}

type LucideIcon = React.ComponentType<{ className?: string }>;

const PILL = {
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  purple: 'bg-purple-50 text-purple-700 border-purple-200',
  green: 'bg-green-50 text-green-700 border-green-200',
  orange: 'bg-orange-50 text-orange-700 border-orange-200',
  gray: 'bg-gray-100 text-gray-600 border-gray-200',
} as const;

type PillTone = keyof typeof PILL;

const TYPE_META: Record<string, { Icon: LucideIcon; tone: PillTone }> = {
  EC2Instance:          { Icon: Server,         tone: 'blue' },
  S3Bucket:             { Icon: HardDrive,      tone: 'purple' },
  LambdaFunction:       { Icon: SquareFunction, tone: 'blue' },
  DynamoDBTable:        { Icon: Database,       tone: 'green' },
  RDSInstance:          { Icon: Database,       tone: 'green' },
  EKSCluster:           { Icon: Container,      tone: 'orange' },
  LoadBalancer:         { Icon: Scale,          tone: 'gray' },
  SQSQueue:             { Icon: Inbox,          tone: 'gray' },
  SNSTopic:             { Icon: Megaphone,      tone: 'gray' },
  CloudFront:           { Icon: Globe,          tone: 'gray' },
  VPC:                  { Icon: Lock,           tone: 'purple' },
  SecurityGroup:        { Icon: Shield,         tone: 'gray' },
  IAMRole:              { Icon: User,           tone: 'gray' },
  APIGateway:           { Icon: Globe,          tone: 'gray' },
  BedrockModel:         { Icon: Bot,            tone: 'green' },
  BedrockAgent:         { Icon: Brain,          tone: 'orange' },
  BedrockKnowledgeBase: { Icon: BookOpen,       tone: 'blue' },
};

function getMeta(type: string): { Icon: LucideIcon; tone: PillTone } {
  return TYPE_META[type] || { Icon: Cloud, tone: 'gray' };
}

function statusPill(status?: string | null): { pill: string; dot: string } {
  const s = (status || '').toLowerCase();
  if (['running', 'active', 'available', 'healthy', 'succeeded'].includes(s))
    return { pill: 'bg-green-50 text-green-700 border-green-200', dot: 'bg-green-500' };
  if (['pending', 'starting'].includes(s))
    return { pill: 'bg-yellow-50 text-yellow-700 border-yellow-200', dot: 'bg-yellow-500' };
  if (['stopped', 'failed', 'terminated', 'error', 'deleting'].includes(s))
    return { pill: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' };
  return { pill: 'bg-gray-100 text-gray-600 border-gray-200', dot: 'bg-gray-400' };
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
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        <span className="text-sm text-gray-500">Loading resources…</span>
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

  const thClass = (key: typeof sortKey) =>
    `px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap cursor-pointer select-none transition-colors ${
      sortKey === key ? 'text-blue-600' : 'text-gray-500 hover:text-gray-700'
    }`;

  const sortIndicator = (key: typeof sortKey) =>
    sortKey === key
      ? (sortAsc
          ? <ChevronUp className="inline h-3 w-3 ml-0.5 -mt-0.5" />
          : <ChevronDown className="inline h-3 w-3 ml-0.5 -mt-0.5" />)
      : null;

  // Summary chips
  const typeCounts = (resources || []).reduce<Record<string, number>>((acc, r) => {
    acc[r.resource_type] = (acc[r.resource_type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(typeCounts).map(([type, count]) => {
          const m = getMeta(type);
          const active = typeFilter === type;
          return (
            <button
              key={type}
              onClick={() => setTypeFilter(active ? 'All' : type)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${
                active ? PILL[m.tone] : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              <m.Icon className="h-3.5 w-3.5" />
              <span>{type}</span>
              <span className={`rounded-full px-1.5 text-[11px] font-bold ${
                active ? 'bg-white/70' : 'bg-gray-100 text-gray-500'
              }`}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={`Search ${filtered.length} resources…`}
          className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm bg-white text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-gray-50">
              <tr>
                <th className={thClass('resource_name')} onClick={() => toggle('resource_name')}>
                  Resource Name{sortIndicator('resource_name')}
                </th>
                <th className={thClass('resource_type')} onClick={() => toggle('resource_type')}>
                  Type{sortIndicator('resource_type')}
                </th>
                <th className={thClass('region_or_zone')} onClick={() => toggle('region_or_zone')}>
                  Region{sortIndicator('region_or_zone')}
                </th>
                <th className={thClass('status')} onClick={() => toggle('status')}>
                  Status{sortIndicator('status')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-sm text-gray-500">
                    No resources found. Try adjusting your filters.
                  </td>
                </tr>
              ) : (
                filtered.map(item => {
                  const isDefault = item.is_default || item.resource_name.toLowerCase() === 'default' || item.config?.is_default === true;
                  const meta = getMeta(item.resource_type);
                  const sc = statusPill(item.status);
                  return (
                    <tr
                      key={item.id}
                      onClick={() => navigate(`/cloud/resources/${item.id}`)}
                      className="cursor-pointer hover:bg-gray-50 transition-colors"
                    >
                      {/* Name */}
                      <td className="px-4 py-3 text-sm whitespace-nowrap">
                        <div className="flex items-center gap-2.5">
                          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${isDefault ? PILL.gray : PILL[meta.tone]}`}>
                            <meta.Icon className="h-4 w-4" />
                          </span>
                          <span className={`font-semibold ${isDefault ? 'text-gray-500' : 'text-gray-900'}`}>
                            {item.resource_name}
                          </span>
                          {isDefault && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-200 text-[9px] font-bold uppercase tracking-wide">
                              default
                            </span>
                          )}
                        </div>
                      </td>
                      {/* Type */}
                      <td className="px-4 py-3 text-sm whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${isDefault ? PILL.gray : PILL[meta.tone]}`}>
                          {item.resource_type}
                        </span>
                      </td>
                      {/* Region */}
                      <td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3.5 w-3.5 text-gray-400" />
                          {item.region_or_zone}
                        </span>
                      </td>
                      {/* Status */}
                      <td className="px-4 py-3 text-sm whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${sc.pill}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${sc.dot}`} />
                          {(item.status || 'NA').toUpperCase()}
                        </span>
                      </td>
                      {/* Arrow */}
                      <td className="px-4 py-3 text-center whitespace-nowrap">
                        <ChevronRight className="inline h-4 w-4 text-gray-400" />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-gray-100 bg-gray-50">
          <span className="text-xs text-gray-500">
            Showing <strong className="font-semibold text-gray-700">{filtered.length}</strong> of <strong className="font-semibold text-gray-700">{(resources || []).length}</strong> resources
          </span>
          {search || typeFilter !== 'All' ? (
            <button
              onClick={() => { setSearch(''); setTypeFilter('All'); }}
              className="text-xs font-semibold text-blue-600 hover:text-blue-700"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};
