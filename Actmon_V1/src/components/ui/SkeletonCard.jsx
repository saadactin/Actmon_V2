import React from 'react';

export const SkeletonCard = () => {
  return (
    <div className="p-5 border border-brand-border bg-white shadow-card rounded-card animate-pulse space-y-4">
      <div className="flex justify-between items-start">
        <div className="space-y-2 flex-1">
          <div className="h-3.5 bg-gray-200 rounded w-1/4" />
          <div className="h-8 bg-gray-200 rounded w-1/2" />
        </div>
        <div className="h-10 w-10 bg-gray-200 rounded-lg" />
      </div>
      <div className="h-3 bg-gray-200 rounded w-2/3" />
    </div>
  );
};

export const SkeletonTable = () => {
  return (
    <div className="w-full border border-brand-border bg-white rounded-card shadow-card animate-pulse">
      <div className="bg-[#FAF9F8] h-12 border-b border-brand-border" />
      <div className="p-4 space-y-4">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex gap-4 items-center">
            <div className="h-4 bg-gray-200 rounded flex-1" />
            <div className="h-4 bg-gray-200 rounded w-1/4" />
            <div className="h-4 bg-gray-200 rounded w-1/6" />
          </div>
        ))}
      </div>
    </div>
  );
};
