-- Auto-sync schedule (operational; reproduces the live cron setup).
--
--   sync-refresh-kickoff : creates a full-refresh run N times/day. The times are
--                          user-editable from Config → Connections (rewrites this
--                          job via connection_cron_set), so treat the schedule
--                          here as the initial default.
--   sync-refresh-driver  : every minute, advances the active run by one step.
--                          Each tick claims the next step and runs it as a
--                          background task (EdgeRuntime.waitUntil), so the tick
--                          returns immediately and the step finishes even after
--                          pg_net closes the connection.
--
-- The Bearer token is the public anon key (same one shipped in the frontend
-- bundle), used only to pass the functions' verify_jwt gate.

do $$
declare
  anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlZXdrYWZjbGdwZnBjemZ0dmFoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3NTMxMDcsImV4cCI6MjA3MTMyOTEwN30.JQgrbsh8GYPc-VxxBfvrpyHd0cEDRJyAktp0ZJKsibo';
  base text := 'https://teewkafclgpfpczftvah.supabase.co/functions/v1/sync-orchestrate';
begin
  -- Retire the standalone sales cron; the orchestrator runs it as step 0.
  perform cron.unschedule('unleashed-sales-sync-daily') where exists (select 1 from cron.job where jobname = 'unleashed-sales-sync-daily');

  perform cron.unschedule('sync-refresh-kickoff') where exists (select 1 from cron.job where jobname = 'sync-refresh-kickoff');
  perform cron.schedule('sync-refresh-kickoff', '0 3,10,20 * * *', format($job$
    select net.http_post(
      url:=%L,
      body:='{"kickoff":true,"trigger":"cron"}'::jsonb,
      headers:=jsonb_build_object('Authorization','Bearer %s','Content-Type','application/json'));
  $job$, base, anon));

  perform cron.unschedule('sync-refresh-driver') where exists (select 1 from cron.job where jobname = 'sync-refresh-driver');
  perform cron.schedule('sync-refresh-driver', '* * * * *', format($job$
    select net.http_post(
      url:=%L,
      body:='{"trigger":"driver"}'::jsonb,
      headers:=jsonb_build_object('Authorization','Bearer %s','Content-Type','application/json'),
      timeout_milliseconds:=20000);
  $job$, base, anon));
end $$;
