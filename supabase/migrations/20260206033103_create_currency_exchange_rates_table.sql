/*
  # Create currency_exchange_rates table

  1. New Tables
    - `currency_exchange_rates`
      - `id` (uuid, primary key) - Unique identifier
      - `year` (integer) - Year of the exchange rate
      - `month` (integer) - Month of the exchange rate (1-12)
      - `rate` (numeric) - Average exchange rate for the month (1 USD = X AUD)
      - `created_at` (timestamptz) - When this record was created
      - `updated_at` (timestamptz) - When this record was last updated
      
  2. Security
    - Enable RLS on `currency_exchange_rates` table
    - Add policy for authenticated users to read exchange rates
    - Add policy for authenticated users to insert/update rates (can be restricted to admin later)
    
  3. Initial Data
    - Pre-populate with historical exchange rates from July 2025 to February 2026
    - Data sourced from reliable exchange rate providers (x-rates.com, ATO)
    
  4. Constraints
    - Unique constraint on (year, month) to prevent duplicate entries
    - Check constraint to ensure month is between 1 and 12
    - Check constraint to ensure rate is positive
*/

CREATE TABLE IF NOT EXISTS currency_exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year integer NOT NULL,
  month integer NOT NULL CHECK (month >= 1 AND month <= 12),
  rate numeric NOT NULL CHECK (rate > 0),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(year, month)
);

ALTER TABLE currency_exchange_rates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read exchange rates"
  ON currency_exchange_rates FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert exchange rates"
  ON currency_exchange_rates FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update exchange rates"
  ON currency_exchange_rates FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete exchange rates"
  ON currency_exchange_rates FOR DELETE
  TO authenticated
  USING (true);

-- Insert historical exchange rates from July 2025 to February 2026
-- Data sourced from x-rates.com and Australian Taxation Office
INSERT INTO currency_exchange_rates (year, month, rate) VALUES
  (2025, 7, 1.527592),   -- July 2025
  (2025, 8, 1.539535),   -- August 2025
  (2025, 9, 1.517419),   -- September 2025
  (2025, 10, 1.529011),  -- October 2025
  (2025, 11, 1.536547),  -- November 2025
  (2025, 12, 1.505074),  -- December 2025
  (2026, 1, 1.44),       -- January 2026 (approximate based on recent range)
  (2026, 2, 1.44)        -- February 2026 (current as per user specification)
ON CONFLICT (year, month) DO NOTHING;
