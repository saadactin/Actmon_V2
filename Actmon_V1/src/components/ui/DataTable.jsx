import React, { useState, useMemo } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';

export function DataTable({
  columns,
  data,
  emptyState,
  onRowClick,
  rowKeyField,
}) {
  const [sortKey, setSortKey] = useState(null);
  const [sortOrder, setSortOrder] = useState('asc');

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortOrder('asc');
    }
  };

  const sortedData = useMemo(() => {
    if (!sortKey) return data;

    return [...data].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];

      if (aVal === undefined || aVal === null) return 1;
      if (bVal === undefined || bVal === null) return -1;

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortOrder === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }

      return sortOrder === 'asc'
        ? (aVal > bVal ? 1 : -1)
        : (bVal > aVal ? 1 : -1);
    });
  }, [data, sortKey, sortOrder]);

  return (
    <div className="w-full overflow-hidden border border-brand-border bg-white rounded-card shadow-card">
      <div className="overflow-x-auto max-h-[600px] scrollbar-thin">
        <table className="min-w-full divide-y divide-brand-border text-left border-collapse">
          <thead className="bg-[#FAF9F8] sticky top-0 z-10 shadow-[0_1px_0_0_rgba(237,235,233,1)]">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-6 py-4 text-xs font-semibold text-brand-text-secondary uppercase tracking-wider ${
                    col.sortable ? 'cursor-pointer select-none hover:text-brand-primary' : ''
                  } ${col.headerClassName || ''}`}
                  onClick={() => col.sortable && handleSort(col.key)}
                >
                  <div className="flex items-center gap-1">
                    <span>{col.label}</span>
                    {col.sortable && (
                      <span className="text-gray-400">
                        {sortKey === col.key ? (
                          sortOrder === 'asc' ? (
                            <ArrowUp className="h-3 w-3 text-brand-primary" />
                          ) : (
                            <ArrowDown className="h-3 w-3 text-brand-primary" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3" />
                        )}
                      </span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-brand-border bg-white">
            {sortedData.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-6 py-12">
                  {emptyState || (
                    <div className="text-center text-brand-text-secondary text-sm">
                      No records found.
                    </div>
                  )}
                </td>
              </tr>
            ) : (
              sortedData.map((row, idx) => {
                const key = rowKeyField ? String(row[rowKeyField]) : idx;
                return (
                  <tr
                    key={key}
                    onClick={() => onRowClick && onRowClick(row)}
                    className={`transition-colors ${
                      onRowClick ? 'cursor-pointer hover:bg-brand-primary-light/10' : 'hover:bg-gray-55/30'
                    }`}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={`px-6 py-3.5 text-sm text-brand-text-primary ${col.cellClassName || ''}`}
                      >
                        {col.render ? col.render(row) : row[col.key]}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
