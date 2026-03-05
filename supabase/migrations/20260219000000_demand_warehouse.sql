-- =============================================================================
-- AIM 2026 — Add warehouse column + demand_detail table
-- =============================================================================
-- 1. Adds 'warehouse' TEXT column to aim2026_demand_history (DEFAULT 'All').
-- 2. Replaces UNIQUE(period_date, sku) with UNIQUE(period_date, sku, warehouse).
-- 3. Creates aim2026_demand_detail for individual transaction rows (CSV download).
-- =============================================================================

-- ─── 1. Add warehouse column ────────────────────────────────────────────────

ALTER TABLE aim2026_demand_history
  ADD COLUMN IF NOT EXISTS warehouse TEXT NOT NULL DEFAULT 'All';

-- ─── 2. Replace unique constraint ──────────────────────────────────────────

ALTER TABLE aim2026_demand_history
  DROP CONSTRAINT IF EXISTS aim2026_demand_history_period_date_sku_key;

ALTER TABLE aim2026_demand_history
  ADD CONSTRAINT aim2026_demand_history_period_date_sku_warehouse_key
  UNIQUE (period_date, sku, warehouse);

-- ─── 3. Create demand_detail table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aim2026_demand_detail (
  id BIGSERIAL PRIMARY KEY,
  period_date DATE NOT NULL,
  sku TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('sale', 'component_usage')),
  order_date DATE,
  order_number TEXT,
  customer TEXT,
  quantity NUMERIC NOT NULL DEFAULT 0,
  amount NUMERIC NOT NULL DEFAULT 0,
  status TEXT,
  warehouse TEXT,
  product_group TEXT,
  customer_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aim2026_detail_sku_period
  ON aim2026_demand_detail(sku, period_date);

CREATE INDEX IF NOT EXISTS idx_aim2026_detail_period_sku_type
  ON aim2026_demand_detail(period_date, sku, type);

-- RLS
ALTER TABLE aim2026_demand_detail ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read aim2026_demand_detail"
  ON aim2026_demand_detail FOR SELECT USING (true);

CREATE POLICY "Service insert aim2026_demand_detail"
  ON aim2026_demand_detail FOR INSERT WITH CHECK (true);

CREATE POLICY "Service delete aim2026_demand_detail"
  ON aim2026_demand_detail FOR DELETE USING (true);

-- ─── 4. Update index on demand_history to include warehouse ─────────────────

DROP INDEX IF EXISTS idx_aim2026_demand_sku_date;
CREATE INDEX idx_aim2026_demand_sku_date_wh
  ON aim2026_demand_history(sku, period_date DESC, warehouse);
