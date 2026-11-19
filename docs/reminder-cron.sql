-- Point the hourly location-reminder cron jobs at the shared secret.
-- Do not run this until REMINDER_CRON_SECRET is set on the Edge Functions
-- and you have pasted that same value over the placeholder below.
-- Do not commit the filled-in statement. See docs/go-live.md.
--
-- Jobs 5 and 6 are the hourly jobs observed on 2026-11-19. They POST {} to
-- location-reminder and location-reminder-wife. This replaces the command.
-- The schedule stays hourly. The anon key is not sent.
--
-- The old functions ignore an unknown header, so this can run before the new
-- function code is deployed. After the new code is deployed, a call without
-- the header is rejected.

begin;

select cron.alter_job(
  job_id := 5,
  schedule := '0 * * * *',
  command := $cmd$
    select net.http_post(
      url := 'https://otnugbbtasbrcjqghvga.supabase.co/functions/v1/location-reminder',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-reminder-secret', '__REMINDER_CRON_SECRET__'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $cmd$
);

select cron.alter_job(
  job_id := 6,
  schedule := '0 * * * *',
  command := $cmd$
    select net.http_post(
      url := 'https://otnugbbtasbrcjqghvga.supabase.co/functions/v1/location-reminder-wife',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-reminder-secret', '__REMINDER_CRON_SECRET__'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $cmd$
);

commit;
