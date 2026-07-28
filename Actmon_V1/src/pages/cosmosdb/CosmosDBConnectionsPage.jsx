import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, ChevronRight, ChevronLeft, Trash2, RefreshCw, Database, AlertTriangle, Loader2, Settings2 } from 'lucide-react';

import { listConnections, deleteConnection } from '../../api/connections';
import { TechLogo } from '../agents/setup/logos';

export default function CosmosDBConnectionsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState(null);

  const { data: connections = [], isLoading } = useQuery({
    queryKey: ['cosmosdbConnections'],
    queryFn: () => listConnections('cosmosdb'),
    refetchInterval: 30000,
  });

  const deleteMut = useMutation({
    mutationFn: (id) => deleteConnection('cosmosdb', id),
    onSuccess: () => { qc.invalidateQueries(['cosmosdbConnections']); setDeleting(null); },
    onError: () => setDeleting(null),
  });

  return (
    <div className="-mx-6 md:-mx-8 min-h-full bg-[#f1f4f9]">
      <div className="bg-gradient-to-r from-slate-900 via-blue-800 to-sky-700 px-6 pt-3 pb-4 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)', backgroundSize: '28px 28px' }} />

        <div className="relative flex items-center gap-2 text-xs text-slate-300/70 mb-2.5">
          <button onClick={() => navigate('/databases')} className="hover:text-slate-300 cursor-pointer transition-colors">ActMon</button>
          <ChevronRight size={11} />
          <button onClick={() => navigate('/databases')} className="hover:text-slate-300 cursor-pointer transition-colors">Databases</button>
          <ChevronRight size={11} />
          <span className="text-slate-300 font-semibold">Azure Cosmos DB</span>
        </div>

        <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/databases')}
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 flex items-center justify-center text-white transition-all flex-shrink-0">
              <ChevronLeft size={16} />
            </button>
            <TechLogo id="cosmosdb" size={36} />
            <div>
              <h1 className="text-lg font-black text-white tracking-tight leading-none">Azure Cosmos DB</h1>
              <p className="text-sky-200/70 text-[11px] mt-0.5">Multi-model, globally distributed cloud database — SQL (Core) API</p>
            </div>
          </div>
          <button onClick={() => navigate('/connections/add?type=CosmosDB')}
            className="h-9 px-4 rounded-lg bg-white text-blue-700 font-bold flex items-center gap-1.5 hover:bg-sky-50 shadow-sm transition-all text-sm flex-shrink-0">
            <Plus size={15} /> Add Connection
          </button>
        </div>
      </div>

      <div className="max-w-screen-2xl mx-auto px-8 py-10">
        {isLoading ? (
          <div className="flex items-center justify-center py-24"><Loader2 className="animate-spin text-slate-300" size={28} /></div>
        ) : connections.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-16 text-center">
            <div className="w-16 h-16 rounded-2xl bg-sky-50 flex items-center justify-center mx-auto mb-4"><Database size={28} className="text-sky-300" /></div>
            <h3 className="text-lg font-black text-slate-700">No Cosmos DB connections yet</h3>
            <p className="text-slate-400 text-sm mt-1">Add an Azure Cosmos DB account to start monitoring its databases and containers.</p>
            <button onClick={() => navigate('/connections/add?type=CosmosDB')}
              className="mt-5 h-10 px-5 rounded-lg bg-blue-700 text-white font-bold text-sm hover:bg-blue-800 inline-flex items-center gap-2">
              <Plus size={16} /> Add Connection
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {connections.map((c) => (
              <div key={c.id}
                className="group relative bg-white rounded-2xl border-2 border-slate-100 p-6 shadow-md hover:shadow-xl transition-all duration-200 hover:-translate-y-1 hover:border-sky-300">
                <button onClick={() => navigate(`/cosmosdb-dashboard/${c.id}`)} className="text-left w-full">
                  <div className="flex items-start gap-4">
                    <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-sky-500 to-blue-700 flex items-center justify-center flex-shrink-0 shadow-lg">
                      <span className="text-2xl select-none">🌌</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-[17px] font-black text-slate-900 leading-tight truncate">{c.connection_name}</h3>
                      <p className="text-xs text-slate-400 mt-0.5 font-medium truncate">{c.endpoint}</p>
                      <div className="flex items-center gap-3 mt-3 flex-wrap">
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-50 border border-sky-200">
                          <Database size={11} className="text-sky-700" />
                          <span className="text-[11px] font-bold text-sky-700">{c.database_name} / {c.container_name}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-5 pt-4 border-t border-slate-100">
                    <span className="text-[12px] font-bold text-sky-700">Explore databases &amp; containers</span>
                    <ChevronRight size={15} className="text-sky-700 group-hover:translate-x-1 transition-transform" />
                  </div>
                </button>
                <div className="absolute top-4 right-4 flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); navigate(`/cosmosdb-edit/${c.id}`); }}
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-300 hover:text-sky-600 hover:bg-sky-50 transition-colors"
                    title="Edit connection">
                    <Settings2 size={14} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeleting(c.id); }}
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                    title="Delete connection">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {deleting != null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <div className="flex items-center gap-3 mb-3">
              <AlertTriangle className="text-red-500" size={22} />
              <h3 className="font-black text-slate-800">Delete connection?</h3>
            </div>
            <p className="text-sm text-slate-500 mb-5">This removes the saved connection. It doesn't affect the Cosmos DB account itself.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleting(null)} className="h-9 px-4 rounded-lg text-slate-600 text-sm font-bold hover:bg-slate-100">Cancel</button>
              <button onClick={() => deleteMut.mutate(deleting)} disabled={deleteMut.isPending}
                className="h-9 px-4 rounded-lg bg-red-600 text-white text-sm font-bold hover:bg-red-700 disabled:opacity-50 flex items-center gap-2">
                {deleteMut.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Trash2 size={13} />} Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
