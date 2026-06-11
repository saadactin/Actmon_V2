import React from 'react';

export const DBTypeBadge = ({ type }) => {
  const getColors = (dbType) => {
    switch (dbType?.toLowerCase()) {
      case 'oracle':
        return {
          bg: 'bg-red-50',
          text: 'text-red-700',
          border: 'border-red-200',
          label: 'Oracle',
        };
      case 'postgresql':
        return {
          bg: 'bg-blue-50',
          text: 'text-blue-700',
          border: 'border-blue-200',
          label: 'PostgreSQL',
        };
      case 'mysql':
        return {
          bg: 'bg-amber-50',
          text: 'text-amber-700',
          border: 'border-amber-200',
          label: 'MySQL',
        };
      case 'mssql':
      case 'sqlserver':
        return {
          bg: 'bg-purple-50',
          text: 'text-purple-700',
          border: 'border-purple-200',
          label: 'MSSQL',
        };
      case 'mongodb':
        return {
          bg: 'bg-emerald-50',
          text: 'text-emerald-700',
          border: 'border-emerald-200',
          label: 'MongoDB',
        };
      case 'clickhouse':
        return {
          bg: 'bg-orange-50',
          text: 'text-orange-700',
          border: 'border-orange-200',
          label: 'ClickHouse',
        };
      default:
        return {
          bg: 'bg-gray-50',
          text: 'text-gray-700',
          border: 'border-gray-200',
          label: dbType,
        };
    }
  };

  const colors = getColors(type);

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium border ${colors.bg} ${colors.text} ${colors.border}`}
    >
      {colors.label}
    </span>
  );
};
