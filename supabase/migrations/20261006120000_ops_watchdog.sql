-- =============================================================================
-- ops watchdog — no automatic job fails in silence again
-- =============================================================================
-- 5/6-Oct-2026 outage (docs/PLAN-DISK-IO-2026-10-06.md): the Web Upgrade cache
-- tick failed 127 times in a row and drained the disk budget; the event
-- archive had returned HTTP 500 every hour since 31-Aug. Nobody saw either.
-- pg_cron's own history could not have said so: for a job that calls an edge
-- function it records "succeeded" the moment the request is QUEUED, and the
-- function's answer lands in net._http_response, which keeps no URL and is
-- purged after 6 hours.
--
-- What this adds:
--   * ops_jobs            what is watched, by whom it may be paused, thresholds.
--   * ops_http_post()     drop-in for net.http_post that remembers which job
--                         sent each request, so the answer can be traced back.
--                         Cron commands are rewritten to call it (end of file).
--   * ops_http_calls      one row per request, resolved with the real answer.
--   * ops_watchdog()      every 15 min: resolves answers, computes each job's
--                         consecutive failures, runs the freshness checks,
--                         PAUSES optional jobs at their threshold, stores a
--                         snapshot in ops_job_status. Reads only small ranges:
--                         the last ~9000 cron runs by primary key, the open
--                         HTTP calls, and index-backed min/max probes.
--   * ops_health()        what Connections shows.
--
-- Stateless on purpose: consecutive failures are recomputed from history every
-- time, so a missed or doubled watchdog run can never miscount.

create table if not exists public.ops_jobs (
  jobname          text primary key,
  label            text not null,
  kind             text not null check (kind in ('cron', 'freshness')),
  via_http         boolean not null default false,
  optional         boolean not null default false,
  fail_threshold   integer not null default 3 check (fail_threshold >= 1),
  http_timeout_ms  integer,
  -- History before this moment is ignored. For HTTP jobs it is the moment they
  -- were wired to ops_http_post: before that their answers were never recorded,
  -- so an old queue failure would count with no success to offset it.
  watch_from       timestamptz not null default now(),
  note             text
);
comment on table public.ops_jobs is
  'What the ops watchdog watches. kind=cron: a pg_cron job by name; kind=freshness: a data check computed in ops_watchdog. optional=true: the watchdog may PAUSE the cron job once fail_threshold consecutive failures are reached (business syncs are never optional: they only alert). http_timeout_ms: how long ops_http_post waits for the function''s answer when the cron command does not say.';

create table if not exists public.ops_http_calls (
  request_id   bigint primary key,
  jobname      text not null,
  called_at    timestamptz not null default now(),
  resolved_at  timestamptz,
  ok           boolean,
  status_code  integer,
  error        text
);
create index if not exists ops_http_calls_job_time on public.ops_http_calls (jobname, called_at desc);
create index if not exists ops_http_calls_open on public.ops_http_calls (called_at) where resolved_at is null;
comment on table public.ops_http_calls is
  'One row per HTTP request a cron job sent through ops_http_post, resolved by ops_watchdog with the function''s real answer from net._http_response (2xx = ok). Kept 14 days.';

create table if not exists public.ops_job_status (
  jobname              text primary key references public.ops_jobs (jobname) on delete cascade,
  state                text not null,
  consecutive_failures integer not null default 0,
  last_ok_at           timestamptz,
  last_fail_at         timestamptz,
  failing_since        timestamptz,
  last_error           text,
  checked_at           timestamptz not null default now(),
  paused_at            timestamptz,
  paused_reason        text
);
comment on table public.ops_job_status is
  'Snapshot written by ops_watchdog every 15 min. state: ok | warn (failing, under threshold) | failing | paused (stopped by the watchdog) | off (cron job inactive) | unknown (no history yet).';

alter table public.ops_jobs enable row level security;
alter table public.ops_http_calls enable row level security;
alter table public.ops_job_status enable row level security;
drop policy if exists ops_jobs_read on public.ops_jobs;
create policy ops_jobs_read on public.ops_jobs for select to authenticated, service_role using (true);
drop policy if exists ops_job_status_read on public.ops_job_status;
create policy ops_job_status_read on public.ops_job_status for select to authenticated, service_role using (true);

-- ── the HTTP wrapper ─────────────────────────────────────────────────────────
-- Same named parameters as net.http_post, plus the job name first, so a cron
-- command changes by one token. timeout_milliseconds defaults to the job's
-- http_timeout_ms: net.http_post's 5 s default gave up on xero-sync (~12 s)
-- and on the archive (~11 s) before they answered, so their failures were
-- invisible even in net._http_response.
create or replace function public.ops_http_post(
  p_job text,
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default null)
returns bigint
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  rid bigint;
  tmo integer;
begin
  tmo := coalesce(timeout_milliseconds,
                  (select j.http_timeout_ms from public.ops_jobs j where j.jobname = p_job),
                  5000);
  rid := net.http_post(url := url, body := body, params := params, headers := headers,
                       timeout_milliseconds := tmo);
  insert into public.ops_http_calls (request_id, jobname) values (rid, p_job)
  on conflict (request_id) do nothing;
  return rid;
end
$function$;
revoke all on function public.ops_http_post(text, text, jsonb, jsonb, jsonb, integer) from public, anon, authenticated;

-- ── the watchdog ─────────────────────────────────────────────────────────────
create or replace function public.ops_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
revoke all on function public.ops_watchdog() from public, anon, authenticated;

-- ── what Connections reads ───────────────────────────────────────────────────
create or replace function public.ops_health()
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'checkedAt', (select max(checked_at) from public.ops_job_status),
    -- The watchdog itself: if its snapshot is old, nothing below can be trusted.
    'watchdogStale', coalesce((select max(checked_at) from public.ops_job_status) < now() - interval '45 minutes', true),
    'failingCount', (select count(*) from public.ops_job_status where state in ('failing', 'paused')),
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object(
        'jobname', o.jobname, 'label', o.label, 'kind', o.kind, 'optional', o.optional,
        'threshold', o.fail_threshold, 'note', o.note,
        'state', coalesce(s.state, 'unknown'),
        'consecutiveFailures', coalesce(s.consecutive_failures, 0),
        'lastOkAt', s.last_ok_at, 'lastFailAt', s.last_fail_at, 'failingSince', s.failing_since,
        'lastError', s.last_error, 'pausedAt', s.paused_at, 'pausedReason', s.paused_reason)
      order by case coalesce(s.state, 'unknown') when 'paused' then 0 when 'failing' then 1 when 'warn' then 2
                    when 'unknown' then 3 when 'off' then 4 else 5 end, o.label), '[]'::jsonb)
      from public.ops_jobs o left join public.ops_job_status s on s.jobname = o.jobname)
  );
$function$;
revoke all on function public.ops_health() from public, anon;
grant execute on function public.ops_health() to authenticated, service_role;

-- ── what is watched ──────────────────────────────────────────────────────────
insert into public.ops_jobs (jobname, label, kind, via_http, optional, fail_threshold, http_timeout_ms, note) values
  ('sync-refresh-kickoff',       'Auto-refresh · start (03, 10, 18 UTC)', 'cron', true,  false, 2, 30000,
   'Starts the orchestrated sync. Its answer only says the run started; the run itself is watched by "Auto-refresh · runs finish" and "Auto-refresh · steps".'),
  ('sync-refresh-driver',        'Auto-refresh · engine (every minute)',  'cron', true,  false, 5, null,
   'Advances a running sync one step at a time.'),
  ('shopify-sales-fast',         'Shopify sales · every 5 min',           'cron', true,  false, 3, null, null),
  ('xero-sync-daily',            'Xero · daily 05:00 Brisbane',           'cron', true,  false, 1, 150000, null),
  ('wu-events-retention',        'Web Upgrade · event archive (hourly)',  'cron', true,  true,  3, 150000,
   'Archives raw events older than 14 days to Storage, then deletes them. Optional: paused automatically after 3 failures.'),
  ('web-upgrade-cache-refresh',  'Web Upgrade · cache refresh',           'cron', false, true,  3, null,
   'Paused by hand on 6-Oct-2026 after it took the database down; due to be removed.'),
  ('ops-watchdog',               'Watchdog itself (every 15 min)',        'cron', false, false, 2, null, null),
  ('dolo-balance-monthly-draft', 'Dolo balance · monthly draft',          'cron', false, false, 1, null, null),
  ('dolo-balance-monthly-capture','Dolo balance · monthly capture',       'cron', false, false, 1, null, null),
  ('wu-ingest',                  'Web Upgrade · events arriving',         'freshness', false, false, 1, null,
   'Fails when no production event arrived in the last 60 minutes.'),
  ('wu-raw-retention',           'Web Upgrade · raw events ≤ 16 days',    'freshness', false, false, 1, null,
   'Fails when the oldest raw event is older than 16 days: the archive is not keeping up.'),
  ('sync-engine',                'Auto-refresh · runs finish',            'freshness', false, false, 1, null,
   'Fails when no sync run finished in the last 10 hours.'),
  ('sync-steps',                 'Auto-refresh · steps',                  'freshness', false, false, 1, null,
   'Fails when the same step errored in each of the last 3 runs.'),
  ('xero-last-sync',             'Xero · data fresh',                     'freshness', false, false, 1, null,
   'Fails when Xero''s last sync is older than 26 hours or reported a failure.')
on conflict (jobname) do update set
  label = excluded.label, kind = excluded.kind, via_http = excluded.via_http,
  optional = excluded.optional, fail_threshold = excluded.fail_threshold,
  http_timeout_ms = excluded.http_timeout_ms, note = excluded.note;

update public.ops_jobs set watch_from = now() - interval '5 days' where kind = 'cron' and not via_http;

-- ── wire the cron jobs ───────────────────────────────────────────────────────
-- Every watched job that calls an edge function goes through ops_http_post.
-- One token changes in each command (net.http_post( -> ops_http_post('job', );
-- URL, headers and body stay exactly as they were.
do $$
declare r record;
begin
  for r in
    select j.jobid, j.jobname, j.command
    from cron.job j
    join public.ops_jobs o on o.jobname = j.jobname and o.via_http
    where j.command ~ 'net\.http_post\s*\('
  loop
    perform cron.alter_job(r.jobid, command := regexp_replace(r.command, 'net\.http_post\s*\(',
                                       'public.ops_http_post(' || quote_literal(r.jobname) || ', '));
  end loop;
end $$;

select cron.schedule('ops-watchdog', '*/15 * * * *', 'select public.ops_watchdog();');
