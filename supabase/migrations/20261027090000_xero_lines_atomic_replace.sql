-- =============================================================================
-- xero_account_lines — document identity and atomic replace
-- =============================================================================
-- docs/PLAN-XERO-DETAIL-SYNC-2026-10-27-v2.md (approved by Mario 27-oct-2026),
-- Fase 0.2 and the schema Fase 2 needs.
--
-- MRD constraint (§3 of the plan): the MRD's view mrd_v_split_lines_month reads
-- this table by its physical identity. So the table is NEVER renamed,
-- recreated or dropped; columns are only ADDED; every replace is DELETE +
-- INSERT inside ONE transaction on this same table (the two functions below).
--
-- New columns (all nullable; the CSV history has no Xero document behind it):
--   document_id       Xero InvoiceID / BankTransactionID / CreditNoteID
--   document_type     'ACCPAY' | 'ACCPAYCREDIT' | 'SPEND' | 'RECEIVE' | ...
--   contact_id        Xero ContactID
--   updated_date_utc  the document's UpdatedDateUTC when it was read
--   tax_amount        line TaxAmount, AUD
--   gross_amount      line amount as entered (incl. tax if Inclusive), AUD
--   line_amount_types 'Exclusive' | 'Inclusive' | 'NoTax'
-- net_amount keeps its meaning for the MRD (the line's AUD amount); from the
-- next read on it is ex-GST, which the MRD agent confirmed is what it wants.

alter table public.xero_account_lines
  add column if not exists document_id text,
  add column if not exists document_type text,
  add column if not exists contact_id text,
  add column if not exists updated_date_utc timestamptz,
  add column if not exists tax_amount numeric,
  add column if not exists gross_amount numeric,
  add column if not exists line_amount_types text;

create index if not exists xero_account_lines_document_idx on public.xero_account_lines (document_id);

comment on column public.xero_account_lines.net_amount is
  'Line amount in AUD, ex-GST for API rows read from 27-Oct-2026 on: (LineAmount - TaxAmount if Inclusive) / CurrencyRate, rounded to cents. Read by the MRD (mrd_v_split_lines_month).';

-- Rows of one replace, as jsonb objects with the table's column names.
-- Shared by both functions below.
create or replace function public.xero_lines_insert_rows(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare n integer;
begin
  insert into public.xero_account_lines as t
    (journal_line_id, journal_number, journal_date, account_name, description, net_amount,
     contact_name, source, currency, amount_source, reference,
     document_id, document_type, contact_id, updated_date_utc, tax_amount, gross_amount, line_amount_types)
  select r.journal_line_id, r.journal_number, r.journal_date, r.account_name, r.description, r.net_amount,
         r.contact_name, r.source, r.currency, r.amount_source, r.reference,
         r.document_id, r.document_type, r.contact_id, r.updated_date_utc, r.tax_amount, r.gross_amount, r.line_amount_types
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
    journal_line_id uuid, journal_number bigint, journal_date date, account_name text, description text,
    net_amount numeric, contact_name text, source text, currency text, amount_source numeric, reference text,
    document_id text, document_type text, contact_id text, updated_date_utc timestamptz,
    tax_amount numeric, gross_amount numeric, line_amount_types text)
  on conflict (journal_line_id) do update set
    journal_number = excluded.journal_number, journal_date = excluded.journal_date,
    account_name = excluded.account_name, description = excluded.description,
    net_amount = excluded.net_amount, contact_name = excluded.contact_name, source = excluded.source,
    currency = excluded.currency, amount_source = excluded.amount_source, reference = excluded.reference,
    document_id = excluded.document_id, document_type = excluded.document_type,
    contact_id = excluded.contact_id, updated_date_utc = excluded.updated_date_utc,
    tax_amount = excluded.tax_amount, gross_amount = excluded.gross_amount,
    line_amount_types = excluded.line_amount_types;
  get diagnostics n = row_count;
  return n;
end
$function$;

-- Replace a slice: the rows of p_accounts dated p_from..p_to whose source is
-- in p_sources, by p_rows. One transaction: a failure leaves the old rows.
-- Used by the CSV loader (sources {csv}, the file's date range) and by the
-- month re-read (sources {api}).
create or replace function public.xero_lines_replace_range(
  p_accounts text[], p_from date, p_to date, p_sources text[], p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare d integer; i integer;
begin
  if p_accounts is null or array_length(p_accounts, 1) is null or p_from is null or p_to is null
     or p_sources is null or array_length(p_sources, 1) is null then
    raise exception 'xero_lines_replace_range: accounts, from, to and sources are all required';
  end if;
  delete from public.xero_account_lines
   where account_name = any(p_accounts)
     and journal_date between p_from and p_to
     and source = any(p_sources);
  get diagnostics d = row_count;
  i := public.xero_lines_insert_rows(p_rows);
  return jsonb_build_object('deleted', d, 'inserted', i);
end
$function$;

-- Replace documents: every stored line of each document in p_document_ids is
-- dropped and p_rows (the documents' current watched lines, possibly none) put
-- back. Covers voided, deleted, re-coded to another account and re-dated.
create or replace function public.xero_lines_replace_documents(p_document_ids text[], p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare d integer; i integer;
begin
  delete from public.xero_account_lines where document_id = any(coalesce(p_document_ids, '{}'));
  get diagnostics d = row_count;
  i := public.xero_lines_insert_rows(p_rows);
  return jsonb_build_object('deleted', d, 'inserted', i);
end
$function$;

revoke all on function public.xero_lines_insert_rows(jsonb) from public, anon, authenticated;
revoke all on function public.xero_lines_replace_range(text[], date, date, text[], jsonb) from public, anon, authenticated;
revoke all on function public.xero_lines_replace_documents(text[], jsonb) from public, anon, authenticated;
grant execute on function public.xero_lines_insert_rows(jsonb) to service_role;
grant execute on function public.xero_lines_replace_range(text[], date, date, text[], jsonb) to service_role;
grant execute on function public.xero_lines_replace_documents(text[], jsonb) to service_role;
