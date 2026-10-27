// =============================================================================
// weekly-health-report — the Monday email with the dashboard's health.
//
// Asked by Mario on 27-Oct-2026: once a week, check the health, compare the
// data, and email what was found to mario@dolo.com.au. Cron
// weekly-health-report, Monday 08:00 Brisbane, through ops_http_post.
//
//   POST {}            → report on last week (Monday-Sunday, Brisbane) and send
//                        it once (a second call for the same week is skipped)
//   POST { test:true } → same report, subject marked PRUEBA, at most every 10 min
//
// All reads are one call to ops_weekly_findings (SQL). Recipients and the
// sender's Gmail token live in ops_email_settings (connected via gmail-oauth).
// Every report is stored in ops_weekly_reports, sent or not. The answer carries
// counts only (the function can be reached with the public key), and is
// non-2xx when the email did not go out, so the watchdog turns red.
// =============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const num = (n: unknown, d = 0) =>
  Number(n ?? 0).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const aud = (n: unknown, d = 0) => `${Number(n ?? 0) < 0 ? '−' : ''}A$${num(Math.abs(Number(n ?? 0)), d)}`;
/** An error as one short line: some answers are whole HTML pages (a 502). */
const short = (s: unknown) => {
  const t = String(s ?? '').replace(/<head>[\s\S]*?<\/head>/i, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 180 ? `${t.slice(0, 180)}…` : t;
};
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fmtDay = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3);
const HOUR = 3600e3;

/** Alerts (something is wrong now) and notes (worth knowing) from the findings. */
function analyse(f: any, today: string) {
  const alerts: string[] = [];
  const notes: string[] = [];

  const failingNow = new Set<string>();
  for (const j of f.failingNow ?? []) {
    failingNow.add(j.job);
    alerts.push(`En rojo ahora: <b>${esc(j.label)}</b>. ${esc(short(j.detail))}`);
  }
  for (const w of f.weekFailures ?? []) {
    if (failingNow.has(w.job)) continue;
    notes.push(`<b>${esc(w.label)}</b> falló ${w.failures} ${w.failures === 1 ? 'vez' : 'veces'} en la semana y se recuperó. Último error: ${esc(short(w.lastError))}`);
  }
  const runs = f.syncRuns?.runs ?? 0;
  for (const s of f.syncRuns?.failedSteps ?? []) {
    const line = `Auto-refresh, paso <b>${esc(s.step)}</b>: falló en ${s.failures} de ${runs} corridas. ${esc(short(s.lastError))}`;
    (s.failures >= 3 ? alerts : notes).push(line);
  }

  // Xero: freight & rates lines vs the P&L.
  for (const r of f.xero?.reconcile ?? []) {
    if (Math.abs(Number(r.diff)) <= 1) continue;
    const line = `Xero ${esc(r.month)}, ${esc(r.account)}: líneas ${aud(r.lines, 2)} vs P&L ${aud(r.pl, 2)} (diferencia ${aud(r.diff, 2)})`;
    if (r.closed) alerts.push(line); else notes.push(`${line}. Mes todavía abierto.`);
  }
  const ls = f.xero?.lastSync;
  if (!ls?.at || Date.now() - Date.parse(ls.at) > 26 * HOUR) alerts.push('Xero: no hubo sync en las últimas 26 horas.');
  else if (!ls.ok && !ls.partial) alerts.push(`Xero: el último sync falló. ${esc(ls.error)}`);
  const mv = f.xero?.monthlyVerification;
  if (mv?.ok === false) alerts.push(`Verificación mensual independiente de ${esc(mv.month)}: FALLÓ. ${esc(mv.summary)} (${esc(mv.doc)})`);
  const prevMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  if (prevMonth >= '2026-10' && Number(today.slice(8)) >= 6 && mv?.month !== prevMonth) {
    alerts.push(`Verificación mensual independiente: falta la de ${prevMonth} (se hace el día 2).`);
  }

  // Shopify: orders vs Shopify's own count.
  const cc = f.shopify?.countCheck;
  if (!cc?.checkedAt || Date.now() - Date.parse(cc.checkedAt) > 26 * HOUR) alerts.push('Shopify: el conteo diario contra Shopify no corrió en las últimas 26 horas.');
  for (const m of cc?.months ?? []) {
    if (Number(m.diff) !== 0) alerts.push(`Shopify ${esc(m.month)}: la base tiene ${num(m.db)} órdenes y Shopify ${num(m.shopify)}.`);
  }
  const pr = f.shopify?.prunedThisWeek;
  if (Number(pr?.orders) > 0) notes.push(`Shopify: ${pr.orders} órdenes borradas en Shopify salieron de la base esta semana (quedan guardadas en backup).`);

  // Freshness.
  const fresh: { source: string; last: string | null; ok: boolean; manual: boolean }[] = [];
  for (const s of f.freshness ?? []) {
    const last: string | null = s.last ?? null;
    let ok = !!last && daysBetween(last, today) <= Number(s.maxAgeDays);
    // The month's rate is loaded on the 1st at 13:00: missing that morning is normal.
    if (!last && String(s.source).startsWith('USD') && today.endsWith('-01')) ok = true;
    fresh.push({ source: s.source, last, ok, manual: !!s.manual });
    if (ok) continue;
    const line = `Datos viejos: <b>${esc(s.source)}</b>, último dato ${last ? fmtDay(last) : 'ninguno'}.`;
    (s.manual ? notes : alerts).push(s.manual ? `${line} Se carga a mano.` : line);
  }
  return { alerts, notes, fresh };
}

/** The week in numbers: E-commerce tab KPIs, this week vs the previous one. */
function numbersTable(e: any) {
  const rows: [string, string, number][] = [
    ['Net revenue', 'revenue', 0], ['Orders', 'orders', 0], ['AOV', 'aov', 2], ['Ad spend', 'spend', 0], ['MER', 'mer', 2],
  ];
  const fmt = (key: string, v: unknown, d: number) =>
    v === null || v === undefined ? '—' : (key === 'orders' || key === 'mer') ? num(v, d) : aud(v, d);
  const big: string[] = [];
  const cell = (market: string, key: string, d: number) => {
    const k = e?.[market]?.kpis?.[key];
    const p = e?.[market]?.prior?.[key];
    if (k === undefined || k === null) return '<td>—</td><td>—</td><td>—</td>';
    let delta = '—';
    if (p !== undefined && p !== null && Number(p) !== 0) {
      const pct = ((Number(k) - Number(p)) / Math.abs(Number(p))) * 100;
      const strong = Math.abs(pct) >= 20;
      delta = `<span style="color:${pct >= 0 ? '#15803d' : '#b91c1c'};${strong ? 'font-weight:700' : ''}">${pct >= 0 ? '+' : ''}${num(pct, 0)}%</span>`;
      if (strong) big.push(`${market === 'all' ? 'Todos los mercados' : market === 'usa' ? 'USA' : 'Australia'}, ${key === 'revenue' ? 'Net revenue' : rows.find((r) => r[1] === key)![0]}: ${pct >= 0 ? '+' : ''}${num(pct, 0)}% vs la semana anterior`);
    }
    return `<td style="text-align:right">${fmt(key, k, d)}</td><td style="text-align:right;color:#6b7280">${fmt(key, p, d)}</td><td style="text-align:right">${delta}</td>`;
  };
  const th = 'style="text-align:right;padding:4px 8px;border-bottom:1px solid #d1d5db;font-size:13px"';
  let html = `<table style="border-collapse:collapse;font-size:14px;width:100%"><tr><th style="text-align:left;padding:4px 8px;border-bottom:1px solid #d1d5db;font-size:13px"></th>`;
  for (const m of ['Todos', 'USA', 'Australia']) html += `<th colspan="3" ${th}>${m}</th>`;
  html += `</tr><tr><th></th>${['all', 'usa', 'australia'].map(() => `<th ${th}>Semana</th><th ${th}>Anterior</th><th ${th}>Δ</th>`).join('')}</tr>`;
  for (const [label, key, d] of rows) {
    html += `<tr><td style="padding:4px 8px">${label}</td>${cell('all', key, d)}${cell('usa', key, d)}${cell('australia', key, d)}</tr>`;
  }
  return { html: html + '</table>', big };
}

function buildHtml(f: any, from: string, to: string, a: ReturnType<typeof analyse>, test: boolean) {
  const nums = numbersTable(f.ecommerce);
  const list = (items: string[], color: string) =>
    `<ul style="margin:6px 0 14px;padding-left:20px">${items.map((i) => `<li style="margin:4px 0;color:${color}">${i}</li>`).join('')}</ul>`;
  const h = (t: string) => `<h3 style="margin:22px 0 6px;font-size:16px">${t}</h3>`;
  const xero = (f.xero?.reconcile ?? []) as any[];
  const cc = f.shopify?.countCheck;

  let html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:760px;color:#111827;font-size:14px;line-height:1.45">`;
  if (test) html += `<p style="background:#fef3c7;padding:6px 10px">PRUEBA: este mail es una prueba del informe semanal.</p>`;
  html += `<h2 style="margin:0 0 4px;font-size:20px">AIM 2026 · Informe semanal</h2>`;
  html += `<p style="margin:0 0 12px;color:#4b5563">Semana del ${fmtDay(from)} al ${fmtDay(to)} (lunes a domingo, hora Brisbane)</p>`;
  html += a.alerts.length
    ? `<p style="font-size:16px"><b style="color:#b91c1c">${a.alerts.length} ${a.alerts.length === 1 ? 'alerta' : 'alertas'}</b></p>${list(a.alerts, '#b91c1c')}`
    : `<p style="font-size:16px"><b style="color:#15803d">Sin alertas.</b> Los jobs están en verde y los datos cuadran con Xero y Shopify.</p>`;
  if (a.notes.length || nums.big.length) html += h('Para tener en cuenta') + list([...nums.big.map((b) => `Cambio grande: ${esc(b)}`), ...a.notes], '#374151');

  html += h('La semana en números') + nums.html;
  html += `<p style="font-size:12px;color:#6b7280;margin:6px 0 0">Fuente: la misma función que la pestaña E-commerce, para estas fechas. AUD. Net revenue = ventas − descuentos − devoluciones + envío cobrado, sin impuestos. Ad spend = Meta (cuentas USA y Australia), pasado a AUD con la tasa del mes. MER = Net revenue ÷ Ad spend. "Anterior" = los 7 días previos. En negrita: cambios de 20% o más.</p>`;

  html += h('Datos contra la fuente');
  html += `<table style="border-collapse:collapse;font-size:13px"><tr><th style="text-align:left;padding:3px 8px">Xero</th><th style="text-align:right;padding:3px 8px">P&amp;L</th><th style="text-align:right;padding:3px 8px">Líneas</th><th style="text-align:right;padding:3px 8px">Dif.</th></tr>`;
  for (const r of xero) {
    html += `<tr><td style="padding:3px 8px">${esc(r.month)} ${esc(r.account)}${r.closed ? '' : ' (abierto)'}</td><td style="text-align:right;padding:3px 8px">${aud(r.pl, 2)}</td><td style="text-align:right;padding:3px 8px">${aud(r.lines, 2)}</td><td style="text-align:right;padding:3px 8px;color:${Math.abs(Number(r.diff)) > 1 ? '#b91c1c' : '#15803d'}">${aud(r.diff, 2)}</td></tr>`;
  }
  html += `</table>`;
  html += `<p style="font-size:12px;color:#6b7280;margin:4px 0 10px">Freight &amp; Courier y Rates &amp; Taxes: suma de las líneas de cada documento (xero_account_lines) contra el P&amp;L de Xero (xero_pl_monthly), AUD sin GST. Tolerancia A$1.</p>`;
  html += `<table style="border-collapse:collapse;font-size:13px"><tr><th style="text-align:left;padding:3px 8px">Shopify</th><th style="text-align:right;padding:3px 8px">Base</th><th style="text-align:right;padding:3px 8px">Shopify</th></tr>`;
  for (const m of cc?.months ?? []) {
    html += `<tr><td style="padding:3px 8px">${esc(m.month)} (hasta ${fmtDay(m.through)})</td><td style="text-align:right;padding:3px 8px">${num(m.db)}</td><td style="text-align:right;padding:3px 8px;color:${Number(m.diff) !== 0 ? '#b91c1c' : '#15803d'}">${num(m.shopify)}</td></tr>`;
  }
  html += `</table>`;
  html += `<p style="font-size:12px;color:#6b7280;margin:4px 0 0">Órdenes por mes en la base (shopify_sales_lines) contra el conteo de Shopify, todas las órdenes, días Brisbane. Conteo de ${cc?.checkedAt ? esc(new Date(cc.checkedAt).toLocaleString('es-AR', { timeZone: 'Australia/Brisbane' })) : 'nunca'}.</p>`;

  html += h('Último dato por fuente');
  html += `<table style="border-collapse:collapse;font-size:13px">`;
  for (const s of a.fresh) {
    html += `<tr><td style="padding:3px 8px">${esc(s.source)}</td><td style="padding:3px 8px">${s.last ? fmtDay(s.last) : '—'}</td><td style="padding:3px 8px;color:${s.ok ? '#15803d' : s.manual ? '#b45309' : '#b91c1c'}">${s.ok ? 'al día' : s.manual ? 'cargar a mano' : 'atrasado'}</td></tr>`;
  }
  html += `</table>`;

  html += `<p style="font-size:12px;color:#6b7280;margin:22px 0 0">Lo arma la función weekly-health-report cada lunes a las 08:00 (Brisbane) con los datos de la base del dashboard. El estado de cada job está en Connections → Automatic jobs.</p></div>`;
  return html;
}

/** RFC 2822 message, HTML, UTF-8, base64url for the Gmail API. */
function mime(from: string, to: string[], subject: string, html: string) {
  const b64 = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const body = b64(html).replace(/.{76}/g, '$&\r\n');
  const msg = [
    `From: ${from}`, `To: ${to.join(', ')}`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
    'MIME-Version: 1.0', 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', body,
  ].join('\r\n');
  return b64(msg).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function gmailAccessToken(supabase: any, s: any): Promise<string> {
  if (s.access_token && s.access_token_expires_at && Date.parse(s.access_token_expires_at) > Date.now() + 60_000) return s.access_token;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '', client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
      refresh_token: s.refresh_token, grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) throw new Error(`Gmail token refresh ${r.status}: ${(await r.text()).slice(0, 200)} (reconnect with gmail-oauth if invalid_grant)`);
  const j = await r.json();
  await supabase.from('ops_email_settings').update({
    access_token: j.access_token,
    access_token_expires_at: new Date(Date.now() + Number(j.expires_in ?? 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', 1);
  return j.access_token;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ success: false, message: 'POST only' }, 405);
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const body = await req.json().catch(() => ({}));
  const test = body?.test === true;

  // Last week, Monday to Sunday, Brisbane (UTC+10, no daylight saving).
  const today = new Date(Date.now() + 10 * HOUR).toISOString().slice(0, 10);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const to = addDays(today, -(dow === 0 ? 7 : dow));
  const from = addDays(to, -6);

  let reportId: number | null = null;
  try {
    if (test) {
      const { data: recent } = await supabase.from('ops_weekly_reports').select('id')
        .eq('test', true).gte('created_at', new Date(Date.now() - 10 * 60_000).toISOString()).limit(1);
      if (recent?.length) return json({ success: false, message: 'a test was sent less than 10 minutes ago' }, 429);
    } else {
      const { data: done } = await supabase.from('ops_weekly_reports').select('id')
        .eq('week_from', from).eq('test', false).not('sent_at', 'is', null).limit(1);
      if (done?.length) return json({ success: true, skipped: `the report for the week of ${from} was already sent` });
    }

    const { data: findings, error: fErr } = await supabase.rpc('ops_weekly_findings', { p_from: from, p_to: to });
    if (fErr) throw new Error(`findings: ${fErr.message}`);
    const a = analyse(findings, today);
    const html = buildHtml(findings, from, to, a, test);
    const subject = `${test ? '[PRUEBA] ' : ''}AIM 2026 · semana ${fmtDay(from)} – ${fmtDay(to)} · ${a.alerts.length ? `${a.alerts.length} ${a.alerts.length === 1 ? 'alerta' : 'alertas'}` : 'sin alertas'}`;

    const { data: row, error: rErr } = await supabase.from('ops_weekly_reports')
      .insert({ week_from: from, week_to: to, test, subject, alerts: a.alerts.length, findings, html })
      .select('id').single();
    if (rErr) throw new Error(`store report: ${rErr.message}`);
    reportId = row.id;

    const { data: s, error: sErr } = await supabase.from('ops_email_settings').select('*').eq('id', 1).maybeSingle();
    if (sErr) throw new Error(`settings: ${sErr.message}`);
    if (!s?.refresh_token || !s?.sender_email) throw new Error('no Gmail account connected yet (gmail-oauth)');
    const recipients: string[] = s.recipients ?? [];
    if (!recipients.length) throw new Error('no recipients in ops_email_settings');

    const token = await gmailAccessToken(supabase, s);
    const send = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: mime(s.sender_email, recipients, subject, html) }),
    });
    if (!send.ok) throw new Error(`Gmail send ${send.status}: ${(await send.text()).slice(0, 200)}`);

    await supabase.from('ops_weekly_reports').update({ sent_to: recipients, sent_at: new Date().toISOString() }).eq('id', reportId);
    return json({ success: true, week: `${from}..${to}`, test, alerts: a.alerts.length, notes: a.notes.length, sentTo: recipients.length });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.error('weekly-health-report error:', message);
    if (reportId) await supabase.from('ops_weekly_reports').update({ error: message }).eq('id', reportId);
    else await supabase.from('ops_weekly_reports').insert({ week_from: from, week_to: to, test, error: message });
    return json({ success: false, message }, 500);
  }
});
