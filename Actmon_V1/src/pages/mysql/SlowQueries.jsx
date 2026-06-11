import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import client from '../../api/client';

const fetchSlowQueries = async (id) => {
  const res = await client.get(`/connections/mysql/${id}/slow-queries`);
  return res.data;
};

export default function SlowQueries() {
  const { id } = useParams();
  const { data = [], isLoading, error, refetch } = useQuery({
    queryKey: ['mysqlSlowQueries', id],
    queryFn: () => fetchSlowQueries(id),
    retry: false,
    refetchInterval: 15000,
  });

  if (isLoading) return <div>Loading slow queries...</div>;
  if (error) return <div>Error: {error.message}</div>;

  const items = Array.isArray(data) ? data : data.slow_queries || [];

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Slow Queries</h1>
        <div className="flex items-center gap-3">
          <Link to={`/mysql-dashboard/${id}`} className="underline">Back</Link>
          <button onClick={() => refetch()} className="ml-2 px-3 py-1 rounded bg-slate-900 text-white">Refresh</button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="text-sm text-slate-500">No slow queries found.</div>
      ) : (
        <div className="space-y-4">
          {items.map((q, i) => (
            <div key={i} className="bg-white border rounded p-3 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-slate-500">{q.sample_time || q.time || ''}</div>
                <div className="text-xs text-slate-600 font-semibold">{q.duration || q.exec_time || ''}</div>
              </div>
              <pre className="font-mono text-sm bg-slate-50 p-2 rounded overflow-auto">{q.query || q.sql || JSON.stringify(q)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
