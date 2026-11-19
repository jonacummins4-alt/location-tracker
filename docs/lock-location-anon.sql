-- Lock anon and authenticated out of the location-tracker tables.
-- Do not run this until both tracker pages and the tracker-api function are
-- deployed and a phone sign-in has been checked. See docs/go-live.md.
--
-- This file is documentation. It is not applied by a deploy or by
-- `supabase db push`. Run it by hand in the Supabase SQL editor.
--
-- Snapshot taken 2026-11-19 from project otnugbbtasbrcjqghvga (read-only).
-- RLS is enabled and not forced on all four tables. No views exist in public.
--
-- Policies then in force:
--   location_entries       "Allow anon all"          ALL to public  using (true) with check (true)
--   location_entries_wife  anon_all_wife_entries     ALL to anon    using (true) with check (true)
--   user_settings          anon_all_user_settings    ALL to anon    using (true) with check (true)
--   user_settings_wife     anon_all_wife_settings    ALL to anon    using (true) with check (true)
--
-- Grants then in force, for anon, authenticated, and service_role, on each of
-- the four tables: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER.
-- No grant to the PUBLIC role itself was present.
--
-- Coordination with research-tracker-alerts PR 39
-- (https://github.com/jonacummins4-alt/research-tracker-alerts/pull/39,
-- branch cursor/anon-rls-lockdown-41a1, file supabase/lock-anon-access.sql
-- as of blob bfb592218e8ef4697b34dbde6e8cb1d5bddfda45):
--
-- That file revokes anon and authenticated on user_settings and drops
-- anon_all_user_settings. It does not touch location_entries,
-- location_entries_wife, or user_settings_wife. As of that blob it also does
-- not create a key-scoped stopgap. The task for this change is to remove the
-- stopgap if a later revision of PR 39 adds one so the location pages can
-- still reach home_state, email_address, and location_email_hour with the
-- anon key.
--
-- This script:
--   * drops the three location-table policies and their anon/authenticated grants
--   * drops any anon or public policy on user_settings whose expression names
--     home_state, email_address, or location_email_hour (the stopgap)
--   * revokes anon/authenticated on user_settings only when anon_all_user_settings
--     is already gone, so running this file before PR 39 does not lock the
--     research tracker off the anon key it still uses today
--
-- After this file AND PR 39's lock-anon-access.sql, anon has no policy and no
-- grant on location_entries, location_entries_wife, user_settings_wife, or
-- user_settings. service_role keeps DML and bypasses RLS, which is how
-- tracker-api and (once confirmed) the reminder functions read and write.
--
-- Rollback: docs/lock-location-anon-rollback.sql

begin;

alter table public.location_entries enable row level security;
alter table public.location_entries_wife enable row level security;
alter table public.user_settings enable row level security;
alter table public.user_settings_wife enable row level security;

drop policy if exists "Allow anon all" on public.location_entries;
drop policy if exists anon_all_wife_entries on public.location_entries_wife;
drop policy if exists anon_all_wife_settings on public.user_settings_wife;

revoke all on table public.location_entries from public, anon, authenticated;
revoke all on table public.location_entries_wife from public, anon, authenticated;
revoke all on table public.user_settings_wife from public, anon, authenticated;

grant select, insert, update, delete on table public.location_entries to service_role;
grant select, insert, update, delete on table public.location_entries_wife to service_role;
grant select, insert, update, delete on table public.user_settings_wife to service_role;

-- Drop the location-key stopgap on user_settings, whatever PR 39 named it,
-- when the policy is for anon or for public and the expression mentions one
-- of the three keys. anon_all_user_settings uses (true) and is left for PR 39.
do $$
declare
  pol record;
begin
  for pol in
    select p.polname as name
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'user_settings'
      and (
        cardinality(p.polroles) = 0
        or exists (
          select 1
          from unnest(p.polroles) as role_oid
          join pg_roles r on r.oid = role_oid
          where r.rolname = 'anon'
        )
      )
      and (
        p.polname in ('anon_location_settings_keys', 'anon_location_tracker_settings')
        or coalesce(pg_get_expr(p.polqual, p.polrelid), '') ilike '%home_state%'
        or coalesce(pg_get_expr(p.polqual, p.polrelid), '') ilike '%email_address%'
        or coalesce(pg_get_expr(p.polqual, p.polrelid), '') ilike '%location_email_hour%'
        or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ilike '%home_state%'
        or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ilike '%email_address%'
        or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ilike '%location_email_hour%'
      )
  loop
    execute format('drop policy %I on public.user_settings', pol.name);
  end loop;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'user_settings'
      and policyname = 'anon_all_user_settings'
  ) then
    revoke all on table public.user_settings from public, anon, authenticated;
    grant select, insert, update, delete on table public.user_settings to service_role;
  end if;
end $$;

commit;
