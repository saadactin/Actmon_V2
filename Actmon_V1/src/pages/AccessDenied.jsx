import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldAlert, ArrowLeft, LayoutDashboard } from 'lucide-react';

export default function AccessDenied() {
  const navigate = useNavigate();
  return (
    <div className="min-h-[70vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center bg-white rounded-3xl border border-slate-200 shadow-sm p-10">
        <div className="w-20 h-20 mx-auto rounded-2xl bg-gradient-to-br from-rose-500 to-red-600 flex items-center justify-center text-white shadow-lg shadow-red-200 mb-5">
          <ShieldAlert size={38} />
        </div>
        <h1 className="text-2xl font-black text-slate-800">Access Denied</h1>
        <p className="text-sm text-slate-500 mt-2">
          You don't have permission to view this page. Contact your administrator to update your role permissions.
        </p>
        <div className="flex items-center justify-center gap-2 mt-7">
          <button onClick={() => navigate(-1)} className="h-11 px-5 rounded-xl bg-slate-100 text-slate-600 font-bold text-sm hover:bg-slate-200 flex items-center gap-2">
            <ArrowLeft size={16} /> Go Back
          </button>
          <button onClick={() => navigate('/dashboard')} className="h-11 px-5 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-bold text-sm shadow-lg flex items-center gap-2">
            <LayoutDashboard size={16} /> Dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
