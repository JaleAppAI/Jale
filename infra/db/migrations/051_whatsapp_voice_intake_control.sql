-- 051_whatsapp_voice_intake_control.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- WhatsApp v2 voice parity: profile capture is gaining a voice-driven intake
-- path (transcribe the worker's spoken answer instead of typed text). Like
-- onboarding_v2_enabled and deferred_delivery_enabled (migration 042), this
-- new capability needs a runtime kill switch an operator can flip without a
-- deploy, and a per-phone allowlist to canary it before going global.
--
-- This migration seeds one additional control row, 'voice_intake_enabled',
-- into the existing public.whatsapp_runtime_controls table. No schema
-- change: that table's columns (control_key, enabled, phone_hashes,
-- global_enabled, updated_by, updated_at) already fit this control exactly,
-- and phone_hashes already defaults to '{}'::text[]. Fail-closed by default:
-- both enabled and global_enabled seed to false, so voice intake stays off
-- everywhere until an operator explicitly turns it on.

BEGIN;

INSERT INTO public.whatsapp_runtime_controls (control_key, enabled, global_enabled)
VALUES ('voice_intake_enabled', false, false)
ON CONFLICT (control_key) DO NOTHING;

-- Only asserts the row exists. It is inserted with ON CONFLICT DO NOTHING,
-- so replaying this migration after an operator has already flipped
-- enabled/global_enabled/phone_hashes must not raise -- only a genuinely
-- missing row is a self-audit failure.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_runtime_controls
     WHERE control_key = 'voice_intake_enabled'
  ) THEN
    RAISE EXCEPTION 'migration 051 voice_intake_enabled control row self-audit failed';
  END IF;
END;
$migration$;

COMMIT;
