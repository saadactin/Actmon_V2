import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import client from '../../api/client';

export default function ErrorAnalysis() {
  const { id } = useParams();
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const analyze = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.post(`/connections/mysql/${id}/analyze-error`, { message: text });
      setResult(res.data);
    } catch (e) {
      setError(e.message || 'Analysis failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">AI Error Analysis</h1>
          <p className="text-sm text-slate-500">Paste an error message or log and run AI analysis for suggestions.</p>
        </div>
        <Link to={`/mysql-dashboard/${id}`} className="underline">Back</Link>
      </div>

      <div className="bg-white rounded-lg border p-4">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} className="w-full p-3 border rounded" placeholder="Paste MySQL error log or message here" />
        <div className="mt-3 flex gap-2">
          <button onClick={analyze} className="px-4 py-2 rounded bg-indigo-600 text-white" disabled={loading || !text}>{loading ? 'Analyzing...' : 'Analyze'}</button>
          <button onClick={() => { setText(''); setResult(null); setError(null); }} className="px-4 py-2 rounded border text-slate-700">Clear</button>
        </div>
      </div>

      {loading && <div className="mt-3 text-slate-500">Analyzing...</div>}
      {error && <div className="mt-3 text-red-600">Error: {error}</div>}
      {result && (
        <div className="mt-4 bg-white rounded-lg border p-4">
          <h3 className="font-semibold">Analysis Result</h3>
          <pre className="bg-slate-50 p-3 border rounded mt-2 overflow-auto">{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
