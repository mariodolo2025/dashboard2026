-- =============================================================================
-- IC13 — the rule's start time, read off the orders instead of assumed.
--
-- rule_from was set to 2026-10-14 00:00 Brisbane, the start of the day Mario
-- switched the Starshipit rule on, because the exact moment was not known. The
-- labels now say it exactly, and they say it cleanly:
--
--   PTI8 standard : 17 orders, 03:06 -> 09:27 Brisbane
--   IC13 express  : 13 orders, 09:40 -> 12:20 Brisbane
--
-- No overlap. The rule went live between 09:27 and 09:40. With midnight as the
-- start, those 17 earlier orders counted as orders the rule failed to catch and
-- adherence read 43% — a number that would have sent someone looking for a
-- broken rule. Same lesson as Canada's duties cutover: a policy's start time is
-- measured from the orders, never assumed from the day.
--
-- 09:35 sits inside the gap. The date the tab opens on is unchanged: it is
-- derived from this timestamp as a store day, and that is still 14 Oct.
-- =============================================================================

update ddp_service_segments
set rule_from = timestamptz '2026-10-14 09:35:00+10',
    note = note || ' Rule measured live between 09:27 and 09:40 Brisbane on 14-Oct-2026: the last PTI8 label and the first IC13 label, with no overlap.',
    updated_at = now()
where code = 'US-IC13';
