-- 062_preferred_cities_whatsapp_read.sql
-- Let the WhatsApp processor read a worker's preferred cities so the
-- WhatsApp "jobs" command can apply the same city filter as the web feed.
-- Run AFTER 061_city_keys_and_preferred_cities.sql, connected as jale_admin
-- (NOT the RDS master user).
--
-- 061 granted worker_preferred_cities to jale_admin only, with a policy
-- keyed on app.current_user_id (a cognito_sub). WhatsApp Lambdas run as
-- jale_whatsapp and identify the worker via app.current_internal_user_id
-- (users.id), the same convention as whatsapp_read_ranked_jobs (013).
-- Read-only: preferences are edited on the web profile, never over WhatsApp.
--
-- Forward-only. Applied manually via bastion (ADR-005).

BEGIN;

GRANT SELECT ON worker_preferred_cities TO jale_whatsapp;

CREATE POLICY worker_preferred_cities_whatsapp_read
  ON worker_preferred_cities FOR SELECT TO jale_whatsapp
  USING (user_id::text = current_setting('app.current_internal_user_id', true));

COMMIT;
