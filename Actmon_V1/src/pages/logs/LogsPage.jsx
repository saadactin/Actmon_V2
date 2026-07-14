import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ScrollText, RefreshCw, AlertTriangle, Database, Activity, Clock,
  CheckCircle2, XCircle, Loader2,
} from 'lucide-react';
import { getLogStatus, getLogCatalog, getLogSnapshot, getLogErrors } from '../../api/logs';

/* ─── helpers ────────────────────────────────────────────────────────────── */
const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '—');

const severityBadge = (sev) => {
  const s = String(sev || '').toLowerCase();
  if (['critical', 'fatal', 'panic'].includes(s)) return 'bg-red-100 text-red-800 border-red-200';
  if (['error', 'err'].includes(s)) return 'bg-orange-100 text-orange-800 border-orange-200';
  if (['warning', 'warn'].includes(s)) return 'bg-yellow-100 text-yellow-800 border-yellow-200';
  return 'bg-gray-100 text-gray-700 border-gray-200';
};

/* ─── page ───────────────────────────────────────────────────────────────── */
export default function LogsPage() {
  const [dbType, setDbType] = useState('');       // '' = all databases
  const [hours, setHours] = useState(24);

  // Log-store health — everything else only loads once the store is reachable
  const status = useQuery({
    queryKey: ['logs', 'status'],
    queryFn: getLogStatus,
    refetchInterval: 30_000,
    retry: 1,
  });
  const available = !!status.data?.available;

  const catalog = useQuery({
    queryKey: ['logs', 'catalog'],
    queryFn: getLogCatalog,
    enabled: available,
  });

  const snapshot = useQuery({
    queryKey: ['logs', 'snapshot', dbType],
    queryFn: () => getLogSnapshot(dbType || undefined),
    enabled: available,
    refetchInterval: 15_000,
  });

  const errors = useQuery({
    queryKey: ['logs', 'errors', hours],
    queryFn: () => getLogErrors(undefined, hours),
    enabled: available,
    refetchInterval: 30_000,
  });

  const dbTypes = Array.isArray(catalog.data?.db_types)
    ? catalog.data.db_types
    : Array.isArray(catalog.data) ? catalog.data : [];
  const snapshotRows = Array.isArray(snapshot.data?.rows)
    ? snapshot.data.rows
    : Array.isArray(snapshot.data) ? snapshot.data : [];
  const errorRows = Array.isArray(errors.data?.rows)
    ? errors.data.rows
    : Array.isArray(errors.data) ? errors.data : [];

  const refreshAll = () => { status.refetch(); snapshot.refetch(); errors.refetch(); };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
            <ScrollText className="h-8 w-8 text-[#0078D4]" />
            Logs
          </h1>
          <p className="text-sm text-gray-600 mt-2">
            Centralized metric and error logs collected from monitored databases.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Store status pill */}
          {status.isLoading ? (
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600 border border-gray-200">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking log store…
            </span>
          ) : available ? (
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-green-100 text-green-800 border border-green-200">
              <CheckCircle2 className="h-3.5 w-3.5" /> Log store connected
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-red-100 text-red-800 border border-red-200">
              <XCircle className="h-3.5 w-3.5" /> Log store offline
            </span>
          )}
          <button
            onClick={refreshAll}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${snapshot.isFetching || errors.isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Store unavailable — explain instead of a blank page */}
      {!status.isLoading && !available && (
        <div className="bg-white rounded-2xl border-2 border-dashed border-gray-300 p-12 text-center">
          <AlertTriangle className="h-10 w-10 text-yellow-500 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-gray-900 mb-2">Log store not reachable</h3>
          <p className="text-sm text-gray-600 max-w-lg mx-auto">
            The centralized log store (ClickHouse) is not connected
            {status.data?.error ? <> — <span className="font-mono">{String(status.data.error)}</span></> : null}.
            Metric and error logs will appear here automatically once it is running.
          </p>
        </div>
      )}

      {available && (
        <>
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Database className="h-4 w-4 text-gray-400" />
              <select
                value={dbType}
                onChange={(e) => setDbType(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All databases</option>
                {dbTypes.map((t) => (
                  <option key={typeof t === 'string' ? t : t.db_type} value={typeof t === 'string' ? t : t.db_type}>
                    {typeof t === 'string' ? t : t.db_type}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Clock className="h-4 w-4 text-gray-400" />
              <select
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
                className="border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value={1}>Last 1 hour</option>
                <option value={6}>Last 6 hours</option>
                <option value={24}>Last 24 hours</option>
                <option value={72}>Last 3 days</option>
              </select>
            </div>
          </div>

          {/* Latest metric snapshot */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
              <Activity className="h-4 w-4 text-[#0078D4]" />
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wider">Latest Metric Snapshot</h2>
            </div>
            {snapshot.isLoading ? (
              <div className="flex justify-center items-center py-16 text-gray-500 text-sm gap-2">
                <Loader2 className="h-5 w-5 animate-spin" /> Loading snapshot…
              </div>
            ) : snapshotRows.length === 0 ? (
              <div className="py-16 text-center text-sm text-gray-500">No metric logs recorded yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      {Object.keys(snapshotRows[0]).slice(0, 8).map((col) => (
                        <th key={col} className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase tracking-wider whitespace-nowrap">
                          {col.replaceAll('_', ' ')}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {snapshotRows.slice(0, 50).map((row, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        {Object.keys(snapshotRows[0]).slice(0, 8).map((col) => (
                          <td key={col} className="px-4 py-2.5 whitespace-nowrap text-gray-700">
                            {col.toLowerCase().includes('time') || col.toLowerCase().includes('_at')
                              ? fmtTs(row[col])
                              : String(row[col] ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Recent errors */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-orange-500" />
              <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wider">Recent Errors</h2>
            </div>
            {errors.isLoading ? (
              <div className="flex justify-center items-center py-16 text-gray-500 text-sm gap-2">
                <Loader2 className="h-5 w-5 animate-spin" /> Loading errors…
              </div>
            ) : errorRows.length === 0 ? (
              <div className="py-16 text-center text-sm text-gray-500">
                No errors in the selected window. 🎉
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">Time</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">Severity</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">Source</th>
                      <th className="px-4 py-3 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {errorRows.slice(0, 100).map((row, i) => (
                      <tr key={i} className="hover:bg-gray-50 align-top">
                        <td className="px-4 py-2.5 whitespace-nowrap text-gray-600">
                          {fmtTs(row.ts || row.time || row.timestamp || row.created_at)}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold border ${severityBadge(row.severity || row.level)}`}>
                            {row.severity || row.level || 'info'}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-gray-700">
                          {row.db_type || row.source || '—'}
                          {row.connection_id != null ? ` #${row.connection_id}` : ''}
                        </td>
                        <td className="px-4 py-2.5 text-gray-700 max-w-xl">
                          <span className="line-clamp-2 font-mono text-xs">{row.message || row.error || JSON.stringify(row)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
