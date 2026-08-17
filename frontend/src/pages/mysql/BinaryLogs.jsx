import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  RefreshCw, Search, FileText, HardDrive, Hash, Clock, Database,
  ChevronRight, ArrowUp, ArrowDown, Circle,
} from 'lucide-react';
import client from '@/api/client';
import EngineDashboardHeader from '@/components/layout/EngineDashboardHeader';
import { MYSQL_DASHBOARD_TABS, mysqlTabRoute } from '@/config/mysqlDashboardNav';

/**
 * MySQL Binary Logs — status + a searchable/sortable/paginated file list.
 * ONLY binary-log content lives here (no error logs, no slow queries, no
 * AI/self-heal, no general server info) — clicking a file opens its own
 * dedicated events view (`BinaryLogDetail.jsx`), never dumped inline.
 *
 * Everything here is server-side: `SHOW BINARY LOGS` is cheap (names/sizes
 * only), and it's this endpoint's own filter/sort/page params that decide
 * which slice comes back — the file LIST is small even on a busy server
 * (rotated files, not rows), so no client-side re-fetch-everything trick is
 * needed the way the slow-query list needed one.
 */

const fetchStatus = (id) => client.get(`/connections/mysql/${id}/binlog/status`).then(r => r.data);
const fetchFiles = (id, params) => client.get(`/connections/mysql/${id}/binlogs`, { params }).then(r => r.data);

function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b > 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b > 1048576) return `${(b / 1048576).toFixed(2)} MB`;
  if (b > 1024) return `${(b / 1024).toFixed(2)} KB`;
  return `${b} B`;
}

function StatCard({ icon: Icon, label, value, tone = 'slate' }) {
  const TONES = {
    slate: 'text-slate-500', green: 'text-green-600', red: 'text-red-500',
    cyan: 'text-cyan-600', violet: 'text-violet-600',
  };
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center gap-2 mb-1.5">
        <Icon size={14} className={TONES[tone] || TONES.slate} />
        <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-lg font-black text-slate-800 truncate" title={typeof value === 'string' ? value : undefined}>
        {value ?? '—'}
      </p>
    </div>
  );
}

export default function BinaryLogs() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 220);
    return () => clearTimeout(t);
  }, [search]);
  const [sort, setSort] = useState({ key: 'name', dir: 'desc' });
  const [page, setPage] = useState(1);
  const pageSize = 20;

  useEffect(() => { setPage(1); }, [debouncedSearch, sort.key, sort.dir]);

  const {
    data: status, isLoading: statusLoading, isFetching: statusFetching, refetch: refetchStatus,
  } = useQuery({
    queryKey: ['mysqlBinlogStatus', id],
    queryFn: () => fetchStatus(id),
    retry: false,
    refetchInterval: 15000,
  });

  const params = {
    search: debouncedSearch.trim() || undefined,
    sort_by: sort.key,
    sort_dir: sort.dir,
    page,
    page_size: pageSize,
  };
  const { data: filesData, isLoading: filesLoading, isFetching: filesFetching, refetch: refetchFiles } = useQuery({
    queryKey: ['mysqlBinlogFiles', id, params],
    queryFn: () => fetchFiles(id, params),
    retry: false,
    // v5 renamed the old v4 boolean `keepPreviousData: true` to this
    // `placeholderData` form — the boolean is silently ignored in v5, so
    // this wasn't actually retaining the previous page across a
    // search/sort/page change before.
    placeholderData: keepPreviousData,
    refetchInterval: 30000,
  });

  // The backend clamps an out-of-range page to the actual last page (e.g. a
  // file got purged between requests, or the requested page never existed)
  // and reports the page it actually served in the response. Sync local
  // state to that so Prev/Next and the footer text always describe what's
  // really on screen — this is what guarantees the user can never be left
  // looking at a page the server didn't actually have data for.
  useEffect(() => {
    if (filesData && typeof filesData.page === 'number' && filesData.page !== page) {
      setPage(filesData.page);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesData]);

  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));

  // Refresh means refresh EVERYTHING — status, the file list, and start
  // back on page 1 (an old page number from before the refresh could now
  // be invalid, e.g. if files rotated/were purged in the meantime).
  const handleRefresh = () => {
    setPage(1);
    refetchStatus();
    refetchFiles();
  };

  const files = filesData?.files || [];
  const total = filesData?.total ?? 0;
  const hasNext = filesData?.has_next ?? false;
  const hasPrevious = filesData?.has_previous ?? page > 1;
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);
  // Prefer the files response's OWN `binlog_enabled` flag (it's a single
  // self-contained check within the same request) — the status endpoint's
  // `enabled` is a fallback for while that request is still in flight.
  const binlogOff = filesData
    ? filesData.binlog_enabled === false
    : status?.status === 'success' && status?.enabled === false;

  return (
    <div className="flex min-h-full flex-col">
      <EngineDashboardHeader
        tech="mysql"
        connectionId={id}
        tabs={MYSQL_DASHBOARD_TABS}
        activeTab="binary-logs"
        onTabChange={(t) => navigate(mysqlTabRoute(id, t))}
        onRefresh={handleRefresh}
        isFetching={statusFetching || filesFetching}
      />

      <div className="space-y-5">
        <div>
          <h1 className="text-lg font-black text-slate-800">Binary Logs</h1>
          <p className="text-xs text-slate-500">MySQL Binary Log Files</p>
        </div>

        {/* Status cards render progressively — a failed/slow status fetch
            never blocks the file table below, which comes from its own
            independent request. */}
        {status?.status === 'error' ? (
          <div className="bg-white rounded-2xl border border-red-200 p-5 text-sm text-red-600">
            Could not read binary log configuration: {status.error}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard icon={Circle} label="Binary Logging" value={statusLoading ? '…' : (status?.enabled ? 'ON' : 'OFF')} tone={status?.enabled ? 'green' : 'red'} />
            <StatCard icon={FileText} label="Format" value={statusLoading ? '…' : (status?.format || '—')} tone="cyan" />
            <StatCard icon={Hash} label="Server ID" value={statusLoading ? '…' : (status?.server_id || '—')} />
            <StatCard icon={Clock} label="Retention" value={statusLoading ? '…' : (status?.retention || '—')} />
            <StatCard icon={FileText} label="Current File" value={statusLoading ? '…' : (status?.current_file || '—')} tone="violet" />
            <StatCard icon={Hash} label="Current Position" value={statusLoading ? '…' : (status?.current_position ?? '—')} />
            <StatCard icon={Database} label="Log Files" value={statusLoading ? '…' : (status?.file_count ?? 0)} />
            <StatCard icon={HardDrive} label="Total Size" value={statusLoading ? '…' : fmtBytes(status?.total_size_bytes)} />
          </div>
        )}

        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-slate-100">
            <h3 className="font-bold text-slate-800 text-sm">Binary Log Files{total ? ` (${total})` : ''}</h3>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search file name…"
                  className="h-8 w-48 rounded-lg border border-slate-200 pl-7 pr-2 text-xs outline-none focus:border-cyan-500"
                />
              </div>
              <button
                onClick={handleRefresh}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-slate-500 hover:bg-slate-50"
              >
                <RefreshCw size={12} className={filesFetching ? 'animate-spin' : undefined} /> Refresh
              </button>
            </div>
          </div>

          {filesLoading ? (
            <div className="py-16 text-center text-sm text-slate-400">Loading binary log files…</div>
          ) : binlogOff && files.length === 0 ? (
            <div className="py-16 text-center text-sm text-slate-400">Binary Logging is OFF</div>
          ) : files.length === 0 ? (
            <div className="py-16 text-center text-sm text-slate-400">
              {debouncedSearch ? `No binary log files match "${debouncedSearch}".` : 'No binary log files found.'}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr className="text-left text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      <th className="px-5 py-2.5 w-8"></th>
                      <SortableTh label="File Name" sortKey="name" sort={sort} onSort={toggleSort} />
                      <SortableTh label="Size" sortKey="size" sort={sort} onSort={toggleSort} align="right" />
                      <th className="px-3 py-2.5 text-right">First Position</th>
                      <th className="px-3 py-2.5">Status</th>
                      <th className="px-5 py-2.5 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((f) => (
                      <tr
                        key={f.log_name}
                        onClick={() => navigate(`/mysql-dashboard/${id}/binary-logs/${encodeURIComponent(f.log_name)}`)}
                        className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                      >
                        <td className="px-5 py-2.5">
                          {f.is_current && <span className="block h-2 w-2 rounded-full bg-green-500" title="Current active file" />}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-slate-700">{f.log_name}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-slate-600">{fmtBytes(f.size_bytes)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-slate-500">{f.first_position ?? '—'}</td>
                        <td className="px-3 py-2.5">
                          {f.is_current ? (
                            <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-bold text-green-700 border border-green-200">
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">
                              Rotated
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-2.5 text-right">
                          <ChevronRight size={14} className="text-slate-300" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 text-xs text-slate-500">
                <span>{rangeStart}–{rangeEnd} of {total} file{total === 1 ? '' : 's'}</span>
                <div className="flex items-center gap-1.5">
                  <button
                    disabled={!hasPrevious}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="h-7 rounded-md border border-slate-200 px-2.5 font-semibold disabled:opacity-40 hover:bg-slate-50"
                  >
                    Prev
                  </button>
                  <button
                    disabled={!hasNext}
                    onClick={() => setPage((p) => p + 1)}
                    className="h-7 rounded-md border border-slate-200 px-2.5 font-semibold disabled:opacity-40 hover:bg-slate-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <p className="text-[11px] text-slate-400">
          Retention: {status?.retention || '—'}. Files are read and paginated on the server — this page never
          loads binary log event data until you open a specific file.
        </p>
      </div>
    </div>
  );
}

function SortableTh({ label, sortKey, sort, onSort, align }) {
  const active = sort.key === sortKey;
  return (
    <th
      className={`px-3 py-2.5 cursor-pointer select-none hover:text-slate-600 ${align === 'right' ? 'text-right' : 'text-left'}`}
      onClick={() => onSort(sortKey)}
    >
      <span className={`inline-flex items-center gap-1 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        {label}
        {active && (sort.dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
      </span>
    </th>
  );
}
