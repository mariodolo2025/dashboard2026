-- =============================================================================
-- 2026-08-17 (Brisbane) · timeout audit: collision with the sync window
-- =============================================================================
-- Symptom: "canceling statement due to statement timeout" opening Web Upgrade
-- at 06:1x Brisbane on 17-Aug, one week after the rollup rewrite supposedly
-- fixed the panel for good.
--
-- Audit result — the RPC is NOT the problem:
--   · web_upgrade_performance (rollup version): 0.57s warm / 4.8s cold on an
--     idle database. The Aug-7 design holds.
--   · The orchestrator's 06:00-Brisbane run (kickoff cron '0 3,10,20' UTC) ran
--     20:00:01 -> 20:22:07 UTC — exactly when Mario opened the panel. Its heavy
--     steps (Unleashed sales 99.5s, assemblies 71s, Meta creatives 61s) saturate
--     the instance's IO; a cold open during that window crosses 25s and dies.
--   · The database DOUBLED in 12 days: 632 MB -> 1,151 MB against 224 MB of
--     shared_buffers (events keep growing ~15-18k/day; the advertising agent's
--     attribution tables added ~70 MB; web_upgrade_sessions_daily is 141 MB).
--     Cold reads increasingly go to throttled disk.
--
-- Two changes, both applied live:
--
-- 1. Kickoff cron moved off Mario's morning (applied via cron.alter_job(5),
--    recorded here as documentation — jobids differ across environments):
--        schedule '0 3,10,20 * * *'  ->  '0 3,10,18 * * *'   (UTC)
--    18:00 UTC = 04:00 Brisbane; the run finishes ~04:25, before the dashboard
--    is opened. The 03:00/10:00 UTC runs (13:00/20:00 Brisbane) stay put.
--
-- 2. A collision that still happens must degrade to a slow load, not an error.
--    25s -> 50s, under Supabase's ~60s HTTP ceiling. This is a safety net, not
--    the fix — outside sync windows the RPCs answer in 0.5-5s.
--
-- Still open (Mario's decisions, not code): purge/archive upgrade_events raw
-- (429 MB nobody reads), instance size, and the theme still emitting
-- compatibility_bar_view per PAGE (~4-5.6k/day) instead of per session.

alter function public.web_upgrade_performance(date, date, text)
  set statement_timeout = '50s';

alter function public.ecommerce_dashboard(date, date, text, numeric, text)
  set statement_timeout = '50s';
