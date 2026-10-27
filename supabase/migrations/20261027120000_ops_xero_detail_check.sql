-- =============================================================================
-- Watchdog: Xero freight & rates detail must equal the P&L
-- =============================================================================
-- docs/PLAN-XERO-DETAIL-SYNC-2026-10-27-v2.md, P5 (approved by Mario
-- 27-Oct-2026). Built from the live ops_watchdog() with three changes:
--
-- 1. New freshness check "xero-detail" (Connections → Automatic jobs): red
--    when a closed month of Freight & Courier or Rates & Taxes in
--    xero_account_lines is off the P&L by more than A$1 (from the 15th of the
--    next month), when the incremental read was cut 3 runs in a row, or when
--    bills, credit notes or bank transactions have not finished a read in 26 h.
-- 2. "xero-last-sync" no longer turns red for a run cut by its time budget
--    (partial:true): the progress is saved and the next run continues; the
--    3-in-a-row rule above covers a read that never catches up.
-- 3. An HTTP answer 2xx whose body says "success": false counts as a failure
--    (before, only the status code was read). No 2xx answer of the last 6 h
--    said so when this was written.

insert into public.ops_jobs (jobname, label, kind, via_http, optional, fail_threshold, http_timeout_ms, note) values
  ('xero-detail', 'Xero · freight & rates = P&L', 'freshness', false, false, 1, null,
   'Fails when Freight & Courier or Rates & Taxes lines differ from the P&L by more than A$1 in a closed month (checked from the 15th of the next month), when the detail read was cut 3 runs in a row, or when a source has not finished a read in 26 hours.')
on conflict (jobname) do update set label = excluded.label, note = excluded.note;

CREATE OR REPLACE FUNCTION public.ops_watchdog()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$

declare

  r          record;

  v_lo       bigint;

  v_paused   text[] := '{}';

  v_val      timestamptz;

  v_fail     boolean;

  v_detail   text;

  v_closed   text;

  v_open     text;

  v_stale    text;

  v_streak   integer;

begin

  if not pg_try_advisory_xact_lock(hashtext('ops_watchdog')) then

    return jsonb_build_object('skipped', 'another watchdog run holds the lock');

  end if;



  -- 1. Resolve HTTP answers. pg_net keeps them 6 h; the watchdog runs every 15 min.

  update public.ops_http_calls c set

    resolved_at = now(),

    ok          = (resp.status_code between 200 and 299 and resp.error_msg is null
                    and coalesce(resp.content, '') !~ '"success"\s*:\s*false'),

    status_code = resp.status_code,

    error       = case when resp.status_code between 200 and 299 and resp.error_msg is null
                    and coalesce(resp.content, '') !~ '"success"\s*:\s*false' then null

                       else left(coalesce(resp.error_msg, 'HTTP ' || resp.status_code || ': ' || coalesce(resp.content, '')), 300) end

  from net._http_response resp

  where resp.id = c.request_id and c.resolved_at is null;



  update public.ops_http_calls set

    resolved_at = now(), ok = false,

    error = 'no answer recorded within 6 h (pg_net drops answers after 6 h)'

  where resolved_at is null and called_at < now() - interval '6 hours 30 minutes';



  delete from public.ops_http_calls where called_at < now() - interval '14 days';



  -- 2. Cron jobs: consecutive failures since the last success.

  --    SQL jobs: pg_cron's finished runs. HTTP jobs: a failed cron run (the

  --    request could not even be queued) or a failed answer; a "succeeded"

  --    cron run of an HTTP job only means queued, so it is not evidence.

  select max(runid) - 9000 into v_lo from cron.job_run_details;



  drop table if exists ops_ev;

  create temp table ops_ev on commit drop as

    select j.jobname::text as jobname,

           coalesce(d.end_time, d.start_time) as at,

           (d.status = 'succeeded') as ok,

           left(d.return_message, 300) as err

    from cron.job_run_details d

    join cron.job j on j.jobid = d.jobid

    join public.ops_jobs o on o.jobname = j.jobname and o.kind = 'cron'

    where d.runid > coalesce(v_lo, 0)

      and coalesce(d.end_time, d.start_time) >= o.watch_from

      and d.status in ('succeeded', 'failed')

      and (not o.via_http or d.status = 'failed')

    union all

    select c.jobname, c.called_at, c.ok, c.error

    from public.ops_http_calls c

    join public.ops_jobs o on o.jobname = c.jobname and o.kind = 'cron'

    where c.resolved_at is not null and c.called_at > now() - interval '5 days'

      and c.called_at >= o.watch_from;



  for r in

    select o.jobname, o.optional, o.fail_threshold, j.jobid, j.active,

           lo.last_ok,

           (select max(e.at) from ops_ev e where e.jobname = o.jobname and not e.ok) as last_fail,

           (select count(*) from ops_ev e where e.jobname = o.jobname and not e.ok

              and e.at > coalesce(lo.last_ok, '-infinity')) as consec,

           (select min(e.at) from ops_ev e where e.jobname = o.jobname and not e.ok

              and e.at > coalesce(lo.last_ok, '-infinity')) as failing_since,

           (select e.err from ops_ev e where e.jobname = o.jobname and not e.ok

              order by e.at desc limit 1) as last_err,

           exists (select 1 from ops_ev e where e.jobname = o.jobname) as has_history,

           s.paused_at, s.paused_reason

    from public.ops_jobs o

    left join cron.job j on j.jobname = o.jobname

    left join public.ops_job_status s on s.jobname = o.jobname

    cross join lateral (select max(e.at) as last_ok from ops_ev e where e.jobname = o.jobname and e.ok) lo

    where o.kind = 'cron'

  loop

    -- Pause an optional job that reached its threshold, once.

    if r.optional and r.active and r.consec >= r.fail_threshold then

      perform cron.alter_job(r.jobid, active := false);

      r.active := false;

      r.paused_at := now();

      r.paused_reason := format('paused by the watchdog after %s failures in a row (since %s): %s',

                                r.consec, to_char(r.failing_since at time zone 'Australia/Brisbane', 'DD Mon HH24:MI'),

                                coalesce(r.last_err, 'no message'));

      v_paused := v_paused || r.jobname;

    elsif r.active then

      -- Turned back on by a person: forget the old pause.

      r.paused_at := null;

      r.paused_reason := null;

    end if;



    insert into public.ops_job_status as t

      (jobname, state, consecutive_failures, last_ok_at, last_fail_at, failing_since, last_error,

       checked_at, paused_at, paused_reason)

    values (

      r.jobname,

      case when r.jobid is null then 'unknown'

           when not r.active and r.paused_at is not null then 'paused'

           when not r.active then 'off'

           when r.consec >= r.fail_threshold then 'failing'

           when r.consec > 0 then 'warn'

           when not r.has_history then 'unknown'

           else 'ok' end,

      r.consec, r.last_ok, r.last_fail, r.failing_since, r.last_err, now(), r.paused_at, r.paused_reason)

    on conflict (jobname) do update set

      state = excluded.state, consecutive_failures = excluded.consecutive_failures,

      last_ok_at = excluded.last_ok_at, last_fail_at = excluded.last_fail_at,

      failing_since = excluded.failing_since, last_error = excluded.last_error,

      checked_at = excluded.checked_at, paused_at = excluded.paused_at,

      paused_reason = excluded.paused_reason;

  end loop;



  -- 3. Freshness checks: the data itself says whether its job is working,

  --    whatever the job reports. Each probe is one index-backed row.

  for r in select o.jobname from public.ops_jobs o where o.kind = 'freshness' loop

    v_fail := null; v_detail := null; v_val := null;



    if r.jobname = 'wu-ingest' then

      -- Storefront events arrive every few seconds around the clock. Server

      -- receive time of the newest row by id: the event's own timestamp comes

      -- from the shopper's browser and can sit hours in the future.

      select received_at into v_val from public.upgrade_events order by id desc limit 1;

      v_fail := v_val is null or v_val < now() - interval '60 minutes';

      v_detail := 'newest Web Upgrade event: ' || coalesce(to_char(v_val at time zone 'Australia/Brisbane', 'DD Mon HH24:MI'), 'none');



    elsif r.jobname = 'wu-raw-retention' then

      -- The archive keeps 14 days of raw events; two days of slack.

      select min(event_timestamp) into v_val from public.upgrade_events where environment = 'production';

      v_fail := v_val is not null and v_val < now() - interval '16 days';

      v_detail := 'oldest raw event kept: ' || coalesce(to_char(v_val at time zone 'Australia/Brisbane', 'DD Mon YYYY'), 'none')

                  || ' (target: 14 days)';



    elsif r.jobname = 'sync-engine' then

      -- Kickoffs at 03, 10 and 18 UTC: the longest gap is 9 h plus the run.

      select max(coalesce(finished_at, updated_at)) into v_val from public.sync_runs where status <> 'running';

      v_fail := v_val is null or v_val < now() - interval '10 hours';

      v_detail := 'last sync run finished: ' || coalesce(to_char(v_val at time zone 'Australia/Brisbane', 'DD Mon HH24:MI'), 'never');



    elsif r.jobname = 'sync-steps' then

      -- A step that failed in each of the last 3 finished runs.

      select string_agg(step, ', ' order by step) into v_detail

      from (

        select s->>'name' as step

        from (select steps from public.sync_runs where status <> 'running'

              order by started_at desc limit 3) last3

        cross join jsonb_array_elements(case jsonb_typeof(last3.steps) when 'array' then last3.steps else '[]'::jsonb end) s

        where s->>'status' = 'error'

        group by 1

        having count(*) = 3

      ) x;

      v_fail := v_detail is not null;

      v_detail := case when v_fail then 'failed in each of the last 3 runs: ' || v_detail

                       else 'no step failed 3 runs in a row' end;

      select max(started_at) into v_val from public.sync_runs where status <> 'running';



    elsif r.jobname = 'public-tables-rls' then
      -- Any table the API can reach without row-level security is readable,
      -- editable and deletable by anyone holding the public (anon) key.
      -- A copy made with CREATE TABLE AS is born that way (3-Oct-2026).
      select string_agg(c.relname, ', ' order by c.relname) into v_detail
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'graphql_public') and c.relkind in ('r', 'p')
        and not c.relrowsecurity;
      v_fail := v_detail is not null;
      v_detail := case when v_fail then 'tables open to the public key: ' || v_detail
                       else 'every table in public has row-level security' end;

    elsif r.jobname = 'public-functions-anon' then
      -- A function the public (anon) key can run is callable by anyone who
      -- loads the login page. Until 8-Oct-2026 that included four that move
      -- China stock and two that rebuild whole histories.
      select string_agg(p.proname, ', ' order by p.proname) into v_detail
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');
      v_fail := v_detail is not null;
      v_detail := case when v_fail then 'functions anyone can run without logging in: ' || v_detail
                       else 'no function in public runs without login' end;

    elsif r.jobname = 'xero-last-sync' then

      select (value->>'at')::timestamptz,
             coalesce((value->>'ok')::boolean, false) or coalesce((value->>'partial')::boolean, false)

        into v_val, v_fail

      from public.xero_sync_state where key = 'last_sync';

      v_fail := v_val is null or v_val < now() - interval '26 hours' or not coalesce(v_fail, false);

      v_detail := 'last Xero sync: ' || coalesce(to_char(v_val at time zone 'Australia/Brisbane', 'DD Mon HH24:MI'), 'never');

    elsif r.jobname = 'xero-detail' then
      -- Freight & Courier and Rates & Taxes lines (xero_account_lines) must add
      -- up to the P&L (xero_pl_monthly). xero-sync re-reads every night any
      -- month off by more than A$1; a month still off after that is a real
      -- gap, never scaled away. Red when a month closed by the 15th of the
      -- next month is off by more than A$1, the incremental read was cut 3
      -- runs in a row, or a source has not finished a read in 26 h. Months
      -- still open are listed, not red. Bounded: the last 13 months.
      -- docs/PLAN-XERO-DETAIL-SYNC-2026-10-27-v2.md, P5.
      select string_agg(x.month || ' ' || x.account_name || ' A$' || x.diff, '; ' order by x.month, x.account_name)
               filter (where (to_date(x.month, 'YYYY-MM') + interval '1 month 14 days')::date
                             <= (now() at time zone 'Australia/Brisbane')::date),
             string_agg(x.month || ' ' || x.account_name || ' A$' || x.diff, '; ' order by x.month, x.account_name)
               filter (where (to_date(x.month, 'YYYY-MM') + interval '1 month 14 days')::date
                             > (now() at time zone 'Australia/Brisbane')::date)
        into v_closed, v_open
      from public.xero_lines_reconcile(greatest(date '2026-07-01',
             (date_trunc('month', now() at time zone 'Australia/Brisbane') - interval '12 months')::date)) x
      where abs(x.diff) > 1;

      select coalesce((value->>'partialStreak')::int, 0), (value->>'lastRun')::timestamptz
        into v_streak, v_val
      from public.xero_sync_state where key = 'detail_v2';

      select string_agg(k.src, ', ' order by k.src) into v_stale
      from (values ('bill'), ('credit'), ('bank')) k(src)
      left join public.xero_sync_state s on s.key = 'detail_v2_' || k.src
      where coalesce((s.value->>'lastDone')::timestamptz, '-infinity'::timestamptz) < now() - interval '26 hours';

      v_fail := v_closed is not null or coalesce(v_streak, 0) >= 3 or v_stale is not null or v_val is null;
      v_detail := case when v_fail then
                    concat_ws('; ',
                      case when v_closed is not null then 'closed months off the P&L: ' || v_closed end,
                      case when coalesce(v_streak, 0) >= 3 then 'read cut by the time budget ' || v_streak || ' runs in a row' end,
                      case when v_stale is not null then 'no finished read in 26 h: ' || v_stale end,
                      case when v_val is null then 'the detail step never ran' end)
                  else 'lines = P&L within A$1 in every closed month; last read '
                       || to_char(v_val at time zone 'Australia/Brisbane', 'DD Mon HH24:MI') end
                  || case when v_open is not null then ' (open months still off: ' || v_open || ')' else '' end;

    end if;



    insert into public.ops_job_status as t

      (jobname, state, consecutive_failures, last_ok_at, last_fail_at, failing_since, last_error, checked_at)

    values (r.jobname,

            case when v_fail is null then 'unknown' when v_fail then 'failing' else 'ok' end,

            case when v_fail then 1 else 0 end,

            case when v_fail = false then now() end,

            case when v_fail then now() end,

            case when v_fail then now() end,

            v_detail, now())

    on conflict (jobname) do update set

      state = excluded.state,

      consecutive_failures = case when excluded.state = 'failing' then t.consecutive_failures + 1 else 0 end,

      last_ok_at = coalesce(excluded.last_ok_at, t.last_ok_at),

      last_fail_at = coalesce(excluded.last_fail_at, t.last_fail_at),

      -- keep the first moment it went bad

      failing_since = case when excluded.state = 'failing' then coalesce(t.failing_since, now()) end,

      last_error = excluded.last_error,

      checked_at = excluded.checked_at;

  end loop;



  return jsonb_build_object(

    'checkedAt', now(),

    'paused', to_jsonb(v_paused),

    'failing', (select coalesce(jsonb_agg(jobname order by jobname), '[]'::jsonb)

                from public.ops_job_status where state in ('failing', 'paused')));

end

$function$;
