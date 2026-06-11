import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import client from '../../api/client';

const fetchErrorLogs = async (id) => {
  const res = await client.get(`/connections/mysql/${id}/error-logs`);
  return res.data;
};

export default function ErrorLogs() {
  const { id } = useParams();
  const { data = {}, isLoading, error, refetch } = useQuery({
    queryKey: ['mysqlErrorLogs', id],
    queryFn: () => fetchErrorLogs(id),
    retry: false,
    refetchInterval: 15000,
  });

  if (isLoading) return <div>Loading error logs...</div>;
  if (error) return <div>Error: {error.message}</div>;

  const lines = Array.isArray(data) ? data : data.lines || [];
  const logPath = data.path || data.file || null;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Error Logs</h1>
        <div className="flex items-center gap-3">
          {logPath && <div className="text-sm text-slate-500 break-all">{logPath}</div>}
          <Link to={`/mysql-dashboard/${id}`} className="underline">Back</Link>
          <button onClick={() => refetch()} className="ml-2 px-3 py-1 rounded bg-slate-900 text-white">Refresh</button>
        </div>
      </div>

      <div className="bg-white border rounded p-3 font-mono text-sm overflow-auto max-h-[60vh]">
        {lines.length === 0 ? (
          <div className="text-slate-500">No error log lines available.</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={`${line.toLowerCase().includes('error') ? 'text-red-600' : 'text-slate-700'}`}>{line}</div>
          ))
        )}
      </div>
    </div>
  );
}
