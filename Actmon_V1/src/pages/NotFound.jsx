import React from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@fluentui/react-components';
import { AlertCircle, ArrowLeft } from 'lucide-react';

export const NotFound = () => {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center text-center p-6 bg-brand-bg">
      <div className="bg-red-50 p-4 rounded-full mb-6">
        <AlertCircle className="h-16 w-16 text-red-600 animate-bounce" />
      </div>
      <h1 className="text-4xl font-bold text-brand-text-primary tracking-tight mb-2">404 - Page Not Found</h1>
      <p className="text-sm text-brand-text-secondary max-w-md mb-8 leading-relaxed">
        The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.
      </p>
      <Link to="/dashboard">
        <Button icon={<ArrowLeft className="h-4 w-4" />} appearance="primary">
          Back to Dashboard
        </Button>
      </Link>
    </div>
  );
};
