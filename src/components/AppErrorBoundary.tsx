import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isStaleChunkError, reloadOnceForNewBuild } from '@/lib/staleBuild';

// Last line of defence for the whole app. Before this, any error while
// rendering — including a tab whose file vanished in a deploy — unmounted
// everything and left a blank page with no clue (Mario, 2026-09-30). Now a
// stale file triggers one reload, and anything else says what broke and offers
// a reload, with the technical message available for a screenshot.

interface State { error: Error | null; }

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('App crashed:', error, info.componentStack);
    if (isStaleChunkError(error)) reloadOnceForNewBuild();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = isStaleChunkError(error);
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
          <h1 className="text-base font-semibold text-foreground">
            {stale ? 'The dashboard was updated while this tab was open' : 'Something went wrong on this screen'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {stale
              ? 'Reload to open the new version. Nothing you saved is lost.'
              : 'Reload to try again. If it keeps happening, send a screenshot of this message.'}
          </p>
          <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs text-muted-foreground">
            {error.message || String(error)}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

export default AppErrorBoundary;
