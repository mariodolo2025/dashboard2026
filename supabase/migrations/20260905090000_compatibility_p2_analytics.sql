-- Compatibility P2 analytics — isolated from the V3 rollups and from the raw
-- event retention. P2 replaced V3 as the live Compatibility page on 2026-09-04;
-- its theme events carry context = 'compatibility_p2' and a flow_id that is new
-- on every page load (the Custom Pixel forwards flow_id since 2026-09-05 08:18
-- AEST). An event is P2 ONLY by context — never by action, page_path or source,
-- because those also appear on V3 history and on product pages.
--
-- Pieces:
--   1. web_upgrade_p2_events — one row per P2 event, fed by an exception-safe
--      AFTER INSERT/UPDATE trigger on upgrade_events. It is NOT touched by the
--      14-day purge of upgrade_events (no DELETE branch, no FK), so the P2
--      funnel survives the raw retention.
--   2. upgrade_order_attribution gains pesado_flow_id / pesado_context so a
--      paid line can be tied back to the exact page load that added it.
--   3. web_upgrade_p2_performance(p_from, p_to, p_environment) — the only reader.
--      Revenue is prorated by quantity against shopify_sales_lines so a SKU that
--      appears on several attribution rows is never counted twice.

-- ── 1. P2 event store ──────────────────────────────────────────────────────
create table if not exists public.web_upgrade_p2_events (
  event_id        bigint primary key,
  ts              timestamptz not null,
  d               date not null,            -- UTC day (events calendar)
  environment     text,
  action          text,
  attribution_id  text,
  flow_id         text,
  brand           text,
  model           text,                     -- payload.machine
  product_id      text,
  product_handle  text,
  variant_id      text,
  sku             text,
  rank            integer,
  quantity        integer,
  source          text,
  result_type     text,
  error_code      text,
  page_path       text
);
alter table public.web_upgrade_p2_events enable row level security;
revoke all on public.web_upgrade_p2_events from public, anon, authenticated;

create index if not exists wu_p2_env_d_action_flow_idx on public.web_upgrade_p2_events (environment, d, action, flow_id);
create index if not exists wu_p2_env_d_brand_model_idx on public.web_upgrade_p2_events (environment, d, brand, model);
create index if not exists wu_p2_flow_idx on public.web_upgrade_p2_events (flow_id);

create or replace function public.web_upgrade_p2_events_sync()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_ts timestamptz := coalesce(new.event_timestamp, new.received_at, now());
begin
  if new.payload->>'context' is distinct from 'compatibility_p2' then
    return null;
  end if;
  -- Best-effort: a failure here must never block the ingest of upgrade_events.
  begin
    insert into public.web_upgrade_p2_events as t (
      event_id, ts, d, environment, action, attribution_id, flow_id, brand, model,
      product_id, product_handle, variant_id, sku, rank, quantity, source, result_type, error_code, page_path)
    values (
      new.id, v_ts, (v_ts at time zone 'UTC')::date, new.environment, new.action, new.attribution_id,
      nullif(new.payload->>'flow_id', ''),
      nullif(new.payload->>'brand', ''),
      nullif(new.payload->>'machine', ''),
      nullif(new.payload->>'product_id', ''),
      nullif(new.payload->>'product_handle', ''),
      nullif(new.payload->>'variant_id', ''),
      nullif(new.payload->>'sku', ''),
      case when new.payload->>'rank' ~ '^\d+$' then (new.payload->>'rank')::int end,
      case when new.payload->>'quantity' ~ '^\d+$' then (new.payload->>'quantity')::int end,
      nullif(new.payload->>'source', ''),
      nullif(new.payload->>'result_type', ''),
      nullif(new.payload->>'error_code', ''),
      nullif(new.payload->>'page_path', ''))
    on conflict (event_id) do update set
      ts = excluded.ts, d = excluded.d, environment = excluded.environment, action = excluded.action,
      attribution_id = excluded.attribution_id, flow_id = excluded.flow_id, brand = excluded.brand,
      model = excluded.model, product_id = excluded.product_id, product_handle = excluded.product_handle,
      variant_id = excluded.variant_id, sku = excluded.sku, rank = excluded.rank, quantity = excluded.quantity,
      source = excluded.source, result_type = excluded.result_type, error_code = excluded.error_code,
      page_path = excluded.page_path;
  exception when others then
    raise warning 'web_upgrade_p2_events_sync skipped event %: %', new.id, sqlerrm;
  end;
  return null;
end
$$;

drop trigger if exists upgrade_events_p2_trg on public.upgrade_events;
create trigger upgrade_events_p2_trg
  after insert or update on public.upgrade_events
  for each row
  when (new.payload->>'context' = 'compatibility_p2')
  execute function public.web_upgrade_p2_events_sync();

-- Idempotent backfill of the P2 events still present in the raw table.
insert into public.web_upgrade_p2_events as t (
  event_id, ts, d, environment, action, attribution_id, flow_id, brand, model,
  product_id, product_handle, variant_id, sku, rank, quantity, source, result_type, error_code, page_path)
select
  e.id,
  coalesce(e.event_timestamp, e.received_at),
  (coalesce(e.event_timestamp, e.received_at) at time zone 'UTC')::date,
  e.environment, e.action, e.attribution_id,
  nullif(e.payload->>'flow_id', ''),
  nullif(e.payload->>'brand', ''),
  nullif(e.payload->>'machine', ''),
  nullif(e.payload->>'product_id', ''),
  nullif(e.payload->>'product_handle', ''),
  nullif(e.payload->>'variant_id', ''),
  nullif(e.payload->>'sku', ''),
  case when e.payload->>'rank' ~ '^\d+$' then (e.payload->>'rank')::int end,
  case when e.payload->>'quantity' ~ '^\d+$' then (e.payload->>'quantity')::int end,
  nullif(e.payload->>'source', ''),
  nullif(e.payload->>'result_type', ''),
  nullif(e.payload->>'error_code', ''),
  nullif(e.payload->>'page_path', '')
from public.upgrade_events e
where e.payload->>'context' = 'compatibility_p2'
on conflict (event_id) do update set
  ts = excluded.ts, d = excluded.d, environment = excluded.environment, action = excluded.action,
  attribution_id = excluded.attribution_id, flow_id = excluded.flow_id, brand = excluded.brand,
  model = excluded.model, product_id = excluded.product_id, product_handle = excluded.product_handle,
  variant_id = excluded.variant_id, sku = excluded.sku, rank = excluded.rank, quantity = excluded.quantity,
  source = excluded.source, result_type = excluded.result_type, error_code = excluded.error_code,
  page_path = excluded.page_path;

-- ── 2. Order attribution: the page load that placed the line ──────────────
alter table public.upgrade_order_attribution
  add column if not exists pesado_flow_id text,
  add column if not exists pesado_context text;
create index if not exists upgrade_oa_parent_date_flow_idx
  on public.upgrade_order_attribution (pesado_parent_product, order_date, pesado_flow_id);

-- ── 3. Reader ──────────────────────────────────────────────────────────────
create or replace function public.web_upgrade_p2_performance(
  p_from date,
  p_to date,
  p_environment text default 'production'
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '20s'
as $function$
with
env as (select coalesce(nullif(p_environment, ''), 'production') v),
fxlast as (select rate from currency_exchange_rates order by year desc, month desc limit 1),
-- P2 events in the window (UTC days)
ev as (
  select *
  from web_upgrade_p2_events
  where d between p_from and p_to
    and ((select v from env) = 'all' or environment = (select v from env))
),
-- only events that can be tied to a page load count in the funnel
evf as (select * from ev where flow_id is not null),
fl as (
  select flow_id,
    bool_or(action = 'compatibility_page_view')    pv,
    bool_or(action = 'compatibility_data_ready')   ready,
    bool_or(action = 'compatibility_data_error')   derr,
    bool_or(action = 'compatibility_brand_open')   brand,
    bool_or(action = 'compatibility_model_select') model,
    bool_or(action = 'compatibility_product_open') popen,
    bool_or(action = 'compatibility_add_click')    aclick,
    bool_or(action = 'compatibility_add_success')  asucc,
    bool_or(action = 'compatibility_add_error')    aerr,
    count(*) filter (where action = 'compatibility_add_click')   click_n,
    count(*) filter (where action = 'compatibility_add_success') succ_n,
    count(*) filter (where action = 'compatibility_add_error')   err_n
  from evf
  group by flow_id
),
fn as (
  select
    count(*)                          flows,
    count(*) filter (where pv)        pv_flows,
    count(*) filter (where ready)     ready_flows,
    count(*) filter (where derr)      err_flows,
    count(*) filter (where brand)     brand_flows,
    count(*) filter (where model)     model_flows,
    count(*) filter (where popen)     popen_flows,
    count(*) filter (where aclick)    aclick_flows,
    count(*) filter (where asucc)     asucc_flows,
    count(*) filter (where aerr)      aerr_flows,
    coalesce(sum(click_n), 0)         click_attempts,
    coalesce(sum(succ_n), 0)          succ_attempts,
    coalesce(sum(err_n), 0)           err_attempts
  from fl
),
-- Paid lines placed by P2. A line is P2 only by its private properties; a null
-- context is tolerated ONLY together with the P2 parent product (first live
-- days, before the theme wrote _pesado_context) and is reported in dataQuality.
p2l as (
  select a.order_id, a.order_date, a.sku,
    nullif(a.pesado_flow_id, '') flow_id,
    nullif(btrim(a.pesado_machine), '') machine,
    a.pesado_context ctx,
    sum(a.quantity) qty
  from upgrade_order_attribution a
  where a.pesado_parent_product = 'compatibility-guide-p2'
    and a.pesado_source = 'compatibility_guide'
    and (a.pesado_context = 'compatibility_p2' or a.pesado_context is null)
    and a.order_date between p_from and p_to
    and ((select v from env) = 'all' or a.pesado_environment = (select v from env))
  group by 1, 2, 3, 4, 5, 6
),
p2tot as (select order_id, sku, sum(qty) p2_qty from p2l group by 1, 2),
-- The Shopify line for the same order+sku, aggregated once (the sales table
-- splits by country; the attribution table can repeat a sku).
shop as (
  select l.order_id, l.sku,
    sum(l.quantity) qty,
    sum(case when l.currency = 'AUD' then l.net_native else l.net_usd * coalesce(r.rate, (select rate from fxlast)) end) net_aud,
    max(l.product_title) title
  from shopify_sales_lines l
  left join currency_exchange_rates r
    on r.year = extract(year from l.order_date)::int and r.month = extract(month from l.order_date)::int
  where l.order_id in (select order_id from p2tot)
  group by 1, 2
),
-- Prorated: the P2 share of the Shopify line (capped at 100%), then split
-- between the flows that added that sku by quantity.
att as (
  select p.order_id, p.order_date, p.sku, p.flow_id, p.machine, p.ctx, p.qty, s.title,
    -- Visits exist only from 2026-09-05 08:18 AEST; ratios per visit use orders
    -- from that store day on, so a day with sales but no visits never inflates them.
    p.order_date >= date '2026-09-05' measured,
    coalesce(s.net_aud, 0)
      * least(1, greatest(0, t.p2_qty / nullif(s.qty, 0)))
      * (p.qty / nullif(t.p2_qty, 0)) rev
  from p2l p
  join p2tot t using (order_id, sku)
  left join shop s using (order_id, sku)
),
sal as (
  select
    count(distinct order_id)                                   orders,
    count(distinct flow_id)                                    buying_flows,
    count(distinct order_id) filter (where flow_id is null)    orders_no_flow,
    count(distinct order_id) filter (where ctx is null)        orders_ctx_null,
    coalesce(sum(rev), 0)                                      revenue,
    coalesce(sum(qty), 0)                                      units,
    count(*)                                                   lines,
    count(distinct order_id) filter (where measured)           orders_m,
    count(distinct flow_id)  filter (where measured)           buying_flows_m,
    coalesce(sum(rev) filter (where measured), 0)              revenue_m
  from att
),
-- Whole basket of the P2 orders, for the AOV of the orders P2 contributed to.
basket as (
  select count(distinct l.order_id) orders,
    coalesce(sum(case when l.currency = 'AUD' then l.net_native else l.net_usd * coalesce(r.rate, (select rate from fxlast)) end), 0) rev
  from shopify_sales_lines l
  left join currency_exchange_rates r
    on r.year = extract(year from l.order_date)::int and r.month = extract(month from l.order_date)::int
  where l.order_id in (select order_id from p2tot)
),
-- Brand / model cuts: funnel stages by distinct flow, sales by the machine
-- written on the line ("Brand / Model").
bf as (
  select brand,
    count(distinct flow_id) filter (where action = 'compatibility_brand_open')   brand_flows,
    count(distinct flow_id) filter (where action = 'compatibility_model_select') model_flows,
    count(distinct flow_id) filter (where action = 'compatibility_product_open') popen_flows,
    count(distinct flow_id) filter (where action = 'compatibility_add_click')    click_flows,
    count(distinct flow_id) filter (where action = 'compatibility_add_success')  succ_flows
  from evf where brand is not null
  group by brand
),
bs as (
  select split_part(machine, ' / ', 1) brand, count(distinct order_id) orders, sum(rev) revenue
  from att where machine is not null
  group by 1
),
mf as (
  select brand, model,
    count(distinct flow_id) filter (where action = 'compatibility_model_select') model_flows,
    count(distinct flow_id) filter (where action = 'compatibility_product_open') popen_flows,
    count(distinct flow_id) filter (where action = 'compatibility_add_click')    click_flows,
    count(distinct flow_id) filter (where action = 'compatibility_add_success')  succ_flows
  from evf where brand is not null and model is not null
  group by brand, model
),
ms as (
  select machine, count(distinct order_id) orders, sum(rev) revenue
  from att where machine is not null
  group by 1
),
-- Products as the guide showed them (events) and as they were paid (sales).
pf as (
  select coalesce(product_handle, product_id) product, max(product_handle) handle, max(product_id) product_id,
    count(distinct flow_id) filter (where action = 'compatibility_product_open') popen_flows,
    count(distinct flow_id) filter (where action = 'compatibility_add_click')    click_flows,
    count(distinct flow_id) filter (where action = 'compatibility_add_success')  succ_flows,
    count(*) filter (where action = 'compatibility_add_success')                 succ_attempts,
    count(*) filter (where action = 'compatibility_add_error')                   err_attempts
  from evf
  where coalesce(product_handle, product_id) is not null
    and action in ('compatibility_product_open', 'compatibility_add_click', 'compatibility_add_success', 'compatibility_add_error')
  group by 1
),
ps as (
  select sku, max(title) title, count(distinct order_id) orders, sum(qty) units, sum(rev) revenue
  from att
  group by sku
),
-- Day by day. Events on the UTC day, orders on the Shopify order day (Brisbane) —
-- the two calendars the rest of the tab already uses.
days as (select generate_series(p_from, p_to, interval '1 day')::date d),
td as (
  select d,
    count(distinct flow_id) filter (where action = 'compatibility_page_view')   pv_flows,
    count(distinct flow_id) filter (where action = 'compatibility_add_success') succ_flows
  from evf group by d
),
ts_ as (
  select order_date d, count(distinct order_id) orders, sum(rev) revenue
  from att group by order_date
),
trend as (
  select jsonb_agg(jsonb_build_object(
    'd', days.d, 'visits', coalesce(td.pv_flows, 0), 'adds', coalesce(td.succ_flows, 0),
    'orders', coalesce(ts_.orders, 0), 'revenue', round(coalesce(ts_.revenue, 0)::numeric, 2)) order by days.d) j
  from days left join td on td.d = days.d left join ts_ on ts_.d = days.d
),
dq as (
  select
    (select count(*) from ev)                                         events_total,
    (select count(*) from ev where flow_id is null)                   missing_flow_id,
    (select count(*) from ev
      where action in ('compatibility_add_click', 'compatibility_add_success', 'compatibility_add_error')
        and product_id is null and variant_id is null)                missing_product_or_variant,
    (select count(*) from web_upgrade_p2_events
      where d between p_from and p_to and environment = 'preview')    preview_events
)
select jsonb_build_object(
  'params', jsonb_build_object('from', p_from, 'to', p_to, 'environment', (select v from env)),
  'generation', jsonb_build_object(
    'label', 'P2',
    'liveSince', '2026-09-04',
    'funnelSince', '2026-09-04T22:18:09Z',
    'link', 'https://pesado585.com/pages/compatibility-guide?view=compatibility-p2'),
  'funnel', (select jsonb_build_object(
    'flows', flows, 'pageViews', pv_flows, 'dataReady', ready_flows, 'dataError', err_flows,
    'brandOpen', brand_flows, 'modelSelect', model_flows, 'productOpen', popen_flows,
    'addClick', aclick_flows, 'addSuccess', asucc_flows, 'addError', aerr_flows,
    'addClickAttempts', click_attempts, 'addSuccessAttempts', succ_attempts, 'addErrorAttempts', err_attempts,
    'buyingFlows', (select buying_flows from sal), 'orders', (select orders from sal)) from fn),
  'sales', (select jsonb_build_object(
    'orders', orders, 'buyingFlows', buying_flows, 'lines', lines, 'units', units,
    'revenue', round(revenue::numeric, 2),
    'basketRevenue', round((select rev from basket)::numeric, 2),
    'aov', case when (select orders from basket) > 0 then round(((select rev from basket) / (select orders from basket))::numeric, 2) end) from sal),
  'kpis', (select jsonb_build_object(
    'measuredFrom',        greatest(p_from, date '2026-09-05'),
    'measuredOrders',      s.orders_m,
    'measuredBuyingFlows', s.buying_flows_m,
    'measuredRevenue',     round(s.revenue_m::numeric, 2),
    'directConversionPct', case when f.pv_flows > 0 then round((100.0 * s.buying_flows_m / f.pv_flows)::numeric, 2) end,
    'revenuePerVisit',     case when f.pv_flows > 0 then round((s.revenue_m / f.pv_flows)::numeric, 2) end,
    'directRevenue',       round(s.revenue::numeric, 2),
    'dataReadyPct',        case when f.pv_flows > 0 then round((100.0 * f.ready_flows / f.pv_flows)::numeric, 1) end,
    'dataErrorPct',        case when f.pv_flows > 0 then round((100.0 * f.err_flows / f.pv_flows)::numeric, 1) end,
    'brandPct',            case when f.pv_flows > 0 then round((100.0 * f.brand_flows / f.pv_flows)::numeric, 1) end,
    'modelPct',            case when f.pv_flows > 0 then round((100.0 * f.model_flows / f.pv_flows)::numeric, 1) end,
    'productOpenPct',      case when f.pv_flows > 0 then round((100.0 * f.popen_flows / f.pv_flows)::numeric, 1) end,
    'addClickPct',         case when f.pv_flows > 0 then round((100.0 * f.aclick_flows / f.pv_flows)::numeric, 1) end,
    'addSuccessPct',       case when f.pv_flows > 0 then round((100.0 * f.asucc_flows / f.pv_flows)::numeric, 1) end,
    'clickToAddPct',       case when f.aclick_flows > 0 then round((100.0 * f.asucc_flows / f.aclick_flows)::numeric, 1) end,
    'errorPerAttemptPct',  case when f.click_attempts > 0 then round((100.0 * f.err_attempts / f.click_attempts)::numeric, 1) end)
    from fn f, sal s),
  -- Same shape as one entry of web_upgrade_performance.modules, so the
  -- Modules view can rank the guide against the other modules. Orders and
  -- revenue here are the MEASURED ones (store day >= 2026-09-05): the card
  -- divides them by visits, and visits do not exist before that.
  'module', (select jsonb_build_object(
    'module', 'Compatibility Guide',
    'sessions', f.pv_flows, 'views', f.pv_flows, 'selects', f.model_flows,
    'clicks', f.aclick_flows, 'adds', f.asucc_flows,
    'ctr', case when f.pv_flows > 0 then round((100.0 * f.aclick_flows / f.pv_flows)::numeric, 2) end,
    'addsPerSession', case when f.pv_flows > 0 then round((f.asucc_flows::numeric / f.pv_flows), 4) end,
    'orders', s.orders_m, 'revenue', round(s.revenue_m::numeric, 2),
    'aov', case when (select orders from basket) > 0 then round(((select rev from basket) / (select orders from basket))::numeric, 2) end)
    from fn f, sal s),
  'byBrand', coalesce((select jsonb_agg(jsonb_build_object(
      'brand', b.brand, 'flows', b.brand_flows, 'modelFlows', b.model_flows, 'productOpenFlows', b.popen_flows,
      'addClickFlows', b.click_flows, 'addSuccessFlows', b.succ_flows,
      'orders', coalesce(bs.orders, 0), 'revenue', round(coalesce(bs.revenue, 0)::numeric, 2))
      order by b.brand_flows desc, b.brand)
    from bf b left join bs on bs.brand = b.brand), '[]'::jsonb),
  'byModel', coalesce((select jsonb_agg(jsonb_build_object(
      'brand', m.brand, 'model', m.model, 'flows', m.model_flows, 'productOpenFlows', m.popen_flows,
      'addClickFlows', m.click_flows, 'addSuccessFlows', m.succ_flows,
      'orders', coalesce(ms.orders, 0), 'revenue', round(coalesce(ms.revenue, 0)::numeric, 2))
      order by m.model_flows desc, m.brand, m.model)
    from mf m left join ms on ms.machine = m.brand || ' / ' || m.model), '[]'::jsonb),
  'byProduct', coalesce((select jsonb_agg(jsonb_build_object(
      'product', product, 'handle', handle, 'productId', product_id,
      'productOpenFlows', popen_flows, 'addClickFlows', click_flows, 'addSuccessFlows', succ_flows,
      'addSuccessAttempts', succ_attempts, 'addErrorAttempts', err_attempts)
      order by succ_flows desc, popen_flows desc, product)
    from pf), '[]'::jsonb),
  'bySku', coalesce((select jsonb_agg(jsonb_build_object(
      'sku', sku, 'title', title, 'orders', orders, 'units', units, 'revenue', round(revenue::numeric, 2))
      order by revenue desc, sku)
    from ps), '[]'::jsonb),
  'trend', coalesce((select j from trend), '[]'::jsonb),
  'dataQuality', (select jsonb_build_object(
    'eventsTotal', d.events_total,
    'missingFlowId', d.missing_flow_id,
    'missingProductOrVariant', d.missing_product_or_variant,
    'previewEventsExcluded', case when (select v from env) = 'all' then 0 else d.preview_events end,
    'ordersWithoutFlowId', s.orders_no_flow,
    'linesWithNullContext', s.orders_ctx_null,
    'readyPlusErrorLeqViews', (f.ready_flows + f.err_flows) <= f.pv_flows,
    'addSuccessLeqClick', f.asucc_flows <= f.aclick_flows)
    from dq d, fn f, sal s)
);
$function$;

revoke all on function public.web_upgrade_p2_performance(date, date, text) from public, anon;
grant execute on function public.web_upgrade_p2_performance(date, date, text) to authenticated, service_role;
