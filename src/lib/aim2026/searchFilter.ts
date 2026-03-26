/**
 * True when `searchRaw` matches SKU or product name.
 * Comma-separated terms are OR'd; each term uses substring match (case-insensitive).
 */
export function matchesSkuProductSearch(
  sku: string,
  product: string,
  searchRaw: string,
): boolean {
  const trimmed = searchRaw.trim();
  if (!trimmed) return true;

  const tokens = trimmed
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (tokens.length === 0) return true;

  const skuL = sku.toLowerCase();
  const prodL = product.toLowerCase();

  return tokens.some((t) => skuL.includes(t) || prodL.includes(t));
}
