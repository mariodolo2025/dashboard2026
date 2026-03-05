/*
  # Add data_source_date column to stock_valuation_history table

  1. Changes
    - Add `data_source_date` column to track the actual date of the source data (last updated)
    - This is different from `recorded_at` which tracks when the snapshot was taken
    - `data_source_date` represents the most recent transaction date in the CSV files
    - Add index on `data_source_date` for efficient queries and filtering
  
  2. Migration Details
    - Column: `data_source_date` (timestamptz, nullable initially for backward compatibility)
    - Default: NULL (will be populated by the application going forward)
    - Index: For efficient date-based queries
  
  3. Notes
    - `recorded_at`: When the snapshot was taken (timestamp of processing)
    - `data_source_date`: The date of the most recent data in the source files
    - `created_at`: When the record was inserted into the database (audit trail)
    - This allows us to track data freshness independently from processing time
    - Enables smart deduplication: only save new snapshots when data or source date changes
*/

-- Add data_source_date column to stock_valuation_history table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'stock_valuation_history' AND column_name = 'data_source_date'
  ) THEN
    ALTER TABLE stock_valuation_history 
    ADD COLUMN data_source_date TIMESTAMPTZ;
  END IF;
END $$;

-- Create index on data_source_date for efficient queries
CREATE INDEX IF NOT EXISTS idx_stock_valuation_history_data_source_date 
  ON stock_valuation_history(data_source_date DESC);

-- Add helpful comment to the column
COMMENT ON COLUMN stock_valuation_history.data_source_date IS 
  'The date of the most recent transaction/data in the source CSV files. This represents when the data was last updated, not when it was processed.';