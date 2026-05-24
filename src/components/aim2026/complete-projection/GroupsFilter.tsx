// =============================================================================
// AIM 2026 — Complete Projection: Groups (Brand) multi-select filter
//
// The dropdown panel is portaled to document.body so the surrounding modal's
// `overflow-hidden` parents can't clip it (which would hide the scrollbar and
// make the list look "unscrollable"). Position is computed from the trigger's
// getBoundingClientRect and re-measured on scroll/resize.
// =============================================================================

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface GroupsFilterProps {
  groups: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}

export function GroupsFilter({ groups, selected, onChange }: GroupsFilterProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  // Measure trigger position so the portal panel sits flush with the button.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  // Click-outside: include the portaled panel as part of "inside".
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const active = selected.size > 0;
  const label =
    selected.size === 0
      ? 'All Groups'
      : selected.size === 1
        ? [...selected][0]
        : `${selected.size} groups`;

  const toggle = (g: string) => {
    const next = new Set(selected);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    onChange(next);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors',
          active
            ? 'border-[#7c3aed] bg-[#ede9fe]/60 text-[#4c1d95] hover:bg-[#ede9fe]'
            : 'border-[#e8e8e3] bg-white text-[#2a2f38] hover:bg-[#faf9f7]',
        )}
      >
        {label}
        <ChevronDown size={14} className={active ? 'text-[#7c3aed]' : 'text-[#828a98]'} />
      </button>

      {open && pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
            className="pointer-events-auto z-[60] flex max-h-[50vh] w-60 flex-col overflow-hidden rounded-md border border-[#e8e8e3] bg-white shadow-lg"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-[#e8e8e3] px-3 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[#5b6270]">
                Groups
              </span>
              {active && (
                <button
                  type="button"
                  onClick={() => onChange(new Set())}
                  className="text-xs font-medium text-[#7c3aed] hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
              {groups.length === 0 && (
                <div className="px-3 py-2 text-sm text-[#828a98]">No groups</div>
              )}
              {groups.map((g) => {
                const checked = selected.has(g);
                return (
                  <button
                    key={g}
                    type="button"
                    onClick={() => toggle(g)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[#2a2f38] hover:bg-[#faf9f7]"
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                        checked ? 'border-[#7c3aed] bg-[#7c3aed] text-white' : 'border-[#d8d8d2] bg-white',
                      )}
                    >
                      {checked && <Check size={11} strokeWidth={3} />}
                    </span>
                    <span className="truncate">{g}</span>
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
