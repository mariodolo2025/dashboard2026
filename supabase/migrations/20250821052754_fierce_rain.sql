/*
  # Create Storage Bucket for CSV Files

  1. Storage Setup
    - Create 'csv-files' bucket for storing the 5 CSV files
    - Enable public access for reading files
    - Set up appropriate policies for file access

  2. Security
    - Allow public read access to CSV files
    - Restrict upload/delete to authenticated users (for future admin functionality)
*/

-- Create the storage bucket for CSV files
INSERT INTO storage.buckets (id, name, public)
VALUES ('csv-files', 'csv-files', true);

-- Allow public read access to CSV files
CREATE POLICY "Public read access for CSV files"
ON storage.objects FOR SELECT
USING (bucket_id = 'csv-files');

-- Allow authenticated users to upload/update files (for admin functionality)
CREATE POLICY "Authenticated users can upload CSV files"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'csv-files');

CREATE POLICY "Authenticated users can update CSV files"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'csv-files');