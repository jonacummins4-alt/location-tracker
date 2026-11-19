-- Lock anon and authenticated out of the location-tracker tables.
-- Run research-tracker-alerts PR 39 supabase/lock-anon-access.sql FIRST, then
-- this file, in the same sitting as the page deploy. See docs/go-live.md.
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
--   * drops every user_settings_location_* policy, plus any anon or public
--     policy whose expression names home_state, email_address, or
--     location_email_hour, whether or not PR 39 has already run
--   * revokes anon/authenticated on user_settings when one of those location
--     policies was dropped, or when anon_all_user_settings is already gone
--
-- After this file AND PR 39's lock-anon-access.sql, anon has no policy and no
-- grant on location_entries, location_entries_wife, user_settings_wife, or
-- user_settings. service_role keeps DML and bypasses RLS, which is how
-- tracker-api and the reminder functions read and write.
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

-- Drop the location stopgap on user_settings. user_settings_location_* is
-- dropped by name even if this file runs before or after PR 39. anon_all_user_settings
-- uses (true) and is left for PR 39 unless it is already gone.
do $$
declare
  pol record;
  dropped_location boolean := false;
  applies_to_anon boolean;
  qual text;
  check_expr text;
begin
  for pol in
    select p.polname as name, p.polroles as roles, p.polqual as qual, p.polwithcheck as check_expr, p.polrelid as relid
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'user_settings'
  loop
    applies_to_anon := cardinality(pol.roles) = 0
      or exists (
        select 1
        from unnest(pol.roles) as role_oid
        join pg_roles r on r.oid = role_oid
        where r.rolname = 'anon'
      );
    qual := coalesce(pg_get_expr(pol.qual, pol.relid), '');
    check_expr := coalesce(pg_get_expr(pol.check_expr, pol.relid), '');
    if pol.name like 'user#_settings#_location#_%' escape '#'
      or pol.name in ('anon_location_settings_keys', 'anon_location_tracker_settings')
      or (
        applies_to_anon
        and (
          qual ilike '%home_state%'
          or qual ilike '%email_address%'
          or qual ilike '%location_email_hour%'
          or check_expr ilike '%home_state%'
          or check_expr ilike '%email_address%'
          or check_expr ilike '%location_email_hour%'
        )
      )
    then
      execute format('drop policy %I on public.user_settings', pol.name);
      if pol.name like 'user#_settings#_location#_%' escape '#'
        or pol.name in ('anon_location_settings_keys', 'anon_location_tracker_settings')
      then
        dropped_location := true;
      end if;
    end if;
  end loop;

  if dropped_location or not exists (
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
