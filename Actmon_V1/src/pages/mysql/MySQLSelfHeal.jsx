import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import client from '../../api/client';

export default function MySQLSelfHeal() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [errorText, setErrorText] = useState('');
  const [actionType, setActionType] = useState('diagnose_only');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleSubmit = async () => {
    if (!id) return setError(new Error('Missing connection id'));
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const payload = {
        mysql_error_message: errorText,
        action_type: actionType,
      };
      const resp = await client.post(`/connections/mysql/${id}/self-heal`, payload);
      setResult(resp.data || resp);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <button onClick={() => navigate(-1)} className="w-10 h-10 rounded-xl border bg-white flex items-center justify-center">←</button>
          <div>
            <h1 className="text-3xl font-bold text-slate-900">MySQL Self-Heal</h1>
            <p className="text-slate-500 text-sm">Trigger the backend self-healing workflow for a MySQL connection.</p>
          </div>
        </div>

        <div className="bg-white rounded-2xl border p-6 mb-4 shadow-sm">
          <label className="block text-sm font-semibold mb-2">Connection ID</label>
          <div className="text-slate-700 font-mono mb-3">{id}</div>

          <label className="block text-sm font-semibold mb-2">Error Log / Message (optional)</label>
          <textarea value={errorText} onChange={(e) => setErrorText(e.target.value)} rows={8} className="w-full rounded-xl border p-3 mb-4" placeholder="Paste relevant MySQL error log or message here" />

          <label className="block text-sm font-semibold mb-2">Action</label>
          <div className="flex gap-4 items-center mb-4">
            <label className="flex items-center gap-2"><input type="radio" name="action" checked={actionType==='diagnose_only'} onChange={() => setActionType('diagnose_only')} /> <span className="ml-1">Diagnose only</span></label>
            <label className="flex items-center gap-2"><input type="radio" name="action" checked={actionType==='run_self_heal'} onChange={() => setActionType('run_self_heal')} /> <span className="ml-1">Run self-heal</span></label>
          </div>

          <div className="flex gap-3">
            <button onClick={handleSubmit} disabled={loading} className="px-4 py-2 rounded-xl bg-rose-600 text-white">{loading ? 'Running...' : 'Run Self-Heal'}</button>
            <button onClick={() => { setErrorText(''); setResult(null); setError(null); }} className="px-4 py-2 rounded-xl border">Clear</button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded bg-red-50 text-red-700">{String(error)}</div>
        )}

        {result && (
          <div className="bg-white rounded-2xl border p-4 shadow-sm">
            <h3 className="font-bold mb-2">Result</h3>
            <pre className="text-xs overflow-auto max-h-72 bg-slate-50 p-2 rounded">{JSON.stringify(result, null, 2)}</pre>
          </div>
        )}

      </div>
    </div>
  );
}
