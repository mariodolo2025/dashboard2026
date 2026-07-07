// =============================================================================
// Xero account split rules — SINGLE SOURCE OF TRUTH.
//
// Watched accounts that mix categories are split into virtual accounts by
// matching the transaction's supplier CONTACT (line descriptions are generic).
// Both parse-xero-costs (the canvas/report totals) and xero-account-detail
// (the drill-down) import from here, so the classification a user sees in the
// detail is exactly the one that built the totals.
//
// Order matters — first matching pattern wins. Anything unmatched → "Review".
// =============================================================================

export interface SplitRule {
  bucket: string;
  pattern: RegExp;
}

export const SPLIT_RULES: Record<string, SplitRule[]> = {
  'Rates & Taxes': [
    { bucket: 'Tax remittances', pattern: /taxation office|(^|\W)ato(\W|$)/i },
    { bucket: 'Property & Compliance', pattern: /gold coast|body corporate|asic|land tax|council/i },
  ],
  'Freight & Courier': [
    { bucket: 'Subscription (Starshipit)', pattern: /starshipit|starship/i },
    { bucket: 'Inbound — Container', pattern: /diamond/i },
    { bucket: 'Inbound — DHL International', pattern: /^dhl(\s+express)?$/i },
    // Freight on merchandise we receive/move for the B2B channel.
    { bucket: 'Inbound — B2B related', pattern: /\bbwt\b|dipacci|coffee\s*machine\s*technolog|el\s*rocio|repa\s*italia|xtracted/i },
    { bucket: 'Outbound — B2C AU', pattern: /australia\s*post|dhl\s*e-?commerce/i },
    { bucket: 'Outbound — B2B', pattern: /one\s*freight|star\s*track|interparcel|tfm|regional\s*express|interflow/i },
    // US customer shipping (UPS/ZONOS) + Hoon Choi (US returns/replacements).
    { bucket: 'Outbound — B2C USA', pattern: /\bups\b|zonos|hoon\s*choi/i },
    // Unmatched → "Review" (e.g. Mavam LLC = freight of a trade-show stand to Belgium).
  ],
};

/** The bucket a line falls into for a watched account, or "Review" if no rule
 *  matches. Returns null if the account isn't split. */
export function classifyLine(account: string, contactName: string | null): string | null {
  const rules = SPLIT_RULES[account];
  if (!rules) return null;
  const contact = String(contactName ?? '');
  const rule = rules.find((r) => r.pattern.test(contact));
  return rule ? rule.bucket : 'Review';
}
