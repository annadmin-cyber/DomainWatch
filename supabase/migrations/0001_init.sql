-- DomainWatch initial schema
-- Apply once in the Supabase SQL Editor (or with `supabase db push`).
-- Safe to re-run: every statement is idempotent.


-- ---------------------------------------------------------------------------
-- Owner registry: exactly one Supabase Auth user may use the app.
-- ---------------------------------------------------------------------------
create table if not exists public.app_owner (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_owner where user_id = auth.uid()
  );
$$;

revoke all on function public.is_owner() from public;
grant execute on function public.is_owner() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enumerations (as check constraints to keep migrations simple)
-- ---------------------------------------------------------------------------
-- registration status values:
--   not_checked | registered | unregistered | unknown | unsupported

-- ---------------------------------------------------------------------------
-- Main domains the owner owns
-- ---------------------------------------------------------------------------
create table if not exists public.domains (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  base_domain text not null,
  label text not null,
  suffix text not null,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint domains_base_domain_lower check (base_domain = lower(base_domain)),
  constraint domains_base_unique unique (base_domain)
);

-- ---------------------------------------------------------------------------
-- Monitored variants (same label, other extensions)
-- ---------------------------------------------------------------------------
create table if not exists public.monitored_domains (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  domain_id uuid not null references public.domains (id) on delete cascade,
  fqdn text not null,
  suffix text not null,
  is_mine boolean not null default false,
  is_active boolean not null default true,

  -- latest check outcome shown in the UI
  status text not null default 'not_checked'
    check (status in ('not_checked','registered','unregistered','unknown','unsupported')),
  status_detail text,
  -- latest conclusive result (registered/unregistered) used for change detection
  last_conclusive_status text
    check (last_conclusive_status in ('registered','unregistered')),
  last_conclusive_at timestamptz,
  last_confirmed_unregistered_at timestamptz,

  -- baseline = first successful conclusive check
  baseline_status text check (baseline_status in ('registered','unregistered')),
  baseline_at timestamptz,

  last_checked_at timestamptz,
  last_success_at timestamptz,
  status_changed_at timestamptz,
  registration_date timestamptz,
  data_source text,
  last_error text,
  consecutive_failures integer not null default 0,
  claimed_until timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monitored_fqdn_lower check (fqdn = lower(fqdn)),
  constraint monitored_fqdn_unique unique (fqdn)
);

create index if not exists monitored_domains_domain_idx on public.monitored_domains (domain_id);
create index if not exists monitored_domains_due_idx on public.monitored_domains (is_active, last_checked_at nulls first);

-- ---------------------------------------------------------------------------
-- Monitoring runs (cron, continuation, manual)
-- ---------------------------------------------------------------------------
create table if not exists public.monitor_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null check (trigger in ('cron','continuation','manual')),
  chain_id uuid,
  chain_depth integer not null default 0,
  status text not null default 'running'
    check (status in ('running','success','partial','failed','skipped')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  checked_count integer not null default 0,
  conclusive_count integer not null default 0,
  error_count integer not null default 0,
  remaining_count integer not null default 0,
  events_count integer not null default 0,
  message text
);

create index if not exists monitor_runs_started_idx on public.monitor_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- Individual check results (history)
-- ---------------------------------------------------------------------------
create table if not exists public.check_results (
  id uuid primary key default gen_random_uuid(),
  monitored_domain_id uuid not null references public.monitored_domains (id) on delete cascade,
  run_id uuid references public.monitor_runs (id) on delete set null,
  checked_at timestamptz not null default now(),
  status text not null check (status in ('registered','unregistered','unknown','unsupported')),
  source text,
  http_status integer,
  registration_date timestamptz,
  error text,
  duration_ms integer,
  confirmation boolean not null default false
);

create index if not exists check_results_domain_idx on public.check_results (monitored_domain_id, checked_at desc);

-- ---------------------------------------------------------------------------
-- Status change events (idempotent via dedupe_key)
-- ---------------------------------------------------------------------------
create table if not exists public.status_events (
  id uuid primary key default gen_random_uuid(),
  monitored_domain_id uuid not null references public.monitored_domains (id) on delete cascade,
  event_type text not null check (event_type in (
    'baseline',
    'new_registration',
    'newly_detected_registered',
    'became_unregistered',
    'own_domain_change'
  )),
  previous_status text,
  new_status text not null,
  previous_confirmed_unregistered_at timestamptz,
  detected_at timestamptz not null default now(),
  registration_date timestamptz,
  message text not null,
  dedupe_key text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists status_events_detected_idx on public.status_events (detected_at desc);

-- ---------------------------------------------------------------------------
-- In-app notifications + delivery log
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  event_id uuid unique references public.status_events (id) on delete cascade,
  kind text not null default 'alert' check (kind in ('alert','info','test')),
  title text not null,
  body text not null,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists notifications_created_idx on public.notifications (created_at desc);

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id) on delete cascade,
  channel text not null check (channel in ('telegram')),
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','skipped')),
  attempts integer not null default 0,
  last_error text,
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint notification_deliveries_unique unique (notification_id, channel)
);

-- ---------------------------------------------------------------------------
-- Settings (single row)
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  singleton boolean primary key default true check (singleton),
  telegram_enabled boolean not null default false,
  telegram_chat_id text,
  default_suffixes text[] not null default array['com','net','org','co','id','co.id','io','app','online','store','xyz'],
  updated_at timestamptz not null default now()
);

insert into public.app_settings (singleton) values (true) on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Run lock + rate limiting (server-only helpers)
-- ---------------------------------------------------------------------------
create table if not exists public.monitor_lock (
  singleton boolean primary key default true check (singleton),
  run_id uuid,
  locked_until timestamptz not null default 'epoch'
);

insert into public.monitor_lock (singleton) values (true) on conflict do nothing;

create or replace function public.acquire_monitor_lock(p_run_id uuid, p_ttl_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.monitor_lock
     set run_id = p_run_id,
         locked_until = now() + make_interval(secs => p_ttl_seconds)
   where singleton and (locked_until < now() or run_id = p_run_id);
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

create or replace function public.release_monitor_lock(p_run_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.monitor_lock
     set run_id = null, locked_until = 'epoch'
   where singleton and run_id = p_run_id;
$$;

create table if not exists public.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits integer not null
);

-- Returns true when the call is allowed, false when the limit is exceeded.
create or replace function public.hit_rate_limit(p_key text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hits integer;
begin
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

-- Claim a batch of due variants so overlapping workers never check the same row.
create or replace function public.claim_due_domains(p_limit integer, p_due_before timestamptz, p_claim_seconds integer)
returns setof public.monitored_domains
language sql
security definer
set search_path = public
as $$
  update public.monitored_domains m
     set claimed_until = now() + make_interval(secs => p_claim_seconds)
   where m.id in (
     select id from public.monitored_domains
      where is_active
        and (claimed_until is null or claimed_until < now())
        and (last_checked_at is null or last_checked_at < p_due_before)
      order by last_checked_at nulls first, created_at
      limit p_limit
      for update skip locked
   )
  returning m.*;
$$;

revoke all on function public.acquire_monitor_lock(uuid, integer) from public, anon, authenticated;
revoke all on function public.release_monitor_lock(uuid) from public, anon, authenticated;
revoke all on function public.hit_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_due_domains(integer, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.acquire_monitor_lock(uuid, integer) to service_role;
grant execute on function public.release_monitor_lock(uuid) to service_role;
grant execute on function public.hit_rate_limit(text, integer, integer) to service_role;
grant execute on function public.claim_due_domains(integer, timestamptz, integer) to service_role;

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists domains_touch on public.domains;
create trigger domains_touch before update on public.domains
  for each row execute function public.touch_updated_at();

drop trigger if exists monitored_domains_touch on public.monitored_domains;
create trigger monitored_domains_touch before update on public.monitored_domains
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Only the registered owner can read/write through the public API.
-- The server (service role) bypasses RLS for background monitoring.
-- ---------------------------------------------------------------------------
alter table public.app_owner enable row level security;
alter table public.domains enable row level security;
alter table public.monitored_domains enable row level security;
alter table public.monitor_runs enable row level security;
alter table public.check_results enable row level security;
alter table public.status_events enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.app_settings enable row level security;
alter table public.monitor_lock enable row level security;
alter table public.rate_limits enable row level security;

-- app_owner: a user may only see whether they themselves are the owner.
drop policy if exists app_owner_select_self on public.app_owner;
create policy app_owner_select_self on public.app_owner
  for select to authenticated using (user_id = (select auth.uid()));

-- domains
drop policy if exists domains_owner_all on public.domains;
create policy domains_owner_all on public.domains
  for all to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

-- monitored_domains
drop policy if exists monitored_owner_all on public.monitored_domains;
create policy monitored_owner_all on public.monitored_domains
  for all to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

-- Read-only tables for the owner (written by the server only)
drop policy if exists runs_owner_read on public.monitor_runs;
create policy runs_owner_read on public.monitor_runs
  for select to authenticated using ((select public.is_owner()));

drop policy if exists checks_owner_read on public.check_results;
create policy checks_owner_read on public.check_results
  for select to authenticated using ((select public.is_owner()));

drop policy if exists events_owner_read on public.status_events;
create policy events_owner_read on public.status_events
  for select to authenticated using ((select public.is_owner()));

drop policy if exists notifications_owner_read on public.notifications;
create policy notifications_owner_read on public.notifications
  for select to authenticated using ((select public.is_owner()));

-- The owner may mark notifications as read (only read_at changes are allowed via column grant).
drop policy if exists notifications_owner_update on public.notifications;
create policy notifications_owner_update on public.notifications
  for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

drop policy if exists deliveries_owner_read on public.notification_deliveries;
create policy deliveries_owner_read on public.notification_deliveries
  for select to authenticated using ((select public.is_owner()));

drop policy if exists settings_owner_read on public.app_settings;
create policy settings_owner_read on public.app_settings
  for select to authenticated using ((select public.is_owner()));

drop policy if exists settings_owner_update on public.app_settings;
create policy settings_owner_update on public.app_settings
  for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

-- monitor_lock and rate_limits: no policies => no access for anon/authenticated.

-- Table privileges: anon gets nothing; authenticated gets only what the policies allow.
revoke all on all tables in schema public from anon;
revoke all on public.monitor_lock, public.rate_limits from authenticated;
revoke insert, update, delete on public.monitor_runs, public.check_results, public.status_events,
  public.notification_deliveries, public.app_owner from authenticated;
revoke insert, delete on public.notifications, public.app_settings from authenticated;
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;
