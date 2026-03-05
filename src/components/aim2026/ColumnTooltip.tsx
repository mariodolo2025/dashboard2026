import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Info, X } from 'lucide-react';
import { KPI_DESCRIPTIONS } from '@/lib/aim2026/types';

interface ColumnTooltipProps {
  kpiKey: string;
  children: React.ReactNode;
}

export function ColumnTooltip({ kpiKey, children }: ColumnTooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const iconRef = useRef<HTMLSpanElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const desc = KPI_DESCRIPTIONS[kpiKey];

  if (!desc) return <>{children}</>;

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        popupRef.current &&
        !popupRef.current.contains(e.target as Node) &&
        iconRef.current &&
        !iconRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!open && iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect();
      setCoords({ x: rect.left + rect.width / 2, y: rect.bottom + 8 });
    }
    setOpen((v) => !v);
  };

  return (
    <span className="inline-flex items-center gap-1">
      {children}
      <span
        ref={iconRef}
        className="flex-shrink-0 cursor-pointer"
        onClick={handleClick}
      >
        <Info
          size={14}
          className={`transition-colors ${
            open
              ? 'text-blue-500'
              : 'text-muted-foreground/50 hover:text-blue-500'
          }`}
        />
      </span>

      {open &&
        createPortal(
          <div
            ref={popupRef}
            style={{
              position: 'fixed',
              top: coords.y,
              left: coords.x,
              transform: 'translateX(-50%)',
              zIndex: 99999,
            }}
          >
            {/* Arrow pointing up */}
            <div className="flex justify-center -mb-[5px] relative z-10">
              <div className="w-2.5 h-2.5 rotate-45 bg-slate-900 border-l border-t border-slate-700" />
            </div>
            {/* Content */}
            <div className="bg-slate-900 text-white rounded-lg shadow-2xl border border-slate-700 px-4 py-3 w-72">
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <p className="text-sm font-semibold text-blue-300">{desc.title}</p>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                  }}
                  className="text-slate-500 hover:text-white transition-colors -mt-0.5 -mr-1"
                >
                  <X size={14} />
                </button>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">{desc.description}</p>
            </div>
          </div>,
          document.body
        )}
    </span>
  );
}
