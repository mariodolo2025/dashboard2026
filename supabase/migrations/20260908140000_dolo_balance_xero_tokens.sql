-- Serialize refreshes used by both the existing sync and the isolated Balance reader.
begin;
set local lock_timeout='3s';
create table public.dolo_balance_xero_session (
  id integer primary key check(id=1), access_token text, expires_at timestamptz,
  refresh_fingerprint text, scopes text, lease_id uuid, lease_until timestamptz
);
alter table public.dolo_balance_xero_session enable row level security;
revoke all on public.dolo_balance_xero_session from public, anon, authenticated;
insert into public.dolo_balance_xero_session(id) values(1);
create function public.dolo_balance_xero_claim(p_lease uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.dolo_balance_xero_session; t public.xero_oauth_tokens;
begin
 select * into v from public.dolo_balance_xero_session where id=1 for update;
 select * into t from public.xero_oauth_tokens where id=1;
 if t.refresh_token is null then raise exception 'XERO_NOT_CONNECTED'; end if;
 if v.expires_at>clock_timestamp()+interval '90 seconds' and v.refresh_fingerprint=md5(t.refresh_token) then
   return jsonb_build_object('accessToken',v.access_token,'tenantId',t.tenant_id,'scopes',v.scopes);
 end if;
 if v.lease_until>clock_timestamp() then return jsonb_build_object('busy',true); end if;
 update public.dolo_balance_xero_session set lease_id=p_lease,lease_until=clock_timestamp()+interval '45 seconds' where id=1;
 return jsonb_build_object('refreshToken',t.refresh_token,'tenantId',t.tenant_id);
end $$;
create function public.dolo_balance_xero_finish(p_lease uuid,p_old_refresh text,p_new_refresh text,p_access text,p_expires integer,p_scopes text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.dolo_balance_xero_session; n integer;
begin
 select * into v from public.dolo_balance_xero_session where id=1 for update;
 if v.lease_id is distinct from p_lease then return false; end if;
 update public.xero_oauth_tokens set refresh_token=p_new_refresh,updated_at=clock_timestamp() where id=1 and refresh_token=p_old_refresh;
 get diagnostics n=row_count;
 if n<>1 then
   update public.dolo_balance_xero_session set lease_id=null,lease_until=null where id=1;
   return false;
 end if;
 update public.dolo_balance_xero_session set access_token=p_access,
 expires_at=clock_timestamp()+make_interval(secs=>least(p_expires,1800)),
 refresh_fingerprint=md5(p_new_refresh),scopes=p_scopes,lease_id=null,lease_until=null where id=1;
 return true;
end $$;
create function public.dolo_balance_xero_release(p_lease uuid) returns void
language sql security definer set search_path=public,pg_temp as $$
 update public.dolo_balance_xero_session set lease_id=null,lease_until=null where id=1 and lease_id=p_lease
$$;
revoke all on function public.dolo_balance_xero_claim(uuid),public.dolo_balance_xero_finish(uuid,text,text,text,integer,text),public.dolo_balance_xero_release(uuid) from public,anon,authenticated;
grant execute on function public.dolo_balance_xero_claim(uuid),public.dolo_balance_xero_finish(uuid,text,text,text,integer,text),public.dolo_balance_xero_release(uuid) to service_role;
commit;
