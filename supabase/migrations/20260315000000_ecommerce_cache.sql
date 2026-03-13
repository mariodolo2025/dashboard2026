-- E-commerce cache tables for fast date-range queries (Shopify + Meta)
-- Sync job populates these; frontend reads from cache instead of hitting APIs on every date change

-- Sync log
CREATE TABLE IF NOT EXISTS ecommerce_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  records_synced JSONB DEFAULT '{}'::jsonb,
  errors TEXT[] DEFAULT '{}',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ecommerce_sync_log_synced_at ON ecommerce_sync_log(synced_at DESC);

ALTER TABLE ecommerce_sync_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read ecommerce_sync_log" ON ecommerce_sync_log FOR SELECT USING (true);
CREATE POLICY "Service insert ecommerce_sync_log" ON ecommerce_sync_log FOR INSERT WITH CHECK (true);

-- Shopify daily aggregates
CREATE TABLE IF NOT EXISTS ecommerce_shopify_daily (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  store_url TEXT NOT NULL,
  order_count INTEGER NOT NULL DEFAULT 0,
  total_revenue NUMERIC NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(date, store_url)
);

CREATE INDEX idx_ecommerce_shopify_date ON ecommerce_shopify_daily(date DESC);

ALTER TABLE ecommerce_shopify_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read ecommerce_shopify_daily" ON ecommerce_shopify_daily FOR SELECT USING (true);
CREATE POLICY "Service insert ecommerce_shopify_daily" ON ecommerce_shopify_daily FOR INSERT WITH CHECK (true);
CREATE POLICY "Service update ecommerce_shopify_daily" ON ecommerce_shopify_daily FOR UPDATE USING (true);

-- Meta daily aggregates per account
CREATE TABLE IF NOT EXISTS ecommerce_meta_daily (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  account_id TEXT NOT NULL,
  spend NUMERIC NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(date, account_id)
);

CREATE INDEX idx_ecommerce_meta_date ON ecommerce_meta_daily(date DESC);

ALTER TABLE ecommerce_meta_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read ecommerce_meta_daily" ON ecommerce_meta_daily FOR SELECT USING (true);
CREATE POLICY "Service insert ecommerce_meta_daily" ON ecommerce_meta_daily FOR INSERT WITH CHECK (true);
CREATE POLICY "Service update ecommerce_meta_daily" ON ecommerce_meta_daily FOR UPDATE USING (true);

-- Meta top 3 ads per account (snapshot from last sync)
CREATE TABLE IF NOT EXISTS ecommerce_meta_top_ads (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  spend NUMERIC NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  permalink TEXT,
  rank INTEGER NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, rank)
);

CREATE INDEX idx_ecommerce_meta_top_ads_account ON ecommerce_meta_top_ads(account_id);

ALTER TABLE ecommerce_meta_top_ads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read ecommerce_meta_top_ads" ON ecommerce_meta_top_ads FOR SELECT USING (true);
CREATE POLICY "Service insert ecommerce_meta_top_ads" ON ecommerce_meta_top_ads FOR INSERT WITH CHECK (true);
CREATE POLICY "Service delete ecommerce_meta_top_ads" ON ecommerce_meta_top_ads FOR DELETE USING (true);
