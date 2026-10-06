-- =============================================================================
-- Web Upgrade visits with integer ids — the distinct count made cheap at root
-- =============================================================================
-- docs/PLAN-DISK-IO-2026-10-06.md, step A.
--
-- web_upgrade_sessions_daily holds one row per (day, environment, scope,
-- visitor): 1.39 M rows, 623 MB (221 MB table + two ~200 MB indexes), about
-- 450 bytes a row, because every row carries the visitor id as 36-char text
-- and the scope name as text of up to 45 chars. The panel counts DISTINCT
-- visitors over it about ten times per window. Measured 6-Oct-2026, one 30-day
-- count of scope 'all': 12.4 s cold, 4.3 s warm — 224,909 index entries, of
-- which 175,127 also had to visit the table because autovacuum had not yet
-- marked the recent pages all-visible, then a sort of 225 k strings under the
-- en_US collation. That count grows by a day every day; it is what the cache
-- and its tick were built to hide, and what took the database down.
--
-- The same facts, as numbers:
--   web_upgrade_visitor  (visitor_id int  <-> attribution_id text)
--   web_upgrade_scope    (scope_id smallint <-> scope text)
--   web_upgrade_env      (env_id smallint <-> environment text)
--   web_upgrade_visits_daily (env_id, scope_id, d, visitor_id): ~40 bytes a
--   row, ONE index — the primary key, in the order the panel reads.
-- Autovacuum on the new table is told to mark pages all-visible after 10k
-- inserts instead of 20% of the table, so its index-only scans stay index-only.
--
-- Migration without a gap: the writers below write BOTH tables from now on
-- (dual-write); the history is copied after this file in batches; the panel
-- switches only after an output comparison. The old table is kept until Mario
-- approves dropping it.

create table if not exists public.web_upgrade_visitor (
  visitor_id     integer generated always as identity primary key,
  attribution_id text not null unique
);
create table if not exists public.web_upgrade_scope (
  scope_id smallint generated always as identity primary key,
  scope    text not null unique
);
create table if not exists public.web_upgrade_env (
  env_id      smallint generated always as identity primary key,
  environment text not null unique
);
create table if not exists public.web_upgrade_visits_daily (
  env_id     smallint not null,
  scope_id   smallint not null,
  d          date     not null,
  visitor_id integer  not null,
  primary key (env_id, scope_id, d, visitor_id)
) with (autovacuum_vacuum_insert_threshold = 10000,
        autovacuum_vacuum_insert_scale_factor = 0.0,
        autovacuum_analyze_scale_factor = 0.02);

comment on table public.web_upgrade_visits_daily is
  'One row per (environment, scope, UTC day, visitor) with at least one Web Upgrade event: the distinct-visitor facts the panel counts. Integer twin of web_upgrade_sessions_daily (text ids), ~10x smaller. Written by the rollup triggers and web_upgrade_daily_reconcile. Ids: web_upgrade_env / _scope / _visitor.';

alter table public.web_upgrade_visitor enable row level security;
alter table public.web_upgrade_scope enable row level security;
alter table public.web_upgrade_env enable row level security;
alter table public.web_upgrade_visits_daily enable row level security;
-- Read through SECURITY DEFINER functions only; no direct policies needed.

-- Seed the small dictionaries from what exists, in a stable order.
insert into public.web_upgrade_env (environment)
select e from (select distinct environment e from public.web_upgrade_sessions_daily) x order by e
on conflict (environment) do nothing;
insert into public.web_upgrade_scope (scope)
select s from (select distinct scope s from public.web_upgrade_sessions_daily) x order by s
on conflict (scope) do nothing;

-- ── id lookups (insert on first sight) ───────────────────────────────────────
create or replace function public.web_upgrade_visitor_id(p text)
returns integer language plpgsql security definer set search_path to 'public', 'pg_temp' as $f$
declare v integer;
begin
  if p is null then return null; end if;
  select visitor_id into v from public.web_upgrade_visitor where attribution_id = p;
  if v is null then
    insert into public.web_upgrade_visitor (attribution_id) values (p)
    on conflict (attribution_id) do nothing returning visitor_id into v;
    if v is null then
      select visitor_id into v from public.web_upgrade_visitor where attribution_id = p;
    end if;
  end if;
  return v;
end $f$;

create or replace function public.web_upgrade_scope_id(p text)
returns smallint language plpgsql security definer set search_path to 'public', 'pg_temp' as $f$
declare v smallint;
begin
  if p is null then return null; end if;
  select scope_id into v from public.web_upgrade_scope where scope = p;
  if v is null then
    insert into public.web_upgrade_scope (scope) values (p)
    on conflict (scope) do nothing returning scope_id into v;
    if v is null then
      select scope_id into v from public.web_upgrade_scope where scope = p;
    end if;
  end if;
  return v;
end $f$;

create or replace function public.web_upgrade_env_id(p text)
returns smallint language plpgsql security definer set search_path to 'public', 'pg_temp' as $f$
declare v smallint;
begin
  if p is null then return null; end if;
  select env_id into v from public.web_upgrade_env where environment = p;
  if v is null then
    insert into public.web_upgrade_env (environment) values (p)
    on conflict (environment) do nothing returning env_id into v;
    if v is null then
      select env_id into v from public.web_upgrade_env where environment = p;
    end if;
  end if;
  return v;
end $f$;

revoke all on function public.web_upgrade_visitor_id(text) from public, anon, authenticated;
revoke all on function public.web_upgrade_scope_id(text) from public, anon, authenticated;
revoke all on function public.web_upgrade_env_id(text) from public, anon, authenticated;

-- ── writers: dual-write ──────────────────────────────────────────────────────
-- Unchanged except the sessions block, which now also writes the integer twin.
create or replace function public.web_upgrade_rollup_absorb(r upgrade_events_slim)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_mod text; v_scope text; v_raw text; v_vid integer; v_eid smallint;
begin
  v_mod := web_upgrade_rollup_module(r.action, r.p_page_path);
  if v_mod is null then return; end if;

  insert into web_upgrade_daily_counts as c (d, environment, module, action, n)
  values (r.d, r.environment, v_mod, r.action, 1)
  on conflict (d, environment, module, action) do update set n = c.n + 1;

  if v_mod = 'Compatibility Guide' and r.p_source = 'compatibility_complete_kit' then
    insert into web_upgrade_daily_counts as c (d, environment, module, action, n)
    values (r.d, r.environment, '__meta', '__complete_kit', 1)
    on conflict (d, environment, module, action) do update set n = c.n + 1;
  end if;

  if v_mod = 'Compatibility Guide' and r.p_brand is not null then
    insert into web_upgrade_daily_brand_model as b (d, environment, brand, model, selects, add_clicks, adds)
    values (r.d, r.environment, r.p_brand, r.p_machine,
            (r.action = 'compatibility_model_select')::int,
            (r.action = 'compatibility_add_click')::int,
            (r.action = 'compatibility_add_success')::int)
    on conflict (d, environment, brand, model) do update set
      selects    = b.selects    + (r.action = 'compatibility_model_select')::int,
      add_clicks = b.add_clicks + (r.action = 'compatibility_add_click')::int,
      adds       = b.adds       + (r.action = 'compatibility_add_success')::int;
  end if;

  if r.action like '%!_add!_click' escape '!' or r.action like '%!_add!_success' escape '!' then
    v_raw := nullif(coalesce(r.p_variant_id, split_part(r.p_variant_ids, ',', 1)), '');
    if v_raw ~ '^[0-9]{1,18}$' then
      insert into web_upgrade_daily_variant as v (d, environment, variant_id, add_clicks, adds)
      values (r.d, r.environment, v_raw::bigint,
              (r.action like '%!_add!_click' escape '!')::int,
              (r.action like '%!_add!_success' escape '!')::int)
      on conflict (d, environment, variant_id) do update set
        add_clicks = v.add_clicks + (r.action like '%!_add!_click' escape '!')::int,
        adds       = v.adds       + (r.action like '%!_add!_success' escape '!')::int;
    end if;
  end if;

  if r.action = 'reward_unlocked' then
    insert into web_upgrade_daily_rewards as w (d, environment, reward_name, unlocks)
    values (r.d, r.environment, coalesce(r.p_reward_name, '?'), 1)
    on conflict (d, environment, reward_name) do update set unlocks = w.unlocks + 1;
  end if;

  if r.attribution_id is not null then
    v_vid := web_upgrade_visitor_id(r.attribution_id);
    v_eid := web_upgrade_env_id(r.environment);
    foreach v_scope in array web_upgrade_rollup_scopes(r.action, r.p_page_path, r.p_reward_name) loop
      insert into web_upgrade_sessions_daily (d, environment, scope, attribution_id)
      values (r.d, r.environment, v_scope, r.attribution_id)
      on conflict do nothing;
      insert into web_upgrade_visits_daily (env_id, scope_id, d, visitor_id)
      values (v_eid, web_upgrade_scope_id(v_scope), r.d, v_vid)
      on conflict do nothing;
    end loop;
  end if;
end $function$;

create or replace function public.web_upgrade_rollup_retract(r upgrade_events_slim)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_mod text; v_scope text; v_raw text; v_backed boolean;
begin
  v_mod := web_upgrade_rollup_module(r.action, r.p_page_path);
  if v_mod is null then return; end if;

  update web_upgrade_daily_counts c set n = c.n - 1
   where c.d = r.d and c.environment = r.environment
     and c.module = v_mod and c.action = r.action;

  if v_mod = 'Compatibility Guide' and r.p_source = 'compatibility_complete_kit' then
    update web_upgrade_daily_counts c set n = c.n - 1
     where c.d = r.d and c.environment = r.environment
       and c.module = '__meta' and c.action = '__complete_kit';
  end if;

  if v_mod = 'Compatibility Guide' and r.p_brand is not null then
    update web_upgrade_daily_brand_model b set
      selects    = b.selects    - (r.action = 'compatibility_model_select')::int,
      add_clicks = b.add_clicks - (r.action = 'compatibility_add_click')::int,
      adds       = b.adds       - (r.action = 'compatibility_add_success')::int
     where b.d = r.d and b.environment = r.environment
       and b.brand = r.p_brand and b.model is not distinct from r.p_machine;
  end if;

  if r.action like '%!_add!_click' escape '!' or r.action like '%!_add!_success' escape '!' then
    v_raw := nullif(coalesce(r.p_variant_id, split_part(r.p_variant_ids, ',', 1)), '');
    if v_raw ~ '^[0-9]{1,18}$' then
      update web_upgrade_daily_variant v set
        add_clicks = v.add_clicks - (r.action like '%!_add!_click' escape '!')::int,
        adds       = v.adds       - (r.action like '%!_add!_success' escape '!')::int
       where v.d = r.d and v.environment = r.environment and v.variant_id = v_raw::bigint;
    end if;
  end if;

  if r.action = 'reward_unlocked' then
    update web_upgrade_daily_rewards w set unlocks = w.unlocks - 1
     where w.d = r.d and w.environment = r.environment
       and w.reward_name = coalesce(r.p_reward_name, '?');
  end if;

  -- sessions: drop the key only if no remaining slim row still backs it
  if r.attribution_id is not null then
    foreach v_scope in array web_upgrade_rollup_scopes(r.action, r.p_page_path, r.p_reward_name) loop
      v_backed := exists (
        select 1 from upgrade_events_slim e
         where e.d = r.d and e.environment = r.environment
           and e.attribution_id = r.attribution_id
           and v_scope = any(web_upgrade_rollup_scopes(e.action, e.p_page_path, e.p_reward_name)));
      if not v_backed then
        delete from web_upgrade_sessions_daily sd
         where sd.d = r.d and sd.environment = r.environment
           and sd.scope = v_scope and sd.attribution_id = r.attribution_id;
        delete from web_upgrade_visits_daily vd
         where vd.d = r.d
           and vd.env_id = (select env_id from web_upgrade_env where environment = r.environment)
           and vd.scope_id = (select scope_id from web_upgrade_scope where scope = v_scope)
           and vd.visitor_id = (select visitor_id from web_upgrade_visitor where attribution_id = r.attribution_id);
      end if;
    end loop;
  end if;
end $function$;

create or replace function public.web_upgrade_daily_reconcile(p_from date, p_to date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_counts bigint; v_bm bigint; v_var bigint; v_rw bigint; v_sess bigint; v_visits bigint;
begin
  -- serialize against the writer triggers: their slim row is uncommitted while
  -- they wait, so our snapshot below cannot see it; when they resume they add
  -- their increment on top -> exactly-once. SELECTs are not blocked.
  lock table web_upgrade_daily_counts, web_upgrade_daily_brand_model,
             web_upgrade_daily_variant, web_upgrade_daily_rewards,
             web_upgrade_sessions_daily, web_upgrade_visits_daily in exclusive mode;

  delete from web_upgrade_daily_counts where d between p_from and p_to;
  delete from web_upgrade_daily_brand_model where d between p_from and p_to;
  delete from web_upgrade_daily_variant where d between p_from and p_to;
  delete from web_upgrade_daily_rewards where d between p_from and p_to;
  delete from web_upgrade_sessions_daily where d between p_from and p_to;
  delete from web_upgrade_visits_daily where d between p_from and p_to;

  insert into web_upgrade_daily_counts (d, environment, module, action, n)
  select * from (
    select e.d, e.environment, web_upgrade_rollup_module(e.action, e.p_page_path) as module,
           e.action, count(*)::bigint
    from upgrade_events_slim e where e.d between p_from and p_to
    group by 1, 2, 3, 4) t
  where module is not null;
  get diagnostics v_counts = row_count;

  insert into web_upgrade_daily_counts (d, environment, module, action, n)
  select e.d, e.environment, '__meta', '__complete_kit', count(*)::bigint
  from upgrade_events_slim e
  where e.d between p_from and p_to
    and web_upgrade_rollup_module(e.action, e.p_page_path) = 'Compatibility Guide'
    and e.p_source = 'compatibility_complete_kit'
  group by 1, 2;

  insert into web_upgrade_daily_brand_model (d, environment, brand, model, selects, add_clicks, adds)
  select e.d, e.environment, e.p_brand, e.p_machine,
         count(*) filter (where e.action = 'compatibility_model_select'),
         count(*) filter (where e.action = 'compatibility_add_click'),
         count(*) filter (where e.action = 'compatibility_add_success')
  from upgrade_events_slim e
  where e.d between p_from and p_to and e.p_brand is not null
    and web_upgrade_rollup_module(e.action, e.p_page_path) = 'Compatibility Guide'
  group by 1, 2, 3, 4;
  get diagnostics v_bm = row_count;

  insert into web_upgrade_daily_variant (d, environment, variant_id, add_clicks, adds)
  select t.d, t.environment, t.vid,
         count(*) filter (where t.action like '%!_add!_click' escape '!'),
         count(*) filter (where t.action like '%!_add!_success' escape '!')
  from (
    select e.d, e.environment, e.action,
           nullif(coalesce(e.p_variant_id, split_part(e.p_variant_ids, ',', 1)), '') raw
    from upgrade_events_slim e
    where e.d between p_from and p_to
      and (e.action like '%!_add!_click' escape '!' or e.action like '%!_add!_success' escape '!')
      and web_upgrade_rollup_module(e.action, e.p_page_path) is not null
  ) t2, lateral (select t2.d, t2.environment, t2.action, t2.raw::bigint vid) t
  where t2.raw ~ '^[0-9]{1,18}$'
  group by 1, 2, 3;
  get diagnostics v_var = row_count;

  insert into web_upgrade_daily_rewards (d, environment, reward_name, unlocks)
  select e.d, e.environment, coalesce(e.p_reward_name, '?'), count(*)::bigint
  from upgrade_events_slim e
  where e.d between p_from and p_to and e.action = 'reward_unlocked'
  group by 1, 2, 3;
  get diagnostics v_rw = row_count;

  insert into web_upgrade_sessions_daily (d, environment, scope, attribution_id)
  select distinct e.d, e.environment, s.scope, e.attribution_id
  from upgrade_events_slim e
  cross join lateral unnest(web_upgrade_rollup_scopes(e.action, e.p_page_path, e.p_reward_name)) as s(scope)
  where e.d between p_from and p_to and e.attribution_id is not null;
  get diagnostics v_sess = row_count;

  -- integer twin, built from the rows just written
  insert into web_upgrade_visitor (attribution_id)
  select distinct sd.attribution_id from web_upgrade_sessions_daily sd
  where sd.d between p_from and p_to
  on conflict (attribution_id) do nothing;
  insert into web_upgrade_env (environment)
  select distinct sd.environment from web_upgrade_sessions_daily sd where sd.d between p_from and p_to
  on conflict (environment) do nothing;
  insert into web_upgrade_scope (scope)
  select distinct sd.scope from web_upgrade_sessions_daily sd where sd.d between p_from and p_to
  on conflict (scope) do nothing;
  insert into web_upgrade_visits_daily (env_id, scope_id, d, visitor_id)
  select en.env_id, sc.scope_id, sd.d, vi.visitor_id
  from web_upgrade_sessions_daily sd
  join web_upgrade_env en on en.environment = sd.environment
  join web_upgrade_scope sc on sc.scope = sd.scope
  join web_upgrade_visitor vi on vi.attribution_id = sd.attribution_id
  where sd.d between p_from and p_to
  on conflict do nothing;
  get diagnostics v_visits = row_count;

  return jsonb_build_object('from', p_from, 'to', p_to, 'counts', v_counts,
                            'brand_model', v_bm, 'variant', v_var,
                            'rewards', v_rw, 'sessions', v_sess, 'visits', v_visits);
end $function$;

-- ── history copy, one batch of days per call ────────────────────────────────
-- Run from p_from upward until it returns copied = 0. Idempotent: rows the
-- dual-write already put in are skipped.
create or replace function public.web_upgrade_visits_backfill(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '300s'
set work_mem to '64MB'
as $function$
declare v_new_visitors bigint; v_rows bigint;
begin
  insert into web_upgrade_visitor (attribution_id)
  select distinct sd.attribution_id from web_upgrade_sessions_daily sd
  where sd.d between p_from and p_to
  on conflict (attribution_id) do nothing;
  get diagnostics v_new_visitors = row_count;

  insert into web_upgrade_scope (scope)
  select distinct sd.scope from web_upgrade_sessions_daily sd where sd.d between p_from and p_to
  on conflict (scope) do nothing;
  insert into web_upgrade_env (environment)
  select distinct sd.environment from web_upgrade_sessions_daily sd where sd.d between p_from and p_to
  on conflict (environment) do nothing;

  insert into web_upgrade_visits_daily (env_id, scope_id, d, visitor_id)
  select en.env_id, sc.scope_id, sd.d, vi.visitor_id
  from web_upgrade_sessions_daily sd
  join web_upgrade_env en on en.environment = sd.environment
  join web_upgrade_scope sc on sc.scope = sd.scope
  join web_upgrade_visitor vi on vi.attribution_id = sd.attribution_id
  where sd.d between p_from and p_to
  on conflict do nothing;
  get diagnostics v_rows = row_count;

  return jsonb_build_object('from', p_from, 'to', p_to, 'newVisitors', v_new_visitors, 'copied', v_rows);
end
$function$;
revoke all on function public.web_upgrade_visits_backfill(date, date) from public, anon, authenticated;

-- ── check: the two tables say the same thing, day by day ────────────────────
create or replace function public.web_upgrade_visits_diff(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '300s'
as $function$
  with o as (
    select d, environment, scope, count(*) n from web_upgrade_sessions_daily
    where d between p_from and p_to group by 1, 2, 3),
  n as (
    select v.d, en.environment, sc.scope, count(*) n
    from web_upgrade_visits_daily v
    join web_upgrade_env en on en.env_id = v.env_id
    join web_upgrade_scope sc on sc.scope_id = v.scope_id
    where v.d between p_from and p_to group by 1, 2, 3)
  select jsonb_build_object(
    'groups', (select count(*) from o),
    'oldRows', (select coalesce(sum(n), 0) from o),
    'newRows', (select coalesce(sum(n), 0) from n),
    'mismatches', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'env', environment, 'scope', scope, 'old', o_n, 'new', n_n)), '[]'::jsonb)
                   from (select coalesce(o.d, n.d) d, coalesce(o.environment, n.environment) environment,
                                coalesce(o.scope, n.scope) scope, o.n o_n, n.n n_n
                         from o full join n using (d, environment, scope)
                         where o.n is distinct from n.n limit 50) x));
$function$;
revoke all on function public.web_upgrade_visits_diff(date, date) from public, anon, authenticated;
