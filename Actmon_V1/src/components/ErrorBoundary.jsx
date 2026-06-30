import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * Catches render-time errors in the routed page tree so a single page crash
 * shows a recoverable message instead of white-screening the whole app
 * (sidebar/topbar stay intact). Reset on navigation via the `resetKey` prop.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[ActMon] Page render error:', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    // Clear the error when the route changes so navigating away recovers.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-full flex items-center justify-center p-8 bg-[#f1f5f9]">
        <div className="max-w-lg w-full bg-white rounded-2xl border border-red-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 bg-red-50 border-b border-red-100 flex items-center gap-3">
            <AlertTriangle className="text-red-500" size={20} />
            <h2 className="font-black text-red-700 text-sm">This page hit an error</h2>
          </div>
          <div className="p-6 space-y-4">
            <p className="text-sm text-slate-600">
              Something went wrong while rendering this page. The rest of the app is still
              usable — you can go back or reload.
            </p>
            <pre className="text-[11px] font-mono bg-slate-50 border border-slate-200 rounded-lg p-3 text-red-600 overflow-x-auto whitespace-pre-wrap break-words max-h-40">
              {String(error?.message || error)}
            </pre>
            <div className="flex gap-2">
              <button onClick={() => window.location.reload()}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700">
                <RefreshCw size={14} /> Reload
              </button>
              <button onClick={() => window.history.back()}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-slate-100 text-slate-600 text-sm font-bold hover:bg-slate-200">
                Go back
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
