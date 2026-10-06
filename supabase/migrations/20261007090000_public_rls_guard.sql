-- =============================================================================
-- No table in the API's schema without row-level security, ever again
-- =============================================================================
-- Supabase, 3-Oct-2026, CRITICAL "Table publicly accessible": three backups
-- made with CREATE TABLE AS (which does not copy row-level security) sat in
-- public, readable, editable and deletable with the public anon key:
--   aim2026_sku_parameters_bkp_20260909 (China costs, made 9-Sep)
--   aim2026_bom_components_bkp_20260826, aim2026_assembled_products_bkp_20260826
-- RLS was switched on for all three on 7-Oct (checked from outside with the
-- anon key: each now answers []). Edge logs of 30-Sep and 4/5/6-Oct show no
-- request to any *_bkp_* table.
--
-- 1. The three backups leave the API: schema `backup`, which PostgREST does not
--    expose and anon/authenticated cannot use. Nothing is deleted.
-- 2. The ops watchdog gets a check that turns red the moment any table in
--    public has row-level security off.

create schema if not exists backup;
revoke all on schema backup from public, anon, authenticated;
comment on schema backup is
  'One-off backup copies. Not exposed by the API (PostgREST serves public and graphql_public only); anon and authenticated have no usage. Moved here on 7-Oct-2026 after Supabase flagged them as public.';

alter table if exists public.aim2026_sku_parameters_bkp_20260909 enable row level security;
alter table if exists public.aim2026_bom_components_bkp_20260826 enable row level security;
alter table if exists public.aim2026_assembled_products_bkp_20260826 enable row level security;
alter table if exists public.aim2026_sku_parameters_bkp_20260909 set schema backup;
alter table if exists public.aim2026_bom_components_bkp_20260826 set schema backup;
alter table if exists public.aim2026_assembled_products_bkp_20260826 set schema backup;

insert into public.ops_jobs (jobname, label, kind, via_http, optional, fail_threshold, http_timeout_ms, note) values
  ('public-tables-rls', 'Security · every table protected', 'freshness', false, false, 1, null,
   'Fails when any table the API can reach (schema public) has row-level security off: with it off, anyone holding the public key can read, edit and delete the table.')
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

begin

  if not pg_try_advisory_xact_lock(hashtext('ops_watchdog')) then

    return jsonb_build_object('skipped', 'another watchdog run holds the lock');

  end if;



  -- 1. Resolve HTTP answers. pg_net keeps them 6 h; the watchdog runs every 15 min.

  update public.ops_http_calls c set

    resolved_at = now(),

    ok          = (resp.status_code between 200 and 299 and resp.error_msg is null),

    status_code = resp.status_code,

    error       = case when resp.status_code between 200 and 299 and resp.error_msg is null then null

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

    elsif r.jobname = 'xero-last-sync' then

      select (value->>'at')::timestamptz, coalesce((value->>'ok')::boolean, false)

        into v_val, v_fail

      from public.xero_sync_state where key = 'last_sync';

      v_fail := v_val is null or v_val < now() - interval '26 hours' or not coalesce(v_fail, false);

      v_detail := 'last Xero sync: ' || coalesce(to_char(v_val at time zone 'Australia/Brisbane', 'DD Mon HH24:MI'), 'never');

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
