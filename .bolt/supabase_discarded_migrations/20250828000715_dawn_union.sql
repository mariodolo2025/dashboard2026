/*
  # Create AIM CSV files storage bucket

  1. New Storage Bucket
    - `aim-csv-files` bucket for storing AIM-related CSV files
    - Public read access for the application to download files
    - Files expected: SalesEnquiryList.csv, SOHList.csv, ProductionEnquiryList.csv, PurchaseEnquiryList.csv

  2. Security
    - Enable RLS on storage objects
    - Allow public read access to files in the aim-csv-files bucket
*/

-- Create the aim-csv-files bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('aim-csv-files', 'aim-csv-files', true)
ON CONFLICT (id) DO NOTHING;

-- Allow public read access to files in the aim-csv-files bucket
CREATE POLICY "Public read access for aim-csv-files"
  ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'aim-csv-files');