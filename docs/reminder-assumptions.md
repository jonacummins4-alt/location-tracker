# Location reminder reconstruction

`location-reminder` and `location-reminder-wife` are deployed with JWT verification off. Their source is not in git, and the connector could not download it. The copies in `supabase/functions/location-reminder` and `supabase/functions/location-reminder-wife` are a conservative replacement. Compare them with the dashboard source before deploying.

The deployed functions read with the publishable anon key. After `docs/lock-location-anon.sql`, that read stops working, so the replacement uses `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEYS` `default` when the legacy key is empty). The incoming `Authorization` header is not used for the database.

## Observed

- `pg_cron` jobs 5 and 6 run hourly and POST `{}` at the two functions.
- Outside the send hour the body is `{skipped:true, now:<hour>, hr:<send hour>}`.
- `hr` comes from `location_email_hour` on `user_settings` for Jon and `user_settings_wife` for Amy.
- During the send hour the function reads that person's entries and emails `email_address` through Resend.

## Assumptions

1. The hour is in `America/New_York`. Set the function secret `REMINDER_TIMEZONE` to `UTC` (or another IANA name) if the dashboard copy uses a different zone. `now` in the skip body is that zone's hour, 0 through 23.
2. A missing or invalid `location_email_hour` is treated as 8, the same fallback the page uses when it loads settings.
3. Hour 0 stays midnight. The page's `parseInt(value) || 8` still displays 0 as 8. The function does not.
4. A wrong hour returns only `{skipped:true, now, hr}`. No extra fields.
5. A matching hour sends one email per invocation. No "already sent today" flag was observed, so none was added. The cron fires once in that hour.
6. The message subject is "Log your location". The body says whether that local date is already logged, and links to the production page with `?date=YYYY-MM-DD`, which the page already pre-fills. The full history is not included. The message does not contain a sign-in code.
7. The From address is `Location Tracker <alerts@updates.joncummins.com>`, the known-good Resend sender for `RESEND_API_KEY`. The same address is used for sign-in codes.
8. A missing address, or the placeholder `your@email.com`, skips the send and adds `reason: "no-email"`. Resend is not called.
9. `OPTIONS` without the secret returns 204, so a health probe that only sends `OPTIONS` still gets a response and cannot send mail. `POST` without header `x-reminder-secret` matching `REMINDER_CRON_SECRET` returns 401.
10. Jon's link is `https://location-tracker-sand-six.vercel.app` and Amy's is `https://location-tracker-wife.vercel.app`.
