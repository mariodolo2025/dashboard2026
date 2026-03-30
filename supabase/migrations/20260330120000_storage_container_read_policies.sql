-- Container Feasibility report: client reads CSV + PDF from Storage bucket `container`.
-- Create the bucket in Dashboard (Storage) if needed, then apply these policies so
-- the anon key used by the web app can list and download objects.

DROP POLICY IF EXISTS "container_bucket_select_anon" ON storage.objects;
DROP POLICY IF EXISTS "container_bucket_select_authenticated" ON storage.objects;

CREATE POLICY "container_bucket_select_anon"
  ON storage.objects FOR SELECT
  TO anon
  USING (bucket_id = 'container');

CREATE POLICY "container_bucket_select_authenticated"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'container');
