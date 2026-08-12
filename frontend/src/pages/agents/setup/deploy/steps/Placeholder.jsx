import React from 'react';
import { Hammer } from 'lucide-react';

// Temporary placeholder for deploy steps that are being built page-by-page.
export default function Placeholder({ title }) {
  return (
    <div className="max-w-3xl h-full flex flex-col items-center justify-center text-center py-24">
      <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center mb-3"><Hammer size={22} className="text-slate-400" /></div>
      <p className="text-lg font-black text-slate-700">{title}</p>
      <p className="text-slate-400 mt-1">This step is coming next.</p>
    </div>
  );
}
