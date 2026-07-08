// =============================================================================
// Starshipit market reallocation — SINGLE SOURCE OF TRUTH.
//
// Xero classifies freight by supplier contact, so Australia Post (which ships
// to AU AND US) lands entirely in "Outbound — B2C AU", and all of DHL
// eCommerce (100% US) sits there too. Starshipit knows each carrier's real
// destination split. We reallocate the outbound-B2C carrier money by that
// carrier's monthly market ratio so the reported AU/US split reflects reality.
//
// Consumed by:
//  - parse-xero-costs      (the canvas/category totals: 2-way AU vs US)
//  - xero-account-detail   (the drill-down reconciliation bridge)
//  - starshipit-market     (the Freight by Market report: 3-way AU/US/Other)
//
// One implementation → the three surfaces can never drift apart.
// =============================================================================

export interface MarketCell { au: number; us: number; other: number; total: number }
export interface StarshipitRatios {
  monthly: Map<string, Map<string, MarketCell>>; // carrier_key → "year-month" → cell
  fy: Map<string, MarketCell>;                    // carrier_key → FY-blended cell
}

function emptyCell(): MarketCell { return { au: 0, us: 0, other: 0, total: 0 }; }
function addToCell(c: MarketCell, market: string, freight: number) {
  c.total += freight;
  if (market === 'AU') c.au += freight;
  else if (market === 'US') c.us += freight;
  else c.other += freight;
}

/** Load per-carrier market ratios from starshipit_market_monthly. The split is
 *  weighted by Starshipit's Freight Charge (what each destination actually
 *  cost that carrier), which is the right weight for splitting a Xero invoice
 *  total across destinations. */
export async function loadStarshipitRatios(supabase: any): Promise<StarshipitRatios> {
  const monthly = new Map<string, Map<string, MarketCell>>();
  const fy = new Map<string, MarketCell>();
  const { data } = await supabase
    .from('starshipit_market_monthly')
    .select('year, month, carrier_key, market, freight_charge');
  for (const r of data ?? []) {
    const ck = String(r.carrier_key);
    const fc = Number(r.freight_charge) || 0;
    const mkKey = `${r.year}-${r.month}`;
    if (!monthly.has(ck)) monthly.set(ck, new Map());
    const mm = monthly.get(ck)!;
    if (!mm.has(mkKey)) mm.set(mkKey, emptyCell());
    addToCell(mm.get(mkKey)!, r.market, fc);
    if (!fy.has(ck)) fy.set(ck, emptyCell());
    addToCell(fy.get(ck)!, r.market, fc);
  }
  return { monthly, fy };
}

/** The best market cell for a carrier in a month: the month's own split, else
 *  the FY-blended split, else null (no Starshipit data → caller decides). */
function bestCell(ratios: StarshipitRatios, ck: string, year: number, month: number): MarketCell | null {
  const cell = ratios.monthly.get(ck)?.get(`${year}-${month}`);
  if (cell && cell.total > 0) return cell;
  const f = ratios.fy.get(ck);
  if (f && f.total > 0) return f;
  return null;
}

/** AU share (0..1) for a carrier in a month, or null when there's no data.
 *  Used by the 2-way category reallocation (everything non-AU → US). */
export function auShare(ratios: StarshipitRatios, ck: string, year: number, month: number): number | null {
  const c = bestCell(ratios, ck, year, month);
  return c ? c.au / c.total : null;
}

/** Full 3-way market share {au,us,other} summing to 1, or null when there's no
 *  data. Used by the Freight by Market report. */
export function marketShare(
  ratios: StarshipitRatios, ck: string, year: number, month: number,
): { au: number; us: number; other: number } | null {
  const c = bestCell(ratios, ck, year, month);
  if (!c) return null;
  return { au: c.au / c.total, us: c.us / c.total, other: c.other / c.total };
}

/** Map a Xero supplier contact to its Starshipit carrier_key. Only outbound-B2C
 *  carriers that ship to multiple markets are returned; single-market or
 *  non-carrier contacts (ZONOS, Hoon Choi, inbound/B2B suppliers) return null
 *  so callers keep them as-is. */
export function carrierKeyForContact(contact: string | null): string | null {
  const n = (contact ?? '').toLowerCase();
  if (/australia\s*post/.test(n)) return 'auspost';
  if (/dhl\s*e-?commerce/.test(n)) return 'dhl_ecommerce';
  if (/\bups\b/.test(n)) return 'ups';
  return null;
}
