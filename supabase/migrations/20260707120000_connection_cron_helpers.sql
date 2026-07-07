-- Helpers so edge functions (service role, via PostgREST RPC) can read and
-- reschedule pg_cron jobs for the Connections panel. The cron schema is not
-- exposed through PostgREST, hence these SECURITY DEFINER wrappers in public.
-- Execute rights: service_role only.

create or replace function public.connection_cron_get(p_jobname text)
returns table (jobname text, schedule text, active boolean)
language sql
security definer
set search_path = public, cron
as $$
  select j.jobname::text, j.schedule::text, j.active
  from cron.job j
  where j.jobname = p_jobname;
$$;

create or replace function public.connection_cron_set(p_jobname text, p_schedule text)
returns void
language plpgsql
security definer
set search_path = public, cron
as $$
declare
  jid bigint;
begin
  select jobid into jid from cron.job where jobname = p_jobname;
  if jid is null then
    raise exception 'cron job "%" not found', p_jobname;
  end if;
  perform cron.alter_job(jid, schedule => p_schedule);
end;
$$;

revoke all on function public.connection_cron_get(text) from public, anon, authenticated;
revoke all on function public.connection_cron_set(text, text) from public, anon, authenticated;
grant execute on function public.connection_cron_get(text) to service_role;
grant execute on function public.connection_cron_set(text, text) to service_role;
