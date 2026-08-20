// =============================================================================
// The workbook constants — editable, so the thresholds stop looking hardcoded
// =============================================================================
// Mario, 2026-08-18: "de donde sale ese target mer de 2.77? porque parece estar
// hardcodeado". It never was — breakeven and target are derived in the RPC. But
// the table behind them held one row that only a migration could write, so the
// number could never move. This is the missing half.
//
// Six fields, one per cell of Juan's monthly workbook. The two MER thresholds
// are NOT entered: they are derived, here for preview and in the RPC for real,
// from the same formula. Typing a threshold directly would let it drift from
// the economics it is supposed to represent.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import type { UnitEconomics } from '@/components/advertising/types';

type Fields = {
  month: string;
  cm1Pct: string;
  fixedCostsUsd: string;
  revenuePerOrderUsd: string;
  pctNewCustomers: string;
  targetMarginPct: string;
  baselineRevenueUsd: string;
};

/** Seeded from the month on screen: a new month usually starts from the last
 *  one and changes two or three numbers, not six. */
const seed = (ue: UnitEconomics | null): Fields => ({
  month: new Date().toISOString().slice(0, 7),
  cm1Pct: ue ? String(Math.round(ue.cm1Pct * 1000) / 10) : '',
  fixedCostsUsd: ue ? String(Math.round(ue.fixedCostsUsd)) : '',
  revenuePerOrderUsd: ue ? String(ue.revenuePerOrderUsd) : '',
  pctNewCustomers: ue ? String(Math.round(ue.pctNewCustomers * 1000) / 10) : '',
  targetMarginPct: ue ? String(Math.round(ue.targetMarginPct * 1000) / 10) : '',
  baselineRevenueUsd: ue ? String(Math.round(ue.baselineRevenueUsd)) : '',
});

const ERRORS: Record<string, string> = {
  AUTH_REQUIRED: 'Your session expired — reload the page.',
  CM1_INVALID: 'Contribution margin must be between 0 and 100%.',
  TARGET_MARGIN_INVALID: 'Target margin must be between 0 and 100%.',
  FIXED_COSTS_INVALID: 'Fixed costs cannot be negative.',
  REVENUE_PER_ORDER_INVALID: 'Revenue per order must be above zero.',
  PCT_NEW_INVALID: 'New-customer share must be between 0 and 100%.',
  BASELINE_REVENUE_INVALID: 'Baseline revenue must be above zero.',
  TARGET_UNREACHABLE:
    'With these numbers no amount of sales reaches the target: fixed costs plus the target margin '
    + 'exceed the contribution margin. Check the three of them.',
};

export default function UnitEconomicsForm({ ue, onSaved }: {
  ue: UnitEconomics | null;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Fields>(() => seed(ue));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const n = (s: string) => {
    const v = parseFloat(s.replace(/,/g, '').trim());
    return Number.isFinite(v) ? v : null;
  };
  const cm1 = n(f.cm1Pct);
  const tgt = n(f.targetMarginPct);
  const fix = n(f.fixedCostsUsd);
  const base = n(f.baselineRevenueUsd);

  // Live preview of exactly what the RPC will derive — so the effect of a
  // change is visible before it is committed for everyone.
  const den = cm1 !== null && tgt !== null && fix !== null && base !== null && base > 0
    ? cm1 / 100 - tgt / 100 - fix / base
    : null;
  const preview = cm1 !== null && cm1 > 0
    ? {
      breakeven: 1 / (cm1 / 100),
      target: den !== null && den > 0 ? 1 / den : null,
    }
    : null;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.rpc('advertising_unit_economics_save', {
      p_month: `${f.month}-01`,
      p_cm1_pct: (n(f.cm1Pct) ?? 0) / 100,
      p_fixed_costs_usd: n(f.fixedCostsUsd),
      p_revenue_per_order_usd: n(f.revenuePerOrderUsd),
      p_pct_new_customers: (n(f.pctNewCustomers) ?? 0) / 100,
      p_target_margin_pct: (n(f.targetMarginPct) ?? 0) / 100,
      p_baseline_revenue_usd: n(f.baselineRevenueUsd),
      p_source: `Juan's unit-economics workbook, ${f.month}`,
    });
    setBusy(false);
    if (error) {
      const key = Object.keys(ERRORS).find((k) => error.message.includes(k));
      setMsg({ ok: false, text: key ? ERRORS[key] : error.message });
      return;
    }
    const r = data as { month: string; breakevenMer: number; targetMer: number };
    setMsg({ ok: true, text: `Saved ${r.month} — breakeven ${r.breakevenMer}× · target ${r.targetMer}×` });
    onSaved();
  };

  const Field = ({ k, label, suffix, hint }: {
    k: keyof Fields; label: string; suffix?: string; hint?: string;
  }) => (
    <label className="block">
      <span className="text-[13px] font-medium">{label}</span>
      <span className="flex items-center gap-1.5 mt-1">
        <input
          value={f[k]}
          onChange={(e) => setF({ ...f, [k]: e.target.value })}
          className="h-8 w-32 rounded-md border bg-background px-2 text-sm tabular-nums"
          inputMode="decimal"
        />
        {suffix && <span className="text-[13px] text-muted-foreground">{suffix}</span>}
      </span>
      {hint && <span className="block text-[13px] text-muted-foreground/70 mt-0.5">{hint}</span>}
    </label>
  );

  if (!open) {
    return (
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="outline" size="sm" onClick={() => { setF(seed(ue)); setOpen(true); }}>
          Update the workbook constants
        </Button>
        <span className="text-[13px] text-muted-foreground/70">
          {ue
            ? <>In use: {ue.month}. The thresholds move when these do.</>
            : <>No month loaded — the thresholds are hidden until there is one.</>}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/60 p-3 space-y-3">
      <p className="text-[13px] text-muted-foreground">
        The six numbers come straight from Juan's monthly workbook. Breakeven and target are not
        typed — they are calculated from these, so they can never disagree with them.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Field k="month" label="Month" hint="The month the workbook describes (YYYY-MM)" />
        <Field k="cm1Pct" label="Contribution margin (CM1)" suffix="%" hint="Left of each $1 before advertising" />
        <Field k="targetMarginPct" label="Target operating margin" suffix="%" hint="The profit you want to keep" />
        <Field k="fixedCostsUsd" label="Fixed costs" suffix="US$/month" hint="Payroll, rent, software, retainers" />
        <Field k="baselineRevenueUsd" label="Baseline revenue" suffix="US$/month" hint="The month's revenue in the workbook" />
        <Field k="revenuePerOrderUsd" label="Revenue per order" suffix="US$" hint="Used by the scale plan" />
        <Field k="pctNewCustomers" label="New-customer share" suffix="%" hint="Of orders, first purchases" />
      </div>

      {preview && (
        <p className="text-[13px]">
          <span className="text-muted-foreground">This gives </span>
          <b>breakeven {preview.breakeven.toFixed(2)}×</b>
          <span className="text-muted-foreground"> · </span>
          {preview.target === null
            ? <b className="text-red-600 dark:text-red-400">target unreachable</b>
            : <b>target {preview.target.toFixed(2)}×</b>}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save the month'}</Button>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setMsg(null); }}>Cancel</Button>
      </div>

      {msg && (
        <p className={msg.ok
          ? 'text-[13px] text-emerald-700 dark:text-emerald-400'
          : 'text-[13px] text-red-600 dark:text-red-400'}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
