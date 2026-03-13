-- Add purchases and purchase_value to ecommerce_meta_top_ads for CPP and ROAS per ad

ALTER TABLE ecommerce_meta_top_ads
  ADD COLUMN IF NOT EXISTS purchases INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS purchase_value NUMERIC DEFAULT 0;
