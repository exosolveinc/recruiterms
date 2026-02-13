-- ============================================================================
-- Migration 013: pg_cron schedule for job feed auto-refresh
-- Calls the fetch-candidate-jobs edge function every 15 minutes
--
-- PREREQUISITE: Store your service role key in the vault first:
--   SELECT vault.create_secret(
--     'eyJhbG...your-service-role-key...',
--     'service_role_key',
--     'Supabase service role key for pg_cron edge function calls'
--   );
-- ============================================================================

-- Enable extensions (idempotent)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove existing schedule if it exists
SELECT cron.unschedule('fetch-candidate-jobs-cron')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'fetch-candidate-jobs-cron'
);

-- Schedule the edge function to run every 15 minutes
SELECT cron.schedule(
  'fetch-candidate-jobs-cron',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://ibzozlezltgokzlfuksg.supabase.co/functions/v1/fetch-candidate-jobs',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
    ),
    body := '{"all": true}'::jsonb
  );
  $$
);
