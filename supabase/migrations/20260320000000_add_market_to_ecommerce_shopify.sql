-- Add market column to ecommerce_shopify_daily for USA/Australia split
-- market: 'all' (legacy/blended), 'usa', 'australia'

ALTER TABLE ecommerce_shopify_daily ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'all';

UPDATE ecommerce_shopify_daily SET market = 'all' WHERE market IS NULL OR market = '';

-- Drop old unique and add new
ALTER TABLE ecommerce_shopify_daily DROP CONSTRAINT IF EXISTS ecommerce_shopify_daily_date_store_url_key;
ALTER TABLE ecommerce_shopify_daily ADD CONSTRAINT ecommerce_shopify_daily_date_store_url_market_key UNIQUE (date, store_url, market);

CREATE INDEX IF NOT EXISTS idx_ecommerce_shopify_market ON ecommerce_shopify_daily(market, date DESC);
