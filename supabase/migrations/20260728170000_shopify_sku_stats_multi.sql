-- =============================================================================
-- B2C Sales Explorer v2 — several SKUs at once, day/week/month series
-- =============================================================================
-- The single-SKU shopify_sku_stats stays in place; the app calls this one.

create or replace function public.shopify_sku_stats_multi(
  p_skus        text[],
  p_from        date,
  p_to          date,
  p_granularity text default 'month'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_days      int;
  v_prev_from date;
  v_prev_to   date;
  v_trunc     text;
  v_result    jsonb;
begin
  if p_skus is null or array_length(p_skus, 1) is null then
    raise exception 'at least one sku is required';
  end if;
  if p_from is null or p_to is null then
    raise exception 'from and to are required';
  end if;

  v_trunc := case lower(coalesce(p_granularity, 'month'))
               when 'day'   then 'day'
               when 'week'  then 'week'
               else 'month'
             end;

  -- Comparison window: the same number of days immediately before p_from.
  v_days      := (p_to - p_from) + 1;
  v_prev_to   := p_from - 1;
  v_prev_from := v_prev_to - (v_days - 1);

  with lines as (
    select l.*,
           l.net_usd       * usd_to_aud_rate(l.order_date) as net_aud,
           l.gross_usd     * usd_to_aud_rate(l.order_date) as gross_aud,
           l.discounts_usd * usd_to_aud_rate(l.order_date) as discounts_aud,
           l.returns_usd   * usd_to_aud_rate(l.order_date) as returns_aud
    from public.shopify_sales_lines l
    where l.sku = any(p_skus)
      and l.order_date between v_prev_from and p_to
  ),
  cur  as (select * from lines where order_date between p_from and p_to),
  prev as (select * from lines where order_date between v_prev_from and v_prev_to),
  cur_totals as (
    select coalesce(sum(quantity), 0)      as units,
           count(distinct order_id)        as orders,
           coalesce(sum(gross_aud), 0)     as gross_aud,
           coalesce(sum(discounts_aud), 0) as discounts_aud,
           coalesce(sum(returns_aud), 0)   as returns_aud,
           coalesce(sum(net_aud), 0)       as net_aud
    from cur
  ),
  prev_totals as (
    select coalesce(sum(quantity), 0) as units,
           count(distinct order_id)   as orders,
           coalesce(sum(net_aud), 0)  as net_aud
    from prev
  ),
  series as (
    select to_char(date_trunc(v_trunc, order_date), 'YYYY-MM-DD') as bucket,
           sum(quantity)                                          as units,
           round(sum(net_aud)::numeric, 2)                        as net_aud,
           count(distinct order_id)                               as orders
    from cur group by 1 order by 1
  ),
  per_sku as (
    select sku,
           max(product_title)              as product_title,
           sum(quantity)                   as units,
           round(sum(net_aud)::numeric, 2) as net_aud,
           count(distinct order_id)        as orders
    from cur group by sku order by units desc
  ),
  countries as (
    select coalesce(nullif(trim(country), ''), 'Unknown') as country,
           sum(quantity)                                  as units,
           round(sum(net_aud)::numeric, 2)                as net_aud
    from cur group by 1 order by units desc limit 15
  ),
  recent as (
    select order_date, sku,
           coalesce(nullif(trim(country), ''), 'Unknown') as country,
           quantity, round(net_aud::numeric, 2) as net_aud, currency
    from cur order by order_date desc, order_id desc limit 30
  )
  select jsonb_build_object(
    'skus', to_jsonb(p_skus),
    'granularity', v_trunc,
    'from', p_from,
    'to', p_to,
    'previousFrom', v_prev_from,
    'previousTo', v_prev_to,
    'summary', (
      select jsonb_build_object(
        'units', units,
        'orders', orders,
        'grossAud', round(gross_aud::numeric, 2),
        'discountsAud', round(discounts_aud::numeric, 2),
        'returnsAud', round(returns_aud::numeric, 2),
        'netAud', round(net_aud::numeric, 2),
        'avgNetPriceAud', case when units > 0
                               then round((net_aud / units)::numeric, 2)
                               else null end
      ) from cur_totals
    ),
    'previous', (
      select jsonb_build_object('units', units, 'orders', orders,
                                'netAud', round(net_aud::numeric, 2))
      from prev_totals
    ),
    'series',       coalesce((select jsonb_agg(to_jsonb(s)) from series s), '[]'::jsonb),
    'perSku',       coalesce((select jsonb_agg(to_jsonb(p)) from per_sku p), '[]'::jsonb),
    'countries',    coalesce((select jsonb_agg(to_jsonb(c)) from countries c), '[]'::jsonb),
    'recentOrders', coalesce((select jsonb_agg(to_jsonb(r)) from recent r), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$fn$;

comment on function public.shopify_sku_stats_multi(text[], date, date, text) is
  'Shopify sales for one or more SKUs over a window: totals, the equivalent previous window, a day/week/month series, a per-SKU breakdown, countries and recent orders. All money in AUD.';

grant execute on function public.shopify_sku_stats_multi(text[], date, date, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2026-07-28 · adds the USD figure alongside every AUD one.
-- USD is what the source rows are normalised to (net_usd); AUD is the converted
-- view the dashboard reports in. Returning both lets a number be checked against
-- Shopify without reversing the conversion. Applied as migration
-- 'shopify_sku_stats_multi_usd' — same function body as above plus:
--   summary:  grossUsd, discountsUsd, returnsUsd, netUsd, avgNetPriceUsd
--   previous: netUsd
--   series / perSku / countries / recentOrders: net_usd

-- -----------------------------------------------------------------------------
-- 2026-07-29 · gap-filled series (migration 'shopify_sku_stats_multi_gapfill').
-- The series only carried buckets that had sales, so a day with none simply did
-- not exist: a 7-day window rendered as 2 bars side by side, and the trend line —
-- a moving average over points that are not adjacent in time — was meaningless.
-- Every bucket in the range is now emitted, zero-filled, via
--   buckets as (select generate_series(date_trunc(v_trunc, p_from), 
--                                      date_trunc(v_trunc, p_to), v_step)::date)
-- left joined to the aggregate. Same totals, honest shape.

-- -----------------------------------------------------------------------------
-- 2026-07-29 · whole store (migration 'shopify_sku_stats_multi_whole_store').
-- An empty/NULL p_skus now means "every SKU" instead of raising, so the explorer
-- answers "how is the store doing" before you narrow to a product. Adds
-- `wholeStore` and `skuCount` to the payload, and caps perSku at 20 rows ordered
-- by units — unbounded it returned every SKU that sold in the range.

-- -----------------------------------------------------------------------------
-- 2026-07-29 · native AUD basis (migration 'shopify_line_aud_native_basis').
-- The AUD figures were a round trip: an Australian order arrives as AUD, the sync
-- converts it to USD, and the RPC converted it back at a monthly average — so an
-- amount already held exactly came back approximated, while net_native (what was
-- actually charged) was never read. New helper shopify_line_aud_factor() gives a
-- per-row USD->AUD multiplier: AUD orders resolve to net_native exactly, other
-- currencies use the order's own rate (net_usd_orderrate) instead of a monthly
-- average of a monthly average. One factor per row, so
-- gross - discounts - returns = net still holds.
--
-- Effect is small in dollars — the same monthly rate was applied in both
-- directions and nearly cancelled: over 12 months AUD lands on 2,488,816.12
-- against 2,488,814.12 before. It is a correctness fix, not a restatement.
