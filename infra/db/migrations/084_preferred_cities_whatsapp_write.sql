-- 084_preferred_cities_whatsapp_write.sql
--
-- WhatsApp onboarding seeds a worker's first preferred city from the
-- location they give during onboarding (typed or voice). 066 granted
-- jale_whatsapp SELECT only; this adds INSERT with the same
-- app.current_internal_user_id-keyed self-policy. No UPDATE/DELETE:
-- onboarding only ever adds the single seed row (ON CONFLICT DO NOTHING);
-- curation stays in the web app.
--
-- Forward-only. Applied manually via bastion (ADR-005), connected as
-- jale_admin (NOT the RDS master user) -- same convention as 066.

BEGIN;

GRANT INSERT ON worker_preferred_cities TO jale_whatsapp;

CREATE POLICY worker_preferred_cities_whatsapp_insert
  ON worker_preferred_cities FOR INSERT TO jale_whatsapp
  WITH CHECK (user_id::text = current_setting('app.current_internal_user_id', true));

COMMIT;
