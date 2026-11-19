-- Rollback for docs/lock-location-anon.sql.
-- Run this only if the trackers break after that file. It restores anon write
-- access to the location tables. Deploy the previous pages or fix the new
-- ones, then lock the tables again.
--
-- user_settings is restored only as the three-key stopgap
-- (home_state, email_address, location_email_hour), not as anon_all_user_settings.
-- Restoring every user_settings key is research-tracker-alerts PR 39's
-- rollback (supabase/lock-anon-access-rollback.sql). That file also re-opens
-- conversations and the other research tables. Do not use it to undo only
-- this location lockdown.
--
-- Snapshot this undoes was taken 2026-11-19. See docs/lock-location-anon.sql.

begin;

alter table public.location_entries enable row level security;
alter table public.location_entries_wife enable row level security;
alter table public.user_settings enable row level security;
alter table public.user_settings_wife enable row level security;

grant select, insert, update, delete, truncate, references, trigger
  on table public.location_entries to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger
  on table public.location_entries_wife to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger
  on table public.user_settings_wife to anon, authenticated;

drop policy if exists "Allow anon all" on public.location_entries;
create policy "Allow anon all" on public.location_entries
  for all to public using (true) with check (true);

drop policy if exists anon_all_wife_entries on public.location_entries_wife;
create policy anon_all_wife_entries on public.location_entries_wife
  for all to anon using (true) with check (true);

drop policy if exists anon_all_wife_settings on public.user_settings_wife;
create policy anon_all_wife_settings on public.user_settings_wife
  for all to anon using (true) with check (true);

-- Three-key stopgap only. Does not recreate anon_all_user_settings.
grant select, insert, update, delete on table public.user_settings to anon;
drop policy if exists anon_location_settings_keys on public.user_settings;
create policy anon_location_settings_keys on public.user_settings
  for all to anon
  using (key in ('home_state', 'email_address', 'location_email_hour'))
  with check (key in ('home_state', 'email_address', 'location_email_hour'));

commit;
