import {
  X, KeyRound, ShieldAlert, WifiOff, Info, AlertTriangle, Loader2, HelpCircle, CheckCircle2,
} from 'lucide-react';

const CATEGORY_META = {
  credentials: { label: 'Credentials Issue', Icon: KeyRound, tone: 'bg-red-50 text-red-700 border-red-200' },
  permission: { label: 'Permission Denied', Icon: ShieldAlert, tone: 'bg-orange-50 text-orange-700 border-orange-200' },
  network: { label: 'Network Error', Icon: WifiOff, tone: 'bg-blue-50 text-blue-700 border-blue-200' },
  no_data: { label: 'No Data From Provider', Icon: Info, tone: 'bg-gray-100 text-gray-600 border-gray-200' },
  unknown: { label: 'Unknown Error', Icon: AlertTriangle, tone: 'bg-amber-50 text-amber-700 border-amber-200' },
  never_scanned: { label: 'Never Scanned', Icon: Info, tone: 'bg-gray-100 text-gray-600 border-gray-200' },
  scanning: { label: 'Scan In Progress', Icon: Loader2, tone: 'bg-blue-50 text-blue-700 border-blue-200' },
  failed: { label: 'Scan Failed', Icon: AlertTriangle, tone: 'bg-red-50 text-red-700 border-red-200' },
  ok: { label: 'Scan Succeeded', Icon: CheckCircle2, tone: 'bg-green-50 text-green-700 border-green-200' },
  unsupported: { label: 'Not Supported Yet', Icon: Info, tone: 'bg-purple-50 text-purple-700 border-purple-200' },
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
      className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[85vh] overflow-hidden flex flex-col"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-gray-100">
        <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
          <HelpCircle size={18} className="text-blue-600" />
          {title}
        </h3>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      <div className="overflow-y-auto p-5 space-y-4">
        {items.length === 0 ? (
          <p className="text-sm text-gray-500">No diagnostic information is available.</p>
        ) : (
          items.map((item, i) => {
            const meta = CATEGORY_META[item.category] || CATEGORY_META.unknown;
            const fix = SUGGESTED_FIX[item.category];
            return (
              <div key={i} className="border border-gray-200 rounded-xl overflow-hidden">
                <div className={`flex items-center gap-2 px-4 py-2.5 border-b ${meta.tone}`}>
                  <meta.Icon size={15} className={item.category === 'scanning' ? 'animate-spin' : ''} />
                  <span className="text-xs font-bold uppercase tracking-wide">{meta.label}</span>
                  <span className="text-xs font-semibold ml-auto">{item.scope}{item.provider ? ` · ${item.provider}` : ''}</span>
                </div>
                <div className="p-4 space-y-3">
                  <p className="text-sm text-gray-700 leading-relaxed">{item.message}</p>
                  {fix && (
                    <div className="bg-blue-50/60 border border-blue-100 rounded-lg p-3">
                      <div className="text-[11px] font-bold text-blue-700 uppercase tracking-wider mb-1">
                        What to do
                      </div>
                      <p className="text-xs text-gray-700">{fix}</p>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="px-5 py-3 border-t border-gray-100 bg-gray-50 flex justify-end">
        <button
          onClick={onClose}
          className="px-4 py-2 text-xs font-semibold text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-100"
        >
          Close
        </button>
      </div>
    </div>
  </div>
);
