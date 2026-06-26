-- ============================================================
-- 031_employer_display_name.sql
-- Run manually AFTER 030_whatsapp_worker_skills_seed.sql. Connect as: jale_admin.
--
-- Worker-facing WhatsApp threads (CHATS list, relay context header) showed
-- "Empleador" instead of the real company name. Those queries run as
-- jale_whatsapp, which is deliberately denied SELECT on employer rows in `users`
-- (004 line 290, "Audit Sec #7 fix") and has no grant on `employer_profiles`
-- (only jale_admin does, 016 line 40). `employer_profiles` also has FORCE ROW
-- LEVEL SECURITY with a self-only policy, so even a SECURITY DEFINER function
-- owned by jale_admin cannot read another employer's row without help.
--
-- Fix: a SECURITY DEFINER lookup that returns just the display name, plus a
-- transaction-local-flag-gated SELECT policy on employer_profiles. This mirrors
-- the set_config + gated-policy pattern used by reconcile_worker_signup (027):
-- the flag is only flipped inside the definer function, so employer-to-employer
-- isolation in normal employer (jale_admin) sessions is preserved — the existing
-- employer_profiles_self policy still governs those.
--
-- Not chosen: granting jale_whatsapp SELECT on employer_profiles/users — that
-- reverses the Audit Sec #7 hardening and widens the WhatsApp role's access to
-- employer PII (phone, contact_name). The definer function exposes one TEXT.
-- ============================================================
BEGIN;

-- Gated read policy: rows are visible only while the definer function below has
-- flipped the transaction-local flag. No application path sets this GUC directly,
-- so normal employer sessions still see only their own row via
-- employer_profiles_self (permissive policies are OR'd).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'employer_profiles_name_lookup'
       AND polrelid = 'public.employer_profiles'::regclass
  ) THEN
    CREATE POLICY employer_profiles_name_lookup
      ON employer_profiles FOR SELECT
      TO jale_admin
      USING (current_setting('app.employer_name_lookup', true) = 'on');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION employer_display_name(p_employer_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name TEXT;
BEGIN
  -- Transaction-local; only this definer body sets it. jale_whatsapp has no
  -- table grant on employer_profiles, so the flag is inert outside this function.
  PERFORM set_config('app.employer_name_lookup', 'on', true);
  SELECT NULLIF(ep.company_name, '')
    INTO v_name
    FROM employer_profiles ep
   WHERE ep.user_id = p_employer_id;
  RETURN COALESCE(v_name, 'Empleador');
END;
$$;

REVOKE ALL ON FUNCTION employer_display_name(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION employer_display_name(UUID) TO jale_whatsapp, jale_admin;

COMMIT;
