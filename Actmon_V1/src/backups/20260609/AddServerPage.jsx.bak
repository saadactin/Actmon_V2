import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { ArrowLeft } from 'lucide-react';
import { createServer } from '../../api/servers';

export default function AddServerPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  const { register, handleSubmit, formState: { errors } } = useForm({
    defaultValues: { environment: 'Production' }
  });

  const onSubmit = async (data) => {
    try {
      setLoading(true);
      setMessage(null);
      await createServer({
        server_name: data.serverName,
        ip: data.ip,
        os: data.os,
        environment: data.environment,
        cluster_name: data.clusterName || null,
      });
      setMessage({ type: 'success', text: 'Server created' });
      setTimeout(() => navigate('/databases'), 800);
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Failed to create server' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f6f8fb] p-6">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <button onClick={() => navigate('/databases')} className="w-10 h-10 rounded-xl border bg-white flex items-center justify-center">
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div>
            <h1 className="text-2xl font-bold">Add OS Server</h1>
            <p className="text-slate-500 text-sm">Register a new operating system server and optionally assign it to a cluster.</p>
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="bg-white p-6 rounded-2xl border">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold mb-1">Server Name</label>
              <input {...register('serverName', { required: 'Server name required' })} className="w-full h-11 rounded-xl border px-3" />
              {errors.serverName && <p className="text-red-500 text-sm">{errors.serverName.message}</p>}
            </div>

            <div>
              <label className="block text-sm font-semibold mb-1">IP Address</label>
              <input {...register('ip', { required: 'IP required' })} className="w-full h-11 rounded-xl border px-3" />
              {errors.ip && <p className="text-red-500 text-sm">{errors.ip.message}</p>}
            </div>

            <div>
              <label className="block text-sm font-semibold mb-1">OS / Service</label>
              <input {...register('os')} className="w-full h-11 rounded-xl border px-3" placeholder="Ubuntu 22.04 / PostgreSQL 15" />
            </div>

            <div>
              <label className="block text-sm font-semibold mb-1">Environment</label>
              <select {...register('environment')} className="w-full h-11 rounded-xl border px-3">
                <option>Production</option>
                <option>UAT</option>
                <option>Development</option>
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-semibold mb-1">Cluster Name (optional)</label>
              <input {...register('clusterName')} className="w-full h-11 rounded-xl border px-3" placeholder="PROD-CLUSTER-01" />
            </div>
          </div>

          {message && (
            <div className={`mt-4 p-3 rounded ${message.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
              {message.text}
            </div>
          )}

          <div className="flex justify-end gap-3 mt-6">
            <button type="button" onClick={() => navigate('/databases')} className="px-4 py-2 rounded-xl border">Cancel</button>
            <button type="submit" disabled={loading} className="px-6 py-2 rounded-xl bg-slate-900 text-white">{loading ? 'Saving...' : 'Save Server'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
