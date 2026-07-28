-- =============================================================================
-- B2C Sales Explorer — per-SKU Shopify stats
-- =============================================================================
-- Answers "type a SKU, see what it did on Shopify" in one round trip.
--
-- Currency: shopify_sales_lines.net_native spans 43 currencies (AUD, USD, JPY,
-- KRW, …), so summing it is meaningless. Everything here converts net_usd to AUD
-- with currency_exchange_rates — the same per-month rate the rest of the
-- dashboard already uses — so the figures reconcile with the other tabs.

-- Rate per month, falling back to the most recent known rate for months the
-- table has not been filled for yet.
create or replace function public.usd_to_aud_rate(p_date date)
returns numeric
language sql
stable
as $fn$
  select coalesce(
    (select rate from public.currency_exchange_rates
      where year = extract(year from p_date)::int
        and month = extract(month from p_date)::int
      limit 1),
    (select rate from public.currency_exchange_rates
      order by year desc, month desc
      limit 1),
    1.44
  );
$fn$;

comment on function public.usd_to_aud_rate(date) is
  'USD→AUD rate for the month of p_date, from currency_exchange_rates; falls back to the latest known rate.';

-- SKUs that have ever sold on Shopify, for the search box.
create or replace function public.shopify_sku_list()
returns table (sku text, product_title text, units numeric, last_sale date)
language sql
stable
security definer
set search_path = public
as $fn$
  select sku,
         max(product_title)      as product_title,
         sum(quantity)           as units,
         max(order_date)         as last_sale
  from public.shopify_sales_lines
  where coalesce(sku, '') <> ''
  group by sku
  order by units desc;
$fn$;

grant execute on function public.shopify_sku_list() to authenticated, service_role;

-- Everything the explorer shows for one SKU over one window, in a single jsonb.
create or replace function public.shopify_sku_stats(
  p_sku  text,
  p_from date,
  p_to   date
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
  v_result    jsonb;
begin
  if p_sku is null or p_from is null or p_to is null then
    raise exception 'sku, from and to are all required';
  end if;

  -- Comparison window: the same number of days immediately before p_from, so
  -- "last 30 days" is judged against the 30 before it, not a calendar month.
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
    where l.sku = p_sku
      and l.order_date between v_prev_from and p_to
  ),
  cur as (select * from lines where order_date between p_from and p_to),
  prev as (select * from lines where order_date between v_prev_from and v_prev_to),
  cur_totals as (
    select coalesce(sum(quantity), 0)              as units,
           count(distinct order_id)                as orders,
           coalesce(sum(gross_aud), 0)             as gross_aud,
           coalesce(sum(discounts_aud), 0)         as discounts_aud,
           coalesce(sum(returns_aud), 0)           as returns_aud,
           coalesce(sum(net_aud), 0)               as net_aud
    from cur
  ),
  prev_totals as (
    select coalesce(sum(quantity), 0)  as units,
           count(distinct order_id)    as orders,
           coalesce(sum(net_aud), 0)   as net_aud
    from prev
  ),
  monthly as (
    select to_char(date_trunc('month', order_date), 'YYYY-MM') as month,
           sum(quantity)                                        as units,
           round(sum(net_aud)::numeric, 2)                      as net_aud
    from cur group by 1 order by 1
  ),
  countries as (
    select coalesce(nullif(trim(country), ''), 'Unknown') as country,
           sum(quantity)                                  as units,
           round(sum(net_aud)::numeric, 2)                as net_aud
    from cur group by 1 order by units desc limit 15
  ),
  recent as (
    select order_date, coalesce(nullif(trim(country), ''), 'Unknown') as country,
           quantity, round(net_aud::numeric, 2) as net_aud, currency
    from cur order by order_date desc, order_id desc limit 25
  )
  select jsonb_build_object(
    'sku', p_sku,
    'productTitle', (select max(product_title) from cur),
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
        -- What a unit actually realised after discounts and returns.
        'avgNetPriceAud', case when units > 0
                               then round((net_aud / units)::numeric, 2)
                               else null end
      ) from cur_totals
    ),
    'previous', (
      select jsonb_build_object(
        'units', units,
        'orders', orders,
        'netAud', round(net_aud::numeric, 2)
      ) from prev_totals
    ),
    'monthly', coalesce((select jsonb_agg(to_jsonb(m)) from monthly m), '[]'::jsonb),
    'countries', coalesce((select jsonb_agg(to_jsonb(c)) from countries c), '[]'::jsonb),
    'recentOrders', coalesce((select jsonb_agg(to_jsonb(r)) from recent r), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$fn$;

comment on function public.shopify_sku_stats(text, date, date) is
  'Shopify sales for one SKU over a window: totals, the equivalent previous window, monthly series, countries and recent orders. All money in AUD.';

grant execute on function public.shopify_sku_stats(text, date, date) to authenticated, service_role;
