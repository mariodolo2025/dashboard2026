/*
  # Stock Valuation History Table

  1. New Tables
    - `stock_valuation_history`
      - `id` (bigint, primary key, auto-increment)
      - `recorded_at` (timestamptz, not null, default now())
      - `main_warehouse` (decimal, not null)
      - `china` (decimal, not null)
      - `container` (decimal, not null)
      - `dhl` (decimal, not null)
      - `on_production` (decimal, not null)
      - `total_inventory` (decimal, not null)
      - `created_at` (timestamptz, not null, default now())
  
  2. Indexes
    - Index on `recorded_at` for efficient time-based queries
    - Index on `created_at` for audit purposes
  
  3. Security
    - Enable RLS on `stock_valuation_history` table
    - Add policy for public read access (anyone can view historical data)
    - Add policy for service role to insert records
  
  4. Notes
    - This table stores snapshots of stock valuation at different points in time
    - Useful for tracking inventory value trends over time
    - Data is inserted automatically when the AIM dashboard is updated
*/

-- Create stock_valuation_history table
CREATE TABLE IF NOT EXISTS stock_valuation_history (
  id BIGSERIAL PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  main_warehouse DECIMAL(12, 2) NOT NULL DEFAULT 0,
  china DECIMAL(12, 2) NOT NULL DEFAULT 0,
  container DECIMAL(12, 2) NOT NULL DEFAULT 0,
  dhl DECIMAL(12, 2) NOT NULL DEFAULT 0,
  on_production DECIMAL(12, 2) NOT NULL DEFAULT 0,
  total_inventory DECIMAL(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_stock_valuation_history_recorded_at 
  ON stock_valuation_history(recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_valuation_history_created_at 
  ON stock_valuation_history(created_at DESC);

-- Enable Row Level Security
ALTER TABLE stock_valuation_history ENABLE ROW LEVEL SECURITY;

-- Policy: Anyone can read historical stock valuation data
CREATE POLICY "Public read access to stock valuation history"
  ON stock_valuation_history
  FOR SELECT
  USING (true);

-- Policy: Only service role can insert new records
CREATE POLICY "Service role can insert stock valuation history"
  ON stock_valuation_history
  FOR INSERT
  TO service_role
  WITH CHECK (true);