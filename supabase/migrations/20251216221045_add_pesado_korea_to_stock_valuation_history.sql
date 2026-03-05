/*
  # Add pesado_korea column to stock_valuation_history table

  1. Changes
    - Add `pesado_korea` column to track stock valuation for Pesado Korea warehouse
    - This column stores the monetary value of inventory in the Pesado Korea warehouse
    - Follows the same pattern as existing warehouse columns (main_warehouse, china, etc.)

  2. Migration Details
    - Column: `pesado_korea` (numeric, default 0)
    - Default: 0 (no inventory value for backward compatibility)
    - Type: NUMERIC for precise monetary calculations
  
  3. Notes
    - The total_inventory calculation should include this new warehouse value
    - Pesado Korea warehouse is identified by the name "Pesado Korea" in the SOHList.csv file
    - This value represents the monetary valuation of stock on hand in Pesado Korea warehouse
*/

-- Add pesado_korea column to stock_valuation_history table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'stock_valuation_history' AND column_name = 'pesado_korea'
  ) THEN
    ALTER TABLE stock_valuation_history 
    ADD COLUMN pesado_korea NUMERIC DEFAULT 0 NOT NULL;
  END IF;
END $$;

-- Add helpful comment to the column
COMMENT ON COLUMN stock_valuation_history.pesado_korea IS 
  'The monetary value of inventory in Pesado Korea warehouse. Calculated from stock on hand quantities multiplied by unit costs.';