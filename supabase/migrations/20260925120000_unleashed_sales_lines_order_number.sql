-- =============================================================================
-- unleashed_sales_lines carries the order number
-- =============================================================================
-- Mario, 2026-09-25, reading the B2B COGS download: "el csv en sale amount
-- dice AUD, pero por ej en la SO-00020273 ese valor creo que es en usd", and
-- then "ya no confio en vos" about Total B2B Sales. He was right, and the cause
-- was mine: on 24-Sep dashboard-data started reading B2B sales from
-- aim2026_demand_detail, whose `amount` is qty x UnitPrice in the ORDER's
-- currency, before discounts and with the sign stripped. It is a demand table:
-- right for units, wrong for money. SO-00020273 (Stricktly Coffee, USD) showed
-- EP-18g at 150.00 where Unleashed's own AUD figure is 232.45.
--
-- The money lives here, in unleashed_sales_lines: sub_total is Unleashed's
-- BCLineTotal, the line total in the base currency (AUD) after discounts. It is
-- what the By Channel screen read until 24-Sep, through SalesEnquiryList.csv.
-- dashboard-data goes back to it.
--
-- What this table lacked was the order number, which the audit CSV now needs so
-- a row can be found in Unleashed. The sync starts writing it; the rows already
-- here are filled from aim2026_demand_detail, which shares the order guid.
-- History before 2026-07-01 (source = 'frozen', loaded from a CSV export) has
-- no guid and stays without a number.

alter table public.unleashed_sales_lines add column if not exists order_number text;

comment on column public.unleashed_sales_lines.order_number is
  'Unleashed OrderNumber (SO-xxxxx). Written by unleashed-sales-sync from 2026-09-25; earlier api rows backfilled from aim2026_demand_detail by order_guid. Null for source = frozen (no guid in the CSV export).';

update public.unleashed_sales_lines u
   set order_number = d.order_number
  from (select distinct order_guid, order_number
          from public.aim2026_demand_detail
         where order_guid is not null and order_number is not null) d
 where u.source = 'api'
   and u.order_number is null
   and u.order_guid = d.order_guid;
