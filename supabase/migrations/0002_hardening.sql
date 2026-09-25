-- DomainWatch migration 0002: privilege hardening, safer ownership and
-- rate-limit pruning. Run after 0001_init.sql in the Supabase SQL Editor.
-- Safe to re-run.

-- Deleting an old owner account must never delete the monitoring data.
alter table public.domains alter column owner_id drop not null;
alter table public.domains drop constraint if exists domains_owner_id_fkey;
alter table public.domains
  add constraint domains_owner_id_fkey foreign key (owner_id) references auth.users (id) on delete set null;

alter table public.monitored_domains alter column owner_id drop not null;
alter table public.monitored_domains drop constraint if exists monitored_domains_owner_id_fkey;
alter table public.monitored_domains
  add constraint monitored_domains_owner_id_fkey foreign key (owner_id) references auth.users (id) on delete set null;

-- TRUNCATE ignores RLS: API roles must never hold it (nor TRIGGER/REFERENCES).
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

-- Functions: only the roles that need them.
revoke execute on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated, service_role;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

-- Explicit grants, so the app works even if the project's default privileges
-- do not grant new tables to the API roles. RLS policies still apply.
grant usage on schema public to authenticated, service_role;
grant select, delete on public.domains, public.monitored_domains to authenticated;
grant select on public.app_owner, public.monitor_runs, public.check_results, public.status_events,
  public.notifications, public.notification_deliveries, public.app_settings to authenticated;
grant update on public.app_settings to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;

-- Column-level privileges: the owner's session may write only the columns the
-- app edits. Monitoring state (status, last_*, baseline_*, claimed_until,
-- consecutive_failures, ...) is written by the server (service_role) only.
-- Revoking the table-level privilege also removes earlier column grants, so
-- this block gives the same result every time it runs.
revoke insert, update on public.domains, public.monitored_domains from authenticated;
grant insert (base_domain, label, suffix, notes) on public.domains to authenticated;
grant update (notes, is_active) on public.domains to authenticated;
grant insert (domain_id, fqdn, suffix, is_mine, is_active) on public.monitored_domains to authenticated;
grant update (is_mine, is_active) on public.monitored_domains to authenticated;

-- Rate limiting also prunes windows older than a day, so rate_limits stays
-- small without a scheduled job (all windows used by the app are far shorter).
create index if not exists rate_limits_window_idx on public.rate_limits (window_start);

create or replace function public.hit_rate_limit(p_key text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hits integer;
begin
  delete from public.rate_limits where window_start < now() - interval '1 day';

  insert into public.rate_limits as r (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update
     set hits = case
                  when r.window_start < now() - make_interval(secs => p_window_seconds) then 1
                  else r.hits + 1
                end,
         window_start = case
                  when r.window_start < now() - make_interval(secs => p_window_seconds) then now()
                  else r.window_start
                end
  returning hits into v_hits;
  return v_hits <= p_max;
end;
$$;

revoke all on function public.hit_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, integer, integer) to service_role;
