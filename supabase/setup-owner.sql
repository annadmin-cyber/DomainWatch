-- DomainWatch: register the owner account.
--
-- 1. Create your login first in Supabase: Authentication > Users > Add user > Create new user
--    (tick "Auto Confirm User").
-- 2. Replace owner@example.com below with that exact email address.
-- 3. Run this script in the Supabase SQL Editor.
--
-- Running it again with a different email moves ownership to that account.

insert into public.app_owner (singleton, user_id)
select true, id
from auth.users
where lower(email) = lower('owner@example.com')
on conflict (singleton) do update set user_id = excluded.user_id;

-- Should return exactly one row with your email. If it returns nothing,
-- the email above does not match a user in Authentication > Users.
select u.email, o.created_at as owner_since
from public.app_owner o
join auth.users u on u.id = o.user_id;
