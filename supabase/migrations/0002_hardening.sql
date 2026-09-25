-- DomainWatch migration 0002: privilege hardening and safer ownership.
-- Run after 0001_init.sql in the Supabase SQL Editor. Safe to re-run.

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
grant select, insert, update, delete on public.domains, public.monitored_domains to authenticated;
grant select on public.app_owner, public.monitor_runs, public.check_results, public.status_events,
  public.notifications, public.notification_deliveries, public.app_settings to authenticated;
grant update on public.app_settings to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
