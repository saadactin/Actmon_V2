import React from 'react';
import { Check } from 'lucide-react';

// ActMon-style numbered step indicator. Supports horizontal and vertical layouts.
export default function Stepper({ steps, current, orientation = 'horizontal' }) {
  if (orientation === 'vertical') {
    return (
      <div className="flex flex-col">
        {steps.map((label, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <div key={label} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black transition-colors flex-shrink-0 ${
                  done ? 'bg-emerald-500 text-white'
                    : active ? 'bg-blue-600 text-white ring-4 ring-blue-100'
                      : 'bg-white border-2 border-slate-300 text-slate-400'}`}>
                  {done ? <Check size={15} /> : i + 1}
                </div>
                {i < steps.length - 1 && <div className={`w-0.5 flex-1 my-1 rounded-full ${i < current ? 'bg-emerald-500' : 'bg-slate-200'}`} style={{ minHeight: 28 }} />}
              </div>
              <div className="pt-1 pb-4">
                <p className={`text-[10px] font-bold uppercase tracking-wide ${i <= current ? 'text-blue-600' : 'text-slate-400'}`}>Step {i + 1}</p>
                <p className={`text-sm font-black ${i <= current ? 'text-slate-800' : 'text-slate-400'}`}>{label}</p>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex items-start">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <React.Fragment key={label}>
            <div className="flex flex-col items-center flex-shrink-0" style={{ minWidth: 90 }}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[14px] font-black transition-colors ${
                done ? 'bg-emerald-500 text-white'
                  : active ? 'bg-blue-600 text-white'
                    : 'bg-white border-2 border-slate-300 text-slate-400'}`}>
                {done ? <Check size={16} /> : i + 1}
              </div>
              <span className={`text-[14px] font-bold mt-1.5 text-center ${i <= current ? 'text-slate-800' : 'text-slate-400'}`}>{label}</span>
            </div>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-0.5 mt-3.5 mx-1 rounded-full ${i < current ? 'bg-emerald-500' : 'bg-slate-200'}`} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
