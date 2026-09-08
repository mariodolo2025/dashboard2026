import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { Info, X } from 'lucide-react';

/** One help surface for hover, keyboard focus and a persistent touch/click. */
export function DoloHelp({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const cancelClose = () => { if (timer.current) clearTimeout(timer.current); };
  const enter = () => { cancelClose(); setOpen(true); };
  const leave = () => { cancelClose(); if (!pinned) timer.current = setTimeout(() => setOpen(false), 160); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setPinned(false); }}>
      <span className="dolo-help-region" data-dolo-help onMouseEnter={enter} onMouseLeave={leave}>
        <span>{label}</span>
        <Popover.Trigger asChild>
          <button
            type="button" className="dolo-help-button" aria-label={`About ${label}`}
            onFocus={enter} onBlur={leave}
            onClick={(event) => { event.preventDefault(); cancelClose(); setPinned(!pinned); setOpen(!pinned); }}
            onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); setPinned(false); } }}
          ><Info size={15} aria-hidden="true" /></button>
        </Popover.Trigger>
      </span>
      <Popover.Portal>
        <Popover.Content
          className="dolo-help-content" data-dolo-layer="help" sideOffset={8} collisionPadding={16}
          onMouseEnter={cancelClose} onMouseLeave={leave}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(false); setPinned(false); }}
          onKeyDownCapture={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); setPinned(false); } }}
        >{children}<Popover.Arrow className="dolo-help-arrow" /></Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function DoloDrawer({ open, title, description, onClose, children, canDismiss = true }: {
  open: boolean; title: string; description: string; onClose: () => void; children: ReactNode; canDismiss?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && canDismiss) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dolo-drawer-overlay" />
        <Dialog.Content
          className="dolo-drawer" data-dolo-layer="drawer"
          onEscapeKeyDown={(event) => {
            // Radix layers can share document-level Escape listeners. A help
            // bubble must consume the key without also dismissing its drawer.
            if (event.defaultPrevented || document.querySelector('[data-dolo-layer="help"]')) { event.preventDefault(); return; }
            event.preventDefault(); event.stopPropagation(); if (canDismiss) onClose();
          }}
          onPointerDownOutside={(event) => { if (!canDismiss) event.preventDefault(); }}
        >
          <div className="dolo-drawer-heading">
            <div><p className="dolo-eyebrow">Snapshot details</p><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div>
            <Dialog.Close className="dolo-icon-button" aria-label="Close details" disabled={!canDismiss}><X size={21} /></Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function DoloConfirm({ open, title, description, confirmLabel, busy, onConfirm, onClose, children }: {
  open: boolean; title: string; description: string; confirmLabel: string; busy: boolean;
  onConfirm: () => void; onClose: () => void; children?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dolo-drawer-overlay" />
        <Dialog.Content className="dolo-confirm" data-dolo-layer="confirm" onEscapeKeyDown={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}>
          <Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description>
          {children}
          <div className="dolo-form-actions"><button className="dolo-button" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="dolo-button dolo-button-primary" type="button" onClick={onConfirm} disabled={busy}>{busy ? 'Saving…' : confirmLabel}</button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
