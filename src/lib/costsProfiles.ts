// =============================================================================
// Costs Profiles — named cost-classification presets for the Costs tab.
//
// A profile is a full CostsConfig (boards + sliders + adjustments + excluded)
// plus a name. Selecting a profile APPLIES it as the active config — the same
// config every other surface consumes (Cost distribution card, By Channel
// "use info from Costs tab", FY Report) — so switching profiles re-frames the
// whole dashboard's cost view.
//
// The three seed profiles share one structural correction (2026-07 analysis):
//   EXCLUDED everywhere — items that are NOT operating expenses:
//   - "Stock purchased" ($4.32M FY26): inventory purchases = COGS. COGS is
//     already deducted per-SKU downstream; keeping this in a board
//     double-counts ~$4.3M against revenue.
//   - "Rates & Taxes" ($491k FY26): lumpy, container-timed spikes totalling
//     ~11% of Stock purchased → import GST/duty paid at customs. Belongs to
//     landed cost (already inside per-SKU costs), not opex. Pending accountant
//     confirmation.
//   - Currency noise: "Unrealised Currency Gains", "Realised Currency Gains",
//     "Bank Revaluations" — accounting revaluations, not operating spend.
//   - "Interest Expense" ($0).
//
// Sliders are % B2B (sliderValue semantics from CostsCanvas): Advertising 10
// (Meta ads ≈ 90% B2C — Mario 2026-07-07), Freight 25, Bank Fees 10, Stripe 0.
// =============================================================================

import type { CostsConfig } from '@/lib/costsCalculator';

export interface CostProfile {
  id: string;
  name: string;
  description?: string;
  boards: CostsConfig['boards'];
  sliders: CostsConfig['sliders'];
  adjustments: CostsConfig['adjustments'];
  excluded: CostsConfig['excluded'];
  updatedAt: string;
}

const COMMON_EXCLUDED: Record<string, boolean> = {
  'Stock purchased': true,
  // Plain 'Rates & Taxes' only exists in xlsx-fallback mode; the live API path
  // splits it into virtual accounts (see parse-xero-costs SPLIT_RULES). The
  // remittances/review/unclassified parts are never operating costs; the
  // Property & Compliance part is assigned per profile below.
  'Rates & Taxes': true,
  'Rates & Taxes — Tax remittances': true,
  'Rates & Taxes — Review': true,
  'Rates & Taxes — Unclassified': true,
  'Unrealised Currency Gains': true,
  'Realised Currency Gains': true,
  'Bank Revaluations': true,
  'Interest Expense': true,
};

const VARIABLE_SLIDERS: Record<string, number> = {
  'Advertising': 10,
  'Freight & Courier': 25,
  'Bank Fees': 10,
  'Stripe Fees (no GST)': 0,
};

const ANDREA_ITEMS = [
  'Cleaning',
  'Insurance',
  'Motor Vehicle Expenses',
  'Travel - International',
  'Travel - National',
  'Entertainment',
  'Light, Power, Heating',
];

const FIXED_ITEMS = [
  'Rates & Taxes — Property & Compliance',
  'Wages and Salaries',
  'Superannuation',
  'Computer & Software',
  'Repairs and Maintenance',
  'Office Expenses',
  'Subscriptions',
  'Consulting & Accounting',
  'Certification / Registration',
  'Legal expenses',
  'non-deductible expense',
  'Management fee',
  'Telephone & Internet',
  'Donation',
];

function boardsFrom(parts: Partial<Record<'fixed' | 'variable' | 'andrea', string[]>>): CostsConfig['boards'] {
  const boards: CostsConfig['boards'] = {};
  (Object.entries(parts) as ['fixed' | 'variable' | 'andrea', string[]][]).forEach(([board, names]) => {
    names.forEach((n) => { boards[n] = board; });
  });
  return boards;
}

export const SEED_PROFILES: CostProfile[] = [
  {
    id: 'ceo-pnl',
    name: 'CEO — P&L',
    description:
      'True operating picture. Variable = costs that scale with sales (Advertising, Freight, payment fees). ' +
      'Andrea board = her discretionary costs (toggle in By Channel). COGS, import duties and currency noise excluded — ' +
      'COGS is already deducted per-SKU downstream.',
    boards: boardsFrom({
      variable: ['Advertising', 'Freight & Courier', 'Bank Fees', 'Stripe Fees (no GST)'],
      andrea: ANDREA_ITEMS,
      fixed: FIXED_ITEMS,
    }),
    sliders: { ...VARIABLE_SLIDERS },
    adjustments: {},
    excluded: { ...COMMON_EXCLUDED },
    updatedAt: new Date('2026-07-07').toISOString(),
  },
  {
    id: 'ops-cost-to-serve',
    name: 'Operations — Cost to Serve',
    description:
      'What it costs to run and fulfil, with marketing stripped out: Advertising excluded on top of the common ' +
      'exclusions. Variable = Freight and payment fees; structure and Andrea unchanged from CEO.',
    boards: boardsFrom({
      variable: ['Freight & Courier', 'Bank Fees', 'Stripe Fees (no GST)'],
      andrea: ANDREA_ITEMS,
      fixed: FIXED_ITEMS,
    }),
    sliders: { ...VARIABLE_SLIDERS },
    adjustments: {},
    excluded: { ...COMMON_EXCLUDED, 'Advertising': true },
    updatedAt: new Date('2026-07-07').toISOString(),
  },
  {
    id: 'marketing-contribution',
    name: 'Marketing — Contribution',
    description:
      'Contribution lens: ONLY costs that scale with each sale (Advertising, Freight, payment fees). All fixed ' +
      'structure and Andrea costs excluded, so By Channel shows sales − COGS − variable = contribution margin.',
    boards: boardsFrom({
      variable: ['Advertising', 'Freight & Courier', 'Bank Fees', 'Stripe Fees (no GST)'],
    }),
    sliders: { ...VARIABLE_SLIDERS },
    adjustments: {},
    excluded: {
      ...COMMON_EXCLUDED,
      ...Object.fromEntries([...ANDREA_ITEMS, ...FIXED_ITEMS].map((n) => [n, true])),
    },
    updatedAt: new Date('2026-07-07').toISOString(),
  },
];

// ─── API ─────────────────────────────────────────────────────────────────────

const fnUrl = () => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/costs-profiles`;
const authHeaders = () => ({
  Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
});

export async function fetchCostProfiles(): Promise<CostProfile[]> {
  const res = await fetch(fnUrl(), { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to load profiles: ${res.status}`);
  const body = await res.json();
  return body.profiles ?? [];
}

export async function saveCostProfiles(profiles: CostProfile[]): Promise<boolean> {
  const res = await fetch(fnUrl(), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ profiles }),
  });
  if (!res.ok) return false;
  const body = await res.json();
  return body.success === true;
}

/** Convert a profile into the active CostsConfig shape. */
export function profileToConfig(p: CostProfile): CostsConfig {
  return {
    schemaVersion: 1,
    boards: { ...p.boards },
    sliders: { ...p.sliders },
    adjustments: { ...p.adjustments },
    excluded: { ...p.excluded },
    updatedAt: new Date().toISOString(),
  };
}
