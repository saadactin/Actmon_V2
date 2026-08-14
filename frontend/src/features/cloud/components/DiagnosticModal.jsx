import {
  X, KeyRound, ShieldAlert, WifiOff, Info, AlertTriangle, Loader2, HelpCircle, CheckCircle2,
} from 'lucide-react';

const CATEGORY_META = {
  credentials: { label: 'Credentials Issue', Icon: KeyRound, tone: 'bg-danger-soft text-danger-fg' },
  permission: { label: 'Permission Denied', Icon: ShieldAlert, tone: 'bg-warning-soft text-warning-fg' },
  network: { label: 'Network Error', Icon: WifiOff, tone: 'bg-info-soft text-info-fg' },
  no_data: { label: 'No Data From Provider', Icon: Info, tone: 'bg-neutral-soft text-muted' },
  unknown: { label: 'Unknown Error', Icon: AlertTriangle, tone: 'bg-warning-soft text-warning-fg' },
  never_scanned: { label: 'Never Scanned', Icon: Info, tone: 'bg-neutral-soft text-muted' },
  scanning: { label: 'Scan In Progress', Icon: Loader2, tone: 'bg-info-soft text-info-fg' },
  failed: { label: 'Scan Failed', Icon: AlertTriangle, tone: 'bg-danger-soft text-danger-fg' },
  ok: { label: 'Scan Succeeded', Icon: CheckCircle2, tone: 'bg-success-soft text-success-fg' },
  unsupported: { label: 'Not Supported Yet', Icon: Info, tone: 'bg-accent-soft text-accent-text' },
};

const SUGGESTED_FIX = {
  credentials: 'Delete this account and re-add it with fresh, valid credentials.',
  permission: "Ask whoever manages this cloud account to grant the missing permission (see the raw error below for the exact action/role needed), then click Refresh.",
  network: 'This is usually transient — wait a moment and click Refresh. If it persists, check that the service hosting this backend has outbound internet access.',
  no_data: 'This is expected for some account types (e.g. sponsored/credit subscriptions) — the provider itself does not expose billing data for them via API.',
  unknown: 'Check the backend service logs for the full error. If it keeps happening, this may need a code fix.',
  never_scanned: 'Click "Scan All Accounts" or "Refresh" to run discovery for this account.',
  scanning: 'Wait for the current scan to finish, then refresh this page.',
  failed: 'See the error detail below for what the scanner hit. Fix the underlying cause (usually credentials or permissions), then re-run the scan.',
  unsupported: 'Nothing to fix on your side — this resource type has no metrics mapping in the product yet.',
};

export const DiagnosticModal = ({ title, items, onClose }) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    onClick={onClose}
  >
    <div
      className="bg-surface rounded-card shadow-2xl w-full max-w-xl max-h-[85vh] overflow-hidden flex flex-col"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-3 px-card py-3.5 border-b border-border">
        <h3 className="text-base font-bold text-fg flex items-center gap-2">
          <HelpCircle size={18} className="text-accent" />
          {title}
        </h3>
        <button
          onClick={onClose}
          className="p-1.5 rounded-control text-subtle hover:text-fg hover:bg-sunken transition-colors"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      <div className="overflow-y-auto px-card py-card space-y-4">
        {items.length === 0 ? (
          <p className="text-sm text-muted">No diagnostic information is available.</p>
        ) : (
          items.map((item, i) => {
            const meta = CATEGORY_META[item.category] || CATEGORY_META.unknown;
            const fix = SUGGESTED_FIX[item.category];
            return (
              <div key={i} className="border border-border rounded-card overflow-hidden">
                <div className={`flex items-center gap-2 px-4 py-2.5 ${meta.tone}`}>
                  <meta.Icon size={15} className={item.category === 'scanning' ? 'animate-spin' : ''} />
                  <span className="text-xs font-bold uppercase tracking-wide">{meta.label}</span>
                  <span className="text-xs font-semibold ml-auto">{item.scope}{item.provider ? ` · ${item.provider}` : ''}</span>
                </div>
                <div className="p-4 space-y-3">
                  <p className="text-sm text-fg leading-relaxed">{item.message}</p>
                  {fix && (
                    <div className="bg-info-soft rounded-control p-3">
                      <div className="text-[11px] font-bold text-info-fg uppercase tracking-wider mb-1">
                        What to do
                      </div>
                      <p className="text-xs text-fg">{fix}</p>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="px-card py-3 border-t border-border bg-raised flex justify-end">
        <button
          onClick={onClose}
          className="px-4 py-2 text-xs font-semibold text-muted bg-surface border border-border rounded-control hover:bg-sunken"
        >
          Close
        </button>
      </div>
    </div>
  </div>
);
