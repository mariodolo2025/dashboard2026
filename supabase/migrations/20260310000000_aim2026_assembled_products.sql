-- AIM 2026: Table of SKUs that are assembled products (have a BOM).
-- Used to filter the main table: by default exclude these; checkbox "Show Assembled Products" includes them.
-- Populated by aim2026-sync-unleashed when syncing assemblies (Product.ProductCode of each assembly).

CREATE TABLE IF NOT EXISTS aim2026_assembled_products (
  sku TEXT PRIMARY KEY
);

CREATE INDEX IF NOT EXISTS idx_aim2026_assembled_sku ON aim2026_assembled_products(sku);

ALTER TABLE aim2026_assembled_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read aim2026_assembled_products" ON aim2026_assembled_products FOR SELECT USING (true);
CREATE POLICY "Service insert aim2026_assembled_products" ON aim2026_assembled_products FOR INSERT WITH CHECK (true);
CREATE POLICY "Service delete aim2026_assembled_products" ON aim2026_assembled_products FOR DELETE USING (true);
