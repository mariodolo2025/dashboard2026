// =============================================================================
// Xero OAuth2 handler — one-time authorization + token storage.
//
// Deployed with --no-verify-jwt: Xero's browser redirect cannot carry an auth
// header (same pattern as handle-gmail-oauth in China Dashboard).
//
// Flow:
//   GET /xero-oauth            → 302 redirect to Xero's consent screen
//   GET /xero-oauth?code=...   → exchanges the code, fetches the tenant id,
//                                stores the (rotating) refresh token in
//                                xero_oauth_tokens, and shows a done page.
//
// Scopes: offline_access (refresh token) + read-only accounting reports and
// journals. No write scopes.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

// Granular scopes (mandatory for apps created after March 2026; the old broad
// accounting.reports.read / accounting.journals.read return invalid_scope).
// Journals (general ledger) is premium-gated now — we use BankTransactions
// instead for account-line detail, which covers the Spend Money payments that
// make up the accounts we need to split. settings.read = chart of accounts
// (code → name mapping).
// Granular scopes (mandatory for apps created after March 2026).
// - reports.profitandloss.read : the P&L by account × month
// - banktransactions.read      : Spend/Receive Money lines (direct expenses)
// - invoices.read              : ACCPAY bills (freight is largely booked as
//                                supplier bills, e.g. Diamond container freight,
//                                DHL International Freight) — needed to split
//                                accounts by line description, not just contact
// - settings.read              : chart of accounts (code → name)
const SCOPES = 'offline_access accounting.reports.profitandloss.read accounting.banktransactions.read accounting.invoices.read accounting.settings.read';
const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

function htmlResponse(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
     <body style="font-family:system-ui;max-width:560px;margin:80px auto;line-height:1.5">
     <h2>${title}</h2><p>${body}</p></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

Deno.serve(async (req: Request) => {
  try {
    const clientId = Deno.env.get('XERO_CLIENT_ID');
    const clientSecret = Deno.env.get('XERO_CLIENT_SECRET');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!clientId || !clientSecret || !supabaseUrl || !serviceKey) {
      return htmlResponse('Configuration error', 'Missing XERO_CLIENT_ID / XERO_CLIENT_SECRET secrets.', 500);
    }

    const url = new URL(req.url);
    // The public URL of this function — must match the redirect URI registered
    // in the Xero app byte-for-byte.
    const redirectUri = `${supabaseUrl}/functions/v1/xero-oauth`;

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      return htmlResponse('Authorization failed', `Xero returned: ${error}`, 400);
    }

    if (!code) {
      // Step 1: send the user to Xero's consent screen.
      const authUrl =
        `${AUTHORIZE_URL}?response_type=code` +
        `&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=${encodeURIComponent(SCOPES)}` +
        `&state=dolo-dashboard`;
      return Response.redirect(authUrl, 302);
    }

    // Step 2: exchange the code for tokens.
    const basic = btoa(`${clientId}:${clientSecret}`);
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text();
      console.error('Token exchange failed:', detail);
      return htmlResponse('Token exchange failed', `Xero rejected the code (HTTP ${tokenRes.status}). Try the flow again.`, 500);
    }
    const tokens = await tokenRes.json();

    // Which Xero organisation authorized us?
    const connRes = await fetch(CONNECTIONS_URL, {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });
    if (!connRes.ok) {
      return htmlResponse('Connections lookup failed', `HTTP ${connRes.status}`, 500);
    }
    const connections = await connRes.json();
    if (!Array.isArray(connections) || connections.length === 0) {
      return htmlResponse('No organisation', 'The authorization completed but no Xero organisation was connected.', 400);
    }
    const tenant = connections[0];

    const supabase = createClient(supabaseUrl, serviceKey);
    const { error: dbError } = await supabase
      .from('xero_oauth_tokens')
      .upsert({
        id: 1,
        refresh_token: tokens.refresh_token,
        tenant_id: tenant.tenantId,
        tenant_name: tenant.tenantName ?? null,
        updated_at: new Date().toISOString(),
      });
    if (dbError) {
      console.error('Failed to store tokens:', dbError);
      return htmlResponse('Storage failed', dbError.message, 500);
    }

    return htmlResponse(
      'Xero connected ✔',
      `Organisation <b>${tenant.tenantName ?? tenant.tenantId}</b> authorized. ` +
      'You can close this tab — the dashboard will sync automatically from now on.',
    );
  } catch (e) {
    console.error('xero-oauth error:', e);
    return htmlResponse('Unexpected error', e instanceof Error ? e.message : 'Unknown error', 500);
  }
});
