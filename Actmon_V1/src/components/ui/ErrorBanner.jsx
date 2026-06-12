import React from 'react';

import { AlertCircle } from 'lucide-react';

export const ErrorBanner = ({
  message = 'An unexpected error occurred. Please try again or contact your administrator.',
  title = 'System Warning',
  onRetry,
  className = '',
}) => {
  return (
    <div className={`p-4 rounded-lg bg-red-50 border border-red-200 flex gap-3 text-red-800 ${className}`}>
      <div className="flex-shrink-0">
        <AlertCircle className="w-5 h-5 text-red-600 mt-0.5" />
      </div>
      <div className="flex-grow">
        {title && <h4 className="font-semibold text-sm leading-5">{title}</h4>}
        <p className="text-sm mt-1 text-red-700 leading-normal">{message}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-3 text-sm font-semibold text-red-800 underline hover:text-red-950 transition-colors"
          >
            Retry operation
          </button>
        )}
      </div>
    </div>
  );
};
