-- =============================================================================
-- xero_pl_monthly — one month replaced atomically
-- =============================================================================
-- docs/PLAN-XERO-DETAIL-SYNC-2026-10-27-v2.md, step P0 (approved 27-oct-2026).
--
-- The P&L step asked Xero for ONE multi-period report ending at the end of the
-- current month (periods=11). Xero builds the earlier columns on the same day
-- of the month as toDate, so whenever the current month has fewer days, the
-- 31st (or 29th-31st in February) of the other months was cut off. Recorded on
-- 28-Sep-2026: xero_pl_monthly differed from Xero exactly in the 31-day months;
-- it matched again in October only because October has 31 days. The auditor
-- predicted it would break again from 2-Nov.
--
-- The step now asks for each month separately (1st..last day) and replaces
-- that month's rows here in one transaction: an account that dropped to zero
-- (Xero omits it from a single-period report) disappears instead of keeping a
-- stale amount. Same table, never recreated: the MRD's mrd_v_pl_month reads it
-- (columns account_name, year, month, amount, section, synced_at unchanged).

create or replace function public.xero_pl_replace_month(p_year integer, p_month integer, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare d integer; i integer;
begin
  if p_year is null or p_month is null or p_month not between 1 and 12 then
    raise exception 'xero_pl_replace_month: year and month required';
  end if;
  if exists (select 1 from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(year integer, month integer)
             where r.year is distinct from p_year or r.month is distinct from p_month) then
    raise exception 'xero_pl_replace_month: every row must belong to %-%', p_year, p_month;
  end if;
  delete from public.xero_pl_monthly where year = p_year and month = p_month;
  get diagnostics d = row_count;
  insert into public.xero_pl_monthly (account_name, year, month, amount, section, synced_at)
  select r.account_name, r.year, r.month, r.amount, r.section, coalesce(r.synced_at, now())
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
    account_name text, year integer, month integer, amount numeric, section text, synced_at timestamptz);
  get diagnostics i = row_count;
  return jsonb_build_object('deleted', d, 'inserted', i);
end
$function$;

revoke all on function public.xero_pl_replace_month(integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.xero_pl_replace_month(integer, integer, jsonb) to service_role;
