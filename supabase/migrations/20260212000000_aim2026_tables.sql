-- =============================================================================
-- AIM 2026 — Database Tables
-- =============================================================================
-- All tables are prefixed with aim2026_ to keep them completely separate
-- from the existing system. The current AIM dashboard continues working
-- unchanged.
-- =============================================================================

-- ─── Sync Log ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aim2026_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  records_synced JSONB DEFAULT '{}'::jsonb,
  errors TEXT[] DEFAULT '{}',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_aim2026_sync_log_synced_at ON aim2026_sync_log(synced_at DESC);

-- RLS
ALTER TABLE aim2026_sync_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read aim2026_sync_log" ON aim2026_sync_log FOR SELECT USING (true);
CREATE POLICY "Service insert aim2026_sync_log" ON aim2026_sync_log FOR INSERT WITH CHECK (true);

-- ─── SOH Snapshots ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aim2026_soh_snapshots (
  id BIGSERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  sku TEXT NOT NULL,
  warehouse TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  allocated INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(snapshot_date, sku, warehouse)
);

CREATE INDEX idx_aim2026_soh_sku ON aim2026_soh_snapshots(sku);
CREATE INDEX idx_aim2026_soh_date ON aim2026_soh_snapshots(snapshot_date DESC);
CREATE INDEX idx_aim2026_soh_sku_date ON aim2026_soh_snapshots(sku, snapshot_date DESC);

-- RLS
ALTER TABLE aim2026_soh_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read aim2026_soh_snapshots" ON aim2026_soh_snapshots FOR SELECT USING (true);
CREATE POLICY "Service insert aim2026_soh_snapshots" ON aim2026_soh_snapshots FOR INSERT WITH CHECK (true);

-- ─── Demand History ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aim2026_demand_history (
  id BIGSERIAL PRIMARY KEY,
  period_date DATE NOT NULL,
  sku TEXT NOT NULL,
  quantity_sold NUMERIC NOT NULL DEFAULT 0,
  revenue NUMERIC NOT NULL DEFAULT 0,
  component_usage NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(period_date, sku)
);

CREATE INDEX idx_aim2026_demand_sku ON aim2026_demand_history(sku);
CREATE INDEX idx_aim2026_demand_date ON aim2026_demand_history(period_date DESC);
CREATE INDEX idx_aim2026_demand_sku_date ON aim2026_demand_history(sku, period_date DESC);

-- RLS
ALTER TABLE aim2026_demand_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read aim2026_demand_history" ON aim2026_demand_history FOR SELECT USING (true);
CREATE POLICY "Service insert aim2026_demand_history" ON aim2026_demand_history FOR INSERT WITH CHECK (true);
CREATE POLICY "Service update aim2026_demand_history" ON aim2026_demand_history FOR UPDATE USING (true);

-- ─── SKU Parameters ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aim2026_sku_parameters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT NOT NULL UNIQUE,
  lead_time_days INTEGER DEFAULT 45,
  service_level_z NUMERIC DEFAULT 1.65,
  min_order_qty INTEGER DEFAULT 1,
  product_group TEXT,
  supplier TEXT,
  product_description TEXT,
  abc_class TEXT CHECK (abc_class IN ('A', 'B', 'C')),
  product_cost_china NUMERIC DEFAULT 0,
  landed_cost_aud NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_aim2026_params_sku ON aim2026_sku_parameters(sku);
CREATE INDEX idx_aim2026_params_group ON aim2026_sku_parameters(product_group);
CREATE INDEX idx_aim2026_params_abc ON aim2026_sku_parameters(abc_class);

-- RLS
ALTER TABLE aim2026_sku_parameters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read aim2026_sku_parameters" ON aim2026_sku_parameters FOR SELECT USING (true);
CREATE POLICY "Service insert aim2026_sku_parameters" ON aim2026_sku_parameters FOR INSERT WITH CHECK (true);
CREATE POLICY "Service update aim2026_sku_parameters" ON aim2026_sku_parameters FOR UPDATE USING (true);
CREATE POLICY "Public update aim2026_sku_parameters" ON aim2026_sku_parameters FOR UPDATE USING (true);

-- ─── Cost Config ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aim2026_cost_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_type TEXT NOT NULL UNIQUE,
  config_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default configs
INSERT INTO aim2026_cost_config (config_type, config_data) VALUES
  ('landed_cost_rates', '{"default": {"freightRate": 0.15, "dutyRate": 0.05, "insuranceRate": 0.01}, "byGroup": {}}'::jsonb),
  ('holding_cost', '{"warehouseItems": [], "capitalRatePercent": 10, "riskRatePercent": 4}'::jsonb),
  ('general', '{"defaultLeadTimeDays": 45, "defaultServiceLevelZ": 1.65, "exchangeRateUSDToAUD": 1.54}'::jsonb)
ON CONFLICT (config_type) DO NOTHING;

-- RLS
ALTER TABLE aim2026_cost_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read aim2026_cost_config" ON aim2026_cost_config FOR SELECT USING (true);
CREATE POLICY "Public upsert aim2026_cost_config" ON aim2026_cost_config FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update aim2026_cost_config" ON aim2026_cost_config FOR UPDATE USING (true);

-- ─── KPI Cache ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aim2026_kpi_cache (
  id BIGSERIAL PRIMARY KEY,
  sku TEXT NOT NULL,
  kpi_data JSONB NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_id UUID REFERENCES aim2026_sync_log(id) ON DELETE SET NULL
);

CREATE INDEX idx_aim2026_kpi_sku ON aim2026_kpi_cache(sku);
CREATE INDEX idx_aim2026_kpi_calculated ON aim2026_kpi_cache(calculated_at DESC);

-- RLS
ALTER TABLE aim2026_kpi_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read aim2026_kpi_cache" ON aim2026_kpi_cache FOR SELECT USING (true);
CREATE POLICY "Service insert aim2026_kpi_cache" ON aim2026_kpi_cache FOR INSERT WITH CHECK (true);
CREATE POLICY "Service delete aim2026_kpi_cache" ON aim2026_kpi_cache FOR DELETE USING (true);

-- ─── Stock Valuation History ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aim2026_stock_valuation_history (
  id BIGSERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  main_warehouse NUMERIC NOT NULL DEFAULT 0,
  china NUMERIC NOT NULL DEFAULT 0,
  container NUMERIC NOT NULL DEFAULT 0,
  dhl NUMERIC NOT NULL DEFAULT 0,
  on_production NUMERIC NOT NULL DEFAULT 0,
  pesado_korea NUMERIC NOT NULL DEFAULT 0,
  total_inventory NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_aim2026_valuation_date ON aim2026_stock_valuation_history(snapshot_date DESC);

-- RLS
ALTER TABLE aim2026_stock_valuation_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read aim2026_stock_valuation_history" ON aim2026_stock_valuation_history FOR SELECT USING (true);
CREATE POLICY "Service insert aim2026_stock_valuation_history" ON aim2026_stock_valuation_history FOR INSERT WITH CHECK (true);
