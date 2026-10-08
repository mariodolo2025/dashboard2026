-- =============================================================================
-- xero_meta_bills_monthly — the Meta invoices inside Xero's "Advertising"
-- =============================================================================
-- Mario, 8-Oct-2026, on By Channel: Advertising for 1-8 Oct showed $297,555
-- while Meta spent A$64,137 in those days. Verified in Xero: Meta is entered
-- as ONE bill per ad account per month, dated the 1st/2nd of the FOLLOWING
-- month ("ads September", dated 1-Oct: A$118,516.12 + US$93,421.38 =
-- A$252,950.46). So Xero's Advertising for a month is the previous month's
-- Meta plus that month's other advertising, and By Channel ran a month late.
-- Exactly: Oct 260,360.83 = 252,950.46 Meta + 7,410.37 other.
--
-- This table holds, per bill month, the AUD total of the Meta bills' lines
-- coded to Advertising, so By Channel can take them out of the Xero figure and
-- put Meta's actual spend for the selected dates in their place (checkbox
-- "Advertising: actual Meta spend"). Written by xero-sync, step 'meta_bills'
-- (part of the daily 'all'). AUD = line amount / the bill's CurrencyRate, the
-- conversion Xero itself books.

create table if not exists public.xero_meta_bills_monthly (
  year       integer not null,
  month      integer not null check (month between 1 and 12),
  amount_aud numeric not null,
  bills      integer not null,
  detail     jsonb,
  synced_at  timestamptz not null default now(),
  primary key (year, month)
);

comment on table public.xero_meta_bills_monthly is
  'Per Xero bill month: AUD total of Meta (contact facebook / Meta Platforms) bill lines coded to Advertising. Meta bills a month''s ads on the 1st/2nd of the next month, so these are the PREVIOUS month''s ads. By Channel subtracts them from Xero Advertising when showing actual Meta spend. Written by xero-sync step meta_bills.';

alter table public.xero_meta_bills_monthly enable row level security;
drop policy if exists xero_meta_bills_monthly_read on public.xero_meta_bills_monthly;
create policy xero_meta_bills_monthly_read on public.xero_meta_bills_monthly
  for select to authenticated, service_role using (true);
