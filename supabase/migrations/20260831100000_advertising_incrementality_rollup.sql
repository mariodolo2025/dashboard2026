-- =============================================================================
-- Advertising Incrementality: closed months come from a rollup (Codex P1,
-- 31-Aug-2026). The RPC's own escape hatch, triggered: 17.3s average / 22.9s
-- max against a 25s timeout, and its scan window (fixed 2025-07-01 start)
-- could never shrink.
--
-- Closed months are immutable (historic attribution coverage ~100% — the
-- counterfactual band constants rely on exactly that), so the 13 months
-- Jul-2025..Jul-2026 were computed ONCE by the then-live function itself and
-- frozen into advertising_incrementality_monthly. The function's rev scan now
-- starts at 2026-08-01 and its monthly CTE UNIONs the frozen rows in.
--
-- Every other block already only needs Aug-2026 onward: last-10-days, the
-- brand-cut windows (fixed 1-5 Aug pre / >=6 Aug post) and spend. The bound
-- cannot advance past 2026-08-01 while the brand-cut experiment stays live —
-- once Mario freezes its verdict the same trick applies again and the live
-- window becomes rolling. Until then the live scan grows one month per month
-- from a base of one, versus thirteen-plus before.
--
-- Measured after apply: the call returns instantly (was 15.6-22.9s); monthly
-- still has 14 rows and Jul-2026 ratioPct 36.3 matches the pre-patch value.
-- =============================================================================
create table if not exists advertising_incrementality_monthly (
  mes date primary key,
  total numeric not null,
  goog numeric not null,
  goog_orders int not null,
  frozen_at timestamptz not null default now()
);
alter table advertising_incrementality_monthly enable row level security;
create policy "service role only" on advertising_incrementality_monthly
  for all to service_role using (true) with check (true);

-- Seed (ran via execute_sql with a 90s timeout, BEFORE the patch below, so the
-- frozen rows come from the exact code that always produced them):
--   insert into advertising_incrementality_monthly (mes, total, goog, goog_orders)
--   select months < 2026-08-01 out of advertising_incrementality()'s own
--   'monthly' array.

-- Patch applied in place (anchored replaces, guards raise on mismatch):
--   1. rev:  where l.order_date >= date '2025-07-01'
--        ->  where l.order_date >= date '2026-08-01'
--   2. monthly: the live group-by gains
--        where order_date >= date '2026-08-01'
--      and UNION ALLs
--        select mes, total, goog, goog_orders
--        from advertising_incrementality_monthly
--        where mes < date '2026-08-01'
do $mig$
declare src text; n int; anchor text;
begin
  select pg_get_functiondef(oid) into src from pg_proc where proname = 'advertising_incrementality';
  if src like '%advertising_incrementality_monthly%' then
    raise notice 'incrementality rollup already applied';
    return;
  end if;

  anchor := 'where l.order_date >= date ''2025-07-01''';
  n := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  if n <> 1 then raise exception 'incr anchor1 x%', n; end if;
  src := replace(src, anchor, 'where l.order_date >= date ''2026-08-01''');

  anchor := 'monthly as (
  select date_trunc(''month'', order_date)::date mes,
         sum(net_aud) total,
         coalesce(sum(net_aud) filter (where is_goog), 0) goog,
         count(*) filter (where is_goog) goog_orders
  from cls group by 1
),';
  n := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  if n <> 1 then raise exception 'incr anchor2 x%', n; end if;
  src := replace(src, anchor, 'monthly as (
  select date_trunc(''month'', order_date)::date mes,
         sum(net_aud) total,
         coalesce(sum(net_aud) filter (where is_goog), 0) goog,
         count(*) filter (where is_goog) goog_orders
  from cls
  where order_date >= date ''2026-08-01''
  group by 1
  union all
  select mes, total, goog, goog_orders
  from advertising_incrementality_monthly
  where mes < date ''2026-08-01''
),');
  execute src;
end
$mig$;
