-- =============================================================================
-- web_upgrade_sessions_daily retired: the integer table is the only one
-- =============================================================================
-- docs/PLAN-DISK-IO-2026-10-06.md, step A, last point. Mario, 8-Oct-2026:
-- "borrá la tabla web_upgrade_sessions_daily" (after asking that no historical
-- information he will need later be lost).
--
-- Nothing historical is lost. The old table held the same facts as
-- web_upgrade_visits_daily, with the visitor id as text instead of a number,
-- and every text id is kept in web_upgrade_visitor. Checked on 8-Oct after two
-- days of writing both: 1,547,584 rows in each, every (day, environment,
-- scope) group equal (1,425 groups, 0 mismatches), 0 visitors of the old table
-- missing from the dictionary. The raw events behind both stay archived in
-- Storage (bucket wu-archive).
--
-- 1. The rollup writers stop writing the old table.
-- 2. web_upgrade_daily_reconcile rebuilds visits straight from the slim mirror,
--    and now REFUSES a range older than the oldest raw event it still has:
--    since the archive keeps 14 days, rebuilding further back would delete
--    history it cannot recount. (The old version had the same hole.)
-- 3. The one-off copy and check functions, and the old table, are dropped:
--    623 MB back.

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
declare v_counts bigint; v_bm bigint; v_var bigint; v_rw bigint; v_visits bigint; v_first date;
begin
  -- Rebuilding deletes the range first and recounts it from upgrade_events_slim.
  -- The slim mirror only keeps what the archive has not purged (14 days), so a
  -- range reaching further back would ERASE history it can no longer rebuild.
  select min(d) into v_first from upgrade_events_slim;
  if v_first is null or p_from < v_first then
    raise exception 'web_upgrade_daily_reconcile(%, %): raw events before % are archived; rebuilding this range would erase history', p_from, p_to, v_first;
  end if;

  -- serialize against the writer triggers: their slim row is uncommitted while
  -- they wait, so our snapshot below cannot see it; when they resume they add
  -- their increment on top -> exactly-once. SELECTs are not blocked.
  lock table web_upgrade_daily_counts, web_upgrade_daily_brand_model,
             web_upgrade_daily_variant, web_upgrade_daily_rewards,
             web_upgrade_visits_daily in exclusive mode;

  delete from web_upgrade_daily_counts where d between p_from and p_to;
  delete from web_upgrade_daily_brand_model where d between p_from and p_to;
  delete from web_upgrade_daily_variant where d between p_from and p_to;
  delete from web_upgrade_daily_rewards where d between p_from and p_to;
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

  insert into web_upgrade_visitor (attribution_id)
  select distinct e.attribution_id from upgrade_events_slim e
  where e.d between p_from and p_to and e.attribution_id is not null
  on conflict (attribution_id) do nothing;
  insert into web_upgrade_env (environment)
  select distinct e.environment from upgrade_events_slim e
  where e.d between p_from and p_to and e.environment is not null
  on conflict (environment) do nothing;
  insert into web_upgrade_scope (scope)
  select distinct s.scope from upgrade_events_slim e
  cross join lateral unnest(web_upgrade_rollup_scopes(e.action, e.p_page_path, e.p_reward_name)) as s(scope)
  where e.d between p_from and p_to and e.attribution_id is not null
  on conflict (scope) do nothing;
  insert into web_upgrade_visits_daily (env_id, scope_id, d, visitor_id)
  select distinct en.env_id, sc.scope_id, e.d, vi.visitor_id
  from upgrade_events_slim e
  cross join lateral unnest(web_upgrade_rollup_scopes(e.action, e.p_page_path, e.p_reward_name)) as s(scope)
  join web_upgrade_env en on en.environment = e.environment
  join web_upgrade_scope sc on sc.scope = s.scope
  join web_upgrade_visitor vi on vi.attribution_id = e.attribution_id
  where e.d between p_from and p_to and e.attribution_id is not null
  on conflict do nothing;
  get diagnostics v_visits = row_count;

  return jsonb_build_object('from', p_from, 'to', p_to, 'counts', v_counts,
                            'brand_model', v_bm, 'variant', v_var,
                            'rewards', v_rw, 'visits', v_visits);
end $function$;

drop function if exists public.web_upgrade_visits_backfill(date, date);
drop function if exists public.web_upgrade_visits_diff(date, date);
drop table if exists public.web_upgrade_sessions_daily;
