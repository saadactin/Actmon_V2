import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, FileText } from 'lucide-react';
import client from '@/api/client';
import PageHeader from '@/components/layout/PageHeader';
import { PageLoading } from '@/components/ui/Loading';

/**
 * One binary log file's events — reached only by clicking a row on the
 * Binary Logs list, never linked to directly with fabricated data. Paginated
 * natively by MySQL's own `SHOW BINLOG EVENTS ... LIMIT offset, count`, so
 * opening a multi-GB file never reads more than one page's worth of events.
 */

const fetchEvents = (id, logName, page, pageSize) =>
  client.get(`/connections/mysql/${id}/binlogs/${encodeURIComponent(logName)}/events`, {
    params: { page, page_size: pageSize },
  }).then(r => r.data);

export default function BinaryLogDetail() {
  const { id, logName } = useParams();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const pageSize = 100;

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['mysqlBinlogEvents', id, logName, page],
    queryFn: () => fetchEvents(id, logName, page, pageSize),
    retry: false,
    // v5's replacement for the v4 boolean `keepPreviousData: true` (which
    // v5 silently ignores) — without this, clicking Next/Prev replaced the
    // events table with the full loading state on every page change instead
    // of keeping the current page's events visible during the fetch.
    placeholderData: keepPreviousData,
  });

  const events = data?.events || [];

  return (
    <div className="flex min-h-full flex-col space-y-5">
      <PageHeader
        icon={FileText}
        title={logName}
        subtitle="Binary Log File — Events"
        backTo={`/mysql-dashboard/${id}/binary-logs`}
        actions={(
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 px-3 h-8 rounded-lg border border-slate-200 text-xs font-semibold text-slate-500 hover:bg-slate-50"
          >
            <RefreshCw size={12} className={isFetching ? 'animate-spin' : undefined} /> Refresh
          </button>
        )}
      />

      {isLoading ? (
        <PageLoading title="Reading binary log events…" />
      ) : error || data?.status === 'error' ? (
        <div className="bg-white rounded-2xl border border-red-200 p-5 text-sm text-red-600">
          Could not read events for this file: {data?.error || error?.message}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100">
            <h3 className="font-bold text-slate-800 text-sm">Events — page {page}</h3>
            <p className="text-[11px] text-slate-400">
              {events.length} event{events.length === 1 ? '' : 's'} on this page · fetched directly from MySQL, one page at a time
            </p>
          </div>

          {events.length === 0 ? (
            <div className="py-16 text-center text-sm text-slate-400">No events on this page.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50">
                  <tr className="text-left text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    <th className="px-5 py-2.5 text-right">Position</th>
                    <th className="px-3 py-2.5 text-right">End Position</th>
                    <th className="px-3 py-2.5">Event Type</th>
                    <th className="px-3 py-2.5 text-right">Server ID</th>
                    <th className="px-3 py-2.5">Info</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev, i) => (
                    <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-5 py-2 text-right font-mono text-slate-600">{ev.position}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-500">{ev.end_position}</td>
                      <td className="px-3 py-2 font-mono font-semibold text-slate-700">{ev.event_type}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-500">{ev.server_id}</td>
                      <td className="px-3 py-2 font-mono text-slate-600 max-w-md truncate" title={ev.info}>{ev.info || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 text-xs text-slate-500">
            <span>Page {page}</span>
            <div className="flex items-center gap-1.5">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="h-7 rounded-md border border-slate-200 px-2.5 font-semibold disabled:opacity-40 hover:bg-slate-50"
              >
                Prev
              </button>
              <button
                disabled={!data?.has_more}
                onClick={() => setPage((p) => p + 1)}
                className="h-7 rounded-md border border-slate-200 px-2.5 font-semibold disabled:opacity-40 hover:bg-slate-50"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
