# AIM 2026 — project rules

## Automatic jobs (pg_cron, edge functions called on a schedule)

Written after the 5/6-Oct-2026 outage (docs/PLAN-DISK-IO-2026-10-06.md): a
cache job retried the same failing computation 127 times and drained the
database's disk budget, and the event archive had answered HTTP 500 every hour
for five weeks. Nobody knew, because nothing checked.

Every new or changed job must:

1. **Do bounded work per run.** A fixed number of rows, pages or batches, and
   a time budget below its limit. A query whose cost grows with the table or
   with the calendar does not belong in a job.
2. **Never retry the same failing work blindly.** Save progress as it goes, so
   a cut run resumes instead of repeating; a run that cannot progress must fail
   loudly, not loop.
3. **Report its real result.** HTTP jobs call `public.ops_http_post('<job>', ...)`
   instead of `net.http_post(...)` (same named arguments), and answer non-2xx
   on any failure. pg_cron's "Succeeded" only means the request was queued.
4. **Be registered in `public.ops_jobs`** (label, threshold, `optional` if it
   may be paused automatically, `http_timeout_ms` if the function takes longer
   than 5 s). The watchdog (`ops_watchdog`, every 15 min) then shows it in
   Connections → Automatic jobs and puts a red dot on the Config gear when it
   fails. Add a `freshness` check when the data itself can prove the job works.

Before calling anything fixed: measure, and watch it in Automatic jobs.
