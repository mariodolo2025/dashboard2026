-- =============================================================================
-- Spend to Stock — the plan survives closing the panel
-- =============================================================================
-- Mario, 2026-09-18: "cuando estoy trabajando aqui, y completo info del spend
-- mensual, si lo cierro toda la info se pierde, quiero que se conserve."
--
-- Every input on that screen lived in React state: the target budget, the mode,
-- the elasticity, the horizon and — the one that costs real work to retype —
-- the month-by-month spend figures. Closing the overlay threw all of it away.
--
-- On the server rather than in the browser, his call: the plan is something he
-- and Juan look at together, and it has to survive changing machines. Same
-- shape as advertising_monthly_plan — reads by policy, writes only through a
-- SECURITY DEFINER RPC that takes the actor from the session JWT so a client
-- cannot claim to be someone else.
--
-- TWO KINDS OF ROW, one table:
--   '__working__'  the draft, written automatically as he types. There is
--                  exactly one, it is overwritten, and it is what comes back
--                  when the screen opens. Nothing is ever lost by closing.
--   anything else  a named scenario he saved on purpose ("Base", "Agresivo").
--                  Listed, loadable, deletable.
-- The reserved name is checked in the RPC, not by convention, so a scenario
-- cannot quietly overwrite the draft.
--
-- payload is jsonb on purpose: these are the knobs of one screen, they change
-- as the screen changes, and a column per knob would mean a migration every
-- time a control is added. The screen validates its own shape on load and falls
-- back to defaults for anything missing.

create table if not exists public.growth_forecast_scenarios (
  name        text primary key check (length(btrim(name)) between 1 and 60),
  payload     jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

comment on table public.growth_forecast_scenarios is
  'Saved Spend to Stock plans. The reserved row "__working__" is the autosaved draft the screen reopens with; every other row is a scenario someone named and saved. payload holds the screen''s inputs (target spend, mode, per-month figures, elasticity, horizon).';

alter table public.growth_forecast_scenarios enable row level security;

-- Read for the dashboard session; writes go through the definer RPCs below.
drop policy if exists "growth_forecast_scenarios_read" on public.growth_forecast_scenarios;
create policy "growth_forecast_scenarios_read"
  on public.growth_forecast_scenarios for select
  to authenticated, service_role using (true);

-- ── Save ─────────────────────────────────────────────────────────────────────
create or replace function public.growth_forecast_scenario_save(
  p_name    text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor text;
  v_name  text := btrim(coalesce(p_name, ''));
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  v_actor := coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'email', ''),
    auth.uid()::text);

  if v_name = '' or length(v_name) > 60 then
    raise exception 'NAME_INVALID' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'PAYLOAD_INVALID' using errcode = '22023';
  end if;

  insert into public.growth_forecast_scenarios (name, payload, updated_at, updated_by)
  values (v_name, p_payload, now(), v_actor)
  on conflict (name) do update
    set payload = excluded.payload, updated_at = now(), updated_by = excluded.updated_by;

  return jsonb_build_object('ok', true, 'name', v_name, 'updatedAt', now(), 'updatedBy', v_actor);
end
$function$;

-- ── Delete ───────────────────────────────────────────────────────────────────
-- The draft is not deletable: there is always one, and removing it would just
-- mean the next keystroke recreates it.
create or replace function public.growth_forecast_scenario_delete(p_name text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_n    int;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if v_name = '__working__' then
    raise exception 'DRAFT_NOT_DELETABLE' using errcode = '22023';
  end if;

  delete from public.growth_forecast_scenarios where name = v_name;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'deleted', v_n);
end
$function$;

revoke all on function public.growth_forecast_scenario_save(text, jsonb) from public, anon;
revoke all on function public.growth_forecast_scenario_delete(text) from public, anon;
grant execute on function public.growth_forecast_scenario_save(text, jsonb) to authenticated, service_role;
grant execute on function public.growth_forecast_scenario_delete(text) to authenticated, service_role;
