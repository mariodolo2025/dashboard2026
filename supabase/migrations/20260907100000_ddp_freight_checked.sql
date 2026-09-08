-- =============================================================================
-- DDP Markets — "awaiting" and "no label" stop being the same blank
-- =============================================================================
-- Mario, 2026-09-07, looking at the USA ledger while its backfill was still
-- running: "que no tenes la info de freight?" Every row said "no label", whose
-- tooltip claims the parcel shipped outside Starshipit or has no label yet.
-- Neither was true: the sync drains newest-first at ~50 orders a run and had
-- simply not reached those rows. A null freight had two meanings - "not looked
-- yet" and "looked, nothing there" - and the tab could only say the second.
--
-- freight_checked_at is set by ddp-sync when it has actually asked Starshipit
-- about an order and come back empty (not found, or found with no label cost
-- yet). Transient API failures do not set it. The ledger exposes it as
-- freightChecked so the tab can say "awaiting" until the sync has looked, and
-- "no label" only afterwards.
--
-- The function body is patched in place through pg_get_functiondef + an
-- anchored replace with a uniqueness guard (the project's pattern, see
-- 20260828090000): one field added to the ledger row, nothing else touched,
-- and a second run raises instead of double-applying.

alter table ddp_shipments add column if not exists freight_checked_at timestamptz;

comment on column ddp_shipments.freight_checked_at is
  'Set when ddp-sync asked Starshipit about this order and found no label cost. '
  'Null with freight null = not looked yet ("awaiting"); set with freight null = looked, nothing ("no label").';

do $mig$
declare
  src    text;
  n      int;
  anchor text := $a$'tracking', tracking_number, 'carrier', ss_carrier, 'matched', matched$a$;
  repl   text := $a$'tracking', tracking_number, 'carrier', ss_carrier, 'matched', matched,
      'freightChecked', freight_checked_at is not null$a$;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'ddp_markets_dashboard';
  if src is null then raise exception 'ddp_markets_dashboard not found'; end if;
  if position('freightChecked' in src) > 0 then
    raise notice 'freightChecked already present - nothing to do';
    return;
  end if;
  n := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  if n <> 1 then raise exception 'ledger anchor matched % times, expected 1', n; end if;
  execute replace(src, anchor, repl);
end
$mig$;
