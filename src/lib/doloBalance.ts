/** Pure snapshot model. All arithmetic is in integer AUD cents, never binary floats. */
export type Decimal = string | number;
export type BalanceClassification = 'asset' | 'liability' | 'unclassified' | 'reference';

export interface DoloBalanceAccess {
  can_view: boolean;
  can_edit: boolean;
  can_close: boolean;
  can_manage_access: boolean;
}

export const NO_BALANCE_ACCESS: DoloBalanceAccess = {
  can_view: false, can_edit: false, can_close: false, can_manage_access: false,
};

export interface BalanceSnapshot {
  id: string;
  as_at_date: string;
  cutoff_at: string;
  version: number;
  status: 'draft' | 'closed';
  previous_snapshot_id: string | null;
  revision: number;
  created_at: string;
  closed_at: string | null;
  closed_by: string | null;
}

export interface BalanceLineInput {
  classification: BalanceClassification;
  is_included: boolean;
  definition: string;
  amount_native: Decimal | null;
  currency: string;
  fx_to_aud: Decimal | null;
  fx_date: string | null;
  fx_source: string;
  available_native: Decimal | null;
  liquidity_eligible: boolean;
  source_label: string;
  source_record_id: string;
  source_as_at: string | null;
  evidence_path: string | null;
  note: string;
  status: 'pending' | 'reviewed';
}

export interface BalanceLine extends BalanceLineInput {
  id: string;
  snapshot_id: string;
  key: string;
  label: string;
  sort_order: number;
  amount_aud: Decimal | null;
  available_aud: Decimal | null;
  source_kind: 'manual';
  revision: number;
  updated_at: string;
}

export interface BalanceBundle { snapshot: BalanceSnapshot; lines: BalanceLine[] }
export interface BalanceUserAccess {
  user_id: string;
  email: string;
  can_view: boolean;
  can_edit: boolean;
  can_close: boolean;
  is_admin: boolean;
}

/** Labels only: no fixture values or inferred balances are shipped to production. */
export const BALANCE_CONCEPTS = [
  ['airwallex', 'Airwallex'], ['airwallex_yield', 'Airwallex Yield'],
  ['anz', 'ANZ'], ['anz_usd', 'ANZ USD'], ['stock', 'Stock'],
  ['shopify', 'Shopify'], ['shopify_usd', 'Shopify USD'], ['amex', 'AMEX (owing)'],
  ['michelle', 'Michelle'], ['meta', 'Meta'], ['meta_usd', 'Meta USD'],
  ['au_post', 'AU POST'], ['xero_owing', 'Xero owing'], ['xero_credits', 'Xero credits'],
  ['not_yet_xero_usd', 'Not yet on Xero USD'], ['gst_daniel', 'GST Daniel'],
  ['t_mstr', 'T MSTR on the way'], ['manus', 'Manus'],
] as const;

export const CASH_CONCEPT_KEYS: readonly string[] = ['airwallex', 'anz', 'anz_usd'];

export const BALANCE_HELP = {
  assets: 'Assets included in this snapshot, converted to AUD. Not all assets are immediately available to spend.',
  liabilities: 'Amounts owed at the cut-off. Shown as positive values and deducted once from Assets.',
  net: "Assets minus Liabilities within this report's agreed scope. Its change is not the period's profit.",
  availableCash: 'Funds available to use at the selected cut-off. Excludes stock, uncollected invoices, pending payouts, restricted funds and unredeemed Yield. Already included in Assets.',
  change: 'Difference from the selected comparison snapshot. For Liabilities, a positive change means the amount owed increased.',
  stock: 'Inventory value at the selected cut-off. Check included locations, quantities and the approved cost basis against the named source.',
  airwallex: 'Use reconciled Xero information or a reviewed manual entry. A ledger balance alone does not prove immediate cash availability.',
  airwallex_yield: 'Kept separate from the wallet balance. Reconcile its month-end value to the Yield statement. Not included in Available cash.',
  pending: 'The original spreadsheet label is preserved. Confirm its definition, classification and source before closing the snapshot.',
  source: 'Manual entries with a named source and cut-off date. Supporting documents are optional. No direct financial feed is enabled.',
} as const;

/** Decimal half-away-from-zero rounding, matching PostgreSQL numeric round(..., 2). */
export function decimalToCents(value: Decimal | null | undefined): bigint | null {
  if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!match) return null;
  const fraction = match[3] ?? '';
  let cents = BigInt(match[2]) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (fraction.length > 2 && fraction[2] >= '5') cents += 1n;
  return match[1] === '-' ? -cents : cents;
}

export function formatMoney(cents: bigint | null | undefined, withCurrency = true): string {
  if (cents === null || cents === undefined) return 'Pending';
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const integer = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = absolute % 100n;
  const amount = integer + (fraction === 0n ? '' : `.${fraction.toString().padStart(2, '0')}`);
  return `${negative ? '−' : ''}${withCurrency ? 'AUD ' : ''}${amount}`;
}

export function changeInCents(current: Decimal | null | undefined, previous: Decimal | null | undefined): bigint | null {
  const a = decimalToCents(current), b = decimalToCents(previous);
  return a === null || b === null ? null : a - b;
}

function parseDateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function snapshotCutoffDate(asAtDate: string): string {
  const date = parseDateOnly(asAtDate);
  if (!date || date.getUTCDate() !== 1) throw new Error('Choose the first day of a month.');
  date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

export function defaultAsAtDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', year: 'numeric', month: '2-digit' }).formatToParts(now);
  return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}-01`;
}

export function formatAsAt(date: string): string {
  const value = parseDateOnly(date);
  return value ? new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(value) : 'Unknown date';
}

export function lineIssues(line: BalanceLine, asAtDate?: string): string[] {
  const issues: string[] = [];
  if (!line.definition.trim()) issues.push('Definition is missing');
  if (line.status !== 'reviewed') issues.push('Review is pending');
  if (!line.is_included || line.classification === 'reference') {
    if (!line.note.trim()) issues.push('Explain why this line is excluded');
    if (line.classification === 'reference' && line.is_included) issues.push('A reference cannot be included');
    return issues;
  }
  if (line.classification === 'unclassified') issues.push('Classification is pending');
  if (!['asset', 'liability'].includes(line.classification)) issues.push('Choose Asset or Liability');
  const amount = decimalToCents(line.amount_aud);
  const native = decimalToCents(line.amount_native);
  if (amount === null || native === null) issues.push('Amount or conversion is missing');
  else if (amount < 0n || native < 0n) issues.push('Enter a positive magnitude; select Liability for an amount owed');
  if (!/^[A-Z]{3}$/.test(line.currency)) issues.push('Currency is invalid');
  if (line.fx_to_aud === null || !Number.isFinite(Number(line.fx_to_aud)) || Number(line.fx_to_aud) <= 0) issues.push('Exchange rate is missing');
  if (line.currency === 'AUD' && Number(line.fx_to_aud) !== 1) issues.push('AUD must use an exchange rate of 1');
  if (line.currency !== 'AUD' && (!line.fx_date || !parseDateOnly(line.fx_date) || !line.fx_source.trim())) issues.push('Exchange-rate date and source are required');
  if (!line.source_label.trim()) issues.push('Source is missing');
  if (!line.source_as_at || !parseDateOnly(line.source_as_at)) issues.push('Source date is missing');
  if (asAtDate) {
    const cutoff = snapshotCutoffDate(asAtDate);
    if (line.source_as_at && line.source_as_at !== cutoff) issues.push('Source date must match the cut-off date');
    if (line.fx_date && line.fx_date > cutoff) issues.push('Exchange-rate date is after the cut-off');
  }
  if (line.liquidity_eligible) {
    const cash = decimalToCents(line.available_aud);
    const cashNative = decimalToCents(line.available_native);
    if (line.classification !== 'asset') issues.push('Only assets can be available cash');
    if (!CASH_CONCEPT_KEYS.includes(line.key)) issues.push('This concept is not an available-cash account');
    if (cash === null || cashNative === null) issues.push('Available cash must be verified separately');
    else if (cash < 0n || cashNative < 0n || (amount !== null && cash > amount) || (native !== null && cashNative > native)) issues.push('Available cash cannot exceed the balance');
  }
  if (line.key === 'airwallex_yield' && line.liquidity_eligible) issues.push('Unredeemed Yield is excluded from Available cash');
  return issues;
}

export interface BalanceSummary {
  assets: bigint | null;
  liabilities: bigint | null;
  net: bigint | null;
  availableCash: bigint | null;
  partialAssets: bigint;
  partialLiabilities: bigint;
  pendingCount: number;
  unclassifiedCount: number;
  issues: string[];
  readyToClose: boolean;
}

export function summarizeBalance(lines: BalanceLine[], asAtDate?: string): BalanceSummary {
  let assetSum = 0n, liabilitySum = 0n, cashSum = 0n;
  let assetComplete = lines.length > 0, liabilityComplete = lines.length > 0, cashComplete = lines.length > 0;
  let pendingCount = 0, unclassifiedCount = 0;
  const issues: string[] = [];
  const keys = new Set<string>();
  const expectedKeys = new Set<string>(BALANCE_CONCEPTS.map(([key]) => key));
  for (const line of lines) {
    const problems = lineIssues(line, asAtDate);
    if (problems.length) { pendingCount++; issues.push(...problems.map(problem => `${line.label}: ${problem}`)); }
    if (keys.has(line.key)) { issues.push(`${line.label}: Duplicate concept`); assetComplete = liabilityComplete = cashComplete = false; continue; }
    keys.add(line.key);
    if (!expectedKeys.has(line.key)) {
      issues.push(`${line.label}: Unknown concept`);
      assetComplete = liabilityComplete = cashComplete = false;
    }
    if (line.key === 'meta_usd' && (line.classification !== 'reference' || line.is_included)) {
      issues.push('Meta USD must remain an excluded reference');
      assetComplete = liabilityComplete = cashComplete = false;
    }
    if (line.classification === 'reference' && line.is_included) assetComplete = liabilityComplete = cashComplete = false;
    if (!line.is_included || line.classification === 'reference') {
      if (problems.length > 0) assetComplete = liabilityComplete = cashComplete = false;
      continue;
    }
    const amount = decimalToCents(line.amount_aud);
    if (line.classification === 'unclassified') {
      unclassifiedCount++; assetComplete = liabilityComplete = cashComplete = false; continue;
    }
    if (line.classification === 'asset') {
      if (amount === null || amount < 0n || problems.length > 0) assetComplete = false;
      if (amount !== null && amount >= 0n) assetSum += amount;
    } else if (line.classification === 'liability') {
      if (amount === null || amount < 0n || problems.length > 0) liabilityComplete = false;
      if (amount !== null && amount >= 0n) liabilitySum += amount;
    } else { assetComplete = liabilityComplete = cashComplete = false; }
    if (line.liquidity_eligible) {
      const cash = decimalToCents(line.available_aud);
      if (problems.length > 0 || cash === null || cash < 0n || amount === null || cash > amount || line.classification !== 'asset' || line.key === 'airwallex_yield') cashComplete = false;
      else cashSum += cash;
    }
  }
  if (!lines.length) issues.push('No balance lines have been loaded');
  const missing = BALANCE_CONCEPTS.filter(([key]) => !keys.has(key));
  if (missing.length) {
    issues.push(`${missing.length} expected concept(s) missing from this snapshot`);
    assetComplete = liabilityComplete = cashComplete = false;
  }
  const assets = assetComplete ? assetSum : null, liabilities = liabilityComplete ? liabilitySum : null;
  return { assets, liabilities, net: assets === null || liabilities === null ? null : assets - liabilities,
    availableCash: cashComplete ? cashSum : null, partialAssets: assetSum, partialLiabilities: liabilitySum,
    pendingCount, unclassifiedCount, issues, readyToClose: issues.length === 0 };
}
