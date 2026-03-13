-- Add campaign_name to ecommerce_meta_top_ads for display like Manuel's report

ALTER TABLE ecommerce_meta_top_ads
  ADD COLUMN IF NOT EXISTS campaign_name TEXT;
