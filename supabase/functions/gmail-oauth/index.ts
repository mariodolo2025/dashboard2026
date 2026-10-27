// =============================================================================
// gmail-oauth — connects the Gmail account that sends the weekly health email.
//
// Mario asked on 27-Oct-2026 for a weekly email (weekly-health-report). This
// function stores the sender's refresh token in ops_email_settings.
//
//   GET ?start=<nonce>    → redirect to Google's consent screen
//   GET ?code=…&state=…   → Google's redirect back: exchange, store, done
//
// Deployed with --no-verify-jwt: Google's redirect carries no Authorization
// header. In its place, a one-time nonce: only a link minted from the database
// (ops_email_settings.connect_nonce, valid 2 hours) can connect an account, so
// nobody else can make the report go out from their own mailbox.
// Scopes: gmail.send (send only) + userinfo.email (gmail.send alone cannot
// read which account connected). access_type=offline + prompt=consent, or
// Google stops issuing refresh tokens (playbook: CF-GC EMAIL-SETUP-GUIDE.md).
// =============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const SCOPES = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email';

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1f2937">` +
      `<h2>${title}</h2><p>${body}</p></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const clientId = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
    const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '';
    const redirectUri = `${supabaseUrl}/functions/v1/gmail-oauth`; // must match Google Cloud byte for byte
    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: st, error: stErr } = await supabase
      .from('ops_email_settings').select('connect_nonce, connect_nonce_expires_at').eq('id', 1).maybeSingle();
    if (stErr) throw new Error(`settings: ${stErr.message}`);
    const nonceOk = (n: string | null) =>
      !!n && !!st?.connect_nonce && n === st.connect_nonce &&
      !!st.connect_nonce_expires_at && Date.parse(st.connect_nonce_expires_at) > Date.now();

    // 1. Start: send the browser to Google.
    const start = url.searchParams.get('start');
    if (start !== null) {
      if (!nonceOk(start)) return page('Link vencido', 'Este link ya no sirve. Pedí uno nuevo.', 403);
      if (!clientId) return page('Falta configurar Google', 'No está cargado GOOGLE_CLIENT_ID en Supabase.', 500);
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES,
        access_type: 'offline', prompt: 'consent', state: start,
      }).toString();
      return Response.redirect(auth.toString(), 302);
    }

    // 2. Callback from Google.
    const gErr = url.searchParams.get('error');
    if (gErr) return page('Google no autorizó', esc(gErr), 400);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !nonceOk(state)) return page('Link vencido', 'Este link ya no sirve. Pedí uno nuevo.', 403);

    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
    });
    if (!tokRes.ok) throw new Error(`token exchange ${tokRes.status}: ${(await tokRes.text()).slice(0, 200)}`);
    const tok = await tokRes.json();
    if (!tok.refresh_token) throw new Error('Google did not return a refresh token (offline access not granted)');

    const who = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (!who.ok) throw new Error(`userinfo ${who.status}`);
    const email = String((await who.json()).email ?? '');
    if (!email) throw new Error('userinfo returned no email');

    const { error: upErr } = await supabase.from('ops_email_settings').update({
      sender_email: email,
      refresh_token: tok.refresh_token,
      access_token: tok.access_token,
      access_token_expires_at: new Date(Date.now() + Number(tok.expires_in ?? 3600) * 1000).toISOString(),
      connect_nonce: null, connect_nonce_expires_at: null, // one use only
      updated_at: new Date().toISOString(),
    }).eq('id', 1);
    if (upErr) throw new Error(`store: ${upErr.message}`);

    return page('Gmail conectado', `El informe semanal se va a enviar desde <b>${esc(email)}</b>. Ya podés cerrar esta pestaña.`);
  } catch (e) {
    console.error('gmail-oauth error:', e);
    return page('Error', esc(e instanceof Error ? e.message : 'Unknown error'), 500);
  }
});
