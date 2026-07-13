-- Extend meta_ads_daily with the funnel metrics the E-commerce marketing dashboard
-- needs fresh (impressions/clicks -> CTR/CPC/CPM; view_content/add_to_cart/
-- initiate_checkout/purchases -> acquisition funnel). Additive only; the existing
-- Meta CSV pipeline (meta-export-csv) selects named columns and is unaffected.
alter table meta_ads_daily add column if not exists impressions bigint not null default 0;
alter table meta_ads_daily add column if not exists clicks bigint not null default 0;
alter table meta_ads_daily add column if not exists view_content integer not null default 0;
alter table meta_ads_daily add column if not exists add_to_cart integer not null default 0;
alter table meta_ads_daily add column if not exists initiate_checkout integer not null default 0;
alter table meta_ads_daily add column if not exists purchases integer not null default 0;
