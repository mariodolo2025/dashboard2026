-- Normalize customer-machine names in web_upgrade_performance.byMachine.
-- The three modules write the same machine differently ("The Dual Boiler",
-- "Compatible with your Dual Boiler", "Breville / Dual Boiler"), fragmenting
-- Sales-by-machine into duplicate rows. Strip the module-specific prefixes so
-- they group into one row per machine. Applied by patching the deployed
-- definition in place (single-expression change):
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('web_upgrade_performance(date,date,text)'::regprocedure);
  v_def := replace(v_def,
    $$coalesce(nullif(btrim(a.pesado_machine), ''), 'Unknown') machine$$,
    $$coalesce(nullif(btrim(regexp_replace(regexp_replace(a.pesado_machine, '^(Compatible with your|The)\s+', '', 'i'), '^Breville\s*/\s*', '', 'i')), ''), 'Unknown') machine$$);
  execute v_def;
end $do$;

notify pgrst, 'reload schema';
