-- =============================================================================
-- ddp-freight-drain - what the job does now, recorded where the watchdog shows
-- it. No schedule change; the behaviour change lives in ddp-sync.
--
-- 15-Oct-2026: Mario printed labels all morning and the IC13 figure did not
-- move. Two reasons, both fixed in ddp-sync:
--   * the freight run skipped Shopify, so an order placed after the
--     orchestrator's last run did not exist here and could not be priced
--     until the next one (up to nine hours). It now reads the last 2 days.
--   * an order asked about before it was packed waited 6 hours to be asked
--     again. Recent orders are now watched: the moment they appear in
--     Starshipit's shipped list - read in bulk, no extra calls - they are
--     priced in that same run.
-- First run after the change priced 52 such orders; the IC13 view went from
-- 31 labels to 96.
-- =============================================================================

update public.ops_jobs
set note = 'Prices labels: asks Starshipit what each one cost, one call per order. Reads the last 2 days of Shopify first, so a new order can be priced in the run right after its label is printed. Orders asked about before they were packed are re-checked as soon as Starshipit lists them as shipped. Optional: if it fails the watchdog pauses it; nothing else depends on it finishing.'
where jobname = 'ddp-freight-drain';
