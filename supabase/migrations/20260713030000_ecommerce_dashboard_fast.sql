-- Performance rewrite of ecommerce_dashboard. The first version re-scanned the
-- shopify view ~60× (the monthly trend used 4 correlated subqueries per month),
-- taking ~3s and intermittently tripping the role's statement_timeout. This version
-- materialises each source ONCE per window and derives every section (main KPIs,
-- market split, trend, geo, family, products, bridge, funnel) from those CTEs using
-- FILTER clauses — a handful of scans total. Behaviour/shape is identical.
create or replace function ecommerce_dashboard(
  p_from date, p_to date, p_market text default 'all', p_margin numeric default 0.45
) returns jsonb
language sql stable security definer set search_path = public set statement_timeout = '25s'
as $$
with
sh as materialized (
  select order_date, net_aud, gross_aud, discounts_aud, returns_aud, shipping_aud, taxes_aud, quantity, sku, product_title,
         case when country='US' then 'usa' when country='AU' then 'australia' else 'other' end mk,
         coalesce(nullif(btrim(country),''),'??') country
  from shopify_sales_by_variant where order_date between p_from and p_to),
shl as materialized (
  select order_id, order_date, case when country='US' then 'usa' when country='AU' then 'australia' else 'other' end mk
  from shopify_sales_lines where order_date between p_from and p_to),
mt as materialized (
  select m.date, m.impressions, m.clicks, m.view_content, m.add_to_cart, m.initiate_checkout, m.purchases,
         case when m.account_id='act_1619162111994178' then 'usa' when m.account_id='act_191914388901521' then 'australia' else 'other' end mk,
         case when m.currency='USD' then m.spend*r.rate else m.spend end spend_aud,
         case when m.currency='USD' then m.conversion_value*r.rate else m.conversion_value end conv_aud
  from meta_ads_daily m left join currency_exchange_rates r on r.year=extract(year from m.date)::int and r.month=extract(month from m.date)::int
  where m.date between p_from and p_to),
-- prior window (already market-filtered — only totals needed)
shp as (select coalesce(sum(net_aud),0) net from shopify_sales_by_variant
        where order_date between (p_from-((p_to-p_from)+1)) and (p_from-1)
          and (p_market='all' or (p_market='usa' and country='US') or (p_market='australia' and country='AU'))),
shlp as (select count(distinct order_id) ord from shopify_sales_lines
         where order_date between (p_from-((p_to-p_from)+1)) and (p_from-1)
           and (p_market='all' or (p_market='usa' and country='US') or (p_market='australia' and country='AU'))),
mtp as (select coalesce(sum(case when m.currency='USD' then m.spend*r.rate else m.spend end),0) spend,
               coalesce(sum(case when m.currency='USD' then m.conversion_value*r.rate else m.conversion_value end),0) conv
        from meta_ads_daily m left join currency_exchange_rates r on r.year=extract(year from m.date)::int and r.month=extract(month from m.date)::int
        where m.date between (p_from-((p_to-p_from)+1)) and (p_from-1)
          and (p_market='all' or (p_market='usa' and m.account_id='act_1619162111994178') or (p_market='australia' and m.account_id='act_191914388901521'))),
-- single-pass aggregates (main = selected market via FILTER; us/au split alongside)
a_sh as (select
   coalesce(sum(net_aud) filter (where p_market='all' or mk=p_market),0) net,
   coalesce(sum(gross_aud) filter (where p_market='all' or mk=p_market),0) gross,
   coalesce(sum(discounts_aud) filter (where p_market='all' or mk=p_market),0) disc,
   coalesce(sum(returns_aud) filter (where p_market='all' or mk=p_market),0) ret,
   coalesce(sum(shipping_aud) filter (where p_market='all' or mk=p_market),0) ship,
   coalesce(sum(taxes_aud) filter (where p_market='all' or mk=p_market),0) tax,
   coalesce(sum(quantity) filter (where p_market='all' or mk=p_market),0) units,
   coalesce(sum(net_aud) filter (where mk='usa'),0) us_net,
   coalesce(sum(net_aud) filter (where mk='australia'),0) au_net
  from sh),
a_shl as (select
   count(distinct order_id) filter (where p_market='all' or mk=p_market) ord,
   count(distinct order_id) filter (where mk='usa') us_ord,
   count(distinct order_id) filter (where mk='australia') au_ord
  from shl),
a_mt as (select
   coalesce(sum(spend_aud) filter (where p_market='all' or mk=p_market),0) spend,
   coalesce(sum(conv_aud) filter (where p_market='all' or mk=p_market),0) conv,
   coalesce(sum(impressions) filter (where p_market='all' or mk=p_market),0) impr,
   coalesce(sum(clicks) filter (where p_market='all' or mk=p_market),0) clicks,
   coalesce(sum(view_content) filter (where p_market='all' or mk=p_market),0) vc,
   coalesce(sum(add_to_cart) filter (where p_market='all' or mk=p_market),0) atc,
   coalesce(sum(initiate_checkout) filter (where p_market='all' or mk=p_market),0) ic,
   coalesce(sum(purchases) filter (where p_market='all' or mk=p_market),0) purch,
   coalesce(sum(spend_aud) filter (where mk='usa'),0) us_spend,
   coalesce(sum(conv_aud) filter (where mk='usa'),0) us_conv,
   coalesce(sum(spend_aud) filter (where mk='australia'),0) au_spend,
   coalesce(sum(conv_aud) filter (where mk='australia'),0) au_conv
  from mt),
trend as (
  select coalesce(jsonb_agg(jsonb_build_object('ym',to_char(d,'YYYY-MM'),
      'revenue',round(coalesce(sr.rev,0)),'spend',round(coalesce(mr.spend,0)),
      'conv',round(coalesce(mr.conv,0)),'orders',coalesce(so.ord,0),
      'mer',case when coalesce(mr.spend,0)>0 then round(sr.rev/mr.spend,2) else null end) order by d),'[]'::jsonb) j
  from generate_series(date_trunc('month',p_from), date_trunc('month',p_to), interval '1 month') d
  left join (select date_trunc('month',order_date) mo, sum(net_aud) filter (where p_market='all' or mk=p_market) rev from sh group by 1) sr on sr.mo=d
  left join (select date_trunc('month',order_date) mo, count(distinct order_id) filter (where p_market='all' or mk=p_market) ord from shl group by 1) so on so.mo=d
  left join (select date_trunc('month',date) mo, sum(spend_aud) filter (where p_market='all' or mk=p_market) spend, sum(conv_aud) filter (where p_market='all' or mk=p_market) conv from mt group by 1) mr on mr.mo=d),
geo as (select coalesce(jsonb_agg(jsonb_build_object('country',country,'revenue',rev,'units',units) order by rev desc),'[]'::jsonb) j from (
   select country, round(sum(net_aud)) rev, round(sum(quantity)) units from sh
   where p_market='all' or mk=p_market group by country order by sum(net_aud) desc nulls last limit 10) q),
family as (select coalesce(jsonb_agg(jsonb_build_object('family',fam,'revenue',rev,'units',units,'pct',pct,'aovUnit',aovu) order by rev desc),'[]'::jsonb) j from (
   select fam, round(sum(net_aud)) rev, round(sum(quantity)) units,
     round(100*sum(net_aud)/nullif((select net from a_sh),0),1) pct,
     round(sum(net_aud)/nullif(sum(quantity),0),2) aovu
   from (select case
       when sku ilike 'PSD-HD%' then 'Shower Screens'
       when sku ilike 'PSD-HE%' or sku ilike 'EP-BR%' then 'Filter Baskets'
       when sku ilike 'PF%' then 'Portafilters'
       when sku ilike 'EXT%' or sku ilike 'PRE%' then 'Bundles'
       when sku ilike 'PSD-puck%' then 'Puck Screens'
       when sku ilike '%distribut%' or sku ilike '%tamp%' or sku ilike '%ring%' or sku ilike '%crusher%' then 'Distribution & Prep'
       else 'Accessories' end fam, net_aud, quantity
     from sh where p_market='all' or mk=p_market) c group by fam) q),
products as (select coalesce(jsonb_agg(jsonb_build_object('title',title,'revenue',rev,'units',units) order by rev desc),'[]'::jsonb) j from (
   select max(product_title) title, round(sum(net_aud)) rev, round(sum(quantity)) units from sh
   where product_title is not null and (p_market='all' or mk=p_market)
   group by btrim(product_title) order by sum(net_aud) desc limit 8) q)
select jsonb_build_object(
  'params', jsonb_build_object('from',p_from,'to',p_to,'market',p_market,'margin',p_margin),
  'kpis', jsonb_build_object(
    'gross',round(a_sh.gross),'discounts',round(a_sh.disc),'returns',round(a_sh.ret),'revenue',round(a_sh.net),
    'shipping',round(a_sh.ship),'taxes',round(a_sh.tax),'units',round(a_sh.units),'orders',a_shl.ord,
    'aov', case when a_shl.ord>0 then round(a_sh.net/a_shl.ord,2) else 0 end,
    'upo', case when a_shl.ord>0 then round(a_sh.units/a_shl.ord,2) else 0 end,
    'spend',round(a_mt.spend),'conv',round(a_mt.conv),
    'mer', case when a_mt.spend>0 then round(a_sh.net/a_mt.spend,2) else null end,
    'purchaseRoas', case when a_mt.spend>0 then round(a_mt.conv/a_mt.spend,2) else null end,
    'cpo', case when a_shl.ord>0 then round(a_mt.spend/a_shl.ord,2) else null end,
    'poas', case when a_mt.spend>0 then round(a_sh.net*p_margin/a_mt.spend,2) else null end,
    'contributionMargin', round(a_sh.net*p_margin),
    'ctr', case when a_mt.impr>0 then round(100*a_mt.clicks/a_mt.impr,2) else 0 end,
    'cpc', case when a_mt.clicks>0 then round(a_mt.spend/a_mt.clicks,2) else 0 end,
    'cpm', case when a_mt.impr>0 then round(a_mt.spend/a_mt.impr*1000,2) else 0 end,
    'impressions',round(a_mt.impr),'clicks',round(a_mt.clicks),
    'returnRate', case when a_sh.gross>0 then round(100*a_sh.ret/a_sh.gross,2) else 0 end,
    'discountRate', case when a_sh.gross>0 then round(100*a_sh.disc/a_sh.gross,2) else 0 end),
  'prior', jsonb_build_object('revenue',round(shp.net),'orders',shlp.ord,'spend',round(mtp.spend),'conv',round(mtp.conv),
    'mer', case when mtp.spend>0 then round(shp.net/mtp.spend,2) else null end,
    'aov', case when shlp.ord>0 then round(shp.net/shlp.ord,2) else null end,
    'purchaseRoas', case when mtp.spend>0 then round(mtp.conv/mtp.spend,2) else null end,
    'hasPrior', ((p_from-((p_to-p_from)+1)) >= date '2024-07-01')),
  'bridge', jsonb_build_object('gross',round(a_sh.gross),'discounts',round(a_sh.disc),'returns',round(a_sh.ret),'net',round(a_sh.net),'shipping',round(a_sh.ship),'taxes',round(a_sh.tax)),
  'funnel', jsonb_build_object('impressions',round(a_mt.impr),'clicks',round(a_mt.clicks),'viewContent',round(a_mt.vc),'addToCart',round(a_mt.atc),'initiateCheckout',round(a_mt.ic),'purchases',round(a_mt.purch)),
  'market', jsonb_build_object(
    'usa', jsonb_build_object('revenue',round(a_sh.us_net),'orders',a_shl.us_ord,'spend',round(a_mt.us_spend),'roas',case when a_mt.us_spend>0 then round(a_mt.us_conv/a_mt.us_spend,2) else null end,'share',case when (a_sh.us_net+a_sh.au_net)>0 then round(100*a_sh.us_net/(a_sh.us_net+a_sh.au_net)) else 0 end),
    'australia', jsonb_build_object('revenue',round(a_sh.au_net),'orders',a_shl.au_ord,'spend',round(a_mt.au_spend),'roas',case when a_mt.au_spend>0 then round(a_mt.au_conv/a_mt.au_spend,2) else null end,'share',case when (a_sh.us_net+a_sh.au_net)>0 then round(100*a_sh.au_net/(a_sh.us_net+a_sh.au_net)) else 0 end)),
  'trend', trend.j, 'geo', geo.j, 'family', family.j, 'products', products.j)
from a_sh, a_shl, a_mt, shp, shlp, mtp, trend, geo, family, products;
$$;

grant execute on function ecommerce_dashboard(date, date, text, numeric) to anon, authenticated;
