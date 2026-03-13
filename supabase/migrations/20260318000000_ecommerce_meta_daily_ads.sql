-- Daily ad-level data for Meta Ads (enables Top 3 per date range)

CREATE TABLE IF NOT EXISTS ecommerce_meta_daily_ads (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  account_id TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  campaign_name TEXT,
  spend NUMERIC NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  purchases INTEGER DEFAULT 0,
  purchase_value NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(date, account_id, ad_id)
);

CREATE INDEX idx_ecommerce_meta_daily_ads_date ON ecommerce_meta_daily_ads(date DESC);
CREATE INDEX idx_ecommerce_meta_daily_ads_account_date ON ecommerce_meta_daily_ads(account_id, date DESC);

ALTER TABLE ecommerce_meta_daily_ads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read ecommerce_meta_daily_ads" ON ecommerce_meta_daily_ads FOR SELECT USING (true);
CREATE POLICY "Service insert ecommerce_meta_daily_ads" ON ecommerce_meta_daily_ads FOR INSERT WITH CHECK (true);
CREATE POLICY "Service update ecommerce_meta_daily_ads" ON ecommerce_meta_daily_ads FOR UPDATE USING (true);
