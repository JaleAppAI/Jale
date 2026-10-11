-- ============================================================
-- 108_problem_reports_functions.sql
-- Run manually AFTER 107_problem_reports_schema.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Sprint 27, report a problem, part 2 of 2: the jale_cap functions, the only
-- way to read or write a report. No runtime login holds any right on the
-- report tables; each function's owner (107) holds exactly what its
-- functions need.
--
--   intake, owner jale_cap_problem_reports
--     problem_report_config              jale_api_public_reports
--     problem_report_create_verified     jale_api
--     problem_report_create_unverified   jale_api_public_reports
--     problem_report_upload_grant        jale_api, jale_api_public_reports
--     problem_report_pending_upload      jale_api, jale_api_public_reports
--     problem_report_attach              jale_api, jale_api_public_reports
--     problem_report_enqueue_team_email  nobody (called by the two creates)
--   admin console, owner jale_cap_problem_reports_admin
--     problem_report_inbox, _counts, _detail, _reveal_contact, _image,
--     _set_status, _set_note, _settings_get, _settings_set
--                                        jale_admin_console
--     problem_report_mask_email          nobody (called by _detail)
--   clean-up, owner jale_cap_report_cleanup
--     problem_report_cleanup             jale_job_report_cleanup
--
-- Every function follows the 061/062/082/105 pattern: SECURITY DEFINER with
-- `search_path = pg_catalog, pg_temp`, every object schema-qualified, EXECUTE
-- revoked from PUBLIC and granted to its caller logins only. Each function
-- scopes to its caller in SQL: the verified create reads the caller from
-- app.current_user_id, the upload functions require the report's attach
-- token hash, and the console functions are reachable by the console login
-- only. Refusals are outcome codes; exceptions are reserved for programming
-- errors (22023, a malformed argument; 42501, an unset caller context).
--
-- What the functions do:
--   creates   check the pause switches; the same report sent again (the
--             same client_key) replays it, while a key held by anyone else
--             is refused; the category must belong to the role; then the
--             limits: per account when signed in, per address and a daily
--             total when signed out. A lost insert race replays or refuses,
--             never a unique violation. The team email is queued in the same
--             transaction: email_queued is true when a row was queued, false
--             when the team email is on but has no recipient or dashboard
--             address yet, and NULL when it is switched off.
--   uploads   the attach token hash must match, and an unknown report
--             answers the same as a wrong token; one image per report; an
--             upload is issued within 30 minutes of the report, attached
--             within 15 minutes of its issue, and copied to its own final
--             key images/<report>/<upload>.<ext>. The token stays after the
--             attach: a retry with it is answered already_attached, and an
--             attach of any other upload is answered upload_expired.
--   console   reads and changes reports only while one of its own calls
--             runs; contact is masked here, and only reveal_contact returns
--             it raw. reveal_contact and image also name the account the
--             report came from, for the caller's access record.
--   clean-up  in order, each part bounded by p_batch: images past 90 days,
--             uploads never attached, content past 12 months, sent report
--             mail, old rate-limit buckets. It returns the object keys to
--             delete and reads no content.
-- A signed-out report never touches an account: the typed contact is
-- stored exactly as typed and never matched.
--
-- OWNERSHIP TRANSFER. ALTER FUNCTION ... OWNER TO requires that jale_admin
-- can SET ROLE to the new owner. 082's sequence, transcribed: grant SET to
-- the migration login, transfer, then turn SET off and revoke the
-- self-granted row, leaving only the creator's ADMIN-only membership. The
-- self-audit proves no role keeps SET or INHERIT on any owner.
--
-- DEPLOY ORDER: apply after 107 and BEFORE the release deploy. The deployed
-- code never calls these functions, so it keeps working unchanged.
--
-- REPLAY. Refused with a clear message once the report functions exist.
-- ============================================================
BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF pg_catalog.to_regclass('public.problem_reports') IS NULL
     OR pg_catalog.to_regclass('public.problem_report_contents') IS NULL
     OR pg_catalog.to_regclass('public.problem_report_rate_buckets') IS NULL
     OR pg_catalog.to_regclass('public.problem_report_settings') IS NULL
     OR (SELECT count(*) FROM pg_catalog.pg_roles
          WHERE rolname IN ('jale_cap_problem_reports', 'jale_cap_problem_reports_admin', 'jale_cap_report_cleanup',
                            'jale_api_public_reports', 'jale_job_report_cleanup',
                            'jale_api', 'jale_admin_console')) <> 7 THEN
    RAISE EXCEPTION 'migration 108: apply 107 first (the report tables, owners or logins are missing)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = pg_catalog.to_regnamespace('jale_cap')
       AND p.proname LIKE 'problem\_report\_%'
  ) THEN
    RAISE EXCEPTION 'migration 108: already applied (the report functions exist); it is not re-runnable';
  END IF;
END;
$$;

-- ── Intake: owner jale_cap_problem_reports ──────────────────
CREATE FUNCTION jale_cap.problem_report_config()
RETURNS TABLE (reporting BOOLEAN, signed_out BOOLEAN, screenshots BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- A pause of the whole feature also pauses the signed-out form and
  -- screenshots, so the form never offers what a create would refuse.
  RETURN QUERY
    SELECT COALESCE(bool_and(s.reporting_enabled), false),
           COALESCE(bool_and(s.reporting_enabled AND s.signed_out_enabled), false),
           COALESCE(bool_and(s.reporting_enabled AND s.screenshots_enabled), false)
      FROM public.problem_report_settings s
     WHERE s.id;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_config() TO jale_api_public_reports;

CREATE FUNCTION jale_cap.problem_report_create_verified(
  p_client_key        UUID,
  p_role_hint         TEXT,
  p_category          TEXT,
  p_description       TEXT,
  p_stops_work        BOOLEAN,
  p_locale            TEXT,
  p_include_technical BOOLEAN,
  p_context           JSONB,
  p_attach_token_hash TEXT
)
RETURNS TABLE (outcome TEXT, report_id UUID, report_number BIGINT, replayed BOOLEAN, email_queued BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_sub       TEXT := pg_catalog.current_setting('app.current_user_id', true);
  v_reporting BOOLEAN;
  v_user_id   UUID;
  v_role      TEXT;
  v_found_id  UUID;
  v_found_num BIGINT;
  v_found_ver BOOLEAN;
  v_found_uid UUID;
  v_found_sub TEXT;
  v_recent    BIGINT;
  v_id        UUID;
  v_number    BIGINT;
  v_created   TIMESTAMPTZ;
  v_queued    BOOLEAN;
BEGIN
  -- The caller is the verified sign-in the request path sets for this
  -- transaction; nothing in the arguments names the reporter.
  IF v_sub IS NULL OR v_sub = '' THEN
    RAISE EXCEPTION 'problem_report_create_verified: no caller is set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_client_key IS NULL
     OR p_role_hint IS NULL OR p_role_hint NOT IN ('worker', 'employer', 'unknown')
     OR p_description IS NULL OR pg_catalog.char_length(p_description) NOT BETWEEN 1 AND 2000
     OR p_locale IS NULL OR p_locale NOT IN ('es', 'en')
     OR p_include_technical IS NULL
     OR p_context IS NULL OR pg_catalog.jsonb_typeof(p_context) <> 'object'
     OR pg_catalog.pg_column_size(p_context) > 32768
     OR p_attach_token_hash IS NULL OR p_attach_token_hash !~ '^[0-9a-f]{64}$'
     OR pg_catalog.char_length(v_sub) > 255 THEN
    RAISE EXCEPTION 'problem_report_create_verified: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT s.reporting_enabled INTO v_reporting FROM public.problem_report_settings s WHERE s.id;
  IF NOT COALESCE(v_reporting, false) THEN
    RETURN QUERY SELECT 'reporting_paused'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
    RETURN;
  END IF;

  -- The role comes from the account when it exists, else from the sign-in.
  SELECT u.id, u.user_type INTO v_user_id, v_role FROM public.users u WHERE u.cognito_sub = v_sub;
  IF v_user_id IS NULL THEN
    v_role := p_role_hint;
  END IF;

  -- The same report sent again: the same caller replays it (and spends no
  -- limit), anyone else is refused.
  SELECT h.id, h.report_number, h.verified, c.reporter_user_id, c.reporter_sub
    INTO v_found_id, v_found_num, v_found_ver, v_found_uid, v_found_sub
    FROM public.problem_reports h
    LEFT JOIN public.problem_report_contents c ON c.report_id = h.id
   WHERE h.client_key = p_client_key;
  IF v_found_id IS NOT NULL THEN
    IF v_found_ver AND (v_found_uid = v_user_id OR v_found_sub = v_sub) THEN
      UPDATE public.problem_report_contents c SET attach_token_hash = p_attach_token_hash WHERE c.report_id = v_found_id;
      RETURN QUERY SELECT 'ok'::text, v_found_id, v_found_num, true, NULL::boolean;
    ELSE
      RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
    END IF;
    RETURN;
  END IF;

  -- The sign-in could not name its pool and no account exists: nothing
  -- decides the role, so nothing is written and no limit is spent.
  IF v_user_id IS NULL AND p_role_hint = 'unknown' THEN
    RETURN QUERY SELECT 'role_unknown'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
    RETURN;
  END IF;

  IF p_category IS NULL OR NOT (
       (v_role = 'worker'
         AND p_category IN ('sign_in', 'finding_jobs', 'applying', 'uploads', 'profile', 'whatsapp', 'other'))
       OR (v_role = 'employer'
         AND p_category IN ('account', 'job_posting', 'applicants', 'messages', 'billing', 'emails',
                            'company_profile', 'other'))) THEN
    RETURN QUERY SELECT 'invalid_category'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
    RETURN;
  END IF;

  -- The account limit, counted under a lock per sign-in so two sends
  -- cannot both take the last place.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('problem_report:account:' || v_sub, 0));
  SELECT pg_catalog.count(*) INTO v_recent
    FROM public.problem_report_contents c
   WHERE c.created_at > pg_catalog.now() - interval '24 hours'
     AND (c.reporter_sub = v_sub OR c.reporter_user_id = v_user_id);
  IF v_recent >= 20 THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
    RETURN;
  END IF;

  -- A unique violation never reaches the caller: when another send with
  -- this key committed first, look it up again and replay or refuse.
  FOR v_attempt IN 1..2 LOOP
    INSERT INTO public.problem_reports AS h
      (client_key, role, verified, category, stops_work, locale, include_technical)
    VALUES (p_client_key, v_role, true, p_category,
            CASE WHEN v_role = 'employer' THEN p_stops_work END, p_locale, p_include_technical)
    ON CONFLICT (client_key) DO NOTHING
    RETURNING h.id, h.report_number, h.created_at INTO v_id, v_number, v_created;
    EXIT WHEN v_id IS NOT NULL;

    SELECT h.id, h.report_number, h.verified, c.reporter_user_id, c.reporter_sub
      INTO v_found_id, v_found_num, v_found_ver, v_found_uid, v_found_sub
      FROM public.problem_reports h
      LEFT JOIN public.problem_report_contents c ON c.report_id = h.id
     WHERE h.client_key = p_client_key;
    IF v_found_id IS NOT NULL THEN
      IF v_found_ver AND (v_found_uid = v_user_id OR v_found_sub = v_sub) THEN
        UPDATE public.problem_report_contents c SET attach_token_hash = p_attach_token_hash WHERE c.report_id = v_found_id;
        RETURN QUERY SELECT 'ok'::text, v_found_id, v_found_num, true, NULL::boolean;
      ELSE
        RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
      END IF;
      RETURN;
    END IF;
  END LOOP;
  IF v_id IS NULL THEN
    RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
    RETURN;
  END IF;

  INSERT INTO public.problem_report_contents
    (report_id, created_at, reporter_user_id, reporter_sub, description, context, attach_token_hash)
  VALUES (v_id, v_created, v_user_id, CASE WHEN v_user_id IS NULL THEN v_sub END,
          p_description, p_context, p_attach_token_hash);
  v_queued := jale_cap.problem_report_enqueue_team_email(v_id);
  RETURN QUERY SELECT 'ok'::text, v_id, v_number, false, v_queued;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_create_verified(uuid, text, text, text, boolean, text, boolean, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_create_verified(uuid, text, text, text, boolean, text, boolean, jsonb, text) TO jale_api;

CREATE FUNCTION jale_cap.problem_report_create_unverified(
  p_client_key        UUID,
  p_role_claimed      TEXT,
  p_category          TEXT,
  p_description       TEXT,
  p_stops_work        BOOLEAN,
  p_locale            TEXT,
  p_contact           TEXT,
  p_include_technical BOOLEAN,
  p_context           JSONB,
  p_attach_token_hash TEXT,
  p_address_hash      TEXT
)
RETURNS TABLE (outcome TEXT, report_id UUID, report_number BIGINT, replayed BOOLEAN, email_queued BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_reporting  BOOLEAN;
  v_signed_out BOOLEAN;
  v_cap        INTEGER;
  v_found_id   UUID;
  v_found_num  BIGINT;
  v_found_ver  BOOLEAN;
  v_hour       INTEGER;
  v_day        INTEGER;
  v_today      BIGINT;
  v_id         UUID;
  v_number     BIGINT;
  v_created    TIMESTAMPTZ;
  v_queued     BOOLEAN;
BEGIN
  IF p_client_key IS NULL
     OR p_role_claimed IS NULL OR p_role_claimed NOT IN ('worker', 'employer', 'unknown')
     OR p_description IS NULL OR pg_catalog.char_length(p_description) NOT BETWEEN 1 AND 2000
     OR p_locale IS NULL OR p_locale NOT IN ('es', 'en')
     OR pg_catalog.char_length(p_contact) > 200
     OR p_include_technical IS NULL
     OR p_context IS NULL OR pg_catalog.jsonb_typeof(p_context) <> 'object'
     OR pg_catalog.pg_column_size(p_context) > 32768
     OR p_attach_token_hash IS NULL OR p_attach_token_hash !~ '^[0-9a-f]{64}$'
     OR p_address_hash IS NULL OR p_address_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'problem_report_create_unverified: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT s.reporting_enabled, s.signed_out_enabled, s.signed_out_daily_cap
    INTO v_reporting, v_signed_out, v_cap
    FROM public.problem_report_settings s
   WHERE s.id;
  IF NOT COALESCE(v_reporting, false) THEN
    RETURN QUERY SELECT 'reporting_paused'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
    RETURN;
  END IF;
  IF NOT COALESCE(v_signed_out, false) THEN
    RETURN QUERY SELECT 'signed_out_paused'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
    RETURN;
  END IF;

  -- The same report sent again replays, and spends no limit. A key held by
  -- a signed-in report is refused.
  SELECT h.id, h.report_number, h.verified INTO v_found_id, v_found_num, v_found_ver
    FROM public.problem_reports h
   WHERE h.client_key = p_client_key;
  IF v_found_id IS NOT NULL THEN
    IF NOT v_found_ver THEN
      UPDATE public.problem_report_contents c SET attach_token_hash = p_attach_token_hash WHERE c.report_id = v_found_id;
      RETURN QUERY SELECT 'ok'::text, v_found_id, v_found_num, true, NULL::boolean;
    ELSE
      RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
    END IF;
    RETURN;
  END IF;

  -- A page that implies no role reports from the worker list.
  IF p_category IS NULL OR NOT (
       (p_role_claimed IN ('worker', 'unknown')
         AND p_category IN ('sign_in', 'finding_jobs', 'applying', 'uploads', 'profile', 'whatsapp', 'other'))
       OR (p_role_claimed = 'employer'
         AND p_category IN ('account', 'job_posting', 'applicants', 'messages', 'billing', 'emails',
                            'company_profile', 'other'))) THEN
    RETURN QUERY SELECT 'invalid_category'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
    RETURN;
  END IF;

  -- Per-address limits, counted atomically; an attempt over a limit counts
  -- too.
  INSERT INTO public.problem_report_rate_buckets AS b (address_hash, window_kind, bucket_start, request_count)
  VALUES (p_address_hash, 'hour', pg_catalog.date_trunc('hour', pg_catalog.now(), 'UTC'), 1)
  ON CONFLICT (address_hash, window_kind, bucket_start) DO UPDATE SET request_count = b.request_count + 1
  RETURNING b.request_count INTO v_hour;
  INSERT INTO public.problem_report_rate_buckets AS b (address_hash, window_kind, bucket_start, request_count)
  VALUES (p_address_hash, 'day', pg_catalog.date_trunc('day', pg_catalog.now(), 'UTC'), 1)
  ON CONFLICT (address_hash, window_kind, bucket_start) DO UPDATE SET request_count = b.request_count + 1
  RETURNING b.request_count INTO v_day;
  IF v_hour > 5 OR v_day > 20 THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
    RETURN;
  END IF;

  -- The daily total of signed-out reports since 00:00 UTC, counted under
  -- one lock so two sends cannot both take the last place.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('problem_report:signed_out_daily', 0));
  SELECT pg_catalog.count(*) INTO v_today
    FROM public.problem_reports h
   WHERE NOT h.verified
     AND h.created_at >= pg_catalog.date_trunc('day', pg_catalog.now(), 'UTC');
  IF v_today >= COALESCE(v_cap, 0) THEN
    RETURN QUERY SELECT 'rate_limited_global'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
    RETURN;
  END IF;

  FOR v_attempt IN 1..2 LOOP
    INSERT INTO public.problem_reports AS h
      (client_key, role, verified, category, stops_work, locale, include_technical)
    VALUES (p_client_key, p_role_claimed, false, p_category,
            CASE WHEN p_role_claimed = 'employer' THEN p_stops_work END, p_locale, p_include_technical)
    ON CONFLICT (client_key) DO NOTHING
    RETURNING h.id, h.report_number, h.created_at INTO v_id, v_number, v_created;
    EXIT WHEN v_id IS NOT NULL;

    SELECT h.id, h.report_number, h.verified INTO v_found_id, v_found_num, v_found_ver
      FROM public.problem_reports h
     WHERE h.client_key = p_client_key;
    IF v_found_id IS NOT NULL THEN
      IF NOT v_found_ver THEN
        UPDATE public.problem_report_contents c SET attach_token_hash = p_attach_token_hash WHERE c.report_id = v_found_id;
        RETURN QUERY SELECT 'ok'::text, v_found_id, v_found_num, true, NULL::boolean;
      ELSE
        RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
      END IF;
      RETURN;
    END IF;
  END LOOP;
  IF v_id IS NULL THEN
    RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::bigint, false, NULL::boolean;
    RETURN;
  END IF;

  -- The contact is kept exactly as typed, and never matched to an account.
  INSERT INTO public.problem_report_contents
    (report_id, created_at, description, typed_contact, context, attach_token_hash)
  VALUES (v_id, v_created, p_description,
          CASE WHEN p_contact ~ '[^[:space:]]' THEN p_contact END,
          p_context, p_attach_token_hash);
  v_queued := jale_cap.problem_report_enqueue_team_email(v_id);
  RETURN QUERY SELECT 'ok'::text, v_id, v_number, false, v_queued;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_create_unverified(uuid, text, text, text, boolean, text, text, boolean, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_create_unverified(uuid, text, text, text, boolean, text, text, boolean, jsonb, text, text) TO jale_api_public_reports;

CREATE FUNCTION jale_cap.problem_report_upload_grant(
  p_report_id         UUID,
  p_attach_token_hash TEXT,
  p_content_type      TEXT
)
RETURNS TABLE (outcome TEXT, upload_key TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_token     TEXT;
  v_image     TEXT;
  v_created   TIMESTAMPTZ;
  v_reporting BOOLEAN;
  v_screens   BOOLEAN;
  v_key       TEXT;
BEGIN
  IF p_report_id IS NULL OR p_attach_token_hash IS NULL OR p_attach_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'problem_report_upload_grant: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT c.attach_token_hash, c.image_key, c.created_at INTO v_token, v_image, v_created
    FROM public.problem_report_contents c
   WHERE c.report_id = p_report_id
     FOR UPDATE;
  -- An unknown report and a wrong token answer the same.
  IF NOT FOUND OR v_token IS DISTINCT FROM p_attach_token_hash THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;
  IF v_image IS NOT NULL THEN
    RETURN QUERY SELECT 'already_attached'::text, NULL::text;
    RETURN;
  END IF;
  IF v_created < pg_catalog.now() - interval '30 minutes' THEN
    RETURN QUERY SELECT 'upload_expired'::text, NULL::text;
    RETURN;
  END IF;
  SELECT s.reporting_enabled, s.screenshots_enabled INTO v_reporting, v_screens
    FROM public.problem_report_settings s WHERE s.id;
  IF NOT COALESCE(v_reporting AND v_screens, false) THEN
    RETURN QUERY SELECT 'screenshots_paused'::text, NULL::text;
    RETURN;
  END IF;
  IF p_content_type IS NULL OR p_content_type NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RETURN QUERY SELECT 'invalid_type'::text, NULL::text;
    RETURN;
  END IF;

  -- The key is generated here, so the caller never chooses it. A re-issue
  -- replaces the pending upload.
  v_key := 'incoming/' || pg_catalog.gen_random_uuid()::text;
  UPDATE public.problem_report_contents c
     SET pending_upload_key = v_key, pending_content_type = p_content_type, upload_issued_at = pg_catalog.now()
   WHERE c.report_id = p_report_id;
  RETURN QUERY SELECT 'ok'::text, v_key;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_upload_grant(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_upload_grant(uuid, text, text) TO jale_api;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_upload_grant(uuid, text, text) TO jale_api_public_reports;

CREATE FUNCTION jale_cap.problem_report_pending_upload(
  p_report_id         UUID,
  p_attach_token_hash TEXT
)
RETURNS TABLE (outcome TEXT, pending_key TEXT, content_type TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_token     TEXT;
  v_image     TEXT;
  v_pending   TEXT;
  v_type      TEXT;
  v_issued    TIMESTAMPTZ;
  v_reporting BOOLEAN;
  v_screens   BOOLEAN;
BEGIN
  IF p_report_id IS NULL OR p_attach_token_hash IS NULL OR p_attach_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'problem_report_pending_upload: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT c.attach_token_hash, c.image_key, c.pending_upload_key, c.pending_content_type, c.upload_issued_at
    INTO v_token, v_image, v_pending, v_type, v_issued
    FROM public.problem_report_contents c
   WHERE c.report_id = p_report_id;
  IF NOT FOUND OR v_token IS DISTINCT FROM p_attach_token_hash THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF v_image IS NOT NULL THEN
    RETURN QUERY SELECT 'already_attached'::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF v_pending IS NULL OR v_issued < pg_catalog.now() - interval '15 minutes' THEN
    RETURN QUERY SELECT 'upload_expired'::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  SELECT s.reporting_enabled, s.screenshots_enabled INTO v_reporting, v_screens
    FROM public.problem_report_settings s WHERE s.id;
  IF NOT COALESCE(v_reporting AND v_screens, false) THEN
    RETURN QUERY SELECT 'screenshots_paused'::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::text, v_pending, v_type;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_pending_upload(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_pending_upload(uuid, text) TO jale_api;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_pending_upload(uuid, text) TO jale_api_public_reports;

CREATE FUNCTION jale_cap.problem_report_attach(
  p_report_id         UUID,
  p_attach_token_hash TEXT,
  p_pending_key       TEXT,
  p_final_key         TEXT,
  p_content_type      TEXT,
  p_byte_size         INTEGER
)
RETURNS TABLE (outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_token     TEXT;
  v_image     TEXT;
  v_pending   TEXT;
  v_type      TEXT;
  v_issued    TIMESTAMPTZ;
  v_reporting BOOLEAN;
  v_screens   BOOLEAN;
  v_final     TEXT;
BEGIN
  IF p_report_id IS NULL OR p_attach_token_hash IS NULL OR p_attach_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'problem_report_attach: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT c.attach_token_hash, c.image_key, c.pending_upload_key, c.pending_content_type, c.upload_issued_at
    INTO v_token, v_image, v_pending, v_type, v_issued
    FROM public.problem_report_contents c
   WHERE c.report_id = p_report_id
     FOR UPDATE;
  -- An unknown report and a wrong token answer the same.
  IF NOT FOUND OR v_token IS DISTINCT FROM p_attach_token_hash THEN
    RETURN QUERY SELECT 'not_found'::text;
    RETURN;
  END IF;
  -- One image per report. The token stays after the attach: a retry of the
  -- attach that succeeded names the attached image itself and is told so;
  -- any other upload is stale, so its copy can be removed.
  IF v_image IS NOT NULL THEN
    IF p_final_key = v_image THEN
      RETURN QUERY SELECT 'already_attached'::text;
    ELSE
      RETURN QUERY SELECT 'upload_expired'::text;
    END IF;
    RETURN;
  END IF;
  -- Everything the pre-check checked, again.
  IF v_pending IS NULL OR p_pending_key IS DISTINCT FROM v_pending
     OR v_issued < pg_catalog.now() - interval '15 minutes' THEN
    RETURN QUERY SELECT 'upload_expired'::text;
    RETURN;
  END IF;
  SELECT s.reporting_enabled, s.screenshots_enabled INTO v_reporting, v_screens
    FROM public.problem_report_settings s WHERE s.id;
  IF NOT COALESCE(v_reporting AND v_screens, false) THEN
    RETURN QUERY SELECT 'screenshots_paused'::text;
    RETURN;
  END IF;

  -- Each upload has its own final key, images/<report>/<upload>.<ext>, and
  -- every attempt of that upload names it; a refusal never names another
  -- upload's image.
  v_final := 'images/' || p_report_id::text || '/' || pg_catalog.substr(v_pending, 10) || '.'
             || CASE v_type WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' ELSE 'webp' END;
  IF p_content_type IS DISTINCT FROM v_type OR p_final_key IS DISTINCT FROM v_final
     OR p_byte_size IS NULL OR p_byte_size NOT BETWEEN 1 AND 5242880 THEN
    RETURN QUERY SELECT 'invalid_image'::text;
    RETURN;
  END IF;

  UPDATE public.problem_report_contents c
     SET image_key = v_final, pending_upload_key = NULL, pending_content_type = NULL, upload_issued_at = NULL
   WHERE c.report_id = p_report_id;
  UPDATE public.problem_reports h SET has_image = true, updated_at = pg_catalog.now() WHERE h.id = p_report_id;
  RETURN QUERY SELECT 'ok'::text;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_attach(uuid, text, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_attach(uuid, text, text, text, text, integer) TO jale_api;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_attach(uuid, text, text, text, text, integer) TO jale_api_public_reports;

CREATE FUNCTION jale_cap.problem_report_enqueue_team_email(
  p_report_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_enabled   BOOLEAN;
  v_recipient TEXT;
  v_base      TEXT;
  v_number    BIGINT;
  v_category  TEXT;
  v_values    TEXT[];
  v_html      TEXT[] := ARRAY[]::text[];
  v_rows      INTEGER;
BEGIN
  SELECT s.team_email_enabled, s.team_recipient, s.admin_base_url INTO v_enabled, v_recipient, v_base
    FROM public.problem_report_settings s WHERE s.id;
  -- Switched off on purpose: nothing to queue and nothing to report.
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NULL;
  END IF;
  -- Switched on, but no recipient or dashboard address is set yet.
  IF v_recipient IS NULL OR v_base IS NULL THEN
    RETURN false;
  END IF;
  SELECT h.report_number, h.category INTO v_number, v_category FROM public.problem_reports h WHERE h.id = p_report_id;
  IF v_number IS NULL THEN
    RETURN false;
  END IF;

  -- [1] the number, [2] the English category label, [3] the dashboard link.
  -- No words, contact, role details or image ever enter the email.
  v_values := ARRAY[
    'JR-' || v_number::text,
    CASE v_category
      WHEN 'sign_in' THEN 'I can''t sign in / the code didn''t arrive'
      WHEN 'finding_jobs' THEN 'Finding jobs'
      WHEN 'applying' THEN 'Applying to a job'
      WHEN 'uploads' THEN 'Uploading documents or photos'
      WHEN 'profile' THEN 'My profile'
      WHEN 'whatsapp' THEN 'WhatsApp messages'
      WHEN 'account' THEN 'Sign-in, account or verification email'
      WHEN 'job_posting' THEN 'Posting or editing a job'
      WHEN 'applicants' THEN 'Applicants and hiring'
      WHEN 'messages' THEN 'Messages to workers'
      WHEN 'billing' THEN 'Billing and plan'
      WHEN 'emails' THEN 'Emails and daily summary'
      WHEN 'company_profile' THEN 'Company profile and settings'
      ELSE 'Something else'
    END,
    v_base || '/reports/' || p_report_id::text
  ];
  FOR i IN 1..3 LOOP
    v_html[i] := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
                   v_values[i], '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;');
  END LOOP;

  INSERT INTO public.email_outbox
    (recipient_email, subject, body_text, body_html, source_type, source_id, idempotency_key)
  VALUES (
    v_recipient,
    pg_catalog.format('New report %s %s %s', v_values[1], pg_catalog.chr(183), v_values[2]),
    pg_catalog.format(
      E'jale.\n\nA new problem report is waiting in the dashboard.\n\nReport: %s\nCategory: %s\n\n'
      || E'Open in the dashboard: %s\n\n'
      || E'This email has no personal details. Sign in to the dashboard to read the report.\n',
      v_values[1], v_values[2], v_values[3]),
    pg_catalog.format(
      '<!doctype html><html lang="en"><body style="margin:0;padding:24px;background-color:#ffffff;'
      || 'color:#1a1a1a;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;">'
      || '<p style="margin:0 0 20px;font-size:24px;font-weight:700;">jale.</p>'
      || '<p style="margin:0 0 20px;">A new problem report is waiting in the dashboard.</p>'
      || '<table role="presentation" style="border-collapse:collapse;margin:0 0 20px;">'
      || '<tr><td style="padding:4px 24px 4px 0;color:#666666;">Report</td><td style="padding:4px 0;">%s</td></tr>'
      || '<tr><td style="padding:4px 24px 4px 0;color:#666666;">Category</td><td style="padding:4px 0;">%s</td></tr>'
      || '</table>'
      || '<p style="margin:0 0 24px;"><a href="%s" style="display:inline-block;padding:10px 18px;'
      || 'background-color:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;">Open in the dashboard</a></p>'
      || '<p style="margin:0;color:#666666;font-size:13px;">This email has no personal details. '
      || 'Sign in to the dashboard to read the report.</p></body></html>',
      v_html[1], v_html[2], v_html[3]),
    'problem_report',
    p_report_id,
    'problem-report:' || p_report_id::text)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_enqueue_team_email(uuid) FROM PUBLIC;

-- ── Admin console: owner jale_cap_problem_reports_admin ─────
CREATE FUNCTION jale_cap.problem_report_inbox(
  p_status   TEXT,
  p_role     TEXT,
  p_category TEXT,
  p_verified BOOLEAN,
  p_number   BIGINT,
  p_limit    INTEGER,
  p_before   TIMESTAMPTZ
)
RETURNS TABLE (
  report_id      UUID,
  report_number  BIGINT,
  role           TEXT,
  verified       BOOLEAN,
  category       TEXT,
  stops_work     BOOLEAN,
  status         TEXT,
  has_image      BOOLEAN,
  created_at     TIMESTAMPTZ,
  content_erased BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_limit INTEGER;
BEGIN
  IF p_limit IS NOT NULL AND p_limit < 1 THEN
    RAISE EXCEPTION 'problem_report_inbox: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_limit := LEAST(COALESCE(p_limit, 50), 200);

  -- Headers only: no words and no contact. A missing contents row means the
  -- content was erased, at 12 months or with the account.
  PERFORM pg_catalog.set_config('app.problem_report_console', 'on', true);
  RETURN QUERY
    SELECT h.id, h.report_number, h.role, h.verified, h.category, h.stops_work, h.status, h.has_image, h.created_at,
           NOT EXISTS (SELECT 1 FROM public.problem_report_contents c WHERE c.report_id = h.id)
      FROM public.problem_reports h
     WHERE (p_status IS NULL OR h.status = p_status)
       AND (p_role IS NULL OR h.role = p_role)
       AND (p_category IS NULL OR h.category = p_category)
       AND (p_verified IS NULL OR h.verified = p_verified)
       AND (p_number IS NULL OR h.report_number = p_number)
       AND (p_before IS NULL OR h.created_at < p_before)
     ORDER BY h.created_at DESC, h.id DESC
     LIMIT v_limit;
  PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_inbox(text, text, text, boolean, bigint, integer, timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_inbox(text, text, text, boolean, bigint, integer, timestamp with time zone) TO jale_admin_console;

CREATE FUNCTION jale_cap.problem_report_counts()
RETURNS TABLE (new_count INTEGER, open_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  PERFORM pg_catalog.set_config('app.problem_report_console', 'on', true);
  RETURN QUERY
    SELECT (pg_catalog.count(*) FILTER (WHERE h.status = 'new'))::integer,
           (pg_catalog.count(*) FILTER (WHERE h.status IN ('new', 'looking')))::integer
      FROM public.problem_reports h;
  PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_counts() TO jale_admin_console;

CREATE FUNCTION jale_cap.problem_report_detail(
  p_report_id UUID
)
RETURNS TABLE (
  report_id         UUID,
  report_number     BIGINT,
  role              TEXT,
  verified          BOOLEAN,
  category          TEXT,
  stops_work        BOOLEAN,
  locale            TEXT,
  include_technical BOOLEAN,
  status            TEXT,
  has_image         BOOLEAN,
  created_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ,
  content_erased    BOOLEAN,
  description       TEXT,
  context           JSONB,
  internal_note     TEXT,
  contact_kind      TEXT,
  contact_masked    TEXT,
  account_user_id   UUID,
  account_exists    BOOLEAN,
  image_available   BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_h       public.problem_reports%ROWTYPE;
  v_has_c   BOOLEAN;
  v_desc    TEXT;
  v_ctx     JSONB;
  v_note    TEXT;
  v_uid     UUID;
  v_sub     TEXT;
  v_typed   TEXT;
  v_image   TEXT;
  v_kind    TEXT := 'none';
  v_raw     TEXT;
  v_masked  TEXT;
  v_account UUID;
  v_exists  BOOLEAN := false;
  v_type    TEXT;
  v_email   TEXT;
  v_phone   TEXT;
BEGIN
  IF p_report_id IS NULL THEN
    RAISE EXCEPTION 'problem_report_detail: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_catalog.set_config('app.problem_report_console', 'on', true);
  SELECT h.* INTO v_h FROM public.problem_reports h WHERE h.id = p_report_id;
  IF NOT FOUND THEN
    PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
    RETURN;
  END IF;
  SELECT c.description, c.context, c.internal_note, c.reporter_user_id, c.reporter_sub, c.typed_contact, c.image_key
    INTO v_desc, v_ctx, v_note, v_uid, v_sub, v_typed, v_image
    FROM public.problem_report_contents c
   WHERE c.report_id = p_report_id;
  v_has_c := FOUND;

  IF v_has_c AND v_h.verified THEN
    -- The account: by its id, or by the sign-in when the account exists by
    -- now. Workers sign in by phone, employers by email.
    v_kind := 'account';
    SELECT u.id, u.user_type, u.email, u.phone INTO v_account, v_type, v_email, v_phone
      FROM public.users u
     WHERE (v_uid IS NOT NULL AND u.id = v_uid)
        OR (v_uid IS NULL AND v_sub IS NOT NULL AND u.cognito_sub = v_sub);
    v_exists := FOUND;
    IF v_exists THEN
      v_raw := CASE WHEN v_type = 'worker' THEN COALESCE(v_phone, v_email) ELSE COALESCE(v_email, v_phone) END;
    END IF;
  ELSIF v_has_c AND v_typed IS NOT NULL THEN
    v_kind := 'typed';
    v_raw := v_typed;
  END IF;
  IF v_raw IS NOT NULL THEN
    v_raw := pg_catalog.btrim(v_raw);
    IF v_raw ~ '^[+]?[0-9 ().-]+$'
       AND pg_catalog.char_length(pg_catalog.regexp_replace(v_raw, '[^0-9]', '', 'g')) >= 7 THEN
      v_masked := public.admin_mask_phone(v_raw);
    ELSIF v_raw ~ '^[^@[:space:]]+@[^@[:space:]]+$' THEN
      v_masked := jale_cap.problem_report_mask_email(v_raw);
    ELSIF pg_catalog.char_length(v_raw) <= 2 THEN
      v_masked := '***';
    ELSE
      v_masked := '***' || pg_catalog.right(v_raw, 2);
    END IF;
  END IF;

  RETURN QUERY
    SELECT v_h.id, v_h.report_number, v_h.role, v_h.verified, v_h.category, v_h.stops_work, v_h.locale,
           v_h.include_technical, v_h.status, v_h.has_image, v_h.created_at, v_h.updated_at, v_h.status_changed_at,
           NOT v_has_c, v_desc, v_ctx, v_note, v_kind, v_masked, v_account, v_exists,
           (v_has_c AND v_image IS NOT NULL);
  PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_detail(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_detail(uuid) TO jale_admin_console;

CREATE FUNCTION jale_cap.problem_report_reveal_contact(
  p_report_id UUID
)
RETURNS TABLE (outcome TEXT, contact_kind TEXT, contact TEXT, account_user_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_verified BOOLEAN;
  v_uid      UUID;
  v_sub      TEXT;
  v_typed    TEXT;
  v_account  UUID;
  v_type     TEXT;
  v_email    TEXT;
  v_phone    TEXT;
  v_raw      TEXT;
BEGIN
  IF p_report_id IS NULL THEN
    RAISE EXCEPTION 'problem_report_reveal_contact: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_catalog.set_config('app.problem_report_console', 'on', true);
  SELECT h.verified INTO v_verified FROM public.problem_reports h WHERE h.id = p_report_id;
  IF NOT FOUND THEN
    PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT c.reporter_user_id, c.reporter_sub, c.typed_contact INTO v_uid, v_sub, v_typed
    FROM public.problem_report_contents c
   WHERE c.report_id = p_report_id;
  IF NOT FOUND THEN
    PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
    RETURN QUERY SELECT 'content_erased'::text, NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  IF v_verified THEN
    SELECT u.id, u.user_type, u.email, u.phone INTO v_account, v_type, v_email, v_phone
      FROM public.users u
     WHERE (v_uid IS NOT NULL AND u.id = v_uid)
        OR (v_uid IS NULL AND v_sub IS NOT NULL AND u.cognito_sub = v_sub);
    v_raw := CASE WHEN v_type = 'worker' THEN COALESCE(v_phone, v_email) ELSE COALESCE(v_email, v_phone) END;
    PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
    IF v_raw IS NULL THEN
      RETURN QUERY SELECT 'no_contact'::text, 'account'::text, NULL::text, NULL::uuid;
    ELSE
      RETURN QUERY SELECT 'ok'::text, 'account'::text, v_raw, v_account;
    END IF;
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
  -- A signed-out report's contact, exactly as typed; it names no account.
  IF v_typed IS NULL THEN
    RETURN QUERY SELECT 'no_contact'::text, 'none'::text, NULL::text, NULL::uuid;
  ELSE
    RETURN QUERY SELECT 'ok'::text, 'typed'::text, v_typed, NULL::uuid;
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_reveal_contact(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_reveal_contact(uuid) TO jale_admin_console;

CREATE FUNCTION jale_cap.problem_report_image(
  p_report_id UUID
)
RETURNS TABLE (outcome TEXT, image_key TEXT, content_type TEXT, account_user_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_has_image BOOLEAN;
  v_verified  BOOLEAN;
  v_key       TEXT;
  v_uid       UUID;
  v_sub       TEXT;
  v_account   UUID;
BEGIN
  IF p_report_id IS NULL THEN
    RAISE EXCEPTION 'problem_report_image: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_catalog.set_config('app.problem_report_console', 'on', true);
  SELECT h.has_image, h.verified INTO v_has_image, v_verified FROM public.problem_reports h WHERE h.id = p_report_id;
  IF NOT FOUND THEN
    PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT c.image_key, c.reporter_user_id, c.reporter_sub INTO v_key, v_uid, v_sub
    FROM public.problem_report_contents c
   WHERE c.report_id = p_report_id;
  IF v_key IS NULL THEN
    PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
    -- Gone at 90 days or with the content, or never attached.
    IF v_has_image THEN
      RETURN QUERY SELECT 'image_expired'::text, NULL::text, NULL::text, NULL::uuid;
    ELSE
      RETURN QUERY SELECT 'no_image'::text, NULL::text, NULL::text, NULL::uuid;
    END IF;
    RETURN;
  END IF;
  IF v_verified THEN
    SELECT u.id INTO v_account
      FROM public.users u
     WHERE (v_uid IS NOT NULL AND u.id = v_uid)
        OR (v_uid IS NULL AND v_sub IS NOT NULL AND u.cognito_sub = v_sub);
  END IF;
  PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
  RETURN QUERY
    SELECT 'ok'::text, v_key,
           CASE WHEN v_key LIKE '%.jpg' THEN 'image/jpeg' WHEN v_key LIKE '%.png' THEN 'image/png' ELSE 'image/webp' END,
           v_account;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_image(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_image(uuid) TO jale_admin_console;

CREATE FUNCTION jale_cap.problem_report_set_status(
  p_report_id UUID,
  p_status    TEXT
)
RETURNS TABLE (outcome TEXT, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_status TEXT;
BEGIN
  IF p_report_id IS NULL THEN
    RAISE EXCEPTION 'problem_report_set_status: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('new', 'looking', 'fixed', 'wont_fix') THEN
    RETURN QUERY SELECT 'invalid_status'::text, NULL::text;
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.problem_report_console', 'on', true);
  -- The change is dated only when the status actually changes.
  UPDATE public.problem_reports h
     SET status = p_status, status_changed_at = pg_catalog.now(), updated_at = pg_catalog.now()
   WHERE h.id = p_report_id AND h.status IS DISTINCT FROM p_status;
  SELECT h.status INTO v_status FROM public.problem_reports h WHERE h.id = p_report_id;
  PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
  IF v_status IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
  ELSE
    RETURN QUERY SELECT 'ok'::text, v_status;
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_set_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_set_status(uuid, text) TO jale_admin_console;

CREATE FUNCTION jale_cap.problem_report_set_note(
  p_report_id UUID,
  p_note      TEXT
)
RETURNS TABLE (outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_note TEXT;
BEGIN
  IF p_report_id IS NULL THEN
    RAISE EXCEPTION 'problem_report_set_note: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_catalog.set_config('app.problem_report_console', 'on', true);
  PERFORM 1 FROM public.problem_reports h WHERE h.id = p_report_id;
  IF NOT FOUND THEN
    PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
    RETURN QUERY SELECT 'not_found'::text;
    RETURN;
  END IF;
  PERFORM 1 FROM public.problem_report_contents c WHERE c.report_id = p_report_id;
  IF NOT FOUND THEN
    PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
    RETURN QUERY SELECT 'content_erased'::text;
    RETURN;
  END IF;
  -- A NULL or blank note clears it.
  v_note := CASE WHEN p_note ~ '[^[:space:]]' THEN p_note END;
  IF pg_catalog.char_length(v_note) > 4000 THEN
    PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
    RETURN QUERY SELECT 'invalid_note'::text;
    RETURN;
  END IF;
  UPDATE public.problem_report_contents c SET internal_note = v_note WHERE c.report_id = p_report_id;
  UPDATE public.problem_reports h SET updated_at = pg_catalog.now() WHERE h.id = p_report_id;
  PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
  RETURN QUERY SELECT 'ok'::text;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_set_note(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_set_note(uuid, text) TO jale_admin_console;

CREATE FUNCTION jale_cap.problem_report_settings_get()
RETURNS TABLE (
  reporting_enabled    BOOLEAN,
  signed_out_enabled   BOOLEAN,
  screenshots_enabled  BOOLEAN,
  team_email_enabled   BOOLEAN,
  signed_out_daily_cap INTEGER,
  team_recipient       TEXT,
  admin_base_url       TEXT,
  updated_at           TIMESTAMPTZ,
  updated_by_admin     UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  PERFORM pg_catalog.set_config('app.problem_report_console', 'on', true);
  RETURN QUERY
    SELECT s.reporting_enabled, s.signed_out_enabled, s.screenshots_enabled, s.team_email_enabled,
           s.signed_out_daily_cap, s.team_recipient, s.admin_base_url, s.updated_at, s.updated_by_admin
      FROM public.problem_report_settings s
     WHERE s.id;
  PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_settings_get() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_settings_get() TO jale_admin_console;

CREATE FUNCTION jale_cap.problem_report_settings_set(
  p_admin_user_id        UUID,
  p_reporting            BOOLEAN,
  p_signed_out           BOOLEAN,
  p_screenshots          BOOLEAN,
  p_team_email           BOOLEAN,
  p_team_recipient       TEXT,
  p_admin_base_url       TEXT,
  p_signed_out_daily_cap INTEGER
)
RETURNS TABLE (outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_admin_user_id IS NULL THEN
    RAISE EXCEPTION 'problem_report_settings_set: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- NULL leaves a setting unchanged.
  IF p_team_recipient IS NOT NULL
     AND (pg_catalog.char_length(p_team_recipient) NOT BETWEEN 3 AND 320
          OR p_team_recipient !~ '^[^@[:space:]]+@[^@[:space:]]+$') THEN
    RETURN QUERY SELECT 'invalid_recipient'::text;
    RETURN;
  END IF;
  IF p_admin_base_url IS NOT NULL AND p_admin_base_url !~ '^https://[a-z0-9.-]+(:[0-9]+)?$' THEN
    RETURN QUERY SELECT 'invalid_base_url'::text;
    RETURN;
  END IF;
  IF p_signed_out_daily_cap IS NOT NULL AND p_signed_out_daily_cap NOT BETWEEN 0 AND 5000 THEN
    RETURN QUERY SELECT 'invalid_cap'::text;
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.problem_report_console', 'on', true);
  UPDATE public.problem_report_settings s
     SET reporting_enabled    = COALESCE(p_reporting, s.reporting_enabled),
         signed_out_enabled   = COALESCE(p_signed_out, s.signed_out_enabled),
         screenshots_enabled  = COALESCE(p_screenshots, s.screenshots_enabled),
         team_email_enabled   = COALESCE(p_team_email, s.team_email_enabled),
         team_recipient       = COALESCE(p_team_recipient, s.team_recipient),
         admin_base_url       = COALESCE(p_admin_base_url, s.admin_base_url),
         signed_out_daily_cap = COALESCE(p_signed_out_daily_cap, s.signed_out_daily_cap),
         updated_at           = pg_catalog.now(),
         updated_by_admin     = p_admin_user_id
   WHERE s.id;
  PERFORM pg_catalog.set_config('app.problem_report_console', 'off', true);
  RETURN QUERY SELECT 'ok'::text;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_settings_set(uuid, boolean, boolean, boolean, boolean, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_settings_set(uuid, boolean, boolean, boolean, boolean, text, text, integer) TO jale_admin_console;

CREATE FUNCTION jale_cap.problem_report_mask_email(
  p_value TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v TEXT;
BEGIN
  -- Keeps the first character of the local part, and the domain.
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;
  v := pg_catalog.btrim(p_value);
  IF v !~ '^[^@[:space:]]+@[^@[:space:]]+$' THEN
    RETURN NULL;
  END IF;
  RETURN pg_catalog.left(pg_catalog.split_part(v, '@', 1), 1) || '***@' || pg_catalog.split_part(v, '@', 2);
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_mask_email(text) FROM PUBLIC;

-- ── Clean-up: owner jale_cap_report_cleanup ─────────────────
CREATE FUNCTION jale_cap.problem_report_cleanup(
  p_batch INTEGER
)
RETURNS TABLE (
  contents_erased       INTEGER,
  images_expired        INTEGER,
  pending_cleared       INTEGER,
  notifications_deleted INTEGER,
  buckets_deleted       INTEGER,
  delete_keys           TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_image_keys   TEXT[];
  v_image_ids    UUID[];
  v_pending_keys TEXT[];
  v_erased       INTEGER;
  v_mail         INTEGER;
  v_buckets      INTEGER;
BEGIN
  IF p_batch IS NULL OR p_batch NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'problem_report_cleanup: the batch size must be between 1 and 5000' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 1. Images older than 90 days: return the key, clear it, date the header.
  WITH picked AS (
    SELECT c.report_id, c.image_key
      FROM public.problem_report_contents c
     WHERE c.image_key IS NOT NULL
       AND c.created_at < pg_catalog.now() - interval '90 days'
     ORDER BY c.created_at, c.report_id
     LIMIT p_batch
       FOR UPDATE SKIP LOCKED
  ), cleared AS (
    UPDATE public.problem_report_contents c
       SET image_key = NULL
      FROM picked
     WHERE c.report_id = picked.report_id
    RETURNING c.report_id, picked.image_key
  )
  SELECT COALESCE(pg_catalog.array_agg(cleared.image_key ORDER BY cleared.image_key COLLATE "C"), ARRAY[]::text[]),
         COALESCE(pg_catalog.array_agg(cleared.report_id), ARRAY[]::uuid[])
    INTO v_image_keys, v_image_ids
    FROM cleared;
  UPDATE public.problem_reports h SET image_deleted_at = pg_catalog.now() WHERE h.id = ANY (v_image_ids);

  -- 2. Uploads issued over a day ago and never attached: return the key,
  --    clear it.
  WITH picked AS (
    SELECT c.report_id, c.pending_upload_key
      FROM public.problem_report_contents c
     WHERE c.pending_upload_key IS NOT NULL
       AND c.upload_issued_at < pg_catalog.now() - interval '1 day'
     ORDER BY c.upload_issued_at, c.report_id
     LIMIT p_batch
       FOR UPDATE SKIP LOCKED
  ), cleared AS (
    UPDATE public.problem_report_contents c
       SET pending_upload_key = NULL, pending_content_type = NULL, upload_issued_at = NULL
      FROM picked
     WHERE c.report_id = picked.report_id
    RETURNING picked.pending_upload_key
  )
  SELECT COALESCE(pg_catalog.array_agg(cleared.pending_upload_key ORDER BY cleared.pending_upload_key COLLATE "C"),
                  ARRAY[]::text[])
    INTO v_pending_keys
    FROM cleared;

  -- 3. Personal content older than 12 months: the row goes, the header keeps
  --    the date. A row whose key is still to be returned waits for parts 1
  --    and 2, so no key is ever lost here.
  WITH picked AS (
    SELECT c.report_id
      FROM public.problem_report_contents c
     WHERE c.created_at < pg_catalog.now() - interval '12 months'
       AND c.image_key IS NULL AND c.pending_upload_key IS NULL
     ORDER BY c.created_at, c.report_id
     LIMIT p_batch
       FOR UPDATE SKIP LOCKED
  ), erased AS (
    DELETE FROM public.problem_report_contents c
     USING picked
     WHERE c.report_id = picked.report_id
       AND c.image_key IS NULL AND c.pending_upload_key IS NULL
    RETURNING c.report_id
  ), dated AS (
    UPDATE public.problem_reports h
       SET content_erased_at = pg_catalog.now()
      FROM erased
     WHERE h.id = erased.report_id
    RETURNING h.id
  )
  SELECT pg_catalog.count(*) INTO v_erased FROM erased;

  -- 4. Report mail a day after it was queued, once the sender will no
  --    longer retry it (the same terms as the policies).
  WITH picked AS (
    SELECT o.id
      FROM public.email_outbox o
     WHERE o.source_type = 'problem_report'
       AND o.created_at < pg_catalog.now() - interval '1 day'
       AND NOT (o.status IN ('pending', 'failed') AND o.attempt_count < 5)
     ORDER BY o.created_at, o.id
     LIMIT p_batch
  )
  DELETE FROM public.email_outbox o
   USING picked
   WHERE o.id = picked.id
     AND o.source_type = 'problem_report'
     AND o.created_at < pg_catalog.now() - interval '1 day'
     AND NOT (o.status IN ('pending', 'failed') AND o.attempt_count < 5);
  GET DIAGNOSTICS v_mail = ROW_COUNT;

  -- 5. Rate-limit buckets older than 2 days.
  WITH picked AS (
    SELECT b.address_hash, b.window_kind, b.bucket_start
      FROM public.problem_report_rate_buckets b
     WHERE b.bucket_start < pg_catalog.now() - interval '2 days'
     ORDER BY b.bucket_start
     LIMIT p_batch
  )
  DELETE FROM public.problem_report_rate_buckets b
   USING picked
   WHERE b.address_hash = picked.address_hash
     AND b.window_kind = picked.window_kind
     AND b.bucket_start = picked.bucket_start;
  GET DIAGNOSTICS v_buckets = ROW_COUNT;

  -- Image keys first, then upload keys. They are random identifiers.
  RETURN QUERY
    SELECT v_erased, pg_catalog.cardinality(v_image_keys), pg_catalog.cardinality(v_pending_keys),
           v_mail, v_buckets, v_image_keys || v_pending_keys;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.problem_report_cleanup(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.problem_report_cleanup(integer) TO jale_job_report_cleanup;

-- ── The callers reach jale_cap; nothing else does ───────────
GRANT USAGE ON SCHEMA jale_cap TO jale_api;
GRANT USAGE ON SCHEMA jale_cap TO jale_api_public_reports;
GRANT USAGE ON SCHEMA jale_cap TO jale_admin_console;
GRANT USAGE ON SCHEMA jale_cap TO jale_job_report_cleanup;

-- ── Ownership transfer (082's window) ───────────────────────
DO $$
DECLARE
  owner_role TEXT;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY[
    'jale_cap_problem_reports', 'jale_cap_problem_reports_admin', 'jale_cap_report_cleanup'
  ] LOOP
    EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', owner_role, current_user);
  END LOOP;
END;
$$;

ALTER FUNCTION jale_cap.problem_report_config() OWNER TO jale_cap_problem_reports;
ALTER FUNCTION jale_cap.problem_report_create_verified(uuid, text, text, text, boolean, text, boolean, jsonb, text) OWNER TO jale_cap_problem_reports;
ALTER FUNCTION jale_cap.problem_report_create_unverified(uuid, text, text, text, boolean, text, text, boolean, jsonb, text, text) OWNER TO jale_cap_problem_reports;
ALTER FUNCTION jale_cap.problem_report_upload_grant(uuid, text, text) OWNER TO jale_cap_problem_reports;
ALTER FUNCTION jale_cap.problem_report_pending_upload(uuid, text) OWNER TO jale_cap_problem_reports;
ALTER FUNCTION jale_cap.problem_report_attach(uuid, text, text, text, text, integer) OWNER TO jale_cap_problem_reports;
ALTER FUNCTION jale_cap.problem_report_enqueue_team_email(uuid) OWNER TO jale_cap_problem_reports;
ALTER FUNCTION jale_cap.problem_report_inbox(text, text, text, boolean, bigint, integer, timestamp with time zone) OWNER TO jale_cap_problem_reports_admin;
ALTER FUNCTION jale_cap.problem_report_counts() OWNER TO jale_cap_problem_reports_admin;
ALTER FUNCTION jale_cap.problem_report_detail(uuid) OWNER TO jale_cap_problem_reports_admin;
ALTER FUNCTION jale_cap.problem_report_reveal_contact(uuid) OWNER TO jale_cap_problem_reports_admin;
ALTER FUNCTION jale_cap.problem_report_image(uuid) OWNER TO jale_cap_problem_reports_admin;
ALTER FUNCTION jale_cap.problem_report_set_status(uuid, text) OWNER TO jale_cap_problem_reports_admin;
ALTER FUNCTION jale_cap.problem_report_set_note(uuid, text) OWNER TO jale_cap_problem_reports_admin;
ALTER FUNCTION jale_cap.problem_report_settings_get() OWNER TO jale_cap_problem_reports_admin;
ALTER FUNCTION jale_cap.problem_report_settings_set(uuid, boolean, boolean, boolean, boolean, text, text, integer) OWNER TO jale_cap_problem_reports_admin;
ALTER FUNCTION jale_cap.problem_report_mask_email(text) OWNER TO jale_cap_problem_reports_admin;
ALTER FUNCTION jale_cap.problem_report_cleanup(integer) OWNER TO jale_cap_report_cleanup;

DO $$
DECLARE
  owner_role TEXT;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY[
    'jale_cap_problem_reports', 'jale_cap_problem_reports_admin', 'jale_cap_report_cleanup'
  ] LOOP
    EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', owner_role, current_user);
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', owner_role, current_user, current_user);
  END LOOP;
END;
$$;

-- ── Self-audit ──────────────────────────────────────────────
DO $$
DECLARE
  spec RECORD;
  fn_oid OID;
  info RECORD;
  grantee_name TEXT;
  owner_role TEXT;
  offender TEXT;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_cap.problem_report_config()', 'jale_cap_problem_reports', ARRAY['jale_api_public_reports']),
      ('jale_cap.problem_report_create_verified(uuid, text, text, text, boolean, text, boolean, jsonb, text)', 'jale_cap_problem_reports', ARRAY['jale_api']),
      ('jale_cap.problem_report_create_unverified(uuid, text, text, text, boolean, text, text, boolean, jsonb, text, text)', 'jale_cap_problem_reports', ARRAY['jale_api_public_reports']),
      ('jale_cap.problem_report_upload_grant(uuid, text, text)', 'jale_cap_problem_reports', ARRAY['jale_api', 'jale_api_public_reports']),
      ('jale_cap.problem_report_pending_upload(uuid, text)', 'jale_cap_problem_reports', ARRAY['jale_api', 'jale_api_public_reports']),
      ('jale_cap.problem_report_attach(uuid, text, text, text, text, integer)', 'jale_cap_problem_reports', ARRAY['jale_api', 'jale_api_public_reports']),
      ('jale_cap.problem_report_enqueue_team_email(uuid)', 'jale_cap_problem_reports', ARRAY[]::TEXT[]),
      ('jale_cap.problem_report_inbox(text, text, text, boolean, bigint, integer, timestamp with time zone)', 'jale_cap_problem_reports_admin', ARRAY['jale_admin_console']),
      ('jale_cap.problem_report_counts()', 'jale_cap_problem_reports_admin', ARRAY['jale_admin_console']),
      ('jale_cap.problem_report_detail(uuid)', 'jale_cap_problem_reports_admin', ARRAY['jale_admin_console']),
      ('jale_cap.problem_report_reveal_contact(uuid)', 'jale_cap_problem_reports_admin', ARRAY['jale_admin_console']),
      ('jale_cap.problem_report_image(uuid)', 'jale_cap_problem_reports_admin', ARRAY['jale_admin_console']),
      ('jale_cap.problem_report_set_status(uuid, text)', 'jale_cap_problem_reports_admin', ARRAY['jale_admin_console']),
      ('jale_cap.problem_report_set_note(uuid, text)', 'jale_cap_problem_reports_admin', ARRAY['jale_admin_console']),
      ('jale_cap.problem_report_settings_get()', 'jale_cap_problem_reports_admin', ARRAY['jale_admin_console']),
      ('jale_cap.problem_report_settings_set(uuid, boolean, boolean, boolean, boolean, text, text, integer)', 'jale_cap_problem_reports_admin', ARRAY['jale_admin_console']),
      ('jale_cap.problem_report_mask_email(text)', 'jale_cap_problem_reports_admin', ARRAY[]::TEXT[]),
      ('jale_cap.problem_report_cleanup(integer)', 'jale_cap_report_cleanup', ARRAY['jale_job_report_cleanup'])
    ) AS t(signature, owner_role, callers)
  LOOP
    fn_oid := pg_catalog.to_regprocedure(spec.signature);
    SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef AS definer,
           p.proconfig AS config, l.lanname AS language
      INTO info
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE p.oid = fn_oid;
    IF fn_oid IS NULL OR info.owner_name IS DISTINCT FROM spec.owner_role OR NOT info.definer
       OR info.config IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
       OR info.language <> 'plpgsql' THEN
      RAISE EXCEPTION 'migration 108: % has the wrong owner, security, search_path or language', spec.signature;
    END IF;

    SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END, ', ')
      INTO grantee_name
      FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
       AND (a.grantee = 0 OR NOT (pg_catalog.pg_get_userbyid(a.grantee) = ANY (spec.callers)));
    IF grantee_name IS NOT NULL THEN
      RAISE EXCEPTION 'migration 108: % is executable by a role other than its owner and callers (%)', spec.signature, grantee_name;
    END IF;

    FOREACH grantee_name IN ARRAY spec.callers LOOP
      IF NOT pg_catalog.has_function_privilege(grantee_name, fn_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration 108: % is not executable by %', spec.signature, grantee_name;
      END IF;
      IF NOT pg_catalog.has_schema_privilege(grantee_name, 'jale_cap', 'USAGE') THEN
        RAISE EXCEPTION 'migration 108: % lacks USAGE on jale_cap', grantee_name;
      END IF;
    END LOOP;
    RAISE NOTICE 'migration 108: % owned by %, executable by %', spec.signature, spec.owner_role,
      CASE WHEN pg_catalog.cardinality(spec.callers) = 0 THEN 'its owner only'
           ELSE pg_catalog.array_to_string(spec.callers, ', ') END;
  END LOOP;

  IF (SELECT count(*) FROM pg_catalog.pg_proc p
       WHERE p.pronamespace = pg_catalog.to_regnamespace('jale_cap')
         AND p.proname LIKE 'problem\_report\_%') <> 18 THEN
    RAISE EXCEPTION 'migration 108: jale_cap holds a report function this audit does not list';
  END IF;

  FOREACH owner_role IN ARRAY ARRAY[
    'jale_cap_problem_reports', 'jale_cap_problem_reports_admin', 'jale_cap_report_cleanup'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = owner_role)
         AND (am.set_option OR am.inherit_option)
    ) THEN
      RAISE EXCEPTION 'migration 108: a role still holds SET or INHERIT on capability owner %', owner_role;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
     WHERE n.nspname = 'jale_cap' AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'migration 108: jale_cap must stay closed to PUBLIC';
  END IF;

  -- No role but the table owner and the three capability owners holds any
  -- privilege, table- or column-level, on a report table or the sequence.
  SELECT string_agg(DISTINCT c.relname || ' (' ||
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ')', ', ')
    INTO offender
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL (
      SELECT x.grantee FROM aclexplode(COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) x
      UNION ALL
      SELECT y.grantee FROM pg_catalog.pg_attribute att, aclexplode(att.attacl) y
       WHERE att.attrelid = c.oid AND att.attacl IS NOT NULL
    ) a
   WHERE c.oid IN (
           pg_catalog.to_regclass('public.problem_reports'), pg_catalog.to_regclass('public.problem_report_contents'),
           pg_catalog.to_regclass('public.problem_report_rate_buckets'), pg_catalog.to_regclass('public.problem_report_settings'),
           pg_catalog.to_regclass('public.problem_report_number_seq'))
     AND a.grantee <> c.relowner
     AND (a.grantee = 0 OR pg_catalog.pg_get_userbyid(a.grantee) NOT IN (
           'jale_cap_problem_reports', 'jale_cap_problem_reports_admin', 'jale_cap_report_cleanup'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 108: a login holds a privilege on report object %', offender;
  END IF;
END;
$$;

COMMIT;
