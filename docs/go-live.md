# Location tracker lockdown

This is the inventory, the design, and the order for putting it live. Nothing in this repo deploys itself, sets a secret, or runs SQL.

## How the pages are hosted

| | Jon | Amy |
| --- | --- | --- |
| Repo | `jonacummins4-alt/location-tracker` | `jonacummins4-alt/location-tracker-wife` |
| GitHub Pages | not enabled (Pages API returns 404) | not enabled |
| Production | Vercel, `https://location-tracker-sand-six.vercel.app` | Vercel, `https://location-tracker-wife.vercel.app` |
| How it ships | GitHub `main` to Vercel Production. Latest production deployment of this repo is commit `acc926d`. | Same, from the wife repo. |
| What is deployed | `index.html` at the repo root. There is no `vercel.json`. | `index.html` only. |

`index-html.html` in this repo is an older copy. It is not the Vercel entrypoint. It was updated in the same pass so it does not keep a Supabase key.

Both live responses send `server: Vercel`.

## What the pages do today (before this change)

Each page is one HTML file. The password gate is still in the source and still contains the password, but the latest commit never calls it, so the page opens straight onto the data. The gate's "forgot password" button, which is also unused, POSTs `{app:"jon"}` or `{app:"wife"}` to `send-password-hint`.

Browser calls, all with the public anon key on `https://otnugbbtasbrcjqghvga.supabase.co`:

| Call | Jon | Amy |
| --- | --- | --- |
| GET `?select=*&order=date.desc` | `location_entries` | `location_entries_wife` |
| POST upsert (`resolution=merge-duplicates`) | `location_entries` | `location_entries_wife` |
| DELETE `?id=eq.…` | `location_entries` | `location_entries_wife` |
| GET `?key=in.(home_state,email_address,location_email_hour)` | `user_settings` | `user_settings_wife` |
| POST upsert of one of those keys | `user_settings` | `user_settings_wife` |
| GET `?select=id&limit=1` on load | `location_entries` | `location_entries_wife` |

`user_settings` is shared with the research tracker. The location page only uses `home_state`, `email_address`, and `location_email_hour`.

## Database, as read on 2026-11-19

RLS is on and not forced. No views in `public`. Anon, authenticated, and service_role each have SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, and TRIGGER.

| Table | Policy | Who |
| --- | --- | --- |
| `location_entries` | `"Allow anon all"` for ALL, using true | public |
| `location_entries_wife` | `anon_all_wife_entries` for ALL, using true | anon |
| `user_settings` | `anon_all_user_settings` for ALL, using true | anon |
| `user_settings_wife` | `anon_all_wife_settings` for ALL, using true | anon |

`location_entries` is unique on `date`. `location_entries_wife` is not. Settings tables are keyed by `key`.

## Edge functions

| Function | In git? | verify_jwt | What it uses |
| --- | --- | --- | --- |
| `send-password-hint` | Yes, previously only in `research-tracker-alerts/supabase-functions/send-password-hint`. The deployed body matches that file. | false | `SUPABASE_SERVICE_ROLE_KEY` to read `email_address`, then Resend. The password it emails comes from the function secrets `LT_JON_PASSWORD` and `LT_WIFE_PASSWORD`, not from the caller. The caller only sends `app`. Anyone can call it. They can change `email_address` with the anon key first, and the next call sends the password to that new address. |
| `location-reminder` | Deployed only, version 17. The connector could not download it. A replacement now lives in `supabase/functions/location-reminder`. | false | The deployed copy reads with the publishable anon key. The replacement reads with `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEYS`. |
| `location-reminder-wife` | Same, version 9. Replacement in `supabase/functions/location-reminder-wife`. | false | Same, for Amy's tables. |

`pg_cron` jobs 5 and 6 run hourly and POST `{}` at those two functions. The deployed functions read with the anon key, so `docs/lock-location-anon.sql` would stop the reminder emails until the replacement is deployed. Assumptions for the replacement are in `docs/reminder-assumptions.md`. Compare that file with the dashboard source before deploying it.

`send-password-hint` in this repo returns 410 and does not send mail. `research-tracker-alerts/supabase-functions/send-password-hint` is a different repo. Deploy the 410 copy from this repo. That other repo is handled separately.

Supabase injects `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_SECRET_KEYS` into Edge Functions. `RESEND_API_KEY` is already set.

## Design

One new Edge Function, `tracker-api`, in this repo. Both pages call it. Vercel already hosts the pages, but a function there would be a different project for each person and would need the service role copied into both. One function in the same Supabase project keeps that key in one place.

Sign-in is a 6-digit code emailed to the address already stored for that tracker. The request does not accept an email address, so a caller cannot point the message at themselves. That replaces the password and `send-password-hint`. A magic link was the other passwordless option. A code stays in the same browser on a phone home-screen icon, which is the daily habit. Supabase Auth was not required, and mail already goes out through Resend.

The function signs a token with HMAC-SHA256 and `LOCATION_SESSION_SECRET` (a new function secret, at least 32 characters). The token lasts 30 days and renews when fewer than 15 days remain, so opening the page on a normal day does not ask again. It is stored in `localStorage` on the page's own origin. A cross-site httpOnly cookie set by `supabase.co` would be a third-party cookie, and Safari already drops those. The token names `jon` or `amy` and a per-person session version stored as `tracker_session_version`. Sign out increments that version, which signs that person out on every device. Data routes ignore any person in the body and use the token. Only `https://location-tracker-sand-six.vercel.app` and `https://location-tracker-wife.vercel.app` are allowed origins. Jon's origin cannot request Amy's code, and the reverse.

Login counters are written with a compare-and-swap on the previous value, so overlapping guesses cannot slip past the five-attempt limit. The challenge and rate rows sit in the settings tables. Those tables stay readable by anon until the SQL in this folder runs, so the page deploy and that SQL belong in one sitting.

Codes and failures are stored with the service role under `tracker_login_challenge` and `tracker_login_rate` in that person's settings table. Those keys are not returned to the page. Limits: one code per minute, five per hour, twenty per hour for one IP, five wrong guesses, ten-minute expiry. The code is stored as an HMAC, not as the digits.

`send-password-hint` in this repo returns 410 and does not read the database or send mail. Deploying it replaces the live function.

## What Jon and Amy do

Jon sets two secrets in the Supabase dashboard and deploys, using the order below. Amy does not set a secret, run SQL, or deploy.

- `LOCATION_SESSION_SECRET` — at least 32 random characters. Signs the browser session.
- `REMINDER_CRON_SECRET` — at least 16 random characters. The hourly cron sends it as `x-reminder-secret`. The same value is pasted into `docs/reminder-cron.sql` in the SQL editor. Do not commit that filled-in file.

`RESEND_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are already available to functions. Optional: `REMINDER_TIMEZONE` if the dashboard reminder does not use `America/New_York`.

After the pages are live, each person opens their own tracker once, taps **Email me a sign-in code**, and types the code from the inbox already saved on that tracker. The same steps work on a phone and on a desktop. After that, logging a day, history, import, export, and the daily reminder email are unchanged. The session renews while they keep opening the page. Sign out increments `tracker_session_version` for that person, so their other devices have to request a new code. Changing the email is in the settings row, and it requires that session.

The old Face ID button is gone. It never checked a server secret. It only looked at a key stored on the phone.

## Go-live order

Do the page deploy and the lockdown SQL in one sitting. Until that SQL runs, the sign-in challenge and the rate-limit row are in tables anon can still read and write.

1. In the Supabase dashboard for project `otnugbbtasbrcjqghvga`, Edge Function secrets, set `LOCATION_SESSION_SECRET` and `REMINDER_CRON_SECRET`. Confirm each saved `email_address` is an inbox that person can open. Compare `docs/reminder-assumptions.md` with the dashboard source of the two reminder functions.
2. In the SQL editor, paste `docs/reminder-cron.sql`, replace `__REMINDER_CRON_SECRET__` with the secret from step 1, and run it. This updates cron jobs 5 and 6. The deployed functions ignore the new header, so the current reminders keep working. Do not save the filled statement into git.
3. From this repo, deploy these functions with JWT verification off, matching `supabase/config.toml`:
   - `tracker-api`
   - `send-password-hint` (the 410 copy in this repo, not the copy under `research-tracker-alerts/supabase-functions`)
   - `location-reminder`
   - `location-reminder-wife`
4. In the same sitting, deploy both Vercel pages, then lock the tables before leaving:
   - On a phone, for each site: email a code, type it, log today, see history, and confirm the hour still saves. Sign out and confirm that token no longer loads history.
   - Run research-tracker-alerts PR 39 `supabase/lock-anon-access.sql` first.
   - Then run `docs/lock-location-anon.sql`. It drops `user_settings_location_*` policies and the anon grants that go with them, including when this file runs after PR 39 has created that stopgap.
5. Verify, with the old anon key, that GET and POST to `location_entries`, `location_entries_wife`, `user_settings`, and `user_settings_wife` return a permission error or no rows. Open each tracker again and confirm history still loads. Outside the send hour, a POST to each reminder function with `x-reminder-secret` returns `{skipped:true, now, hr}`.

If step 5 breaks the trackers, run `docs/lock-location-anon-rollback.sql`, fix the deploy, and lock again. That rollback restores the location tables and a three-key stopgap on `user_settings`. It does not restore the research tracker's full anon access. PR 39's own rollback does that, and it also re-opens every `user_settings` key.

## Tests

`node --test tests/tracker-api.test.mjs tests/reminder.test.mjs` covers the token, the separation between the two people, the compare-and-swap limit, the reminder skip and send shapes, and that the pages no longer contain a key. It does not call Supabase or send mail.
