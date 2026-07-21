import React from 'react';
import {
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
} from '@fluentui/react-components';

export const ConfirmDialog = ({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  isDanger = false,
}) => {
  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <p className="text-sm text-brand-text-secondary leading-relaxed mt-2">
            {message}
          </p>
        </DialogContent>
        <DialogActions>
          <Button appearance="secondary" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            appearance={isDanger ? 'primary' : 'outline'}
            style={isDanger ? { backgroundColor: 'var(--color-error)', color: '#white', borderColor: 'transparent' } : undefined}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogActions>
      </DialogSurface>
    </Dialog>
  );
};
