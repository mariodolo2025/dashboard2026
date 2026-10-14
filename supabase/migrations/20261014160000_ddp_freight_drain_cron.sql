-- =============================================================================
-- ddp-freight-drain — a job whose only task is to ask Starshipit what each
-- label cost.
--
-- Why it exists (Mario, 14-Oct-2026): the DDP tab showed "8 of 86 orders
-- labelled" on the day the IC13 rule started, and 2,331 orders going back to
-- 1-Aug had never been priced at all. The cause is not a bug, it is arithmetic.
-- The label price needs ONE HTTP call per order (Starshipit's bulk shipped list
-- carries order_id and tracking but no price - their own OpenAPI confirms it),
-- each call takes about 2 seconds, and that pass was sharing a 140 s run with
-- the Shopify scan and the ZONOS walk. It got through ~45 orders per run, three
-- runs a day, against ~109 new US orders a day. The queue could only grow.
--
-- This job calls the same function with {"only":"freight"}: no Shopify scan, no
-- ZONOS walk, the whole budget on label prices. Measured: 67 orders per run.
-- At every 20 minutes that is ~4,800 a day against a 2,331 backlog, so it
-- clears inside a day and then idles - a run with nothing pending returns in
-- about a second.
--
-- Against the rules in CLAUDE.md for automatic jobs:
--   * bounded per run - one wall-clock budget, stops at 6 s left and reports
--     `remaining`; it never decides how much work to do from the table size;
--   * never repeats failing work - an order is "pending" only while its price
--     is null, and freight_checked_at keeps a fruitless ask from being retried
--     for 6 hours, so a run resumes instead of redoing;
--   * reports its real result - ops_http_post, not net.http_post, so a non-2xx
--     answer is recorded instead of pg_cron's "Succeeded" meaning "queued";
--   * registered in ops_jobs below, so it shows in Connections -> Automatic
--     jobs and puts the red dot on the gear when it fails.
-- Optional: a few failed runs only delay label prices, they never corrupt
-- anything, so the watchdog may pause it rather than shout.
-- =============================================================================

select cron.unschedule('ddp-freight-drain')
where exists (select 1 from cron.job where jobname = 'ddp-freight-drain');

select cron.schedule('ddp-freight-drain', '*/20 * * * *', $job$
  select public.ops_http_post('ddp-freight-drain',
    url:='https://teewkafclgpfpczftvah.supabase.co/functions/v1/ddp-sync',
    headers:=jsonb_build_object('Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlZXdrYWZjbGdwZnBjemZ0dmFoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3NTMxMDcsImV4cCI6MjA3MTMyOTEwN30.JQgrbsh8GYPc-VxxBfvrpyHd0cEDRJyAktp0ZJKsibo','Content-Type','application/json'),
    body:='{"only":"freight"}'::jsonb);
$job$);

insert into public.ops_jobs (jobname, label, kind, via_http, optional, fail_threshold, http_timeout_ms, watch_from, note)
values (
  'ddp-freight-drain',
  'DDP · label prices (every 20 min)',
  'cron', true, true, 3, 150000, now(),
  'Asks Starshipit what each label cost - one call per order, about 67 per run. Fills the "Label cost" column of DDP Markets. Optional: if it fails the watchdog pauses it; nothing else depends on it finishing.'
)
on conflict (jobname) do update
set label = excluded.label, kind = excluded.kind, via_http = excluded.via_http,
    optional = excluded.optional, fail_threshold = excluded.fail_threshold,
    http_timeout_ms = excluded.http_timeout_ms, note = excluded.note;
