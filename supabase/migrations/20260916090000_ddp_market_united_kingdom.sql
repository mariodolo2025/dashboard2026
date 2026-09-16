-- The United Kingdom joins the DDP markets (Mario, 2026-09-16).
--
-- It behaves like Canada does now: the VAT is INSIDE the product price rather
-- than added at checkout, starting 2026-09-17 Brisbane. Duties are not charged
-- below the GBP 135 threshold, and above it they are zero anyway — the
-- Australia-UK FTA gives AU-origin goods a 0% tariff, which is why all 15 ZONOS
-- UK records verified on 2026-09-15 carry duties = A$0 and bill only the
-- British VAT plus the ZONOS fee. Confirmed again on the 28 orders loaded here:
-- charged tax A$0.00, charged duties A$0.00, ZONOS duty A$0.00, ZONOS VAT
-- A$95.15 and fee A$28.11 over the 11 orders it has billed so far.
--
-- charges_duties = false, unlike Canada's true. Canada charged at checkout
-- until its cutover; the UK never did — every GB month since June shows exactly
-- $0.00 of checkout tax. So its "before" side is Dolo absorbing the VAT, not
-- collecting it, and the price rise from the 17th is what starts covering it.
-- The before/after panel keys off duties_included_from alone, so it lights up
-- for the UK with no code change; only the flag is drawn in the tab.
--
-- ad_region null: there is no UK campaign. The Europe campaign names Germany,
-- Denmark and Sweden, so no MER can be attributed here without inventing one.
--
-- in_all_markets = true: ~30 orders a month, the same order of magnitude as
-- Canada. Only the USA sits outside the aggregate, and only because it is forty
-- times the next market.
--
-- The market list is data, not code: adding this row is what makes ddp-sync
-- pick UK orders up at both ends (Shopify intake and the ZONOS pass).

insert into ddp_markets (
  country_code, name, zonos_expected, active, ad_region, ad_campaign_like,
  charges_duties, in_all_markets, duties_included_from, note, updated_at)
values (
  'GB', 'United Kingdom', true, true, null, null,
  false, true,
  -- 2026-09-17 00:00 Brisbane
  timestamptz '2026-09-17 00:00:00+10',
  'Added 2026-09-16. VAT moves INTO the product price from 17-Sep-2026 (Brisbane), the Canadian model. '
  || 'Nothing was ever charged at UK checkout: $0.00 of tax in every month since June, because orders sit under the GBP 135 threshold. '
  || 'Duties are always A$0 under the Australia-UK FTA, so what ZONOS bills is British VAT plus its fee. '
  || 'In ZONOS since 20-Aug-2026; before that UK shipped via DHL Express and never reached ZONOS. '
  || 'No UK advertising campaign exists, so no MER on this tab.',
  now())
on conflict (country_code) do update set
  name = excluded.name, zonos_expected = excluded.zonos_expected, active = excluded.active,
  ad_region = excluded.ad_region, ad_campaign_like = excluded.ad_campaign_like,
  charges_duties = excluded.charges_duties, in_all_markets = excluded.in_all_markets,
  duties_included_from = excluded.duties_included_from, note = excluded.note, updated_at = now();
