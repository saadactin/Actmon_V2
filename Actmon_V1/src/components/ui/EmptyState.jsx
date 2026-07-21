import React from 'react';
import { Button } from '@fluentui/react-components';
import { Database } from 'lucide-react';

export const EmptyState = ({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  actionIcon,
}) => {
  return (
    <div className="flex flex-col items-center justify-center p-8 md:p-12 text-center bg-white border border-dashed border-brand-border rounded-card min-h-[320px] w-full">
      <div className="text-gray-400 p-4 bg-[#F3F2F1] rounded-full mb-4 flex items-center justify-center">
        {icon || <Database className="h-10 w-10 text-gray-500" />}
      </div>
      <h3 className="text-base font-bold text-brand-text-primary mb-1">{title}</h3>
      <p className="text-sm text-brand-text-secondary max-w-md mb-6">{description}</p>
      {actionLabel && onAction && (
        <Button appearance="primary" icon={actionIcon} onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
};
