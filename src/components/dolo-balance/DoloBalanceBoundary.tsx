import { Component, type ReactNode } from 'react';

interface DoloBalanceBoundaryProps {
  children: ReactNode;
  onLeaveBalance: () => void;
}

/** Keep a failed Balance render or lazy download inside this report only. */
export class DoloBalanceBoundary extends Component<DoloBalanceBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h3 className="text-lg font-semibold">DOLO Balance is temporarily unavailable</h3>
        <p className="max-w-md text-sm text-muted-foreground">
          This report could not be displayed. You can still use the other reports or close Reports.
        </p>
        <button
          type="button"
          onClick={this.props.onLeaveBalance}
          className="rounded-md border border-[#e8e8e3] bg-white px-3 py-2 text-sm font-medium hover:bg-[#faf9f7]"
        >
          Back to FY Report
        </button>
      </div>
    );
  }
}
