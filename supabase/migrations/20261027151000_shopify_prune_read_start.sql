-- =============================================================================
-- shopify_lines_prune_window: only rows written before the read started
-- =============================================================================
-- Follow-up to 20261027150000. The 5-minute cron can insert an order created
-- after the backfill read Shopify and before it pruned; that order is not in
-- the read and would have been pruned (the next fast run would put it back,
-- but it must not leave in the first place). Now only rows whose synced_at is
-- before the read started can be pruned. Same rules otherwise.

drop function if exists public.shopify_lines_prune_window(date, date, text[]);

create or replace function public.shopify_lines_prune_window(p_from date, p_to date, p_keep text[], p_read_started timestamptz)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare ids text[]; n integer; kept integer := coalesce(cardinality(p_keep), 0);
begin
  if kept = 0 then raise exception 'PRUNE_NO_READ: the window % to % read no orders', p_from, p_to; end if;
  if p_read_started is null then raise exception 'PRUNE_NO_START: the read start time is required'; end if;
  select array_agg(distinct l.order_id) into ids
  from public.shopify_sales_lines l
  where l.source = 'api' and l.order_date between p_from and p_to
    and not (l.order_id = any(p_keep))
    and not exists (select 1 from public.shopify_sales_lines y
                    where y.order_id = l.order_id and y.synced_at >= p_read_started);
  if ids is null then return jsonb_build_object('pruned_orders', 0); end if;
  if cardinality(ids) > greatest(5, ceil(kept * 0.02)) then
    raise exception 'PRUNE_TOO_MANY: % orders of % to % are not in Shopify''s answer (% read); nothing removed',
      cardinality(ids), p_from, p_to, kept;
  end if;
  insert into backup.shopify_sales_lines_pruned
  select l.*, now() from public.shopify_sales_lines l where l.source = 'api' and l.order_id = any(ids);
  delete from public.shopify_sales_lines where source = 'api' and order_id = any(ids);
  get diagnostics n = row_count;
  return jsonb_build_object('pruned_orders', cardinality(ids), 'rows', n, 'order_ids', to_jsonb(ids));
end
$function$;
revoke all on function public.shopify_lines_prune_window(date, date, text[], timestamptz) from public, anon, authenticated;
grant execute on function public.shopify_lines_prune_window(date, date, text[], timestamptz) to service_role;
