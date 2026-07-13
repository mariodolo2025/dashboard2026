-- ecommerce_dashboard: single aggregation entry point for the E-commerce marketing
-- tab and the E-commerce EOFY report. SECURITY DEFINER so the authenticated client
-- can call it directly (supabase.rpc) without exposing the underlying tables — it
-- returns only aggregates (no PII, no tokens). Reads the FRESH DB-first sources:
--   shopify_sales_by_variant (net AUD per line) + shopify_sales_lines (order ids) +
--   meta_ads_daily (spend/conversion/funnel, native currency) + currency_exchange_rates.
-- Market maps: usa = US-shipping orders + Meta act_1619…; australia = AU + act_1919….
create or replace function ecommerce_dashboard(
  p_from date, p_to date, p_market text default 'all', p_margin numeric default 0.45
) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_len int := (p_to - p_from) + 1;
  p2_to date := p_from - 1;
  p2_from date := p_from - ((p_to - p_from) + 1);
  s_gross numeric; s_disc numeric; s_ret numeric; s_net numeric; s_ship numeric; s_tax numeric; s_units numeric; s_orders bigint;
  m_spend numeric; m_conv numeric; m_impr numeric; m_clicks numeric; m_vc numeric; m_atc numeric; m_ic numeric; m_purch numeric;
  p_net numeric; p_ord bigint; p_spend numeric; p_conv numeric;
  us_net numeric; us_ord bigint; us_spend numeric; us_conv numeric;
  au_net numeric; au_ord bigint; au_spend numeric; au_conv numeric;
begin
  -- Shopify, selected market
  select coalesce(sum(gross_aud),0),coalesce(sum(discounts_aud),0),coalesce(sum(returns_aud),0),
         coalesce(sum(net_aud),0),coalesce(sum(shipping_aud),0),coalesce(sum(taxes_aud),0),coalesce(sum(quantity),0)
    into s_gross,s_disc,s_ret,s_net,s_ship,s_tax,s_units
  from shopify_sales_by_variant
  where order_date between p_from and p_to
    and (p_market='all' or (p_market='usa' and country='US') or (p_market='australia' and country='AU'));
  select count(distinct order_id) into s_orders from shopify_sales_lines
  where order_date between p_from and p_to
    and (p_market='all' or (p_market='usa' and country='US') or (p_market='australia' and country='AU'));

  -- Meta (AUD), selected market
  select coalesce(sum(case when m.currency='USD' then m.spend*r.rate else m.spend end),0),
         coalesce(sum(case when m.currency='USD' then m.conversion_value*r.rate else m.conversion_value end),0),
         coalesce(sum(m.impressions),0),coalesce(sum(m.clicks),0),coalesce(sum(m.view_content),0),
         coalesce(sum(m.add_to_cart),0),coalesce(sum(m.initiate_checkout),0),coalesce(sum(m.purchases),0)
    into m_spend,m_conv,m_impr,m_clicks,m_vc,m_atc,m_ic,m_purch
  from meta_ads_daily m left join currency_exchange_rates r on r.year=extract(year from m.date)::int and r.month=extract(month from m.date)::int
  where m.date between p_from and p_to
    and (p_market='all' or (p_market='usa' and m.account_id='act_1619162111994178') or (p_market='australia' and m.account_id='act_191914388901521'));

  -- prior window (same length, same market) for deltas
  select coalesce(sum(net_aud),0) into p_net from shopify_sales_by_variant
   where order_date between p2_from and p2_to and (p_market='all' or (p_market='usa' and country='US') or (p_market='australia' and country='AU'));
  select count(distinct order_id) into p_ord from shopify_sales_lines
   where order_date between p2_from and p2_to and (p_market='all' or (p_market='usa' and country='US') or (p_market='australia' and country='AU'));
  select coalesce(sum(case when m.currency='USD' then m.spend*r.rate else m.spend end),0),
         coalesce(sum(case when m.currency='USD' then m.conversion_value*r.rate else m.conversion_value end),0)
    into p_spend,p_conv from meta_ads_daily m left join currency_exchange_rates r on r.year=extract(year from m.date)::int and r.month=extract(month from m.date)::int
   where m.date between p2_from and p2_to and (p_market='all' or (p_market='usa' and m.account_id='act_1619162111994178') or (p_market='australia' and m.account_id='act_191914388901521'));

  -- market split (always both, for the window, ignoring p_market)
  select coalesce(sum(net_aud),0) into us_net from shopify_sales_by_variant where order_date between p_from and p_to and country='US';
  select count(distinct order_id) into us_ord from shopify_sales_lines where order_date between p_from and p_to and country='US';
  select coalesce(sum(case when m.currency='USD' then m.spend*r.rate else m.spend end),0),
         coalesce(sum(case when m.currency='USD' then m.conversion_value*r.rate else m.conversion_value end),0)
    into us_spend,us_conv from meta_ads_daily m left join currency_exchange_rates r on r.year=extract(year from m.date)::int and r.month=extract(month from m.date)::int
   where m.date between p_from and p_to and m.account_id='act_1619162111994178';
  select coalesce(sum(net_aud),0) into au_net from shopify_sales_by_variant where order_date between p_from and p_to and country='AU';
  select count(distinct order_id) into au_ord from shopify_sales_lines where order_date between p_from and p_to and country='AU';
  select coalesce(sum(case when m.currency='USD' then m.spend*r.rate else m.spend end),0),
         coalesce(sum(case when m.currency='USD' then m.conversion_value*r.rate else m.conversion_value end),0)
    into au_spend,au_conv from meta_ads_daily m left join currency_exchange_rates r on r.year=extract(year from m.date)::int and r.month=extract(month from m.date)::int
   where m.date between p_from and p_to and m.account_id='act_191914388901521';

  return jsonb_build_object(
    'params', jsonb_build_object('from',p_from,'to',p_to,'market',p_market,'margin',p_margin,'priorFrom',p2_from,'priorTo',p2_to),
    'kpis', jsonb_build_object(
      'gross',round(s_gross),'discounts',round(s_disc),'returns',round(s_ret),'revenue',round(s_net),
      'shipping',round(s_ship),'taxes',round(s_tax),'units',round(s_units),'orders',s_orders,
      'aov', case when s_orders>0 then round(s_net/s_orders,2) else 0 end,
      'upo', case when s_orders>0 then round(s_units/s_orders,2) else 0 end,
      'spend',round(m_spend),'conv',round(m_conv),
      'mer', case when m_spend>0 then round(s_net/m_spend,2) else null end,
      'purchaseRoas', case when m_spend>0 then round(m_conv/m_spend,2) else null end,
      'cpo', case when s_orders>0 then round(m_spend/s_orders,2) else null end,
      'poas', case when m_spend>0 then round(s_net*p_margin/m_spend,2) else null end,
      'contributionMargin', round(s_net*p_margin),
      'ctr', case when m_impr>0 then round(100*m_clicks/m_impr,2) else 0 end,
      'cpc', case when m_clicks>0 then round(m_spend/m_clicks,2) else 0 end,
      'cpm', case when m_impr>0 then round(m_spend/m_impr*1000,2) else 0 end,
      'impressions',round(m_impr),'clicks',round(m_clicks),
      'returnRate', case when s_gross>0 then round(100*s_ret/s_gross,2) else 0 end,
      'discountRate', case when s_gross>0 then round(100*s_disc/s_gross,2) else 0 end
    ),
    'prior', jsonb_build_object(
      'revenue',round(p_net),'orders',p_ord,'spend',round(p_spend),'conv',round(p_conv),
      'mer', case when p_spend>0 then round(p_net/p_spend,2) else null end,
      'aov', case when p_ord>0 then round(p_net/p_ord,2) else null end,
      'purchaseRoas', case when p_spend>0 then round(p_conv/p_spend,2) else null end,
      'hasPrior', (p2_from >= date '2024-07-01')
    ),
    'bridge', jsonb_build_object('gross',round(s_gross),'discounts',round(s_disc),'returns',round(s_ret),'net',round(s_net),'shipping',round(s_ship),'taxes',round(s_tax)),
    'funnel', jsonb_build_object('impressions',round(m_impr),'clicks',round(m_clicks),'viewContent',round(m_vc),'addToCart',round(m_atc),'initiateCheckout',round(m_ic),'purchases',round(m_purch)),
    'market', jsonb_build_object(
      'usa', jsonb_build_object('revenue',round(us_net),'orders',us_ord,'spend',round(us_spend),'roas', case when us_spend>0 then round(us_conv/us_spend,2) else null end,'share', case when (us_net+au_net)>0 then round(100*us_net/(us_net+au_net)) else 0 end),
      'australia', jsonb_build_object('revenue',round(au_net),'orders',au_ord,'spend',round(au_spend),'roas', case when au_spend>0 then round(au_conv/au_spend,2) else null end,'share', case when (us_net+au_net)>0 then round(100*au_net/(us_net+au_net)) else 0 end)
    ),
    'trend', (select coalesce(jsonb_agg(jsonb_build_object(
        'ym',to_char(d,'YYYY-MM'),
        'revenue',round(coalesce((select sum(net_aud) from shopify_sales_by_variant v where date_trunc('month',v.order_date)=d and (p_market='all' or (p_market='usa' and v.country='US') or (p_market='australia' and v.country='AU'))),0)),
        'spend',round(coalesce((select sum(case when m.currency='USD' then m.spend*r.rate else m.spend end) from meta_ads_daily m left join currency_exchange_rates r on r.year=extract(year from m.date)::int and r.month=extract(month from m.date)::int where date_trunc('month',m.date)=d and (p_market='all' or (p_market='usa' and m.account_id='act_1619162111994178') or (p_market='australia' and m.account_id='act_191914388901521'))),0)),
        'conv',round(coalesce((select sum(case when m.currency='USD' then m.conversion_value*r.rate else m.conversion_value end) from meta_ads_daily m left join currency_exchange_rates r on r.year=extract(year from m.date)::int and r.month=extract(month from m.date)::int where date_trunc('month',m.date)=d and (p_market='all' or (p_market='usa' and m.account_id='act_1619162111994178') or (p_market='australia' and m.account_id='act_191914388901521'))),0)),
        'orders',coalesce((select count(distinct order_id) from shopify_sales_lines l where date_trunc('month',l.order_date)=d and (p_market='all' or (p_market='usa' and l.country='US') or (p_market='australia' and l.country='AU'))),0)
      ) order by d),'[]'::jsonb)
      from generate_series(date_trunc('month',p_from), date_trunc('month',p_to), interval '1 month') d),
    'geo', (select coalesce(jsonb_agg(jsonb_build_object('country',country,'revenue',rev,'units',units) order by rev desc),'[]'::jsonb) from (
        select coalesce(nullif(btrim(country),''),'??') country, round(sum(net_aud)) rev, round(sum(quantity)) units
        from shopify_sales_by_variant where order_date between p_from and p_to
          and (p_market='all' or (p_market='usa' and country='US') or (p_market='australia' and country='AU'))
        group by 1 order by sum(net_aud) desc nulls last limit 10) q),
    'family', (select coalesce(jsonb_agg(jsonb_build_object('family',fam,'revenue',rev,'units',units,'pct',pct,'aovUnit',aovu) order by rev desc),'[]'::jsonb) from (
        select fam, round(sum(net_aud)) rev, round(sum(quantity)) units,
          round(100*sum(net_aud)/nullif(s_net,0),1) pct,
          round(sum(net_aud)/nullif(sum(quantity),0),2) aovu
        from (select case
            when sku ilike 'PSD-HD%' then 'Shower Screens'
            when sku ilike 'PSD-HE%' or sku ilike 'EP-BR%' then 'Filter Baskets'
            when sku ilike 'PF%' then 'Portafilters'
            when sku ilike 'EXT%' or sku ilike 'PRE%' then 'Bundles'
            when sku ilike 'PSD-puck%' then 'Puck Screens'
            when sku ilike '%distribut%' or sku ilike '%tamp%' or sku ilike '%ring%' or sku ilike '%crusher%' then 'Distribution & Prep'
            else 'Accessories' end fam, net_aud, quantity
          from shopify_sales_by_variant where order_date between p_from and p_to
            and (p_market='all' or (p_market='usa' and country='US') or (p_market='australia' and country='AU'))) c
        group by fam) q),
    'products', (select coalesce(jsonb_agg(jsonb_build_object('title',title,'revenue',rev,'units',units) order by rev desc),'[]'::jsonb) from (
        select max(product_title) title, round(sum(net_aud)) rev, round(sum(quantity)) units
        from shopify_sales_by_variant where order_date between p_from and p_to and product_title is not null
          and (p_market='all' or (p_market='usa' and country='US') or (p_market='australia' and country='AU'))
        group by btrim(product_title) order by sum(net_aud) desc limit 8) q)
  );
end $$;

grant execute on function ecommerce_dashboard(date, date, text, numeric) to anon, authenticated;
