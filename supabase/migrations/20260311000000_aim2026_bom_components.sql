-- AIM 2026: BOM components - assembly SKU -> component SKU -> quantity per assembly
-- Enables dashboard to show component relationships for assembled products.

CREATE TABLE IF NOT EXISTS aim2026_bom_components (
  assembly_sku TEXT NOT NULL,
  component_sku TEXT NOT NULL,
  quantity_per_assembly NUMERIC(12, 4) NOT NULL DEFAULT 1,
  PRIMARY KEY (assembly_sku, component_sku)
);

CREATE INDEX IF NOT EXISTS idx_aim2026_bom_assembly ON aim2026_bom_components(assembly_sku);
CREATE INDEX IF NOT EXISTS idx_aim2026_bom_component ON aim2026_bom_components(component_sku);

ALTER TABLE aim2026_bom_components ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read aim2026_bom_components" ON aim2026_bom_components FOR SELECT USING (true);
CREATE POLICY "Service insert aim2026_bom_components" ON aim2026_bom_components FOR INSERT WITH CHECK (true);
CREATE POLICY "Service delete aim2026_bom_components" ON aim2026_bom_components FOR DELETE USING (true);
