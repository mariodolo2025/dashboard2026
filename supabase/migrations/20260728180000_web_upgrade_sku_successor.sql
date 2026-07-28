-- =============================================================================
-- Web Upgrade — carry a frozen baseline across a SKU rename or consolidation
-- =============================================================================
-- Symptom: the "Families that moved" card read **+1018%** for Shower Screens
-- (735 u/wk against 65.8) while the family was actually running about -30%.
--
-- Cause: on 2026-07-23 — the first day of the measurement window — the shower
-- screen line was consolidated (PSD-HD-EX54 + PSD-HD-54 -> PSD-HD-BR54,
-- PSD-HD-MV58 -> PSD-HD-BR58). The replacements carry ~95% of the volume but had
-- no row in web_upgrade_baseline, which was frozen on 2026-07-22, so the RPC's
-- `coalesce(..., 0)` gave them a baseline of zero. The three retired SKUs, which
-- hold 1,045.91 u/wk of baseline between them, never enter the panel at all
-- because no module event in the window points at their variant_ids. The card was
-- comparing the whole line against the baseline of its five smallest members.
--
-- Baseline itself is never regenerated (it is the frozen pre-launch picture);
-- instead the retired SKU's baseline is attributed to its successor.

create table if not exists public.web_upgrade_sku_successor (
  old_sku        text primary key,
  new_sku        text not null,
  effective_date date not null,
  note           text,
  created_at     timestamptz not null default now()
);

alter table public.web_upgrade_sku_successor enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'web_upgrade_sku_successor'
      and policyname = 'web_upgrade_sku_successor_rw'
  ) then
    create policy web_upgrade_sku_successor_rw
      on public.web_upgrade_sku_successor
      for all to authenticated, service_role
      using (true) with check (true);
  end if;
end $$;

comment on table public.web_upgrade_sku_successor is
  'Retired SKU -> replacement. Used to carry a frozen baseline across a SKU rename or consolidation so the pre/post comparison stays like-for-like.';

insert into public.web_upgrade_sku_successor (old_sku, new_sku, effective_date, note) values
  ('PSD-HD-EX54', 'PSD-HD-BR54', '2026-07-23', 'Breville 54mm shower screens consolidated: Express/Infuser + other 54mm into one SKU'),
  ('PSD-HD-54',   'PSD-HD-BR54', '2026-07-23', 'Breville 54mm shower screens consolidated: Express/Infuser + other 54mm into one SKU'),
  ('PSD-HD-MV58', 'PSD-HD-BR58', '2026-07-23', 'Breville 58mm shower screen renamed')
on conflict (old_sku) do update
  set new_sku = excluded.new_sku,
      effective_date = excluded.effective_date,
      note = excluded.note;

-- Baseline units/week for a SKU, adding in whatever its retired predecessors
-- held. A SKU with no predecessor and no baseline row returns NULL — the caller
-- must treat that as "not comparable", never as zero.
create or replace function public.web_upgrade_baseline_upw(p_sku text, p_window_days int default 84)
returns numeric
language sql
stable
security definer
set search_path = public
as $fn$
  select nullif(
    coalesce((select b.units_per_week
                from public.web_upgrade_baseline b
               where b.sku = p_sku and b.window_days = p_window_days), 0)
    + coalesce((select sum(b2.units_per_week)
                  from public.web_upgrade_sku_successor s
                  join public.web_upgrade_baseline b2
                    on b2.sku = s.old_sku and b2.window_days = p_window_days
                 where s.new_sku = p_sku), 0),
    0);
$fn$;

comment on function public.web_upgrade_baseline_upw(text, int) is
  'Frozen baseline units/week for a SKU including its retired predecessors. NULL means no comparable baseline exists — never 0.';

grant execute on function public.web_upgrade_baseline_upw(text, int) to authenticated, service_role;

-- In-place patch of web_upgrade_performance so byScreen uses the helper.
-- Never CREATE OR REPLACE by hand; the guard fails if the anchor is not unique.
do $do$
declare
  v_src   text;
  v_new   text;
  v_old   constant text :=
    'coalesce((select b.units_per_week from web_upgrade_baseline b where b.sku = m.sku and b.window_days = 84), 0)';
  v_repl  constant text :=
    'coalesce(web_upgrade_baseline_upw(m.sku, 84), 0)';
  v_count int;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'web_upgrade_performance';

  if v_src is null then
    raise exception 'web_upgrade_performance not found';
  end if;

  v_count := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  if v_count <> 1 then
    raise exception 'anchor matched % times, expected exactly 1 — aborting', v_count;
  end if;

  v_new := replace(v_src, v_old, v_repl);
  execute v_new;
end
$do$;
