-- ============================================================
-- 054_remove_onboarding_v2_control.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- WhatsApp onboarding v2 is now hardwired as the only onboarding path --
-- the 'onboarding_v2_enabled' runtime kill switch (seeded in migration
-- 042) has no remaining reader once the code deploy that removes its
-- lambda check ships. 'voice_intake_enabled' (051) and
-- 'deferred_delivery_enabled' (042) are unrelated feature flags and stay
-- exactly as they are.
--
-- Sequencing note: apply this AFTER the code deploy that stops reading
-- onboarding_v2_enabled. An old Lambda that still checked that row would
-- see it disappear and simply find no matching row -- the same "not
-- enabled" outcome as today's disabled-by-default seed -- so even an
-- out-of-order apply degrades safely rather than breaking traffic.
--
-- Data-only, no schema change. Idempotent: DELETE matching zero rows on
-- replay is a no-op, and the self-audit only ever asserts existence/
-- absence, never a mutable value.
-- ============================================================

BEGIN;

DELETE FROM public.whatsapp_runtime_controls WHERE control_key = 'onboarding_v2_enabled';

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.whatsapp_runtime_controls WHERE control_key = 'onboarding_v2_enabled'
  ) THEN
    RAISE EXCEPTION 'migration 054 self-audit failed: onboarding_v2_enabled control row still present';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_runtime_controls WHERE control_key = 'voice_intake_enabled'
  ) THEN
    RAISE EXCEPTION 'migration 054 self-audit failed: voice_intake_enabled control row missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_runtime_controls WHERE control_key = 'deferred_delivery_enabled'
  ) THEN
    RAISE EXCEPTION 'migration 054 self-audit failed: deferred_delivery_enabled control row missing';
  END IF;
END;
$migration$;

COMMIT;
