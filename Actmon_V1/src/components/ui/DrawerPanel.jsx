import React, { useEffect } from 'react';
import { X } from 'lucide-react';

export const DrawerPanel = ({
  open,
  onClose,
  title,
  children,
}) => {
  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop overlay */}
      <div
        className="fixed inset-0 bg-black/40 z-40 transition-opacity animate-in fade-in duration-200"
        onClick={onClose}
      />
      {/* Drawer Container */}
      <div
        className="fixed top-0 right-0 bottom-0 w-[480px] max-w-full bg-white shadow-2xl z-50 flex flex-col border-l border-brand-border animate-in slide-in-from-right duration-300"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-brand-border bg-[#FAF9F8]">
          <h3 className="text-base font-semibold text-brand-text-primary">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 text-brand-text-secondary hover:text-brand-text-primary hover:bg-gray-100 rounded-md transition-all focus:outline-none"
            aria-label="Close panel"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        
        {/* Content (Scrollable) */}
        <div className="flex-grow overflow-y-auto p-6">
          {children}
        </div>
      </div>
    </>
  );
};
