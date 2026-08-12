import { Component } from 'react';
import Icon from '@/components/ui/Icon';

/**
 * Catches render errors so one broken page can't blank the whole shell.
 * `resetKey` (the pathname) clears the error on navigation.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error, info) {
    // Keep the stack in the console — this is the only place it survives.
    console.error('[ActMon] render error:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="card mx-auto max-w-xl p-card text-center">
        <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-full bg-danger-soft text-danger-fg">
          <Icon name="alert" size={22} />
        </div>
        <h2 className="text-base font-bold text-fg">This page hit an error</h2>
        <p className="mt-1 text-[13px] text-muted">
          {error.message || 'Something went wrong while rendering.'}
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="h-control rounded-control bg-accent px-4 text-[13px] font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-control rounded-control border border-border px-4 text-[13px] font-semibold text-fg transition-colors hover:bg-sunken"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
