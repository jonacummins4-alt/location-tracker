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
| `location-reminder` | Not in either location repo. The research-tracker README lists it as a backup, but the directory is not in that repo. `get_edge_function` returned an internal error, so the body was not retrieved. | false (version 17) | Caller JWT role is `anon`. See below. |
| `location-reminder-wife` | Same as above. | false (version 9) | Same. |

`pg_cron` jobs 5 and 6 run hourly and POST an empty body at the two reminder functions. The Authorization header on those jobs is the anon key. `verify_jwt` is false, so that header does not decide which database role the function uses. Function logs for the last day show the caller role as `anon` (the cron) and, separately, calls with no JWT (the research tracker's health check).

`send-password-hint` is the only one of the three whose body we could read. It uses `SUPABASE_SERVICE_ROLE_KEY` from the function environment for REST, and ignores the caller token. Supabase injects `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_SECRET_KEYS` into Edge Functions. `RESEND_API_KEY` is already set, because the hint function reads it.

Before the SQL in this folder is run, download `location-reminder` and `location-reminder-wife` in the Supabase dashboard (or `supabase functions download`) and confirm each REST call uses `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEYS`, not `req.headers.get("Authorization")`. If a function forwards the caller token, redeploy it so it uses the service role before the SQL. Otherwise the hourly reminder breaks when anon loses table access. The cron jobs themselves can stay as they are.

## Design

One new Edge Function, `tracker-api`, in this repo. Both pages call it. Vercel already hosts the pages, but a function there would be a different project for each person and would need the service role copied into both. One function in the same Supabase project keeps that key in one place.

Sign-in is a 6-digit code emailed to the address already stored for that tracker. The request does not accept an email address, so a caller cannot point the message at themselves. That replaces the password and `send-password-hint`. A magic link was the other passwordless option. A code stays in the same browser on a phone home-screen icon, which is the daily habit. Supabase Auth was not required, and mail already goes out through Resend.

The function signs a token with HMAC-SHA256 and `TRACKER_SESSION_SECRET` (a new function secret, at least 32 characters). The token lasts 30 days and is renewed when fewer than 15 days remain, so opening the page on a normal day does not ask again. It is stored in `localStorage` on the page's own origin. A cross-site httpOnly cookie set by `supabase.co` would be a third-party cookie, and Safari already drops those; the old page had to work around that. The token names `jon` or `amy`. Data routes ignore any person in the body and use the token. Jon's origin cannot request Amy's code, and the reverse.

Codes and failures are stored with the service role under `tracker_login_challenge` and `tracker_login_rate` in that person's settings table. Those keys are not returned to the page. Limits: one code per minute, five per hour, twenty per hour for one IP, five wrong guesses, ten-minute expiry. The code is stored as an HMAC, not as the digits.

`send-password-hint` in this repo returns 410 and does not read the database or send mail. Deploying it replaces the live function.

## What Jon and Amy do

Jon sets one secret and deploys, using the order below. Amy does not set a secret and does not run SQL.

After the pages are live, each person opens their own tracker once, taps **Email me a sign-in code**, and types the code from the inbox already saved on that tracker. The same steps work on a phone and on a desktop. After that, logging a day, history, import, export, and the daily reminder email are unchanged. The session renews while they keep opening the page. Sign out is on the page. Changing the email is in the settings row, and it requires that session, so the next code follows the new address only after someone who is already signed in changes it.

The old Face ID button is gone. It never checked a server secret. It only looked at a key stored on the phone.

## Go-live order

Do this in order. Do not run the SQL first.

1. In the Supabase dashboard for project `otnugbbtasbrcjqghvga`, Edge Function secrets, set `TRACKER_SESSION_SECRET` to a new random string of at least 32 characters. Do not reuse a password, do not put it in git, and do not paste it into a shell history if you can avoid it. `RESEND_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are already available to functions. Confirm the saved `email_address` for each tracker is an inbox that person can open. This page can no longer change that address until after a code is delivered.
2. From this repo, deploy the two functions with JWT verification off, matching `supabase/config.toml`:
   - `tracker-api`
   - `send-password-hint` (the retired copy in this repo)
3. Download the two reminder functions and confirm they use the service role, as described above. Redeploy them first if they do not.
4. Merge and deploy this repo and the wife-repo page change. Vercel Production should update both sites. The pages call `https://otnugbbtasbrcjqghvga.supabase.co/functions/v1/tracker-api`.
5. On a phone, for each site: email a code, type it, log today, see history, change nothing about the email unless you mean to, and confirm the hour still saves. Sign out and confirm the history is gone until the next code. A wrong code fails. A sixth wrong code requires a new email.
6. Run `docs/lock-location-anon.sql` in the SQL editor. Then, if it is not already applied, run research-tracker-alerts PR 39's `supabase/lock-anon-access.sql`. Together, anon has no policy and no grant on `location_entries`, `location_entries_wife`, `user_settings_wife`, or `user_settings`.
7. Verify, with the old anon key, that GET and POST to those four tables return a permission error or no rows. Open each tracker again and confirm history still loads. Confirm the next reminder hour still sends, or invoke the reminder function once the same way cron does and confirm it still reads its table.

If step 7 breaks the trackers, run `docs/lock-location-anon-rollback.sql`, fix the deploy, and lock again. That rollback restores the location tables and a three-key stopgap on `user_settings`. It does not restore the research tracker's full anon access. PR 39's own rollback does that, and it also re-opens every `user_settings` key, so don't use it just to undo this file.

`docs/lock-location-anon.sql` will not revoke anon on `user_settings` while `anon_all_user_settings` still exists. That keeps the research tracker working if this SQL is run before PR 39's code and SQL. It still locks the three location tables, so the old location pages stop working at that moment. Deploy the new pages first.

## Tests

`node --test tests/tracker-api.test.mjs` covers the token, the separation between the two people, the rate limit, the settings allowlist, and that the pages no longer contain a key. It does not call Supabase or send mail.
