// =============================================================================
// AIM 2026 — Full-screen overlay wrapper for the dashboard
//
// Replaces a previous Radix <Dialog> wrapper. Radix Dialog modal=true applies
// body{pointer-events:none} + FocusScope + RemoveScroll globally — these break
// any sub-modal portaled to document.body from inside the dashboard (Complete
// Projection, POBuilder, etc.) because they fall outside its scope. modal=false
// was an alternative but left click-outside-closes and other artifacts.
//
// This overlay: portal to body, fixed inset-0 full-screen, dark backdrop,
// closes only with the X button or Escape. No global Radix effects.
// =============================================================================

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import AIM2026Dashboard from './AIM2026Dashboard';

interface DateRange {
  from?: Date;
  to?: Date;
}

interface AIM2026OverlayProps {
  open: boolean;
  onClose: () => void;
  dateRange?: DateRange;
  setDateRange?: (r: DateRange) => void;
}

export function AIM2026Overlay({ open, onClose, dateRange, setDateRange }: AIM2026OverlayProps) {
  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Lock body scroll while open (so the page behind doesn't move when wheel
  // events bleed past sub-modals). Clean up on unmount/close.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="AIM 2026"
      className="pointer-events-auto fixed inset-0 z-[50] flex h-screen w-screen flex-col overflow-hidden bg-[#f7f7f5]"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#e8e8e3] bg-white px-5 py-3">
        <h2 className="text-base font-bold text-[#0f1115]">AIM 2026</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-[#828a98] hover:bg-[#faf9f7] hover:text-[#2a2f38]"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      {/* Body — full-height scroll container so the dashboard can scroll on its own */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-4">
          <AIM2026Dashboard dateRange={dateRange} setDateRange={setDateRange} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
