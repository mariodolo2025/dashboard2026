-- =============================================================================
-- xero_lines_reconcile — watched-account lines vs the P&L, per month
-- =============================================================================
-- docs/PLAN-XERO-DETAIL-SYNC-2026-10-27-v2.md, P3b/P5 (approved 27-oct-2026).
-- Used by xero-sync (nightly re-read of any month off by more than A$1) and
-- by the ops watchdog. Read-only: one row per watched account and month from
-- p_from to the current month. Months with no P&L row count as 0.

create or replace function public.xero_lines_reconcile(p_from date)
returns table (account_name text, month text, pl numeric, lines numeric, diff numeric)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with acc(account_name) as (values ('Freight & Courier'), ('Rates & Taxes')),
  m as (
    select to_char(d, 'YYYY-MM') as month, extract(year from d)::int as y, extract(month from d)::int as mo
    from generate_series(date_trunc('month', p_from)::date,
                         date_trunc('month', (now() at time zone 'Australia/Brisbane'))::date,
                         interval '1 month') d
  ),
  p as (
    select x.account_name, x.year, x.month, sum(x.amount) amt
    from public.xero_pl_monthly x join acc using (account_name)
    group by 1, 2, 3
  ),
  l as (
    select x.account_name, extract(year from x.journal_date)::int y, extract(month from x.journal_date)::int mo,
           sum(x.net_amount) amt
    from public.xero_account_lines x join acc using (account_name)
    where x.journal_date >= date_trunc('month', p_from)::date
    group by 1, 2, 3
  )
  select acc.account_name, m.month,
         round(coalesce(p.amt, 0), 2) as pl,
         round(coalesce(l.amt, 0), 2) as lines,
         round(coalesce(l.amt, 0) - coalesce(p.amt, 0), 2) as diff
  from acc cross join m
  left join p on p.account_name = acc.account_name and p.year = m.y and p.month = m.mo
  left join l on l.account_name = acc.account_name and l.y = m.y and l.mo = m.mo
  order by m.month, acc.account_name;
$function$;

revoke all on function public.xero_lines_reconcile(date) from public, anon, authenticated;
grant execute on function public.xero_lines_reconcile(date) to service_role;
