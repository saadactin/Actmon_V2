import {
  X, KeyRound, ShieldAlert, WifiOff, Info, AlertTriangle, Loader2, HelpCircle,
  CheckCircle2, Clock, CloudOff,
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
  unsupported: { label: 'Not Supported', Icon: Info, tone: 'bg-accent-soft text-accent-text' },

  // Categories the cost error classifier emits. Without these the modal fell
  // back to `unknown`, so a throttled Azure subscription — correctly classified
  // as rate_limited by the backend — still rendered as "Unknown Error" with
  // advice to check the logs, when the true answer was "wait 32 seconds".
  rate_limited: { label: 'Rate Limited', Icon: Clock, tone: 'bg-warning-soft text-warning-fg' },
  timeout: { label: 'Timed Out', Icon: Clock, tone: 'bg-warning-soft text-warning-fg' },
  provider_unavailable: { label: 'Provider Unavailable', Icon: CloudOff, tone: 'bg-info-soft text-info-fg' },
  invalid_request: { label: 'Invalid Query', Icon: AlertTriangle, tone: 'bg-danger-soft text-danger-fg' },
  partial: { label: 'Partial Data', Icon: AlertTriangle, tone: 'bg-warning-soft text-warning-fg' },
  // AWS is read only during a refresh, because it bills per query. Nothing is
  // wrong; the account simply has nothing saved yet.
  awaiting_refresh: { label: 'Waiting For Refresh', Icon: Clock, tone: 'bg-info-soft text-info-fg' },
};

const SUGGESTED_FIX = {
  credentials: 'Delete this account and re-add it with fresh, valid credentials.',
  permission: "Ask whoever manages this cloud account to grant the missing permission (see the raw error below for the exact action/role needed), then click Refresh.",
  network: 'This is usually transient — wait a moment and click Refresh. If it persists, check that the service hosting this backend has outbound internet access.',
  no_data: 'This is expected for some account types (e.g. sponsored/credit subscriptions) — the provider itself does not expose billing data for them via API.',
  unknown: 'Check the backend service logs for the full error. If it keeps happening, this may need a code fix.',
  never_scanned: 'Use Refresh all, at the top of the account page, to read this account from the provider.',
  scanning: 'Wait for the current scan to finish — every tab re-reads on its own when it does.',
  failed: 'See the error detail below for what the scanner hit. Fix the underlying cause (usually credentials or permissions), then re-run the scan.',
  unsupported: 'Nothing is broken and nothing to fix — this billing integration cannot produce this value at all. The reason above says what would be required to change that.',
  rate_limited: 'Nothing to fix — the provider is throttling billing queries and this clears on its own. The next refresh retries automatically; the last good figures stay on screen in the meantime.',
  timeout: 'The provider did not respond in time. Large windows (180–365 days) are the usual cause; the refresh continues in the background, so reload in a moment.',
  provider_unavailable: 'This is a server-side error on the provider, not a problem with your account or credentials. It is usually transient.',
  invalid_request: 'This is a defect in the query this product sent, not a problem with your account. It needs a code fix — please report it with the raw error below.',
  partial: 'Some sub-queries succeeded and others did not, so the totals shown are incomplete. They are labelled PARTIAL rather than presented as final.',
  awaiting_refresh: 'Nothing is broken. AWS charges for every billing and metrics query, so ActMon reads AWS only when the account is refreshed. Click Refresh on this account, or wait for its scheduled refresh.',
};

export const DiagnosticModal = ({ title, items, onClose }) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
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

                  {/* The facts that make a diagnostic actionable rather than
                      merely descriptive: how long to wait, and the exact
                      permission string to paste into an IAM policy. */}
                  {(item.http_status || item.retry_after_seconds != null
                    || item.required_permission) && (
                    <dl className="grid grid-cols-1 gap-1.5 rounded-control border border-border bg-sunken p-3 text-xs sm:grid-cols-2">
                      {item.http_status && (
                        <div className="flex gap-2">
                          <dt className="font-semibold text-muted">HTTP</dt>
                          <dd className="font-mono text-fg">{item.http_status}</dd>
                        </div>
                      )}
                      {item.retry_after_seconds != null && (
                        <div className="flex gap-2">
                          <dt className="font-semibold text-muted">Retry after</dt>
                          <dd className="text-fg">{item.retry_after_seconds}s</dd>
                        </div>
                      )}
                      {item.required_permission && (
                        <div className="flex flex-col gap-1 sm:col-span-2">
                          <dt className="font-semibold text-muted">Permission required</dt>
                          <dd className="break-all rounded bg-surface px-2 py-1 font-mono text-meta text-fg">
                            {item.required_permission}
                          </dd>
                        </div>
                      )}
                    </dl>
                  )}

                  {fix && (
                    <div className="bg-info-soft rounded-control p-3">
                      <div className="text-meta font-bold text-info-fg uppercase tracking-wider mb-1">
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
