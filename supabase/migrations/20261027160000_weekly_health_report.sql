-- =============================================================================
-- Weekly health report by email (Mondays 08:00 Brisbane)
-- =============================================================================
-- Asked by Mario on 27-Oct-2026: once a week, check the dashboard's health,
-- compare its data, and email him what was found (mario@dolo.com.au). He chose
-- the server option (runs with his PC off) and Monday 08:00.
--
-- Pieces:
--   ops_email_settings   one row: recipients, the Gmail account that sends
--                        (OAuth refresh token, scope gmail.send), and the
--                        one-time nonce that authorises connecting it.
--   ops_weekly_reports   every report built: dates, findings, HTML, outcome.
--   ops_weekly_findings  all the reads of one report in one call (bounded:
--                        one week, a fixed set of sources).
--   edge functions       gmail-oauth (connects the sender, no JWT: Google's
--                        redirect carries none; refuses without the nonce)
--                        and weekly-health-report (builds, sends, stores).
--   cron                 weekly-health-report, Sunday 22:00 UTC = Monday 08:00
--                        Brisbane, through ops_http_post, watched in ops_jobs.
-- Tokens and reports are readable only by the service role.

create table if not exists public.ops_email_settings (
  id                      integer primary key default 1 check (id = 1),
  recipients              text[] not null,
  sender_email            text,
  refresh_token           text,
  access_token            text,
  access_token_expires_at timestamptz,
  connect_nonce           text,
  connect_nonce_expires_at timestamptz,
  updated_at              timestamptz not null default now()
);
alter table public.ops_email_settings enable row level security;
revoke all on table public.ops_email_settings from anon, authenticated;
drop policy if exists "ops_email_settings service" on public.ops_email_settings;
create policy "ops_email_settings service" on public.ops_email_settings
  for all to service_role using (true) with check (true);
insert into public.ops_email_settings (id, recipients) values (1, array['mario@dolo.com.au'])
on conflict (id) do nothing;

create table if not exists public.ops_weekly_reports (
  id          bigint generated always as identity primary key,
  week_from   date not null,
  week_to     date not null,
  test        boolean not null default false,
  subject     text,
  alerts      integer,
  findings    jsonb,
  html        text,
  sent_to     text[],
  sent_at     timestamptz,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists ops_weekly_reports_week_idx on public.ops_weekly_reports (week_from, test);
alter table public.ops_weekly_reports enable row level security;
revoke all on table public.ops_weekly_reports from anon, authenticated;
drop policy if exists "ops_weekly_reports service" on public.ops_weekly_reports;
create policy "ops_weekly_reports service" on public.ops_weekly_reports
  for all to service_role using (true) with check (true);

create or replace function public.ops_weekly_findings(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '90s'
as $function$
declare
  t0    timestamptz := p_from::timestamp at time zone 'Australia/Brisbane';
  t1    timestamptz := (p_to + 1)::timestamp at time zone 'Australia/Brisbane';
  today date := (now() at time zone 'Australia/Brisbane')::date;
  r     jsonb := jsonb_build_object('from', p_from, 'to', p_to, 'builtAt', now());
begin
  -- 1. Automatic jobs failing right now (watchdog state).
  r := r || jsonb_build_object('failingNow', coalesce((
    select jsonb_agg(jsonb_build_object('job', s.jobname, 'label', coalesce(o.label, s.jobname),
             'state', s.state, 'since', s.failing_since, 'detail', s.last_error) order by s.jobname)
    from public.ops_job_status s left join public.ops_jobs o on o.jobname = s.jobname
    where s.state in ('failing', 'paused')), '[]'::jsonb));

  -- 2. Failures during the week, recovered or not: HTTP answers (ops_http_calls)
  --    and pg_cron runs (bounded to the last 30,000 runs).
  r := r || jsonb_build_object('weekFailures', coalesce((
    select jsonb_agg(x order by x->>'label') from (
      select jsonb_build_object('job', c.jobname, 'label', coalesce(o.label, c.jobname), 'failures', count(*),
               'lastError', left((array_agg(c.error order by c.called_at desc))[1], 200)) x
      from public.ops_http_calls c left join public.ops_jobs o on o.jobname = c.jobname
      where c.called_at >= t0 and c.called_at < t1 and c.ok = false
      group by c.jobname, o.label
      union all
      select jsonb_build_object('job', j.jobname, 'label', coalesce(o.label, j.jobname), 'failures', count(*),
               'lastError', left((array_agg(d.return_message order by d.start_time desc))[1], 200))
      from cron.job_run_details d
      join cron.job j on j.jobid = d.jobid
      left join public.ops_jobs o on o.jobname = j.jobname
      where d.runid > (select max(runid) - 30000 from cron.job_run_details)
        and d.start_time >= t0 and d.start_time < t1 and d.status = 'failed'
      group by j.jobname, o.label) y), '[]'::jsonb));

  -- 3. Auto-refresh (sync_runs): runs of the week and the steps that failed.
  r := r || jsonb_build_object('syncRuns', jsonb_build_object(
    'runs',   (select count(*) from public.sync_runs where started_at >= t0 and started_at < t1),
    'errors', (select count(*) from public.sync_runs where started_at >= t0 and started_at < t1 and status = 'error'),
    'failedSteps', coalesce((
      select jsonb_agg(jsonb_build_object('step', step, 'failures', n, 'lastError', msg) order by n desc)
      from (select s->>'name' step, count(*) n,
                   left((array_agg(s->>'message' order by sr.started_at desc))[1], 200) msg
            from public.sync_runs sr
            cross join jsonb_array_elements(case jsonb_typeof(sr.steps) when 'array' then sr.steps else '[]'::jsonb end) s
            where sr.started_at >= t0 and sr.started_at < t1 and s->>'status' = 'error'
            group by 1) z), '[]'::jsonb)));

  -- 4. Xero: freight & rates lines vs the P&L (last 3 months + current),
  --    the last sync, and the monthly independent check.
  r := r || jsonb_build_object('xero', jsonb_build_object(
    'reconcile', coalesce((
      select jsonb_agg(jsonb_build_object('month', x.month, 'account', x.account_name, 'pl', x.pl,
               'lines', x.lines, 'diff', x.diff,
               'closed', (to_date(x.month, 'YYYY-MM') + interval '1 month 14 days')::date <= today)
             order by x.month, x.account_name)
      from public.xero_lines_reconcile(greatest(date '2026-07-01',
             (date_trunc('month', today) - interval '3 months')::date)) x), '[]'::jsonb),
    'lastSync', (select value - 'summary' from public.xero_sync_state where key = 'last_sync'),
    'monthlyVerification', (select value from public.xero_sync_state where key = 'monthly_verification')));

  -- 5. Shopify: orders per month vs Shopify, the sync's last run, orders
  --    pruned this week (deleted in Shopify).
  r := r || jsonb_build_object('shopify', jsonb_build_object(
    'countCheck', (select count_check from public.shopify_sales_sync_state where id = 1),
    'lastRun', (select jsonb_build_object('at', last_run_at, 'status', last_run_status)
                from public.shopify_sales_sync_state where id = 1),
    'prunedThisWeek', (select jsonb_build_object('orders', count(distinct order_id), 'netUsd', coalesce(sum(net_usd), 0))
                       from backup.shopify_sales_lines_pruned where pruned_at >= t0 and pruned_at < t1)));

  -- 6. Freshness: newest data per source, and how old it may be.
  r := r || jsonb_build_object('freshness', jsonb_build_array(
    jsonb_build_object('source', 'Shopify sales', 'last',
      (select max(order_date) from public.shopify_sales_lines where source = 'api'), 'maxAgeDays', 1),
    -- Unleashed carries orders dated in the future: its last sync, not its newest date.
    jsonb_build_object('source', 'Unleashed sales (last sync)', 'last',
      (select (max(synced_at) at time zone 'Australia/Brisbane')::date from public.unleashed_sales_lines where source = 'api'), 'maxAgeDays', 1),
    jsonb_build_object('source', 'Meta ads', 'last',
      (select max(date) from public.meta_ads_daily), 'maxAgeDays', 2),
    jsonb_build_object('source', 'Google ads (entered by hand)', 'last',
      (select max(date) from public.google_ads_daily where spend_aud is not null), 'maxAgeDays', 10, 'manual', true),
    jsonb_build_object('source', 'Xero P&L', 'last',
      (select (max(synced_at) at time zone 'Australia/Brisbane')::date from public.xero_pl_monthly), 'maxAgeDays', 1),
    jsonb_build_object('source', 'Web Upgrade events', 'last',
      (select (received_at at time zone 'Australia/Brisbane')::date from public.upgrade_events order by id desc limit 1), 'maxAgeDays', 0),
    jsonb_build_object('source', 'USD→AUD rate (this month)', 'last',
      (select make_date(year, month, 1) from public.currency_exchange_rates
        where year = extract(year from today)::int and month = extract(month from today)::int),
      'maxAgeDays', 40)));

  -- 7. The week in numbers, from the E-commerce tab's own function (same
  --    numbers as the screen for these dates; the tab also passes margin
  --    0.45), all markets and per market ('usa', 'australia').
  r := r || jsonb_build_object('ecommerce', jsonb_build_object(
    'all', (select jsonb_build_object('kpis', d->'kpis', 'prior', d->'prior')
            from (select public.ecommerce_dashboard(p_from, p_to, 'all', 0.45, 'day') d) a),
    'usa', (select jsonb_build_object('kpis', d->'kpis', 'prior', d->'prior')
            from (select public.ecommerce_dashboard(p_from, p_to, 'usa', 0.45, 'day') d) a),
    'australia', (select jsonb_build_object('kpis', d->'kpis', 'prior', d->'prior')
            from (select public.ecommerce_dashboard(p_from, p_to, 'australia', 0.45, 'day') d) a)));

  return r;
end
$function$;
revoke all on function public.ops_weekly_findings(date, date) from public, anon, authenticated;
grant execute on function public.ops_weekly_findings(date, date) to service_role;

insert into public.ops_jobs (jobname, label, kind, via_http, optional, fail_threshold, http_timeout_ms, note) values
  ('weekly-health-report', 'Weekly health email (Mon 08:00)', 'cron', true, false, 1, 120000,
   'Builds the weekly health report (jobs, data vs Xero and Shopify, freshness, the week in numbers) and emails it to the recipients in ops_email_settings.')
on conflict (jobname) do update set label = excluded.label, kind = excluded.kind, via_http = excluded.via_http,
  fail_threshold = excluded.fail_threshold, http_timeout_ms = excluded.http_timeout_ms, note = excluded.note;

-- Same Authorization header as shopify-sales-fast (the public anon key), so no
-- key is written in this file.
do $$
declare k text;
begin
  select substring(command from 'Bearer ([A-Za-z0-9._-]+)') into k from cron.job where jobname = 'shopify-sales-fast';
  if k is null then raise exception 'no Authorization header found in shopify-sales-fast'; end if;
  perform cron.schedule('weekly-health-report', '0 22 * * 0', format(
    $c$select public.ops_http_post('weekly-health-report', url:='https://teewkafclgpfpczftvah.supabase.co/functions/v1/weekly-health-report', headers:=jsonb_build_object('Authorization','Bearer %s','Content-Type','application/json'), body:='{}'::jsonb);$c$, k));
end $$;
