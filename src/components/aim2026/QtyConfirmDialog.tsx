import { useState, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';

interface QtyConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sku: string;
  product: string;
  suggestedQty: number;
  onConfirm: (qty: number) => void;
}

export function QtyConfirmDialog({
  open,
  onOpenChange,
  sku,
  product,
  suggestedQty,
  onConfirm,
}: QtyConfirmDialogProps) {
  const [qty, setQty] = useState(suggestedQty);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQty(suggestedQty);
      // Auto-select input when dialog opens
      setTimeout(() => inputRef.current?.select(), 100);
    }
  }, [open, suggestedQty]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (qty > 0) {
      onConfirm(qty);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-0 overflow-hidden">
        <div className="px-5 pt-5 pb-3">
          <DialogHeader>
            <DialogTitle className="text-base">Add to Purchase Order</DialogTitle>
            <DialogDescription className="text-xs mt-1">
              <span className="font-mono text-blue-600 dark:text-blue-400 font-medium">{sku}</span>
              {' — '}
              <span className="text-muted-foreground">{product}</span>
            </DialogDescription>
          </DialogHeader>
        </div>

        <form onSubmit={handleSubmit} className="px-5 pb-5 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1.5">
              Order Quantity
            </label>
            <input
              ref={inputRef}
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(parseInt(e.target.value) || 0)}
              className="w-full h-11 text-lg font-semibold tabular-nums text-center bg-muted/30 border border-border rounded-lg px-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              autoFocus
            />
            {qty !== suggestedQty && (
              <button
                type="button"
                onClick={() => setQty(suggestedQty)}
                className="text-[10px] text-blue-500 hover:text-blue-700 mt-1 transition-colors"
              >
                Reset to suggested: {suggestedQty.toLocaleString()}
              </button>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1 h-9 text-xs"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="flex-1 h-9 text-xs gap-1.5"
              disabled={qty <= 0}
            >
              <Plus size={14} />
              Add to PO
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
