-- =============================================================================
-- AIM 2026 — Add pack_size to aim2026_sku_parameters
-- =============================================================================
-- pack_size = unidades por caja master. Se usa al agregar SKUs al PO Builder
-- desde Complete Projection: la qty sugerida se redondea al múltiplo más
-- cercano de pack_size. Default 1 = sin redondeo. Se carga desde ProductList.csv
-- vía Settings → "Load Lead Times from CSV" (mismo archivo, columna "Pack Size").
-- =============================================================================

ALTER TABLE aim2026_sku_parameters
  ADD COLUMN IF NOT EXISTS pack_size INTEGER DEFAULT 1;
