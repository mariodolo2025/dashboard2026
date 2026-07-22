// =============================================================================
// Shopify variant map sync.
//
// The upgrade pixel identifies products by variant_id (that is what cart/add.js
// takes), while every sales table in this project keys on sku. Without a bridge
// between the two, an upgrade click event cannot be tied to the product it was
// for — so "how many clicks did the Gaggia shower screen get" is unanswerable.
//
// Pulls every product/variant from the Admin API and upserts the mapping. Safe to
// re-run: upsert on variant_id, never deletes (a variant that disappears from the
// catalogue must keep resolving, because historical events still reference it).
//
//   POST {} → full refresh
// Service-role only.
// =============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: creds } = await supabase
      .from('api_credentials').select('store_url, access_token').eq('provider', 'shopify').maybeSingle();
    if (!creds?.access_token) return json({ success: false, message: 'no shopify creds' }, 400);
    let store = String(creds.store_url).trim();
    if (!store.includes('.')) store += '.myshopify.com';
    store = store.replace(/^https?:\/\//, '').split('/')[0];
    const token = creds.access_token as string;

    // Diagnostic: which custom app does the stored token belong to, and what can it
    // already do? Needed because the store has several apps and only one of them is
    // the dashboard's — editing the wrong one's scopes would do nothing.
    if (body?.mode === 'whoami') {
      const gql = await fetch(`https://${store}/admin/api/2024-01/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ currentAppInstallation { app { title handle } } }' }),
      });
      const who = await gql.json();
      const sc = await fetch(`https://${store}/admin/oauth/access_scopes.json`, {
        headers: { 'X-Shopify-Access-Token': token },
      });
      const scopes = await sc.json();
      return json({
        success: true, store,
        app: who?.data?.currentAppInstallation?.app ?? null,
        scopes: (scopes?.access_scopes ?? []).map((s: { handle: string }) => s.handle).sort(),
      });
    }

    // Preferred path: build the map from ORDER LINE ITEMS. Every line carries both
    // variant_id and sku, and read_orders is a scope the app already has — so this
    // needs no new merchant approval, unlike products.json which 403s on
    // read_products. It only maps variants that have actually sold, which is exactly
    // the population that can ever appear in a sales join anyway.
    if (body?.mode !== 'products') {
      const days = Number(body?.days) || 60;
      const since = new Date(Date.now() - days * 86400e3).toISOString();
      let url: string | null =
        `https://${store}/admin/api/2024-01/orders.json?limit=250&status=any&order=updated_at+desc` +
        `&updated_at_min=${encodeURIComponent(since)}&fields=id,line_items`;

      const seen = new Map<number, Record<string, unknown>>();
      let pages = 0, orders = 0;
      while (url) {
        const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
        if (!res.ok) return json({ success: false, message: `shopify ${res.status}: ${await res.text()}` }, 502);
        const b = await res.json();
        for (const o of (b.orders ?? [])) {
          orders++;
          for (const li of (o.line_items ?? [])) {
            const vid = Number(li.variant_id);
            if (!vid || seen.has(vid)) continue;
            seen.set(vid, {
              variant_id: vid,
              product_id: li.product_id ? Number(li.product_id) : null,
              sku: li.sku ? String(li.sku) : null,
              product_title: li.title ?? null,
              variant_title: li.variant_title ?? null,
              synced_at: new Date().toISOString(),
            });
          }
        }
        const link = res.headers.get('link') ?? '';
        const m = link.match(/<([^>]+)>;\s*rel="next"/);
        url = m ? m[1] : null;
        pages++;
        if (pages > 120) break; // bound the walk; re-run with a smaller `days` if hit
      }

      const rows2 = [...seen.values()];
      let written2 = 0;
      for (let i = 0; i < rows2.length; i += 500) {
        const chunk = rows2.slice(i, i + 500);
        // Do not clobber a hand-seeded row with a null sku from a deleted variant.
        const { error } = await supabase.from('shopify_variant_map').upsert(chunk, { onConflict: 'variant_id' });
        if (error) return json({ success: false, message: `upsert: ${error.message}`, written: written2 }, 500);
        written2 += chunk.length;
      }
      // `rows` is what sync-orchestrate logs into sync_runs.steps.
      return json({ success: true, source: 'orders', days, pages, orders, variants: rows2.length, written: written2, rows: written2 });
    }

    let nextUrl: string | null =
      `https://${store}/admin/api/2024-01/products.json?limit=250&fields=id,title,variants`;

    const rows: Record<string, unknown>[] = [];
    let products = 0, pages = 0;

    while (nextUrl) {
      const res = await fetch(nextUrl, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) return json({ success: false, message: `shopify ${res.status}: ${await res.text()}` }, 502);
      const body = await res.json();

      for (const p of (body.products ?? [])) {
        products++;
        for (const v of (p.variants ?? [])) {
          rows.push({
            variant_id: Number(v.id),
            product_id: Number(p.id),
            sku: v.sku ? String(v.sku) : null,
            product_title: p.title ?? null,
            variant_title: v.title ?? null,
            synced_at: new Date().toISOString(),
          });
        }
      }

      // Shopify paginates via the Link header; follow rel="next" until exhausted.
      const link = res.headers.get('link') ?? '';
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      nextUrl = m ? m[1] : null;
      pages++;
      if (pages > 60) break; // guard against an unbounded cursor loop
    }

    // Chunked upsert — a single statement with thousands of rows can exceed limits.
    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await supabase.from('shopify_variant_map').upsert(chunk, { onConflict: 'variant_id' });
      if (error) return json({ success: false, message: `upsert: ${error.message}`, written }, 500);
      written += chunk.length;
    }

    return json({ success: true, pages, products, variants: rows.length, written });
  } catch (e) {
    return json({ success: false, message: String(e) }, 500);
  }
});
